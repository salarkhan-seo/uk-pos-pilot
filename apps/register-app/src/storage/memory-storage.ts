/**
 * In-memory storage driver (Build-04, Objective 1).
 *
 * Fully tested, used by all automated tests. `transaction` snapshots
 * every map and restores it on throw, so a failed flush step cannot
 * leave a half-marked queue.
 *
 * ENCRYPTION (Build-05, Objective 3): when a cipher is supplied via
 * the constructor, sensitive payload fields are stored as AES-256-GCM
 * envelopes inside the maps and decrypted on read — the same
 * field set as the SQLite driver (catalog name/prices/tax/stock,
 * queue order payload + tender total, audit detail). Lookup keys
 * (sku, barcode, ids, sync_status) stay plaintext. Without a cipher
 * the stored form is plaintext, exactly as before. `debugStoredRows()`
 * exposes the stored (possibly encrypted) form for tests/diagnostics.
 */
import { randomUUID } from 'node:crypto';
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

/** Stored form of a catalog row: string fields hold plaintext, or a GCM envelope when a cipher is configured. */
interface StoredCatalogRow {
  variantId: string;
  sku: string;
  barcode: string | null;
  name: string;
  pricePence: string;
  priceBookPricePence: string | null;
  taxRateKind: string | null;
  taxRatePercent: string | null;
  stockOnHand: string | null;
  stockComputedAt: string | null;
  requiresChallenge25: boolean;
  minAge: number | null;
  updatedAt: string;
}

interface StoredQueueRow {
  localId: string;
  idempotencyKey: string;
  tenantId: string;
  locationId: string;
  registerId: string;
  orderPayloadJson: string;
  tenderTotalPence: string;
  createdAt: string;
  syncStatus: SyncStatus;
}

interface StoredAuditRow {
  id: string;
  kind: SyncAuditKind;
  detailJson: string;
  createdAt: string;
}

export interface InMemoryStorageAdapterOptions {
  /** Optional AES-256-GCM cipher (see sqlite-cipher.ts). Without it, rows are stored as plaintext. */
  cipher?: Aes256GcmSqliteCipher;
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private catalog = new Map<string, StoredCatalogRow>();
  private queue = new Map<string, StoredQueueRow>();
  private audit: StoredAuditRow[] = [];
  private parked = new Map<string, ParkedBasket>();
  /**
   * Mutable only for key rotation: `reEncryptAllRecords` swaps in
   * the rotated cipher after the rewrite commits. Nothing else
   * reassigns it.
   */
  private cipher?: Aes256GcmSqliteCipher;
  private closed = false;

  constructor(options: InMemoryStorageAdapterOptions = {}) {
    this.cipher = options.cipher;
  }

  private enc(value: string | null): string | null {
    if (value === null || this.cipher === undefined) {
      return value;
    }
    return this.cipher.encrypt(value);
  }

  private dec(value: string | null): string | null {
    if (value === null || this.cipher === undefined) {
      return value;
    }
    return this.cipher.decrypt(value);
  }

  private catalogToStored(entry: CatalogCacheEntry): StoredCatalogRow {
    return {
      variantId: entry.variantId,
      sku: entry.sku,
      barcode: entry.barcode,
      name: this.enc(entry.name) as string,
      pricePence: this.enc(entry.pricePence.toString()) as string,
      priceBookPricePence:
        entry.priceBookPricePence === null ? null : (this.enc(entry.priceBookPricePence.toString()) as string),
      taxRateKind: this.enc(entry.taxRateKind),
      taxRatePercent: this.enc(entry.taxRatePercent),
      stockOnHand: entry.stockOnHand === null ? null : (this.enc(entry.stockOnHand.toString()) as string),
      stockComputedAt: this.enc(entry.stockComputedAt),
      requiresChallenge25: entry.requiresChallenge25,
      minAge: entry.minAge,
      updatedAt: entry.updatedAt,
    };
  }

  private catalogFromStored(row: StoredCatalogRow): CatalogCacheEntry {
    const priceBook = this.dec(row.priceBookPricePence);
    const stock = this.dec(row.stockOnHand);
    return {
      variantId: row.variantId,
      sku: row.sku,
      barcode: row.barcode,
      name: this.dec(row.name) as string,
      pricePence: BigInt(this.dec(row.pricePence) as string),
      priceBookPricePence: priceBook === null ? null : BigInt(priceBook),
      taxRateKind: this.dec(row.taxRateKind),
      taxRatePercent: this.dec(row.taxRatePercent),
      stockOnHand: stock === null ? null : BigInt(stock),
      stockComputedAt: this.dec(row.stockComputedAt),
      requiresChallenge25: row.requiresChallenge25,
      minAge: row.minAge,
      updatedAt: row.updatedAt,
    };
  }

  private queueFromStored(row: StoredQueueRow): QueuedOrder {
    return {
      localId: row.localId,
      idempotencyKey: row.idempotencyKey,
      tenantId: row.tenantId,
      locationId: row.locationId,
      registerId: row.registerId,
      orderPayloadJson: this.dec(row.orderPayloadJson) as string,
      tenderTotalPence: BigInt(this.dec(row.tenderTotalPence) as string),
      createdAt: row.createdAt,
      syncStatus: row.syncStatus,
    };
  }

  /**
   * Diagnostics / test-only accessor: the stored form of the rows
   * (ciphertext envelopes when a cipher is configured). Never use in
   * production paths — read through the StorageAdapter methods.
   */
  debugStoredRows(): {
    catalog: StoredCatalogRow[];
    queue: StoredQueueRow[];
    audit: StoredAuditRow[];
  } {
    return {
      catalog: [...this.catalog.values()].map((row) => ({ ...row })),
      queue: [...this.queue.values()].map((row) => ({ ...row })),
      audit: this.audit.map((row) => ({ ...row })),
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Storage adapter is closed');
    }
  }

  async upsertCatalog(entries: CatalogCacheEntry[]): Promise<void> {
    this.assertOpen();
    for (const entry of entries) {
      this.catalog.set(entry.variantId, this.catalogToStored(entry));
    }
  }

  async listCatalog(): Promise<CatalogCacheEntry[]> {
    this.assertOpen();
    return [...this.catalog.values()].map((row) => this.catalogFromStored(row));
  }

  async findCatalogBySku(sku: string): Promise<CatalogCacheEntry | undefined> {
    this.assertOpen();
    for (const row of this.catalog.values()) {
      if (row.sku === sku) {
        return this.catalogFromStored(row);
      }
    }
    return undefined;
  }

  async findCatalogByBarcode(barcode: string): Promise<CatalogCacheEntry | undefined> {
    this.assertOpen();
    for (const row of this.catalog.values()) {
      if (row.barcode !== null && row.barcode === barcode) {
        return this.catalogFromStored(row);
      }
    }
    return undefined;
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
    for (const existing of this.queue.values()) {
      if (existing.idempotencyKey === order.idempotencyKey) {
        throw new Error(`Duplicate idempotency key in local queue: ${order.idempotencyKey}`);
      }
    }
    const row: StoredQueueRow = {
      localId: randomUUID(),
      syncStatus: 'queued',
      idempotencyKey: order.idempotencyKey,
      tenantId: order.tenantId,
      locationId: order.locationId,
      registerId: order.registerId,
      orderPayloadJson: this.enc(order.orderPayloadJson) as string,
      tenderTotalPence: this.enc(order.tenderTotalPence.toString()) as string,
      createdAt: order.createdAt,
    };
    this.queue.set(row.localId, row);
    return this.queueFromStored(row);
  }

  async listQueuedOrders(): Promise<QueuedOrder[]> {
    this.assertOpen();
    return [...this.queue.values()]
      .filter((row) => row.syncStatus === 'queued' || row.syncStatus === 'syncing')
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.localId.localeCompare(b.localId)
          : a.createdAt.localeCompare(b.createdAt),
      )
      .map((row) => this.queueFromStored(row));
  }

  async listAllQueue(): Promise<QueuedOrder[]> {
    this.assertOpen();
    return [...this.queue.values()]
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.localId.localeCompare(b.localId)
          : a.createdAt.localeCompare(b.createdAt),
      )
      .map((row) => this.queueFromStored(row));
  }

  async updateQueueStatus(localId: string, status: SyncStatus): Promise<void> {
    this.assertOpen();
    const row = this.queue.get(localId);
    if (row === undefined) {
      throw new Error(`Unknown queued order: ${localId}`);
    }
    this.queue.set(localId, { ...row, syncStatus: status });
  }

  async logSyncAudit(kind: SyncAuditKind, detail: unknown): Promise<void> {
    this.assertOpen();
    this.audit.push({
      id: randomUUID(),
      kind,
      detailJson: this.enc(JSON.stringify(detail)) as string,
      createdAt: new Date().toISOString(),
    });
  }

  async listSyncAudit(): Promise<SyncAuditEntry[]> {
    this.assertOpen();
    return this.audit.map((row) => ({
      id: row.id,
      kind: row.kind,
      detailJson: this.dec(row.detailJson) as string,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Master key-ID rotation for stored data (Build-07, Objective 2).
   * Same semantics as `NodeSqliteStorageAdapter.reEncryptAllRecords`:
   * re-encrypts every encrypted field in the catalog, queue and audit
   * maps to a fresh `newKeyId`/`newSecret`, then swaps the adapter to
   * the rotated cipher. Runs inside `transaction()` (snapshot +
   * restore), so a tampered row aborts the whole rewrite and the old
   * cipher stays in place. Returns the rotated cipher plus
   * per-table record counts.
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
      const catalogCols = [
        'name',
        'pricePence',
        'priceBookPricePence',
        'taxRateKind',
        'taxRatePercent',
        'stockOnHand',
        'stockComputedAt',
      ] as const;
      const catalogRows = [...this.catalog.values()];
      const catalogValues: string[] = [];
      for (const row of catalogRows) {
        for (const col of catalogCols) {
          const value = row[col];
          if (value !== null) {
            catalogValues.push(value);
          }
        }
      }
      const catalogRotated = oldCipher.reEncryptAllRecords(catalogValues, newKeyId, newSecret);
      rotated = catalogRotated.cipher;
      let i = 0;
      for (const row of catalogRows) {
        const next = (col: (typeof catalogCols)[number]): string | null => {
          const value = row[col];
          if (value === null) {
            return null;
          }
          const out = catalogRotated.records[i] as string;
          i += 1;
          return out;
        };
        this.catalog.set(row.variantId, {
          ...row,
          name: next('name') as string,
          pricePence: next('pricePence') as string,
          priceBookPricePence: next('priceBookPricePence'),
          taxRateKind: next('taxRateKind'),
          taxRatePercent: next('taxRatePercent'),
          stockOnHand: next('stockOnHand'),
          stockComputedAt: next('stockComputedAt'),
        });
        counts.catalog += 1;
      }

      const queueRows = [...this.queue.values()];
      const queueValues: string[] = [];
      for (const row of queueRows) {
        queueValues.push(row.orderPayloadJson, row.tenderTotalPence);
      }
      const queueRotated = oldCipher.reEncryptAllRecords(queueValues, newKeyId, newSecret);
      queueRows.forEach((row, index) => {
        this.queue.set(row.localId, {
          ...row,
          orderPayloadJson: queueRotated.records[index * 2] as string,
          tenderTotalPence: queueRotated.records[index * 2 + 1] as string,
        });
        counts.queue += 1;
      });

      const auditValues = this.audit.map((row) => row.detailJson);
      const auditRotated = oldCipher.reEncryptAllRecords(auditValues, newKeyId, newSecret);
      this.audit = this.audit.map((row, index) => ({
        ...row,
        detailJson: auditRotated.records[index] as string,
      }));
      counts.audit = this.audit.length;
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
    const row: ParkedBasket = { localId: randomUUID(), ...basket };
    this.parked.set(row.localId, row);
    return { ...row };
  }

  async listParkedBaskets(): Promise<ParkedBasket[]> {
    this.assertOpen();
    return [...this.parked.values()].map((row) => ({ ...row }));
  }

  async deleteParkedBasket(localId: string): Promise<void> {
    this.assertOpen();
    this.parked.delete(localId);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const catalogSnapshot = new Map(this.catalog);
    const queueSnapshot = new Map(this.queue);
    const auditSnapshot = [...this.audit];
    const parkedSnapshot = new Map(this.parked);
    try {
      return await fn();
    } catch (error) {
      this.catalog = catalogSnapshot;
      this.queue = queueSnapshot;
      this.audit = auditSnapshot;
      this.parked = parkedSnapshot;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
  }
}
