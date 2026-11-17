/**
 * Inventory service tests (Build-02, Objective 4).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant. PGlite runs on a single connection, so the G-A-13 test runs the
 * two sales SEQUENTIALLY — it proves the outcome (first succeeds, second
 * fails cleanly, no negative stock), not true concurrent lock contention,
 * which must be re-verified against real PostgreSQL. The lock-held proof
 * below shows the FOR UPDATE select the service runs actually holds a
 * RowShareLock.
 */
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { InventoryService, InsufficientStockError } from '../../src/modules/inventory/inventory.service';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.manager.id,
    locationId: tenant.locationId,
    roles: ['manager'],
  };
}

async function makeOrder(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const order = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      register_id: tenant.registerId,
      order_number: 1n,
      business_date: '2026-11-13',
      status: 'draft',
      subtotal_pence: 0n,
      discount_pence: 0n,
      tax_pence: 0n,
      total_pence: 0n,
      created_by_user_id: tenant.users.manager.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return order.id;
}

async function makeSupplier(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const supplier = await db
    .insertInto('suppliers')
    .values({ tenant_id: tenant.tenantId, name: 'Acme Supplies', currency: 'GBP' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return supplier.id;
}

async function balanceOf(
  db: Kysely<DB>,
  variantId: string,
  warehouseId: string,
): Promise<bigint> {
  const row = await db
    .selectFrom('stock_balances')
    .select('quantity_on_hand')
    .where('variant_id', '=', variantId)
    .where('warehouse_id', '=', warehouseId)
    .executeTakeFirst();
  return row === undefined ? -1n : row.quantity_on_hand;
}

async function movementsOf(
  db: Kysely<DB>,
  variantId: string,
): Promise<Array<{ cause: string; quantity_change: bigint; cost: bigint | null }>> {
  const rows = await db
    .selectFrom('stock_movements')
    .select(['cause', 'quantity_change', 'cost_pence_at_movement'])
    .where('variant_id', '=', variantId)
    .orderBy('created_at')
    .execute();
  return rows.map((row) => ({
    cause: row.cause,
    quantity_change: row.quantity_change,
    cost: row.cost_pence_at_movement,
  }));
}

describe('InventoryService — Objective 4', () => {
  it('G-A-13 outcome (SEQUENTIAL): first sale succeeds, second fails cleanly, no negative stock', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 1n });
      const orderId = await makeOrder(db, tenant);
      const service = new InventoryService(db);

      const sellOne = (): Promise<void> =>
        db.transaction().execute(async (trx) =>
          service.decrementStockForOrder(actor, trx, {
            locationId: tenant.locationId,
            orderId,
            userId: actor.userId,
            lines: [{ variantId: variant.variantId, warehouseId: tenant.warehouseId, quantity: 1n }],
          }),
        );

      await sellOne();
      await expect(sellOne()).rejects.toThrow(InsufficientStockError);
      try {
        await sellOne();
        expect.unreachable('second sale should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientStockError);
        const insufficient = error as InsufficientStockError;
        expect(insufficient.variantId).toBe(variant.variantId);
        expect(insufficient.available).toBe(0n);
        expect(insufficient.requested).toBe(1n);
      }

      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(0n);
      const sales = (await movementsOf(db, variant.variantId)).filter((m) => m.cause === 'sale');
      expect(sales).toHaveLength(1);
      expect(sales[0]?.quantity_change).toBe(-1n);
    } finally {
      await close();
    }
  });

  it('lock-held proof: the FOR UPDATE select holds a granted RowShareLock', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });

      // This is the same locking select decrementStockForOrder runs: a
      // plain SELECT takes only AccessShareLock, while SELECT ... FOR
      // UPDATE takes RowShareLock. (Tuple locks are lightweight locks and
      // do not appear in pg_locks.)
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
    } finally {
      await close();
    }
  });

  it('has no direct stock-quantity write method (C-INV-04)', () => {
    const service = new InventoryService(null as unknown as Kysely<DB>);
    expect('setStockQuantity' in service).toBe(false);
    expect('updateQuantity' in service).toBe(false);
  });

  it('count with variance: counted 8 of expected 10 writes one -2 movement; second draft conflicts; re-submit rejected', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 10n });
      const service = new InventoryService(db);

      const count = await service.startCount(actor, { locationId: tenant.locationId });
      expect(count.status).toBe('draft');

      await expect(
        service.startCount(actor, { locationId: tenant.locationId }),
      ).rejects.toThrow(ConflictException);

      await service.setCountedQuantity(actor, {
        countId: count.id,
        variantId: variant.variantId,
        countedQuantity: 8n,
      });
      const result = await service.submitCount(actor, count.id);
      expect(result.adjustments).toEqual([{ variantId: variant.variantId, variance: -2n }]);

      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(8n);
      const countMovements = (await movementsOf(db, variant.variantId)).filter(
        (m) => m.cause === 'count',
      );
      expect(countMovements).toHaveLength(1);
      expect(countMovements[0]?.quantity_change).toBe(-2n);

      await expect(service.submitCount(actor, count.id)).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('goods-in revaluation with exact expected pence (round half up)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 10n, costPence: 100n });
      const supplierId = await makeSupplier(db, tenant);
      const service = new InventoryService(db);

      // (10x100 + 10x120) / 20 = 110p, quantity 20.
      await service.receiveGoodsIn(actor, {
        poId: null,
        supplierId,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        lines: [{ variantId: variant.variantId, quantityReceived: 10n, costPence: 120n }],
      });
      let valuation = await db
        .selectFrom('stock_valuation')
        .select(['weighted_average_cost_pence', 'quantity_on_hand'])
        .where('variant_id', '=', variant.variantId)
        .where('warehouse_id', '=', tenant.warehouseId)
        .executeTakeFirstOrThrow();
      expect(valuation.weighted_average_cost_pence).toBe(110n);
      expect(valuation.quantity_on_hand).toBe(20n);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(20n);

      // (20x110 + 10x130) / 30 = 116.666... -> 117p round half up.
      // Damage of 2 removes quantity at the NEW average 117p; net 28.
      await service.receiveGoodsIn(actor, {
        poId: null,
        supplierId,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        lines: [
          {
            variantId: variant.variantId,
            quantityReceived: 10n,
            quantityDamaged: 2n,
            costPence: 130n,
          },
        ],
      });
      valuation = await db
        .selectFrom('stock_valuation')
        .select(['weighted_average_cost_pence', 'quantity_on_hand'])
        .where('variant_id', '=', variant.variantId)
        .where('warehouse_id', '=', tenant.warehouseId)
        .executeTakeFirstOrThrow();
      expect(valuation.weighted_average_cost_pence).toBe(117n);
      expect(valuation.quantity_on_hand).toBe(28n);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(28n);

      const movements = await movementsOf(db, variant.variantId);
      const goodsIn = movements.filter((m) => m.cause === 'goods_in');
      expect(goodsIn).toHaveLength(3); // seeded 10 @100, then 10 @120, then 10 @130
      expect(goodsIn.map((m) => [m.quantity_change, m.cost])).toContainEqual([10n, 120n]);
      expect(goodsIn.map((m) => [m.quantity_change, m.cost])).toContainEqual([10n, 130n]);
      const damage = movements.filter((m) => m.cause === 'damage');
      expect(damage).toHaveLength(1);
      expect(damage[0]?.quantity_change).toBe(-2n);
      expect(damage[0]?.cost).toBe(117n);
    } finally {
      await close();
    }
  });

  it('receipt without a PO succeeds and the receipt row has po_id NULL', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      const supplierId = await makeSupplier(db, tenant);
      const service = new InventoryService(db);

      const { receiptId } = await service.receiveGoodsIn(actor, {
        poId: null,
        supplierId,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        lines: [{ variantId: variant.variantId, quantityReceived: 5n, costPence: 200n }],
      });
      const receipt = await db
        .selectFrom('goods_in_receipts')
        .selectAll()
        .where('id', '=', receiptId)
        .executeTakeFirstOrThrow();
      expect(receipt.po_id).toBeNull();
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(5n);
      const goodsIn = (await movementsOf(db, variant.variantId)).filter(
        (m) => m.cause === 'goods_in',
      );
      expect(goodsIn).toHaveLength(1);
      expect(goodsIn[0]?.quantity_change).toBe(5n);
    } finally {
      await close();
    }
  });

  it('goods-in against a PO advances status; over-receipt is rejected', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      const supplierId = await makeSupplier(db, tenant);
      const service = new InventoryService(db);

      const po = await db
        .insertInto('purchase_orders')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          supplier_id: supplierId,
          po_number: 1n,
          status: 'sent',
          currency: 'GBP',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('purchase_order_lines')
        .values({
          po_id: po.id,
          variant_id: variant.variantId,
          quantity_ordered: 10n,
          quantity_received: 0n,
          cost_pence: 100n,
          currency: 'GBP',
        })
        .execute();

      const receive = (qty: bigint): Promise<{ receiptId: string }> =>
        service.receiveGoodsIn(actor, {
          poId: po.id,
          supplierId,
          locationId: tenant.locationId,
          warehouseId: tenant.warehouseId,
          lines: [{ variantId: variant.variantId, quantityReceived: qty, costPence: 100n }],
        });

      await receive(6n);
      let poRow = await db
        .selectFrom('purchase_orders')
        .select('status')
        .where('id', '=', po.id)
        .executeTakeFirstOrThrow();
      expect(poRow.status).toBe('partially_received');

      await receive(4n);
      poRow = await db
        .selectFrom('purchase_orders')
        .select('status')
        .where('id', '=', po.id)
        .executeTakeFirstOrThrow();
      expect(poRow.status).toBe('received');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(10n);

      // Over-receipt: a second PO ordered 10, receiving 11 is rejected.
      const po2 = await db
        .insertInto('purchase_orders')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          supplier_id: supplierId,
          po_number: 2n,
          status: 'sent',
          currency: 'GBP',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('purchase_order_lines')
        .values({
          po_id: po2.id,
          variant_id: variant.variantId,
          quantity_ordered: 10n,
          quantity_received: 0n,
          cost_pence: 100n,
          currency: 'GBP',
        })
        .execute();
      await expect(
        service.receiveGoodsIn(actor, {
          poId: po2.id,
          supplierId,
          locationId: tenant.locationId,
          warehouseId: tenant.warehouseId,
          lines: [{ variantId: variant.variantId, quantityReceived: 11n, costPence: 100n }],
        }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('case/pack conversion: decrementing 1 case removes 12 base units; insufficiency is in base units', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 24n });
      const orderId = await makeOrder(db, tenant);
      const service = new InventoryService(db);

      const unit = await db
        .insertInto('units_of_measure')
        .values({ tenant_id: tenant.tenantId, name: 'Case', abbreviation: 'CASE', is_base: false })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('variant_units')
        .values({
          variant_id: variant.variantId,
          unit_id: unit.id,
          conversion_factor: '12',
          is_base: false,
        })
        .execute();

      const sellCases = (cases: bigint): Promise<void> =>
        db.transaction().execute(async (trx) =>
          service.decrementStockForOrder(actor, trx, {
            locationId: tenant.locationId,
            orderId,
            userId: actor.userId,
            lines: [
              {
                variantId: variant.variantId,
                warehouseId: tenant.warehouseId,
                quantity: cases,
                unitId: unit.id,
              },
            ],
          }),
        );

      await sellCases(1n);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(12n);
      const saleMovements = (await movementsOf(db, variant.variantId)).filter(
        (m) => m.cause === 'sale',
      );
      expect(saleMovements).toHaveLength(1);
      expect(saleMovements[0]?.quantity_change).toBe(-12n);

      try {
        await sellCases(2n);
        expect.unreachable('selling 2 cases from 12 base units should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientStockError);
        const insufficient = error as InsufficientStockError;
        expect(insufficient.available).toBe(12n);
        expect(insufficient.requested).toBe(24n);
      }
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(12n);
    } finally {
      await close();
    }
  });

  it('serial numbers: tracked variant without serials is rejected; supplied serials are marked sold', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 2n });
      const orderId = await makeOrder(db, tenant);
      const service = new InventoryService(db);

      const serial = await db
        .insertInto('serial_numbers')
        .values({
          tenant_id: tenant.tenantId,
          variant_id: variant.variantId,
          serial_number: 'SN-001',
          status: 'in_stock',
          order_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const sell = (serialIds?: string[]): Promise<void> =>
        db.transaction().execute(async (trx) =>
          service.decrementStockForOrder(actor, trx, {
            locationId: tenant.locationId,
            orderId,
            userId: actor.userId,
            lines: [
              {
                variantId: variant.variantId,
                warehouseId: tenant.warehouseId,
                quantity: 1n,
                serialIds,
              },
            ],
          }),
        );

      await expect(sell()).rejects.toThrow(BadRequestException);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(2n);

      await sell([serial.id]);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(1n);
      const serialRow = await db
        .selectFrom('serial_numbers')
        .select(['status', 'order_id'])
        .where('id', '=', serial.id)
        .executeTakeFirstOrThrow();
      expect(serialRow.status).toBe('sold');
      expect(serialRow.order_id).toBe(orderId);
    } finally {
      await close();
    }
  });

  it('tenant isolation: a variant from another tenant is not found, never 403', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const otherTenant = await seedTenant(db, { name: 'Other Shop Ltd' });
      const actor = actorFor(tenant);
      const otherVariant = await seedVariant(db, otherTenant);
      const orderId = await makeOrder(db, tenant);
      const service = new InventoryService(db);

      await expect(
        db.transaction().execute(async (trx) =>
          service.decrementStockForOrder(actor, trx, {
            locationId: tenant.locationId,
            orderId,
            userId: actor.userId,
            lines: [
              {
                variantId: otherVariant.variantId,
                warehouseId: tenant.warehouseId,
                quantity: 1n,
              },
            ],
          }),
        ),
      ).rejects.toThrow(NotFoundException);
    } finally {
      await close();
    }
  });
});
