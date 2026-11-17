/**
 * Build-03 Objective 1 — migrations 009 and 010.
 *
 * 009 adds warehouse_id / unit_id / quantity_in_base_units to
 * order_lines (nullable: a DB default cannot look up the default
 * warehouse or the base unit — the application defaults them, see
 * InventoryService.decrementStockForOrder).
 * 010 creates api_keys (SHA-256 hash only, first-8-chars prefix,
 * scopes, active/rotating/revoked with a rotation grace period).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestDb, seedTenant, seedVariant } from '../src/index';

describe('migration 009 — order_lines units and warehouse', () => {
  it('adds the three columns, nullable, with FK enforcement', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant);

      const order = await db
        .insertInto('orders')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          register_id: tenant.registerId,
          order_number: 1n,
          business_date: '2026-11-13',
          status: 'draft',
          subtotal_pence: 12000n,
          discount_pence: 0n,
          tax_pence: 2000n,
          total_pence: 12000n,
          created_by_user_id: tenant.users.manager.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Pre-009 style insert (columns omitted) still works — NULLs.
      const legacyLine = await db
        .insertInto('order_lines')
        .values({
          tenant_id: tenant.tenantId,
          order_id: order.id,
          variant_id: variant.variantId,
          quantity: 2n,
          unit_price_pence: 1000n,
          base_price_pence: 1000n,
          price_book_id: null,
          price_book_price_pence: null,
          promotion_discount_pence: 0n,
          manual_discount_pence: 0n,
          final_price_pence: 1000n,
          tax_rate_kind: 'standard',
          tax_rate_percent: '20.00',
          tax_amount_pence: 333n,
          line_total_pence: 2000n,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(legacyLine.warehouse_id).toBeNull();
      expect(legacyLine.unit_id).toBeNull();
      expect(legacyLine.quantity_in_base_units).toBeNull();

      // New-style insert with all three columns.
      const stamped = await db
        .insertInto('order_lines')
        .values({
          tenant_id: tenant.tenantId,
          order_id: order.id,
          variant_id: variant.variantId,
          quantity: 2n,
          warehouse_id: tenant.warehouseId,
          unit_id: null,
          quantity_in_base_units: 24n,
          unit_price_pence: 1000n,
          base_price_pence: 1000n,
          price_book_id: null,
          price_book_price_pence: null,
          promotion_discount_pence: 0n,
          manual_discount_pence: 0n,
          final_price_pence: 1000n,
          tax_rate_kind: 'standard',
          tax_rate_percent: '20.00',
          tax_amount_pence: 333n,
          line_total_pence: 2000n,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(stamped.warehouse_id).toBe(tenant.warehouseId);
      expect(stamped.quantity_in_base_units).toBe(24n);

      // FK enforcement: an unknown warehouse is rejected.
      await expect(
        db
          .insertInto('order_lines')
          .values({
            tenant_id: tenant.tenantId,
            order_id: order.id,
            variant_id: variant.variantId,
            quantity: 1n,
            warehouse_id: '00000000-0000-0000-0000-000000000000',
            unit_id: null,
            quantity_in_base_units: 1n,
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
          .execute(),
      ).rejects.toThrow();

      // CHECK enforcement: a zero base-unit quantity is rejected.
      await expect(
        db
          .updateTable('order_lines')
          .set({ quantity_in_base_units: 0n })
          .where('id', '=', stamped.id)
          .execute(),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});

describe('migration 010 — api_keys', () => {
  it('creates the table with the specified columns, checks and uniqueness', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const key = 'ukp_testkeymaterial0123456789abcdef';
      const hash = createHash('sha256').update(key).digest('hex');

      const row = await db
        .insertInto('api_keys')
        .values({
          tenant_id: tenant.tenantId,
          key_hash: hash,
          key_prefix: key.slice(0, 8),
          name: 'Stock script',
          scopes: ['stock:read', 'stock:write'],
          status: 'active',
          last_used_at: null,
          expires_at: null,
          grace_until: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(row.key_prefix).toBe('ukp_test');
      expect(row.scopes).toEqual(['stock:read', 'stock:write']);
      expect(row.status).toBe('active');
      expect(row.last_used_at).toBeNull();

      // key_hash is UNIQUE: the same key cannot be stored twice.
      await expect(
        db
          .insertInto('api_keys')
          .values({
            tenant_id: tenant.tenantId,
            key_hash: hash,
            key_prefix: key.slice(0, 8),
            name: 'Duplicate',
            scopes: ['catalogue:read'],
            status: 'active',
            last_used_at: null,
            expires_at: null,
            grace_until: null,
          })
          .execute(),
      ).rejects.toThrow();

      // Status CHECK rejects anything outside active/rotating/revoked.
      await expect(
        db
          .insertInto('api_keys')
          .values({
            tenant_id: tenant.tenantId,
            key_hash: createHash('sha256').update('another-key').digest('hex'),
            key_prefix: 'another-',
            name: 'Bad status',
            scopes: [],
            status: 'suspended',
            last_used_at: null,
            expires_at: null,
            grace_until: null,
          })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
