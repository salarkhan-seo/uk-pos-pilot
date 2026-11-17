/**
 * Demo seeder tests (Build-08, Objective 3).
 *
 * Proves seedDemo is IDEMPOTENT — seeding twice creates no duplicates —
 * and that the seeded data is exactly the documented demo (tenant,
 * location, warehouse, register, four users with the documented PINs,
 * four UK tax rates, four catalogue items incl. the Challenge 25 vape
 * and the case-breakdown coffee, initial stock, one open session, and
 * the demo API key with the `admin` scope).
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { verifyPin } from '@uk-pos/shared-kernel';
import {
  createTestDb,
  seedDemo,
  DEMO_ADMIN_ID,
  DEMO_API_KEY,
  DEMO_API_KEY_ID,
  DEMO_CASHIER_ID,
  DEMO_CASHIER_PIN,
  DEMO_LOCATION_ID,
  DEMO_MANAGER_ID,
  DEMO_MANAGER_PIN,
  DEMO_OWNER_ID,
  DEMO_OWNER_PIN,
  DEMO_REGISTER_ID,
  DEMO_TAX_EXEMPT_ID,
  DEMO_TAX_REDUCED_ID,
  DEMO_TAX_STANDARD_ID,
  DEMO_TAX_ZERO_ID,
  DEMO_TENANT_ID,
  DEMO_VARIANT_COFFEE_ID,
  DEMO_VARIANT_GADGET_ID,
  DEMO_VARIANT_VAPE_ID,
  DEMO_VARIANT_WIDGET_ID,
  DEMO_WAREHOUSE_ID,
} from '../src/index';

async function countAll(db: Awaited<ReturnType<typeof createTestDb>>['db'], table: string): Promise<number> {
  const row = await sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM ${sql.table(table)}`.execute(db);
  return Number(row.rows[0]?.count ?? 0);
}

describe('seedDemo (Build-08 Objective 3)', () => {
  it('seeds the full demo and is idempotent: a second run creates no duplicates', async () => {
    const { db, close } = await createTestDb();
    try {
      const first = await seedDemo(db);
      expect(first.tenantId).toBe(DEMO_TENANT_ID);
      expect(first.locationId).toBe(DEMO_LOCATION_ID);
      expect(first.warehouseId).toBe(DEMO_WAREHOUSE_ID);
      expect(first.registerId).toBe(DEMO_REGISTER_ID);
      expect(first.apiKey).toBe(DEMO_API_KEY);
      expect(first.userIds).toEqual({
        owner: DEMO_OWNER_ID,
        admin: DEMO_ADMIN_ID,
        manager: DEMO_MANAGER_ID,
        cashier: DEMO_CASHIER_ID,
      });

      const countsAfterFirst: Record<string, number> = {};
      for (const table of [
        'tenants', 'locations', 'warehouses', 'registers', 'roles', 'role_permissions',
        'users', 'user_roles', 'user_locations', 'tax_rates', 'units_of_measure',
        'products', 'product_variants', 'age_restrictions', 'variant_units',
        'stock_movements', 'stock_balances', 'stock_valuation', 'api_keys',
        'register_sessions',
      ]) {
        countsAfterFirst[table] = await countAll(db, table);
      }
      expect(countsAfterFirst).toEqual({
        tenants: 1,
        locations: 1,
        warehouses: 1,
        registers: 1,
        roles: 4,
        role_permissions: 18,
        users: 4,
        user_roles: 4,
        user_locations: 4,
        tax_rates: 4,
        units_of_measure: 2,
        products: 4,
        product_variants: 4,
        age_restrictions: 1,
        variant_units: 2,
        stock_movements: 4,
        stock_balances: 4,
        stock_valuation: 4,
        api_keys: 1,
        register_sessions: 1,
      });

      // Second run: same result, same counts — nothing duplicated.
      const second = await seedDemo(db);
      expect(second.tenantId).toBe(DEMO_TENANT_ID);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.apiKey).toBe(DEMO_API_KEY);
      for (const [table, count] of Object.entries(countsAfterFirst)) {
        expect(await countAll(db, table), `row count for ${table} after second seed`).toBe(count);
      }

      // --- Contents: tax rates ---
      const rates = await db
        .selectFrom('tax_rates')
        .select(['id', 'name', 'kind', 'rate_percent'])
        .where('tenant_id', '=', DEMO_TENANT_ID)
        .orderBy('rate_percent', 'desc')
        .execute();
      expect(rates).toEqual([
        { id: DEMO_TAX_STANDARD_ID, name: 'Standard 20%', kind: 'standard', rate_percent: '20.00' },
        { id: DEMO_TAX_REDUCED_ID, name: 'Reduced 5%', kind: 'reduced', rate_percent: '5.00' },
        { id: DEMO_TAX_ZERO_ID, name: 'Zero-rated 0%', kind: 'zero', rate_percent: '0.00' },
        { id: DEMO_TAX_EXEMPT_ID, name: 'Exempt', kind: 'exempt', rate_percent: '0.00' },
      ]);

      // --- Contents: catalogue ---
      const variants = await db
        .selectFrom('product_variants')
        .select(['id', 'sku', 'barcode', 'price_pence', 'tax_rate_id'])
        .where('tenant_id', '=', DEMO_TENANT_ID)
        .orderBy('sku')
        .execute();
      expect(variants).toEqual([
        { id: DEMO_VARIANT_COFFEE_ID, sku: 'DEMO-COFFEE-CASE', barcode: '5012345678903', price_pence: 2400n, tax_rate_id: DEMO_TAX_STANDARD_ID },
        { id: DEMO_VARIANT_GADGET_ID, sku: 'DEMO-GADGET-1', barcode: '5012345678901', price_pence: 1050n, tax_rate_id: DEMO_TAX_REDUCED_ID },
        { id: DEMO_VARIANT_VAPE_ID, sku: 'DEMO-VAPE-1', barcode: '5012345678902', price_pence: 800n, tax_rate_id: DEMO_TAX_STANDARD_ID },
        { id: DEMO_VARIANT_WIDGET_ID, sku: 'DEMO-WIDGET-1', barcode: '5012345678900', price_pence: 1200n, tax_rate_id: DEMO_TAX_STANDARD_ID },
      ]);

      // --- Contents: Challenge 25 restriction on the vape only ---
      const restrictions = await db.selectFrom('age_restrictions').selectAll().execute();
      expect(restrictions).toHaveLength(1);
      expect(restrictions[0]).toMatchObject({
        tenant_id: DEMO_TENANT_ID,
        variant_id: DEMO_VARIANT_VAPE_ID,
        min_age_years: 18,
        challenge_25: true,
      });

      // --- Contents: case breakdown (case = 12 each) on the coffee ---
      const units = await db
        .selectFrom('variant_units')
        .select(['variant_id', 'unit_id', 'conversion_factor', 'is_base'])
        .where('variant_id', '=', DEMO_VARIANT_COFFEE_ID)
        .orderBy('conversion_factor')
        .execute();
      expect(units).toHaveLength(2);
      expect(units[0]).toMatchObject({ conversion_factor: '1.0000', is_base: true });
      expect(units[1]).toMatchObject({ conversion_factor: '12.0000', is_base: false });

      // --- Contents: stock (25 / 12 / 40 / 10 cases) ---
      const balances = await db
        .selectFrom('stock_balances')
        .select(['variant_id', 'quantity_on_hand'])
        .orderBy('variant_id')
        .execute();
      expect(new Map(balances.map((b) => [b.variant_id, b.quantity_on_hand]))).toEqual(
        new Map([
          [DEMO_VARIANT_WIDGET_ID, 25n],
          [DEMO_VARIANT_GADGET_ID, 12n],
          [DEMO_VARIANT_VAPE_ID, 40n],
          [DEMO_VARIANT_COFFEE_ID, 10n],
        ]),
      );

      // --- Contents: one open session, float £50.00, opened by manager ---
      const sessions = await db.selectFrom('register_sessions').selectAll().execute();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: first.sessionId,
        tenant_id: DEMO_TENANT_ID,
        register_id: DEMO_REGISTER_ID,
        opened_by_user_id: DEMO_MANAGER_ID,
        float_pence: 5000n,
        status: 'open',
      });

      // --- Contents: demo API key (hash only stored) + documented PINs ---
      const keys = await db.selectFrom('api_keys').selectAll().execute();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({
        id: DEMO_API_KEY_ID,
        tenant_id: DEMO_TENANT_ID,
        key_hash: createHash('sha256').update(DEMO_API_KEY).digest('hex'),
        key_prefix: DEMO_API_KEY.slice(0, 8),
        name: 'Demo key (DEMO_SEED_ON_BOOT)',
        status: 'active',
      });
      expect(keys[0]?.scopes).toEqual(['admin']);

      const users = await db
        .selectFrom('users')
        .select(['id', 'pin_hash'])
        .where('tenant_id', '=', DEMO_TENANT_ID)
        .execute();
      const pinById = new Map(users.map((u) => [u.id, u.pin_hash as string]));
      expect(verifyPin(DEMO_MANAGER_PIN, pinById.get(DEMO_MANAGER_ID) as string)).toBe(true);
      expect(verifyPin(DEMO_CASHIER_PIN, pinById.get(DEMO_CASHIER_ID) as string)).toBe(true);
      expect(verifyPin(DEMO_OWNER_PIN, pinById.get(DEMO_OWNER_ID) as string)).toBe(true);
      expect(verifyPin('0000', pinById.get(DEMO_MANAGER_ID) as string)).toBe(false);
    } finally {
      await close();
    }
  }, 120_000);

  it('re-seeding after the demo session was closed opens a fresh session without duplicating anything', async () => {
    const { db, close } = await createTestDb();
    try {
      const first = await seedDemo(db);
      await db
        .updateTable('register_sessions')
        .set({ status: 'closed', closed_at: new Date() })
        .where('id', '=', first.sessionId)
        .execute();
      const second = await seedDemo(db);
      expect(second.sessionId).not.toBe(first.sessionId);
      const sessions = await db.selectFrom('register_sessions').select(['id', 'status']).execute();
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.status === 'open')).toHaveLength(1);
      expect(await countAll(db, 'tenants')).toBe(1);
      expect(await countAll(db, 'stock_movements')).toBe(4);
    } finally {
      await close();
    }
  }, 120_000);
});
