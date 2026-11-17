/**
 * Sync service tests (Build-04, Objective 1).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant. PGlite runs on a single connection, so no Promise.all
 * concurrency anywhere in this file.
 *
 * Money notes: seedVariant defaults to 1000p at the standard 20% rate
 * (tax-inclusive). A 1-unit offline order snapshots at 1000p total.
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { NotFoundException } from '@nestjs/common';
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
import { SalesService } from '../../src/modules/sales/sales.service';
import { SyncService } from '../../src/modules/sync/sync.service';
import type { FlushOrder } from '../../src/modules/sync/sync.dto';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant, role: 'owner' | 'admin' | 'manager' | 'cashier' = 'manager'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

function makeSync(db: Kysely<DB>): { sync: SyncService; catalogue: CatalogueService } {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  const sync = new SyncService(db, sales, catalogue, audit);
  return { sync, catalogue };
}

function offlineOrder(
  tenant: SeededTenant,
  input: { key: string; variantId: string; quantity: bigint; unitPricePence: bigint },
): FlushOrder {
  const lineTotal = input.quantity * input.unitPricePence;
  return {
    idempotencyKey: input.key,
    locationId: tenant.locationId,
    registerId: tenant.registerId,
    customerId: null,
    tenderTotalPence: lineTotal.toString(),
    createdAt: new Date().toISOString(),
    lines: [
      {
        variantId: input.variantId,
        quantity: input.quantity.toString(),
        snapshotUnitPricePence: input.unitPricePence.toString(),
        snapshotLineTotalPence: lineTotal.toString(),
      },
    ],
  };
}

describe('SyncService — handshake', () => {
  it('returns server time, tenant/register state and a full catalogue snapshot', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      const res = await sync.handshake(actor, { registerId: tenant.registerId });

      expect(res.tenantId).toBe(tenant.tenantId);
      expect(res.tenantStatus).toBe('active');
      expect(res.registerId).toBe(tenant.registerId);
      expect(res.registerName).toBe('TILL-01');
      expect(res.registerStatus).toBe('active');
      expect(res.locationId).toBe(tenant.locationId);
      expect(new Date(res.serverTime).getTime()).toBeLessThanOrEqual(Date.now() + 5000);
      expect(res.catalogue.fullSnapshot).toBe(true);
      expect(res.catalogue.variants).toHaveLength(1);
      expect(res.catalogue.variants[0]?.sku).toBe(variant.sku);
      expect(res.catalogue.variants[0]?.pricePence).toBe('1000');
      expect(res.catalogue.taxRates).toHaveLength(4);
      expect(res.catalogue.barcodeMode).toBeNull();
    } finally {
      await close();
    }
  });

  it('carries requiresChallenge25 + minAge on every variant: true/18 with a row, false/null without (Build-08 Obj 2)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const plain = await seedVariant(db, tenant, { sku: 'PLAIN-001', pricePence: 1000n });
      const restricted = await seedVariant(db, tenant, {
        sku: 'C25-001',
        barcode: '5012345678903',
        name: 'Challenge 25 Vape Liquid',
        pricePence: 800n,
      });
      await db
        .insertInto('age_restrictions')
        .values({
          tenant_id: tenant.tenantId,
          variant_id: restricted.variantId,
          min_age_years: 18,
          challenge_25: true,
        })
        .execute();
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      const res = await sync.handshake(actor, { registerId: tenant.registerId });

      expect(res.catalogue.variants).toHaveLength(2);
      const bySku = new Map(res.catalogue.variants.map((v) => [v.sku, v]));
      const plainDelta = bySku.get(plain.sku);
      expect(plainDelta?.requiresChallenge25, 'no age row → false, never omitted').toBe(false);
      expect(plainDelta?.minAge, 'no age row → null, never omitted').toBeNull();
      const restrictedDelta = bySku.get(restricted.sku);
      expect(restrictedDelta?.requiresChallenge25).toBe(true);
      expect(restrictedDelta?.minAge).toBe(18);
    } finally {
      await close();
    }
  });

  it('returns only variants changed since `since` on a delta handshake', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      const { sync, catalogue } = makeSync(db);
      const actor = actorFor(tenant);

      const before = new Date().toISOString();
      // Price changes require an admin/owner actor (CatalogueService rule).
      await catalogue.updateVariantPrice(actorFor(tenant, 'admin'), variant.variantId, 1200n);
      // NOTE: updateVariantPrice sets price_pence only — it does NOT
      // stamp updated_at (pre-existing Build-02 behaviour, flagged as a
      // follow-up: a register relying on the delta could miss a price
      // change until that is fixed). The test stamps the row directly
      // to exercise the delta filter itself.
      await db
        .updateTable('product_variants')
        .set({ updated_at: new Date() })
        .where('id', '=', variant.variantId)
        .execute();

      const delta = await sync.handshake(actor, { registerId: tenant.registerId, since: before });
      expect(delta.catalogue.fullSnapshot).toBe(false);
      expect(delta.catalogue.variants).toHaveLength(1);
      expect(delta.catalogue.variants[0]?.pricePence).toBe('1200');

      const empty = await sync.handshake(actor, {
        registerId: tenant.registerId,
        since: new Date().toISOString(),
      });
      expect(empty.catalogue.variants).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('reports a register from another tenant as not found (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      await expect(
        sync.handshake(actor, { registerId: other.registerId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('SyncService — flush', () => {
  it('replays a queued offline cash order to a completed order with receipt and stock decrement', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      const order = offlineOrder(tenant, { key: 'key-happy-1', variantId: variant.variantId, quantity: 2n, unitPricePence: 1000n });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });

      expect(res.outcomes).toHaveLength(1);
      const outcome = res.outcomes[0];
      expect(outcome?.status).toBe('synced');
      expect(outcome?.orderId).not.toBeNull();
      expect(outcome?.receiptNumber).not.toBeNull();
      expect(outcome?.orderTotalPence).toBe('2000');
      expect(outcome?.warnings).toHaveLength(0);
      expect(outcome?.error).toBeNull();

      const completed = await db
        .selectFrom('orders')
        .select(['status', 'total_pence'])
        .where('id', '=', outcome?.orderId as string)
        .executeTakeFirstOrThrow();
      expect(completed.status).toBe('completed');
      expect(completed.total_pence).toBe(2000n);

      const balance = await db
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(balance.quantity_on_hand).toBe(3n);
    } finally {
      await close();
    }
  });

  it('honors the snapshot price when the server price rose while offline (basket-discount bridge + warning)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { sync, catalogue } = makeSync(db);
      const actor = actorFor(tenant);

      // Price rises to 1500p while the register is offline; the customer paid 1000p.
      // (Price changes require an admin/owner actor.)
      await catalogue.updateVariantPrice(actorFor(tenant, 'admin'), variant.variantId, 1500n);

      const order = offlineOrder(tenant, { key: 'key-price-rise', variantId: variant.variantId, quantity: 1n, unitPricePence: 1000n });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });

      const outcome = res.outcomes[0];
      expect(outcome?.status).toBe('synced');
      expect(outcome?.orderTotalPence).toBe('1000');
      expect(outcome?.warnings.some((w) => w.includes('snapshot price honored'))).toBe(true);

      const completed = await db
        .selectFrom('orders')
        .select(['status', 'total_pence', 'discount_pence'])
        .where('id', '=', outcome?.orderId as string)
        .executeTakeFirstOrThrow();
      expect(completed.status).toBe('completed');
      expect(completed.total_pence).toBe(1000n);
      expect(completed.discount_pence).toBe(500n);
    } finally {
      await close();
    }
  });

  it('records a cash-overpayment warning when the server price fell while offline', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { sync, catalogue } = makeSync(db);
      const actor = actorFor(tenant);

      await catalogue.updateVariantPrice(actorFor(tenant, 'admin'), variant.variantId, 500n);

      const order = offlineOrder(tenant, { key: 'key-price-fall', variantId: variant.variantId, quantity: 1n, unitPricePence: 1000n });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });

      const outcome = res.outcomes[0];
      expect(outcome?.status).toBe('synced');
      expect(outcome?.orderTotalPence).toBe('500');
      expect(outcome?.warnings.some((w) => w.includes('overpayment'))).toBe(true);
    } finally {
      await close();
    }
  });

  it('accepts the completed cash sale on stock shortfall with an offline_sync_conflict movement + audit alert', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 1n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      // Customer physically paid for 3 units; only 1 was on hand.
      const order = offlineOrder(tenant, { key: 'key-shortfall', variantId: variant.variantId, quantity: 3n, unitPricePence: 1000n });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });

      const outcome = res.outcomes[0];
      expect(outcome?.status).toBe('conflict');
      expect(outcome?.orderId).not.toBeNull();
      expect(outcome?.conflict).toHaveLength(1);
      expect(outcome?.conflict?.[0]).toMatchObject({ requested: '3', available: '1', shortfall: '2' });
      expect(outcome?.warnings.some((w) => w.includes('offline_sync_conflict'))).toBe(true);

      // The order COMPLETED — the cash sale is never voided or dropped.
      const completed = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', outcome?.orderId as string)
        .executeTakeFirstOrThrow();
      expect(completed.status).toBe('completed');

      const movements = await db
        .selectFrom('stock_movements')
        .select(['cause', 'quantity_change'])
        .where('order_id', '=', outcome?.orderId as string)
        .orderBy('created_at', 'asc')
        .execute();
      expect(movements).toContainEqual({ cause: 'sale', quantity_change: -1n });
      expect(movements).toContainEqual({ cause: 'offline_sync_conflict', quantity_change: -2n });

      const balance = await db
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(balance.quantity_on_hand).toBe(0n);

      const alert = await db
        .selectFrom('audit_events')
        .select('event_type')
        .where('tenant_id', '=', tenant.tenantId)
        .where('event_type', '=', 'sync.offline_stock_conflict')
        .where('entity_id', '=', outcome?.orderId as string)
        .executeTakeFirst();
      expect(alert).toBeDefined();
    } finally {
      await close();
    }
  });

  it('replays an already-flushed idempotency key instead of creating a second order', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      const order = offlineOrder(tenant, { key: 'key-replay', variantId: variant.variantId, quantity: 1n, unitPricePence: 1000n });
      const first = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });
      expect(first.outcomes[0]?.status).toBe('synced');

      const second = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });
      expect(second.outcomes[0]?.status).toBe('replayed');
      expect(second.outcomes[0]?.orderId).toBe(first.outcomes[0]?.orderId);

      const count = await db
        .selectFrom('orders')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(count).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('processes FIFO in queue order and keeps going after a failed order', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 10n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      const first = offlineOrder(tenant, { key: 'key-fifo-1', variantId: variant.variantId, quantity: 1n, unitPricePence: 1000n });
      const broken = offlineOrder(tenant, { key: 'key-fifo-2', variantId: '00000000-0000-0000-0000-000000000000', quantity: 1n, unitPricePence: 1000n });
      const third = offlineOrder(tenant, { key: 'key-fifo-3', variantId: variant.variantId, quantity: 1n, unitPricePence: 1000n });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [first, broken, third] });

      expect(res.outcomes.map((o) => o.status)).toEqual(['synced', 'failed', 'synced']);
      expect(res.outcomes[1]?.error).toContain('Resource not found');

      // Order numbers follow the queue order: first order is #1, third is #2.
      const orders = await db
        .selectFrom('orders')
        .select(['order_number'])
        .where('tenant_id', '=', tenant.tenantId)
        .orderBy('order_number', 'asc')
        .execute();
      expect(orders.map((o) => o.order_number)).toEqual([1n, 2n]);
    } finally {
      await close();
    }
  });

  it('fails an order whose location does not match the register location, without creating it', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);

      const order = offlineOrder(tenant, { key: 'key-wrong-loc', variantId: variant.variantId, quantity: 1n, unitPricePence: 1000n });
      order.locationId = '00000000-0000-0000-0000-000000000000';
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });

      expect(res.outcomes[0]?.status).toBe('failed');
      const count = await db.selectFrom('orders').select('id').where('tenant_id', '=', tenant.tenantId).execute();
      expect(count).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
