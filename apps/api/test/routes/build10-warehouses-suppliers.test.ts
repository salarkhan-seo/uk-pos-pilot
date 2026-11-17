/**
 * Build-10 Objective 2 — warehouse + supplier HTTP endpoints.
 *
 * Mounted paths (the real ones):
 *   POST v1/inventory/warehouses            (stock:write)
 *   GET  v1/inventory/warehouses            (stock:read)
 *   GET  v1/inventory/warehouses/:id        (stock:read, :id named `id`)
 *   POST v1/purchasing/suppliers            (stock:write)
 *   GET  v1/purchasing/suppliers            (stock:read)
 *   GET  v1/purchasing/suppliers/:id        (stock:read, :id named `id`)
 *   POST v1/purchasing/suppliers/:id/variants (stock:write)
 *
 * The supplier routes live in a second controller inside the
 * InventoryModule (SuppliersController, mounted at v1/purchasing) —
 * not a new module: the PurchasingService and the guard providers
 * already live there. No new migration for warehouses/suppliers
 * (tables date from migrations 002/003); migration 017 adds only the
 * `is_preferred` column on supplier_variants, which the commission
 * requires on the link and which no table had.
 *
 * Layers, each proven where it actually lives (no Nest app boots under
 * vitest — esbuild emits no decorator metadata):
 *
 *  (a) Service — warehouse create/list/get (name/type validation,
 *      location 404, second default for the same location 409 via the
 *      migration-003 partial unique index); supplier create/list/get
 *      (name/currency/lead-time/min-order validation, GBP default);
 *      linkSupplierVariant (supplier + variant 404s, cost validation,
 *      is_preferred persisted, supplier-currency default, upsert).
 *  (b) Controller — direct construction with the real services; the
 *      view shapes are what the wire returns (snake_case, bigint as
 *      decimal strings, ISO dates).
 *  (c) AuthGuard — driven directly with mock ExecutionContexts on the
 *      real decorated handlers: no credential → 401, wrong scope →
 *      403, stock:write/read key or manager PIN session → pass,
 *      cashier PIN session → 403 on writes, x-tenant-id for another
 *      tenant → 404.
 *  (d) UuidValidationInterceptor — malformed :id → 400 INVALID_UUID
 *      naming the field; a well-formed UUID passes through.
 *  (e) Goods-in without a PO — service-level proof that receiveGoodsIn
 *      with poId null updates stock balances and the weighted-average
 *      cost (the cost itself is not exposed over HTTP, so this layer
 *      is the proof; the live HTTP proof of the stock update lives in
 *      apps/api/test/e2e/build10-warehouses-suppliers-live.test.ts).
 *
 * The wire-level proof (real HTTP against the compiled server) lives
 * in apps/api/test/e2e/build10-warehouses-suppliers-live.test.ts.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import { PurchasingController } from '../../src/modules/inventory/purchasing.controller';
import { SuppliersController } from '../../src/modules/inventory/suppliers.controller';
import { PurchasingService } from '../../src/modules/inventory/purchasing.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { UuidValidationInterceptor } from '../../src/common/uuid-validation.interceptor';
import { actorFor, guardContext, makeApiKey, makeGuard, reqFor, withDb } from './helpers';

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED = 'not-a-uuid';

function service(db: Kysely<DB>): PurchasingService {
  return new PurchasingService(db);
}

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

describe('PurchasingService — warehouses', () => {
  it('creates a store and a warehouse; the seeded default is listed first', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      const store = await svc.createWarehouse(actor, {
        locationId: tenant.locationId,
        name: 'Back Store',
        type: 'store',
      });
      expect(store.tenant_id).toBe(tenant.tenantId);
      expect(store.location_id).toBe(tenant.locationId);
      expect(store.type).toBe('store');
      expect(store.is_default).toBe(false);
      const warehouse = await svc.createWarehouse(actor, {
        locationId: tenant.locationId,
        name: 'Overflow',
        type: 'warehouse',
        isDefault: false,
      });
      expect(warehouse.type).toBe('warehouse');
      const listed = await svc.listWarehouses(actor);
      // seedTenant already seeds one default warehouse ('Main Store').
      expect(listed.map((w) => w.name)).toEqual(['Main Store', 'Back Store', 'Overflow']);
      expect(listed[0]?.is_default).toBe(true);
      const fetched = await svc.getWarehouse(actor, warehouse.id);
      expect(fetched.name).toBe('Overflow');
    });
  });

  it('rejects a blank name, a bad type, an unknown location and another tenant location', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      await expect(
        svc.createWarehouse(actor, { locationId: tenant.locationId, name: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.createWarehouse(actor, {
          locationId: tenant.locationId,
          name: 'Bad',
          // @ts-expect-error deliberate bad type
          type: 'shed',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.createWarehouse(actor, { locationId: UNKNOWN_UUID, name: 'Nowhere' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // A missing locationId is a 400 (validation), not a 404 or a
      // database-layer error.
      await expect(
        svc.createWarehouse(actor, {
          // @ts-expect-error deliberate missing locationId
          locationId: undefined,
          name: 'No location',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.linkSupplierVariant(actor, UNKNOWN_UUID, {
          // @ts-expect-error deliberate missing variantId
          variantId: undefined,
          costPence: 100n,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const svc = service(db);
      await expect(
        svc.createWarehouse(actorFor(tenantA, 'owner'), {
          locationId: tenantB.locationId,
          name: 'Other tenant location',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('a second default warehouse for the same location is 409; a non-default is fine', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      // seedTenant already created the default warehouse for this
      // location ('Main Store', is_default true).
      await expect(
        svc.createWarehouse(actor, {
          locationId: tenant.locationId,
          name: 'Second default',
          isDefault: true,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      const plain = await svc.createWarehouse(actor, {
        locationId: tenant.locationId,
        name: 'Second store, not default',
      });
      expect(plain.is_default).toBe(false);
      await expect(svc.getWarehouse(actor, UNKNOWN_UUID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('getWarehouse is 404 for another tenant warehouse (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const svc = service(db);
      await expect(
        svc.getWarehouse(actorFor(tenantA, 'owner'), tenantB.warehouseId),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('PurchasingService — suppliers', () => {
  it('creates with all fields; defaults are GBP, null lead time and min order', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      const full = await svc.createSupplier(actor, {
        name: 'Acme Wholesale',
        currency: 'eur',
        leadTimeDays: 3,
        minOrderValuePence: 5000n,
        contactName: 'Jo',
        email: 'jo@acme.test',
        phone: '020 7946 0000',
      });
      expect(full.currency).toBe('EUR');
      expect(full.lead_time_days).toBe(3);
      expect(full.minimum_order_value_pence).toBe(5000n);
      expect(full.contact_name).toBe('Jo');
      const bare = await svc.createSupplier(actor, { name: 'Minimal Ltd' });
      expect(bare.currency).toBe('GBP');
      expect(bare.lead_time_days).toBeNull();
      expect(bare.minimum_order_value_pence).toBeNull();
      const listed = await svc.listSuppliers(actor);
      expect(listed.map((s) => s.name)).toEqual(['Acme Wholesale', 'Minimal Ltd']);
      expect((await svc.getSupplier(actor, full.id)).name).toBe('Acme Wholesale');
    });
  });

  it('rejects a blank name, a bad currency, a negative lead time and a negative min order', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      await expect(svc.createSupplier(actor, { name: '  ' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        svc.createSupplier(actor, { name: 'Bad currency', currency: 'GB' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.createSupplier(actor, { name: 'Bad lead', leadTimeDays: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.createSupplier(actor, { name: 'Bad min', minOrderValuePence: -1n }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.getSupplier(actor, UNKNOWN_UUID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('getSupplier is 404 for another tenant supplier (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const svc = service(db);
      const supplierB = await svc.createSupplier(actorFor(tenantB, 'owner'), {
        name: 'Tenant B supplier',
      });
      await expect(
        svc.getSupplier(actorFor(tenantA, 'owner'), supplierB.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('PurchasingService — linkSupplierVariant', () => {
  it('links with sku, cost and is_preferred; currency defaults to the supplier currency', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await svc.createSupplier(actor, { name: 'Euro Supplier', currency: 'EUR' });
      const { variantId } = await seedVariant(db, tenant, 'LINK-001');
      const link = await svc.linkSupplierVariant(actor, supplier.id, {
        variantId,
        supplierSku: 'EU-001',
        costPence: 350n,
        isPreferred: true,
      });
      expect(link.supplier_id).toBe(supplier.id);
      expect(link.variant_id).toBe(variantId);
      expect(link.supplier_sku).toBe('EU-001');
      expect(link.cost_pence).toBe(350n);
      // No currency given → the supplier's EUR, not a bare GBP guess.
      expect(link.currency).toBe('EUR');
      expect(link.is_preferred).toBe(true);
      // Upsert: re-linking replaces the row instead of 409ing.
      const relinked = await svc.linkSupplierVariant(actor, supplier.id, {
        variantId,
        supplierSku: 'EU-001-B',
        costPence: 300n,
        currency: 'GBP',
        isPreferred: false,
      });
      expect(relinked.supplier_sku).toBe('EU-001-B');
      expect(relinked.cost_pence).toBe(300n);
      expect(relinked.currency).toBe('GBP');
      expect(relinked.is_preferred).toBe(false);
      const rows = await db
        .selectFrom('supplier_variants')
        .selectAll()
        .where('supplier_id', '=', supplier.id)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  it('is 404 for an unknown supplier, unknown variant or cross-tenant variant; 400 for a negative cost', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await svc.createSupplier(actor, { name: 'Supplier' });
      const { variantId } = await seedVariant(db, tenant, 'LINK-002');
      await expect(
        svc.linkSupplierVariant(actor, UNKNOWN_UUID, { variantId, costPence: 100n }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.linkSupplierVariant(actor, supplier.id, { variantId: UNKNOWN_UUID, costPence: 100n }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.linkSupplierVariant(actor, supplier.id, { variantId, costPence: -5n }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const svc = service(db);
      const supplierA = await svc.createSupplier(actorFor(tenantA, 'owner'), { name: 'A' });
      const { variantId } = await seedVariant(db, tenantB, 'LINK-003');
      await expect(
        svc.linkSupplierVariant(actorFor(tenantA, 'owner'), supplierA.id, {
          variantId,
          costPence: 100n,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('PurchasingController + SuppliersController — view shapes (direct construction)', () => {
  it('warehouse create/list/get return snake_case views with ISO dates', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const purchasing = new PurchasingController(svc);
      const actor = actorFor(tenant, 'owner');
      const created = await purchasing.createWarehouse(reqFor(actor), {
        locationId: tenant.locationId,
        name: 'New Store',
        type: 'store',
        isDefault: false,
      });
      expect(created.name).toBe('New Store');
      expect(created.is_default).toBe(false);
      expect(typeof created.created_at).toBe('string');
      expect(typeof created.updated_at).toBe('string');
      const listed = await purchasing.listWarehouses(reqFor(actor));
      expect(listed.some((w) => w.id === created.id)).toBe(true);
      const fetched = await purchasing.getWarehouse(reqFor(actor), created.id);
      expect(fetched.id).toBe(created.id);
    });
  });

  it('supplier create/list/get/link return snake_case views; min order and cost are decimal strings', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const suppliers = new SuppliersController(svc);
      const actor = actorFor(tenant, 'owner');
      const created = await suppliers.createSupplier(reqFor(actor), {
        name: 'Widget Co',
        currency: 'GBP',
        leadTimeDays: 2,
        minOrderValuePence: '2500',
        contactName: null,
        email: null,
        phone: null,
      });
      expect(created.minimum_order_value_pence).toBe('2500');
      expect(created.lead_time_days).toBe(2);
      const listed = await suppliers.listSuppliers(reqFor(actor));
      expect(listed.map((s) => s.id)).toContain(created.id);
      expect((await suppliers.getSupplier(reqFor(actor), created.id)).name).toBe('Widget Co');
      const { variantId } = await seedVariant(db, tenant, 'VIEW-001');
      const link = await suppliers.linkSupplierVariant(reqFor(actor), created.id, {
        variantId,
        supplierSku: 'W-1',
        costPence: '420',
        isPreferred: true,
      });
      expect(link.cost_pence).toBe('420');
      expect(link.is_preferred).toBe(true);
      expect(typeof link.created_at).toBe('string');
    });
  });
});

describe('Warehouse + supplier controllers — AuthGuard scope checks', () => {
  it('unauthenticated → 401, wrong scope → 403, write key / manager PIN → pass, cashier → 403 on writes', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const createWarehouse = PurchasingController.prototype.createWarehouse;
      const listWarehouses = PurchasingController.prototype.listWarehouses;
      const getWarehouse = PurchasingController.prototype.getWarehouse;
      const createSupplier = SuppliersController.prototype.createSupplier;
      const listSuppliers = SuppliersController.prototype.listSuppliers;
      const getSupplier = SuppliersController.prototype.getSupplier;
      const linkVariant = SuppliersController.prototype.linkSupplierVariant;
      const writeHandlers = [createWarehouse, createSupplier, linkVariant];
      const readHandlers = [listWarehouses, getWarehouse, listSuppliers, getSupplier];
      for (const handler of [...writeHandlers, ...readHandlers]) {
        await expect(guard.canActivate(guardContext(handler, {}))).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      const readKey = await makeApiKey(db, tenant.tenantId, ['stock:read']);
      for (const handler of writeHandlers) {
        await expect(
          guard.canActivate(guardContext(handler, { authorization: `Bearer ${readKey}` })),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      for (const handler of readHandlers) {
        expect(
          await guard.canActivate(guardContext(handler, { authorization: `Bearer ${readKey}` })),
        ).toBe(true);
      }
      const writeKey = await makeApiKey(db, tenant.tenantId, ['stock:write']);
      // A scope grants exactly itself — stock:write does NOT imply
      // stock:read, so the read handlers need a read key.
      for (const handler of writeHandlers) {
        expect(
          await guard.canActivate(guardContext(handler, { authorization: `Bearer ${writeKey}` })),
        ).toBe(true);
      }
      for (const handler of readHandlers) {
        await expect(
          guard.canActivate(guardContext(handler, { authorization: `Bearer ${writeKey}` })),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      // An admin-scope key implies every scope (scopes.ts).
      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      expect(
        await guard.canActivate(
          guardContext(createWarehouse, { authorization: `Bearer ${adminKey}` }),
        ),
      ).toBe(true);
      // A manager PIN session carries stock:write; a cashier PIN
      // session carries stock:read only.
      const sessions = new SessionService(db);
      const manager = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      expect(
        await guard.canActivate(
          guardContext(createSupplier, { authorization: `Bearer ${manager.token}` }),
        ),
      ).toBe(true);
      const cashier = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
      });
      await expect(
        guard.canActivate(
          guardContext(createWarehouse, { authorization: `Bearer ${cashier.token}` }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        await guard.canActivate(
          guardContext(listSuppliers, { authorization: `Bearer ${cashier.token}` }),
        ),
      ).toBe(true);
    });
  });

  it('cross-tenant credential → 404, never 403 (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const guard = makeGuard(db);
      const keyB = await makeApiKey(db, tenantB.tenantId, ['stock:read']);
      await expect(
        guard.canActivate(
          guardContext(SuppliersController.prototype.listSuppliers, {
            authorization: `Bearer ${keyB}`,
            'x-tenant-id': tenantA.tenantId,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('UuidValidationInterceptor — malformed :id on the new routes', () => {
  function mockContext(params: Record<string, unknown>): ExecutionContext {
    const request = {
      params,
      body: undefined,
      method: 'GET',
      path: '/v1/purchasing/suppliers/not-a-uuid',
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
      getHandler: () => undefined,
      getClass: () => Object,
      getType: () => 'http',
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToRpc: () => undefined,
      switchToWs: () => undefined,
    } as unknown as ExecutionContext;
  }

  const NEXT: CallHandler = { handle: () => of('ok') };

  it('malformed id → 400 INVALID_UUID naming the field; a well-formed UUID passes through', () => {
    const interceptor = new UuidValidationInterceptor();
    let caught: unknown;
    try {
      interceptor.intercept(mockContext({ id: MALFORMED }), NEXT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect((caught as HttpException).getResponse()).toMatchObject({
      error: { code: 'INVALID_UUID' },
    });
    expect(interceptor.intercept(mockContext({ id: UNKNOWN_UUID }), NEXT)).toBeDefined();
  });
});

describe('InventoryService — goods-in without a PO updates stock + weighted-average cost', () => {
  it('two receipts at different costs: stock sums, average is the quantity-weighted mean', async () => {
    await withDb(async ({ db, tenant }) => {
      const purchasing = service(db);
      const inventory = new InventoryService(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await purchasing.createSupplier(actor, { name: 'Goods-in Co' });
      const { variantId } = await seedVariant(db, tenant, 'GI-001');
      // First receipt: 10 units at 400p. Second: 10 units at 600p.
      // Weighted average must be (10*400 + 10*600) / 20 = 500p.
      for (const costPence of [400n, 600n]) {
        const receipt = await inventory.receiveGoodsIn(actor, {
          poId: null,
          supplierId: supplier.id,
          locationId: tenant.locationId,
          warehouseId: tenant.warehouseId,
          lines: [
            {
              variantId,
              quantityReceived: 10n,
              quantityDamaged: 0n,
              quantityShort: 0n,
              costPence,
            },
          ],
        });
        expect(receipt.receiptId).toBeTruthy();
      }
      const levels = await inventory.getStockLevels(actor, { variantId });
      expect(levels).toHaveLength(1);
      expect(levels[0]?.quantityOnHand).toBe(20n);
      const valuation = await db
        .selectFrom('stock_valuation')
        .select(['quantity_on_hand', 'weighted_average_cost_pence'])
        .where('variant_id', '=', variantId)
        .where('warehouse_id', '=', tenant.warehouseId)
        .executeTakeFirstOrThrow();
      expect(valuation.quantity_on_hand).toBe(20n);
      expect(valuation.weighted_average_cost_pence).toBe(500n);
    });
  });
});

describe('PurchasingService — createPurchaseOrder (Build-12 Objective 3)', () => {
  it('creates a DRAFT PO with sequential numbers, warehouse + expected date recorded, lines at the given costs', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await svc.createSupplier(actor, { name: 'PO Wholesale' });
      const { variantId } = await seedVariant(db, tenant, 'PO-001');
      const { variantId: variant2Id } = await seedVariant(db, tenant, 'PO-002');
      const expected = new Date('2026-12-01T00:00:00.000Z');
      const first = await svc.createPurchaseOrder(actor, {
        supplierId: supplier.id,
        warehouseId: tenant.warehouseId,
        expectedDeliveryDate: expected,
        lines: [
          { variantId, quantityOrdered: 10n, unitCostPence: 400n },
          { variantId: variant2Id, quantityOrdered: 5n, unitCostPence: 600n },
        ],
      });
      expect(first.purchaseOrder.status).toBe('draft');
      expect(first.purchaseOrder.po_number).toBe(1n);
      expect(first.purchaseOrder.location_id).toBe(tenant.locationId);
      expect(first.purchaseOrder.supplier_id).toBe(supplier.id);
      expect(first.purchaseOrder.warehouse_id).toBe(tenant.warehouseId);
      expect(first.purchaseOrder.expected_delivery_date?.toISOString()).toBe(expected.toISOString());
      expect(first.purchaseOrder.currency).toBe('GBP');
      expect(first.purchaseOrder.sent_at).toBeNull();
      expect(first.lines).toHaveLength(2);
      // Lines are returned ordered by variant_id (service order), NOT
      // insertion order — the two variant UUIDs are random, so assert
      // by variant, not by position. (Build-12 Obj 4: the positional
      // form failed when the second variant's UUID sorted first —
      // lines[0] was the 5-qty line, not the 10-qty line. The
      // service ordering is deliberate and deterministic; the test
      // was the bug, not the service.)
      const lineFor = (id: string) => first.lines.find((l) => l.variant_id === id);
      const line1 = lineFor(variantId);
      const line2 = lineFor(variant2Id);
      expect(line1?.quantity_ordered).toBe(10n);
      expect(line1?.quantity_received).toBe(0n);
      expect(line1?.cost_pence).toBe(400n);
      expect(line2?.quantity_ordered).toBe(5n);
      expect(line2?.quantity_received).toBe(0n);
      expect(line2?.cost_pence).toBe(600n);
      // A second PO numbers sequentially (D-15, same advisory-lock pattern as the suggestion conversion).
      const second = await svc.createPurchaseOrder(actor, {
        supplierId: supplier.id,
        warehouseId: tenant.warehouseId,
        lines: [{ variantId, quantityOrdered: 1n, unitCostPence: 400n }],
      });
      expect(second.purchaseOrder.po_number).toBe(2n);
      expect(second.purchaseOrder.expected_delivery_date).toBeNull();
      const listed = await svc.listPurchaseOrders(actor);
      expect(listed.map((view) => view.purchaseOrder.po_number)).toEqual([2n, 1n]);
    });
  });

  it('rejects unknown supplier/warehouse/variant (404), bad lines (400), and duplicate variants (400)', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const actor = actorFor(tenant, 'owner');
      const supplier = await svc.createSupplier(actor, { name: 'PO Wholesale' });
      const { variantId } = await seedVariant(db, tenant, 'PO-001');
      const base = {
        supplierId: supplier.id,
        warehouseId: tenant.warehouseId,
        lines: [{ variantId, quantityOrdered: 10n, unitCostPence: 400n }],
      };
      await expect(
        svc.createPurchaseOrder(actor, { ...base, supplierId: UNKNOWN_UUID }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        svc.createPurchaseOrder(actor, { ...base, warehouseId: UNKNOWN_UUID }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        svc.createPurchaseOrder(actor, {
          ...base,
          lines: [{ variantId: UNKNOWN_UUID, quantityOrdered: 10n, unitCostPence: 400n }],
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(svc.createPurchaseOrder(actor, { ...base, lines: [] })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        svc.createPurchaseOrder(actor, {
          ...base,
          lines: [{ variantId, quantityOrdered: 0n, unitCostPence: 400n }],
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        svc.createPurchaseOrder(actor, {
          ...base,
          lines: [{ variantId, quantityOrdered: 10n, unitCostPence: -1n }],
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        svc.createPurchaseOrder(actor, {
          ...base,
          lines: [
            { variantId, quantityOrdered: 10n, unitCostPence: 400n },
            { variantId, quantityOrdered: 5n, unitCostPence: 400n },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('controller: createPurchaseOrder returns the snake_case wire shape with the new columns', async () => {
    await withDb(async ({ db, tenant }) => {
      const svc = service(db);
      const controller = new PurchasingController(svc);
      const actor = actorFor(tenant, 'owner');
      const supplier = await svc.createSupplier(actor, { name: 'PO Wholesale' });
      const { variantId } = await seedVariant(db, tenant, 'PO-001');
      const result = await controller.createPurchaseOrder(
        { actor } as Parameters<PurchasingController['createPurchaseOrder']>[0],
        {
          supplierId: supplier.id,
          warehouseId: tenant.warehouseId,
          expectedDeliveryDate: '2026-12-01T00:00:00.000Z',
          lines: [{ variantId, quantityOrdered: '10', unitCostPence: '400' }],
        },
      );
      const po = result as Record<string, unknown>;
      expect(po.status).toBe('draft');
      expect(po.po_number).toBe('1');
      expect(po.warehouse_id).toBe(tenant.warehouseId);
      expect(po.expected_delivery_date).toBe('2026-12-01T00:00:00.000Z');
      expect(po.sent_at).toBeNull();
      const lines = po.lines as Array<Record<string, unknown>>;
      expect(lines).toHaveLength(1);
      expect(lines[0]?.quantity_ordered).toBe('10');
      expect(lines[0]?.cost_pence).toBe('400');
      await expect(
        controller.createPurchaseOrder(
          { actor } as Parameters<PurchasingController['createPurchaseOrder']>[0],
          {
            supplierId: supplier.id,
            warehouseId: tenant.warehouseId,
            expectedDeliveryDate: 'not-a-date',
            lines: [{ variantId, quantityOrdered: '10', unitCostPence: '400' }],
          },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
