/**
 * E2E — offline cash queue bounds & online-only feature blocks
 * (Build-04, Objective 3; Arch-04 §4.2, Arch-09/10, G-A-16).
 *
 * Two layers, kept distinct:
 *   (1) The bounds themselves (50 orders / 24h / £250) are pure
 *       tablet rules — proven here against the shared bounds module
 *       in support/offline-queue.ts, and in the register app's own
 *       suite (Worker 1), which owns the local SQLite queue.
 *   (2) The SERVER-side proofs: the API completes the offline-allowed
 *       path (cash) and refuses — or correctly handles — each
 *       online-only path (card without an approved attempt, gift card
 *       with an unknown code, loyalty without a customer, voucher
 *       with an unknown code, and a refund against an unforwarded
 *       offline PaymentIntent, G-A-16). The server cannot observe
 *       "offline", so the block itself lives in the register app;
 *       what the server proves is that none of these paths can
 *       complete a sale on unvalidated data.
 *
 * Stock counts and stock transfers have no offline block to prove at
 * this layer: the count API exists server-side (proven working below)
 * and no transfer service exists in Build-03, so both blocks are
 * register-app guards (Worker 1's suite).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MAX_OFFLINE_DURATION_MS,
  MAX_OFFLINE_ORDERS,
  MAX_SINGLE_OFFLINE_SALE_PENCE,
  checkOfflineSaleAllowed,
  isAllowedOffline,
  offlineFeatureBanner,
  sortQueueFifo,
  type OfflineQueuedOrder,
} from './support/offline-queue';
import {
  balanceOf,
  captureReject,
  completeCashOrder,
  makeServices,
  managerActor,
  orderStatus,
  seedVariant,
  setStock,
  withDb,
} from './support/e2e-helpers';
import { RefundBlockedError } from '../../src/modules/sales/sales.service';

function queuedOrder(n: number, createdAt: Date): OfflineQueuedOrder {
  return {
    localId: `local-${n}`,
    idempotencyKey: `offline-key-${n}`,
    tenderTotalPence: 1000n,
    createdAt,
  };
}

describe('E2E — offline queue bounds (Arch-04 §4.2)', () => {
  const now = new Date('2026-11-13T12:00:00.000Z');
  const offlineSince = new Date(now.getTime() - 60 * 60 * 1000); // 1h offline

  it('bounds: the 50th queued order is allowed, the 51st is blocked as queue_full', () => {
    const queue49 = Array.from({ length: 49 }, (_, i) =>
      queuedOrder(i + 1, new Date(now.getTime() - i * 1000)),
    );
    expect(checkOfflineSaleAllowed(queue49, offlineSince, now, 1000n)).toEqual({ allowed: true });
    const queue50 = [...queue49, queuedOrder(50, now)];
    expect(checkOfflineSaleAllowed(queue50, offlineSince, now, 1000n)).toEqual({
      allowed: false,
      reason: 'queue_full',
      message: expect.stringContaining('50'),
    });
  });

  it('bounds: exactly 24h offline is allowed, 24h + 1ms is blocked as offline_too_long', () => {
    const at24h = new Date(now.getTime() - MAX_OFFLINE_DURATION_MS);
    expect(checkOfflineSaleAllowed([], at24h, now, 1000n)).toEqual({ allowed: true });
    const past24h = new Date(now.getTime() - MAX_OFFLINE_DURATION_MS - 1);
    expect(checkOfflineSaleAllowed([], past24h, now, 1000n)).toEqual({
      allowed: false,
      reason: 'offline_too_long',
      message: expect.stringContaining('24 hours'),
    });
  });

  it('bounds: exactly £250.00 is allowed, £250.01 is blocked as single_sale_too_large', () => {
    expect(checkOfflineSaleAllowed([], offlineSince, now, MAX_SINGLE_OFFLINE_SALE_PENCE)).toEqual({
      allowed: true,
    });
    expect(
      checkOfflineSaleAllowed([], offlineSince, now, MAX_SINGLE_OFFLINE_SALE_PENCE + 1n),
    ).toEqual({
      allowed: false,
      reason: 'single_sale_too_large',
      message: expect.stringContaining('£250.00'),
    });
  });

  it('bounds: the queue cap, the duration cap and the single-sale cap are independent', () => {
    // A small sale on a full queue is still blocked (queue rule wins);
    // a large sale on an empty queue is blocked by the sale rule alone.
    const fullQueue = Array.from({ length: MAX_OFFLINE_ORDERS }, (_, i) =>
      queuedOrder(i + 1, new Date(now.getTime() - i * 1000)),
    );
    const blockedByQueue = checkOfflineSaleAllowed(fullQueue, offlineSince, now, 100n);
    expect(blockedByQueue.allowed).toBe(false);
    if (!blockedByQueue.allowed) {
      expect(blockedByQueue.reason).toBe('queue_full');
    }
    const blockedBySize = checkOfflineSaleAllowed([], offlineSince, now, 999999n);
    expect(blockedBySize.allowed).toBe(false);
    if (!blockedBySize.allowed) {
      expect(blockedBySize.reason).toBe('single_sale_too_large');
    }
  });

  it('bounds: every online-only feature carries an explicit offline banner; cash, price-book pricing and manual discounts are allowed offline', () => {
    for (const feature of [
      'card',
      'gift_card',
      'store_credit',
      'loyalty',
      'voucher',
      'stock_count',
      'stock_transfer',
    ] as const) {
      const banner = offlineFeatureBanner(feature);
      expect(banner).not.toBeNull();
      expect(banner as string).toContain('unavailable offline');
    }
    expect(isAllowedOffline('cash_sale')).toBe(true);
    expect(isAllowedOffline('price_book_pricing')).toBe(true);
    expect(isAllowedOffline('manual_discount')).toBe(true);
  });

  it('bounds: FIFO flush order is created_at ascending, stable for equal timestamps', () => {
    const t0 = new Date('2026-11-13T10:00:00.000Z');
    const t1 = new Date('2026-11-13T10:01:00.000Z');
    const t2 = new Date('2026-11-13T10:02:00.000Z');
    // Deliberately enqueued out of order (t2 first) — the flush must
    // still go oldest-first.
    const queue = [queuedOrder(3, t2), queuedOrder(1, t0), queuedOrder(2, t1)];
    expect(sortQueueFifo(queue).map((o) => o.localId)).toEqual(['local-1', 'local-2', 'local-3']);
    const tied = [queuedOrder(2, t0), queuedOrder(1, t0)];
    expect(sortQueueFifo(tied).map((o) => o.localId)).toEqual(['local-2', 'local-1']);
  });
});

describe('E2E — server side of the offline / online-only boundary', () => {
  it('server: the offline-allowed path (cash sale) completes end to end', async () => {
    await withDb(async ({ db, tenant }) => {
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await completeCashOrder(tenant, sales, variant.variantId);
      expect(order.status).toBe('completed');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(4n);
      expect(await sales.getReceipt(managerActor(tenant), order.id)).toBeDefined();
    });
  });

  it('server: a card sale cannot complete without an approved attempt (the offline card block, server side)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      // A card tender with no provider evidence behind it.
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'card',
        amountPence: order.total_pence,
      });
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow();
      expect(await orderStatus(db, order.id)).toBe('pending_payment');
      const receipts = await db
        .selectFrom('receipts')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(receipts).toHaveLength(0);
    });
  });

  it('server: a gift card tender with an unknown code is rejected (no code is ever trusted offline)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const thrown = await captureReject(
        sales.addTender(actor, {
          orderId: order.id,
          tenderType: 'gift_card',
          amountPence: order.total_pence,
          giftCardCode: 'UNKNOWN-CODE',
        }),
      );
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect(await orderStatus(db, order.id)).toBe('draft');
    });
  });

  it('server: a loyalty tender without a customer is rejected', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const thrown = await captureReject(
        sales.addTender(actor, {
          orderId: order.id,
          tenderType: 'loyalty_points',
          amountPence: order.total_pence,
        }),
      );
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toContain('customerId is required');
    });
  });

  it('server: a voucher code that does not exist is rejected at order creation', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      await expect(
        sales.createOrder(actor, {
          locationId: tenant.locationId,
          lines: [{ variantId: variant.variantId, quantity: 1n }],
          voucherCode: 'NO-SUCH-VOUCHER',
        }),
      ).rejects.toThrow();
    });
  });

  it('server: a refund against an unforwarded offline PaymentIntent is blocked (G-A-16)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      // A completed card order via the stand-in (approved, no provider
      // reference — the offline PaymentIntent has not been forwarded).
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
      await sales.recordCardAttemptOutcome(actor, {
        paymentAttemptId: attemptId,
        outcome: 'approved',
      });
      await sales.completeOrder(actor, order.id);
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
          idempotency_key: 'off-key-e2e-a16',
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
      // The block leaves an auditable trace only via the error code
      // (see gates file-top note); the order itself is untouched.
      expect(await orderStatus(db, order.id)).toBe('completed');
    });
  });

  it('server: stock counts exist and work online — so the offline count block must live in the register app (Worker 1)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { inventory } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const count = await inventory.startCount(actor, { locationId: tenant.locationId });
      await inventory.setCountedQuantity(actor, {
        countId: count.id,
        variantId: variant.variantId,
        countedQuantity: 5n,
      });
      const { adjustments } = await inventory.submitCount(actor, count.id);
      expect(adjustments).toHaveLength(0);
      // No variance: no count movement was written.
      const countMovements = await db
        .selectFrom('stock_movements')
        .select('id')
        .where('variant_id', '=', variant.variantId)
        .where('cause', '=', 'count')
        .execute();
      expect(countMovements).toHaveLength(0);
    });
  });
});
