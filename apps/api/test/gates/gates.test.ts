/**
 * Acceptance Gate Verification Suite — Build-03 Objective 5.
 *
 * Proves Arch-05 §2 gates G-A-01–G-A-18, G-B, G-E, plus the leaky-bucket
 * 429 contract (Arch-02 §2.4), webhook HMAC + DLQ replay (Arch-02 §3),
 * Z-report/CSV reproducibility (Arch-02 §5.3) and the D-11/GDPR exit +
 * statutory-archive deletion flow (Arch-01 §4, §6).
 *
 * Every gate has at least one test named with its gate id. Each test
 * creates its own PGlite database (createTestDb) and seeds one tenant
 * (two tenants for G-B). No network call is ever made: the payment
 * adapter is the deterministic simulated Stripe adapter, webhook
 * delivery uses an injected fake, and the rate limiter uses a fake
 * clock where time matters. PGlite runs on a single connection, so no
 * Promise.all concurrency anywhere in this file.
 *
 * HONEST LIMITS (recorded here, not hidden):
 *  - UI-only parts are NOT provable at this layer and are not faked:
 *    the W-12 unknown-payment banner, the offline banner, the disabled
 *    card button and the disabled Pay button after the first tap are
 *    till-screen behaviour (Arch-04). Each such test asserts the
 *    server-enforceable part (the banner DATA — attempt id + order id —
 *    is present in the audit record / attempt row) and names the UI part
 *    in its comment as till-layer only.
 *  - G-A-01/G-A-02 "no stock has moved": this codebase reserves stock
 *    at the FIRST tender (decrementStockForOrder inside addTender), so a
 *    pending_payment order already carries exactly one 'sale' reservation
 *    movement from before the timeout/disconnect. The gate is therefore
 *    proven as: the timeout/disconnect itself moves NO further stock
 *    (movement count before == after), no receipt exists, and the order
 *    never completes. Arch-05's wording predates the reservation design;
 *    the reservation is the pre-timeout state, not a consequence of it.
 *  - G-A-10 double-tap: the server enforcement is per-basket
 *    idempotency (the till generates ONE idempotency key per basket, so
 *    a double-tap re-sends the same key and the server returns the
 *    original attempt). A second submit with a DIFFERENT key can only be
 *    prevented by the till disabling the Pay button — till-layer only,
 *    recorded, not asserted as server behaviour.
 *  - G-A-13 concurrency: PGlite serialises transactions on one
 *    connection, so true concurrent lock contention CANNOT be exercised
 *    here. The two sales run sequentially through the same locking code
 *    path (SELECT ... FOR UPDATE + availability check inside the lock,
 *    with a pg_locks RowShareLock proof), proving the outcome. True
 *    concurrent contention MUST be re-verified against real PostgreSQL.
 *  - G-A-16 "is_offline": payment_attempts carries NO is_offline column
 *    in the Build-01 schema. The implemented evidence (see the
 *    sales.service.ts file-top comment) is an offline_payment_records
 *    row with status 'pending_forward' and forwarded_at NULL combined
 *    with a NULL provider_reference on the attempt. That is what this
 *    test seeds and asserts.
 *  - G-A-14 follow-on: a decline recorded via the Build-02 stand-in
 *    recordCardAttemptOutcome leaves the dead card tender row in place,
 *    so a replacement tender would over-sum at completion; the Build-03
 *    provider-query/webhook decline path removes the tender row (proven
 *    in G-A-04). Recorded as an observation in the handover, not fixed
 *    here.
 *  - G-A-15 rejections surface as typed errors (RefundBlockedError.code
 *    / BadRequestException message); no audit_events row is written for
 *    a rejected refund/return — the error code is the durable record of
 *    the reason.
 */
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { lastValueFrom, of } from 'rxjs';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import {
  applyMigrations,
  createPGliteDb,
  createTestDb,
  findMigrationsDir,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { InventoryService, InsufficientStockError } from '../../src/modules/inventory/inventory.service';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { SimulatedStripeTerminalAdapter } from '../../src/modules/payments/simulated-stripe-terminal.adapter';
import {
  IllegalOrderTransitionError,
  RefundBlockedError,
  SalesService,
  TenderNotApprovedError,
} from '../../src/modules/sales/sales.service';
import {
  ReportingService,
  Z_REPORT_CSV_COLUMNS,
  cardFeeEstimatePence,
  settlementDateFor,
} from '../../src/modules/reporting/reporting.service';
import { RETRY_DELAYS_MS } from '../../src/modules/integrations/webhook-catalog';
import {
  WebhookService,
  type DeliverRequest,
} from '../../src/modules/integrations/webhook.service';
import { PER_KEY_BUCKET, RateLimiter } from '../../src/common/rate-limiter';
import { RateLimitInterceptor } from '../../src/common/rate-limit.interceptor';
import {
  ExitService,
  TenantWriteGuard,
  TerminationBlockedError,
} from '../../src/modules/admin/exit.service';
import { ExportService } from '../../src/modules/admin/export.service';
import { GdprService } from '../../src/modules/admin/gdpr.service';
import type { Actor } from '../../src/common/actor';

function managerActor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.manager.id,
    locationId: tenant.locationId,
    roles: ['manager'],
  };
}

function cashierActor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.cashier.id,
    locationId: tenant.locationId,
    roles: ['cashier'],
  };
}

interface Services {
  sales: SalesService;
  payments: PaymentsService;
  reporting: ReportingService;
  approvals: ApprovalService;
  audit: AuditService;
  webhooks: WebhookService;
  exit: ExitService;
  exports: ExportService;
  gdpr: GdprService;
}

function makeServices(db: Kysely<DB>): Services {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  const reporting = new ReportingService(db, approvals, audit);
  const exit = new ExitService(db, audit);
  const exportsSvc = new ExportService(db, audit);
  const gdpr = new GdprService(db, audit, exit, exportsSvc);
  const webhooks = new WebhookService(db, audit, {
    deliver: async () => 200,
  });
  return { sales, payments, reporting, approvals, audit, webhooks, exit, exports: exportsSvc, gdpr };
}

function adapterOf(payments: PaymentsService): SimulatedStripeTerminalAdapter {
  const adapter = payments.getAdapter();
  expect(adapter).toBeInstanceOf(SimulatedStripeTerminalAdapter);
  return adapter as SimulatedStripeTerminalAdapter;
}

async function withDb<T>(
  fn: (ctx: { db: Kysely<DB>; tenant: SeededTenant }) => Promise<T>,
): Promise<T> {
  const { db, close } = await createTestDb();
  try {
    const tenant = await seedTenant(db);
    return await fn({ db, tenant });
  } finally {
    await close();
  }
}

/** Business-date column reads back as a Date; normalise to YYYY-MM-DD. */
function businessDateOf(order: { business_date: unknown }): string {
  const value = order.business_date as unknown as string | Date;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

async function voidApproval(
  approvals: ApprovalService,
  tenant: SeededTenant,
  orderId: string,
): Promise<string> {
  const approval = await approvals.approve(managerActor(tenant), {
    action: 'void_post_tender',
    requestedByUserId: tenant.users.cashier.id,
    orderId,
    approverPin: '1234',
  });
  return approval.id;
}

/** Direct approval_events insert for actions with no ApprovalAction (corrections). */
async function insertManagerApproval(
  db: Kysely<DB>,
  tenant: SeededTenant,
  action: string,
): Promise<string> {
  const row = await db
    .insertInto('approval_events')
    .values({
      tenant_id: tenant.tenantId,
      order_id: null,
      action,
      amount_pence: null,
      reason: `test approval for ${action}`,
      requested_by_user_id: tenant.users.cashier.id,
      approved_by_user_id: tenant.users.manager.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** An order in pending_payment with one card tender whose attempt is 'unknown'. */
async function pendingUnknownOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
  options: { registerId?: string } = {},
) {
  const { order } = await sales.createOrder(managerActor(tenant), {
    locationId: tenant.locationId,
    registerId: options.registerId,
    lines: [{ variantId, quantity: 1n }],
  });
  const tender = await sales.addTender(managerActor(tenant), {
    orderId: order.id,
    tenderType: 'card',
    amountPence: order.total_pence,
  });
  const attemptId = tender.payment_attempt_id as string;
  await sales.recordCardAttemptOutcome(managerActor(tenant), {
    paymentAttemptId: attemptId,
    outcome: 'unknown',
  });
  return { order, attemptId };
}

/** A completed cash order (no card attempt involved). */
async function completeCashOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
  options: { registerId?: string; quantity?: bigint } = {},
) {
  const { order } = await sales.createOrder(managerActor(tenant), {
    locationId: tenant.locationId,
    registerId: options.registerId,
    lines: [{ variantId, quantity: options.quantity ?? 1n }],
  });
  await sales.addTender(managerActor(tenant), {
    orderId: order.id,
    tenderType: 'cash',
    amountPence: order.total_pence,
  });
  return sales.completeOrder(managerActor(tenant), order.id);
}

/** A completed card order via the Build-02 stand-in (standalone attempt, approved). */
async function completeCardOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
  options: { registerId?: string } = {},
) {
  const { order } = await sales.createOrder(managerActor(tenant), {
    locationId: tenant.locationId,
    registerId: options.registerId,
    lines: [{ variantId, quantity: 1n }],
  });
  const tender = await sales.addTender(managerActor(tenant), {
    orderId: order.id,
    tenderType: 'card',
    amountPence: order.total_pence,
  });
  const attemptId = tender.payment_attempt_id as string;
  await sales.recordCardAttemptOutcome(managerActor(tenant), {
    paymentAttemptId: attemptId,
    outcome: 'approved',
  });
  const completed = await sales.completeOrder(managerActor(tenant), order.id);
  return { ...completed, attemptId };
}

async function auditEvents(
  db: Kysely<DB>,
  tenantId: string,
  eventType: string,
): Promise<Array<{ payload: Record<string, unknown> }>> {
  const rows = await db
    .selectFrom('audit_events')
    .select('payload')
    .where('tenant_id', '=', tenantId)
    .where('event_type', '=', eventType)
    .execute();
  return rows as Array<{ payload: Record<string, unknown> }>;
}

async function saleMovementCount(db: Kysely<DB>, orderId: string): Promise<number> {
  const rows = await db
    .selectFrom('stock_movements')
    .select('id')
    .where('order_id', '=', orderId)
    .where('cause', '=', 'sale')
    .execute();
  return rows.length;
}

async function receiptCount(db: Kysely<DB>, orderId: string): Promise<number> {
  const rows = await db.selectFrom('receipts').select('id').where('order_id', '=', orderId).execute();
  return rows.length;
}

async function balanceOf(db: Kysely<DB>, variantId: string, warehouseId: string): Promise<bigint> {
  const row = await db
    .selectFrom('stock_balances')
    .select('quantity_on_hand')
    .where('variant_id', '=', variantId)
    .where('warehouse_id', '=', warehouseId)
    .executeTakeFirstOrThrow();
  return row.quantity_on_hand;
}

async function orderStatus(db: Kysely<DB>, orderId: string): Promise<string> {
  const row = await db
    .selectFrom('orders')
    .select('status')
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function attemptStatus(db: Kysely<DB>, attemptId: string): Promise<string> {
  const row = await db
    .selectFrom('payment_attempts')
    .select('status')
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
  return row.status;
}

/** Run a promise that must reject; return the thrown value for assertions. */
async function captureReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('Gates — G-A-01 / G-A-02 payment timeout & terminal disconnect', () => {
  it('G-A-01 payment timeout leaves order pending_payment, attempt unknown, no stock moved by the timeout, no sale receipt', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      // Stock state BEFORE the timeout: exactly the pre-timeout
      // reservation (one 'sale' movement, balance 4 of 5). The timeout
      // itself must move nothing further (see file-top honest limit).
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);

      // The timeout injection: the attempt becomes unknown.
      const unknown = await payments.markAttemptUnknown(actor, {
        paymentAttemptId: attemptId,
        reason: 'timeout',
      });
      expect(unknown.status).toBe('unknown');

      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      expect(await attemptStatus(db, attemptId)).toBe('unknown');
      // The timeout moved no further stock and completed no sale.
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      expect(await receiptCount(db, order.id)).toBe(0);
      // No "mark as paid" path: completion is refused while unknown.
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        'Payment outcome unknown',
      );
      // The unknown-payment banner DATA (attempt id + order id) is
      // available server-side in the audit record. The banner UI itself
      // is till-layer behaviour (Arch-04 §2.5) and is NOT asserted here.
      const events = await auditEvents(db, tenant.tenantId, 'payment.unknown');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.attemptId).toBe(attemptId);
      expect(events[0]?.payload.orderId).toBe(order.id);
      expect(events[0]?.payload.reason).toBe('timeout');
    });
  });

  it('G-A-02 terminal disconnect mid-payment leaves the same state as G-A-01', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const tender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: order.total_pence,
      });
      const attemptId = tender.payment_attempt_id as string;
      expect(await saleMovementCount(db, order.id)).toBe(1);

      // The disconnect injection.
      const unknown = await payments.markAttemptUnknown(actor, {
        paymentAttemptId: attemptId,
        reason: 'terminal_disconnect',
      });
      expect(unknown.status).toBe('unknown');

      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      expect(await attemptStatus(db, attemptId)).toBe('unknown');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      expect(await receiptCount(db, order.id)).toBe(0);
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        'Payment outcome unknown',
      );
      // Banner data available (attempt id + order id); banner UI itself
      // is till-layer, not asserted here.
      const events = await auditEvents(db, tenant.tenantId, 'payment.unknown');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.attemptId).toBe(attemptId);
      expect(events[0]?.payload.orderId).toBe(order.id);
      expect(events[0]?.payload.reason).toBe('terminal_disconnect');
    });
  });
});

describe('Gates — G-A-03 / G-A-04 provider status query resolution', () => {
  it('G-A-03 status query resolves unknown -> approved: order completes, stock moves exactly once, receipt exists', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      adapter.scriptQueryResult(attemptId, {
        status: 'approved',
        providerReference: 'pi_gate_a03',
      });

      const result = await sales.resolveUnknownPayment(actor, {
        paymentAttemptId: attemptId,
        method: 'provider_query',
      });
      expect(result.outcome).toBe('approved');
      expect(result.attempt.status).toBe('approved');
      expect(result.attempt.provider_reference).toBe('pi_gate_a03');
      expect(result.completed).not.toBeNull();
      expect(result.completed?.order.status).toBe('completed');
      // Stock moved exactly once (the reservation at first tender;
      // completion moves nothing again).
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      expect(await receiptCount(db, order.id)).toBe(1);
      const receipt = await sales.getReceipt(actor, order.id);
      expect(receipt.receiptNumber).toBe(1n);
      expect(receipt.totalPence).toBe(1000n);
    });
  });

  it('G-A-04 status query resolves unknown -> declined: order stays open, no stock moved, another tender can be taken', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      adapter.scriptQueryResult(attemptId, { status: 'declined', providerReference: null });

      const result = await sales.resolveUnknownPayment(actor, {
        paymentAttemptId: attemptId,
        method: 'provider_query',
      });
      expect(result.outcome).toBe('declined');
      expect(result.completed).toBeNull();
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      expect(await attemptStatus(db, attemptId)).toBe('declined');
      // No sale completed: still exactly the pre-decline reservation,
      // no receipt.
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      expect(await receiptCount(db, order.id)).toBe(0);
      // The cashier can take another tender on the same order and it
      // completes (the declined tender row was removed by the
      // provider-query path, so the tender sum still matches).
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: order.total_pence,
      });
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await receiptCount(db, order.id)).toBe(1);
    });
  });
});

describe('Gates — G-A-05 / G-A-06 manager decisions', () => {
  it('G-A-05 manager void-and-retry: old attempt stays unknown with a resolution note, new attempt has a different idempotency key, order not completed by the void', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments, approvals } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const oldKey = (
        await db
          .selectFrom('payment_attempts')
          .select('idempotency_key')
          .where('id', '=', attemptId)
          .executeTakeFirstOrThrow()
      ).idempotency_key;
      const approvalId = await voidApproval(approvals, tenant, order.id);

      const decision = await payments.resolveUnknownByManagerDecision(actor, {
        paymentAttemptId: attemptId,
        decision: 'void_and_retry',
        approvalEventsId: approvalId,
        resolutionNote: 'Gate G-A-05: terminal froze; retry on the reader.',
      });
      expect(decision.decision).toBe('void_and_retry');
      expect(decision.oldAttempt.id).toBe(attemptId);
      expect(decision.oldAttempt.status).toBe('unknown');
      expect(decision.attempt.id).not.toBe(attemptId);
      expect(decision.attempt.idempotency_key).not.toBe(oldKey);

      // The old attempt row was never deleted or rewritten.
      const oldRow = await db
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(oldRow.status).toBe('unknown');
      expect(oldRow.idempotency_key).toBe(oldKey);
      // The resolution note is recorded (audit), the order is NOT
      // completed by the void, and the tender points at the fresh attempt.
      const notes = await auditEvents(db, tenant.tenantId, 'payment.unknown_resolved');
      expect(notes).toHaveLength(1);
      expect(notes[0]?.payload.resolutionNote).toBe(
        'Gate G-A-05: terminal froze; retry on the reader.',
      );
      expect(notes[0]?.payload.oldAttemptId).toBe(attemptId);
      expect(notes[0]?.payload.newAttemptId).toBe(decision.attempt.id);
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      expect(await receiptCount(db, order.id)).toBe(0);
      const tender = await db
        .selectFrom('order_tenders')
        .select('payment_attempt_id')
        .where('order_id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(tender.payment_attempt_id).toBe(decision.attempt.id);
      expect(await saleMovementCount(db, order.id)).toBe(1);
    });
  });

  it('G-A-06 manager manual/standalone payment: order completes on the manual tender with the reference recorded; unknown attempt stays unknown with a resolution note', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments, approvals } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const approvalId = await voidApproval(approvals, tenant, order.id);

      const decision = await payments.resolveUnknownByManagerDecision(actor, {
        paymentAttemptId: attemptId,
        decision: 'standalone',
        approvalEventsId: approvalId,
        terminalReference: 'TERM-REF-GATE-A06',
        resolutionNote: 'Gate G-A-06: card taken on the standalone terminal.',
      });
      expect(decision.attempt.provider).toBe('standalone');
      expect(decision.attempt.status).toBe('approved');
      expect(decision.attempt.provider_reference).toBe('TERM-REF-GATE-A06');
      // The unknown attempt stays unknown with the resolution note.
      expect(await attemptStatus(db, attemptId)).toBe('unknown');
      const notes = await auditEvents(db, tenant.tenantId, 'payment.unknown_resolved');
      expect(notes).toHaveLength(1);
      expect(notes[0]?.payload.decision).toBe('standalone');
      expect(notes[0]?.payload.resolutionNote).toBe(
        'Gate G-A-06: card taken on the standalone terminal.',
      );

      // The order completes ON THE MANUAL TENDER (not on the unknown
      // attempt): the tender points at the standalone attempt.
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      const tender = await db
        .selectFrom('order_tenders')
        .selectAll()
        .where('order_id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(tender.payment_attempt_id).toBe(decision.attempt.id);
      expect(tender.tender_type).toBe('card');
      expect(await attemptStatus(db, attemptId)).toBe('unknown');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await receiptCount(db, order.id)).toBe(1);
    });
  });
});

describe('Gates — G-A-07 late webhook after void / refund', () => {
  it('G-A-07 late webhook after void: discrepancy alert in audit_events with attempt id, order id and webhook content; no silent second sale, no second stock movement', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments, approvals } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const approvalId = await voidApproval(approvals, tenant, order.id);
      await sales.voidOrder(actor, order.id, 'customer left', approvalId);
      expect(await orderStatus(db, order.id)).toBe('voided');

      const result = await payments.ingestWebhook(actor, {
        eventId: 'evt_gate_a07_void',
        type: 'payment_intent.succeeded',
        paymentAttemptId: attemptId,
        orderId: order.id,
        providerReference: 'pi_late_gate_a07',
        raw: { id: 'evt_gate_a07_void', type: 'payment_intent.succeeded' },
      });
      expect(result.action).toBe('discrepancy');

      const discrepancies = await auditEvents(db, tenant.tenantId, 'payment.discrepancy');
      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0]?.payload.attemptId).toBe(attemptId);
      expect(discrepancies[0]?.payload.orderId).toBe(order.id);
      expect(discrepancies[0]?.payload.reason).toBe('late_webhook_after_void_or_refund');
      expect(discrepancies[0]?.payload.webhookContent).toBeDefined();

      expect(await orderStatus(db, order.id)).toBe('voided');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await receiptCount(db, order.id)).toBe(0);
      expect(await attemptStatus(db, attemptId)).toBe('unknown');
    });
  });

  it('G-A-07 late webhook after refund: discrepancy alert, not a second sale', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await completeCardOrder(db, tenant, sales, variant.variantId);
      const lines = await db
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      expect(returned.order.status).toBe('returned');
      expect(returned.refund?.status).toBe('manual_escalation');
      await sales.completeManualRefund(actor, {
        refundId: returned.refund?.id as string,
        outcome: 'completed',
        providerReference: 're_gate_a07',
      });

      const result = await payments.ingestWebhook(actor, {
        eventId: 'evt_gate_a07_refund',
        type: 'payment_intent.succeeded',
        paymentAttemptId: attemptId,
        orderId: order.id,
        providerReference: 'pi_gate_a07_refund',
      });
      expect(result.action).toBe('discrepancy');
      const discrepancies = await auditEvents(db, tenant.tenantId, 'payment.discrepancy');
      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0]?.payload.attemptId).toBe(attemptId);
      expect(discrepancies[0]?.payload.orderId).toBe(order.id);
      expect(await orderStatus(db, order.id)).toBe('returned');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await receiptCount(db, order.id)).toBe(1);
    });
  });
});

describe('Gates — G-A-08 / G-A-09 / G-A-10 duplicate handling', () => {
  it('G-A-08 duplicate webhook (same event id twice): exactly one sale, one movement, one receipt; duplicate logged as duplicate', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const event = {
        eventId: 'evt_gate_a08',
        type: 'payment_intent.succeeded',
        paymentAttemptId: attemptId,
        orderId: order.id,
        providerReference: 'pi_gate_a08',
      };
      expect((await payments.ingestWebhook(actor, event)).action).toBe('resolved');
      expect((await payments.ingestWebhook(actor, event)).action).toBe('duplicate');
      const duplicates = await auditEvents(db, tenant.tenantId, 'payment.webhook_duplicate');
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]?.payload.eventId).toBe('evt_gate_a08');

      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      expect(await receiptCount(db, order.id)).toBe(1);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
    });
  });

  it('G-A-09 duplicate submission (same idempotency key): second submission returns the original result; exactly one payment attempt, no sale created by the replay', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      // Queue two DIFFERENT outcomes: the replay must return the first
      // one's result, proving the key — not the queue — decides.
      adapter.scriptOutcomes(['approved', 'declined']);
      const first = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
        idempotencyKey: 'gate-a09-key',
      });
      expect(first.status).toBe('approved');
      const replay = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
        idempotencyKey: 'gate-a09-key',
      });
      expect(replay.id).toBe(first.id);
      expect(replay.status).toBe('approved');
      expect(replay.provider_reference).toBe(first.provider_reference);
      const attempts = await db
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(attempts).toHaveLength(1);
      // The replay created no sale by itself: order untouched, no stock
      // moved, no receipt. (Completion on the approved attempt is proven
      // end to end in G-A-03.)
      expect(await orderStatus(db, order.id)).toBe('draft');
      expect(await saleMovementCount(db, order.id)).toBe(0);
      expect(await receiptCount(db, order.id)).toBe(0);
    });
  });

  it('G-A-10 double-tap / double-submit: two submits for the same basket produce exactly one payment attempt (server enforcement is per-basket idempotency)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      // The till generates ONE idempotency key per basket: a double-tap
      // re-sends the SAME key, so the server must return the original
      // attempt, not create a second one. (A second submit with a
      // DIFFERENT key can only be prevented by the till disabling the
      // Pay button after the first tap — till-layer behaviour, Arch-04
      // §2.5 — not provable at this layer and not asserted here.)
      adapter.scriptOutcomes(['approved', 'approved']);
      const basketKey = 'gate-a10-basket-key';
      const first = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
        idempotencyKey: basketKey,
      });
      const secondTap = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
        idempotencyKey: basketKey,
      });
      expect(secondTap.id).toBe(first.id);
      const attempts = await db
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(attempts).toHaveLength(1);
    });
  });
});

describe('Gates — G-A-11 / G-A-12 restart & network loss', () => {
  it('G-A-11 register restart mid-payment: order draft + attempt id survive a service/DB restart against the same PGlite database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gates-ga11-'));
    try {
      const migrationsDir = findMigrationsDir();
      // "Before the restart": a fresh file-backed PGlite database.
      const first = await createPGliteDb(dir);
      let orderId: string;
      let attemptId: string;
      try {
        await applyMigrations(first.db, migrationsDir);
        const tenant = await seedTenant(first.db);
        const { sales } = makeServices(first.db);
        const variant = await seedVariant(first.db, tenant);
        await setStock(first.db, tenant, variant.variantId, { quantity: 5n });
        const { order } = await sales.createOrder(managerActor(tenant), {
          locationId: tenant.locationId,
          lines: [{ variantId: variant.variantId, quantity: 1n }],
        });
        const tender = await sales.addTender(managerActor(tenant), {
          orderId: order.id,
          tenderType: 'card',
          amountPence: order.total_pence,
        });
        orderId = order.id;
        attemptId = tender.payment_attempt_id as string;
        expect(await attemptStatus(first.db, attemptId)).toBe('created');
      } finally {
        await first.close();
      }

      // "After the restart": a NEW service/DB handle against the SAME
      // database directory. Migrations are already applied (none new).
      const second = await createPGliteDb(dir);
      try {
        const newlyApplied = await applyMigrations(second.db, migrationsDir);
        expect(newlyApplied).toHaveLength(0);
        const order = await second.db
          .selectFrom('orders')
          .selectAll()
          .where('id', '=', orderId)
          .executeTakeFirstOrThrow();
        expect(order.status).toBe('pending_payment');
        const attempt = await second.db
          .selectFrom('payment_attempts')
          .selectAll()
          .where('id', '=', attemptId)
          .executeTakeFirstOrThrow();
        // Recoverable with its attempt id; pending/unknown — NOT approved
        // without evidence.
        expect(attempt.order_id).toBe(orderId);
        expect(['created', 'pending', 'unknown']).toContain(attempt.status);
        expect(attempt.status).not.toBe('approved');
        // No stock moved beyond the pre-restart reservation, no sale receipt.
        expect(await saleMovementCount(second.db, orderId)).toBe(1);
        expect(await receiptCount(second.db, orderId)).toBe(0);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G-A-12 network loss mid-sale: the attempt becomes unknown (simulated disconnect outcome); the order is not completed on card', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      // The network-loss injection, via the simulated adapter's
      // disconnect outcome: the provider never answers.
      adapter.scriptOutcome('unknown');
      const attempt = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
      });
      expect(attempt.status).toBe('unknown');
      expect(attempt.provider_reference).toBeNull();

      // The order is NOT completed on card: no receipt, no stock moved.
      expect(await saleMovementCount(db, order.id)).toBe(0);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);
      expect(await receiptCount(db, order.id)).toBe(0);
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        IllegalOrderTransitionError,
      );
      // The sale can still proceed on cash; the unknown card attempt
      // never became the sale.
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: order.total_pence,
      });
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(await attemptStatus(db, attempt.id)).toBe('unknown');
      // The offline banner + disabled card button are till-layer
      // behaviour (Arch-04 §4.5) and are NOT asserted here.
    });
  });
});

describe('Gates — G-A-13 concurrent sale of the last item', () => {
  it('G-A-13 concurrent sale of the last item (SEQUENTIAL on PGlite): one succeeds, one fails cleanly, no negative stock, exactly one movement, failed order not completed and no payment attempt left pending', async () => {
    // HONEST LIMIT: PGlite runs on a single connection, so true
    // concurrent lock contention CANNOT be exercised here. The two
    // sales run sequentially through the SAME locking code path
    // (SELECT ... FOR UPDATE + availability check inside the lock),
    // proving the outcome. True concurrent contention MUST be
    // re-verified against real PostgreSQL before the pilot goes live.
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 1n });

      // Register 1 sells the last unit.
      const { order: completed } = await completeCashOrder(db, tenant, sales, variant.variantId);
      expect(completed.status).toBe('completed');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(0n);

      // Register 2 sells the same last unit: fails cleanly.
      const { order: failedOrder } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const thrown = await captureReject(
        sales.addTender(actor, {
          orderId: failedOrder.id,
          tenderType: 'cash',
          amountPence: failedOrder.total_pence,
        }),
      );
      expect(thrown).toBeInstanceOf(InsufficientStockError);
      const insufficient = thrown as InsufficientStockError;
      expect(insufficient.variantId).toBe(variant.variantId);
      expect(insufficient.available).toBe(0n);
      expect(insufficient.requested).toBe(1n);

      // No negative stock; exactly one 'sale' movement for the last unit.
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(0n);
      const salesMovements = await db
        .selectFrom('stock_movements')
        .select('id')
        .where('variant_id', '=', variant.variantId)
        .where('cause', '=', 'sale')
        .execute();
      expect(salesMovements).toHaveLength(1);
      // The failed order is not completed and holds no tender and no
      // payment attempt (nothing left pending/voided/refunded to chase).
      expect(await orderStatus(db, failedOrder.id)).toBe('draft');
      const failedTenders = await db
        .selectFrom('order_tenders')
        .select('id')
        .where('order_id', '=', failedOrder.id)
        .execute();
      expect(failedTenders).toHaveLength(0);
      const failedAttempts = await db
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', failedOrder.id)
        .execute();
      expect(failedAttempts).toHaveLength(0);
      expect(await receiptCount(db, failedOrder.id)).toBe(0);
    });
  });

  it('G-A-13 lock-held proof: the FOR UPDATE select holds a granted RowShareLock (the lock + availability check inside the lock)', async () => {
    await withDb(async ({ db, tenant }) => {
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      // The same locking select decrementStockForOrder runs: a plain
      // SELECT takes only AccessShareLock, while SELECT ... FOR UPDATE
      // takes RowShareLock.
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('stock_balances')
          .selectAll()
          .where('variant_id', '=', variant.variantId)
          .where('warehouse_id', '=', tenant.warehouseId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        expect(row.quantity_on_hand).toBe(5n);
        const locks = await sql<{ held: string }>`
          SELECT COUNT(*)::text AS held FROM pg_locks
          WHERE locktype = 'relation' AND mode = 'RowShareLock'
            AND granted AND pid = pg_backend_pid()
        `.execute(trx);
        expect(Number(locks.rows[0]?.held)).toBeGreaterThan(0);
      });
    });
  });
});

describe('Gates — G-A-14 split-tender failure', () => {
  it('G-A-14 split-tender failure (cash taken, card declined): order is open with tenders recorded, never a fourth/ambiguous state', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      expect(order.total_pence).toBe(1000n);
      // Cash £5 taken first.
      const cashTender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 500n,
      });
      expect(cashTender.tender_type).toBe('cash');
      // Then the card £5 declines.
      const cardTender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: 500n,
      });
      const attemptId = cardTender.payment_attempt_id as string;
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'declined',
      });

      // The order is in exactly one of the three defined states (open).
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      // The taken tender is reconcilable (recorded, approved-by-being-cash).
      const tenders = await db
        .selectFrom('order_tenders')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute();
      expect(tenders).toHaveLength(2);
      const cash = tenders.find((t) => t.tender_type === 'cash');
      expect(cash?.amount_pence).toBe(500n);
      // The declined tender is declined.
      expect(await attemptStatus(db, attemptId)).toBe('declined');
      const card = tenders.find((t) => t.tender_type === 'card');
      expect(card?.payment_attempt_id).toBe(attemptId);
      // The order cannot complete on a declined card tender, and it is
      // not completed, voided, or half-paid with no record.
      const thrown = await captureReject(sales.completeOrder(actor, order.id));
      expect(thrown).toBeInstanceOf(TenderNotApprovedError);
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      expect(await receiptCount(db, order.id)).toBe(0);
      // OBSERVATION (not fixed here): a decline recorded via the
      // Build-02 stand-in recordCardAttemptOutcome leaves the dead card
      // tender row in place, so a replacement tender would over-sum at
      // completion. The Build-03 provider-query/webhook decline path
      // removes the tender row instead (proven in G-A-04).
    });
  });
});

describe('Gates — G-A-15 refund of a refund / return above original', () => {
  it('G-A-15 refund of a refund and refund above original are both blocked, no second refund, rejection carries the reason code', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // Fully refund a card order (standalone attempt -> manual
      // escalation -> manager completes it; the attempt becomes refunded).
      // A 2-unit order (£20) is used: a full return would move the
      // order to 'returned', where createRefund refuses on order status
      // before it can reach the already-refunded check — so the
      // already-refunded attempt is proven on a partially_returned
      // order instead (1 unit returned, then the remaining £10 refunded
      // directly, then a third refund attempt is blocked).
      const { order: order2 } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      expect(order2.total_pence).toBe(2000n);
      const tender2 = await sales.addTender(actor, {
        orderId: order2.id,
        tenderType: 'card',
        amountPence: order2.total_pence,
      });
      const attemptId = tender2.payment_attempt_id as string;
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'approved',
      });
      await sales.completeOrder(actor, order2.id);
      const order = order2;
      const lines = await db
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      expect(returned.order.status).toBe('partially_returned');
      expect(returned.refund?.status).toBe('manual_escalation');
      expect(returned.refundAmountPence).toBe(1000n);
      await sales.completeManualRefund(actor, {
        refundId: returned.refund?.id as string,
        outcome: 'completed',
        providerReference: 're_gate_a15',
      });
      expect(await attemptStatus(db, attemptId)).not.toBe('refunded');
      // The remaining £10 of the attempt is refunded directly.
      const secondRefund = await sales.createRefund(actor, {
        orderId: order.id,
        paymentAttemptId: attemptId,
        amountPence: 1000n,
        reason: 'remaining balance refund',
      });
      expect(secondRefund.status).toBe('manual_escalation');
      await sales.completeManualRefund(actor, {
        refundId: secondRefund.id,
        outcome: 'completed',
        providerReference: 're_gate_a15_b',
      });
      expect(await attemptStatus(db, attemptId)).toBe('refunded');
      const refundsBefore = await db
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(refundsBefore).toHaveLength(2);

      // A third refund against the already-refunded attempt is blocked.
      const blocked = await captureReject(
        sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 1000n,
          reason: 'second refund attempt',
        }),
      );
      expect(blocked).toBeInstanceOf(RefundBlockedError);
      expect((blocked as RefundBlockedError).code).toBe('attempt_already_refunded');
      expect(
        await db.selectFrom('refunds').select('id').where('order_id', '=', order.id).execute(),
      ).toHaveLength(2);

      // A refund above the original amount is blocked on a fresh order.
      const second = await completeCardOrder(db, tenant, sales, variant.variantId);
      const over = await captureReject(
        sales.createRefund(actor, {
          orderId: second.order.id,
          paymentAttemptId: second.attemptId,
          amountPence: 1500n,
          reason: 'refund above original',
        }),
      );
      expect(over).toBeInstanceOf(RefundBlockedError);
      expect((over as RefundBlockedError).code).toBe('refund_exceeds_original');
      expect(
        await db
          .selectFrom('refunds')
          .select('id')
          .where('order_id', '=', second.order.id)
          .execute(),
      ).toHaveLength(0);
      // Rejections surface as typed errors carrying the reason code;
      // no audit_events row is written for a rejected refund (the
      // error code is the durable record of the reason).
    });
  });

  it('G-A-15 return above original quantity is blocked, no movement for the excess, rejection carries the reason', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await completeCashOrder(db, tenant, sales, variant.variantId);
      const lines = await db
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      const movementsBefore = await db
        .selectFrom('stock_movements')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();

      const thrown = await captureReject(
        sales.returnOrder(actor, {
          orderId: order.id,
          lines: [{ orderLineId: lines[0]?.id as string, quantity: 2n, disposition: 'restock' }],
        }),
      );
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as Error).message).toContain('Cannot return 2');
      // No movement for the excess, no refund, order unchanged.
      const movementsAfter = await db
        .selectFrom('stock_movements')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(movementsAfter).toHaveLength(movementsBefore.length);
      expect(
        await db.selectFrom('refunds').select('id').where('order_id', '=', order.id).execute(),
      ).toHaveLength(0);
      expect(await orderStatus(db, order.id)).toBe('completed');
    });
  });
});

describe('Gates — G-A-16 refund against an unforwarded offline PaymentIntent', () => {
  it('G-A-16 refund against an unforwarded offline PaymentIntent is blocked (pending_forward record + NULL provider_reference); no refund created', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // NOTE: payment_attempts carries no is_offline column in the
      // Build-01 schema. The implemented evidence (sales.service.ts
      // file-top comment) is an offline_payment_records row with
      // status 'pending_forward' and forwarded_at NULL, combined with
      // a NULL provider_reference on the attempt. That is what is
      // seeded and asserted here.
      const { order, attemptId } = await completeCardOrder(db, tenant, sales, variant.variantId);
      const attempt = await db
        .selectFrom('payment_attempts')
        .select('provider_reference')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attempt.provider_reference).toBeNull();
      await db
        .insertInto('offline_payment_records')
        .values({
          tenant_id: tenant.tenantId,
          order_id: order.id,
          local_id: randomUUID(),
          amount_pence: 1000n,
          currency: 'GBP',
          status: 'pending_forward',
          stripe_payment_intent_id: null,
          reader_id: null,
          location_id: tenant.locationId,
          forwarded_at: null,
          idempotency_key: 'off-key-gate-a16',
          reader_software_version: null,
          connection_token_age_hours: null,
        })
        .execute();

      const blocked = await captureReject(
        sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 1000n,
          reason: 'refund of unforwarded offline payment',
        }),
      );
      expect(blocked).toBeInstanceOf(RefundBlockedError);
      expect((blocked as RefundBlockedError).code).toBe('offline_unforwarded');
      expect(
        await db.selectFrom('refunds').select('id').where('order_id', '=', order.id).execute(),
      ).toHaveLength(0);

      // Control: the same refund on an identical order WITHOUT the
      // unforwarded offline record proceeds (standalone -> manual
      // escalation), proving the block is the offline record, not the
      // refund path itself.
      const control = await completeCardOrder(db, tenant, sales, variant.variantId);
      const refund = await sales.createRefund(actor, {
        orderId: control.order.id,
        paymentAttemptId: control.attemptId,
        amountPence: 1000n,
        reason: 'control refund',
      });
      expect(refund.status).toBe('manual_escalation');
    });
  });
});

describe('Gates — G-A-17 settlement reconciliation', () => {
  /**
   * One approved card sale (£10) inside a closed session, resolved via
   * the provider-query path so the adapter's settlement ledger is
   * populated as well as the database attempt. Returns the business
   * date, the issued Z-report and the session.
   */
  async function cardSaleInClosedSession(
    db: Kysely<DB>,
    tenant: SeededTenant,
    services: Services,
    variantId: string,
  ) {
    const actor = managerActor(tenant);
    const { session } = await services.reporting.openSession(actor, {
      registerId: tenant.registerId,
      openingFloatPence: 10000n,
    });
    const { order, attemptId } = await pendingUnknownOrder(db, tenant, services.sales, variantId, {
      registerId: tenant.registerId,
    });
    const adapter = adapterOf(services.payments);
    adapter.scriptQueryResult(attemptId, {
      status: 'approved',
      providerReference: 'pi_gate_a17',
    });
    const result = await services.sales.resolveUnknownPayment(actor, {
      paymentAttemptId: attemptId,
      method: 'provider_query',
    });
    expect(result.completed?.order.status).toBe('completed');
    const businessDate = businessDateOf(order);
    const ended = await services.reporting.endSession(actor, session.id);
    expect(ended.expected_cash_pence).toBe(10000n);
    const { zReport } = await services.reporting.closeSession(actor, {
      sessionId: session.id,
      countedCashPence: 10000n,
    });
    return { order, attemptId, businessDate, zReport, session };
  }

  it('G-A-17 settlement reconciliation: payout at T+3 matches the Z-report card total less reserve hold and dispute debit as separate lines, reconciled by settlement date', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { businessDate, zReport } = await cardSaleInClosedSession(
        db,
        tenant,
        services,
        variant.variantId,
      );
      // The Z-report's card total for the date is £10.
      const cardLine = zReport.tenderLines.find((t) => t.tenderType === 'card');
      expect(cardLine?.amountPence).toBe(1000n);
      expect(zReport.zReport.gross_pence).toBe(1000n);

      // The payout arrives at T+3 (Stripe UK standard).
      const settlementDate = settlementDateFor(businessDate);
      const schedule = services.payments.payoutScheduleFor(businessDate);
      expect(schedule.settlementDate).toBe(settlementDate);
      expect(schedule.grossPence).toBe(1000n);
      const feeEstimate = cardFeeEstimatePence(1000n);
      expect(feeEstimate).toBe(24n);

      const reconciliation = await services.reporting.reconcileSettlement(actor, businessDate, [
        {
          providerReference: 'po_gate_a17',
          settlementDate,
          grossPence: 1000n,
          feePence: feeEstimate,
          reserveHoldPence: 100n,
          disputeDebitPence: 50n,
        },
      ]);
      expect(reconciliation.status).toBe('reconciled');
      expect(reconciliation.settlementDate).toBe(settlementDate);
      expect(reconciliation.cardGrossPence).toBe(1000n);
      expect(reconciliation.settledGrossPence).toBe(1000n);
      // Reserve hold and dispute debit are separate lines, never
      // missing sales.
      expect(reconciliation.reserveHoldTotalPence).toBe(100n);
      expect(reconciliation.disputeDebitTotalPence).toBe(50n);
      expect(reconciliation.expectedNetPayoutPence).toBe(1000n - 24n - 100n - 50n);
      expect(reconciliation.feeAdjustment).toBeNull();
      expect(reconciliation.payouts).toHaveLength(1);
      expect(reconciliation.otherSettlementDatePayouts).toHaveLength(0);
      expect(reconciliation.discrepancyReason).toBeNull();
    });
  });

  it('G-A-17 settlement mismatch creates a discrepancy alert, not a silent correction', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { businessDate } = await cardSaleInClosedSession(
        db,
        tenant,
        services,
        variant.variantId,
      );
      const reconciliation = await services.reporting.reconcileSettlement(actor, businessDate, [
        {
          providerReference: 'po_gate_a17_short',
          settlementDate: settlementDateFor(businessDate),
          grossPence: 900n,
          feePence: cardFeeEstimatePence(1000n),
          reserveHoldPence: 0n,
          disputeDebitPence: 0n,
        },
      ]);
      expect(reconciliation.status).toBe('discrepancy');
      expect(reconciliation.discrepancyReason).toContain('900');
      expect(reconciliation.discrepancyReason).toContain('1000');
      const alerts = await auditEvents(db, tenant.tenantId, 'settlement.discrepancy');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.payload.cardGrossPence).toBe('1000');
      expect(alerts[0]?.payload.settledGrossPence).toBe('900');
    });
  });

  it('G-A-17 reconciliation is by settlement date, not sale date: a payout for another settlement date does not match', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { businessDate } = await cardSaleInClosedSession(
        db,
        tenant,
        services,
        variant.variantId,
      );
      // A payout for a DIFFERENT business date's settlement (T+3 of
      // the next day) carries the right gross but the wrong settlement
      // date: it must not match this date's card sales.
      const [y, m, d] = businessDate.split('-').map(Number);
      const nextDay = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const otherBusinessDate = nextDay.toISOString().slice(0, 10);
      const reconciliation = await services.reporting.reconcileSettlement(actor, businessDate, [
        {
          providerReference: 'po_gate_a17_other_date',
          settlementDate: settlementDateFor(otherBusinessDate),
          grossPence: 1000n,
          feePence: cardFeeEstimatePence(1000n),
          reserveHoldPence: 0n,
          disputeDebitPence: 0n,
        },
      ]);
      expect(reconciliation.payouts).toHaveLength(0);
      expect(reconciliation.otherSettlementDatePayouts).toHaveLength(1);
      expect(reconciliation.status).toBe('discrepancy');
      expect(reconciliation.discrepancyReason).toContain('No payout received');
    });
  });
});

describe('Gates — G-A-18 async refund failure', () => {
  it('G-A-18 async refund failure: a refund initially succeeded later transitions to failed via refund.failed, routed to manual escalation, merchant alert recorded', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await completeCardOrder(db, tenant, sales, variant.variantId);
      const lines = await db
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      const refundId = returned.refund?.id as string;
      expect(returned.refund?.status).toBe('manual_escalation');
      // The refund genuinely shows succeeded: the manager completed it
      // on the terminal and recorded the reference.
      const manuallyCompleted = await sales.completeManualRefund(actor, {
        refundId,
        outcome: 'completed',
        providerReference: 're_gate_a18',
      });
      expect(manuallyCompleted.status).toBe('completed');

      // Later, asynchronously, the provider reports refund.failed.
      const result = await payments.ingestWebhook(actor, {
        eventId: 'evt_gate_a18',
        type: 'refund.failed',
        refundId,
        orderId: order.id,
        failureReason: 'refund_failed',
      });
      expect(result.action).toBe('refund_failed');
      const refund = await db
        .selectFrom('refunds')
        .selectAll()
        .where('id', '=', refundId)
        .executeTakeFirstOrThrow();
      // The refund is NOT left as succeeded.
      expect(refund.status).toBe('failed');
      expect(refund.failure_reason).toBe('refund_failed');
      // Merchant alert recorded (audit event) with the escalation route.
      const failed = await auditEvents(db, tenant.tenantId, 'refund.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload.routedTo).toBe('manual_escalation');
      expect(failed[0]?.payload.orderId).toBe(order.id);

      // The manager completes it with the provider's reference.
      const completed = await sales.completeManualRefund(actor, {
        refundId,
        outcome: 'completed',
        providerReference: 're_gate_a18_manual',
      });
      expect(completed.status).toBe('completed');
      expect(completed.provider_reference).toBe('re_gate_a18_manual');
    });
  });
});

describe('Gates — G-B cross-tenant isolation across the new endpoints', () => {
  it('G-B cross-tenant attempts return 404 (never 403), including direct ID guessing', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Beta Retail Ltd' });
      const services = makeServices(db);
      const actorA = managerActor(tenantA);
      const actorB = managerActor(tenantB);

      // Tenant A data: a completed cash order (receipt), an unknown
      // card attempt, and an issued Z-report in a closed session.
      const variant = await seedVariant(db, tenantA);
      await setStock(db, tenantA, variant.variantId, { quantity: 5n });
      const { session } = await services.reporting.openSession(actorA, {
        registerId: tenantA.registerId,
        openingFloatPence: 10000n,
      });
      const { order: cashOrder } = await completeCashOrder(db, tenantA, services.sales, variant.variantId, {
        registerId: tenantA.registerId,
      });
      const { attemptId } = await pendingUnknownOrder(db, tenantA, services.sales, variant.variantId);
      await services.reporting.endSession(actorA, session.id);
      const { zReport } = await services.reporting.closeSession(actorA, {
        sessionId: session.id,
        countedCashPence: 11000n,
      });
      const zReportId = zReport.zReport.id;
      const cashLines = await db
        .selectFrom('order_lines')
        .select('id')
        .where('order_id', '=', cashOrder.id)
        .execute();

      // A webhook event owned by tenant A (for the Events API check).
      await services.webhooks.publish('order.completed', {
        tenant_id: tenantA.tenantId,
        order_id: cashOrder.id,
        total_pence: 1000,
      });

      // A customer owned by tenant A (for the per-customer export check).
      const customerA = await db
        .insertInto('customers')
        .values({
          tenant_id: tenantA.tenantId,
          first_name: 'Test',
          last_name: 'Customer',
          email: 'test.customer@example.test',
          phone: '07123456789',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Payments resolution, cross-tenant: 404, never 403.
      await expect(
        services.payments.resolveUnknownByProviderQuery(actorB, { paymentAttemptId: attemptId }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        services.payments.markAttemptUnknown(actorB, {
          paymentAttemptId: attemptId,
          reason: 'timeout',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        services.payments.createCardAttempt(actorB, {
          orderId: cashOrder.id,
          amountPence: 1000n,
        }),
      ).rejects.toThrow(NotFoundException);

      // Returns / refunds / receipts, cross-tenant: 404.
      await expect(
        services.sales.createRefund(actorB, {
          orderId: cashOrder.id,
          amountPence: 100n,
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        services.sales.returnOrder(actorB, {
          orderId: cashOrder.id,
          lines: [{ orderLineId: cashLines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(services.sales.getReceipt(actorB, cashOrder.id)).rejects.toThrow(
        NotFoundException,
      );

      // Reporting / Z-reports, cross-tenant: 404.
      await expect(services.reporting.getZReport(actorB, zReportId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(services.reporting.exportZReportCsv(actorB, zReportId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        services.reporting.closeSession(actorB, {
          sessionId: session.id,
          countedCashPence: 11000n,
        }),
      ).rejects.toThrow(NotFoundException);

      // Direct ID guessing (random UUIDs, no such row anywhere): 404.
      await expect(services.sales.getReceipt(actorB, randomUUID())).rejects.toThrow(
        NotFoundException,
      );
      await expect(services.reporting.getZReport(actorB, randomUUID())).rejects.toThrow(
        NotFoundException,
      );
      await expect(services.exit.assertTenantWritable(randomUUID())).rejects.toThrow(
        NotFoundException,
      );

      // Events API: tenant B sees none of tenant A's events.
      const eventsB = await services.webhooks.listEvents(tenantB.tenantId);
      expect(eventsB.events).toHaveLength(0);
      const eventsA = await services.webhooks.listEvents(tenantA.tenantId);
      expect(eventsA.events).toHaveLength(1);

      // Exit/export: per-customer export is tenant-scoped (404), and a
      // full export for tenant B contains none of tenant A's orders.
      await expect(
        services.gdpr.exportCustomer(tenantB.tenantId, customerA.id),
      ).rejects.toThrow(NotFoundException);
      const exportB = await services.exports.runFullExport(tenantB.tenantId);
      const ordersB = JSON.parse(exportB.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(ordersB).toHaveLength(0);
      const exportA = await services.exports.runFullExport(tenantA.tenantId);
      const ordersA = JSON.parse(exportA.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(ordersA.some((o) => o.id === cashOrder.id)).toBe(true);
      // NOTE: ExitService/GdprService take tenantId as a parameter at
      // the service layer; tenant binding for those calls is enforced
      // by the controller/guard layer, not by an actor argument here.
    } finally {
      await close();
    }
  });
});

describe('Gates — G-E backup/restore reconciliation', () => {
  it('G-E backup/restore: snapshot export restores into a fresh PGlite instance and reconciles row counts, ledger sums and Z-report totals', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { session } = await services.reporting.openSession(actor, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      await completeCashOrder(db, tenant, services.sales, variant.variantId, {
        registerId: tenant.registerId,
      });
      await services.reporting.endSession(actor, session.id);
      const { zReport } = await services.reporting.closeSession(actor, {
        sessionId: session.id,
        countedCashPence: 11000n,
      });
      expect(zReport.zReport.gross_pence).toBe(1000n);

      const restoreDb = await createTestDb();
      try {
        const { snapshot, report } = await services.exports.snapshotAndVerify(
          tenant.tenantId,
          restoreDb.db,
        );
        expect(report.pass).toBe(true);
        expect(report.discrepancies).toHaveLength(0);
        expect(report.tablesChecked).toBeGreaterThan(0);
        expect(report.rowsRestored).toBeGreaterThan(0);
        expect(snapshot.files['orders.json']).toBeDefined();
        expect(snapshot.files['z_reports.json']).toBeDefined();
        expect(snapshot.files['manifest.json']).toBeDefined();
      } finally {
        await restoreDb.close();
      }
    });
  });

  it('G-E tampered snapshot fails with named discrepancies (checksum, ledger sum, row count)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      await completeCashOrder(db, tenant, services.sales, variant.variantId);

      const snapshot = await services.exports.runFullExport(tenant.tenantId);

      // Tamper 1: an order total changed.
      const tamperedOrders = JSON.parse(snapshot.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      tamperedOrders[0] = { ...tamperedOrders[0], total_pence: '9999' };
      const tampered1 = {
        ...snapshot,
        files: { ...snapshot.files, 'orders.json': JSON.stringify(tamperedOrders) },
      };
      const restoreDb1 = await createTestDb();
      try {
        const report = await services.exports.verifyBackupRestore(
          tampered1,
          restoreDb1.db,
          db,
          tenant.tenantId,
        );
        expect(report.pass).toBe(false);
        expect(
          report.discrepancies.some((d) => d.includes('orders.json: checksum mismatch')),
        ).toBe(true);
        expect(
          report.discrepancies.some((d) => d.includes('orders.total_pence sum mismatch')),
        ).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('live=1000'))).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('restored=9999'))).toBe(true);
      } finally {
        await restoreDb1.close();
      }

      // Tamper 2: a row removed.
      const tamperedOrders2 = JSON.parse(snapshot.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      tamperedOrders2.pop();
      const tampered2 = {
        ...snapshot,
        files: { ...snapshot.files, 'orders.json': JSON.stringify(tamperedOrders2) },
      };
      const restoreDb2 = await createTestDb();
      try {
        const report = await services.exports.verifyBackupRestore(
          tampered2,
          restoreDb2.db,
          db,
          tenant.tenantId,
        );
        expect(report.pass).toBe(false);
        expect(
          report.discrepancies.some((d) => d.includes('orders: row count mismatch')),
        ).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('live=1, restored=0'))).toBe(true);
      } finally {
        await restoreDb2.close();
      }
    });
  });
});

describe('Gates — leaky-bucket 429 throttling (Arch-02 §2.4)', () => {
  interface MockRes {
    headers: Record<string, string | number>;
    setHeader(name: string, value: string | number): void;
  }

  function mockRes(): MockRes {
    const headers: Record<string, string | number> = {};
    return {
      headers,
      setHeader(name: string, value: string | number): void {
        headers[name] = value;
      },
    };
  }

  function contextFor(
    req: {
      method?: string;
      path?: string;
      headers?: Record<string, string | undefined>;
      actor?: Actor;
    },
    res: MockRes,
  ): Parameters<RateLimitInterceptor['intercept']>[0] {
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ((): void => undefined),
      getClass: () => class {},
    } as unknown as Parameters<RateLimitInterceptor['intercept']>[0];
  }

  const handler = { handle: () => of({ ok: true }) };

  it('leaky-bucket 429: burst then 429 with Retry-After + RATE_LIMITED + X-RateLimit-* headers', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const interceptor = new RateLimitInterceptor(limiter);
    const actor: Actor = {
      tenantId: 'tenant-gates-429',
      userId: 'user-1',
      locationId: 'loc-1',
      roles: ['manager'],
      authKind: 'api-key',
      apiKeyId: 'key-gates-429',
    };
    // Exhaust the bucket first (same bucket key the interceptor derives).
    for (let i = 0; i < 100; i++) {
      limiter.consume('tenant:tenant-gates-429:key:key:key-gates-429', PER_KEY_BUCKET);
    }
    const res = mockRes();
    let thrown: unknown;
    try {
      await lastValueFrom(
        interceptor.intercept(
          contextFor({ method: 'GET', path: '/v1/catalogue/variants', headers: {}, actor }, res),
          handler,
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(429);
    const body = exception.getResponse() as {
      error: { code: string; message: string; retry_after_seconds: number; request_id: string };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(typeof body.error.request_id).toBe('string');
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
    expect(res.headers['Retry-After']).toBe(body.error.retry_after_seconds);
  });

  it('leaky-bucket 429: till checkout path is exempt from hard 429 (still counted, headers attached)', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const interceptor = new RateLimitInterceptor(limiter);
    const tillActor: Actor = {
      tenantId: 'tenant-gates-till',
      userId: 'user-till',
      locationId: 'loc-1',
      roles: ['cashier'],
      authKind: 'session',
      isTillSession: true,
    };
    // Exhaust the till's bucket completely first.
    for (let i = 0; i < 100; i++) {
      limiter.consume('tenant:tenant-gates-till:key:anonymous', PER_KEY_BUCKET);
    }
    const res = mockRes();
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          { method: 'POST', path: '/v1/sales/orders/abc/tenders', headers: {}, actor: tillActor },
          res,
        ),
        handler,
      ),
    );
    expect(result).toEqual({ ok: true });
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
    expect(res.headers['Retry-After']).toBeUndefined();

    // The same exhausted bucket DOES 429 a non-till checkout call.
    const backOffice: Actor = { ...tillActor, isTillSession: false };
    const res2 = mockRes();
    let thrown: unknown;
    try {
      await lastValueFrom(
        interceptor.intercept(
          contextFor(
            { method: 'POST', path: '/v1/sales/orders/abc/tenders', headers: {}, actor: backOffice },
            res2,
          ),
          handler,
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect(res2.headers['Retry-After']).toBeGreaterThan(0);
  });
});

describe('Gates — webhook HMAC + DLQ replay (Arch-02 §3)', () => {
  /** Scripted fake delivery: returns the next scripted outcome (status code, or throws). */
  function scriptedDeliver(script: Array<number | Error>) {
    const requests: DeliverRequest[] = [];
    let index = 0;
    const deliver = async (request: DeliverRequest): Promise<number> => {
      requests.push(request);
      const outcome = script[Math.min(index, script.length - 1)] as number | Error;
      index += 1;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    };
    return { deliver, requests };
  }

  it('webhook HMAC: signature verifies, tampered body fails, stale timestamp rejected', async () => {
    const secret = 'gate-webhook-secret';
    const timestamp = 1_792_000_000;
    const body = JSON.stringify({ event_id: 'abc', total_pence: 1200 });

    const signature = WebhookService.signPayload(secret, timestamp, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signature).toBe(
      `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`,
    );
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp)).toBe(true);
    // Tampered body fails.
    expect(
      WebhookService.verifySignature(
        secret,
        timestamp,
        JSON.stringify({ event_id: 'abc', total_pence: 9999 }),
        signature,
        timestamp,
      ),
    ).toBe(false);
    // Wrong secret fails.
    expect(WebhookService.verifySignature('other-secret', timestamp, body, signature, timestamp)).toBe(
      false,
    );
    // Timestamp older than 5 minutes is rejected (replay protection);
    // exactly 5 minutes old is still accepted; a future timestamp
    // beyond the window is also rejected.
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp + 301)).toBe(
      false,
    );
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp + 300)).toBe(
      true,
    );
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp - 301)).toBe(
      false,
    );
    expect(WebhookService.verifySignature(secret, timestamp, body, 'sha256=short', timestamp)).toBe(
      false,
    );
  });

  it('webhook DLQ: delivery fails 11 times then dead_letter; replay re-delivers', async () => {
    await withDb(async ({ db, tenant }) => {
      const audit = new AuditService(db);
      const script: Array<number | Error> = [500];
      const { deliver, requests } = scriptedDeliver(script);
      let now = new Date('2026-11-13T12:00:00.000Z');
      const webhooks = new WebhookService(db, audit, { deliver, clock: () => now });
      const { endpoint, secret } = await webhooks.registerEndpoint(
        tenant.tenantId,
        'https://example.test/hook',
        ['order.completed'],
      );
      void endpoint;

      const published = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 1200,
      });
      const deliveryId = published.deliveryIds[0] as string;

      // Attempt 1 (initial delivery) at T0.
      let delivery = await webhooks.getDelivery(deliveryId);
      expect(delivery?.status).toBe('pending');
      expect(delivery?.attempt_count).toBe(1);
      expect(delivery?.last_status_code).toBe(500);

      // Attempts 2..11, each at its scheduled time.
      let expectedTime = now.getTime();
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        expectedTime += RETRY_DELAYS_MS[attempt - 2] as number;
        now = new Date(expectedTime);
        const attempted = await webhooks.processDueDeliveries(now);
        expect(attempted).toContain(deliveryId);
        delivery = await webhooks.getDelivery(deliveryId);
        expect(delivery?.attempt_count).toBe(attempt);
        if (attempt < 11) {
          expect(delivery?.status).toBe('pending');
        } else {
          expect(delivery?.status).toBe('dead_letter');
          expect(delivery?.dlq_entered_at?.getTime()).toBe(expectedTime);
          expect(delivery?.next_attempt_at).toBeNull();
        }
      }

      // The DLQ entry is audited, and the due sweep never retries it.
      expect((await auditEvents(db, tenant.tenantId, 'webhook.dlq_entered')).length).toBe(1);
      now = new Date(expectedTime + 30 * 24 * 60 * 60 * 1000);
      expect(await webhooks.processDueDeliveries(now)).not.toContain(deliveryId);

      // Every failed delivery attempt carried a signed request whose
      // signature verifies against the endpoint secret.
      expect(requests.length).toBe(11);
      const firstRequest = requests[0] as DeliverRequest;
      const ts = Number(firstRequest.headers['X-Webhook-Timestamp']);
      expect(
        WebhookService.verifySignature(
          secret,
          ts,
          firstRequest.body,
          firstRequest.headers['X-Webhook-Signature'] as string,
          ts,
        ),
      ).toBe(true);

      // Replay with the endpoint healthy again: success clears dead_letter.
      script.push(200);
      const replayed = await webhooks.replayDeadLetter(deliveryId, now);
      expect(replayed.status).toBe('delivered');
      expect(replayed.attempt_count).toBe(1);
      expect(replayed.dlq_entered_at).toBeNull();
      expect(requests).toHaveLength(12);
      expect((await auditEvents(db, tenant.tenantId, 'webhook.replayed')).length).toBe(1);
    });
  });
});

describe('Gates — Z-report / CSV reproducibility (Arch-02 §5.3)', () => {
  it('Z-report/CSV reproducibility: same Z-report exported twice yields identical base figures plus visible correction rows', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const generatedAt = new Date('2026-11-13T12:00:00.000Z');

      // Z-report 1: one £10 cash sale.
      const { session: session1 } = await services.reporting.openSession(actor, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      await completeCashOrder(db, tenant, services.sales, variant.variantId, {
        registerId: tenant.registerId,
      });
      await services.reporting.endSession(actor, session1.id);
      const { zReport: z1 } = await services.reporting.closeSession(actor, {
        sessionId: session1.id,
        countedCashPence: 11000n,
      });
      expect(z1.zReport.z_number).toBe(1n);
      expect(z1.zReport.gross_pence).toBe(1000n);

      // Same Z-report exported twice (same generated_at): identical.
      const first1 = await services.reporting.exportZReportCsv(actor, z1.zReport.id, {
        generatedAt,
      });
      const second1 = await services.reporting.exportZReportCsv(actor, z1.zReport.id, {
        generatedAt,
      });
      expect(first1.csv).toBe(second1.csv);
      expect(first1.sha256).toBe(second1.sha256);
      expect(first1.sha256).toBe(createHash('sha256').update(first1.csv).digest('hex'));
      expect(first1.csv.split('\n')[0]).toBe(Z_REPORT_CSV_COLUMNS.join(','));

      // A post-close correction against Z-report 1 (manager-approved).
      const approvalId = await insertManagerApproval(db, tenant, 'z_report_correction');
      await services.reporting.recordCorrection(actor, {
        zReportId: z1.zReport.id,
        correctionType: 'cash_variance',
        amountPence: 500n,
        reason: 'Post-close cash count correction',
        approvalEventId: approvalId,
      });
      // The issued Z-report itself is never rewritten.
      const z1After = await services.reporting.getZReport(actor, z1.zReport.id);
      expect(z1After.zReport.gross_pence).toBe(1000n);
      expect(z1After.carriedCorrectionTotalPence).toBe(0n);

      // Z-report 2 carries the correction into the next report.
      const { session: session2 } = await services.reporting.openSession(actor, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      await completeCashOrder(db, tenant, services.sales, variant.variantId, {
        registerId: tenant.registerId,
      });
      await services.reporting.endSession(actor, session2.id);
      const { zReport: z2 } = await services.reporting.closeSession(actor, {
        sessionId: session2.id,
        countedCashPence: 11000n,
      });
      expect(z2.zReport.z_number).toBe(2n);
      expect(z2.carriedCorrectionTotalPence).toBe(500n);
      expect(z2.carriedCorrections).toHaveLength(1);
      expect(z2.carriedCorrections[0]?.reason).toBe('Post-close cash count correction');

      // Z-report 2 exported twice: identical.
      const first2 = await services.reporting.exportZReportCsv(actor, z2.zReport.id, {
        generatedAt,
      });
      const second2 = await services.reporting.exportZReportCsv(actor, z2.zReport.id, {
        generatedAt,
      });
      expect(first2.csv).toBe(second2.csv);
      expect(first2.sha256).toBe(second2.sha256);

      // Base figures are unchanged by the correction (it is a separate
      // row, never netted into the VAT lines).
      const rows = first2.csv
        .split('\n')
        .filter((line) => line.length > 0)
        .slice(1)
        .map((line) => line.split(','));
      const vatRow = rows.find((cols) => cols[6] !== '' && cols[12] === '');
      expect(vatRow).toBeDefined();
      expect(vatRow?.[10]).toBe('1000'); // gross_pence
      expect(vatRow?.[9]).toBe('167'); // vat_pence (20% tax-inclusive on £10)
      expect(vatRow?.[8]).toBe('833'); // net_pence
      // The correction is visible as its own row.
      const correctionRows = rows.filter(
        (cols) =>
          cols[6] === '' &&
          cols[12] === '' &&
          cols[30] === '' &&
          cols[26] === '500' &&
          (cols[27] as string).includes('cash_variance') &&
          (cols[27] as string).includes('Post-close cash count correction'),
      );
      expect(correctionRows).toHaveLength(1);
    });
  });
});

describe('Gates — D-11 / GDPR exit + statutory archive deletion', () => {
  it('D-11/GDPR exit: termination blocked with exact blocking ids, export window is read-only, hard deletion separates the 6-year VAT archive, zero rows remain, tombstone retained, deletion job logged', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const startAt = new Date('2026-11-13T12:00:00.000Z');
      let now = startAt;
      services.exit.setClock(() => now);
      services.gdpr.setClock(() => now);

      // Live trading data: an open session, a completed cash sale in
      // it, and an unknown card attempt on an order with no register.
      const { session } = await services.reporting.openSession(actor, {
        registerId: tenant.registerId,
        openingFloatPence: 5000n,
      });
      const { order: cashOrder } = await completeCashOrder(db, tenant, services.sales, variant.variantId, {
        registerId: tenant.registerId,
      });
      const { order: unknownOrder, attemptId } = await pendingUnknownOrder(
        db,
        tenant,
        services.sales,
        variant.variantId,
      );
      void unknownOrder;

      // D-11: termination is blocked, with the EXACT blocking ids.
      const blocked = await captureReject(
        services.exit.requestTermination(tenant.tenantId, tenant.users.owner.id),
      );
      expect(blocked).toBeInstanceOf(TerminationBlockedError);
      expect((blocked as TerminationBlockedError).openSessionIds).toEqual([session.id]);
      expect((blocked as TerminationBlockedError).blockingPaymentAttemptIds).toEqual([attemptId]);

      // Resolve the blockers through the real paths: the unknown
      // attempt is declined by provider query; the session is ended
      // and closed (float 5000 + £10 cash sale = 6000 counted).
      const adapter = adapterOf(services.payments);
      adapter.scriptQueryResult(attemptId, { status: 'declined', providerReference: null });
      const resolved = await services.sales.resolveUnknownPayment(actor, {
        paymentAttemptId: attemptId,
        method: 'provider_query',
      });
      expect(resolved.outcome).toBe('declined');
      await services.reporting.endSession(actor, session.id);
      const { zReport } = await services.reporting.closeSession(actor, {
        sessionId: session.id,
        countedCashPence: 6000n,
      });
      expect(zReport.zReport.status).toBe('issued');
      const blockers = await services.exit.findBlockers(tenant.tenantId);
      expect(ExitService.hasBlockers(blockers)).toBe(false);

      // Walk the state machine.
      const requested = await services.exit.requestTermination(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(requested.status).toBe('termination_requested');
      const { tenant: inWindow, windowEndsAt } = await services.exit.beginExportWindow(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(inWindow.status).toBe('export_window');
      expect(windowEndsAt.getTime()).toBe(startAt.getTime() + 30 * 24 * 60 * 60 * 1000);

      // Export window: read-only. A write is blocked at the service
      // layer and at the HTTP guard layer.
      const writeBlocked = await captureReject(
        services.exit.assertTenantWritable(tenant.tenantId),
      );
      expect(writeBlocked).toBeInstanceOf(ForbiddenException);
      const guard = new TenantWriteGuard(services.exit);
      const guardContext = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-tenant-id': tenant.tenantId } }),
        }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(guardContext)).rejects.toThrow(ForbiddenException);

      // The 30-day window has not ended yet: scheduling is rejected.
      await expect(
        services.exit.scheduleHardDelete(tenant.tenantId, tenant.users.owner.id),
      ).rejects.toThrow(BadRequestException);

      // 31 days later: schedule, then hard-delete.
      now = new Date(startAt.getTime() + 31 * 24 * 60 * 60 * 1000);
      const scheduled = await services.exit.scheduleHardDelete(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(scheduled.status).toBe('hard_delete_scheduled');
      const deleted = await services.gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);
      expect(deleted.verifiedRowCount).toBe(0);
      expect(deleted.deletedAt.getTime()).toBe(now.getTime());

      // Tombstone retained: id + deleted_at only.
      const tombstone = await db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(tombstone.status).toBe('deleted');
      expect(tombstone.name).toBe('[deleted]');
      expect(tombstone.legal_name).toBeNull();
      expect(tombstone.vat_number).toBeNull();
      expect(tombstone.deleted_at?.getTime()).toBe(now.getTime());

      // Zero rows remain for the tenant in every table.
      for (const table of [
        'orders',
        'order_lines',
        'order_tenders',
        'payment_attempts',
        'refunds',
        'stock_movements',
        'audit_events',
        'z_reports',
        'register_sessions',
        'customers',
      ] as const) {
        const counted = await sql<{ count: string }>`
          SELECT COUNT(*)::text AS count FROM ${sql.table(table)}
          WHERE ${sql.id('tenant_id')} = ${tenant.tenantId}
        `.execute(db);
        expect(Number(counted.rows[0]?.count ?? '0')).toBe(0);
      }

      // The deletion job is logged (platform-level deletion log).
      const jobs = await db
        .selectFrom('deletion_jobs')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('completed');
      expect(jobs[0]?.verified_row_count).toBe(0);

      // The 6-year statutory VAT archive was separated first, with
      // customer PII stripped.
      const archiveOrders = JSON.parse(deleted.archive.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(archiveOrders).toHaveLength(2);
      const archivedCashOrder = archiveOrders.find((o) => o.id === cashOrder.id);
      expect(archivedCashOrder).toBeDefined();
      expect(archivedCashOrder?.customer_id).toBeNull();
      expect(deleted.archive.files['vat_periods.json']).toBeDefined();
      expect(deleted.archive.files['order_lines.json']).toBeDefined();
      expect(deleted.archive.files['payment_attempts.json']).toBeDefined();
      expect(deleted.archive.manifest.length).toBeGreaterThan(0);
    });
  });
});
