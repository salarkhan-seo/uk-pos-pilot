/**
 * PaymentsService — provider adapter use, W-12 unknown-payment
 * resolution, late-webhook discrepancies (Build-03 Objective 2;
 * Arch-02 §6.2–§6.5, Arch-03).
 *
 * THE RULE (Arch-02 §6.3, absolute): never assume approved or declined.
 * No path in this service marks an order paid without provider evidence
 * or a manager-approved standalone reference:
 *  - provider status query resolves unknown → approved/declined on the
 *    provider's answer only (path (a));
 *  - terminal reconciliation records the terminal evidence FIRST, then
 *    still resolves on the provider's answer — never on the terminal's
 *    display alone (path (b));
 *  - manager decision (path (c)) requires a `void_post_tender`
 *    approval_events row: void the unknown attempt and retry with a
 *    fresh idempotency key (the old attempt stays `unknown`, never
 *    deleted, never rewritten), OR record a standalone/manual tender
 *    with a physical terminal reference.
 *
 * The adapter is swappable via setAdapter(); the default is the
 * deterministic SimulatedStripeTerminalAdapter — no network calls, ever.
 * The EventPublisher (integrations module, Build-03 Objective 4) is
 * optional: without one, the hash-chained audit log is the durable
 * record and publishing is skipped.
 *
 * Duplicate webhooks are deduped by event id at the adapter (G-A-08);
 * a webhook arriving after its order was voided/refunded creates a
 * discrepancy alert in audit_events (event_type 'payment.discrepancy')
 * and a discrepancy event — never a silent second sale (G-A-07).
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Kysely, type Selectable } from 'kysely';
import type { DB, PaymentAttemptsTable } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { ApprovalService } from '../admin/approval.service';
import { AuditService } from '../admin/audit.service';
import type {
  PaymentAdapter,
  PayoutSchedule,
  ProviderWebhookEvent,
} from './payment-adapter.interface';
import { SimulatedStripeTerminalAdapter } from './simulated-stripe-terminal.adapter';
import type { EventPublisher } from './event-publisher.interface';
import type { DBWithRefundRetry } from '../sales/refund-retry-schema';

export type PaymentAttemptRow = Selectable<PaymentAttemptsTable>;

export class UnknownPaymentEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPaymentEvidenceError';
  }
}

/** UUID-format guard: approval ids arrive from callers, and comparing a
 * non-UUID string against a uuid column raises a DB error (22P02)
 * instead of "no such approval". Anything malformed is simply not a
 * valid approval — BadRequest, never a 500. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Business dates are stored as a `date` column, so a read can return a
 * JS Date instead of the 'YYYY-MM-DD' string the service wrote. The
 * adapter's settlement ledger is keyed by the string form.
 */
export function toBusinessDateString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value;
}

export interface CreateCardAttemptInput {
  orderId: string;
  amountPence: bigint;
  idempotencyKey?: string;
}

export interface MarkAttemptUnknownInput {
  paymentAttemptId: string;
  reason: 'timeout' | 'terminal_disconnect' | 'late_webhook';
}

export interface ResolveUnknownResult {
  attempt: PaymentAttemptRow;
  orderId: string;
  outcome: 'approved' | 'declined' | 'unknown' | 'pending';
  resolved: boolean;
  terminalEvidenceRecorded?: boolean;
}

export interface ManagerDecisionInput {
  paymentAttemptId: string;
  decision: 'void_and_retry' | 'standalone';
  approvalEventsId: string;
  terminalReference?: string;
  resolutionNote?: string;
}

export interface ManagerDecisionResult {
  /** The new attempt (retry, or the approved standalone attempt). */
  attempt: PaymentAttemptRow;
  /** The old attempt — retained as `unknown`, never deleted/rewritten. */
  oldAttempt: PaymentAttemptRow;
  decision: 'void_and_retry' | 'standalone';
}

export interface DiscrepancyInput {
  paymentAttemptId?: string | null;
  orderId: string;
  reason: string;
  webhookContent: Record<string, unknown>;
}

export type WebhookAction =
  | 'resolved'
  | 'duplicate'
  | 'discrepancy'
  | 'ignored'
  | 'refund_failed'
  | 'dispute_noted';

export interface WebhookIngestResult {
  action: WebhookAction;
  eventId: string;
  paymentAttemptId?: string | null;
  orderId?: string | null;
}

const TERMINAL_ATTEMPT_STATUSES = ['approved', 'declined', 'refunded'] as const;

@Injectable()
export class PaymentsService {
  /** Swappable provider adapter; default is the simulated Stripe one. */
  private adapter: PaymentAdapter = new SimulatedStripeTerminalAdapter();
  private eventPublisher?: EventPublisher;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
  ) {}

  status(): { module: string; status: string } {
    return {
      module: 'payments',
      status: 'Build-03 Objective 2 — simulated Stripe Terminal adapter, W-12 resolution, discrepancies',
    };
  }

  getAdapter(): PaymentAdapter {
    return this.adapter;
  }

  setAdapter(adapter: PaymentAdapter): void {
    this.adapter = adapter;
  }

  setEventPublisher(publisher?: EventPublisher): void {
    this.eventPublisher = publisher;
  }

  // ------------------------------------------------------------------
  // createCardAttempt — one attempt per tender, idempotent by key.
  // A retry with the same idempotency key returns the original attempt
  // (G-A-09); a retry with a new key creates a new attempt.
  // ------------------------------------------------------------------

  async createCardAttempt(actor: Actor, input: CreateCardAttemptInput): Promise<PaymentAttemptRow> {
    if (input.amountPence <= 0n) {
      throw new BadRequestException('Attempt amount must be greater than zero');
    }
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.orderId)
        .where('tenant_id', '=', actor.tenantId)
        .where('location_id', '=', actor.locationId)
        .executeTakeFirst();
      if (order === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (order.status !== 'draft' && order.status !== 'pending_payment') {
        throw new BadRequestException(
          `Cannot create a card attempt for an order in status ${order.status}`,
        );
      }

      const idempotencyKey = input.idempotencyKey ?? randomUUID();
      const existing = await trx
        .selectFrom('payment_attempts')
        .selectAll()
        .where('tenant_id', '=', actor.tenantId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        return existing;
      }

      const result = await this.adapter.createAttempt({
        idempotencyKey,
        orderId: order.id,
        amountPence: input.amountPence,
        currency: 'GBP',
        businessDate: toBusinessDateString(order.business_date),
        metadataCustomId: idempotencyKey,
      });

      const existingCount = await trx
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .execute();

      const attempt = await trx
        .insertInto('payment_attempts')
        .values({
          tenant_id: actor.tenantId,
          order_id: order.id,
          idempotency_key: idempotencyKey,
          provider: 'stripe',
          provider_reference: result.providerReference,
          status: result.status,
          amount_pence: input.amountPence,
          currency: 'GBP',
          attempt_number: existingCount.length + 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment.attempt_created',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        payload: {
          orderId: order.id,
          amountPence: input.amountPence.toString(),
          adapterStatus: result.status,
          providerReference: result.providerReference ?? null,
        },
      });

      return attempt;
    });
  }

  // ------------------------------------------------------------------
  // markAttemptUnknown — G-A-01/G-A-02: timeout or terminal disconnect.
  // The order stays pending_payment; the till shows the W-12 banner.
  // ------------------------------------------------------------------

  async markAttemptUnknown(actor: Actor, input: MarkAttemptUnknownInput): Promise<PaymentAttemptRow> {
    return this.db.transaction().execute(async (trx) => {
      const attempt = await this.loadAttempt(trx, actor, input.paymentAttemptId);
      if (
        (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)
      ) {
        throw new BadRequestException(
          `Payment attempt is ${attempt.status} and can no longer become unknown`,
        );
      }
      const updated = await trx
        .updateTable('payment_attempts')
        .set({ status: 'unknown' })
        .where('id', '=', attempt.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment.unknown',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        payload: {
          orderId: attempt.order_id,
          attemptId: attempt.id,
          reason: input.reason,
        },
      });
      await this.publish('payment.unknown', {
        payment_attempt_id: attempt.id,
        order_id: attempt.order_id,
        attempt_id_display: attempt.id,
        reason: input.reason,
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------
  // W-12 path (a) — provider status query by attempt id / metadata
  // custom ID. Resolves unknown → approved (order may then complete) or
  // declined (order stays open for another tender). An unanswered query
  // leaves the attempt unknown.
  // ------------------------------------------------------------------

  async resolveUnknownByProviderQuery(
    actor: Actor,
    input: { paymentAttemptId: string },
  ): Promise<ResolveUnknownResult> {
    return this.db.transaction().execute(async (trx) => {
      const attempt = await this.loadAttempt(trx, actor, input.paymentAttemptId);
      if (attempt.status !== 'unknown') {
        throw new BadRequestException(
          `Only an unknown payment attempt can be resolved by provider query (attempt is ${attempt.status})`,
        );
      }
      const result = await this.adapter.queryStatus({
        paymentAttemptId: attempt.id,
        providerReference: attempt.provider_reference,
        metadataCustomId: attempt.idempotency_key,
      });
      return this.applyQueryResult(trx, actor, attempt, result.status, result.providerReference);
    });
  }

  // ------------------------------------------------------------------
  // W-12 path (b) — terminal reconciliation. The terminal evidence
  // (reader report reference) is recorded in the audit log BEFORE any
  // resolution is attempted, and the resolution still follows the
  // provider's answer — never the terminal's display alone (Arch-02
  // §6.3 step 3).
  // ------------------------------------------------------------------

  async reconcileTerminal(
    actor: Actor,
    input: { paymentAttemptId: string; terminalEvidence: string },
  ): Promise<ResolveUnknownResult> {
    if (input.terminalEvidence === undefined || input.terminalEvidence.trim() === '') {
      throw new BadRequestException('Terminal reconciliation requires the terminal evidence (reader report reference)');
    }
    return this.db.transaction().execute(async (trx) => {
      const attempt = await this.loadAttempt(trx, actor, input.paymentAttemptId);
      if (attempt.status !== 'unknown') {
        throw new BadRequestException(
          `Only an unknown payment attempt can be reconciled (attempt is ${attempt.status})`,
        );
      }
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment.terminal_reconciled',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        payload: {
          orderId: attempt.order_id,
          attemptId: attempt.id,
          terminalEvidence: input.terminalEvidence,
        },
      });
      const result = await this.adapter.queryStatus({
        paymentAttemptId: attempt.id,
        providerReference: attempt.provider_reference,
        metadataCustomId: attempt.idempotency_key,
      });
      const resolved = await this.applyQueryResult(
        trx,
        actor,
        attempt,
        result.status,
        result.providerReference,
      );
      return { ...resolved, terminalEvidenceRecorded: true };
    });
  }

  // ------------------------------------------------------------------
  // W-12 path (c) — manager decision. Requires a valid
  // `void_post_tender` approval_events row (approver !== requester is
  // enforced when the approval was created). Either:
  //  - void_and_retry: the old attempt stays `unknown` with a resolution
  //    note (audit); a NEW attempt is created with a FRESH idempotency
  //    key and the order's card tender is repointed at it;
  //  - standalone: a NEW standalone attempt is created APPROVED with the
  //    physical terminal reference; the tender is repointed at it and
  //    the order may then complete on the manual tender (G-A-06).
  // ------------------------------------------------------------------

  async resolveUnknownByManagerDecision(
    actor: Actor,
    input: ManagerDecisionInput,
  ): Promise<ManagerDecisionResult> {
    return this.db.transaction().execute(async (trx) => {
      const attempt = await this.loadAttempt(trx, actor, input.paymentAttemptId);
      if (attempt.status !== 'unknown') {
        throw new BadRequestException(
          `Only an unknown payment attempt can be resolved by manager decision (attempt is ${attempt.status})`,
        );
      }
      const approvalOk =
        input.approvalEventsId !== undefined &&
        input.approvalEventsId !== '' &&
        isUuid(input.approvalEventsId) &&
        (await this.approvals.hasApproval(trx, {
          tenantId: actor.tenantId,
          approvalEventsId: input.approvalEventsId,
          action: 'void_post_tender',
        }));
      if (!approvalOk) {
        throw new BadRequestException(
          'Resolving an unknown payment by manager decision requires a valid manager void_post_tender approval',
        );
      }

      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', attempt.order_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirstOrThrow();

      if (input.decision === 'void_and_retry') {
        const freshKey = randomUUID();
        const adapterResult = await this.adapter.createAttempt({
          idempotencyKey: freshKey,
          orderId: order.id,
          amountPence: attempt.amount_pence,
          currency: 'GBP',
          businessDate: toBusinessDateString(order.business_date),
          metadataCustomId: freshKey,
        });
        const fresh = await trx
          .insertInto('payment_attempts')
          .values({
            tenant_id: actor.tenantId,
            order_id: order.id,
            idempotency_key: freshKey,
            provider: 'stripe',
            provider_reference: adapterResult.providerReference,
            status: adapterResult.status,
            amount_pence: attempt.amount_pence,
            currency: 'GBP',
            attempt_number: attempt.attempt_number + 1,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.repointCardTender(trx, actor, attempt.id, fresh.id);
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'payment.unknown_resolved',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          payload: {
            orderId: order.id,
            decision: 'void_and_retry',
            resolutionNote:
              input.resolutionNote ??
              'Unknown attempt voided by manager decision; retry with a fresh idempotency key. The old attempt stays unknown.',
            oldAttemptId: attempt.id,
            oldIdempotencyKey: attempt.idempotency_key,
            newAttemptId: fresh.id,
            newIdempotencyKey: freshKey,
            approvalEventsId: input.approvalEventsId,
          },
        });
        return { attempt: fresh, oldAttempt: attempt, decision: 'void_and_retry' };
      }

      if (input.decision === 'standalone') {
        if (input.terminalReference === undefined || input.terminalReference.trim() === '') {
          throw new BadRequestException(
            'A standalone/manual resolution requires the physical terminal reference',
          );
        }
        const freshKey = randomUUID();
        const manual = await trx
          .insertInto('payment_attempts')
          .values({
            tenant_id: actor.tenantId,
            order_id: order.id,
            idempotency_key: freshKey,
            provider: 'standalone',
            provider_reference: input.terminalReference,
            status: 'approved',
            amount_pence: attempt.amount_pence,
            currency: 'GBP',
            attempt_number: attempt.attempt_number + 1,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.repointCardTender(trx, actor, attempt.id, manual.id);
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'payment.unknown_resolved',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          payload: {
            orderId: order.id,
            decision: 'standalone',
            resolutionNote:
              input.resolutionNote ??
              'Unknown attempt resolved by manager decision: card taken on a standalone terminal.',
            oldAttemptId: attempt.id,
            newAttemptId: manual.id,
            terminalReference: input.terminalReference,
            approvalEventsId: input.approvalEventsId,
          },
        });
        return { attempt: manual, oldAttempt: attempt, decision: 'standalone' };
      }

      throw new BadRequestException(`Unknown manager decision: ${String(input.decision)}`);
    });
  }

  // ------------------------------------------------------------------
  // recordDiscrepancy — a late webhook (or any provider event that
  // contradicts the ledger) creates a discrepancy alert in audit_events
  // (event_type 'payment.discrepancy', with attempt id, order id and the
  // webhook content) and a discrepancy event. Never a silent second sale.
  // ------------------------------------------------------------------

  async recordDiscrepancy(
    actor: Actor,
    input: DiscrepancyInput,
  ): Promise<{ auditId: string }> {
    const recorded = await this.audit.record(this.db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'payment.discrepancy',
      entityType: 'payment_attempt',
      entityId: input.paymentAttemptId ?? null,
      payload: {
        orderId: input.orderId,
        attemptId: input.paymentAttemptId ?? null,
        reason: input.reason,
        webhookContent: input.webhookContent,
      },
    });
    await this.publish('payment.discrepancy', {
      payment_attempt_id: input.paymentAttemptId ?? null,
      order_id: input.orderId,
      reason: input.reason,
      webhook_content: input.webhookContent,
    });
    return { auditId: recorded.id };
  }

  // ------------------------------------------------------------------
  // ingestWebhook — reconcile a provider webhook against the ledger.
  // Duplicate event ids are ignored (G-A-08, logged as duplicates).
  // A webhook for a voided/refunded order is a discrepancy (G-A-07).
  // A webhook for a pending_payment order resolves the attempt.
  // `refund.failed` moves the refund to failed with its failure reason
  // and routes it to manual escalation (G-A-18).
  // ------------------------------------------------------------------

  async ingestWebhook(actor: Actor, event: ProviderWebhookEvent): Promise<WebhookIngestResult> {
    const { duplicate } = await this.adapter.ingestWebhook(event);
    if (duplicate) {
      await this.audit.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment.webhook_duplicate',
        entityType: 'payment_attempt',
        entityId: event.paymentAttemptId ?? null,
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          orderId: event.orderId ?? null,
        },
      });
      return {
        action: 'duplicate',
        eventId: event.eventId,
        paymentAttemptId: event.paymentAttemptId ?? null,
        orderId: event.orderId ?? null,
      };
    }

    if (event.type === 'refund.failed') {
      return this.handleRefundFailedWebhook(actor, event);
    }
    if (event.type === 'payment.dispute.created') {
      await this.audit.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment.dispute',
        entityType: 'payment_attempt',
        entityId: event.paymentAttemptId ?? null,
        payload: {
          eventId: event.eventId,
          orderId: event.orderId ?? null,
          providerReference: event.providerReference ?? null,
        },
      });
      await this.publish('payment.dispute.created', {
        payment_attempt_id: event.paymentAttemptId ?? null,
        order_id: event.orderId ?? null,
      });
      return {
        action: 'dispute_noted',
        eventId: event.eventId,
        paymentAttemptId: event.paymentAttemptId ?? null,
        orderId: event.orderId ?? null,
      };
    }
    if (event.type === 'payment_intent.succeeded' || event.type === 'payment.approved') {
      return this.handlePaymentOutcomeWebhook(actor, event, 'approved');
    }
    if (event.type === 'payment_intent.payment_failed' || event.type === 'payment.declined') {
      return this.handlePaymentOutcomeWebhook(actor, event, 'declined');
    }

    await this.audit.record(this.db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'payment.webhook_ignored',
      entityType: 'payment_attempt',
      entityId: event.paymentAttemptId ?? null,
      payload: { eventId: event.eventId, eventType: event.type, reason: 'unknown event type' },
    });
    return {
      action: 'ignored',
      eventId: event.eventId,
      paymentAttemptId: event.paymentAttemptId ?? null,
      orderId: event.orderId ?? null,
    };
  }

  /** Payout schedule for a business date (T+3 settlement, G-A-17). */
  payoutScheduleFor(businessDate: string): PayoutSchedule {
    return this.adapter.payoutScheduleFor(businessDate);
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async loadAttempt(
    q: Kysely<DB>,
    actor: Actor,
    paymentAttemptId: string,
  ): Promise<PaymentAttemptRow> {
    const attempt = await q
      .selectFrom('payment_attempts')
      .selectAll()
      .where('id', '=', paymentAttemptId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (attempt === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return attempt;
  }

  /**
   * Apply a provider query answer to an unknown attempt. Approved /
   * declined resolve it; unknown / pending leave it unknown. The
   * provider's answer is the ONLY evidence accepted here.
   */
  private async applyQueryResult(
    trx: Kysely<DB>,
    actor: Actor,
    attempt: PaymentAttemptRow,
    status: 'approved' | 'declined' | 'unknown' | 'pending',
    providerReference: string | null,
  ): Promise<ResolveUnknownResult> {
    if (status === 'approved' || status === 'declined') {
      const updated = await trx
        .updateTable('payment_attempts')
        .set({
          status,
          provider_reference: providerReference ?? attempt.provider_reference,
        })
        .where('id', '=', attempt.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      let tenderRemoved = false;
      if (status === 'declined') {
        // A declined tender never settled — no money moved — so its
        // tender row is removed and the order stays open for another
        // tender (Arch-02 §6.3 path (a)). Without this the order could
        // never complete: completeOrder sums ALL tenders, so a dead
        // 1000p card tender plus a 1000p cash tender would exceed the
        // total. The attempt row itself stays as the declined record,
        // and the audit event records the removal.
        const removed = await trx
          .deleteFrom('order_tenders')
          .where('tenant_id', '=', actor.tenantId)
          .where('payment_attempt_id', '=', attempt.id)
          .execute();
        tenderRemoved = removed.length > 0;
      }
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment_attempt.outcome',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        payload: {
          orderId: attempt.order_id,
          outcome: status,
          providerReference: providerReference ?? attempt.provider_reference ?? null,
          source: 'provider_query',
          tenderRemoved: String(tenderRemoved),
        },
      });
      if (status === 'approved') {
        const order = await trx
          .selectFrom('orders')
          .select('business_date')
          .where('id', '=', attempt.order_id)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirstOrThrow();
        this.adapter.recordApprovedSale(
          toBusinessDateString(order.business_date),
          attempt.amount_pence,
        );
        await this.publish('payment.approved', {
          payment_attempt_id: attempt.id,
          order_id: attempt.order_id,
        });
      }
      return { attempt: updated, orderId: attempt.order_id, outcome: status, resolved: true };
    }
    await this.audit.record(trx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'payment.query_no_answer',
      entityType: 'payment_attempt',
      entityId: attempt.id,
      payload: {
        orderId: attempt.order_id,
        providerStatus: status,
      },
    });
    return { attempt, orderId: attempt.order_id, outcome: status, resolved: false };
  }

  /** Repoint the order's card tender(s) from one attempt to another. */
  private async repointCardTender(
    trx: Kysely<DB>,
    actor: Actor,
    oldAttemptId: string,
    newAttemptId: string,
  ): Promise<void> {
    await trx
      .updateTable('order_tenders')
      .set({ payment_attempt_id: newAttemptId })
      .where('tenant_id', '=', actor.tenantId)
      .where('payment_attempt_id', '=', oldAttemptId)
      .execute();
  }

  /** Best-effort event publish: the audit log is the durable record, so
   * a publisher failure never fails the payment operation. */
  private async publish(eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (this.eventPublisher === undefined) {
      return;
    }
    try {
      await this.eventPublisher.publish(eventType, payload);
    } catch {
      // Deliberately swallowed: see the class comment.
    }
  }

  private async handlePaymentOutcomeWebhook(
    actor: Actor,
    event: ProviderWebhookEvent,
    outcome: 'approved' | 'declined',
  ): Promise<WebhookIngestResult> {
    const webhookContent: Record<string, unknown> = {
      eventId: event.eventId,
      type: event.type,
      ...(event.raw ?? {}),
    };
    return this.db.transaction().execute(async (trx) => {
      let attempt: PaymentAttemptRow | undefined;
      if (event.paymentAttemptId !== undefined) {
        attempt = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('id', '=', event.paymentAttemptId)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
      }
      if (attempt === undefined && event.providerReference !== undefined && event.providerReference !== null) {
        attempt = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('provider_reference', '=', event.providerReference)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
      }
      if (attempt === undefined) {
        // No attempt to reconcile against: a discrepancy, not a sale.
        await this.recordDiscrepancyInTrx(trx, actor, {
          paymentAttemptId: event.paymentAttemptId ?? null,
          orderId: event.orderId ?? '',
          reason: 'webhook_for_unknown_attempt',
          webhookContent,
        });
        return {
          action: 'discrepancy' as const,
          eventId: event.eventId,
          paymentAttemptId: event.paymentAttemptId ?? null,
          orderId: event.orderId ?? null,
        };
      }

      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', attempt.order_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirstOrThrow();

      // Late webhook: the order was already voided / refunded (or the
      // attempt was already declined and the webhook says approved).
      // Discrepancy alert — never a silent second sale (G-A-07).
      if (
        order.status === 'voided' ||
        order.status === 'returned' ||
        (outcome === 'approved' && attempt.status === 'declined')
      ) {
        await this.recordDiscrepancyInTrx(trx, actor, {
          paymentAttemptId: attempt.id,
          orderId: order.id,
          reason: 'late_webhook_after_void_or_refund',
          webhookContent,
        });
        return {
          action: 'discrepancy' as const,
          eventId: event.eventId,
          paymentAttemptId: attempt.id,
          orderId: order.id,
        };
      }
      if (order.status === 'completed') {
        // The sale already happened; the webhook changes nothing.
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'payment.webhook_ignored',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          payload: {
            eventId: event.eventId,
            eventType: event.type,
            orderId: order.id,
            reason: 'order already completed',
          },
        });
        return {
          action: 'ignored' as const,
          eventId: event.eventId,
          paymentAttemptId: attempt.id,
          orderId: order.id,
        };
      }

      // Order still pending_payment: the webhook resolves the attempt.
      if (attempt.status === 'created' || attempt.status === 'pending' || attempt.status === 'unknown') {
        const updated = await trx
          .updateTable('payment_attempts')
          .set({
            status: outcome,
            provider_reference: event.providerReference ?? attempt.provider_reference,
          })
          .where('id', '=', attempt.id)
          .where('tenant_id', '=', actor.tenantId)
          .returningAll()
          .executeTakeFirstOrThrow();
        let tenderRemoved = false;
        if (outcome === 'declined') {
          // Same rule as the provider-query path: a declined tender
          // never settled, so its tender row is removed and the order
          // stays open for another tender.
          const removed = await trx
            .deleteFrom('order_tenders')
            .where('tenant_id', '=', actor.tenantId)
            .where('payment_attempt_id', '=', attempt.id)
            .execute();
          tenderRemoved = removed.length > 0;
        }
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'payment_attempt.outcome',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          payload: {
            orderId: order.id,
            outcome,
            providerReference: event.providerReference ?? attempt.provider_reference ?? null,
            source: 'webhook',
            eventId: event.eventId,
            tenderRemoved: String(tenderRemoved),
          },
        });
        if (outcome === 'approved') {
          this.adapter.recordApprovedSale(
            toBusinessDateString(order.business_date),
            attempt.amount_pence,
          );
        }
        return {
          action: 'resolved' as const,
          eventId: event.eventId,
          paymentAttemptId: updated.id,
          orderId: order.id,
        };
      }

      // Attempt already in its terminal state for this outcome.
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment.webhook_ignored',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          orderId: order.id,
          reason: `attempt already ${attempt.status}`,
        },
      });
      return {
        action: 'ignored' as const,
        eventId: event.eventId,
        paymentAttemptId: attempt.id,
        orderId: order.id,
      };
    });
  }

  private async handleRefundFailedWebhook(
    actor: Actor,
    event: ProviderWebhookEvent,
  ): Promise<WebhookIngestResult> {
    return this.db.transaction().execute(async (trx) => {
      const refundsDb = trx as unknown as Kysely<DBWithRefundRetry>;
      let refund =
        event.refundId !== undefined && event.refundId !== null
          ? await refundsDb
              .selectFrom('refunds')
              .selectAll()
              .where('id', '=', event.refundId)
              .where('tenant_id', '=', actor.tenantId)
              .executeTakeFirst()
          : undefined;
      if (refund === undefined && event.providerReference !== undefined && event.providerReference !== null) {
        refund = await refundsDb
          .selectFrom('refunds')
          .selectAll()
          .where('provider_reference', '=', event.providerReference)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
      }
      if (refund === undefined) {
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'refund.webhook_unmatched',
          entityType: 'refund',
          entityId: event.refundId ?? null,
          payload: {
            eventId: event.eventId,
            providerReference: event.providerReference ?? null,
          },
        });
        return {
          action: 'ignored' as const,
          eventId: event.eventId,
          paymentAttemptId: null,
          orderId: event.orderId ?? null,
        };
      }

      // G-A-18: a refund that initially showed succeeded has now failed
      // asynchronously. It is NOT left as succeeded: status → failed,
      // the failure reason is recorded, and it is routed to manual
      // escalation — a manager completes it (with the provider's
      // reference) via completeManualRefund. It is never blindly retried.
      const failureReason = event.failureReason ?? 'refund_failed';
      const updated = await refundsDb
        .updateTable('refunds')
        .set({ status: 'failed', failure_reason: failureReason })
        .where('id', '=', refund.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'refund.failed',
        entityType: 'refund',
        entityId: refund.id,
        payload: {
          orderId: refund.order_id,
          paymentAttemptId: refund.payment_attempt_id,
          amountPence: refund.amount_pence.toString(),
          failureReason,
          routedTo: 'manual_escalation',
          nextAction: 'Manager completes the refund via the provider Dashboard and records the provider reference.',
          eventId: event.eventId,
        },
      });
      await this.publish('refund.failed', {
        refund_id: refund.id,
        order_id: refund.order_id,
        payment_attempt_id: refund.payment_attempt_id,
        amount_pence: refund.amount_pence.toString(),
        failure_reason: failureReason,
      });
      return {
        action: 'refund_failed' as const,
        eventId: event.eventId,
        paymentAttemptId: updated.payment_attempt_id,
        orderId: updated.order_id,
      };
    });
  }

  /** Discrepancy audit + publish inside an existing transaction. */
  private async recordDiscrepancyInTrx(
    trx: Kysely<DB>,
    actor: Actor,
    input: DiscrepancyInput,
  ): Promise<void> {
    await this.audit.record(trx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'payment.discrepancy',
      entityType: 'payment_attempt',
      entityId: input.paymentAttemptId ?? null,
      payload: {
        orderId: input.orderId,
        attemptId: input.paymentAttemptId ?? null,
        reason: input.reason,
        webhookContent: input.webhookContent,
      },
    });
    await this.publish('payment.discrepancy', {
      payment_attempt_id: input.paymentAttemptId ?? null,
      order_id: input.orderId,
      reason: input.reason,
      webhook_content: input.webhookContent,
    });
  }
}
