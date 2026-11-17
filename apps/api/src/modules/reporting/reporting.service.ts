import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  CashMovementsTable,
  DB,
  RefundsTable,
  RegisterSessionsTable,
  ZReportCorrectionsTable,
  ZReportsTable,
} from '@uk-pos/db';
import {
  allocateBasketDiscount,
  businessDate,
  divRoundHalfUp,
  taxBreakdownForLine,
  type TaxRateKind,
} from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { userIdAsUuid } from '../../common/uuid';
import { ApprovalService } from '../admin/approval.service';
import { AuditService } from '../admin/audit.service';

/**
 * ReportingService — register sessions, immutable Z-reports, VAT periods,
 * accounting CSV sync and settlement reconciliation (Build-03, Objective 3;
 * Arch-01 §2.6 and §3, Arch-02 §5.2–§5.3 and §6.5, Arch-10 §5.3,
 * Arch-05 G-A-17, Arch-04 §2.7).
 *
 * DESIGN DECISIONS set here (not research facts) — also listed in the
 * Build-03 handover report:
 *
 *  - Petty-cash-out manager-approval threshold: £50 (5000p). A petty cash
 *    out of MORE than 5000p requires a manager approval_event_id (action
 *    'cash_paid_out'); 5000p or less needs only the required note.
 *  - Card fee estimate: Stripe UK in-person 1.4% + 10p per approved
 *    attempt (Arch-02 §5.2 / T-06 §3.2), round-half-up per attempt:
 *    fee = round_half_up(amount * 14 / 1000) + 10. There is NO fee-snapshot
 *    column on payment_attempts in the Build-01 schema, so the estimate is
 *    computed at Z-report / settlement time from the published rate and is
 *    NOT stored on the attempt — see MISSING COLUMNS below.
 *  - Settlement lag: T+3 days (Arch-02 §6.5, T-06 §8.4). The payout for
 *    business date D is expected on settlement date D + 3 days; matching
 *    is BY SETTLEMENT DATE, never by sale date.
 *  - Session order window: a session's Z-report aggregates completed
 *    orders created in [opened_at, closed_at] on that register with
 *    business_date = the London date of opened_at, and voided orders
 *    created in the same window. Orders from another session or day are
 *    never pulled in.
 *  - Carried corrections: a Z-report carries the corrections recorded
 *    against the IMMEDIATELY PRECEDING issued Z-report for the same
 *    register (created before this Z-report issues). The original
 *    Z-report is never rewritten; the carried total is a separately
 *    identified CSV line, never netted into the new Z-report's sales.
 *  - Cash refunds: refunds with payment_attempt_id IS NULL and status
 *    'completed' count as cash refunds in the expected-cash formula
 *    (a card refund is linked to its payment attempt; a cash refund has
 *    no attempt). See MISSING COLUMNS below.
 *  - VAT-period lines store SALES-ONLY aggregates for the period.
 *    Refunds are NOT netted into the stored lines: they appear as
 *    `refund_adjustment_pence` in the VAT-period CSV (per rate) and, when
 *    the refunded order belongs to an earlier (closed) period, as an
 *    explicit restatement entry (returned by closeVatPeriod and written
 *    to audit_events as `vat_period.restatement`). A closed period's
 *    stored lines are never rewritten.
 *  - Z-report CSV shape (Arch-02 §5.3 lists the columns; the row shape
 *    is this service's reading of "one row per tax rate, plus summary
 *    rows"): one row per VAT rate (carrying the day's summary columns),
 *    one row per tender type, one row per promotion in the breakdown,
 *    and one row per carried correction. The listed columns appear in
 *    order as the header prefix; `promotion_id`, `promotion_name` and
 *    `promotion_discount_pence` are appended after `export_generated_at`
 *    (Arch-10 §5.3 requires the per-promotion breakdown in the CSV).
 *  - Zero-float and carry-forward approvals have NO dedicated
 *    ApprovalAction in the Build-02 roles list, so they are verified by
 *    direct inspection of the approval_events row (same tenant, approver
 *    holds manager/admin/owner at the location, requester != approver).
 *    The D-08 variance approval and the petty-cash-out approval DO use
 *    ApprovalService.hasApproval with the existing actions
 *    'till_close_variance' and 'cash_paid_out'.
 *
 * MISSING COLUMNS (do NOT add a migration in Build-03 — reported to the
 * coordinator; the service works around each one as noted):
 *  - registers.status has no 'retired' value ('active'|'disabled'|
 *    'lost'). Any non-'active' register is treated as retired/unavailable
 *    for opening a session.
 *  - register_sessions has no business_date, no carried-forward attempt
 *    list and no float-warning flag. Carried-forward attempt ids and the
 *    zero-float warning live in the audit_events payload for the close /
 *    open event (and are returned by the service); the session's
 *    business date is derived as businessDate(opened_at).
 *  - payment_attempts has no fee snapshot (no fee_pence / fee-rate
 *    column), so card fee estimates are computed from the published rate
 *    at report time instead of read from a snapshot.
 *  - z_reports has no card_fee_estimate_pence, no void_total_pence and
 *    no correction_total_pence columns, and there is no
 *    z_report_promotion_lines table: the fee estimate, void total,
 *    carried-correction total and per-promotion breakdown are returned
 *    in the Z-report view and the CSV, not stored on the Z-report row.
 *  - z_report_corrections has no approval_event_id and no
 *    included_in_z_report_id column: the manager approval is verified at
 *    record time and its id is kept in the audit payload; "carried" is
 *    derived by the immediately-preceding-Z rule above, not marked.
 *  - z_report_vat_lines has no line_count column (Arch-01 §2.6 names
 *    one): the CSV line_count is computed from order_lines at export.
 *  - vat_period_lines has no order_line_count and no
 *    refund_adjustment_pence columns, and there is no restatement table:
 *    both are computed at export/close time; restatements are returned
 *    and audit-logged, not stored.
 *  - refunds has no tender column: cash vs card refunds are derived
 *    from payment_attempt_id IS NULL (see above).
 */
export type SessionRow = Selectable<RegisterSessionsTable>;
export type CashMovementRow = Selectable<CashMovementsTable>;
export type ZReportRow = Selectable<ZReportsTable>;
export type ZReportCorrectionRow = Selectable<ZReportCorrectionsTable>;

/** Petty cash out above this amount needs a manager approval. */
export const PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE = 5000n;

/** Stripe UK in-person card fee used for fee estimates (T-06 §3.2). */
export const CARD_FEE_PERCENT_NUMERATOR = 14n;
export const CARD_FEE_PERCENT_DENOMINATOR = 1000n;
export const CARD_FEE_PER_TRANSACTION_PENCE = 10n;

/** Provider settlement lag (T+3, Arch-02 §6.5). */
export const SETTLEMENT_LAG_DAYS = 3;

export const CASH_MOVEMENT_TYPES = ['cash_in', 'cash_out', 'petty_cash_in', 'petty_cash_out'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const Z_REPORT_CORRECTION_TYPES = ['cash_variance', 'card_total', 'vat_total', 'void', 'other'] as const;
export type ZReportCorrectionType = (typeof Z_REPORT_CORRECTION_TYPES)[number];

const TAX_RATE_ORDER: TaxRateKind[] = ['standard', 'reduced', 'zero', 'exempt'];
const TAX_RATE_NAMES: Record<TaxRateKind, string> = {
  standard: 'Standard',
  reduced: 'Reduced',
  zero: 'Zero-rated',
  exempt: 'Exempt',
};

/** Card fee estimate for one approved attempt (round-half-up, D-13). */
export function cardFeeEstimatePence(amountPence: bigint): bigint {
  if (amountPence < 0n) {
    throw new Error('cardFeeEstimatePence: amount must be non-negative');
  }
  return divRoundHalfUp(amountPence * CARD_FEE_PERCENT_NUMERATOR, CARD_FEE_PERCENT_DENOMINATOR) + CARD_FEE_PER_TRANSACTION_PENCE;
}

/** Expected settlement date (business date + T+3), as YYYY-MM-DD. */
export function settlementDateFor(businessDateValue: string): string {
  const [y, m, d] = businessDateValue.split('-').map(Number);
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  date.setUTCDate(date.getUTCDate() + SETTLEMENT_LAG_DAYS);
  return date.toISOString().slice(0, 10);
}

export interface OpenSessionInput {
  registerId: string;
  openingFloatPence: bigint;
  /** Required when openingFloatPence is 0 (D-07 warn + manager override). */
  approvalEventId?: string | null;
}

export interface RecordCashMovementInput {
  sessionId: string;
  type: CashMovementType;
  amountPence: bigint;
  note: string;
  /** Required when type is petty_cash_out above the threshold. */
  approvalEventId?: string | null;
}

export interface CloseSessionInput {
  sessionId: string;
  countedCashPence: bigint;
  /** Required whenever variance != 0. */
  varianceReason?: string | null;
  /** Required when |variance| exceeds the D-08 threshold. */
  approvalEventId?: string | null;
  /**
   * Required when pending/unknown card payments exist: the exact set of
   * pending/unknown attempt ids, a manager approval and a note.
   */
  carryForward?: {
    attemptIds: string[];
    approvalEventId: string;
    note: string;
  } | null;
}

export interface VatLineView {
  taxRateKind: TaxRateKind;
  taxRatePercent: string;
  grossPence: bigint;
  vatPence: bigint;
  netPence: bigint;
  lineCount: number;
}

export interface TenderLineView {
  tenderType: 'cash' | 'card' | 'store_credit' | 'gift_card' | 'loyalty_points';
  amountPence: bigint;
  transactionCount: number;
}

export interface PromotionBreakdownView {
  promotionId: string;
  promotionName: string;
  promotionVersion: number;
  discountPence: bigint;
}

export interface CarriedCorrectionView {
  id: string;
  originalZReportId: string;
  correctionType: string;
  amountPence: bigint;
  reason: string;
}

export interface ZReportView {
  zReport: ZReportRow;
  vatLines: VatLineView[];
  tenderLines: TenderLineView[];
  promotionBreakdown: PromotionBreakdownView[];
  carriedCorrections: CarriedCorrectionView[];
  carriedCorrectionTotalPence: bigint;
  /** Card fee estimate (1.4% + 10p per approved attempt); NOT stored on the row. */
  cardFeeEstimatePence: bigint;
  voidTotalPence: bigint;
  refundCount: number;
}

export interface RecordCorrectionInput {
  zReportId: string;
  correctionType: ZReportCorrectionType;
  amountPence: bigint;
  reason: string;
  /** Manager approval_event_id (verified; id kept in the audit payload). */
  approvalEventId: string;
}

export interface VatPeriodLineView {
  taxRateKind: TaxRateKind;
  taxRatePercent: string;
  grossPence: bigint;
  vatPence: bigint;
  netPence: bigint;
  orderLineCount: number;
}

export interface VatRestatementView {
  refundId: string;
  orderId: string;
  originalBusinessDate: string;
  refundBusinessDate: string;
  amountPence: bigint;
  perRate: VatLineView[];
}

export interface PayoutInput {
  providerReference: string;
  settlementDate: string;
  grossPence: bigint;
  feePence: bigint;
  reserveHoldPence: bigint;
  disputeDebitPence: bigint;
}

export interface SettlementReconciliation {
  businessDate: string;
  settlementDate: string;
  cardGrossPence: bigint;
  feeEstimatePence: bigint;
  payouts: PayoutInput[];
  otherSettlementDatePayouts: PayoutInput[];
  settledGrossPence: bigint;
  settledFeePence: bigint;
  reserveHoldTotalPence: bigint;
  disputeDebitTotalPence: bigint;
  expectedNetPayoutPence: bigint;
  feeAdjustment: {
    estimatedFeePence: bigint;
    settledFeePence: bigint;
    adjustmentPence: bigint;
    zReportIds: string[];
  } | null;
  status: 'reconciled' | 'discrepancy';
  discrepancyReason: string | null;
}

export const Z_REPORT_CSV_COLUMNS = [
  'z_number',
  'business_date',
  'location_id',
  'location_name',
  'register_id',
  'register_name',
  'tax_rate_name',
  'tax_rate_percent',
  'net_pence',
  'vat_pence',
  'gross_pence',
  'line_count',
  'tender_type',
  'tender_total_pence',
  'tender_count',
  'discount_total_pence',
  'refund_total_pence',
  'refund_count',
  'card_fee_estimate_pence',
  'cash_expected_pence',
  'cash_counted_pence',
  'cash_variance_pence',
  'variance_reason',
  'order_count',
  'void_count',
  'void_total_pence',
  'correction_total_pence',
  'correction_reason',
  'currency',
  'export_generated_at',
  'promotion_id',
  'promotion_name',
  'promotion_discount_pence',
] as const;

export const VAT_PERIOD_CSV_COLUMNS = [
  'vat_period_id',
  'period_start',
  'period_end',
  'tax_rate_name',
  'tax_rate_percent',
  'net_pence',
  'vat_pence',
  'gross_pence',
  'order_line_count',
  'refund_adjustment_pence',
  'currency',
  'export_generated_at',
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format a `date` column as YYYY-MM-DD. PGlite (and the `pg` driver)
 * return PostgreSQL `date` values as JS Date objects, whose default
 * string form is NOT ISO — format explicitly.
 */
function formatDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

@Injectable()
export class ReportingService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
  ) {}

  status(): { module: string; status: string } {
    return { module: 'reporting', status: 'Build-03 Objective 3 — sessions, Z-reports, VAT periods, CSV sync, settlement reconciliation' };
  }

  // ------------------------------------------------------------------
  // Register sessions
  // ------------------------------------------------------------------

  async openSession(
    actor: Actor,
    input: OpenSessionInput,
  ): Promise<{ session: SessionRow; warning: string | null }> {
    if (input.openingFloatPence < 0n) {
      throw new BadRequestException('Opening float must not be negative');
    }
    return this.db.transaction().execute(async (trx) => {
      const register = await trx
        .selectFrom('registers')
        .selectAll()
        .where('id', '=', input.registerId)
        .where('tenant_id', '=', actor.tenantId)
        .where('location_id', '=', actor.locationId)
        .executeTakeFirst();
      if (register === undefined) {
        throw new NotFoundException('Resource not found');
      }
      // No 'retired' value exists in the schema CHECK; any non-'active'
      // register (disabled / lost) is treated as retired/unavailable.
      if (register.status !== 'active') {
        throw new BadRequestException(
          `Register ${register.name} is ${register.status} and cannot open a session`,
        );
      }
      const alreadyOpen = await trx
        .selectFrom('register_sessions')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('register_id', '=', register.id)
        .where('status', 'in', ['open', 'ended'])
        .executeTakeFirst();
      if (alreadyOpen !== undefined) {
        throw new BadRequestException('Register already has an open session');
      }

      let warning: string | null = null;
      if (input.openingFloatPence === 0n) {
        // D-07: a zero / delayed float is allowed ONLY with a manager
        // approval (warning recorded). No dedicated approval action
        // exists for this, so the approval row is verified directly.
        if (input.approvalEventId === undefined || input.approvalEventId === null) {
          throw new BadRequestException(
            'Opening a session with no float requires a manager approval (approval_event_id)',
          );
        }
        await this.verifyManagerApprovalRow(trx, actor, input.approvalEventId);
        warning =
          'Session opened with no float: float must be counted and recorded before trading; manager approval recorded.';
      }

      const session = await trx
        .insertInto('register_sessions')
        .values({
          tenant_id: actor.tenantId,
          register_id: register.id,
          opened_by_user_id: userIdAsUuid(actor.userId),
          float_pence: input.openingFloatPence,
          status: 'open',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType:
          input.openingFloatPence === 0n ? 'session.opened_zero_float' : 'session.opened',
        entityType: 'register_session',
        entityId: session.id,
        payload: {
          registerId: register.id,
          openingFloatPence: input.openingFloatPence.toString(),
          warning,
          approvalEventId: input.approvalEventId ?? null,
        },
      });
      return { session, warning };
    });
  }

  async recordCashMovement(
    actor: Actor,
    input: RecordCashMovementInput,
  ): Promise<CashMovementRow> {
    if (!CASH_MOVEMENT_TYPES.includes(input.type)) {
      throw new BadRequestException(`Unknown cash movement type: ${String(input.type)}`);
    }
    if (input.amountPence <= 0n) {
      throw new BadRequestException('Cash movement amount must be greater than zero');
    }
    if (input.note === undefined || input.note.trim() === '') {
      throw new BadRequestException('Cash movements require a note');
    }
    return this.db.transaction().execute(async (trx) => {
      const session = await this.loadSession(trx, actor, input.sessionId);
      if (session.status !== 'open') {
        throw new BadRequestException(
          `Cash movements can only be recorded on an open session (session is ${session.status})`,
        );
      }
      if (
        input.type === 'petty_cash_out' &&
        input.amountPence > PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE
      ) {
        if (input.approvalEventId === undefined || input.approvalEventId === null) {
          throw new BadRequestException(
            `Petty cash out above £${(PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE / 100n).toString()} requires a manager approval (approval_event_id)`,
          );
        }
        const ok = await this.approvals.hasApproval(trx, {
          tenantId: actor.tenantId,
          approvalEventsId: input.approvalEventId,
          action: 'cash_paid_out',
          minAmountPence: input.amountPence,
        });
        if (!ok) {
          throw new BadRequestException(
            'No matching manager approval (cash_paid_out) found for this petty cash out',
          );
        }
      }
      const movement = await trx
        .insertInto('cash_movements')
        .values({
          tenant_id: actor.tenantId,
          session_id: session.id,
          type: input.type,
          amount_pence: input.amountPence,
          note: input.note,
          created_by_user_id: userIdAsUuid(actor.userId),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'cash_movement.recorded',
        entityType: 'cash_movement',
        entityId: movement.id,
        payload: {
          sessionId: session.id,
          type: input.type,
          amountPence: input.amountPence.toString(),
          approvalEventId: input.approvalEventId ?? null,
        },
      });
      return movement;
    });
  }

  /**
   * End (step 1 of close): compute and store the expected cash.
   * expected = opening_float + cash_sales - cash_refunds - cash_out
   *   + cash_in - petty_cash_out + petty_cash_in  (exactly this formula).
   */
  async endSession(actor: Actor, sessionId: string): Promise<SessionRow> {
    return this.db.transaction().execute(async (trx) => {
      const session = await this.loadSession(trx, actor, sessionId);
      if (session.status !== 'open') {
        throw new BadRequestException(
          `Only an open session can be ended (session is ${session.status})`,
        );
      }
      const now = new Date();
      const expected = await this.computeExpectedCash(trx, actor, session, now);
      const ended = await trx
        .updateTable('register_sessions')
        .set({ status: 'ended', ended_at: now, expected_cash_pence: expected })
        .where('id', '=', session.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'session.ended',
        entityType: 'register_session',
        entityId: session.id,
        payload: { expectedCashPence: expected.toString() },
      });
      return ended;
    });
  }

  /**
   * Close (step 2): record counted cash + variance (+ reason when != 0),
   * enforce D-08, block on pending/unknown card payments unless carried
   * forward, and issue the Z-report in the same transaction.
   */
  async closeSession(
    actor: Actor,
    input: CloseSessionInput,
  ): Promise<{ session: SessionRow; zReport: ZReportView }> {
    return this.db.transaction().execute(async (trx) => {
      const session = await this.loadSession(trx, actor, input.sessionId);
      if (session.status !== 'ended') {
        throw new BadRequestException(
          `Only an ended session can be closed (session is ${session.status}); end the session first`,
        );
      }
      if (session.expected_cash_pence === null) {
        throw new BadRequestException('Session has no expected cash: end the session first');
      }
      const expected = session.expected_cash_pence;
      const variance = input.countedCashPence - expected;
      if (variance !== 0n && (input.varianceReason === undefined || input.varianceReason === null || input.varianceReason.trim() === '')) {
        throw new BadRequestException('A variance_reason is required whenever variance is not zero');
      }
      // D-08: |variance| > max(£10, 2% of expected) needs manager approval.
      if (ApprovalService.varianceNeedsApproval(expected, input.countedCashPence)) {
        const absVariance = variance < 0n ? -variance : variance;
        if (input.approvalEventId === undefined || input.approvalEventId === null) {
          throw new BadRequestException(
            'Variance exceeds the D-08 threshold (higher of £10 or 2% of expected cash) and requires a manager approval (approval_event_id)',
          );
        }
        const ok = await this.approvals.hasApproval(trx, {
          tenantId: actor.tenantId,
          approvalEventsId: input.approvalEventId,
          action: 'till_close_variance',
          minAmountPence: absVariance,
        });
        if (!ok) {
          throw new BadRequestException(
            'No matching manager approval (till_close_variance) found for this variance',
          );
        }
      }

      // W-13: block close while card payments are pending/unknown, unless
      // explicitly carried forward with a manager approval note.
      const now = new Date();
      const pendingAttempts = await this.pendingPaymentAttempts(trx, actor, session, now);
      let carriedForwardAttemptIds: string[] = [];
      if (pendingAttempts.length > 0) {
        if (input.carryForward === undefined || input.carryForward === null) {
          throw new BadRequestException(
            `Session close is blocked: ${pendingAttempts.length} card payment(s) are pending or unknown (${pendingAttempts.map((a) => a.id).join(', ')}). Resolve them or carry them forward with a manager approval note.`,
          );
        }
        const wanted = [...input.carryForward.attemptIds].sort();
        const actual = pendingAttempts.map((a) => a.id).sort();
        if (wanted.length !== actual.length || wanted.some((id, i) => id !== actual[i])) {
          throw new BadRequestException(
            'Carried-forward attempt ids must be exactly the pending/unknown payment attempts for this session',
          );
        }
        if (input.carryForward.note.trim() === '') {
          throw new BadRequestException('A manager carry-forward note is required');
        }
        await this.verifyManagerApprovalRow(trx, actor, input.carryForward.approvalEventId);
        carriedForwardAttemptIds = input.carryForward.attemptIds;
      }

      const closed = await trx
        .updateTable('register_sessions')
        .set({
          status: 'closed',
          closed_at: now,
          closed_by_user_id: userIdAsUuid(actor.userId),
          counted_cash_pence: input.countedCashPence,
          variance_pence: variance,
          variance_reason: variance === 0n ? null : (input.varianceReason as string),
        })
        .where('id', '=', session.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      const zReport = await this.issueZReport(trx, actor, closed, now, carriedForwardAttemptIds);

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'session.closed',
        entityType: 'register_session',
        entityId: session.id,
        payload: {
          countedCashPence: input.countedCashPence.toString(),
          expectedCashPence: expected.toString(),
          variancePence: variance.toString(),
          varianceReason: variance === 0n ? null : (input.varianceReason as string),
          approvalEventId: input.approvalEventId ?? null,
          // No carried-forward column exists on register_sessions; the
          // ids are recorded here (see the module header note).
          carriedForwardAttemptIds,
          carryForwardNote: input.carryForward?.note ?? null,
          zReportId: zReport.zReport.id,
          zNumber: zReport.zReport.z_number.toString(),
        },
      });
      return { session: closed, zReport };
    });
  }

  // ------------------------------------------------------------------
  // Z-reports
  // ------------------------------------------------------------------

  async getZReport(actor: Actor, zReportId: string): Promise<ZReportView> {
    const z = await this.db
      .selectFrom('z_reports')
      .selectAll()
      .where('id', '=', zReportId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (z === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return this.buildZReportView(this.db, actor, z);
  }

  /**
   * Record a post-close correction against an issued Z-report. The
   * original Z-report is never edited; the correction is a separate row
   * carried into the next Z-report for the register.
   */
  async recordCorrection(
    actor: Actor,
    input: RecordCorrectionInput,
  ): Promise<ZReportCorrectionRow> {
    if (!Z_REPORT_CORRECTION_TYPES.includes(input.correctionType)) {
      throw new BadRequestException(`Unknown correction type: ${String(input.correctionType)}`);
    }
    if (input.reason.trim() === '') {
      throw new BadRequestException('A correction reason is required');
    }
    return this.db.transaction().execute(async (trx) => {
      const z = await trx
        .selectFrom('z_reports')
        .selectAll()
        .where('id', '=', input.zReportId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (z === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (z.status !== 'issued') {
        throw new BadRequestException('Corrections can only be recorded against an issued Z-report');
      }
      // Manager approval required; no dedicated action exists, so the
      // approval row is verified directly and its id kept in the audit
      // payload (no approval_event_id column on z_report_corrections).
      await this.verifyManagerApprovalRow(trx, actor, input.approvalEventId);
      const correction = await trx
        .insertInto('z_report_corrections')
        .values({
          z_report_id: z.id,
          correction_type: input.correctionType,
          amount_pence: input.amountPence,
          reason: input.reason,
          corrected_by_user_id: userIdAsUuid(actor.userId),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'z_report.correction_recorded',
        entityType: 'z_report_correction',
        entityId: correction.id,
        payload: {
          zReportId: z.id,
          zNumber: z.z_number.toString(),
          correctionType: input.correctionType,
          amountPence: input.amountPence.toString(),
          reason: input.reason,
          approvalEventId: input.approvalEventId,
        },
      });
      return correction;
    });
  }

  // ------------------------------------------------------------------
  // VAT periods
  // ------------------------------------------------------------------

  /**
   * Close a VAT period by its date range, CREATING the row (the
   * Build-03 creation path — retained for callers that close a period
   * no open row exists for yet). The created row is closed with
   * closed_at / closed_by_user_id set (migration 014 columns).
   */
  async closeVatPeriod(
    actor: Actor,
    input: { periodStart: string; periodEnd: string },
  ): Promise<{
    periodId: string;
    lines: VatPeriodLineView[];
    restatements: VatRestatementView[];
  }> {
    if (input.periodEnd < input.periodStart) {
      throw new BadRequestException('VAT period end must be on or after its start');
    }
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('vat_periods')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('period_start', '=', input.periodStart)
        .where('period_end', '=', input.periodEnd)
        .executeTakeFirst();
      if (existing !== undefined) {
        throw new BadRequestException('A VAT period with these dates already exists');
      }

      const period = await trx
        .insertInto('vat_periods')
        .values({
          tenant_id: actor.tenantId,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          status: 'closed',
          closed_at: new Date(),
          closed_by_user_id: userIdAsUuid(actor.userId),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return this.closePeriodRows(trx, actor, period.id, input.periodStart, input.periodEnd);
    });
  }

  /**
   * Close an EXISTING draft/open vat_periods row IN PLACE (Build-05
   * fix for the Build-04 honest limit): the same :id is updated —
   * aggregated lines populated, status 'closed', closed_at and
   * closed_by_user_id stamped — and the SAME :id is returned. The
   * Build-04 controller bridge (delete the open row, create a new
   * one, return a new id) is gone. A missing row is 404; a row that
   * is not open is 409. Callers with no row yet use closeVatPeriod
   * (the creation path above).
   */
  async closeVatPeriodById(
    actor: Actor,
    periodId: string,
  ): Promise<{
    periodId: string;
    lines: VatPeriodLineView[];
    restatements: VatRestatementView[];
  }> {
    return this.db.transaction().execute(async (trx) => {
      const period = await trx
        .selectFrom('vat_periods')
        .selectAll()
        .where('id', '=', periodId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (period === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (period.status !== 'open') {
        throw new ConflictException(`VAT period is ${period.status}, not open`);
      }
      await trx
        .updateTable('vat_periods')
        .set({
          status: 'closed',
          closed_at: new Date(),
          closed_by_user_id: userIdAsUuid(actor.userId),
          updated_at: new Date(),
        })
        .where('id', '=', period.id)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
      return this.closePeriodRows(
        trx,
        actor,
        period.id,
        formatDate(period.period_start),
        formatDate(period.period_end),
      );
    });
  }

  /**
   * Shared close work for both paths: populate the aggregated
   * vat_period_lines for the period, compute + audit-log the
   * restatements, and audit-log the close itself. An open row never
   * carries lines, but any stale lines are removed first so a close
   * is idempotent within its transaction.
   */
  private async closePeriodRows(
    trx: Kysely<DB>,
    actor: Actor,
    periodId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{
    periodId: string;
    lines: VatPeriodLineView[];
    restatements: VatRestatementView[];
  }> {
    // Sales-only aggregates for the period, from completed orders'
    // order-line tax snapshots (D-13: the stored tax_amount_pence).
    const lines = await trx
      .selectFrom('order_lines')
      .innerJoin('orders', 'orders.id', 'order_lines.order_id')
      .select([
        'order_lines.tax_rate_kind',
        'order_lines.tax_rate_percent',
        sql<string>`COUNT(*)::text`.as('line_count'),
        sql<string>`COALESCE(SUM(order_lines.line_total_pence), 0)::text`.as('gross'),
        sql<string>`COALESCE(SUM(order_lines.tax_amount_pence), 0)::text`.as('vat'),
      ])
      .where('order_lines.tenant_id', '=', actor.tenantId)
      .where('orders.status', '=', 'completed')
      .where('orders.business_date', '>=', periodStart)
      .where('orders.business_date', '<=', periodEnd)
      .groupBy(['order_lines.tax_rate_kind', 'order_lines.tax_rate_percent'])
      .execute();

    await trx.deleteFrom('vat_period_lines').where('vat_period_id', '=', periodId).execute();

    const lineViews: VatPeriodLineView[] = [];
    for (const line of lines) {
      const gross = BigInt(line.gross);
      const vat = BigInt(line.vat);
      await trx
        .insertInto('vat_period_lines')
        .values({
          vat_period_id: periodId,
          tax_rate_kind: line.tax_rate_kind,
          tax_rate_percent: line.tax_rate_percent,
          gross_pence: gross,
          vat_pence: vat,
          net_pence: gross - vat,
        })
        .execute();
      lineViews.push({
        taxRateKind: line.tax_rate_kind,
        taxRatePercent: line.tax_rate_percent,
        grossPence: gross,
        vatPence: vat,
        netPence: gross - vat,
        orderLineCount: Number(line.line_count),
      });
    }

    // Restatements: completed refunds created in THIS period whose
    // original order belongs to an EARLIER period. The closed earlier
    // period is never rewritten; the restatement is returned here and
    // audit-logged, and surfaces in this period's CSV as
    // refund_adjustment_pence.
    const restatements = await this.restatementsForPeriod(trx, actor, periodStart, periodEnd);
    for (const restatement of restatements) {
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'vat_period.restatement',
        entityType: 'vat_period',
        entityId: periodId,
        payload: {
          refundId: restatement.refundId,
          orderId: restatement.orderId,
          originalBusinessDate: restatement.originalBusinessDate,
          refundBusinessDate: restatement.refundBusinessDate,
          amountPence: restatement.amountPence.toString(),
          perRate: restatement.perRate.map((r) => ({
            kind: r.taxRateKind,
            percent: r.taxRatePercent,
            grossPence: r.grossPence.toString(),
            vatPence: r.vatPence.toString(),
            netPence: r.netPence.toString(),
          })),
        },
      });
    }

    await this.audit.record(trx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'vat_period.closed',
      entityType: 'vat_period',
      entityId: periodId,
      payload: {
        periodStart,
        periodEnd,
        restatementCount: String(restatements.length),
      },
    });
    return { periodId, lines: lineViews, restatements };
  }

  // ------------------------------------------------------------------
  // CSV exports (Arch-02 §5.3 — exact column contract)
  // ------------------------------------------------------------------

  async exportZReportCsv(
    actor: Actor,
    zReportId: string,
    opts: { generatedAt?: Date } = {},
  ): Promise<{ fileName: string; csv: string; sha256: string }> {
    const view = await this.getZReport(actor, zReportId);
    const z = view.zReport;
    const session = await this.db
      .selectFrom('register_sessions')
      .selectAll()
      .where('id', '=', z.session_id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirstOrThrow();
    const register = await this.db
      .selectFrom('registers')
      .selectAll()
      .where('id', '=', z.register_id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirstOrThrow();
    const location = await this.db
      .selectFrom('locations')
      .selectAll()
      .where('id', '=', register.location_id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirstOrThrow();

    const generatedAt = (opts.generatedAt ?? new Date()).toISOString();
    const businessDateValue = formatDate(z.business_date);
    const base = [
      z.z_number.toString(),
      businessDateValue,
      location.id,
      location.name,
      register.id,
      register.name,
    ];
    const summary = [
      z.discount_pence.toString(),
      z.refund_pence.toString(),
      // refund_count is not a column on z_reports; the count is carried
      // in the view, recomputed from the completed refunds for the day.
      String(view.refundCount),
      view.cardFeeEstimatePence.toString(),
      (z.cash_expected_pence ?? session.expected_cash_pence ?? 0n).toString(),
      (z.cash_counted_pence ?? session.counted_cash_pence ?? 0n).toString(),
      (z.cash_variance_pence ?? session.variance_pence ?? 0n).toString(),
      session.variance_reason ?? '',
      z.order_count.toString(),
      z.void_count.toString(),
      view.voidTotalPence.toString(),
      view.carriedCorrectionTotalPence.toString(),
      view.carriedCorrections.map((c) => `${c.correctionType}: ${c.reason}`).join('; '),
      'GBP',
      generatedAt,
    ];

    const rows: string[][] = [];
    // One row per VAT rate, carrying the summary columns.
    for (const line of view.vatLines) {
      rows.push([
        ...base,
        TAX_RATE_NAMES[line.taxRateKind],
        line.taxRatePercent,
        line.netPence.toString(),
        line.vatPence.toString(),
        line.grossPence.toString(),
        line.lineCount.toString(),
        '',
        '',
        '',
        ...summary,
        '',
        '',
        '',
      ]);
    }
    // One row per tender type (summary columns blank except currency /
    // generated_at, which identify the export on every row).
    for (const tender of view.tenderLines) {
      const row = [
        ...base,
        '',
        '',
        '',
        '',
        '',
        '',
        tender.tenderType,
        tender.amountPence.toString(),
        tender.transactionCount.toString(),
        ...summary.map(() => ''),
        '',
        '',
        '',
      ];
      row[28] = 'GBP';
      row[29] = generatedAt;
      rows.push(row);
    }
    // One row per promotion (Arch-10 §5.3 breakdown).
    for (const promo of view.promotionBreakdown) {
      const row = [
        ...base,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        ...summary.map(() => ''),
        promo.promotionId,
        promo.promotionName,
        promo.discountPence.toString(),
      ];
      row[28] = 'GBP';
      row[29] = generatedAt;
      rows.push(row);
    }
    // One row per carried correction (visible, never netted).
    for (const correction of view.carriedCorrections) {
      const row = [
        ...base,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        ...summary.map(() => ''),
        '',
        '',
        '',
      ];
      // correction columns live at fixed positions in the summary block.
      row[26] = correction.amountPence.toString();
      row[27] = `${correction.correctionType}: ${correction.reason}`;
      row[28] = 'GBP';
      row[29] = generatedAt;
      rows.push(row);
    }

    const csv =
      Z_REPORT_CSV_COLUMNS.join(',') +
      '\n' +
      rows.map((row) => row.map(csvEscape).join(',')).join('\n') +
      (rows.length > 0 ? '\n' : '');
    const sha256 = createHash('sha256').update(csv).digest('hex');
    await this.audit.record(this.db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'z_report.exported',
      entityType: 'z_report',
      entityId: z.id,
      payload: {
        zNumber: z.z_number.toString(),
        sha256,
        fileName: `z-report-${z.z_number.toString()}-${businessDateValue}.csv`,
      },
    });
    return { fileName: `z-report-${z.z_number.toString()}-${businessDateValue}.csv`, csv, sha256 };
  }

  async exportVatPeriodCsv(
    actor: Actor,
    vatPeriodId: string,
    opts: { generatedAt?: Date } = {},
  ): Promise<{ fileName: string; csv: string; sha256: string }> {
    const period = await this.db
      .selectFrom('vat_periods')
      .selectAll()
      .where('id', '=', vatPeriodId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (period === undefined) {
      throw new NotFoundException('Resource not found');
    }
    if (period.status === 'open') {
      throw new BadRequestException('VAT period must be closed before it can be exported');
    }
    const lines = await this.db
      .selectFrom('vat_period_lines')
      .selectAll()
      .where('vat_period_id', '=', period.id)
      .execute();

    // Refund adjustments for this period: completed refunds created in
    // the period, allocated per rate from their original order lines.
    // Format the period bounds FIRST: the driver returns `date` columns
    // as Date objects, and a JS string-vs-Date comparison is wrong.
    const periodStart = formatDate(period.period_start);
    const periodEnd = formatDate(period.period_end);
    const adjustments = await this.refundAdjustmentsForPeriod(
      this.db,
      actor,
      periodStart,
      periodEnd,
    );
    const lineCounts = await this.orderLineCountsForPeriod(
      this.db,
      actor,
      periodStart,
      periodEnd,
    );

    const generatedAt = (opts.generatedAt ?? new Date()).toISOString();
    const kinds = new Set<TaxRateKind>();
    for (const line of lines) kinds.add(line.tax_rate_kind);
    for (const kind of adjustments.keys()) kinds.add(kind);
    const orderedKinds = TAX_RATE_ORDER.filter((k) => kinds.has(k));

    const rows: string[][] = [];
    for (const kind of orderedKinds) {
      const line = lines.find((l) => l.tax_rate_kind === kind);
      const adjustment = adjustments.get(kind);
      rows.push([
        period.id,
        periodStart,
        periodEnd,
        TAX_RATE_NAMES[kind],
        line?.tax_rate_percent ?? adjustment?.percent ?? '0.00',
        (line?.net_pence ?? 0n).toString(),
        (line?.vat_pence ?? 0n).toString(),
        (line?.gross_pence ?? 0n).toString(),
        String(lineCounts.get(kind) ?? 0),
        (adjustment?.grossPence ?? 0n).toString(),
        'GBP',
        generatedAt,
      ]);
    }
    const csv =
      VAT_PERIOD_CSV_COLUMNS.join(',') +
      '\n' +
      rows.map((row) => row.map(csvEscape).join(',')).join('\n') +
      (rows.length > 0 ? '\n' : '');
    const sha256 = createHash('sha256').update(csv).digest('hex');
    const fileName = `vat-period-${periodStart}-to-${periodEnd}.csv`;

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('vat_return_exports')
        .values({
          tenant_id: actor.tenantId,
          vat_period_id: period.id,
          file_name: fileName,
          sha256_checksum: sha256,
          exported_by_user_id: userIdAsUuid(actor.userId),
        })
        .execute();
      if (period.status === 'closed') {
        await trx
          .updateTable('vat_periods')
          .set({ status: 'exported' })
          .where('id', '=', period.id)
          .execute();
      }
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'vat_period.exported',
        entityType: 'vat_period',
        entityId: period.id,
        payload: { fileName, sha256 },
      });
    });
    return { fileName, csv, sha256 };
  }

  // ------------------------------------------------------------------
  // Settlement reconciliation (G-A-17, Arch-02 §6.5)
  // ------------------------------------------------------------------

  async reconcileSettlement(
    actor: Actor,
    businessDateValue: string,
    payouts: PayoutInput[],
  ): Promise<SettlementReconciliation> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDateValue)) {
      throw new BadRequestException('businessDate must be YYYY-MM-DD');
    }
    const settlementDate = settlementDateFor(businessDateValue);

    // Approved card attempts for the business date (from the Z-report's
    // card total: approved attempts only; pending/unknown are not sales).
    const attempts = await this.db
      .selectFrom('payment_attempts')
      .innerJoin('orders', 'orders.id', 'payment_attempts.order_id')
      .select(['payment_attempts.amount_pence'])
      .where('payment_attempts.tenant_id', '=', actor.tenantId)
      .where('payment_attempts.status', '=', 'approved')
      .where('orders.business_date', '=', businessDateValue)
      .execute();
    const cardGross = attempts.reduce((sum, a) => sum + a.amount_pence, 0n);
    const feeEstimate = attempts.reduce((sum, a) => sum + cardFeeEstimatePence(a.amount_pence), 0n);

    const matched = payouts.filter((p) => p.settlementDate === settlementDate);
    const others = payouts.filter((p) => p.settlementDate !== settlementDate);
    const settledGross = matched.reduce((s, p) => s + p.grossPence, 0n);
    const settledFee = matched.reduce((s, p) => s + p.feePence, 0n);
    const reserveTotal = matched.reduce((s, p) => s + p.reserveHoldPence, 0n);
    const disputeTotal = matched.reduce((s, p) => s + p.disputeDebitPence, 0n);
    const expectedNet = cardGross - settledFee - reserveTotal - disputeTotal;

    let status: 'reconciled' | 'discrepancy' = 'reconciled';
    let discrepancyReason: string | null = null;
    if (matched.length === 0 && cardGross > 0n) {
      status = 'discrepancy';
      discrepancyReason = `No payout received for settlement date ${settlementDate} against card sales of ${cardGross.toString()}p`;
    } else if (settledGross !== cardGross) {
      status = 'discrepancy';
      discrepancyReason = `Payout gross ${settledGross.toString()}p does not match card sales ${cardGross.toString()}p for business date ${businessDateValue}`;
    }

    // Fee differences post a fee-adjustment entry, never a silent
    // correction; reserves and disputes are distinct lines, never
    // missing sales.
    let feeAdjustment: SettlementReconciliation['feeAdjustment'] = null;
    if (matched.length > 0 && settledFee !== feeEstimate) {
      const zReports = await this.db
        .selectFrom('z_reports')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('business_date', '=', businessDateValue)
        .execute();
      feeAdjustment = {
        estimatedFeePence: feeEstimate,
        settledFeePence: settledFee,
        adjustmentPence: settledFee - feeEstimate,
        zReportIds: zReports.map((z) => z.id),
      };
      await this.audit.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'settlement.fee_adjustment',
        entityType: 'settlement',
        entityId: null,
        payload: {
          businessDate: businessDateValue,
          settlementDate,
          estimatedFeePence: feeEstimate.toString(),
          settledFeePence: settledFee.toString(),
          adjustmentPence: (settledFee - feeEstimate).toString(),
          zReportIds: feeAdjustment.zReportIds,
        },
      });
    }
    if (status === 'discrepancy') {
      await this.audit.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'settlement.discrepancy',
        entityType: 'settlement',
        entityId: null,
        payload: {
          businessDate: businessDateValue,
          settlementDate,
          cardGrossPence: cardGross.toString(),
          settledGrossPence: settledGross.toString(),
          reserveHoldTotalPence: reserveTotal.toString(),
          disputeDebitTotalPence: disputeTotal.toString(),
          reason: discrepancyReason,
        },
      });
    }
    return {
      businessDate: businessDateValue,
      settlementDate,
      cardGrossPence: cardGross,
      feeEstimatePence: feeEstimate,
      payouts: matched,
      otherSettlementDatePayouts: others,
      settledGrossPence: settledGross,
      settledFeePence: settledFee,
      reserveHoldTotalPence: reserveTotal,
      disputeDebitTotalPence: disputeTotal,
      expectedNetPayoutPence: expectedNet,
      feeAdjustment,
      status,
      discrepancyReason,
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async loadSession(
    q: Kysely<DB>,
    actor: Actor,
    sessionId: string,
  ): Promise<SessionRow> {
    const session = await q
      .selectFrom('register_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (session === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const register = await q
      .selectFrom('registers')
      .select(['id', 'location_id'])
      .where('id', '=', session.register_id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (register === undefined || register.location_id !== actor.locationId) {
      throw new NotFoundException('Resource not found');
    }
    return session;
  }

  /**
   * Verify a manager approval row directly (used where no dedicated
   * ApprovalAction exists: zero-float open, carry-forward, corrections).
   * The row must belong to this tenant, its approver must hold
   * manager/admin/owner at the actor's location, and requester !=
   * approver (the DB CHECK is the backstop for the last rule).
   */
  private async verifyManagerApprovalRow(
    q: Kysely<DB>,
    actor: Actor,
    approvalEventId: string,
  ): Promise<void> {
    const approval = await q
      .selectFrom('approval_events')
      .selectAll()
      .where('id', '=', approvalEventId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (approval === undefined) {
      throw new BadRequestException('No matching manager approval found');
    }
    if (approval.requested_by_user_id === approval.approved_by_user_id) {
      throw new BadRequestException('An approval cannot be granted by the user who requested it');
    }
    const approverRole = await q
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select('roles.name')
      .where('user_roles.user_id', '=', approval.approved_by_user_id)
      .where('user_roles.location_id', '=', actor.locationId)
      .where('roles.tenant_id', '=', actor.tenantId)
      .where('roles.name', 'in', ['manager', 'admin', 'owner'])
      .executeTakeFirst();
    if (approverRole === undefined) {
      throw new BadRequestException('The approval was not granted by a manager, admin or owner at this location');
    }
  }

  /** London business date of the session's opening. */
  private sessionBusinessDate(session: SessionRow): string {
    return businessDate(session.opened_at);
  }

  /** Completed orders in the session window (register + date + created_at). */
  private async windowOrders(
    q: Kysely<DB>,
    actor: Actor,
    session: SessionRow,
    windowEnd: Date,
  ): Promise<Array<{ id: string; total_pence: bigint; status: string }>> {
    return q
      .selectFrom('orders')
      .select(['id', 'total_pence', 'status'])
      .where('tenant_id', '=', actor.tenantId)
      .where('register_id', '=', session.register_id)
      .where('business_date', '=', this.sessionBusinessDate(session))
      .where('created_at', '>=', session.opened_at)
      .where('created_at', '<=', windowEnd)
      .execute();
  }

  private async computeExpectedCash(
    trx: Kysely<DB>,
    actor: Actor,
    session: SessionRow,
    windowEnd: Date,
  ): Promise<bigint> {
    const orders = await this.windowOrders(trx, actor, session, windowEnd);
    const completedIds = orders.filter((o) => o.status === 'completed').map((o) => o.id);

    let cashSales = 0n;
    if (completedIds.length > 0) {
      const tenders = await trx
        .selectFrom('order_tenders')
        .select('amount_pence')
        .where('tenant_id', '=', actor.tenantId)
        .where('tender_type', '=', 'cash')
        .where('order_id', 'in', completedIds)
        .execute();
      cashSales = tenders.reduce((s, t) => s + t.amount_pence, 0n);
    }

    // Cash refunds: completed refunds with no payment attempt (see the
    // module header note), on orders in this session's window.
    let cashRefunds = 0n;
    if (completedIds.length > 0) {
      const refunds = await trx
        .selectFrom('refunds')
        .select('amount_pence')
        .where('tenant_id', '=', actor.tenantId)
        .where('status', '=', 'completed')
        .where('payment_attempt_id', 'is', null)
        .where('order_id', 'in', completedIds)
        .where('created_at', '>=', session.opened_at)
        .where('created_at', '<=', windowEnd)
        .execute();
      cashRefunds = refunds.reduce((s, r) => s + r.amount_pence, 0n);
    }

    const movements = await trx
      .selectFrom('cash_movements')
      .select(['type', 'amount_pence'])
      .where('tenant_id', '=', actor.tenantId)
      .where('session_id', '=', session.id)
      .execute();
    const sumType = (type: string): bigint =>
      movements.filter((m) => m.type === type).reduce((s, m) => s + m.amount_pence, 0n);

    // EXACT formula from the commission (D-07/D-08, Arch-01 §2.6).
    return (
      session.float_pence +
      cashSales -
      cashRefunds -
      sumType('cash_out') +
      sumType('cash_in') -
      sumType('petty_cash_out') +
      sumType('petty_cash_in')
    );
  }

  /** Pending ('created'/'pending') or 'unknown' attempts on window orders. */
  private async pendingPaymentAttempts(
    trx: Kysely<DB>,
    actor: Actor,
    session: SessionRow,
    windowEnd: Date,
  ): Promise<Array<{ id: string; status: string }>> {
    const orders = await this.windowOrders(trx, actor, session, windowEnd);
    if (orders.length === 0) {
      return [];
    }
    return trx
      .selectFrom('payment_attempts')
      .select(['id', 'status'])
      .where('tenant_id', '=', actor.tenantId)
      .where('order_id', 'in', orders.map((o) => o.id))
      .where('status', 'in', ['created', 'pending', 'unknown'])
      .execute();
  }

  private async nextZNumber(trx: Kysely<DB>, registerId: string): Promise<bigint> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`z_number|${registerId}`}))`.execute(trx);
    const result = await sql<{ max_number: string | bigint | null }>`
      SELECT MAX(z_number) AS max_number FROM z_reports
      WHERE register_id = ${registerId}
    `.execute(trx);
    const max = result.rows[0]?.max_number;
    return (max == null ? 0n : BigInt(max)) + 1n;
  }

  private async issueZReport(
    trx: Kysely<DB>,
    actor: Actor,
    session: SessionRow,
    closedAt: Date,
    carriedForwardAttemptIds: string[],
  ): Promise<ZReportView> {
    const businessDateValue = this.sessionBusinessDate(session);
    // The session's trading window ends at End, not at Close: expected
    // cash is computed at End, so the Z-report must aggregate the same
    // window (sales after End belong to the next session).
    const windowEnd = session.ended_at ?? closedAt;
    const orders = await this.windowOrders(trx, actor, session, windowEnd);
    const completed = orders.filter((o) => o.status === 'completed');
    const voided = orders.filter((o) => o.status === 'voided');
    const completedIds = completed.map((o) => o.id);

    const gross = completed.reduce((s, o) => s + o.total_pence, 0n);
    const voidTotal = voided.reduce((s, o) => s + o.total_pence, 0n);

    let discount = 0n;
    let vat = 0n;
    const vatByKind = new Map<TaxRateKind, { percent: string; gross: bigint; vat: bigint; lineCount: number }>();
    let refundTotal = 0n;
    let refundCount = 0;
    let feeEstimate = 0n;
    const tenderByType = new Map<string, { amount: bigint; count: number }>();

    if (completedIds.length > 0) {
      const orderRows = await trx
        .selectFrom('orders')
        .select(['discount_pence'])
        .where('tenant_id', '=', actor.tenantId)
        .where('id', 'in', completedIds)
        .execute();
      discount = orderRows.reduce((s, o) => s + o.discount_pence, 0n);

      const lines = await trx
        .selectFrom('order_lines')
        .selectAll()
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .execute();
      for (const line of lines) {
        vat += line.tax_amount_pence;
        const existing = vatByKind.get(line.tax_rate_kind);
        if (existing !== undefined) {
          if (existing.percent !== line.tax_rate_percent) {
            throw new Error(
              `Orders for Z-report have mixed tax percents for rate ${line.tax_rate_kind}`,
            );
          }
          existing.gross += line.line_total_pence;
          existing.vat += line.tax_amount_pence;
          existing.lineCount += 1;
        } else {
          vatByKind.set(line.tax_rate_kind, {
            percent: line.tax_rate_percent,
            gross: line.line_total_pence,
            vat: line.tax_amount_pence,
            lineCount: 1,
          });
        }
      }

      const tenders = await trx
        .selectFrom('order_tenders')
        .selectAll()
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .execute();
      for (const tender of tenders) {
        const existing = tenderByType.get(tender.tender_type) ?? { amount: 0n, count: 0 };
        existing.amount += tender.amount_pence;
        existing.count += 1;
        tenderByType.set(tender.tender_type, existing);
      }

      const attempts = await trx
        .selectFrom('payment_attempts')
        .select(['amount_pence'])
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .where('status', '=', 'approved')
        .execute();
      feeEstimate = attempts.reduce((s, a) => s + cardFeeEstimatePence(a.amount_pence), 0n);

      const refunds = await trx
        .selectFrom('refunds')
        .select(['amount_pence'])
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .where('status', '=', 'completed')
        .execute();
      refundTotal = refunds.reduce((s, r) => s + r.amount_pence, 0n);
      refundCount = refunds.length;
    }

    const net = gross - vat;
    const zNumber = await this.nextZNumber(trx, session.register_id);

    // Corrections carried from the immediately preceding issued Z-report
    // for this register (never netted into this Z-report's sales).
    const predecessor = await trx
      .selectFrom('z_reports')
      .select('id')
      .where('tenant_id', '=', actor.tenantId)
      .where('register_id', '=', session.register_id)
      .where('status', '=', 'issued')
      .orderBy('z_number', 'desc')
      .limit(1)
      .executeTakeFirst();
    let carriedCorrections: CarriedCorrectionView[] = [];
    if (predecessor !== undefined) {
      const rows = await trx
        .selectFrom('z_report_corrections')
        .selectAll()
        .where('z_report_id', '=', predecessor.id)
        .orderBy('created_at', 'asc')
        .execute();
      carriedCorrections = rows.map((r) => ({
        id: r.id,
        originalZReportId: r.z_report_id,
        correctionType: r.correction_type,
        amountPence: r.amount_pence,
        reason: r.reason,
      }));
    }
    const carriedTotal = carriedCorrections.reduce((s, c) => s + c.amountPence, 0n);

    const z = await trx
      .insertInto('z_reports')
      .values({
        tenant_id: actor.tenantId,
        register_id: session.register_id,
        session_id: session.id,
        z_number: zNumber,
        business_date: businessDateValue,
        status: 'issued',
        issued_at: closedAt,
        gross_pence: gross,
        net_pence: net,
        vat_pence: vat,
        discount_pence: discount,
        refund_pence: refundTotal,
        cash_expected_pence: session.expected_cash_pence,
        cash_counted_pence: session.counted_cash_pence,
        cash_variance_pence: session.variance_pence,
        order_count: completed.length,
        void_count: voided.length,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const vatLines: VatLineView[] = [];
    for (const kind of TAX_RATE_ORDER) {
      const totals = vatByKind.get(kind);
      if (totals === undefined) {
        continue;
      }
      await trx
        .insertInto('z_report_vat_lines')
        .values({
          z_report_id: z.id,
          tax_rate_kind: kind,
          tax_rate_percent: totals.percent,
          gross_pence: totals.gross,
          vat_pence: totals.vat,
          net_pence: totals.gross - totals.vat,
        })
        .execute();
      vatLines.push({
        taxRateKind: kind,
        taxRatePercent: totals.percent,
        grossPence: totals.gross,
        vatPence: totals.vat,
        netPence: totals.gross - totals.vat,
        lineCount: totals.lineCount,
      });
    }
    const tenderLines: TenderLineView[] = [];
    for (const [tenderType, totals] of [...tenderByType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      await trx
        .insertInto('z_report_tender_lines')
        .values({
          z_report_id: z.id,
          tender_type: tenderType as TenderLineView['tenderType'],
          amount_pence: totals.amount,
          transaction_count: totals.count,
        })
        .execute();
      tenderLines.push({
        tenderType: tenderType as TenderLineView['tenderType'],
        amountPence: totals.amount,
        transactionCount: totals.count,
      });
    }

    const promotionBreakdown = await this.promotionBreakdownForOrders(trx, actor, completedIds);

    await this.audit.record(trx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'z_report.issued',
      entityType: 'z_report',
      entityId: z.id,
      payload: {
        zNumber: zNumber.toString(),
        businessDate: businessDateValue,
        grossPence: gross.toString(),
        netPence: net.toString(),
        vatPence: vat.toString(),
        discountPence: discount.toString(),
        refundPence: refundTotal.toString(),
        cardFeeEstimatePence: feeEstimate.toString(),
        voidCount: String(voided.length),
        voidTotalPence: voidTotal.toString(),
        carriedCorrectionTotalPence: carriedTotal.toString(),
        carriedForwardAttemptIds,
      },
    });

    return {
      zReport: z,
      vatLines,
      tenderLines,
      promotionBreakdown,
      carriedCorrections,
      carriedCorrectionTotalPence: carriedTotal,
      cardFeeEstimatePence: feeEstimate,
      voidTotalPence: voidTotal,
      refundCount,
    };
  }

  private async buildZReportView(
    q: Kysely<DB>,
    actor: Actor,
    z: ZReportRow,
  ): Promise<ZReportView> {
    const vatRows = await q
      .selectFrom('z_report_vat_lines')
      .selectAll()
      .where('z_report_id', '=', z.id)
      .execute();
    const session = await q
      .selectFrom('register_sessions')
      .selectAll()
      .where('id', '=', z.session_id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirstOrThrow();
    const orders = await this.windowOrders(
      q,
      actor,
      session,
      session.ended_at ?? session.closed_at ?? new Date(),
    );
    const completedIds = orders.filter((o) => o.status === 'completed').map((o) => o.id);

    // line_count is not stored on z_report_vat_lines: recompute it from
    // the (immutable) completed order lines for the session window.
    const lineCounts = new Map<TaxRateKind, number>();
    if (completedIds.length > 0) {
      const counts = await q
        .selectFrom('order_lines')
        .select(['tax_rate_kind', sql<string>`COUNT(*)::text`.as('n')])
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .groupBy('tax_rate_kind')
        .execute();
      for (const row of counts) {
        lineCounts.set(row.tax_rate_kind, Number(row.n));
      }
    }
    const vatLines: VatLineView[] = vatRows
      .map((row) => ({
        taxRateKind: row.tax_rate_kind,
        taxRatePercent: row.tax_rate_percent,
        grossPence: row.gross_pence,
        vatPence: row.vat_pence,
        netPence: row.net_pence,
        lineCount: lineCounts.get(row.tax_rate_kind) ?? 0,
      }))
      .sort((a, b) => TAX_RATE_ORDER.indexOf(a.taxRateKind) - TAX_RATE_ORDER.indexOf(b.taxRateKind));

    const tenderRows = await q
      .selectFrom('z_report_tender_lines')
      .selectAll()
      .where('z_report_id', '=', z.id)
      .execute();
    const tenderLines: TenderLineView[] = tenderRows.map((row) => ({
      tenderType: row.tender_type,
      amountPence: row.amount_pence,
      transactionCount: row.transaction_count,
    }));

    const promotionBreakdown = await this.promotionBreakdownForOrders(q, actor, completedIds);

    // Carried corrections: corrections on the immediately preceding
    // issued Z-report for this register (same rule as at issuance).
    const predecessor = await q
      .selectFrom('z_reports')
      .select('id')
      .where('tenant_id', '=', actor.tenantId)
      .where('register_id', '=', z.register_id)
      .where('status', '=', 'issued')
      .where('z_number', '<', z.z_number)
      .orderBy('z_number', 'desc')
      .limit(1)
      .executeTakeFirst();
    let carriedCorrections: CarriedCorrectionView[] = [];
    if (predecessor !== undefined) {
      const rows = await q
        .selectFrom('z_report_corrections')
        .selectAll()
        .where('z_report_id', '=', predecessor.id)
        .orderBy('created_at', 'asc')
        .execute();
      carriedCorrections = rows.map((r) => ({
        id: r.id,
        originalZReportId: r.z_report_id,
        correctionType: r.correction_type,
        amountPence: r.amount_pence,
        reason: r.reason,
      }));
    }

    let feeEstimate = 0n;
    let voidTotal = 0n;
    let refundCount = 0;
    if (completedIds.length > 0) {
      const attempts = await q
        .selectFrom('payment_attempts')
        .select(['amount_pence'])
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .where('status', '=', 'approved')
        .execute();
      feeEstimate = attempts.reduce((s, a) => s + cardFeeEstimatePence(a.amount_pence), 0n);
      const refunds = await q
        .selectFrom('refunds')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', 'in', completedIds)
        .where('status', '=', 'completed')
        .execute();
      refundCount = refunds.length;
    }
    voidTotal = orders
      .filter((o) => o.status === 'voided')
      .reduce((s, o) => s + o.total_pence, 0n);

    return {
      zReport: z,
      vatLines,
      tenderLines,
      promotionBreakdown,
      carriedCorrections,
      carriedCorrectionTotalPence: carriedCorrections.reduce((s, c) => s + c.amountPence, 0n),
      cardFeeEstimatePence: feeEstimate,
      voidTotalPence: voidTotal,
      refundCount,
    };
  }

  /** Per-promotion discount totals for completed orders (Arch-10 §5.3). */
  private async promotionBreakdownForOrders(
    q: Kysely<DB>,
    actor: Actor,
    orderIds: string[],
  ): Promise<PromotionBreakdownView[]> {
    if (orderIds.length === 0) {
      return [];
    }
    const rows = await q
      .selectFrom('applied_promotions')
      .innerJoin('promotions', 'promotions.id', 'applied_promotions.promotion_id')
      .select([
        'applied_promotions.promotion_id',
        'promotions.name',
        'applied_promotions.promotion_version',
        sql<string>`COALESCE(SUM(applied_promotions.discount_pence), 0)::text`.as('total'),
      ])
      .where('applied_promotions.tenant_id', '=', actor.tenantId)
      .where('applied_promotions.order_id', 'in', orderIds)
      .where('applied_promotions.voided', '=', false)
      .groupBy([
        'applied_promotions.promotion_id',
        'promotions.name',
        'applied_promotions.promotion_version',
      ])
      .orderBy('promotions.name', 'asc')
      .execute();
    return rows.map((row) => ({
      promotionId: row.promotion_id,
      promotionName: row.name,
      promotionVersion: row.promotion_version,
      discountPence: BigInt(row.total),
    }));
  }

  /**
   * Completed refunds created in [start, end] (by London business date
   * of created_at), allocated per rate from their original order lines.
   * Used for the VAT-period CSV refund_adjustment_pence column.
   */
  private async refundAdjustmentsForPeriod(
    q: Kysely<DB>,
    actor: Actor,
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<TaxRateKind, { percent: string; grossPence: bigint; vatPence: bigint; netPence: bigint }>> {
    const refunds = await q
      .selectFrom('refunds')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('status', '=', 'completed')
      .execute();
    const inPeriod = refunds.filter((r) => {
      const d = businessDate(r.created_at);
      return d >= periodStart && d <= periodEnd;
    });
    return this.allocateRefundsPerRate(q, actor, inPeriod);
  }

  /**
   * Restatements for a period close: completed refunds created in this
   * period whose original order's business_date is BEFORE the period.
   */
  private async restatementsForPeriod(
    q: Kysely<DB>,
    actor: Actor,
    periodStart: string,
    periodEnd: string,
  ): Promise<VatRestatementView[]> {
    const refunds = await q
      .selectFrom('refunds')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('status', '=', 'completed')
      .execute();
    const restatements: VatRestatementView[] = [];
    for (const refund of refunds) {
      const refundDate = businessDate(refund.created_at);
      if (refundDate < periodStart || refundDate > periodEnd) {
        continue;
      }
      const order = await q
        .selectFrom('orders')
        .select(['business_date'])
        .where('id', '=', refund.order_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      // business_date comes back as a Date from the driver; compare
      // formatted ISO dates, never a Date against a string.
      const originalDate = order === undefined ? null : formatDate(order.business_date);
      if (originalDate === null || originalDate >= periodStart) {
        continue;
      }
      const perRateMap = await this.allocateRefundsPerRate(q, actor, [refund]);
      const perRate: VatLineView[] = [...perRateMap.entries()].map(([kind, totals]) => ({
        taxRateKind: kind,
        taxRatePercent: totals.percent,
        grossPence: totals.grossPence,
        vatPence: totals.vatPence,
        netPence: totals.netPence,
        lineCount: 0,
      }));
      restatements.push({
        refundId: refund.id,
        orderId: refund.order_id,
        originalBusinessDate: originalDate,
        refundBusinessDate: refundDate,
        amountPence: refund.amount_pence,
        perRate,
      });
    }
    return restatements;
  }

  /**
   * Allocate each refund across its original order's lines pro-rata by
   * line total (D-14 helper, reused — never reimplemented), then split
   * each slice into net/VAT with the shared kernel (D-13).
   */
  private async allocateRefundsPerRate(
    q: Kysely<DB>,
    actor: Actor,
    refunds: Array<Selectable<RefundsTable>>,
  ): Promise<Map<TaxRateKind, { percent: string; grossPence: bigint; vatPence: bigint; netPence: bigint }>> {
    const byRate = new Map<TaxRateKind, { percent: string; grossPence: bigint; vatPence: bigint; netPence: bigint }>();
    for (const refund of refunds) {
      const lines = await q
        .selectFrom('order_lines')
        .selectAll()
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', '=', refund.order_id)
        .execute();
      if (lines.length === 0) {
        continue;
      }
      const orderTotal = lines.reduce((s, l) => s + l.line_total_pence, 0n);
      if (refund.amount_pence > orderTotal) {
        throw new Error(
          `Refund ${refund.id} of ${refund.amount_pence.toString()}p exceeds its order total ${orderTotal.toString()}p`,
        );
      }
      const allocations = allocateBasketDiscount(
        refund.amount_pence,
        lines.map((l) => ({ lineTotalPence: l.line_total_pence })),
      );
      lines.forEach((line, i) => {
        const slice = allocations[i] ?? 0n;
        if (slice === 0n) {
          return;
        }
        const breakdown = taxBreakdownForLine(slice, line.tax_rate_kind);
        const existing = byRate.get(line.tax_rate_kind) ?? {
          percent: line.tax_rate_percent,
          grossPence: 0n,
          vatPence: 0n,
          netPence: 0n,
        };
        existing.grossPence += breakdown.grossPence;
        existing.vatPence += breakdown.vatPence;
        existing.netPence += breakdown.netPence;
        byRate.set(line.tax_rate_kind, existing);
      });
    }
    return byRate;
  }

  private async orderLineCountsForPeriod(
    q: Kysely<DB>,
    actor: Actor,
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<TaxRateKind, number>> {
    const counts = await q
      .selectFrom('order_lines')
      .innerJoin('orders', 'orders.id', 'order_lines.order_id')
      .select(['order_lines.tax_rate_kind', sql<string>`COUNT(*)::text`.as('n')])
      .where('order_lines.tenant_id', '=', actor.tenantId)
      .where('orders.status', '=', 'completed')
      .where('orders.business_date', '>=', periodStart)
      .where('orders.business_date', '<=', periodEnd)
      .groupBy('order_lines.tax_rate_kind')
      .execute();
    const map = new Map<TaxRateKind, number>();
    for (const row of counts) {
      map.set(row.tax_rate_kind, Number(row.n));
    }
    return map;
  }
}
