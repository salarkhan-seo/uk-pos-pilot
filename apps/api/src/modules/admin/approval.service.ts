/**
 * ApprovalService — manager approvals for till actions (Build-02,
 * Objective 2; Arch-04 §2.8).
 *
 * An approval is a first-class record in approval_events: who requested
 * it, who approved it, for which action and amount. Rules, in check order:
 *
 *  (a) the approver must hold manager, admin or owner — a cashier can
 *      never approve (ForbiddenException);
 *  (b) the approval target must be at the approver's location — an order
 *      from another tenant, or at another location, is reported as
 *      NotFoundException, never 403, so tenants/locations cannot be
 *      enumerated (G-B);
 *  (c) approver !== requester (BadRequestException; the DB CHECK on
 *      approval_events is the backstop);
 *  (d) the approver's till PIN must verify against users.pin_hash via
 *      the shared-kernel scrypt check (no PIN set, or a wrong PIN, is a
 *      generic ForbiddenException — the caller learns nothing about
 *      which of the two failed).
 *
 * Every approval also writes an audit event (approval.granted) through
 * AuditService in the SAME transaction, so an approval without its audit
 * row can never commit. Callers in the sales module pass their transaction
 * as `trx`; without one the service uses its own database connection.
 *
 * D-08 (till-close variance): the approval threshold is the higher of
 * £10 (1000p) or 2% of expected cash, the 2% computed with integer math
 * and round-half-up — see varianceThresholdPence / varianceNeedsApproval.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { userIdAsUuid } from '../../common/uuid';
import type { Kysely, Selectable } from 'kysely';
import type { ApprovalEventsTable, DB } from '@uk-pos/db';
import { divRoundHalfUp, verifyPin } from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { actorCanApprove } from '../../common/actor';
import type { ApprovalAction } from '../../common/roles';
import { AuditService } from './audit.service';

export interface ApproveInput {
  action: ApprovalAction;
  amountPence?: bigint | null;
  reason?: string | null;
  requestedByUserId: string;
  orderId?: string | null;
  approverPin: string;
}

export interface HasApprovalInput {
  tenantId: string;
  approvalEventsId: string;
  action: ApprovalAction;
  minAmountPence?: bigint;
}

@Injectable()
export class ApprovalService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly auditService: AuditService,
  ) {}

  async approve(
    actor: Actor,
    input: ApproveInput,
    trx?: Kysely<DB>,
  ): Promise<Selectable<ApprovalEventsTable>> {
    const q = trx ?? this.db;

    // (a) Role: only manager / admin / owner may approve — never a cashier.
    if (!actorCanApprove(actor)) {
      throw new ForbiddenException('Only a manager, admin or owner can approve');
    }

    // (b) Location scope: an order from another tenant, or at another
    // location, is not found (never 403 — G-B anti-enumeration).
    if (input.orderId !== undefined && input.orderId !== null) {
      const order = await q
        .selectFrom('orders')
        .select(['id', 'location_id'])
        .where('tenant_id', '=', actor.tenantId)
        .where('id', '=', input.orderId)
        .executeTakeFirst();
      if (order === undefined || order.location_id !== actor.locationId) {
        throw new NotFoundException('Resource not found');
      }
    }

    // (c) Self-approval is forbidden (DB CHECK is the backstop).
    if (input.requestedByUserId === actor.userId) {
      throw new BadRequestException('An approval cannot be granted by the user who requested it');
    }

    // (d) Till PIN: must verify against the approver's stored PIN hash.
    const approver = await q
      .selectFrom('users')
      .select(['id', 'pin_hash'])
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', userIdAsUuid(actor.userId))
      .executeTakeFirst();
    if (
      approver === undefined ||
      approver.pin_hash === null ||
      !verifyPin(input.approverPin, approver.pin_hash)
    ) {
      throw new ForbiddenException('Invalid PIN');
    }

    const inserted = await q
      .insertInto('approval_events')
      .values({
        tenant_id: actor.tenantId,
        order_id: input.orderId ?? null,
        action: input.action,
        amount_pence: input.amountPence ?? null,
        reason: input.reason ?? null,
        requested_by_user_id: input.requestedByUserId,
        // actor.userId is a real user UUID here: the role check (a) and
        // the PIN lookup (d) above both throw Forbidden for an API-key
        // actor before this insert is reached.
        approved_by_user_id: actor.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.auditService.record(q, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'approval.granted',
      entityType: 'approval_event',
      entityId: inserted.id,
      payload: {
        action: input.action,
        amountPence: input.amountPence?.toString() ?? null,
        orderId: input.orderId ?? null,
        requestedByUserId: input.requestedByUserId,
      },
    });

    return inserted;
  }

  /**
   * D-08: till-close variance threshold — the higher of £10 (1000p) or 2%
   * of expected cash. The 2% uses integer math with round-half-up
   * (shared-kernel divRoundHalfUp); no float money anywhere.
   */
  static varianceThresholdPence(expectedCashPence: bigint): bigint {
    if (expectedCashPence < 0n) {
      throw new Error('varianceThresholdPence: expected cash must be non-negative');
    }
    const twoPercent = divRoundHalfUp(expectedCashPence * 2n, 100n);
    return twoPercent > 1000n ? twoPercent : 1000n;
  }

  /** True when |counted − expected| exceeds the D-08 threshold. */
  static varianceNeedsApproval(expectedCashPence: bigint, countedCashPence: bigint): boolean {
    const diff = countedCashPence - expectedCashPence;
    const absDiff = diff < 0n ? -diff : diff;
    return absDiff > ApprovalService.varianceThresholdPence(expectedCashPence);
  }

  /**
   * Used by the catalogue pricing pipeline to verify a manual-discount
   * approval exists: same tenant, same action, and (when given) an
   * approved amount at least minAmountPence. A NULL stored amount never
   * satisfies a minimum.
   */
  async hasApproval(dbOrTrx: Kysely<DB>, input: HasApprovalInput): Promise<boolean> {
    let query = dbOrTrx
      .selectFrom('approval_events')
      .select('id')
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.approvalEventsId)
      .where('action', '=', input.action);
    if (input.minAmountPence !== undefined) {
      query = query.where('amount_pence', '>=', input.minAmountPence);
    }
    const row = await query.executeTakeFirst();
    return row !== undefined;
  }
}
