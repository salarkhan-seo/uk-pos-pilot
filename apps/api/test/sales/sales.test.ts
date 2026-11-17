/**
 * Sales service tests (Build-02, Objective 5).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant. PGlite runs on a single connection, so no Promise.all
 * concurrency anywhere in this file.
 *
 * Money notes: seedVariant defaults to 1000p at the standard 20% rate
 * (tax-inclusive: VAT = round(1000 * 20 / 120) = 167p, net 833p).
 * A zero-rated variant is 500p with 0p VAT. Receipt VAT lines are
 * asserted by hand from those figures.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  createTestDb,
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
  SplitTimeoutError,
  TenderNotApprovedError,
  TenderSumMismatchError,
  UnknownPaymentBlockedError,
  UNKNOWN_PAYMENT_MESSAGE,
} from '../../src/modules/sales/sales.service';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.manager.id,
    locationId: tenant.locationId,
    roles: ['manager'],
  };
}

function makeServices(db: Kysely<DB>): SalesService {
  return makeServicesFull(db).sales;
}

function makeServicesFull(db: Kysely<DB>): {
  sales: SalesService;
  payments: PaymentsService;
  approvals: ApprovalService;
  audit: AuditService;
} {
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

async function approvalFor(
  approvals: ApprovalService,
  tenant: SeededTenant,
  action: 'void_post_tender' | 'refund_above_threshold',
  orderId: string,
): Promise<string> {
  const approval = await approvals.approve(
    {
      tenantId: tenant.tenantId,
      userId: tenant.users.manager.id,
      locationId: tenant.locationId,
      roles: ['manager'],
    },
    {
      action,
      requestedByUserId: tenant.users.cashier.id,
      orderId,
      approverPin: '1234',
    },
  );
  return approval.id;
}

async function orderLines(db: Kysely<DB>, orderId: string) {
  return db
    .selectFrom('order_lines')
    .selectAll()
    .where('order_id', '=', orderId)
    .orderBy('created_at', 'asc')
    .execute();
}

/** A completed card order; the attempt is approved (optionally with a provider reference). */
async function completeCardOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
  opts: { quantity?: bigint; providerReference?: string | null } = {},
) {
  const actor = actorFor(tenant);
  const quantity = opts.quantity ?? 1n;
  const { order } = await sales.createOrder(actor, {
    locationId: tenant.locationId,
    lines: [{ variantId, quantity }],
  });
  const tender = await sales.addTender(actor, {
    orderId: order.id,
    tenderType: 'card',
    amountPence: order.total_pence,
  });
  const attemptId = tender.payment_attempt_id as string;
  await sales.recordCardAttemptOutcome(actor, {
    paymentAttemptId: attemptId,
    outcome: 'approved',
    ...(opts.providerReference === undefined
      ? {}
      : { providerReference: opts.providerReference ?? undefined }),
  });
  const completed = await sales.completeOrder(actor, order.id);
  return { order: completed.order, attemptId, receipt: completed.receipt };
}

/**
 * A completed card order whose attempt went through the simulated Stripe
 * adapter (provider 'stripe'), i.e. the integrated-reader path. Build-02's
 * addTender stamps card attempts as provider 'standalone' (the operator
 * key-in stand-in); this helper repoints the tender at a real adapter
 * attempt, the way the register links an adapter attempt to its tender.
 * Used by the adapter-refund tests (G-A-15, retry queue,
 * insufficient_balance); the standalone path has its own test.
 */
async function completeStripeCardOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sales: SalesService,
  payments: PaymentsService,
  variantId: string,
) {
  const actor = actorFor(tenant);
  const adapter = adapterOf(payments);
  const { order } = await sales.createOrder(actor, {
    locationId: tenant.locationId,
    lines: [{ variantId, quantity: 1n }],
  });
  const tender = await sales.addTender(actor, {
    orderId: order.id,
    tenderType: 'card',
    amountPence: order.total_pence,
  });
  const standaloneAttemptId = tender.payment_attempt_id as string;
  adapter.scriptOutcome('approved');
  const stripeAttempt = await payments.createCardAttempt(actor, {
    orderId: order.id,
    amountPence: order.total_pence,
  });
  expect(stripeAttempt.status).toBe('approved');
  expect(stripeAttempt.provider).toBe('stripe');
  await db
    .updateTable('order_tenders')
    .set({ payment_attempt_id: stripeAttempt.id })
    .where('id', '=', tender.id)
    .execute();
  const completed = await sales.completeOrder(actor, order.id);
  return { order: completed.order, attemptId: stripeAttempt.id, standaloneAttemptId };
}

async function orderStatus(db: Kysely<DB>, orderId: string): Promise<string> {
  const row = await db
    .selectFrom('orders')
    .select('status')
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function balanceOf(db: Kysely<DB>, variantId: string, warehouseId: string): Promise<bigint> {
  const row = await db
    .selectFrom('stock_balances')
    .select('quantity_on_hand')
    .where('variant_id', '=', variantId)
    .where('warehouse_id', '=', warehouseId)
    .executeTakeFirst();
  return row === undefined ? -1n : row.quantity_on_hand;
}

async function tenderCount(db: Kysely<DB>, orderId: string): Promise<number> {
  const rows = await db
    .selectFrom('order_tenders')
    .select('id')
    .where('order_id', '=', orderId)
    .execute();
  return rows.length;
}

describe('SalesService — Objective 5', () => {
  it('state machine: draft -> pending_payment -> completed + receipt with VAT lines and the not-a-VAT-invoice notice', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      expect(order.status).toBe('draft');
      expect(order.order_number).toBe(1n);
      expect(order.total_pence).toBe(1000n);
      expect(order.tax_pence).toBe(167n);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);

      const tender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      expect(tender.tender_type).toBe('cash');
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      // Stock is reserved at the first tender.
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);

      const { order: completed, receipt } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
      expect(completed.completed_at).not.toBeNull();
      expect(receipt.receiptNumber).toBe(1n);
      expect(receipt.orderId).toBe(order.id);
      expect(receipt.totalPence).toBe(1000n);
      expect(receipt.vatInvoiceNotice).toBe('This is not a VAT invoice');
      expect(receipt.lines).toHaveLength(1);
      const line = receipt.lines[0];
      expect(line).toBeDefined();
      expect(line?.taxRateKind).toBe('standard');
      expect(line?.taxRatePercent).toBe('20.00');
      expect(line?.grossPence).toBe(1000n);
      expect(line?.vatPence).toBe(167n);
      expect(line?.netPence).toBe(833n);

      const fetched = await sales.getReceipt(actor, order.id);
      expect(fetched.receiptNumber).toBe(1n);
      expect(fetched.vatInvoiceNotice).toBe('This is not a VAT invoice');

      // The audit rows written by the sales service (via its
      // appendAuditEvent workaround — see sales.service.ts) must form a
      // valid hash chain verifiable by AuditService itself.
      const auditService = new AuditService(db);
      const chain = await auditService.verifyChain(tenant.tenantId);
      expect(chain.ok).toBe(true);
      const events = await auditService.listEvents(tenant.tenantId, {
        eventType: 'order.completed',
      });
      expect(events).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('illegal transitions throw: complete a draft, complete a voided order, void a completed order, tender on a completed order; the DB trigger is the backstop', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // Complete a draft order (no tender yet).
      const { order: draft } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await expect(sales.completeOrder(actor, draft.id)).rejects.toThrow(
        IllegalOrderTransitionError,
      );

      // Complete a voided order.
      await sales.voidOrder(actor, draft.id, 'no longer wanted');
      expect(await orderStatus(db, draft.id)).toBe('voided');
      await expect(sales.completeOrder(actor, draft.id)).rejects.toThrow(
        IllegalOrderTransitionError,
      );
      await expect(
        sales.addTender(actor, { orderId: draft.id, tenderType: 'cash', amountPence: 1000n }),
      ).rejects.toThrow(IllegalOrderTransitionError);

      // Void a completed order, and tender on a completed order: the
      // service refuses both before touching the DB.
      const { order: done } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: done.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await sales.completeOrder(actor, done.id);
      expect(await orderStatus(db, done.id)).toBe('completed');
      await expect(sales.voidOrder(actor, done.id)).rejects.toThrow(IllegalOrderTransitionError);
      await expect(
        sales.addTender(actor, { orderId: done.id, tenderType: 'cash', amountPence: 1000n }),
      ).rejects.toThrow(IllegalOrderTransitionError);
      await expect(sales.completeOrder(actor, done.id)).rejects.toThrow(
        IllegalOrderTransitionError,
      );

      // Direct service-bypassing edit attempt on the completed order:
      // the DB trigger (trg_orders_completed_immutable) rejects it.
      await expect(
        db
          .updateTable('orders')
          .set({ status: 'voided' })
          .where('id', '=', done.id)
          .execute(),
      ).rejects.toThrow(/immutable/);
      expect(await orderStatus(db, done.id)).toBe('completed');
    } finally {
      await close();
    }
  });

  it('numbering: sequential order numbers, voided numbers never reused, sequential receipt numbers', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 10n });

      const { order: first } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const { order: second } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      expect(first.order_number).toBe(1n);
      expect(second.order_number).toBe(2n);

      await sales.voidOrder(actor, first.id, 'customer changed mind');
      const { order: third } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      expect(third.order_number).toBe(3n);

      // Two receipts, sequential.
      await sales.addTender(actor, {
        orderId: second.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      const completedSecond = await sales.completeOrder(actor, second.id);
      expect(completedSecond.receipt.receiptNumber).toBe(1n);
      await sales.addTender(actor, {
        orderId: third.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      const completedThird = await sales.completeOrder(actor, third.id);
      expect(completedThird.receipt.receiptNumber).toBe(2n);
    } finally {
      await close();
    }
  });

  it('split tenders: cash + card completes only after the card attempt is approved; unknown blocks with the W-12 message', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      expect(order.total_pence).toBe(2000n);
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1200n,
      });
      const cardTender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: 800n,
      });
      expect(cardTender.payment_attempt_id).not.toBeNull();
      const attemptId = cardTender.payment_attempt_id as string;

      // Attempt merely 'created': not approved, so completion is blocked
      // (but not with the W-12 unknown message).
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(TenderNotApprovedError);

      // Operator keys in an unknown outcome: W-12 blocks completion.
      const unknown = await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'unknown',
      });
      expect(unknown.status).toBe('unknown');
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        UnknownPaymentBlockedError,
      );
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(UNKNOWN_PAYMENT_MESSAGE);
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      const attemptStillUnknown = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attemptStillUnknown.status).toBe('unknown');

      // Operator checks with the provider: approved. Now it completes.
      const approved = await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'approved',
        providerReference: 'pi_standalone_123',
      });
      expect(approved.status).toBe('approved');
      expect(approved.provider_reference).toBe('pi_standalone_123');
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');
    } finally {
      await close();
    }
  });

  it('tender sum must match the total exactly', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 500n,
      });
      try {
        await sales.completeOrder(actor, order.id);
        throw new Error('completeOrder should have thrown TenderSumMismatchError');
      } catch (error) {
        expect(error).toBeInstanceOf(TenderSumMismatchError);
        const mismatch = error as TenderSumMismatchError;
        expect(mismatch.expected).toBe(1000n);
        expect(mismatch.actual).toBe(500n);
      }
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
    } finally {
      await close();
    }
  });

  it('split timeout: a first tender older than 5 minutes unwinds the sale back to draft, restores stock, deletes tenders', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);

      // Simulate elapsed time: move the tender's created_at back > 5 min.
      await sql`UPDATE order_tenders SET created_at = now() - interval '10 minutes' WHERE order_id = ${order.id}`.execute(
        db,
      );

      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(SplitTimeoutError);
      expect(await orderStatus(db, order.id)).toBe('draft');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);
      expect(await tenderCount(db, order.id)).toBe(0);
      // The reversal is a compensating 'adjustment' movement.
      const movements = await db
        .selectFrom('stock_movements')
        .select(['cause', 'quantity_change'])
        .where('order_id', '=', order.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(movements.map((m) => [m.cause, m.quantity_change])).toEqual([
        ['sale', -1n],
        ['adjustment', 1n],
      ]);

      // The sale can be retried from draft: tender again and complete.
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

  it('insufficient stock at first tender fails cleanly (G-A-13): order stays draft, no tender, no movement', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      // No stock seeded at all.
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await expect(
        sales.addTender(actor, {
          orderId: order.id,
          tenderType: 'cash',
          amountPence: 1000n,
        }),
      ).rejects.toThrow(InsufficientStockError);
      expect(await orderStatus(db, order.id)).toBe('draft');
      expect(await tenderCount(db, order.id)).toBe(0);
      const movements = await db
        .selectFrom('stock_movements')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(movements).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('void of a pending_payment order restores stock, queues a pending refund for the approved card attempt, deletes tenders', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 400n,
      });
      const cardTender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: 600n,
      });
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: cardTender.payment_attempt_id as string,
        outcome: 'approved',
      });
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);

      // Post-tender void needs a manager void_post_tender approval (Build-03 gate).
      const { approvals } = makeServicesFull(db);
      const approvalId = await approvalFor(approvals, tenant, 'void_post_tender', order.id);
      await sales.voidOrder(actor, order.id, 'customer left', approvalId);
      expect(await orderStatus(db, order.id)).toBe('voided');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);
      expect(await tenderCount(db, order.id)).toBe(0);
      const refunds = await db
        .selectFrom('refunds')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute();
      expect(refunds).toHaveLength(1);
      expect(refunds[0]?.status).toBe('pending');
      expect(refunds[0]?.amount_pence).toBe(600n);
      expect(refunds[0]?.payment_attempt_id).toBe(cardTender.payment_attempt_id);
    } finally {
      await close();
    }
  });

  it('tenant isolation: another tenant sees 404 on addTender, completeOrder and getReceipt', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const actor = actorFor(tenant);
      const otherActor = actorFor(other);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await expect(
        sales.addTender(otherActor, {
          orderId: order.id,
          tenderType: 'cash',
          amountPence: 1000n,
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(sales.completeOrder(otherActor, order.id)).rejects.toThrow(NotFoundException);

      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await sales.completeOrder(actor, order.id);
      await expect(sales.getReceipt(otherActor, order.id)).rejects.toThrow(NotFoundException);

      // Creating an order at another tenant's location is also 404.
      await expect(
        sales.createOrder(otherActor, {
          locationId: tenant.locationId,
          lines: [{ variantId: variant.variantId, quantity: 1n }],
        }),
      ).rejects.toThrow(NotFoundException);
    } finally {
      await close();
    }
  });

  it('gift card tender: balance decreases, a redeem ledger row exists; insufficient balance throws', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const card = await db
        .insertInto('gift_cards')
        .values({
          tenant_id: tenant.tenantId,
          code_hash: createHash('sha256').update('GC-1234').digest('hex'),
          code_last4: '1234',
          initial_amount_pence: 5000n,
          balance_pence: 5000n,
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'gift_card',
        amountPence: 600n,
        giftCardCode: 'GC-1234',
      });
      const after = await db
        .selectFrom('gift_cards')
        .select(['balance_pence', 'status'])
        .where('id', '=', card.id)
        .executeTakeFirstOrThrow();
      expect(after.balance_pence).toBe(4400n);
      expect(after.status).toBe('active');
      const ledger = await db
        .selectFrom('gift_card_ledger')
        .selectAll()
        .where('gift_card_id', '=', card.id)
        .execute();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.kind).toBe('redeem');
      expect(ledger[0]?.amount_pence).toBe(-600n);
      expect(ledger[0]?.order_id).toBe(order.id);

      // Pay the rest in cash and complete.
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 400n,
      });
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');

      // Insufficient balance on a second order.
      const { order: second } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await expect(
        sales.addTender(actor, {
          orderId: second.id,
          tenderType: 'gift_card',
          amountPence: 5000n,
          giftCardCode: 'GC-1234',
        }),
      ).rejects.toThrow(/insufficient/i);
      expect(await orderStatus(db, second.id)).toBe('draft');
    } finally {
      await close();
    }
  });

  it('loyalty points tender: 1 point = 1p, a redeem ledger row exists', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const customer = await db
        .insertInto('customers')
        .values({ tenant_id: tenant.tenantId, first_name: 'Loyal', last_name: 'Customer' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const membership = await db
        .insertInto('loyalty_memberships')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          membership_number: 'M-0001',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          membership_id: membership.id,
          kind: 'earn',
          points: 800n,
          order_id: null,
          idempotency_key: 'earn-1',
        })
        .execute();

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        customerId: customer.id,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'loyalty_points',
        amountPence: 500n,
        customerId: customer.id,
      });
      const redeem = await db
        .selectFrom('loyalty_ledger')
        .selectAll()
        .where('customer_id', '=', customer.id)
        .where('kind', '=', 'redeem')
        .execute();
      expect(redeem).toHaveLength(1);
      expect(redeem[0]?.points).toBe(-500n);
      expect(redeem[0]?.membership_id).toBe(membership.id);
      expect(redeem[0]?.order_id).toBe(order.id);

      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 500n,
      });
      const { order: completed } = await sales.completeOrder(actor, order.id);
      expect(completed.status).toBe('completed');

      // Only 300 points remain: a 400p points tender is refused.
      const { order: second } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        customerId: customer.id,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await expect(
        sales.addTender(actor, {
          orderId: second.id,
          tenderType: 'loyalty_points',
          amountPence: 400n,
          customerId: customer.id,
        }),
      ).rejects.toThrow(/insufficient/i);
    } finally {
      await close();
    }
  });

  it('receipt VAT breakdown: standard and zero-rated lines produce two exact per-rate lines', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const standardVariant = await seedVariant(db, tenant, {
        pricePence: 1200n,
        taxRateId: tenant.taxRates.standard,
      });
      const zeroVariant = await seedVariant(db, tenant, {
        pricePence: 500n,
        taxRateId: tenant.taxRates.zero,
      });
      await setStock(db, tenant, standardVariant.variantId, { quantity: 5n });
      await setStock(db, tenant, zeroVariant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [
          { variantId: standardVariant.variantId, quantity: 1n },
          { variantId: zeroVariant.variantId, quantity: 1n },
        ],
      });
      // Hand-computed: total 1700p; standard VAT round(1200*20/120)=200p.
      expect(order.total_pence).toBe(1700n);
      expect(order.tax_pence).toBe(200n);
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1700n,
      });
      const { receipt } = await sales.completeOrder(actor, order.id);
      expect(receipt.lines).toHaveLength(2);
      const standard = receipt.lines.find((l) => l.taxRateKind === 'standard');
      const zero = receipt.lines.find((l) => l.taxRateKind === 'zero');
      expect(standard).toBeDefined();
      expect(standard?.grossPence).toBe(1200n);
      expect(standard?.vatPence).toBe(200n);
      expect(standard?.netPence).toBe(1000n);
      expect(standard?.taxRatePercent).toBe('20.00');
      expect(zero).toBeDefined();
      expect(zero?.grossPence).toBe(500n);
      expect(zero?.vatPence).toBe(0n);
      expect(zero?.netPence).toBe(500n);
      expect(zero?.taxRatePercent).toBe('0.00');
      expect(receipt.totalPence).toBe(1700n);
    } finally {
      await close();
    }
  });

  it('store credit tender: balance is SUM of the ledger, redeem writes a negative row', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const sales = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const customer = await db
        .insertInto('customers')
        .values({ tenant_id: tenant.tenantId, first_name: 'Credit', last_name: 'Customer' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('store_credit_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          kind: 'issue',
          amount_pence: 2000n,
          order_id: null,
          idempotency_key: 'credit-issue-1',
        })
        .execute();

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        customerId: customer.id,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'store_credit',
        amountPence: 700n,
        customerId: customer.id,
      });
      const rows = await db
        .selectFrom('store_credit_ledger')
        .selectAll()
        .where('customer_id', '=', customer.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(rows).toHaveLength(2);
      const redeemRow = rows[1];
      expect(redeemRow?.kind).toBe('redeem');
      expect(redeemRow?.amount_pence).toBe(-700n);
      expect(redeemRow?.order_id).toBe(order.id);

      // Insufficient store credit on a second order (1300p left).
      const { order: second } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        customerId: customer.id,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      await expect(
        sales.addTender(actor, {
          orderId: second.id,
          tenderType: 'store_credit',
          amountPence: 1500n,
          customerId: customer.id,
        }),
      ).rejects.toThrow(/insufficient/i);
    } finally {
      await close();
    }
  });
});

describe('SalesService — Build-03 Objective 2 (void gate, returns & refunds)', () => {
  it('void_post_tender gate: void before any tender needs no approval; void after a tender without approval is rejected, with approval accepted', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales, approvals } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // Draft void: no tender yet, no approval needed.
      const { order: draft } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.voidOrder(actor, draft.id, 'changed mind');
      expect(await orderStatus(db, draft.id)).toBe('voided');

      // Pending void without approval: rejected.
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await expect(sales.voidOrder(actor, order.id, 'no approval')).rejects.toThrow(
        BadRequestException,
      );
      await expect(sales.voidOrder(actor, order.id, 'bad approval', 'missing-id')).rejects.toThrow(
        BadRequestException,
      );
      expect(await orderStatus(db, order.id)).toBe('pending_payment');

      // With a manager void_post_tender approval: accepted.
      const approvalId = await approvalFor(approvals, tenant, 'void_post_tender', order.id);
      await sales.voidOrder(actor, order.id, 'customer left', approvalId);
      expect(await orderStatus(db, order.id)).toBe('voided');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);
    } finally {
      await close();
    }
  });

  it('partial return (restock): refund is the final price paid, stock comes back, order is partially_returned', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 2000n,
      });
      await sales.completeOrder(actor, order.id);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(3n);

      const lines = await orderLines(db, order.id);
      const result = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      expect(result.order.status).toBe('partially_returned');
      expect(result.refundAmountPence).toBe(1000n);
      expect(result.refund?.status).toBe('completed');
      expect(result.refund?.payment_attempt_id).toBeNull();
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      const movements = await db
        .selectFrom('stock_movements')
        .select(['cause', 'quantity_change'])
        .where('order_id', '=', order.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(movements.map((m) => [m.cause, m.quantity_change])).toEqual([
        ['sale', -2n],
        ['return', 1n],
      ]);
    } finally {
      await close();
    }
  });

  it('full return: order becomes returned, refund covers the whole total, stock fully restored', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 2000n,
      });
      await sales.completeOrder(actor, order.id);

      const lines = await orderLines(db, order.id);
      const result = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 2n, disposition: 'restock' }],
      });
      expect(result.order.status).toBe('returned');
      expect(result.refundAmountPence).toBe(2000n);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);

      // A returned order cannot be returned again.
      await expect(
        sales.returnOrder(actor, {
          orderId: order.id,
          lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
        }),
      ).rejects.toThrow(IllegalOrderTransitionError);
    } finally {
      await close();
    }
  });

  it('damaged return: no on-hand increase, return + damage write-off movements recorded', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await sales.completeOrder(actor, order.id);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);

      const lines = await orderLines(db, order.id);
      const result = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'damaged' }],
      });
      expect(result.order.status).toBe('returned');
      expect(result.refundAmountPence).toBe(1000n);
      // Damaged goods never re-enter sellable stock.
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      const movements = await db
        .selectFrom('stock_movements')
        .select(['cause', 'quantity_change'])
        .where('order_id', '=', order.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(movements.map((m) => [m.cause, m.quantity_change])).toEqual([
        ['sale', -1n],
        ['return', 1n],
        ['damage', -1n],
      ]);
    } finally {
      await close();
    }
  });

  it('discount reversal: a pro-rata basket discount is refunded at the discounted price, not the base price', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // 2 x 1000p with a 200p basket discount (D-14 pro-rata: 100p/line).
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
        basketDiscountPence: 200n,
      });
      expect(order.total_pence).toBe(1800n);
      const lines = await orderLines(db, order.id);
      expect(lines[0]?.line_total_pence).toBe(1800n);
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1800n,
      });
      await sales.completeOrder(actor, order.id);

      const result = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      expect(result.refundAmountPence).toBe(900n);
      expect(result.order.status).toBe('partially_returned');
    } finally {
      await close();
    }
  });

  it('BOGO reversal: returning one unit of a buy-1-get-1-free pair refunds nothing; returning both refunds the price paid', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const promo = await db
        .insertInto('promotions')
        .values({
          tenant_id: tenant.tenantId,
          name: 'BOGO test',
          type: 'bogo',
          status: 'active',
          start_at: new Date(Date.now() - 3600_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('promotion_conditions')
        .values({
          promotion_id: promo.id,
          condition_type: 'bogo',
          condition_value: { buyQty: 1, getQty: 1 },
        })
        .execute();

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      // Buy 1 get 1 free: 2 units for 1000p.
      expect(order.total_pence).toBe(1000n);
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await sales.completeOrder(actor, order.id);

      const lines = await orderLines(db, order.id);
      const lineId = lines[0]?.id as string;
      // Returning one unit: the remaining unit is no longer free — it
      // costs the 1000p already paid, so the refund is zero.
      const first = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lineId, quantity: 1n, disposition: 'restock' }],
      });
      expect(first.refundAmountPence).toBe(0n);
      expect(first.refund).toBeNull();
      expect(first.order.status).toBe('partially_returned');
      // Returning the second unit refunds the full price paid.
      const second = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lineId, quantity: 1n, disposition: 'restock' }],
      });
      expect(second.refundAmountPence).toBe(1000n);
      expect(second.order.status).toBe('returned');
      // The fully returned line's promotion application is voided.
      const applied = await db
        .selectFrom('applied_promotions')
        .select('voided')
        .where('order_id', '=', order.id)
        .execute();
      expect(applied).toHaveLength(1);
      expect(applied[0]?.voided).toBe(true);
    } finally {
      await close();
    }
  });

  it('loyalty reversal: earn is reversed on return, capped at the balance; a shortfall needs manager approval', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales, approvals } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const customer = await db
        .insertInto('customers')
        .values({ tenant_id: tenant.tenantId, first_name: 'Loyal', last_name: 'Returner' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const membership = await db
        .insertInto('loyalty_memberships')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          membership_number: 'M-0002',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // --- Full reversal: 200 points earned on the order, none redeemed.
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        customerId: customer.id,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      await db
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          membership_id: membership.id,
          kind: 'earn',
          points: 200n,
          order_id: order.id,
          idempotency_key: 'earn-return-1',
        })
        .execute();
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await sales.completeOrder(actor, order.id);
      const lines = await orderLines(db, order.id);
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      expect(returned.reversedLoyaltyPoints).toBe(200n);
      expect(returned.loyaltyShortfallPoints).toBe(0n);
      const ledger = await db
        .selectFrom('loyalty_ledger')
        .select(['id', 'kind', 'points', 'reverses_ledger_id'])
        .where('customer_id', '=', customer.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(ledger).toHaveLength(2);
      expect(ledger[1]?.kind).toBe('correction');
      expect(ledger[1]?.points).toBe(-200n);
      expect(ledger[1]?.reverses_ledger_id).toBe(ledger[0]?.id);

      // --- Shortfall: 500 earned, 450 already redeemed (balance 50).
      const { order: second } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        customerId: customer.id,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const earn = await db
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          membership_id: membership.id,
          kind: 'earn',
          points: 500n,
          order_id: second.id,
          idempotency_key: 'earn-return-2',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customer.id,
          membership_id: membership.id,
          kind: 'redeem',
          points: -450n,
          order_id: null,
          idempotency_key: 'redeem-return-2',
        })
        .execute();
      await sales.addTender(actor, {
        orderId: second.id,
        tenderType: 'cash',
        amountPence: 1000n,
      });
      await sales.completeOrder(actor, second.id);
      const secondLines = await orderLines(db, second.id);

      // Without a manager approval the shortfall blocks the return.
      await expect(
        sales.returnOrder(actor, {
          orderId: second.id,
          lines: [
            { orderLineId: secondLines[0]?.id as string, quantity: 1n, disposition: 'restock' },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(await orderStatus(db, second.id)).toBe('completed');

      // With approval: reversal capped at the 50-point balance, the
      // 450-point shortfall recorded as a separate correction row.
      const approvalId = await approvalFor(approvals, tenant, 'refund_above_threshold', second.id);
      const shortfalled = await sales.returnOrder(actor, {
        orderId: second.id,
        lines: [{ orderLineId: secondLines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
        approvalEventsId: approvalId,
      });
      expect(shortfalled.reversedLoyaltyPoints).toBe(50n);
      expect(shortfalled.loyaltyShortfallPoints).toBe(450n);
      const shortfallRows = await db
        .selectFrom('loyalty_ledger')
        .select(['kind', 'points', 'reason', 'reverses_ledger_id'])
        .where('customer_id', '=', customer.id)
        .where('order_id', '=', second.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(shortfallRows).toHaveLength(3);
      expect(shortfallRows[1]?.kind).toBe('correction');
      expect(shortfallRows[1]?.points).toBe(-50n);
      expect(shortfallRows[1]?.reverses_ledger_id).toBe(earn.id);
      expect(shortfallRows[2]?.kind).toBe('correction');
      expect(shortfallRows[2]?.points).toBe(0n);
      expect(shortfallRows[2]?.reason).toMatch(/shortfall: 450 points/);
      expect(shortfallRows[2]?.reverses_ledger_id).toBe(earn.id);
    } finally {
      await close();
    }
  });

  it('return above the original quantity is blocked (G-A-15)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 2000n,
      });
      await sales.completeOrder(actor, order.id);
      const lines = await orderLines(db, order.id);
      const lineId = lines[0]?.id as string;

      await expect(
        sales.returnOrder(actor, {
          orderId: order.id,
          lines: [{ orderLineId: lineId, quantity: 3n, disposition: 'restock' }],
        }),
      ).rejects.toThrow(BadRequestException);

      // Return 1 (ok), then a further 2 exceeds the 1 remaining.
      await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lineId, quantity: 1n, disposition: 'restock' }],
      });
      await expect(
        sales.returnOrder(actor, {
          orderId: order.id,
          lines: [{ orderLineId: lineId, quantity: 2n, disposition: 'restock' }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(await orderStatus(db, order.id)).toBe('partially_returned');
    } finally {
      await close();
    }
  });

  it('refund above the original amount is blocked, and a refund of an already-refunded attempt is blocked (G-A-15)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales, payments } = makeServicesFull(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await completeStripeCardOrder(
        db,
        tenant,
        sales,
        payments,
        variant.variantId,
      );

      // 1500p against a 1000p attempt.
      await expect(
        sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 1500n,
          reason: 'too much',
        }),
      ).rejects.toThrow(RefundBlockedError);
      try {
        await sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 1500n,
        });
        throw new Error('createRefund should have thrown RefundBlockedError');
      } catch (error) {
        expect(error).toBeInstanceOf(RefundBlockedError);
        expect((error as RefundBlockedError).code).toBe('refund_exceeds_original');
      }

      // A 600p refund completes; a further 500p would exceed the 1000p original.
      adapter.scriptRefundOutcome('completed');
      const first = await sales.createRefund(actor, {
        orderId: order.id,
        paymentAttemptId: attemptId,
        amountPence: 600n,
        reason: 'partial',
      });
      expect(first.status).toBe('completed');
      await expect(
        sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 500n,
        }),
      ).rejects.toThrow(RefundBlockedError);

      // Refund the remaining 400p: the attempt is now fully refunded...
      adapter.scriptRefundOutcome('completed');
      await sales.createRefund(actor, {
        orderId: order.id,
        paymentAttemptId: attemptId,
        amountPence: 400n,
      });
      const attempt = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attempt.status).toBe('refunded');
      // ...and any further refund against it is blocked.
      try {
        await sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 1n,
        });
        throw new Error('createRefund should have thrown RefundBlockedError');
      } catch (error) {
        expect(error).toBeInstanceOf(RefundBlockedError);
        expect((error as RefundBlockedError).code).toBe('attempt_already_refunded');
      }
      const refunds = await db
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(refunds).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('refund against an unforwarded offline PaymentIntent is blocked (G-A-16)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // Approved attempt with NO provider reference (never forwarded).
      const { order, attemptId } = await completeCardOrder(db, tenant, sales, variant.variantId, {
        providerReference: null,
      });
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
          status: 'pending_forward',
          location_id: tenant.locationId,
          forwarded_at: null,
          idempotency_key: 'off-g16-1',
        })
        .execute();

      try {
        await sales.createRefund(actor, {
          orderId: order.id,
          paymentAttemptId: attemptId,
          amountPence: 1000n,
        });
        throw new Error('createRefund should have thrown RefundBlockedError');
      } catch (error) {
        expect(error).toBeInstanceOf(RefundBlockedError);
        expect((error as RefundBlockedError).code).toBe('offline_unforwarded');
      }
      const refunds = await db
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(refunds).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('refund retry queue: 5 provider-unavailable failures -> manual_escalation with backoff between attempts', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales, payments } = makeServicesFull(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await completeStripeCardOrder(
        db,
        tenant,
        sales,
        payments,
        variant.variantId,
      );
      const lines = await orderLines(db, order.id);
      adapter.scriptRefundOutcomes([
        'failed_provider_unavailable',
        'failed_provider_unavailable',
        'failed_provider_unavailable',
        'failed_provider_unavailable',
        'failed_provider_unavailable',
      ]);

      // Attempt 1 (the return itself) fails: queued, retry 1, due in ~1m.
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      const refundId = returned.refund?.id as string;
      expect(returned.refund?.status).toBe('pending');
      expect(returned.refund?.retry_count).toBe(1);
      expect(returned.refund?.next_retry_at).not.toBeNull();
      expect(returned.refund?.failure_reason).toBe('provider_unavailable');
      expect(returned.refund?.next_retry_at?.getTime() as number).toBeGreaterThan(Date.now());

      // Attempts 2–4: still queued, backoff grows.
      for (const expectedCount of [2, 3, 4]) {
        const retried = await sales.processRefundRetry(actor, refundId);
        expect(retried.status).toBe('pending');
        expect(retried.retry_count).toBe(expectedCount);
        expect(retried.next_retry_at).not.toBeNull();
      }
      // Attempt 5 fails: queue exhausted -> manual_escalation.
      const escalated = await sales.processRefundRetry(actor, refundId);
      expect(escalated.status).toBe('manual_escalation');
      expect(escalated.retry_count).toBe(5);
      expect(escalated.next_retry_at).toBeNull();
      expect(escalated.failure_reason).toBe('provider_unavailable');
      const escalations = await db
        .selectFrom('audit_events')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .where('event_type', '=', 'refund.escalated')
        .execute();
      expect(escalations).toHaveLength(1);
      // A retry on an escalated refund is refused.
      await expect(sales.processRefundRetry(actor, refundId)).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('insufficient_balance: straight to manual_escalation, never retried; manager completes it with a reference', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales, payments } = makeServicesFull(db);
      const adapter = adapterOf(payments);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order, attemptId } = await completeStripeCardOrder(
        db,
        tenant,
        sales,
        payments,
        variant.variantId,
      );
      const lines = await orderLines(db, order.id);
      adapter.scriptRefundOutcome('failed_insufficient_balance');
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      const refundId = returned.refund?.id as string;
      expect(returned.refund?.status).toBe('manual_escalation');
      expect(returned.refund?.failure_reason).toBe('insufficient_balance');
      expect(returned.refund?.next_retry_at).toBeNull();
      expect(returned.refund?.retry_count).toBe(0);
      // Never retried: a retry call is refused outright.
      await expect(sales.processRefundRetry(actor, refundId)).rejects.toThrow(BadRequestException);
      const escalations = await db
        .selectFrom('audit_events')
        .select('payload')
        .where('tenant_id', '=', tenant.tenantId)
        .where('event_type', '=', 'refund.escalated')
        .execute();
      expect(escalations).toHaveLength(1);
      expect(String((escalations[0]?.payload as Record<string, unknown>).nextAction)).toMatch(
        /Top up the provider balance/,
      );

      // A cashier cannot complete a manual refund; a manager can, with a reference.
      const cashier: Actor = {
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        locationId: tenant.locationId,
        roles: ['cashier'],
      };
      await expect(
        sales.completeManualRefund(cashier, {
          refundId,
          outcome: 'completed',
          providerReference: 're_topup_1',
        }),
      ).rejects.toThrow(/Only a manager/);
      const completed = await sales.completeManualRefund(actor, {
        refundId,
        outcome: 'completed',
        providerReference: 're_topup_1',
      });
      expect(completed.status).toBe('completed');
      expect(completed.provider_reference).toBe('re_topup_1');
      const attempt = await db
        .selectFrom('payment_attempts')
        .select('status')
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(attempt.status).toBe('refunded');
    } finally {
      await close();
    }
  });

  it('standalone-terminal refund: routed to manual escalation, never sent to a provider', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // Standalone attempt approved by the operator (no provider reference).
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const tender = await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: 1000n,
      });
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: tender.payment_attempt_id as string,
        outcome: 'approved',
        providerReference: 'TERM-REF-001',
      });
      await sales.completeOrder(actor, order.id);
      const lines = await orderLines(db, order.id);
      const returned = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lines[0]?.id as string, quantity: 1n, disposition: 'restock' }],
      });
      expect(returned.refund?.status).toBe('manual_escalation');
      expect(returned.refund?.failure_reason).toBe('standalone_manual_refund');
      // The manager completes it on the physical terminal and records the reference.
      const completed = await sales.completeManualRefund(actor, {
        refundId: returned.refund?.id as string,
        outcome: 'completed',
        providerReference: 'TERM-REFUND-001',
      });
      expect(completed.status).toBe('completed');
    } finally {
      await close();
    }
  });

  it('return idempotency: the same return key twice returns the original refund, no second refund row', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const { sales } = makeServicesFull(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 2000n,
      });
      await sales.completeOrder(actor, order.id);
      const lines = await orderLines(db, order.id);
      const lineId = lines[0]?.id as string;

      const first = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lineId, quantity: 1n, disposition: 'restock' }],
        idempotencyKey: 'return-1',
      });
      expect(first.replayed).toBeUndefined();
      const second = await sales.returnOrder(actor, {
        orderId: order.id,
        lines: [{ orderLineId: lineId, quantity: 1n, disposition: 'restock' }],
        idempotencyKey: 'return-1',
      });
      expect(second.replayed).toBe(true);
      expect(second.refund?.id).toBe(first.refund?.id);
      const refunds = await db
        .selectFrom('refunds')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(refunds).toHaveLength(1);
      // And the replay did not move stock a second time.
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
    } finally {
      await close();
    }
  });
});
