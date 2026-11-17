/**
 * Payments service tests (Build-03 Objective 2).
 *
 * Covers the deterministic simulated Stripe Terminal adapter (scripted
 * outcomes, T+3 payout), the W-12 unknown-payment resolution paths
 * (provider query, terminal reconciliation, manager decision), late and
 * duplicate webhooks (G-A-07 / G-A-08), async refund.failed (G-A-18),
 * and the discrepancy audit trail. No network call is ever made: the
 * adapter is in-memory and scripted (asserted by the source test below).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant. PGlite runs on a single connection, so no Promise.all
 * concurrency anywhere in this file.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { SimulatedStripeTerminalAdapter } from '../../src/modules/payments/simulated-stripe-terminal.adapter';
import {
  IllegalOrderTransitionError,
  SalesService,
  UnknownPaymentBlockedError,
} from '../../src/modules/sales/sales.service';
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
  approvals: ApprovalService;
  audit: AuditService;
}

function makeServices(db: Kysely<DB>): Services {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  return { sales, payments, approvals, audit };
}

function adapterOf(payments: PaymentsService): SimulatedStripeTerminalAdapter {
  const adapter = payments.getAdapter();
  expect(adapter).toBeInstanceOf(SimulatedStripeTerminalAdapter);
  return adapter as SimulatedStripeTerminalAdapter;
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

/** A completed cash order (no card attempt involved). */
async function completeCashOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
  quantity = 1n,
) {
  const { order } = await sales.createOrder(managerActor(tenant), {
    locationId: tenant.locationId,
    lines: [{ variantId, quantity }],
  });
  await sales.addTender(managerActor(tenant), {
    orderId: order.id,
    tenderType: 'cash',
    amountPence: order.total_pence,
  });
  return sales.completeOrder(managerActor(tenant), order.id);
}

/** An order in pending_payment with one card tender whose attempt is 'unknown'. */
async function pendingUnknownOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
) {
  const { order } = await sales.createOrder(managerActor(tenant), {
    locationId: tenant.locationId,
    lines: [{ variantId, quantity: 1n }],
  });
  const tender = await sales.addTender(managerActor(tenant), {
    orderId: order.id,
    tenderType: 'card',
    amountPence: 1000n,
  });
  const attemptId = tender.payment_attempt_id as string;
  await sales.recordCardAttemptOutcome(managerActor(tenant), {
    paymentAttemptId: attemptId,
    outcome: 'unknown',
  });
  return { order, attemptId };
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

describe('PaymentsService — Objective 2 (adapter)', () => {
  it('simulated adapter: scripted approve / decline / timeout outcomes, and no scripted outcome stays pending', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });

      adapter.scriptOutcome('approved');
      const approved = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
      });
      expect(approved.status).toBe('approved');
      expect(approved.provider_reference).toBe('pi_sim_1');
      expect(approved.provider).toBe('stripe');

      adapter.scriptOutcome('declined');
      const declined = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
      });
      expect(declined.status).toBe('declined');
      expect(declined.provider_reference).toBeNull();

      adapter.scriptOutcome('unknown');
      const unknown = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
      });
      expect(unknown.status).toBe('unknown');

      // No scripted outcome: the adapter never invents an approval.
      const pending = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
      });
      expect(pending.status).toBe('pending');
      expect(pending.provider_reference).toBeNull();
    } finally {
      await close();
    }
  });

  it('simulated adapter: same idempotency key returns the original attempt (no second charge)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      adapter.scriptOutcomes(['approved', 'declined']);
      const first = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
        idempotencyKey: 'key-1',
      });
      expect(first.status).toBe('approved');
      // Same key again: the original attempt, not the queued 'declined'.
      const replay = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
        idempotencyKey: 'key-1',
      });
      expect(replay.id).toBe(first.id);
      expect(replay.status).toBe('approved');
      const attempts = await db
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(attempts).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('simulated adapter: no network — the adapter sources contain no fetch/http import and outcomes come only from the scripted queue', async () => {
    const adapterPath = fileURLToPath(
      new URL('../../src/modules/payments/simulated-stripe-terminal.adapter.ts', import.meta.url),
    );
    const standalonePath = fileURLToPath(
      new URL('../../src/modules/payments/standalone-terminal.adapter.ts', import.meta.url),
    );
    const interfacePath = fileURLToPath(
      new URL('../../src/modules/payments/payment-adapter.interface.ts', import.meta.url),
    );
    for (const path of [adapterPath, standalonePath, interfacePath]) {
      const source = readFileSync(path, 'utf8');
      // Import statements only: the adapter's own comments name the
      // forbidden modules, so a bare substring match would false-positive.
      expect(source).not.toMatch(
        /^import\s+.*\bfrom\s+['"](node:https?|https?|axios|undici)['"]/m,
      );
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/XMLHttpRequest/);
      expect(source).not.toMatch(/https?:\/\/[a-z0-9]/i);
    }
    // Behavioural half: with an empty queue the adapter answers 'pending'
    // (no decision) rather than inventing an outcome.
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const attempt = await payments.createCardAttempt(actor, {
        orderId: order.id,
        amountPence: 1000n,
      });
      expect(attempt.status).toBe('pending');
      const queried = await adapter.queryStatus({ paymentAttemptId: attempt.id });
      expect(queried.status).toBe('unknown');
      const refunded = await adapter.refund({
        idempotencyKey: 're-1',
        paymentAttemptId: attempt.id,
        amountPence: 1000n,
      });
      expect(refunded.outcome).toBe('pending');
    } finally {
      await close();
    }
  });

  it('simulated adapter: T+3 settlement payout schedule per business date', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      adapter.scriptOutcome('approved');
      await payments.createCardAttempt(actor, { orderId: order.id, amountPence: 1000n });

      // business_date reads back as a Date from a `date` column.
      const rawBusinessDate = order.business_date as unknown as string | Date;
      const businessDate =
        rawBusinessDate instanceof Date
          ? rawBusinessDate.toISOString().slice(0, 10)
          : rawBusinessDate;
      const schedule = payments.payoutScheduleFor(businessDate);
      expect(schedule.businessDate).toBe(businessDate);
      expect(schedule.grossPence).toBe(1000n);
      // T+3: settlement date is the business date + 3 calendar days.
      const [y, m, d] = businessDate.split('-').map(Number);
      const expected = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
      expected.setUTCDate(expected.getUTCDate() + 3);
      expect(schedule.settlementDate).toBe(expected.toISOString().slice(0, 10));

      // A date with no approved sales reports zero, not an error.
      expect(payments.payoutScheduleFor('2026-01-01').grossPence).toBe(0n);
    } finally {
      await close();
    }
  });
});

describe('PaymentsService — Objective 2 (W-12)', () => {
  it('W-12 (a): provider query resolves unknown -> approved, order completes, stock moves exactly once', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      adapter.scriptQueryResult(attemptId, {
        status: 'approved',
        providerReference: 'pi_provider_approved',
      });

      const result = await sales.resolveUnknownPayment(actor, {
        paymentAttemptId: attemptId,
        method: 'provider_query',
      });
      expect(result.outcome).toBe('approved');
      expect(result.attempt.status).toBe('approved');
      expect(result.attempt.provider_reference).toBe('pi_provider_approved');
      expect(result.completed).not.toBeNull();
      expect(result.completed?.order.status).toBe('completed');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      const balance = await db
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(balance.quantity_on_hand).toBe(4n);
    } finally {
      await close();
    }
  });

  it('W-12 (a): provider query resolves unknown -> declined, order stays open for another tender', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
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
      const status = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(status.status).toBe('pending_payment');
      // The cashier can take another tender on the same order.
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
    } finally {
      await close();
    }
  });

  it('W-12 (a): unscripted provider query leaves the attempt unknown — no completion without evidence', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const result = await sales.resolveUnknownPayment(actor, {
        paymentAttemptId: attemptId,
        method: 'provider_query',
      });
      expect(result.outcome).toBe('unknown');
      expect(result.completed).toBeNull();
      const attempt = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attempt.status).toBe('unknown');
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        UnknownPaymentBlockedError,
      );
    } finally {
      await close();
    }
  });

  it('W-12 (b): terminal reconciliation records the evidence first, then resolves on the provider answer', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      adapter.scriptQueryResult(attemptId, {
        status: 'approved',
        providerReference: 'pi_reconciled',
      });

      const result = await sales.resolveUnknownPayment(actor, {
        paymentAttemptId: attemptId,
        method: 'terminal_reconciliation',
        terminalEvidence: 'READER-REPORT-2026-11-13-001',
      });
      expect(result.outcome).toBe('approved');
      expect(result.completed?.order.status).toBe('completed');
      const evidence = await auditEvents(db, tenant.tenantId, 'payment.terminal_reconciled');
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.payload.terminalEvidence).toBe('READER-REPORT-2026-11-13-001');
      expect(evidence[0]?.payload.attemptId).toBe(attemptId);

      // Reconciliation without evidence is refused outright.
      const second = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      await expect(
        sales.resolveUnknownPayment(actor, {
          paymentAttemptId: second.attemptId,
          method: 'terminal_reconciliation',
          terminalEvidence: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(order.id).not.toBe(second.order.id);
    } finally {
      await close();
    }
  });

  it('W-12 (c): manager void-and-retry keeps the old attempt unknown with a note, fresh key, tender repointed', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments, approvals } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const approvalId = await voidApproval(approvals, tenant, order.id);

      const decision = await payments.resolveUnknownByManagerDecision(actor, {
        paymentAttemptId: attemptId,
        decision: 'void_and_retry',
        approvalEventsId: approvalId,
        resolutionNote: 'Terminal froze; retry on the reader.',
      });
      expect(decision.decision).toBe('void_and_retry');
      expect(decision.oldAttempt.id).toBe(attemptId);
      expect(decision.oldAttempt.status).toBe('unknown');
      expect(decision.attempt.id).not.toBe(attemptId);
      expect(decision.attempt.idempotency_key).not.toBe(decision.oldAttempt.idempotency_key);
      expect(decision.attempt.status).toBe('pending');

      // The old attempt row was never deleted or rewritten.
      const oldRow = await db
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(oldRow.status).toBe('unknown');
      expect(oldRow.idempotency_key).toBe(decision.oldAttempt.idempotency_key);
      // The tender now points at the fresh attempt; the order is still open.
      const tender = await db
        .selectFrom('order_tenders')
        .select('payment_attempt_id')
        .where('order_id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(tender.payment_attempt_id).toBe(decision.attempt.id);
      const status = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(status.status).toBe('pending_payment');
      const notes = await auditEvents(db, tenant.tenantId, 'payment.unknown_resolved');
      expect(notes).toHaveLength(1);
      expect(notes[0]?.payload.decision).toBe('void_and_retry');
      expect(notes[0]?.payload.resolutionNote).toBe('Terminal froze; retry on the reader.');

      // The retry resolves and the order completes.
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: decision.attempt.id,
        outcome: 'approved',
        providerReference: 'pi_retry_approved',
      });
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(await saleMovementCount(db, order.id)).toBe(1);
    } finally {
      await close();
    }
  });

  it('W-12 (c): manager decision without a valid approval is refused', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      // A malformed id is not a valid approval (BadRequest, not a DB error).
      await expect(
        payments.resolveUnknownByManagerDecision(actor, {
          paymentAttemptId: attemptId,
          decision: 'void_and_retry',
          approvalEventsId: 'missing-approval-id',
        }),
      ).rejects.toThrow(BadRequestException);
      // A well-formed but nonexistent id is likewise refused.
      await expect(
        payments.resolveUnknownByManagerDecision(actor, {
          paymentAttemptId: attemptId,
          decision: 'void_and_retry',
          approvalEventsId: randomUUID(),
        }),
      ).rejects.toThrow(BadRequestException);
      const attempt = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attempt.status).toBe('unknown');
    } finally {
      await close();
    }
  });

  it('W-12 (c): manager standalone decision completes on the manual tender with the reference recorded', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments, approvals } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const approvalId = await voidApproval(approvals, tenant, order.id);

      // No reference, no standalone resolution.
      await expect(
        payments.resolveUnknownByManagerDecision(actor, {
          paymentAttemptId: attemptId,
          decision: 'standalone',
          approvalEventsId: approvalId,
          terminalReference: '',
        }),
      ).rejects.toThrow(BadRequestException);

      const decision = await payments.resolveUnknownByManagerDecision(actor, {
        paymentAttemptId: attemptId,
        decision: 'standalone',
        approvalEventsId: approvalId,
        terminalReference: 'TERM-REF-7788',
      });
      expect(decision.attempt.provider).toBe('standalone');
      expect(decision.attempt.status).toBe('approved');
      expect(decision.attempt.provider_reference).toBe('TERM-REF-7788');
      const oldRow = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(oldRow.status).toBe('unknown');

      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(await saleMovementCount(db, order.id)).toBe(1);
    } finally {
      await close();
    }
  });

  it('negative: completing on an unknown attempt without evidence is rejected (no mark-as-paid path)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        UnknownPaymentBlockedError,
      );
      const status = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(status.status).toBe('pending_payment');
      // recordCardAttemptOutcome itself refuses to complete anything: it
      // only changes the attempt state, and 'unknown' still blocks.
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        'Payment outcome unknown',
      );
    } finally {
      await close();
    }
  });

  it('markAttemptUnknown: a terminal attempt can no longer become unknown; unknown fires the event', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      payments.setEventPublisher({
        publish: (eventType, payload) => {
          events.push({ type: eventType, payload });
        },
      });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const tender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: 1000n,
      });
      const attemptId = tender.payment_attempt_id as string;
      const unknown = await payments.markAttemptUnknown(actor, {
        paymentAttemptId: attemptId,
        reason: 'timeout',
      });
      expect(unknown.status).toBe('unknown');
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('payment.unknown');
      expect(events[0]?.payload.order_id).toBe(order.id);
      const auditRows = await auditEvents(db, tenant.tenantId, 'payment.unknown');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.payload.reason).toBe('timeout');

      // Approve it, then it can no longer become unknown.
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'approved',
      });
      await expect(
        payments.markAttemptUnknown(actor, { paymentAttemptId: attemptId, reason: 'timeout' }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });
});

describe('PaymentsService — Objective 2 (webhooks & discrepancies)', () => {
  it('duplicate webhook: same event id twice -> exactly one sale, one stock movement, one receipt; duplicate logged', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const event = {
        eventId: 'evt_dup_1',
        type: 'payment_intent.succeeded',
        paymentAttemptId: attemptId,
        orderId: order.id,
        providerReference: 'pi_webhook_1',
      };
      const first = await payments.ingestWebhook(actor, event);
      expect(first.action).toBe('resolved');
      const second = await payments.ingestWebhook(actor, event);
      expect(second.action).toBe('duplicate');
      const duplicates = await auditEvents(db, tenant.tenantId, 'payment.webhook_duplicate');
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]?.payload.eventId).toBe('evt_dup_1');

      const { order: completed, receipt } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(receipt.receiptNumber).toBe(1n);
      expect(await saleMovementCount(db, order.id)).toBe(1);
      const receipts = await db
        .selectFrom('receipts')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(receipts).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('late webhook after void -> discrepancy alert in audit_events, order stays voided, no second sale', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments, approvals } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await pendingUnknownOrder(db, tenant, sales, variant.variantId);
      const approvalId = await voidApproval(approvals, tenant, order.id);
      await sales.voidOrder(actor, order.id, 'customer left', approvalId);
      const status = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(status.status).toBe('voided');

      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      payments.setEventPublisher({
        publish: (eventType, payload) => {
          events.push({ type: eventType, payload });
        },
      });

      const result = await payments.ingestWebhook(actor, {
        eventId: 'evt_late_1',
        type: 'payment_intent.succeeded',
        paymentAttemptId: attemptId,
        orderId: order.id,
        providerReference: 'pi_late_1',
        raw: { id: 'evt_late_1', type: 'payment_intent.succeeded' },
      });
      expect(result.action).toBe('discrepancy');
      const discrepancies = await auditEvents(db, tenant.tenantId, 'payment.discrepancy');
      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0]?.payload.attemptId).toBe(attemptId);
      expect(discrepancies[0]?.payload.orderId).toBe(order.id);
      expect(discrepancies[0]?.payload.reason).toBe('late_webhook_after_void_or_refund');
      expect(discrepancies[0]?.payload.webhookContent).toBeDefined();
      expect(events.some((e) => e.type === 'payment.discrepancy')).toBe(true);

      const after = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe('voided');
      expect(await saleMovementCount(db, order.id)).toBe(1);
      // The attempt itself was never rewritten by the late webhook.
      const attempt = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attempt.status).toBe('unknown');
    } finally {
      await close();
    }
  });

  it('late webhook after refund -> discrepancy alert, not a second sale', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // Complete a card order, then fully return it (card refund completes).
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const tender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: 1000n,
      });
      const attemptId = tender.payment_attempt_id as string;
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'approved',
        providerReference: 'pi_sale_1',
      });
      await sales.completeOrder(actor, order.id);
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
      // The sale used a Build-02 standalone attempt, so the refund is
      // routed to manual escalation; the manager completes it on the
      // terminal and records the reference — the refund is then completed.
      expect(returned.refund?.status).toBe('manual_escalation');
      const manuallyCompleted = await sales.completeManualRefund(actor, {
        refundId: returned.refund?.id as string,
        outcome: 'completed',
        providerReference: 're_terminal_1',
      });
      expect(manuallyCompleted.status).toBe('completed');

      const result = await payments.ingestWebhook(actor, {
        eventId: 'evt_late_2',
        type: 'payment_intent.succeeded',
        paymentAttemptId: attemptId,
        orderId: order.id,
        providerReference: 'pi_sale_1',
      });
      expect(result.action).toBe('discrepancy');
      const discrepancies = await auditEvents(db, tenant.tenantId, 'payment.discrepancy');
      expect(discrepancies).toHaveLength(1);
      expect(await saleMovementCount(db, order.id)).toBe(1);
    } finally {
      await close();
    }
  });

  it('refund.failed webhook (G-A-18): succeeded refund -> failed with reason, routed to manual escalation, manager completes it', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
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
        amountPence: 1000n,
      });
      const attemptId = tender.payment_attempt_id as string;
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'approved',
        providerReference: 'pi_sale_2',
      });
      await sales.completeOrder(actor, order.id);
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
      // The sale used a Build-02 standalone attempt, so the refund is
      // routed to manual escalation; the manager completes it on the
      // terminal first, so the refund genuinely shows succeeded.
      expect(returned.refund?.status).toBe('manual_escalation');
      const manuallyCompleted = await sales.completeManualRefund(actor, {
        refundId,
        outcome: 'completed',
        providerReference: 're_terminal_2',
      });
      expect(manuallyCompleted.status).toBe('completed');

      const result = await payments.ingestWebhook(actor, {
        eventId: 'evt_rf_1',
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
      const failed = await auditEvents(db, tenant.tenantId, 'refund.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload.routedTo).toBe('manual_escalation');

      // The manager completes it with the provider's reference.
      const completed = await sales.completeManualRefund(actor, {
        refundId,
        outcome: 'completed',
        providerReference: 're_manual_1',
      });
      expect(completed.status).toBe('completed');
      expect(completed.provider_reference).toBe('re_manual_1');
    } finally {
      await close();
    }
  });

  it('recordDiscrepancy writes payment.discrepancy with attempt, order and webhook content; works with no publisher', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = managerActor(tenant);
      const { sales, payments } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await completeCashOrder(db, tenant, sales, variant.variantId);

      // No publisher is set here: audit-only path.
      const { auditId } = await payments.recordDiscrepancy(actor, {
        paymentAttemptId: null,
        orderId: order.id,
        reason: 'webhook_for_unknown_attempt',
        webhookContent: { eventId: 'evt_x', type: 'payment_intent.succeeded' },
      });
      expect(auditId).toMatch(/^[0-9a-f-]{36}$/);
      const rows = await auditEvents(db, tenant.tenantId, 'payment.discrepancy');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.orderId).toBe(order.id);
      expect(rows[0]?.payload.reason).toBe('webhook_for_unknown_attempt');
      expect(rows[0]?.payload.webhookContent).toEqual({
        eventId: 'evt_x',
        type: 'payment_intent.succeeded',
      });
    } finally {
      await close();
    }
  });
});
