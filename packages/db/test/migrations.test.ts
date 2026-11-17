/**
 * Migration and locking tests (Build-02, Objective 1) — verifies the
 * PGlite engine behaves like PostgreSQL for the things Build-02 depends
 * on:
 *  - all 19 migration files execute and create 89 tables;
 *    NOTE (Build-03): this list is shared by parallel Build-03 workers —
 *    whoever adds a migration MUST extend the list and the table count
 *    here (009/010 added by Objective 1, 011–013 by Objectives 2/4,
 *    014 by Build-05, 015 by Build-06 Objective 1 — 015 adds a column
 *    only, so the table count stays 89; 016 by Build-07 Objective 1 —
 *    016 adds columns only, so the table count stays 89; 017 by
 *    Build-10 Objective 2 — 017 adds a column only, so the table count
 *    stays 89; 018 by Build-11 Objective 2 — 018 adds columns and
 *    indexes only, so the table count stays 89; 019 by Build-12
 *    Objective 3 — 019 adds columns only, so the table count stays 89).
 *  - gen_random_uuid() works (core since PG 13 — no pgcrypto needed);
 *  - bigint money columns round-trip as JS bigint through Kysely
 *    (the local dialect converts int8 to bigint on read);
 *  - advisory locks work;
 *  - the G-A-13 outcome holds under serialised execution, with the row
 *    lock actually held (see the test's comment: true concurrent lock
 *    contention cannot be exercised on PGlite's single connection and
 *    must be re-verified against real PostgreSQL).
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDb, seedTenant, seedVariant, setStock } from '../src/index';

describe('migrations and locking', () => {
  it('runs all 19 migrations and creates 89 tables', async () => {
    const { db, close } = await createTestDb();
    try {
      const tables = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `.execute(db);
      const applied = await db.selectFrom('migrations').select('filename').execute();
      expect(applied.map((r) => r.filename)).toEqual([
        '001_tenancy.sql',
        '002_catalogue.sql',
        '003_inventory_ledger.sql',
        '004_sales_payments.sql',
        '005_sessions_zreports.sql',
        '006_audit_export_gdpr.sql',
        '007_phase2_crm_loyalty.sql',
        '008_phase2_promotions.sql',
        '009_order_line_units_and_warehouse.sql',
        '010_api_keys.sql',
        '011_webhook_events_dlq.sql',
        '012_refund_retry_fields.sql',
        '013_completed_order_return_transition.sql',
        '014_statutory_vat_archives_and_webhook_rotation.sql',
        '015_encrypted_retiring_webhook_secret.sql',
        '016_webhook_current_secret_encryption_and_keyring.sql',
        '017_supplier_variants_is_preferred.sql',
        '018_age_restriction_inheritance_and_verified_at.sql',
        '019_purchase_order_warehouse_and_expected_date.sql',
      ]);
      // 89 tables in total (the 89 CREATE TABLE statements across
      // migrations 001–014, including the `migrations` tracking table;
      // 009 adds columns only, 010 adds api_keys, 011–013 add the
      // webhook/DLQ, refund-retry and return-transition tables, 014
      // adds statutory_vat_archives, 015 adds a column only, 016 adds
      // columns only, 017 adds a column only, 018 adds columns and
      // indexes only, 019 adds columns only).
      expect(Number(tables.rows[0]?.count)).toBe(89);
    } finally {
      await close();
    }
  });

  it('migration 016 adds current_secret_ciphertext and encryption_key_id to webhook_endpoints', async () => {
    const { db, close } = await createTestDb();
    try {
      const columns = await sql<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'webhook_endpoints'
          AND column_name IN ('current_secret_ciphertext', 'encryption_key_id')
        ORDER BY column_name
      `.execute(db);
      expect(columns.rows).toHaveLength(2);
      const current = columns.rows.find((r) => r.column_name === 'current_secret_ciphertext');
      expect(current?.data_type).toBe('text');
      expect(current?.is_nullable).toBe('YES');
      const keyId = columns.rows.find((r) => r.column_name === 'encryption_key_id');
      expect(keyId?.data_type).toBe('text');
      expect(keyId?.is_nullable).toBe('NO');
      expect(keyId?.column_default).toContain('v1');
    } finally {
      await close();
    }
  });

  it('migration 019 adds warehouse_id and expected_delivery_date to purchase_orders', async () => {
    const { db, close } = await createTestDb();
    try {
      const columns = await sql<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'purchase_orders'
          AND column_name IN ('warehouse_id', 'expected_delivery_date')
        ORDER BY column_name
      `.execute(db);
      expect(columns.rows).toHaveLength(2);
      const warehouse = columns.rows.find((r) => r.column_name === 'warehouse_id');
      expect(warehouse?.data_type).toBe('uuid');
      expect(warehouse?.is_nullable).toBe('YES');
      const expected = columns.rows.find((r) => r.column_name === 'expected_delivery_date');
      expect(expected?.data_type).toBe('timestamp with time zone');
      expect(expected?.is_nullable).toBe('YES');
    } finally {
      await close();
    }
  });

  it('migration 015 adds a nullable previous_secret_ciphertext column to webhook_endpoints', async () => {
    const { db, close } = await createTestDb();
    try {
      const column = await sql<{ data_type: string; is_nullable: string }>`
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'webhook_endpoints'
          AND column_name = 'previous_secret_ciphertext'
      `.execute(db);
      expect(column.rows).toHaveLength(1);
      expect(column.rows[0]?.data_type).toBe('text');
      expect(column.rows[0]?.is_nullable).toBe('YES');
    } finally {
      await close();
    }
  });

  it('round-trips bigint money as JS bigint and generates uuids', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1234n, costPence: 567n });
      await setStock(db, tenant, variant.variantId, { quantity: 10n, costPence: 567n });
      const row = await db
        .selectFrom('product_variants')
        .select(['id', 'price_pence', 'cost_pence'])
        .where('id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(typeof row.price_pence).toBe('bigint');
      expect(row.price_pence).toBe(1234n);
      expect(typeof row.cost_pence).toBe('bigint');
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      const balance = await db
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(typeof balance.quantity_on_hand).toBe('bigint');
      expect(balance.quantity_on_hand).toBe(10n);
    } finally {
      await close();
    }
  });

  it('supports advisory locks', async () => {
    const { db, close } = await createTestDb();
    try {
      await db.transaction().execute(async (trx) => {
        const locked = await sql<{ locked: boolean }>`
          SELECT pg_try_advisory_xact_lock(12345) AS locked
        `.execute(trx);
        expect(locked.rows[0]?.locked).toBe(true);
      });
    } finally {
      await close();
    }
  });

  /**
   * G-A-13 outcome, under PGlite's serialised execution.
   *
   * PGlite runs on ONE connection: two Kysely transactions started with
   * Promise.all interleave on that connection, so their FOR UPDATE locks
   * do not block each other (both read quantity 1 and both sell — the
   * probe proved this). Two PGlite instances on one data directory do NOT
   * fix it either (their locks do not coordinate; a probe run sold the
   * last item twice). True concurrent lock contention therefore CANNOT be
   * exercised on PGlite and must be re-verified against real PostgreSQL.
   *
   * What this test proves instead: the lock → check → write sequence is
   * correct (the row lock IS held — see the pg_locks assertion), the
   * second sale fails cleanly after the first commits, and stock never
   * goes negative. The two sales run sequentially here because that is
   * the only execution PGlite can express honestly.
   */
  it('G-A-13 outcome: first sale succeeds, second fails cleanly, no negative stock', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 1n });

      const sellOne = async (): Promise<'sold' | 'out-of-stock'> =>
        db.transaction().execute(async (trx) => {
          const row = await trx
            .selectFrom('stock_balances')
            .selectAll()
            .where('variant_id', '=', variant.variantId)
            .where('warehouse_id', '=', tenant.warehouseId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          // The row lock is actually held by this transaction: a plain
          // SELECT takes AccessShareLock on the table, while SELECT ...
          // FOR UPDATE takes RowShareLock. (Tuple locks are lightweight
          // locks and do not appear in pg_locks.)
          const locks = await sql<{ held: string }>`
            SELECT COUNT(*)::text AS held FROM pg_locks
            WHERE locktype = 'relation' AND mode = 'RowShareLock'
              AND granted AND pid = pg_backend_pid()
          `.execute(trx);
          expect(Number(locks.rows[0]?.held)).toBeGreaterThan(0);
          if (row.quantity_on_hand < 1n) {
            return 'out-of-stock';
          }
          await trx
            .updateTable('stock_balances')
            .set({ quantity_on_hand: row.quantity_on_hand - 1n })
            .where('variant_id', '=', variant.variantId)
            .where('warehouse_id', '=', tenant.warehouseId)
            .execute();
          return 'sold';
        });

      expect(await sellOne()).toBe('sold');
      expect(await sellOne()).toBe('out-of-stock');
      const balance = await db
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(balance.quantity_on_hand).toBe(0n);
    } finally {
      await close();
    }
  });
});
