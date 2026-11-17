/**
 * SQLite storage driver (Build-04, Objective 1).
 *
 * Backed by Node 24's built-in `node:sqlite` (DatabaseSync) — verified
 * working in this environment (Node v24.22.1): tables, UNIQUE
 * constraints and BEGIN/COMMIT/ROLLBACK all behave. No native
 * dependency (no better-sqlite3, no compiler toolchain).
 *
 * HONEST LIMITS (not hidden):
 *  - ENCRYPTION IS OPT-IN via the `cipher` constructor option (see
 *    sqlite-cipher.ts). With a cipher supplied, the sensitive payload
 *    columns of local_cash_queue, local_catalog_cache and
 *    sync_audit_log are stored as AES-256-GCM envelopes and any
 *    tampering throws LOCAL_STORAGE_TAMPERED on read. Without a
 *    cipher (e.g. the existing no-arg construction in tests) rows
 *    are stored as plaintext exactly as before — the production
 *    wiring must pass a cipher built from the device-keystore secret.
 *    local_parked_baskets is NOT encrypted: it is outside the
 *    Build-05 Objective 3 scope (only the three tables above).
 *  - `node:sqlite` returns INTEGER columns as JS numbers and throws
 *    RangeError for values above Number.MAX_SAFE_INTEGER. Money is
 *    bigint pence, so this driver stores every bigint column as TEXT
 *    and converts with BigInt() on read — exact round-trip, no range
 *    cliff. (DESIGN DECISION, not a research fact.)
 *  - Transactions use BEGIN IMMEDIATE / COMMIT / ROLLBACK around the
 *    awaited callback. node:sqlite is synchronous, so while the
 *    callback awaits, another caller on the same connection could
 *    interleave; the register is a single-writer device and all
 *    controller paths go through this one adapter, so that is
 *    accepted and documented rather than pretended away.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Aes256GcmSqliteCipher } from './sqlite-cipher';
import type {
  CatalogCacheEntry,
  ParkedBasket,
  QueuedOrder,
  StorageAdapter,
  SyncAuditEntry,
  SyncAuditKind,
  SyncStatus,
} from './storage-adapter';

// Re-exported so the cipher is reachable through the package's
// existing `export * from './storage/sqlite-storage'` (src/index.ts
// is owned by another worker and is not touched here).
export {
  Aes256GcmSqliteCipher,
  LOCAL_STORAGE_TAMPERED,
  LOCAL_STORAGE_UNKNOWN_KEY_ID,
  LocalStorageTamperedError,
  LocalStorageUnknownKeyError,
} from './sqlite-cipher';
export type { Aes256GcmSqliteCipherOptions } from './sqlite-cipher';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_catalog_cache (
  variant_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  price_pence TEXT NOT NULL,
  price_book_price_pence TEXT,
  tax_rate_kind TEXT,
  tax_rate_percent TEXT,
  stock_on_hand TEXT,
  stock_computed_at TEXT,
  requires_challenge_25 INTEGER NOT NULL DEFAULT 0,
  min_age_years INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_sku ON local_catalog_cache (sku);
CREATE INDEX IF NOT EXISTS idx_catalog_barcode ON local_catalog_cache (barcode);
CREATE TABLE IF NOT EXISTS local_cash_queue (
  local_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  order_payload_json TEXT NOT NULL,
  tender_total_pence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('queued','syncing','synced','conflict'))
);
CREATE INDEX IF NOT EXISTS idx_queue_fifo ON local_cash_queue (created_at, local_id);
CREATE TABLE IF NOT EXISTS sync_audit_log (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('handshake','flush','conflict','price_discrepancy')),
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_parked_baskets (
  local_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  basket_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface NodeSqliteStorageAdapterOptions {
  /**
   * When supplied, sensitive payload columns are stored as
   * AES-256-GCM envelopes (see sqlite-cipher.ts) and authenticated /
   * decrypted on read. When omitted, rows are stored as plaintext
   * exactly as before. Lookup keys (sku, barcode, ids, sync_status,
   * timestamps) are never encrypted — they stay plaintext so WHERE /
   * ORDER BY keep working.
   *
   * ENCRYPTED columns:
   *  - local_catalog_cache: name, price_pence,
   *    price_book_price_pence, tax_rate_kind, tax_rate_percent,
   *    stock_on_hand, stock_computed_at
   *  - local_cash_queue: order_payload_json, tender_total_pence
   *  - sync_audit_log: detail_json
   * NOT encrypted (out of scope / lookup keys): local_parked_baskets
   * and all id / sku / barcode / status / timestamp columns.
   */
  cipher?: Aes256GcmSqliteCipher;
}

export class NodeSqliteStorageAdapter implements StorageAdapter {
  private readonly db: DatabaseSync;
  /**
   * Mutable only for key rotation: `reEncryptAllRecords` swaps in
   * the rotated cipher after the rewrite commits. Nothing else
   * reassigns it.
   */
  private cipher?: Aes256GcmSqliteCipher;
  private closed = false;

  /**
   * @param path SQLite file path, or ':memory:' for an in-memory
   * database (used by tests). The parent directory must exist for a
   * file path.
   * @param options.cipher Optional AES-256-GCM cipher (see above).
   * The caller owns the device-keystore secret; this driver never
   * reads it from anywhere itself.
   */
  constructor(path: string, options: NodeSqliteStorageAdapterOptions = {}) {
    this.db = new DatabaseSync(path);
    this.cipher = options.cipher;
    this.db.exec(SCHEMA);
    // Upgrade path for device files created before Build-08: the
    // table already exists without min_age_years, and CREATE TABLE IF
    // NOT EXISTS will not add it. Add the column when it is missing
    // (a no-op on fresh files, where SCHEMA already created it).
    const columns = this.db.prepare('PRAGMA table_info(local_catalog_cache)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'min_age_years')) {
      this.db.exec('ALTER TABLE local_catalog_cache ADD COLUMN min_age_years INTEGER');
    }
  }

  /** Encrypt a nullable TEXT value when a cipher is configured. */
  private enc(value: string | null): string | null {
    if (value === null || this.cipher === undefined) {
      return value;
    }
    return this.cipher.encrypt(value);
  }

  /**
   * Decrypt a nullable TEXT value when a cipher is configured. A
   * tampered or non-envelope value throws LocalStorageTamperedError.
   */
  private dec(value: string | null): string | null {
    if (value === null || this.cipher === undefined) {
      return value;
    }
    return this.cipher.decrypt(value);
  }

  private decBigint(value: string | null): bigint | null {
    const decrypted = this.dec(value);
    return decrypted === null ? null : BigInt(decrypted);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Storage adapter is closed');
    }
  }

  async upsertCatalog(entries: CatalogCacheEntry[]): Promise<void> {
    this.assertOpen();
    const stmt = this.db.prepare(
      `INSERT INTO local_catalog_cache
        (variant_id, sku, barcode, name, price_pence, price_book_price_pence,
         tax_rate_kind, tax_rate_percent, stock_on_hand, stock_computed_at,
         requires_challenge_25, min_age_years, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(variant_id) DO UPDATE SET
         sku = excluded.sku, barcode = excluded.barcode, name = excluded.name,
         price_pence = excluded.price_pence,
         price_book_price_pence = excluded.price_book_price_pence,
         tax_rate_kind = excluded.tax_rate_kind,
         tax_rate_percent = excluded.tax_rate_percent,
         stock_on_hand = excluded.stock_on_hand,
         stock_computed_at = excluded.stock_computed_at,
         requires_challenge_25 = excluded.requires_challenge_25,
         min_age_years = excluded.min_age_years,
         updated_at = excluded.updated_at`,
    );
    for (const entry of entries) {
      stmt.run(
        entry.variantId,
        entry.sku,
        entry.barcode,
        this.enc(entry.name),
        this.enc(entry.pricePence.toString()),
        entry.priceBookPricePence === null ? null : this.enc(entry.priceBookPricePence.toString()),
        this.enc(entry.taxRateKind),
        this.enc(entry.taxRatePercent),
        entry.stockOnHand === null ? null : this.enc(entry.stockOnHand.toString()),
        this.enc(entry.stockComputedAt),
        entry.requiresChallenge25 ? 1 : 0,
        // Build-08 Obj 3: minAge is required by CatalogCacheEntry, but
        // an untyped caller may omit it — a missing minimum age means
        // "no minimum age recorded", never "skip the gate": the
        // requires_challenge_25 flag above stays authoritative.
        entry.minAge ?? null,
        entry.updatedAt,
      );
    }
  }

  private rowToCatalog(row: Record<string, unknown>): CatalogCacheEntry {
    return {
      variantId: row.variant_id as string,
      sku: row.sku as string,
      barcode: row.barcode as string | null,
      name: this.dec(row.name as string) as string,
      pricePence: BigInt(this.dec(row.price_pence as string) as string),
      priceBookPricePence: this.decBigint(row.price_book_price_pence as string | null),
      taxRateKind: this.dec(row.tax_rate_kind as string | null),
      taxRatePercent: this.dec(row.tax_rate_percent as string | null),
      stockOnHand: this.decBigint(row.stock_on_hand as string | null),
      stockComputedAt: this.dec(row.stock_computed_at as string | null),
      requiresChallenge25: (row.requires_challenge_25 as number) === 1,
      minAge: (row.min_age_years as number | null) ?? null,
      updatedAt: row.updated_at as string,
    };
  }

  async listCatalog(): Promise<CatalogCacheEntry[]> {
    this.assertOpen();
    return this.db
      .prepare('SELECT * FROM local_catalog_cache ORDER BY sku ASC')
      .all()
      .map((row) => this.rowToCatalog(row as Record<string, unknown>));
  }

  async findCatalogBySku(sku: string): Promise<CatalogCacheEntry | undefined> {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM local_catalog_cache WHERE sku = ?')
      .get(sku) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToCatalog(row);
  }

  async findCatalogByBarcode(barcode: string): Promise<CatalogCacheEntry | undefined> {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM local_catalog_cache WHERE barcode = ?')
      .get(barcode) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToCatalog(row);
  }

  async enqueueOrder(order: {
    idempotencyKey: string;
    tenantId: string;
    locationId: string;
    registerId: string;
    orderPayloadJson: string;
    tenderTotalPence: bigint;
    createdAt: string;
  }): Promise<QueuedOrder> {
    this.assertOpen();
    const localId = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO local_cash_queue
            (local_id, idempotency_key, tenant_id, location_id, register_id,
             order_payload_json, tender_total_pence, created_at, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
        )
        .run(
          localId,
          order.idempotencyKey,
          order.tenantId,
          order.locationId,
          order.registerId,
          this.enc(order.orderPayloadJson) as string,
          this.enc(order.tenderTotalPence.toString()) as string,
          order.createdAt,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed')) {
        throw new Error(`Duplicate idempotency key in local queue: ${order.idempotencyKey}`);
      }
      throw new Error(`Could not enqueue offline order: ${message}`);
    }
    return { localId, syncStatus: 'queued', ...order };
  }

  private rowToQueued(row: Record<string, unknown>): QueuedOrder {
    return {
      localId: row.local_id as string,
      idempotencyKey: row.idempotency_key as string,
      tenantId: row.tenant_id as string,
      locationId: row.location_id as string,
      registerId: row.register_id as string,
      orderPayloadJson: this.dec(row.order_payload_json as string) as string,
      tenderTotalPence: BigInt(this.dec(row.tender_total_pence as string) as string),
      createdAt: row.created_at as string,
      syncStatus: row.sync_status as SyncStatus,
    };
  }

  async listQueuedOrders(): Promise<QueuedOrder[]> {
    this.assertOpen();
    return this.db
      .prepare(
        `SELECT * FROM local_cash_queue
          WHERE sync_status IN ('queued', 'syncing')
          ORDER BY created_at ASC, local_id ASC`,
      )
      .all()
      .map((row) => this.rowToQueued(row as Record<string, unknown>));
  }

  async listAllQueue(): Promise<QueuedOrder[]> {
    this.assertOpen();
    return this.db
      .prepare('SELECT * FROM local_cash_queue ORDER BY created_at ASC, local_id ASC')
      .all()
      .map((row) => this.rowToQueued(row as Record<string, unknown>));
  }

  async updateQueueStatus(localId: string, status: SyncStatus): Promise<void> {
    this.assertOpen();
    const result = this.db
      .prepare('UPDATE local_cash_queue SET sync_status = ? WHERE local_id = ?')
      .run(status, localId);
    if (result.changes === 0) {
      throw new Error(`Unknown queued order: ${localId}`);
    }
  }

  async logSyncAudit(kind: SyncAuditKind, detail: unknown): Promise<void> {
    this.assertOpen();
    this.db
      .prepare('INSERT INTO sync_audit_log (id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), kind, this.enc(JSON.stringify(detail)) as string, new Date().toISOString());
  }

  async listSyncAudit(): Promise<SyncAuditEntry[]> {
    this.assertOpen();
    return this.db
      .prepare('SELECT * FROM sync_audit_log ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          kind: r.kind as SyncAuditKind,
          detailJson: this.dec(r.detail_json as string) as string,
          createdAt: r.created_at as string,
        };
      });
  }

  /**
   * Master key-ID rotation for stored data (Build-07, Objective 2).
   * Re-encrypts every encrypted column in local_catalog_cache,
   * local_cash_queue and sync_audit_log from the keys held by the
   * current cipher to a fresh `newKeyId`/`newSecret`, then swaps the
   * adapter to the rotated cipher. Runs inside one transaction: a
   * tampered row aborts the whole rewrite (rollback) and the old
   * cipher stays in place — no partial rotation ever reaches disk.
   * local_parked_baskets is not encrypted and is untouched.
   * Returns the rotated cipher plus per-table record counts.
   */
  async reEncryptAllRecords(
    newKeyId: string,
    newSecret: string | Buffer,
  ): Promise<{ cipher: Aes256GcmSqliteCipher; catalog: number; queue: number; audit: number }> {
    this.assertOpen();
    if (this.cipher === undefined) {
      throw new Error('Cannot rotate keys on an unencrypted store — no cipher is configured');
    }
    const oldCipher = this.cipher;
    const counts = { catalog: 0, queue: 0, audit: 0 };
    let rotated: Aes256GcmSqliteCipher | undefined;
    await this.transaction(async () => {
      // Catalog: 7 encrypted columns (nulls stay null).
      const catalogRows = this.db
        .prepare(
          'SELECT variant_id, name, price_pence, price_book_price_pence, tax_rate_kind, ' +
            'tax_rate_percent, stock_on_hand, stock_computed_at FROM local_catalog_cache',
        )
        .all() as Record<string, unknown>[];
      const catalogCols = [
        'name',
        'price_pence',
        'price_book_price_pence',
        'tax_rate_kind',
        'tax_rate_percent',
        'stock_on_hand',
        'stock_computed_at',
      ] as const;
      const catalogValues: string[] = [];
      for (const row of catalogRows) {
        for (const col of catalogCols) {
          const value = row[col] as string | null;
          if (value !== null) {
            catalogValues.push(value);
          }
        }
      }
      const catalogRotated = oldCipher.reEncryptAllRecords(catalogValues, newKeyId, newSecret);
      rotated = catalogRotated.cipher;
      const updateCatalog = this.db.prepare(
        'UPDATE local_catalog_cache SET name = ?, price_pence = ?, price_book_price_pence = ?, ' +
          'tax_rate_kind = ?, tax_rate_percent = ?, stock_on_hand = ?, stock_computed_at = ? ' +
          'WHERE variant_id = ?',
      );
      let i = 0;
      for (const row of catalogRows) {
        const next = (col: (typeof catalogCols)[number]): string | null => {
          const value = row[col] as string | null;
          if (value === null) {
            return null;
          }
          const out = catalogRotated.records[i] as string;
          i += 1;
          return out;
        };
        updateCatalog.run(
          next('name'),
          next('price_pence'),
          next('price_book_price_pence'),
          next('tax_rate_kind'),
          next('tax_rate_percent'),
          next('stock_on_hand'),
          next('stock_computed_at'),
          row.variant_id as string,
        );
        counts.catalog += 1;
      }

      // Queue: order_payload_json + tender_total_pence (both non-null).
      const queueRows = this.db
        .prepare('SELECT local_id, order_payload_json, tender_total_pence FROM local_cash_queue')
        .all() as Record<string, unknown>[];
      const queueValues: string[] = [];
      for (const row of queueRows) {
        queueValues.push(row.order_payload_json as string, row.tender_total_pence as string);
      }
      const queueRotated = oldCipher.reEncryptAllRecords(queueValues, newKeyId, newSecret);
      const updateQueue = this.db.prepare(
        'UPDATE local_cash_queue SET order_payload_json = ?, tender_total_pence = ? WHERE local_id = ?',
      );
      queueRows.forEach((row, index) => {
        updateQueue.run(
          queueRotated.records[index * 2] as string,
          queueRotated.records[index * 2 + 1] as string,
          row.local_id as string,
        );
        counts.queue += 1;
      });

      // Audit: detail_json (non-null).
      const auditRows = this.db
        .prepare('SELECT id, detail_json FROM sync_audit_log')
        .all() as Record<string, unknown>[];
      const auditValues = auditRows.map((row) => row.detail_json as string);
      const auditRotated = oldCipher.reEncryptAllRecords(auditValues, newKeyId, newSecret);
      const updateAudit = this.db.prepare('UPDATE sync_audit_log SET detail_json = ? WHERE id = ?');
      auditRows.forEach((row, index) => {
        updateAudit.run(auditRotated.records[index] as string, row.id as string);
        counts.audit += 1;
      });
    });
    if (rotated === undefined) {
      throw new Error('Key rotation did not complete');
    }
    this.cipher = rotated;
    return { cipher: rotated, ...counts };
  }

  async parkBasket(basket: {
    tenantId: string;
    locationId: string;
    registerId: string;
    basketJson: string;
    createdAt: string;
  }): Promise<ParkedBasket> {
    this.assertOpen();
    const localId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO local_parked_baskets
          (local_id, tenant_id, location_id, register_id, basket_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(localId, basket.tenantId, basket.locationId, basket.registerId, basket.basketJson, basket.createdAt);
    return { localId, ...basket };
  }

  async listParkedBaskets(): Promise<ParkedBasket[]> {
    this.assertOpen();
    return this.db
      .prepare('SELECT * FROM local_parked_baskets ORDER BY created_at ASC')
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          localId: r.local_id as string,
          tenantId: r.tenant_id as string,
          locationId: r.location_id as string,
          registerId: r.register_id as string,
          basketJson: r.basket_json as string,
          createdAt: r.created_at as string,
        };
      });
  }

  async deleteParkedBasket(localId: string): Promise<void> {
    this.assertOpen();
    this.db.prepare('DELETE FROM local_parked_baskets WHERE local_id = ?').run(localId);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
