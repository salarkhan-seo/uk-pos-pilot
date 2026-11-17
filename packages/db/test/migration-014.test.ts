/**
 * Migration 014 tests (Build-05).
 *
 * Proves, against the live PGlite engine with all migrations applied,
 * that migration 014 (not 011 — 011 already exists from Build-03)
 * lands correctly:
 *  - statutory_vat_archives exists with its columns, tenant_id
 *    carries NO foreign key (the archive survives hard deletion),
 *    and the immutability trigger blocks UPDATE always and DELETE
 *    while the retention window is open;
 *  - purge_expired_statutory_vat_archives() deletes ONLY rows whose
 *    retention has expired;
 *  - vat_periods gains closed_at / closed_by_user_id and
 *    webhook_endpoints gains previous_secret_hash /
 *    previous_secret_expires_at.
 *
 * One shared PGlite database for the file (migration application is
 * the slow part); each test uses its own tenant/archive rows.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createTestDb, seedTenant, type TestDatabase } from '../src/index';
import type { DB } from '../src/schema';

let tdb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
}, 120000);

afterAll(async () => {
  await tdb.close();
});

async function insertArchive(
  tenantId: string,
  overrides: { retentionUntil?: Date; archivedAt?: Date } = {},
): Promise<string> {
  const archivedAt = overrides.archivedAt ?? new Date('2026-11-13T12:00:00.000Z');
  const retentionUntil =
    overrides.retentionUntil ?? new Date('2032-11-13T12:00:00.000Z');
  const row = await db
    .insertInto('statutory_vat_archives')
    .values({
      tenant_id: tenantId,
      archived_at: archivedAt,
      retention_until: retentionUntil,
      archive_sha256: 'a'.repeat(64),
      row_counts_json: { orders: 1 },
      archive_payload_json: { tenant_id: tenantId },
      storage_bundle_path: '/tmp/test-bundle.json',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('migration 014 — statutory_vat_archives', () => {
  it('creates the table with an unconstrained tenant_id and the 014 columns on vat_periods / webhook_endpoints', async () => {
    const tenant = await seedTenant(db);
    const archiveId = await insertArchive(tenant.tenantId);
    const row = await db
      .selectFrom('statutory_vat_archives')
      .selectAll()
      .where('id', '=', archiveId)
      .executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(tenant.tenantId);
    expect(row.retention_until.getTime()).toBe(new Date('2032-11-13T12:00:00.000Z').getTime());
    expect(row.archive_sha256).toBe('a'.repeat(64));

    // tenant_id has no FK: an archive for a tenant id that does not
    // exist (e.g. after the tenant row was hard-deleted) inserts fine.
    const orphanId = await insertArchive('00000000-0000-0000-0000-000000000099');
    const orphan = await db
      .selectFrom('statutory_vat_archives')
      .select('id')
      .where('id', '=', orphanId)
      .executeTakeFirst();
    expect(orphan?.id).toBe(orphanId);

    // The 014 columns exist on the other two tables.
    const periodRow = await db
      .insertInto('vat_periods')
      .values({
        tenant_id: tenant.tenantId,
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        status: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const period = await db
      .selectFrom('vat_periods')
      .select(['closed_at', 'closed_by_user_id'])
      .where('id', '=', periodRow.id)
      .executeTakeFirstOrThrow();
    expect(period.closed_at).toBeNull();
    expect(period.closed_by_user_id).toBeNull();
    const endpointRow = await db
      .insertInto('webhook_endpoints')
      .values({
        tenant_id: tenant.tenantId,
        url: 'https://example.com/hooks',
        secret_hash: 'd'.repeat(64),
        event_types: ['order.completed'],
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const endpoint = await db
      .selectFrom('webhook_endpoints')
      .select(['previous_secret_hash', 'previous_secret_expires_at'])
      .where('id', '=', endpointRow.id)
      .executeTakeFirstOrThrow();
    expect(endpoint.previous_secret_hash).toBeNull();
    expect(endpoint.previous_secret_expires_at).toBeNull();
  });

  it('immutability trigger blocks UPDATE and DELETE inside the retention window', async () => {
    const tenant = await seedTenant(db);
    const archiveId = await insertArchive(tenant.tenantId);
    await expect(
      db
        .updateTable('statutory_vat_archives')
        .set({ archive_sha256: 'b'.repeat(64) })
        .where('id', '=', archiveId)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.deleteFrom('statutory_vat_archives').where('id', '=', archiveId).execute(),
    ).rejects.toThrow(/retention window/);
    // The row is still there.
    const row = await db
      .selectFrom('statutory_vat_archives')
      .select('id')
      .where('id', '=', archiveId)
      .executeTakeFirst();
    expect(row?.id).toBe(archiveId);
  });

  it('purge function deletes only expired archives, and UPDATE stays blocked even after expiry', async () => {
    const tenant = await seedTenant(db);
    const liveId = await insertArchive(tenant.tenantId);
    const expiredId = await insertArchive(tenant.tenantId, {
      archivedAt: new Date('2019-11-13T12:00:00.000Z'),
      retentionUntil: new Date('2025-11-13T12:00:00.000Z'),
    });
    const purged = await sql<{ id: string }>`
      SELECT * FROM purge_expired_statutory_vat_archives()
    `.execute(db);
    expect(purged.rows.map((r) => r.id)).toContain(expiredId);
    expect(purged.rows.map((r) => r.id)).not.toContain(liveId);
    const gone = await db
      .selectFrom('statutory_vat_archives')
      .select('id')
      .where('id', '=', expiredId)
      .executeTakeFirst();
    expect(gone).toBeUndefined();
    const kept = await db
      .selectFrom('statutory_vat_archives')
      .select('id')
      .where('id', '=', liveId)
      .executeTakeFirst();
    expect(kept?.id).toBe(liveId);

    // Even an expired row cannot be UPDATEd — only the purge deletes.
    const expired2 = await insertArchive(tenant.tenantId, {
      archivedAt: new Date('2019-11-13T12:00:00.000Z'),
      retentionUntil: new Date('2025-11-13T12:00:00.000Z'),
    });
    await expect(
      db
        .updateTable('statutory_vat_archives')
        .set({ archive_sha256: 'c'.repeat(64) })
        .where('id', '=', expired2)
        .execute(),
    ).rejects.toThrow(/immutable/);
    // ...but a direct DELETE of an expired row is permitted by the trigger.
    await db.deleteFrom('statutory_vat_archives').where('id', '=', expired2).execute();
    const gone2 = await db
      .selectFrom('statutory_vat_archives')
      .select('id')
      .where('id', '=', expired2)
      .executeTakeFirst();
    expect(gone2).toBeUndefined();
  });
});
