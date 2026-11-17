/**
 * Build-03 Objective 1 — migration 009: the checkout decrement converts
 * case/pack quantities to base units and stamps the order line.
 *
 * A case of 12 sold as 2 cases must move 24 base units (not 2), and the
 * order line must carry warehouse_id / unit_id /
 * quantity_in_base_units = 24. Omitting the unit defaults to the
 * variant's base unit; omitting the warehouse defaults to the
 * location's default warehouse.
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.manager.id,
    locationId: tenant.locationId,
    roles: ['manager'],
  };
}

async function makeOrderWithLine(
  db: Kysely<DB>,
  tenant: SeededTenant,
  variantId: string,
  quantity: bigint,
): Promise<{ orderId: string; lineId: string }> {
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
  const line = await db
    .insertInto('order_lines')
    .values({
      tenant_id: tenant.tenantId,
      order_id: order.id,
      variant_id: variantId,
      quantity,
      unit_price_pence: 1000n,
      base_price_pence: 1000n,
      price_book_id: null,
      price_book_price_pence: null,
      promotion_discount_pence: 0n,
      manual_discount_pence: 0n,
      final_price_pence: 1000n,
      tax_rate_kind: 'standard',
      tax_rate_percent: '20.00',
      tax_amount_pence: 167n,
      line_total_pence: 1000n,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { orderId: order.id, lineId: line.id };
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

/** Create a base unit (factor 1) and a case unit (factor 12) for a variant. */
async function seedUnits(
  db: Kysely<DB>,
  tenant: SeededTenant,
  variantId: string,
): Promise<{
  /** units_of_measure ids — what StockLineInput.unitId carries. */
  baseUnitId: string;
  caseUnitId: string;
  /** variant_units row ids — what order_lines.unit_id carries (FK → variant_units). */
  baseVariantUnitRowId: string;
  caseVariantUnitRowId: string;
}> {
  const baseUom = await db
    .insertInto('units_of_measure')
    .values({ tenant_id: tenant.tenantId, name: 'Single', abbreviation: 'EA', is_base: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  const caseUom = await db
    .insertInto('units_of_measure')
    .values({ tenant_id: tenant.tenantId, name: 'Case', abbreviation: 'CASE', is_base: false })
    .returning('id')
    .executeTakeFirstOrThrow();
  const baseUnit = await db
    .insertInto('variant_units')
    .values({
      variant_id: variantId,
      unit_id: baseUom.id,
      conversion_factor: '1',
      is_base: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const caseUnit = await db
    .insertInto('variant_units')
    .values({
      variant_id: variantId,
      unit_id: caseUom.id,
      conversion_factor: '12',
      is_base: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    baseUnitId: baseUom.id,
    caseUnitId: caseUom.id,
    baseVariantUnitRowId: baseUnit.id,
    caseVariantUnitRowId: caseUnit.id,
  };
}

describe('InventoryService — order line units and warehouse (migration 009)', () => {
  it('converts a case of 12 to 12 base units and stamps the order line', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      const { caseUnitId, caseVariantUnitRowId } = await seedUnits(db, tenant, variant.variantId);
      await setStock(db, tenant, variant.variantId, { quantity: 24n });
      const { orderId, lineId } = await makeOrderWithLine(db, tenant, variant.variantId, 2n);
      const service = new InventoryService(db);

      await db.transaction().execute(async (trx) => {
        await service.decrementStockForOrder(actor, trx, {
          locationId: tenant.locationId,
          orderId,
          userId: actor.userId,
          lines: [
            {
              variantId: variant.variantId,
              warehouseId: tenant.warehouseId,
              quantity: 2n,
              unitId: caseUnitId,
              orderLineId: lineId,
            },
          ],
        });
      });

      // 2 cases x 12 = 24 base units moved; the pool is empty.
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(0n);
      const movement = await db
        .selectFrom('stock_movements')
        .select(['quantity_change', 'quantity_in_base_units', 'unit_id'])
        .where('variant_id', '=', variant.variantId)
        .where('cause', '=', 'sale')
        .executeTakeFirstOrThrow();
      expect(movement.quantity_change).toBe(-24n);
      expect(movement.quantity_in_base_units).toBe(-24n);
      expect(movement.unit_id).toBe(caseUnitId);

      const line = await db
        .selectFrom('order_lines')
        .select(['warehouse_id', 'unit_id', 'quantity_in_base_units'])
        .where('id', '=', lineId)
        .executeTakeFirstOrThrow();
      expect(line.warehouse_id).toBe(tenant.warehouseId);
      expect(line.unit_id).toBe(caseVariantUnitRowId);
      expect(line.quantity_in_base_units).toBe(24n);
    } finally {
      await close();
    }
  });

  it('defaults to the base unit and the default warehouse when omitted', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      const { baseVariantUnitRowId } = await seedUnits(db, tenant, variant.variantId);
      await setStock(db, tenant, variant.variantId, { quantity: 10n });
      const { orderId, lineId } = await makeOrderWithLine(db, tenant, variant.variantId, 3n);
      const service = new InventoryService(db);

      await db.transaction().execute(async (trx) => {
        await service.decrementStockForOrder(actor, trx, {
          locationId: tenant.locationId,
          orderId,
          userId: actor.userId,
          // No warehouseId, no unitId: both must default.
          lines: [{ variantId: variant.variantId, quantity: 3n }],
        });
      });

      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(7n);
      const line = await db
        .selectFrom('order_lines')
        .select(['warehouse_id', 'unit_id', 'quantity_in_base_units'])
        .where('id', '=', lineId)
        .executeTakeFirstOrThrow();
      expect(line.warehouse_id).toBe(tenant.warehouseId);
      expect(line.unit_id).toBe(baseVariantUnitRowId);
      expect(line.quantity_in_base_units).toBe(3n);
    } finally {
      await close();
    }
  });

  it('insufficient base units fail: 2 cases need 24, only 12 are on hand', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant);
      const { caseUnitId } = await seedUnits(db, tenant, variant.variantId);
      await setStock(db, tenant, variant.variantId, { quantity: 12n });
      const { orderId, lineId } = await makeOrderWithLine(db, tenant, variant.variantId, 2n);
      const service = new InventoryService(db);

      await expect(
        db.transaction().execute(async (trx) => {
          await service.decrementStockForOrder(actor, trx, {
            locationId: tenant.locationId,
            orderId,
            userId: actor.userId,
            lines: [
              {
                variantId: variant.variantId,
                warehouseId: tenant.warehouseId,
                quantity: 2n,
                unitId: caseUnitId,
                orderLineId: lineId,
              },
            ],
          });
        }),
      ).rejects.toThrow('available 12, requested 24');
      // Nothing moved and the line is unstamped after the rollback.
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(12n);
      const line = await db
        .selectFrom('order_lines')
        .select('quantity_in_base_units')
        .where('id', '=', lineId)
        .executeTakeFirstOrThrow();
      expect(line.quantity_in_base_units).toBeNull();
    } finally {
      await close();
    }
  });
});
