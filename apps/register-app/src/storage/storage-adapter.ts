/**
 * Local storage adapter interface (Build-04, Objective 1).
 *
 * The register is offline-first: catalogue, queue and audit live on the
 * device. Two implementations exist — an in-memory driver (used by all
 * automated tests) and a SQLite driver backed by Node 24's built-in
 * `node:sqlite` (no native dependency, no compiler toolchain).
 * Encryption at rest (Build-05, Objective 3): both drivers accept an
 * optional `Aes256GcmSqliteCipher` (see sqlite-cipher.ts). With one
 * supplied, the sensitive payload columns of local_catalog_cache,
 * local_cash_queue and sync_audit_log are stored as AES-256-GCM
 * envelopes and authenticated/decrypted on read; tampering throws
 * LOCAL_STORAGE_TAMPERED. No card data, PINs, or full gift/voucher
 * codes are ever written to local storage.
 *
 * Money is bigint pence in memory. In SQLite it is stored as INTEGER
 * (node:sqlite binds JS bigint to SQLite integers losslessly).
 */

export interface CatalogCacheEntry {
  variantId: string;
  sku: string;
  barcode: string | null;
  name: string;
  /** Base price in pence. */
  pricePence: bigint;
  /** Active price-book price when one applies, else null. */
  priceBookPricePence: bigint | null;
  taxRateKind: string | null;
  taxRatePercent: string | null;
  /** Cached on-hand in the default warehouse — DISPLAY HINT ONLY, never authoritative for online sales. */
  stockOnHand: bigint | null;
  /** When the cached stock level was computed (server time, ISO string). */
  stockComputedAt: string | null;
  /** True when the variant carries a Challenge 25 age restriction. */
  requiresChallenge25: boolean;
  /**
   * Minimum legal age in years for this variant (from the server's
   * age_restrictions.min_age_years), or null when the variant has no
   * age restriction. Informational: the Challenge 25 gate itself
   * always verifies the 25 threshold — minAge is the product's legal
   * minimum, not the verification threshold (Build-08, Objective 2).
   */
  minAge: number | null;
  updatedAt: string;
}

export type SyncStatus = 'queued' | 'syncing' | 'synced' | 'conflict';

export interface QueuedOrder {
  localId: string;
  idempotencyKey: string;
  tenantId: string;
  locationId: string;
  registerId: string;
  /** JSON string of the FlushOrder payload (see apps/api sync.dto.ts). */
  orderPayloadJson: string;
  tenderTotalPence: bigint;
  createdAt: string;
  syncStatus: SyncStatus;
}

export type SyncAuditKind = 'handshake' | 'flush' | 'conflict' | 'price_discrepancy';

export interface SyncAuditEntry {
  id: string;
  kind: SyncAuditKind;
  /** JSON string of the detail object. */
  detailJson: string;
  createdAt: string;
}

export interface ParkedBasket {
  localId: string;
  tenantId: string;
  locationId: string;
  registerId: string;
  /** JSON string of the basket lines. */
  basketJson: string;
  createdAt: string;
}

/**
 * StorageAdapter — the only storage surface the register controllers
 * use. `transaction` runs the callback atomically: on throw, the
 * in-memory driver restores its snapshot and the SQLite driver rolls
 * the transaction back.
 */
export interface StorageAdapter {
  upsertCatalog(entries: CatalogCacheEntry[]): Promise<void>;
  listCatalog(): Promise<CatalogCacheEntry[]>;
  findCatalogBySku(sku: string): Promise<CatalogCacheEntry | undefined>;
  findCatalogByBarcode(barcode: string): Promise<CatalogCacheEntry | undefined>;

  enqueueOrder(order: {
    idempotencyKey: string;
    tenantId: string;
    locationId: string;
    registerId: string;
    orderPayloadJson: string;
    tenderTotalPence: bigint;
    createdAt: string;
  }): Promise<QueuedOrder>;
  /** Queued rows in FIFO order (created_at ASC, then local id). */
  listQueuedOrders(): Promise<QueuedOrder[]>;
  listAllQueue(): Promise<QueuedOrder[]>;
  updateQueueStatus(localId: string, status: SyncStatus): Promise<void>;

  logSyncAudit(kind: SyncAuditKind, detail: unknown): Promise<void>;
  listSyncAudit(): Promise<SyncAuditEntry[]>;

  parkBasket(basket: {
    tenantId: string;
    locationId: string;
    registerId: string;
    basketJson: string;
    createdAt: string;
  }): Promise<ParkedBasket>;
  listParkedBaskets(): Promise<ParkedBasket[]>;
  deleteParkedBasket(localId: string): Promise<void>;

  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}
