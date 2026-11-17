/**
 * E2E — FIFO sync reconciliation with offline_sync_conflict handling
 * (Build-04, Objective 3; Arch-04 §4.3, Arch-06).
 *
 * Scenario: a tablet goes offline with 2 units on hand and queues
 * three £10 cash sales. It reconnects and flushes in FIFO order
 * (created_at ASC). The first two flush cleanly through the real
 * sales service. The third hits a stock shortfall — the shelf is
 * empty — and the flush is REJECTED by the service with
 * InsufficientStockError: the sale is never silently completed, never
 * voided and never deleted (the draft order and its record survive
 * for reconciliation).
 *
 * The reconciliation itself is the register app's sync engine
 * (Worker 1): the physical cash exchange already happened, so the
 * completed cash sale is kept and the shortfall is recorded as a
 * stock_movements adjustment with cause 'offline_sync_conflict'
 * (the schema's `cause` column — the commission's wording
 * "movement_type" is the same concept under the schema's name) plus
 * a dashboard/audit alert. This test proves the SERVER side of that
 * contract: the ledger accepts the conflict cause, the audit alert
 * is recordable through the production AuditService, and the two
 * completed sales are untouched by the reconciliation. The
 * tablet-side flush loop is Worker 1's suite.
 *
 * SCHEMA FINDING (C-INV-01, migration 003): stock_balances carries
 * CHECK (quantity_on_hand >= 0) — "no negative stock", enforced by
 * the balance CHECK as well as by the application at tender time.
 * The balance read model therefore CANNOT go to -1 to express the
 * shortfall. The reconciliation clamps the balance at 0
 * (GREATEST(quantity_on_hand - 1, 0), mirroring
 * InventoryService.applyBalanceDelta with a floor) and the
 * shortfall lives ONLY in the ledger movement + audit alert: after
 * reconciliation, SUM(stock_movements) is -1 while the balance is 0,
 * and that 1-unit divergence IS the recorded shortfall, surfaced to
 * the dashboard by the alert. It is resolved by goods-in or a count,
 * never by deleting the sale. The sync engine (Worker 1) must apply
 * this clamp — a naive -1 balance update is rejected by the CHECK.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { InsufficientStockError } from '../../src/modules/inventory/inventory.service';
import { sortQueueFifo, type OfflineQueuedOrder } from './support/offline-queue';
import {
  auditEvents,
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

describe('E2E — FIFO sync reconciliation with offline_sync_conflict', () => {
  it('FIFO flush: oldest first; shortfall rejected cleanly; conflict adjustment + audit alert recorded; completed cash sales kept', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales, audit } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 2n });

      // Three offline cash sales queued out of order; the flush must
      // still go oldest-first (created_at ASC).
      const t0 = new Date('2026-11-13T10:00:00.000Z');
      const t1 = new Date('2026-11-13T10:01:00.000Z');
      const t2 = new Date('2026-11-13T10:02:00.000Z');
      const queue: OfflineQueuedOrder[] = [
        { localId: 'local-3', idempotencyKey: 'off-3', tenderTotalPence: 1000n, createdAt: t2 },
        { localId: 'local-1', idempotencyKey: 'off-1', tenderTotalPence: 1000n, createdAt: t0 },
        { localId: 'local-2', idempotencyKey: 'off-2', tenderTotalPence: 1000n, createdAt: t1 },
      ];
      const flushOrder = sortQueueFifo(queue);
      expect(flushOrder.map((o) => o.localId)).toEqual(['local-1', 'local-2', 'local-3']);

      // Flush 1 and 2 through the real sales service: both complete,
      // receipts exist, stock 2 -> 0.
      const completedIds: string[] = [];
      for (const queued of flushOrder.slice(0, 2)) {
        void queued;
        const { order } = await completeCashOrder(tenant, sales, variant.variantId);
        expect(order.status).toBe('completed');
        completedIds.push(order.id);
      }
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(0n);

      // Flush 3: the shelf is empty. The service rejects the flush —
      // the sale is NOT completed on no stock, and the order is NOT
      // voided or deleted: it stays 'draft' for reconciliation.
      const { order: shortfallOrder } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const thrown = await captureReject(
        sales.addTender(actor, {
          orderId: shortfallOrder.id,
          tenderType: 'cash',
          amountPence: shortfallOrder.total_pence,
        }),
      );
      expect(thrown).toBeInstanceOf(InsufficientStockError);
      expect((thrown as InsufficientStockError).available).toBe(0n);
      expect(await orderStatus(db, shortfallOrder.id)).toBe('draft');
      const shortfallAttempts = await db
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', shortfallOrder.id)
        .execute();
      expect(shortfallAttempts).toHaveLength(0);

      // Reconciliation (the sync engine's server-side write): the
      // physical cash exchange is kept, so the shortfall is recorded
      // as an 'offline_sync_conflict' adjustment (-1) plus an audit
      // alert. The balance is CLAMPED at 0, not driven to -1:
      // C-INV-01 (migration 003) puts CHECK (quantity_on_hand >= 0)
      // on stock_balances, so a -1 balance update is rejected by the
      // database. The conflict movement carries the offline order's
      // id so the dashboard can trace it.
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('stock_movements')
          .values({
            tenant_id: tenant.tenantId,
            variant_id: variant.variantId,
            warehouse_id: tenant.warehouseId,
            location_id: tenant.locationId,
            cause: 'offline_sync_conflict',
            quantity_change: -1n,
            quantity_in_base_units: -1n,
            unit_id: null,
            cost_pence_at_movement: null,
            order_id: shortfallOrder.id,
            reference_id: null,
            reference_type: 'offline_order',
            created_by_user_id: tenant.users.manager.id,
          })
          .execute();
        await trx
          .updateTable('stock_balances')
          .set({
            quantity_on_hand: sql`GREATEST(quantity_on_hand - 1, 0)`,
            computed_at: sql`now()`,
          })
          .where('variant_id', '=', variant.variantId)
          .where('warehouse_id', '=', tenant.warehouseId)
          .execute();
        await audit.record(trx, {
          tenantId: tenant.tenantId,
          userId: tenant.users.manager.id,
          eventType: 'sync.offline_conflict',
          entityType: 'order',
          entityId: shortfallOrder.id,
          payload: {
            orderId: shortfallOrder.id,
            variantId: variant.variantId,
            shortfallQuantity: '1',
            reason: 'offline_sync_conflict',
            alert: 'Offline cash sale flushed with insufficient stock; completed cash exchange kept, stock shortfall recorded.',
          },
        });
      });

      // The conflict is durable and visible: one movement with the
      // offline_sync_conflict cause, one audit alert, balance clamped
      // at 0 — while the ledger sum is -1, and that 1-unit divergence
      // between ledger and balance IS the recorded shortfall.
      const conflicts = await db
        .selectFrom('stock_movements')
        .selectAll()
        .where('variant_id', '=', variant.variantId)
        .where('cause', '=', 'offline_sync_conflict')
        .execute();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.quantity_change).toBe(-1n);
      expect(conflicts[0]?.order_id).toBe(shortfallOrder.id);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(0n);
      const ledgerSum = await sql<{ total: string }>`
        SELECT COALESCE(SUM(quantity_change), 0)::text AS total FROM stock_movements
        WHERE variant_id = ${variant.variantId} AND warehouse_id = ${tenant.warehouseId}
      `.execute(db);
      expect(BigInt(ledgerSum.rows[0]?.total ?? '0')).toBe(-1n);
      const alerts = await auditEvents(db, tenant.tenantId, 'sync.offline_conflict');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.payload.orderId).toBe(shortfallOrder.id);
      expect(alerts[0]?.payload.shortfallQuantity).toBe('1');

      // The completed cash sales are untouched by the reconciliation:
      // still completed, receipts intact, exactly one 'sale' movement
      // each, no second movement written for them.
      for (const completedId of completedIds) {
        expect(await orderStatus(db, completedId)).toBe('completed');
        const receipts = await db
          .selectFrom('receipts')
          .select('id')
          .where('order_id', '=', completedId)
          .execute();
        expect(receipts).toHaveLength(1);
      }
      const saleMovements = await db
        .selectFrom('stock_movements')
        .select('id')
        .where('variant_id', '=', variant.variantId)
        .where('cause', '=', 'sale')
        .execute();
      expect(saleMovements).toHaveLength(2);
    });
  });
});
