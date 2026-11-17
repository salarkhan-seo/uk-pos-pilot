/**
 * Build-11 Objective 1 — weighted-average cost & stock valuation over HTTP.
 *
 * New routes (both AuthGuard + RequireScope('stock:read')):
 *   GET v1/inventory/balances   — per variant-warehouse balance rows with
 *                                 weighted_avg_cost_pence + total_value_pence
 *   GET v1/inventory/valuation  — per-variant roll-up across warehouses
 *                                 + tenant totals
 *
 * Neither route pre-existed under any name: the inventory controller
 * had only GET v1/inventory/stock (demo-header auth, no cost data).
 * The weighted average comes ONLY from stock_valuation — there is no
 * second valuation source. stock_valuation.quantity_on_hand is a
 * goods-in-time snapshot (only goods-in writes stock_valuation; sales,
 * counts and transfers move stock_balances alone), so quantities here
 * always come from stock_balances and the valuation table supplies
 * the average alone.
 *
 * Layers, each proven where it actually lives (no Nest app boots under
 * vitest — esbuild emits no decorator metadata):
 *
 *  (a) Service — getBalances (two receipts at different costs give the
 *      quantity-weighted mean, not the last cost; total value is
 *      quantity * average; a balance with no valuation row reports
 *      nulls, never a guessed cost; a net-zero goods-in — received ==
 *      damaged — still surfaces its valuation row with quantity 0);
 *      getValuation (multi-warehouse roll-up: value-weighted average,
 *      round half up; tenant totals; nulls when no average is known).
 *  (b) Controller — direct construction with the real services; the
 *      view shapes are what the wire returns (snake_case, bigint as
 *      decimal strings, ISO computed_at).
 *  (c) AuthGuard — driven directly with mock ExecutionContexts on the
 *      real decorated handlers: no credential → 401, stock:write-only
 *      key → 403, stock:read key / admin key / manager PIN / cashier
 *      PIN → pass, cross-tenant actor sees only its own rows.
 *
 * The wire-level proof (real HTTP against the compiled server) lives
 * in apps/api/test/e2e/build11-balances-valuation-live.test.ts.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import { InventoryController } from '../../src/modules/inventory/inventory.controller';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { PurchasingService } from '../../src/modules/inventory/purchasing.service';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { actorFor, guardContext, makeApiKey, makeGuard, reqFor, withDb } from './helpers';

async function seedVariant(
  db: Kysely<DB>,
  tenant: SeededTenant,
  sku: string,
): Promise<{ productId: string; variantId: string }> {
  const catalogue = new CatalogueService(db);
  const actor = actorFor(tenant, 'owner');
  const product = await catalogue.createProduct(actor, { name: `Product ${sku}` });
  const variant = await catalogue.createVariant(actor, {
    productId: product.id,
    sku,
    name: `Variant ${sku}`,
    pricePence: 1000n,
    costPence: 400n,
    taxRateId: tenant.taxRates.standard,
  });
  return { productId: product.id, variantId: variant.id };
}

async function receive(
  inventory: InventoryService,
  actor: ReturnType<typeof actorFor>,
  input: {
    supplierId: string;
    locationId: string;
    warehouseId: string;
    variantId: string;
    quantityReceived: bigint;
    quantityDamaged?: bigint;
    costPence: bigint;
  },
): Promise<void> {
  await inventory.receiveGoodsIn(actor, {
    poId: null,
    supplierId: input.supplierId,
    locationId: input.locationId,
    warehouseId: input.warehouseId,
    lines: [
      {
        variantId: input.variantId,
        quantityReceived: input.quantityReceived,
        quantityDamaged: input.quantityDamaged ?? 0n,
        quantityShort: 0n,
        costPence: input.costPence,
      },
    ],
  });
}

describe('InventoryService — getBalances', () => {
  it('two receipts at different costs: quantity sums, average is the weighted mean, value is quantity * average', async () => {
    await withDb(async ({ db, tenant }) => {
      const purchasing = new PurchasingService(db);
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await purchasing.createSupplier(actor, { name: 'Goods-in Co' });
      const { variantId } = await seedVariant(db, tenant, 'BAL-001');
      // 10 @ 400p + 10 @ 600p → average (10*400 + 10*600) / 20 = 500p,
      // total value 20 * 500 = 10000p — the average, not the last cost.
      for (const costPence of [400n, 600n]) {
        await receive(inventory, actor, {
          supplierId: supplier.id,
          locationId: tenant.locationId,
          warehouseId: tenant.warehouseId,
          variantId,
          quantityReceived: 10n,
          costPence,
        });
      }
      const balances = await inventory.getBalances(actor, { variantId });
      expect(balances).toHaveLength(1);
      expect(balances[0]?.variantId).toBe(variantId);
      expect(balances[0]?.warehouseId).toBe(tenant.warehouseId);
      expect(balances[0]?.quantityOnHand).toBe(20n);
      expect(balances[0]?.weightedAvgCostPence).toBe(500n);
      expect(balances[0]?.totalValuePence).toBe(10000n);
      expect(balances[0]?.computedAt).toBeInstanceOf(Date);
    });
  });

  it('a balance with no valuation row reports nulls, never a guessed cost; filters and cross-tenant isolation hold', async () => {
    await withDb(async ({ db, tenant }) => {
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const { variantId: withCost } = await seedVariant(db, tenant, 'BAL-002');
      const { variantId: noCost } = await seedVariant(db, tenant, 'BAL-003');
      // A balance row with no goods-in behind it: stock that arrived
      // by count/transfer has no received cost on record.
      await db
        .insertInto('stock_balances')
        .values({
          variant_id: noCost,
          warehouse_id: tenant.warehouseId,
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          quantity_on_hand: 7n,
        })
        .execute();
      const balances = await inventory.getBalances(actor);
      expect(balances).toHaveLength(1);
      expect(balances[0]?.variantId).toBe(noCost);
      expect(balances[0]?.quantityOnHand).toBe(7n);
      expect(balances[0]?.weightedAvgCostPence).toBeNull();
      expect(balances[0]?.totalValuePence).toBeNull();
      // Filters: an unknown variant (or warehouse) is an empty list,
      // never 404 — same as GET /v1/inventory/stock.
      expect(await inventory.getBalances(actor, { variantId: withCost })).toHaveLength(0);
      expect(
        await inventory.getBalances(actor, {
          warehouseId: '00000000-0000-0000-0000-000000000000',
        }),
      ).toHaveLength(0);
    });
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const inventory = new InventoryService(db);
      const { variantId } = await seedVariant(db, tenantA, 'BAL-004');
      await db
        .insertInto('stock_balances')
        .values({
          variant_id: variantId,
          warehouse_id: tenantA.warehouseId,
          tenant_id: tenantA.tenantId,
          location_id: tenantA.locationId,
          quantity_on_hand: 3n,
        })
        .execute();
      // Tenant B sees none of tenant A's rows.
      expect(await inventory.getBalances(actorFor(tenantB, 'owner'))).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('a net-zero goods-in (received == damaged) still surfaces its valuation row with quantity 0', async () => {
    await withDb(async ({ db, tenant }) => {
      const purchasing = new PurchasingService(db);
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await purchasing.createSupplier(actor, { name: 'Goods-in Co' });
      const { variantId } = await seedVariant(db, tenant, 'BAL-005');
      // 5 received, 5 damaged: net 0, so no stock_balances row is
      // created — but the valuation row is, with average 700p.
      await receive(inventory, actor, {
        supplierId: supplier.id,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        variantId,
        quantityReceived: 5n,
        quantityDamaged: 5n,
        costPence: 700n,
      });
      expect(await inventory.getStockLevels(actor, { variantId })).toHaveLength(0);
      const balances = await inventory.getBalances(actor, { variantId });
      expect(balances).toHaveLength(1);
      expect(balances[0]?.quantityOnHand).toBe(0n);
      expect(balances[0]?.weightedAvgCostPence).toBe(700n);
      expect(balances[0]?.totalValuePence).toBe(0n);
    });
  });
});

describe('InventoryService — getValuation', () => {
  it('rolls warehouses up per variant with a value-weighted average (round half up) and tenant totals', async () => {
    await withDb(async ({ db, tenant }) => {
      const purchasing = new PurchasingService(db);
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await purchasing.createSupplier(actor, { name: 'Goods-in Co' });
      const secondWarehouse = await purchasing.createWarehouse(actor, {
        locationId: tenant.locationId,
        name: 'Overflow',
        type: 'warehouse',
        isDefault: false,
      });
      const { variantId } = await seedVariant(db, tenant, 'VAL-001');
      // Warehouse A: 1 @ 100p. Warehouse B: 1 @ 101p.
      // Total value 201p over 2 valued units → 100.5 rounds half up to 101p.
      await receive(inventory, actor, {
        supplierId: supplier.id,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        variantId,
        quantityReceived: 1n,
        costPence: 100n,
      });
      await receive(inventory, actor, {
        supplierId: supplier.id,
        locationId: tenant.locationId,
        warehouseId: secondWarehouse.id,
        variantId,
        quantityReceived: 1n,
        costPence: 101n,
      });
      const { valuation, totals } = await inventory.getValuation(actor);
      expect(valuation).toHaveLength(1);
      expect(valuation[0]?.variantId).toBe(variantId);
      expect(valuation[0]?.totalQuantityOnHand).toBe(2n);
      expect(valuation[0]?.weightedAvgCostPence).toBe(101n);
      expect(valuation[0]?.totalValuePence).toBe(201n);
      expect(totals.totalQuantityOnHand).toBe(2n);
      expect(totals.totalValuePence).toBe(201n);
    });
  });

  it('a variant with no known average reports nulls and contributes nothing to the totals value', async () => {
    await withDb(async ({ db, tenant }) => {
      const purchasing = new PurchasingService(db);
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await purchasing.createSupplier(actor, { name: 'Goods-in Co' });
      const { variantId: valued } = await seedVariant(db, tenant, 'VAL-002');
      const { variantId: unvalued } = await seedVariant(db, tenant, 'VAL-003');
      await receive(inventory, actor, {
        supplierId: supplier.id,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        variantId: valued,
        quantityReceived: 4n,
        costPence: 250n,
      });
      await db
        .insertInto('stock_balances')
        .values({
          variant_id: unvalued,
          warehouse_id: tenant.warehouseId,
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          quantity_on_hand: 9n,
        })
        .execute();
      const { valuation, totals } = await inventory.getValuation(actor);
      expect(valuation).toHaveLength(2);
      const unvaluedRow = valuation.find((row) => row.variantId === unvalued);
      expect(unvaluedRow?.totalQuantityOnHand).toBe(9n);
      expect(unvaluedRow?.weightedAvgCostPence).toBeNull();
      expect(unvaluedRow?.totalValuePence).toBeNull();
      // Totals count every unit on hand, but value only the valued ones.
      expect(totals.totalQuantityOnHand).toBe(13n);
      expect(totals.totalValuePence).toBe(1000n);
    });
  });

  it('totals value is null when no variant has a known average', async () => {
    await withDb(async ({ db, tenant }) => {
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const { valuation, totals } = await inventory.getValuation(actor);
      expect(valuation).toHaveLength(0);
      expect(totals.totalQuantityOnHand).toBe(0n);
      expect(totals.totalValuePence).toBeNull();
    });
  });
});

describe('InventoryController — balances + valuation view shapes (direct construction)', () => {
  it('balances return snake_case rows with decimal strings and an ISO computed_at; valuation returns per-variant rows + totals', async () => {
    await withDb(async ({ db, tenant }) => {
      const purchasing = new PurchasingService(db);
      const inventory = new InventoryService(db);
      const controller = new InventoryController(inventory, db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await purchasing.createSupplier(actor, { name: 'Goods-in Co' });
      const { variantId } = await seedVariant(db, tenant, 'VIEW-001');
      for (const costPence of [400n, 600n]) {
        await receive(inventory, actor, {
          supplierId: supplier.id,
          locationId: tenant.locationId,
          warehouseId: tenant.warehouseId,
          variantId,
          quantityReceived: 10n,
          costPence,
        });
      }
      const balances = await controller.balances(reqFor(actor), undefined, undefined);
      expect(balances.balances).toHaveLength(1);
      const row = balances.balances[0];
      expect(row?.variant_id).toBe(variantId);
      expect(row?.warehouse_id).toBe(tenant.warehouseId);
      expect(row?.quantity_on_hand).toBe('20');
      expect(row?.weighted_avg_cost_pence).toBe('500');
      expect(row?.total_value_pence).toBe('10000');
      expect(typeof row?.computed_at).toBe('string');
      expect(Number.isNaN(Date.parse(row?.computed_at ?? ''))).toBe(false);
      const valuation = await controller.valuation(reqFor(actor), undefined, undefined);
      expect(valuation.valuation).toHaveLength(1);
      expect(valuation.valuation[0]?.variant_id).toBe(variantId);
      expect(valuation.valuation[0]?.total_quantity_on_hand).toBe('20');
      expect(valuation.valuation[0]?.weighted_avg_cost_pence).toBe('500');
      expect(valuation.valuation[0]?.total_value_pence).toBe('10000');
      expect(valuation.totals.total_quantity_on_hand).toBe('20');
      expect(valuation.totals.total_value_pence).toBe('10000');
    });
  });
});

describe('Inventory balances + valuation — AuthGuard scope checks', () => {
  it('unauthenticated → 401, stock:write-only key → 403, stock:read key / admin key / manager PIN / cashier PIN → pass', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const balances = InventoryController.prototype.balances;
      const valuation = InventoryController.prototype.valuation;
      for (const handler of [balances, valuation]) {
        await expect(guard.canActivate(guardContext(handler, {}))).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      const readKey = await makeApiKey(db, tenant.tenantId, ['stock:read']);
      for (const handler of [balances, valuation]) {
        expect(
          await guard.canActivate(guardContext(handler, { authorization: `Bearer ${readKey}` })),
        ).toBe(true);
      }
      const writeKey = await makeApiKey(db, tenant.tenantId, ['stock:write']);
      // A scope grants exactly itself — stock:write does NOT imply
      // stock:read, so the read handlers need a read key.
      for (const handler of [balances, valuation]) {
        await expect(
          guard.canActivate(guardContext(handler, { authorization: `Bearer ${writeKey}` })),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      for (const handler of [balances, valuation]) {
        expect(
          await guard.canActivate(guardContext(handler, { authorization: `Bearer ${adminKey}` })),
        ).toBe(true);
      }
      const sessions = new SessionService(db);
      const manager = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      const cashier = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
      });
      for (const token of [manager.token, cashier.token]) {
        for (const handler of [balances, valuation]) {
          expect(
            await guard.canActivate(guardContext(handler, { authorization: `Bearer ${token}` })),
          ).toBe(true);
        }
      }
    });
  });
});
