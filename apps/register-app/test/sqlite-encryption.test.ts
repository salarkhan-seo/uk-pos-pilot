/**
 * AES-256-GCM encryption-at-rest tests (Build-05, Objective 3).
 *
 * Proves, for BOTH drivers (NodeSqlite + InMemory):
 *  (a) raw stored rows hold ciphertext, not plaintext;
 *  (b) flipping a byte in stored ciphertext / auth tag throws
 *      LOCAL_STORAGE_TAMPERED on read;
 *  (c) normal encrypt/decrypt round-trips through both drivers;
 *  (d) key-ID rotation: data encrypted under an old key id still
 *      decrypts after rotation while the old key is retained.
 *
 * Raw SQLite inspection bypasses the driver entirely: a second,
 * independent `node:sqlite` connection opens the same database file.
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
import type { CatalogCacheEntry, StorageAdapter } from '../src/storage/storage-adapter';

const TEST_SECRET = 'test-only-device-secret-do-not-use-in-production';
const OTHER_SECRET = 'test-only-other-secret-do-not-use-in-production';

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'register-app-enc-'));
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

/** Flip one byte of the decoded envelope payload at `index` and re-encode. */
function flipEnvelopeByte(envelope: string, index: number): string {
  const parts = envelope.split(':');
  expect(parts).toHaveLength(3);
  const payload = Buffer.from(parts[2] as string, 'base64');
  payload[index] = (payload[index] as number) ^ 0xff;
  return `${parts[0]}:${parts[1]}:${payload.toString('base64')}`;
}

/** Index 12 is the first byte of the 16-byte auth tag (iv is 12 bytes). */
function flipTagByte(envelope: string): string {
  return flipEnvelopeByte(envelope, 12);
}

/** Last byte of the payload is inside the ciphertext. */
function flipCiphertextByte(envelope: string): string {
  const payload = Buffer.from((envelope.split(':')[2] as string), 'base64');
  return flipEnvelopeByte(envelope, payload.length - 1);
}

function assertTampered(error: unknown): void {
  expect(error).toBeInstanceOf(LocalStorageTamperedError);
  expect((error as { code?: string }).code).toBe(LOCAL_STORAGE_TAMPERED);
}

describe('Aes256GcmSqliteCipher', () => {
  it('round-trips plaintext and uses a fresh random IV each time', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    expect(cipher.decrypt(cipher.encrypt('hello register'))).toBe('hello register');
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
    const first = cipher.encrypt('same plaintext');
    const second = cipher.encrypt('same plaintext');
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe('same plaintext');
    expect(cipher.decrypt(second)).toBe('same plaintext');
  });

  it('rejects decryption under a different secret as tampering', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    const other = new Aes256GcmSqliteCipher({ secret: OTHER_SECRET });
    const envelope = cipher.encrypt('sensitive');
    expect(() => other.decrypt(envelope)).toThrowError(LocalStorageTamperedError);
    try {
      other.decrypt(envelope);
    } catch (error) {
      assertTampered(error);
    }
  });

  it('rejects malformed envelopes and truncated payloads as tampering', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    for (const bad of ['not-an-envelope', 'v1:k1:', 'v2:k1:AAAA', 'v1:k1:!!!not-base64!!!']) {
      expect(() => cipher.decrypt(bad)).toThrowError(LocalStorageTamperedError);
    }
    const envelope = cipher.encrypt('x');
    const truncated = envelope.slice(0, envelope.length - 4);
    expect(() => cipher.decrypt(truncated)).toThrowError(LocalStorageTamperedError);
  });

  it('throws LOCAL_STORAGE_UNKNOWN_KEY_ID for an envelope whose key is not held', () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const envelope = cipher.encrypt('old data');
    const fresh = new Aes256GcmSqliteCipher({ secret: OTHER_SECRET, keyId: 'k2' });
    expect(() => fresh.decrypt(envelope)).toThrowError(LocalStorageUnknownKeyError);
    try {
      fresh.decrypt(envelope);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(LOCAL_STORAGE_UNKNOWN_KEY_ID);
    }
  });

  it('rotation: old-key data still decrypts when the old key is retained', () => {
    const oldCipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const envelope = oldCipher.encrypt('encrypted before rotation');
    const rotated = oldCipher.rotateTo('k2', OTHER_SECRET);
    expect(rotated.currentKeyId).toBe('k2');
    expect(rotated.keyIds).toEqual(expect.arrayContaining(['k1', 'k2']));
    // Old rows still decrypt; new rows use the new key id.
    expect(rotated.decrypt(envelope)).toBe('encrypted before rotation');
    expect(rotated.encrypt('after rotation')).toMatch(/^v1:k2:/);
    // The pre-rotation instance is unchanged and cannot read k2 rows.
    expect(oldCipher.currentKeyId).toBe('k1');
    expect(() => oldCipher.decrypt(rotated.encrypt('new row'))).toThrowError(
      LocalStorageUnknownKeyError,
    );
  });

  it('fromEnvironment reads the secret from the env var and throws when it is missing', () => {
    const savedSecret = process.env.REGISTER_APP_DEVICE_SECRET;
    const savedKeyId = process.env.REGISTER_APP_DEVICE_KEY_ID;
    try {
      delete process.env.REGISTER_APP_DEVICE_SECRET;
      delete process.env.REGISTER_APP_DEVICE_KEY_ID;
      expect(() => Aes256GcmSqliteCipher.fromEnvironment()).toThrow(
        'REGISTER_APP_DEVICE_SECRET is not set',
      );
      process.env.REGISTER_APP_DEVICE_SECRET = TEST_SECRET;
      process.env.REGISTER_APP_DEVICE_KEY_ID = 'device-7';
      const cipher = Aes256GcmSqliteCipher.fromEnvironment();
      expect(cipher.currentKeyId).toBe('device-7');
      expect(cipher.decrypt(cipher.encrypt('env secret works'))).toBe('env secret works');
    } finally {
      if (savedSecret === undefined) delete process.env.REGISTER_APP_DEVICE_SECRET;
      else process.env.REGISTER_APP_DEVICE_SECRET = savedSecret;
      if (savedKeyId === undefined) delete process.env.REGISTER_APP_DEVICE_KEY_ID;
      else process.env.REGISTER_APP_DEVICE_KEY_ID = savedKeyId;
    }
  });

  it('refuses to construct without any secret', () => {
    expect(() => new Aes256GcmSqliteCipher({})).toThrow('requires a device secret');
  });
});

function runEncryptedSuite(
  name: string,
  makeAdapter: (cipher: Aes256GcmSqliteCipher) => StorageAdapter,
): void {
  describe(name, () => {
    it('round-trips catalog, queue and audit values identically', async () => {
      const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
      const storage = makeAdapter(cipher);
      try {
        await storage.upsertCatalog([catalogEntry()]);
        const found = await storage.findCatalogBySku('SKU-001');
        expect(found).toEqual(catalogEntry());
        expect(await storage.findCatalogByBarcode('5012345678900')).toEqual(catalogEntry());

        const queued = await storage.enqueueOrder({
          idempotencyKey: 'key-1',
          tenantId: 't1',
          locationId: 'l1',
          registerId: 'r1',
          orderPayloadJson: '{"lines":[{"sku":"SKU-001","qty":2}],"total":2468}',
          tenderTotalPence: 2468n,
          createdAt: '2026-11-13T10:00:00.000Z',
        });
        expect((await storage.listQueuedOrders())[0]).toEqual({ ...queued, syncStatus: 'queued' });

        await storage.logSyncAudit('handshake', { serverTime: '2026-11-13T10:00:00.000Z' });
        const audit = await storage.listSyncAudit();
        expect(audit).toHaveLength(1);
        expect(JSON.parse(audit[0]?.detailJson as string)).toEqual({
          serverTime: '2026-11-13T10:00:00.000Z',
        });
      } finally {
        storage.close();
      }
    });

    it('preserves nulls and upsert-replace behaviour under encryption', async () => {
      const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
      const storage = makeAdapter(cipher);
      try {
        await storage.upsertCatalog([
          catalogEntry({
            priceBookPricePence: null,
            taxRateKind: null,
            taxRatePercent: null,
            stockOnHand: null,
            stockComputedAt: null,
          }),
        ]);
        const found = await storage.findCatalogBySku('SKU-001');
        expect(found?.priceBookPricePence).toBeNull();
        expect(found?.stockOnHand).toBeNull();
        await storage.upsertCatalog([catalogEntry({ pricePence: 5555n })]);
        expect((await storage.listCatalog())).toHaveLength(1);
        expect((await storage.findCatalogBySku('SKU-001'))?.pricePence).toBe(5555n);
      } finally {
        storage.close();
      }
    });
  });
}

runEncryptedSuite(
  'encrypted NodeSqliteStorageAdapter',
  (cipher) => new NodeSqliteStorageAdapter(':memory:', { cipher }),
);
runEncryptedSuite(
  'encrypted InMemoryStorageAdapter',
  (cipher) => new InMemoryStorageAdapter({ cipher }),
);

describe('raw SQLite rows hold ciphertext, not plaintext', () => {
  it('local_catalog_cache, local_cash_queue and sync_audit_log store envelopes on disk', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      await storage.upsertCatalog([catalogEntry()]);
      await storage.enqueueOrder({
        idempotencyKey: 'key-1',
        tenantId: 't1',
        locationId: 'l1',
        registerId: 'r1',
        orderPayloadJson: '{"lines":[{"sku":"SKU-001","qty":2}],"total":2468}',
        tenderTotalPence: 2468n,
        createdAt: '2026-11-13T10:00:00.000Z',
      });
      await storage.logSyncAudit('conflict', { shortfall: '2', secretNote: 'do-not-leak' });

      const catalog = raw
        .prepare('SELECT * FROM local_catalog_cache')
        .all() as Record<string, unknown>[];
      expect(catalog).toHaveLength(1);
      const row = catalog[0] as Record<string, unknown>;
      // Lookup keys stay plaintext by design; every sensitive payload column is an envelope.
      expect(row.sku).toBe('SKU-001');
      expect(row.barcode).toBe('5012345678900');
      for (const column of [
        'name',
        'price_pence',
        'price_book_price_pence',
        'tax_rate_kind',
        'tax_rate_percent',
        'stock_on_hand',
        'stock_computed_at',
      ]) {
        expect(String(row[column])).toMatch(/^v1:k1:/);
      }
      expect(JSON.stringify(row)).not.toContain('Secret Product Name');
      // The encrypted price column holds an envelope, never the plaintext pence value.
      expect(String(row.price_pence)).not.toBe('1234');

      const queue = raw
        .prepare('SELECT * FROM local_cash_queue')
        .all() as Record<string, unknown>[];
      expect(queue).toHaveLength(1);
      expect(String(queue[0]?.order_payload_json)).toMatch(/^v1:k1:/);
      expect(String(queue[0]?.tender_total_pence)).toMatch(/^v1:k1:/);
      expect(JSON.stringify(queue)).not.toContain('SKU-001');

      const audit = raw
        .prepare('SELECT * FROM sync_audit_log')
        .all() as Record<string, unknown>[];
      expect(audit).toHaveLength(1);
      expect(String(audit[0]?.detail_json)).toMatch(/^v1:k1:/);
      expect(JSON.stringify(audit)).not.toContain('do-not-leak');
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flipping a ciphertext byte in the catalog name throws LOCAL_STORAGE_TAMPERED on read', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      await storage.upsertCatalog([catalogEntry()]);
      const row = raw
        .prepare('SELECT name FROM local_catalog_cache WHERE sku = ?')
        .get('SKU-001') as Record<string, unknown>;
      raw
        .prepare('UPDATE local_catalog_cache SET name = ? WHERE sku = ?')
        .run(flipCiphertextByte(row.name as string), 'SKU-001');
      await expect(storage.listCatalog()).rejects.toThrowError(LocalStorageTamperedError);
      try {
        await storage.listCatalog();
      } catch (error) {
        assertTampered(error);
      }
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flipping an auth-tag byte in the queued order payload throws LOCAL_STORAGE_TAMPERED on read', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      const queued = await storage.enqueueOrder({
        idempotencyKey: 'key-1',
        tenantId: 't1',
        locationId: 'l1',
        registerId: 'r1',
        orderPayloadJson: '{"lines":[{"sku":"SKU-001","qty":2}]}',
        tenderTotalPence: 2468n,
        createdAt: '2026-11-13T10:00:00.000Z',
      });
      const row = raw
        .prepare('SELECT order_payload_json FROM local_cash_queue WHERE local_id = ?')
        .get(queued.localId) as Record<string, unknown>;
      raw
        .prepare('UPDATE local_cash_queue SET order_payload_json = ? WHERE local_id = ?')
        .run(flipTagByte(row.order_payload_json as string), queued.localId);
      await expect(storage.listQueuedOrders()).rejects.toThrowError(LocalStorageTamperedError);
      try {
        await storage.listQueuedOrders();
      } catch (error) {
        assertTampered(error);
      }
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flipping a ciphertext byte in the sync audit detail throws LOCAL_STORAGE_TAMPERED on read', async () => {
    const { dir, file } = tempDbPath();
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    const storage = new NodeSqliteStorageAdapter(file, { cipher });
    const raw = new DatabaseSync(file);
    try {
      await storage.logSyncAudit('conflict', { shortfall: '2' });
      const row = raw.prepare('SELECT id, detail_json FROM sync_audit_log').get() as Record<
        string,
        unknown
      >;
      raw
        .prepare('UPDATE sync_audit_log SET detail_json = ? WHERE id = ?')
        .run(flipCiphertextByte(row.detail_json as string), row.id as string);
      await expect(storage.listSyncAudit()).rejects.toThrowError(LocalStorageTamperedError);
      try {
        await storage.listSyncAudit();
      } catch (error) {
        assertTampered(error);
      }
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotation through the driver: old-key rows still read, new rows use the new key id', async () => {
    const { dir, file } = tempDbPath();
    const oldCipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET, keyId: 'k1' });
    const storage = new NodeSqliteStorageAdapter(file, { cipher: oldCipher });
    try {
      await storage.upsertCatalog([catalogEntry()]);
      await storage.enqueueOrder({
        idempotencyKey: 'key-1',
        tenantId: 't1',
        locationId: 'l1',
        registerId: 'r1',
        orderPayloadJson: '{"old":true}',
        tenderTotalPence: 100n,
        createdAt: '2026-11-13T10:00:00.000Z',
      });
    } finally {
      storage.close();
    }

    const rotated = oldCipher.rotateTo('k2', OTHER_SECRET);
    const reopened = new NodeSqliteStorageAdapter(file, { cipher: rotated });
    const raw = new DatabaseSync(file);
    try {
      // Old rows still decrypt after rotation.
      expect((await reopened.findCatalogBySku('SKU-001'))?.name).toBe('Secret Product Name');
      expect((await reopened.listQueuedOrders())[0]?.orderPayloadJson).toBe('{"old":true}');
      // New rows are encrypted under k2.
      await reopened.upsertCatalog([catalogEntry({ variantId: 'variant-2', sku: 'SKU-002' })]);
      const rows = raw
        .prepare('SELECT sku, name FROM local_catalog_cache ORDER BY sku ASC')
        .all() as Record<string, unknown>[];
      expect(String(rows[0]?.name)).toMatch(/^v1:k1:/);
      expect(String(rows[1]?.name)).toMatch(/^v1:k2:/);
    } finally {
      reopened.close();
      raw.close();
    }

    // A cipher that dropped k1 can no longer read the old row — and
    // says so distinctly (unknown key id, not tampering).
    const withoutOldKey = new Aes256GcmSqliteCipher({ secret: OTHER_SECRET, keyId: 'k2' });
    const dropped = new NodeSqliteStorageAdapter(file, { cipher: withoutOldKey });
    try {
      await expect(dropped.listCatalog()).rejects.toThrowError(LocalStorageUnknownKeyError);
    } finally {
      dropped.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InMemory driver stored form', () => {
  it('stores ciphertext envelopes internally, not plaintext', async () => {
    const cipher = new Aes256GcmSqliteCipher({ secret: TEST_SECRET });
    const storage = new InMemoryStorageAdapter({ cipher });
    try {
      await storage.upsertCatalog([catalogEntry()]);
      await storage.enqueueOrder({
        idempotencyKey: 'key-1',
        tenantId: 't1',
        locationId: 'l1',
        registerId: 'r1',
        orderPayloadJson: '{"secret":"payload"}',
        tenderTotalPence: 100n,
        createdAt: '2026-11-13T10:00:00.000Z',
      });
      await storage.logSyncAudit('conflict', { secretNote: 'do-not-leak' });
      const stored = storage.debugStoredRows();
      expect(stored.catalog[0]?.name).toMatch(/^v1:k1:/);
      expect(stored.catalog[0]?.pricePence).toMatch(/^v1:k1:/);
      expect(stored.queue[0]?.orderPayloadJson).toMatch(/^v1:k1:/);
      expect(stored.queue[0]?.tenderTotalPence).toMatch(/^v1:k1:/);
      expect(stored.audit[0]?.detailJson).toMatch(/^v1:k1:/);
      expect(JSON.stringify(stored)).not.toContain('Secret Product Name');
      expect(JSON.stringify(stored)).not.toContain('do-not-leak');
      // …while the public API still returns plaintext.
      expect((await storage.findCatalogBySku('SKU-001'))?.name).toBe('Secret Product Name');
    } finally {
      storage.close();
    }
  });
});

describe('no-cipher behaviour is unchanged', () => {
  it('a driver built without a cipher stores plaintext exactly as before', async () => {
    const { dir, file } = tempDbPath();
    const storage = new NodeSqliteStorageAdapter(file);
    const raw = new DatabaseSync(file);
    try {
      await storage.upsertCatalog([catalogEntry()]);
      const row = raw.prepare('SELECT name FROM local_catalog_cache').get() as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('Secret Product Name');
      expect((await storage.findCatalogBySku('SKU-001'))?.name).toBe('Secret Product Name');
    } finally {
      storage.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
