/**
 * Storage adapter tests (Build-04, Objective 1).
 *
 * The same suite runs against BOTH drivers — the in-memory driver
 * (used by all automated tests) and the node:sqlite driver (verified
 * working in this environment). If node:sqlite ever becomes
 * unavailable, the SQLite block fails loudly rather than being
 * silently skipped.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import { NodeSqliteStorageAdapter } from '../src/storage/sqlite-storage';
import type { CatalogCacheEntry, StorageAdapter } from '../src/storage/storage-adapter';

function catalogEntry(overrides: Partial<CatalogCacheEntry> = {}): CatalogCacheEntry {
  return {
    variantId: 'variant-1',
    sku: 'SKU-001',
    barcode: '5012345678900',
    name: 'Test Product',
    pricePence: 1000n,
    priceBookPricePence: null,
    taxRateKind: 'standard',
    taxRatePercent: '20.00',
    stockOnHand: 5n,
    stockComputedAt: '2026-11-13T10:00:00.000Z',
    requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

function runSuite(name: string, makeAdapter: () => StorageAdapter): void {
  describe(name, () => {
    it('upserts and reads the catalog cache by SKU and barcode', async () => {
      const storage = makeAdapter();
      try {
        await storage.upsertCatalog([catalogEntry()]);
        expect(await storage.findCatalogBySku('SKU-001')).toMatchObject({ name: 'Test Product' });
        expect(await storage.findCatalogByBarcode('5012345678900')).toMatchObject({ sku: 'SKU-001' });
        expect(await storage.findCatalogBySku('NOPE')).toBeUndefined();
        expect(await storage.listCatalog()).toHaveLength(1);

        // Upsert replaces the price; the row is not duplicated.
        await storage.upsertCatalog([catalogEntry({ pricePence: 1200n })]);
        expect(await storage.listCatalog()).toHaveLength(1);
        expect((await storage.findCatalogBySku('SKU-001'))?.pricePence).toBe(1200n);
      } finally {
        storage.close();
      }
    });

    it('round-trips requiresChallenge25 + minAge through the catalog cache (Build-08 Obj 2)', async () => {
      const storage = makeAdapter();
      try {
        await storage.upsertCatalog([
          catalogEntry({
            variantId: 'variant-age',
            sku: 'VAPE-1',
            requiresChallenge25: true,
            minAge: 18,
          }),
          catalogEntry({ variantId: 'variant-plain', sku: 'BREAD-1', name: 'Bread' }),
        ]);
        const restricted = await storage.findCatalogBySku('VAPE-1');
        expect(restricted?.requiresChallenge25).toBe(true);
        expect(restricted?.minAge).toBe(18);
        const plain = await storage.findCatalogBySku('BREAD-1');
        expect(plain?.requiresChallenge25).toBe(false);
        expect(plain?.minAge).toBeNull();
        // An upsert that lifts the restriction clears both fields.
        await storage.upsertCatalog([
          catalogEntry({
            variantId: 'variant-age',
            sku: 'VAPE-1',
            requiresChallenge25: false,
            minAge: null,
          }),
        ]);
        const lifted = await storage.findCatalogBySku('VAPE-1');
        expect(lifted?.requiresChallenge25).toBe(false);
        expect(lifted?.minAge).toBeNull();
      } finally {
        storage.close();
      }
    });

    it('enqueues offline cash orders FIFO and rejects a duplicate idempotency key', async () => {
      const storage = makeAdapter();
      try {
        const first = await storage.enqueueOrder({
          idempotencyKey: 'key-1',
          tenantId: 't1',
          locationId: 'l1',
          registerId: 'r1',
          orderPayloadJson: '{}',
          tenderTotalPence: 1000n,
          createdAt: '2026-11-13T10:00:00.000Z',
        });
        await storage.enqueueOrder({
          idempotencyKey: 'key-2',
          tenantId: 't1',
          locationId: 'l1',
          registerId: 'r1',
          orderPayloadJson: '{}',
          tenderTotalPence: 2000n,
          createdAt: '2026-11-13T10:01:00.000Z',
        });
        const queued = await storage.listQueuedOrders();
        expect(queued.map((row) => row.idempotencyKey)).toEqual(['key-1', 'key-2']);
        expect(first.syncStatus).toBe('queued');

        await expect(
          storage.enqueueOrder({
            idempotencyKey: 'key-1',
            tenantId: 't1',
            locationId: 'l1',
            registerId: 'r1',
            orderPayloadJson: '{}',
            tenderTotalPence: 1000n,
            createdAt: '2026-11-13T10:02:00.000Z',
          }),
        ).rejects.toThrow('Duplicate idempotency key');

        await storage.updateQueueStatus(first.localId, 'synced');
        expect((await storage.listQueuedOrders()).map((row) => row.idempotencyKey)).toEqual(['key-2']);
        expect((await storage.listAllQueue()).map((row) => row.syncStatus)).toEqual(['synced', 'queued']);
      } finally {
        storage.close();
      }
    });

    it('logs and lists the sync audit trail', async () => {
      const storage = makeAdapter();
      try {
        await storage.logSyncAudit('handshake', { serverTime: '2026-11-13T10:00:00.000Z' });
        await storage.logSyncAudit('conflict', { shortfall: '2' });
        const audit = await storage.listSyncAudit();
        expect(audit.map((entry) => entry.kind)).toEqual(['handshake', 'conflict']);
        expect(JSON.parse(audit[1]?.detailJson as string)).toEqual({ shortfall: '2' });
      } finally {
        storage.close();
      }
    });

    it('parks and resumes baskets without touching stock (park is a local draft only)', async () => {
      const storage = makeAdapter();
      try {
        const parked = await storage.parkBasket({
          tenantId: 't1',
          locationId: 'l1',
          registerId: 'r1',
          basketJson: '[{"sku":"SKU-001"}]',
          createdAt: '2026-11-13T10:00:00.000Z',
        });
        expect((await storage.listParkedBaskets())).toHaveLength(1);
        await storage.deleteParkedBasket(parked.localId);
        expect((await storage.listParkedBaskets())).toHaveLength(0);
      } finally {
        storage.close();
      }
    });

    it('rolls a transaction back on throw', async () => {
      const storage = makeAdapter();
      try {
        await expect(
          storage.transaction(async () => {
            await storage.upsertCatalog([catalogEntry()]);
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await storage.listCatalog()).toHaveLength(0);
      } finally {
        storage.close();
      }
    });
  });
}

runSuite('InMemoryStorageAdapter', () => new InMemoryStorageAdapter());
runSuite('NodeSqliteStorageAdapter', () => new NodeSqliteStorageAdapter(':memory:'));

/**
 * A device file created before Build-08 has a local_catalog_cache
 * WITHOUT min_age_years. Opening it with the new adapter must add
 * the column (not crash, not drop the table) and minAge must then
 * round-trip. Uses a real temp file — the ':memory:' driver cannot
 * simulate a pre-existing file.
 */
describe('NodeSqliteStorageAdapter — pre-Build-08 file upgrade', () => {
  it('adds min_age_years to an old-schema file and persists minAge afterwards', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ukpos-build08-upgrade-'));
    const file = join(dir, 'register.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      legacy.exec(
        `CREATE TABLE local_catalog_cache (
          variant_id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT,
          name TEXT NOT NULL, price_pence TEXT NOT NULL,
          price_book_price_pence TEXT, tax_rate_kind TEXT,
          tax_rate_percent TEXT, stock_on_hand TEXT,
          stock_computed_at TEXT,
          requires_challenge_25 INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        )`,
      );
      legacy
        .prepare(
          `INSERT INTO local_catalog_cache
            (variant_id, sku, barcode, name, price_pence, requires_challenge_25, updated_at)
           VALUES ('old-v-1', 'OLD-001', '5012345678900', 'Old Product', '1000', 1, '2026-11-01T10:00:00.000Z')`,
        )
        .run();
      legacy.close();

      const storage = new NodeSqliteStorageAdapter(file);
      try {
        // The pre-existing restricted row reads back with minAge null
        // (no column existed when it was written — never invented).
        const old = await storage.findCatalogBySku('OLD-001');
        expect(old?.requiresChallenge25).toBe(true);
        expect(old?.minAge).toBeNull();
        await storage.upsertCatalog([
          catalogEntry({
            variantId: 'old-v-1',
            sku: 'OLD-001',
            requiresChallenge25: true,
            minAge: 18,
          }),
        ]);
        expect((await storage.findCatalogBySku('OLD-001'))?.minAge).toBe(18);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
