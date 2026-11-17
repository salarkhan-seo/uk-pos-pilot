/**
 * Master key-ID rotation tests (Build-07, Objective 2).
 *
 * Proves `Aes256GcmSqliteCipher.reEncryptAllRecords` and the
 * adapter-level rotation on BOTH drivers (NodeSqlite +
 * InMemory):
 *  (a) every stored envelope moves to the new key id, old-key rows
 *      still decrypt while the old key is retained, and reads return
 *      identical plaintext after rotation;
 *  (b) a tampered row aborts the whole rotation (no partial rewrite)
 *      and the old data stays readable;
 *  (c) after rotation, a cipher that dropped the old key can no
 *      longer read the rows (unknown key id, not tampering).
 *
 * All secrets below are test-only values, never production secrets.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import {
  Aes256GcmSqliteCipher,
  LOCAL_STORAGE_TAMPERED,
  LOCAL_STORAGE_UNKNOWN_KEY_ID,
  LocalStorageTamperedError,
  LocalStorageUnknownKeyError,
} from '../src/storage/sqlite-cipher';
import { NodeSqliteStorageAdapter } from '../src/storage/sqlite-storage';
import type { CatalogCacheEntry } from '../src/storage/storage-adapter';

const TEST_SECRET = 'test-only-device-secret-do-not-use-in-production';
const OTHER_SECRET = 'test-only-other-secret-do-not-use-in-production';
const THIRD_SECRET = 'test-only-third-secret-do-not-use-in-production';

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'register-app-reenc-'));
  return { dir, file: join(dir, 'register.db') };
}

function catalogEntry(overrides: Partial<CatalogCacheEntry> = {}): CatalogCacheEntry {
  return {
    variantId: 'variant-1',
    sku: 'SKU-001',
    barcode: '5012345678900',
    name: 'Secret Product Name',
    pricePence: 1234n,
    priceBookPricePence: 999n,
    taxRateKind: 'standard',
    taxRatePercent: '20.00',
    stockOnHand: 7n,
    stockComputedAt: '2026-11-13T10:00:00.000Z',
    requiresChallenge25: true,
    minAge: 18,
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

function flipEnvelopeByte(envelope: string, index: number): string {
  const parts = envelope.split(':');
  const payload = Buffer.from(parts[2] as string, 'base64');
  payload[index] = (payload[index] as number) ^ 0xff;
  return `${parts[0]}:${parts[1]}:${payload.toString('base64')}`;
}

describe('Aes256GcmSqliteCipher.reEncryptAllRecords', () => {
  it('re-encrypts a batch to the new key id, keeping the old key retained', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const records = ['first secret', 'second secret', ''].map((text) => cipher.encrypt(text));
    expect(records.every((r) => r.startsWith('v1:k1:'))).toBe(true);

    const { cipher: rotated, records: reEncrypted } = cipher.reEncryptAllRecords(
      records,
      'k2',
      OTHER_SECRET,
    );
    expect(rotated.currentKeyId).toBe('k2');
    expect(rotated.keyIds).toEqual(expect.arrayContaining(['k1', 'k2']));
    expect(reEncrypted).toHaveLength(3);
    expect(reEncrypted.every((r) => r.startsWith('v1:k2:'))).toBe(true);
    expect(reEncrypted.map((r) => rotated.decrypt(r))).toEqual([
      'first secret',
      'second secret',
      '',
    ]);
    // Old records still decrypt through the rotated cipher (retained key).
    expect(records.map((r) => rotated.decrypt(r))).toEqual(['first secret', 'second secret', '']);
    // The original cipher instance is unchanged and cannot read k2 rows.
    expect(cipher.currentKeyId).toBe('k1');
    expect(() => cipher.decrypt(reEncrypted[0] as string)).toThrowError(
      LocalStorageUnknownKeyError,
    );
    // Re-encrypted envelopes differ from the originals (fresh IVs + new key).
    for (let i = 0; i < records.length; i += 1) {
      expect(reEncrypted[i]).not.toBe(records[i]);
    }
  });

  it('returns an empty batch and a rotated cipher for no records', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const result = cipher.reEncryptAllRecords([], 'k2', OTHER_SECRET);
    expect(result.records).toEqual([]);
    expect(result.cipher.currentKeyId).toBe('k2');
  });

  it('a tampered record aborts the whole batch with LOCAL_STORAGE_TAMPERED', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const good = cipher.encrypt('good record');
    const tampered = flipEnvelopeByte(cipher.encrypt('will be tampered'), 12);
    expect(() => cipher.reEncryptAllRecords([good, tampered], 'k2', OTHER_SECRET)).toThrowError(
      LocalStorageTamperedError,
    );
    try {
      cipher.reEncryptAllRecords([good, tampered], 'k2', OTHER_SECRET);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(LOCAL_STORAGE_TAMPERED);
    }
    // The good record is untouched — nothing was returned or rewritten.
    expect(cipher.decrypt(good)).toBe('good record');
  });

  it('an unknown-key record aborts with LOCAL_STORAGE_UNKNOWN_KEY_ID', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const foreign = new Aes256GcmSqliteCipher({ secret: THIRD_SECRET, keyId: 'k9' }).encrypt(
      'foreign',
    );
    expect(() => cipher.reEncryptAllRecords([foreign], 'k2', OTHER_SECRET)).toThrowError(
      LocalStorageUnknownKeyError,
    );
    try {
      cipher.reEncryptAllRecords([foreign], 'k2', OTHER_SECRET);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(LOCAL_STORAGE_UNKNOWN_KEY_ID);
    }
  });

  it('refuses a new key id that is already held', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    expect(() => cipher.reEncryptAllRecords([], 'k1', OTHER_SECRET)).toThrow(
      'already held',
    );
  });
});

async function seedEncrypted(
  storage: NodeSqliteStorageAdapter | InMemoryStorageAdapter,
): Promise<void> {
  await storage.upsertCatalog([
    catalogEntry(),
    catalogEntry({
      variantId: 'variant-2',
      sku: 'SKU-002',
      barcode: null,
      name: 'Second Product',
      pricePence: 500n,
      priceBookPricePence: null,
      taxRateKind: null,
      taxRatePercent: null,
      stockOnHand: null,
      stockComputedAt: null,
    }),
  ]);
  await storage.enqueueOrder({
    idempotencyKey: 'key-1',
    tenantId: 't1',
    locationId: 'l1',
    registerId: 'r1',
    orderPayloadJson: '{"lines":[{"sku":"SKU-001","qty":2}],"total":2468}',
    tenderTotalPence: 2468n,
    createdAt: '2026-11-13T10:00:00.000Z',
  });
  await storage.logSyncAudit('handshake', { serverTime: '2026-11-13T10:00:00.000Z' });
}

describe('adapter reEncryptAllRecords — NodeSqliteStorageAdapter', () => {
  it('moves every encrypted column to the new key id; reads are unchanged', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      await seedEncrypted(storage);
      const result = await storage.reEncryptAllRecords('k2', OTHER_SECRET);
      expect(result).toEqual(
        expect.objectContaining({ catalog: 2, queue: 1, audit: 1 }),
      );
      expect(result.cipher.currentKeyId).toBe('k2');
      expect(result.cipher.keyIds).toEqual(expect.arrayContaining(['k1', 'k2']));

      // Reads return identical plaintext through the rotated adapter.
      expect((await storage.listCatalog()).map((e) => e.name)).toEqual([
        'Secret Product Name',
        'Second Product',
      ]);
      expect((await storage.listAllQueue())[0]?.orderPayloadJson).toBe(
        '{"lines":[{"sku":"SKU-001","qty":2}],"total":2468}',
      );
      expect(JSON.parse((await storage.listSyncAudit())[0]?.detailJson as string)).toEqual({
        serverTime: '2026-11-13T10:00:00.000Z',
      });

      // Raw rows are now k2 envelopes; no plaintext leaks.
      const catalog = raw
        .prepare('SELECT name, price_pence FROM local_catalog_cache')
        .all() as Record<string, unknown>[];
      expect(catalog).toHaveLength(2);
      for (const row of catalog) {
        expect(String(row.name)).toMatch(/^v1:k2:/);
        expect(String(row.price_pence)).toMatch(/^v1:k2:/);
      }
      expect(JSON.stringify(catalog)).not.toContain('Secret Product Name');
      const queue = raw.prepare('SELECT * FROM local_cash_queue').all() as Record<
        string,
        unknown
      >[];
      expect(String(queue[0]?.order_payload_json)).toMatch(/^v1:k2:/);
      expect(String(queue[0]?.tender_total_pence)).toMatch(/^v1:k2:/);
      const audit = raw.prepare('SELECT * FROM sync_audit_log').all() as Record<
        string,
        unknown
      >[];
      expect(String(audit[0]?.detail_json)).toMatch(/^v1:k2:/);

      // New writes after rotation use k2.
      await storage.upsertCatalog([catalogEntry({ variantId: 'variant-3', sku: 'SKU-003' })]);
      const third = raw
        .prepare('SELECT name FROM local_catalog_cache WHERE sku = ?')
        .get('SKU-003') as Record<string, unknown>;
      expect(String(third.name)).toMatch(/^v1:k2:/);
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered row aborts rotation and the old data stays readable', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      await seedEncrypted(storage);
      const row = raw
        .prepare('SELECT name FROM local_catalog_cache WHERE sku = ?')
        .get('SKU-001') as Record<string, unknown>;
      raw
        .prepare('UPDATE local_catalog_cache SET name = ? WHERE sku = ?')
        .run(flipEnvelopeByte(row.name as string, 12), 'SKU-001');
      await expect(storage.reEncryptAllRecords('k2', OTHER_SECRET)).rejects.toThrowError(
        LocalStorageTamperedError,
      );
      // The rewrite rolled back: the untampered row still reads, and
      // the raw envelopes are still k1 (rotation never committed).
      expect((await storage.findCatalogBySku('SKU-002'))?.name).toBe('Second Product');
      const names = raw
        .prepare('SELECT name FROM local_catalog_cache WHERE sku = ?')
        .get('SKU-002') as Record<string, unknown>;
      expect(String(names.name)).toMatch(/^v1:k1:/);
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after rotation, the old key alone cannot decrypt the rotated rows', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      await seedEncrypted(storage);
      await storage.reEncryptAllRecords('k2', OTHER_SECRET);
      const row = raw
        .prepare('SELECT name FROM local_catalog_cache WHERE sku = ?')
        .get('SKU-001') as Record<string, unknown>;
      expect(String(row.name)).toMatch(/^v1:k2:/);
      // A cipher holding ONLY the old key cannot read a k2 row — and
      // says so distinctly (unknown key id, not tampering).
      const k1Only = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
      expect(() => k1Only.decrypt(String(row.name))).toThrowError(
        LocalStorageUnknownKeyError,
      );
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses rotation on an unencrypted store', async () => {
    const { dir, file } = tempDbPath();
    const storage = new NodeSqliteStorageAdapter(file);
    try {
      await seedEncrypted(storage);
      await expect(storage.reEncryptAllRecords('k2', OTHER_SECRET)).rejects.toThrow(
        'no cipher is configured',
      );
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('adapter reEncryptAllRecords — InMemoryStorageAdapter', () => {
  it('moves every stored envelope to the new key id; reads are unchanged', async () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const storage = new InMemoryStorageAdapter({ cipher });
    try {
      await seedEncrypted(storage);
      const result = await storage.reEncryptAllRecords('k2', OTHER_SECRET);
      expect(result).toEqual(
        expect.objectContaining({ catalog: 2, queue: 1, audit: 1 }),
      );
      expect(result.cipher.currentKeyId).toBe('k2');

      expect((await storage.listCatalog()).map((e) => e.name)).toEqual([
        'Secret Product Name',
        'Second Product',
      ]);
      expect((await storage.listAllQueue())[0]?.tenderTotalPence).toBe(2468n);

      const stored = storage.debugStoredRows();
      expect(stored.catalog.every((row) => row.name.startsWith('v1:k2:'))).toBe(true);
      expect(stored.catalog.every((row) => row.pricePence.startsWith('v1:k2:'))).toBe(true);
      expect(stored.queue[0]?.orderPayloadJson.startsWith('v1:k2:')).toBe(true);
      expect(stored.audit[0]?.detailJson.startsWith('v1:k2:')).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('Secret Product Name');

      // A k1-only cipher can no longer decrypt the rotated rows.
      const k1Only = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
      expect(() => k1Only.decrypt(stored.catalog[0]?.name as string)).toThrowError(
        LocalStorageUnknownKeyError,
      );
    } finally {
      storage.close();
    }
  });

  it('rotation can run twice in a row (k1 -> k2 -> k3)', async () => {
    // NOTE: the tamper-abort path for this driver is covered by the
    // SQLite driver's test above (same transaction shape) and by the
    // cipher batch suite — the in-memory maps have no raw-write seam
    // to inject a tampered row, so this test proves repeated rotation
    // instead.
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const storage = new InMemoryStorageAdapter({ cipher });
    try {
      await seedEncrypted(storage);
      const second = await storage.reEncryptAllRecords('k2', OTHER_SECRET);
      expect(second.catalog).toBe(2);
      expect(second.cipher.currentKeyId).toBe('k2');
      const third = await storage.reEncryptAllRecords('k3', THIRD_SECRET);
      expect(third.cipher.currentKeyId).toBe('k3');
      expect(third.cipher.keyIds).toEqual(expect.arrayContaining(['k1', 'k2', 'k3']));
      expect((await storage.findCatalogBySku('SKU-001'))?.name).toBe('Secret Product Name');
      const storedAfter = storage.debugStoredRows();
      expect(storedAfter.catalog.every((row) => row.name.startsWith('v1:k3:'))).toBe(true);
      expect(storedAfter.queue[0]?.orderPayloadJson.startsWith('v1:k3:')).toBe(true);
      expect(storedAfter.audit[0]?.detailJson.startsWith('v1:k3:')).toBe(true);
    } finally {
      storage.close();
    }
  });

  it('refuses rotation on an unencrypted store', async () => {
    const storage = new InMemoryStorageAdapter();
    try {
      await seedEncrypted(storage);
      await expect(storage.reEncryptAllRecords('k2', OTHER_SECRET)).rejects.toThrow(
        'no cipher is configured',
      );
    } finally {
      storage.close();
    }
  });
});
