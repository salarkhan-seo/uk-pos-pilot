/**
 * Register Tablet UI — HTTP server / shell (Build-06, Objective 3).
 *
 * Dependency-free: Node's built-in `http` only. Serves the rendered
 * register page at GET / and a health check at GET /health.
 *
 * The shell wires the REAL view-models: SellController, SplitTenderController,
 * TillSessionController and the simulated Stripe Terminal adapter — and,
 * new in Build-06, the LIVE backend: catalogue handshake + FIFO flush
 * through SyncClient over `createHttpSyncTransport`, online sales through
 * LiveSalesClient, manager approvals through LiveApprovalsClient, and PIN
 * login through RegisterApiClient (the session token then drives the
 * Bearer-authenticated sync calls).
 *
 * Live vs offline (how the mode is decided):
 *   effective online = manualOnline && apiReachable !== false.
 *   - manualOnline is the cashier's toggle (POST /action toggle-online).
 *   - apiReachable is the last probe of GET /sales/status (true = the API
 *     answered, false = unreachable, null = not probed yet). The shell
 *     probes once at creation and the E2E worker / tests can call the
 *     exposed probeApi() again at any time.
 *   When the API is unreachable the shell still boots and serves every
 *   page with an explicit offline/unreachable banner; cash sales queue
 *   locally and card/loyalty/gift-card/voucher actions stay disabled.
 *
 * No till-session endpoints exist on apps/api (verified Build-06):
 * ReportingService has the methods but no controller exposes them, so
 * till sessions stay LOCAL (LocalSessionTracker, expected cash from
 * locally recorded movements only; Z-report ids are prefixed `local-`)
 * and getZReport goes live only for server-issued ids.
 *
 * W-12 live mapping (only POST /v1/sales/payment-attempts/:id/outcome
 * exists for attempts; the payments controller exposes no resolve
 * routes): poll / reconcile = the operator keys in the terminal result
 * and the outcome is recorded against the attempt. A declined attempt
 * blocks completion and the tender sum still counts it, so the only
 * live recovery is a manager void: the W-12 manager form takes the
 * manager PIN, creates a void_post_tender approval (POST /v1/approvals),
 * voids the order (POST /v1/sales/orders/:id/void), and the same basket
 * is re-taken as a fresh order. Standalone = the same approval, then the
 * attempt is recorded approved with the physical terminal reference.
 *
 * Storage: by default the shell uses in-memory storage seeded with the
 * demo catalogue (the Build-04/05 demo path). A direct run uses an
 * encrypted node:sqlite file (REGISTER_SQLITE_PATH, default
 * data/register.sqlite relative to the working directory; cipher from
 * REGISTER_APP_DEVICE_SECRET via Aes256GcmSqliteCipher). When the device
 * secret is absent the file is stored unencrypted and the page shows a
 * warning banner. If the ciphertext cannot be decrypted at startup
 * (wrong key / tampered file) the shell falls back to in-memory storage
 * with a warning banner instead of 500ing. Demo entries are never
 * seeded into a SQLite file, so a live catalogue stays clean.
 *
 * Environment:
 *   REGISTER_API_BASE_URL  API base URL (default http://localhost:3127)
 *   REGISTER_API_KEY       API key used as the Bearer fallback until a
 *                          PIN login stores a session token
 *   REGISTER_TENANT_ID / REGISTER_LOCATION_ID / REGISTER_REGISTER_ID /
 *   REGISTER_USER_ID / REGISTER_ROLES   actor defaults (demo-*)
 *   REGISTER_UI_PORT       UI port (default 3130)
 *   REGISTER_SQLITE_PATH   SQLite file path (direct run only)
 *   REGISTER_APP_DEVICE_SECRET / REGISTER_APP_DEVICE_KEY_ID  local cipher
 *   REGISTER_API_TIMEOUT_MS  live request timeout (default 15000)
 *   DEMO_SEED_ON_BOOT  when 'true', default the actor ids + API key to
 *                          the demo-seeded tenant (see demo-seed.ts) and
 *                          do NOT seed the in-memory demo catalogue —
 *                          the live catalogue comes from the API sync.
 *                          Explicit REGISTER_* vars still win.
 *
 * Start: `pnpm --filter @uk-pos/register-app build && node dist/apps/register-app/src/ui/server.js`
 * (or `node --loader`… no — plain node on the compiled output).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEMO_API_KEY,
  DEMO_CASHIER_ID,
  DEMO_LOCATION_ID,
  DEMO_REGISTER_ID,
  DEMO_TENANT_ID,
} from '@uk-pos/db';
import { InMemoryStorageAdapter } from '../storage/memory-storage';
import { NodeSqliteStorageAdapter } from '../storage/sqlite-storage';
import { Aes256GcmSqliteCipher, LOCAL_STORAGE_TAMPERED } from '../storage/sqlite-cipher';
import type {
  CatalogCacheEntry,
  ParkedBasket,
  QueuedOrder,
  StorageAdapter,
  SyncAuditEntry,
  SyncAuditKind,
  SyncStatus,
} from '../storage/storage-adapter';
import { SellController, type SellControllerOptions } from '../sell/sell-controller';
import { SplitTenderController, type TenderKind } from '../sell/split-tender';
import { TillSessionController, type ReportingClient } from '../session/till-session';
import type { RoleName } from '../../../api/src/common/roles';
import type { AgeVerificationWire } from '../../../api/src/modules/sales/sales.service';
import { SimulatedStripeTerminalAdapter } from '../hardware/stripe-terminal';
import { SyncClient, type SyncTransport } from '../sync/sync-client';
import { RegisterApiClient } from '../api/client';
import {
  CompositeReportingClient,
  LiveApprovalsClient,
  LiveSalesClient,
  createHttpSyncTransport,
  probeApi as probeApiEndpoint,
  type ActorHeaders,
} from '../api/live-transport';
import {
  snapshotRegisterUiState,
  type RegisterUiFlushSummary,
  type RegisterUiLiveOrder,
  type RegisterUiLiveOrderOpen,
  type RegisterUiPendingCardAttempt,
  type RegisterUiState,
} from './state';
import { renderRegisterPage } from './renderer';

export const REGISTER_UI_DEFAULT_PORT = 3130;
export const REGISTER_API_DEFAULT_BASE_URL = 'http://localhost:3127';

const DEMO_CATALOGUE: CatalogCacheEntry[] = [
  {
    variantId: 'demo-v-1', sku: 'WIDGET-1', barcode: '5012345678900', name: 'Demo Widget',
    pricePence: 1200n, priceBookPricePence: 1000n, taxRateKind: 'standard', taxRatePercent: '20.00',
    stockOnHand: 25n, stockComputedAt: '2026-11-13T12:00:00.000Z', requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-13T12:00:00.000Z',
  },
  {
    variantId: 'demo-v-2', sku: 'GADGET-1', barcode: '5012345678901', name: 'Demo Gadget',
    pricePence: 1050n, priceBookPricePence: null, taxRateKind: 'reduced', taxRatePercent: '5.00',
    stockOnHand: 12n, stockComputedAt: '2026-11-13T12:00:00.000Z', requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-13T12:00:00.000Z',
  },
  {
    variantId: 'demo-v-3', sku: 'VAPE-1', barcode: '5012345678902', name: 'Demo Vape Liquid',
    pricePence: 800n, priceBookPricePence: null, taxRateKind: 'standard', taxRatePercent: '20.00',
    stockOnHand: 40n, stockComputedAt: '2026-11-13T12:00:00.000Z', requiresChallenge25: true,
    // Vapes are 18+ by law; the Challenge 25 gate still verifies the
    // 25 threshold — minAge is the legal minimum, not the threshold.
    minAge: 18,
    updatedAt: '2026-11-13T12:00:00.000Z',
  },
];

/** Fake reporting client for the demo shell — no live API is called. */
class DemoReportingClient implements ReportingClient {
  private sessions = 0;
  async openSession(): Promise<{ sessionId: string; warning: string | null }> {
    this.sessions += 1;
    return { sessionId: `demo-session-${this.sessions}`, warning: null };
  }
  async recordCashMovement(): Promise<{ movementId: string }> {
    return { movementId: `demo-movement-${Date.now()}` };
  }
  async endSession(sessionId: string): Promise<{ sessionId: string; expectedCashPence: bigint }> {
    return { sessionId, expectedCashPence: 10000n };
  }
  async closeSession(input: { sessionId: string }): Promise<{ sessionId: string; zReportId: string; zNumber: string }> {
    return { sessionId: input.sessionId, zReportId: `demo-z-${Date.now()}`, zNumber: `Z-${this.sessions}` };
  }
  async getZReport(zReportId: string): Promise<{ zReportId: string; zNumber: string }> {
    return { zReportId, zNumber: 'Z-demo' };
  }
}

/**
 * StorageAdapter that delegates to a replaceable inner adapter, so a
 * tampered/uncryptable SQLite file can be swapped for in-memory
 * storage at runtime without the view-models noticing.
 */
class SwitchableStorage implements StorageAdapter {
  constructor(private current: StorageAdapter) {}

  replace(next: StorageAdapter): void {
    this.current = next;
  }

  upsertCatalog(entries: CatalogCacheEntry[]): Promise<void> {
    return this.current.upsertCatalog(entries);
  }
  listCatalog(): Promise<CatalogCacheEntry[]> {
    return this.current.listCatalog();
  }
  findCatalogBySku(sku: string): Promise<CatalogCacheEntry | undefined> {
    return this.current.findCatalogBySku(sku);
  }
  findCatalogByBarcode(barcode: string): Promise<CatalogCacheEntry | undefined> {
    return this.current.findCatalogByBarcode(barcode);
  }
  enqueueOrder(order: {
    idempotencyKey: string;
    tenantId: string;
    locationId: string;
    registerId: string;
    orderPayloadJson: string;
    tenderTotalPence: bigint;
    createdAt: string;
  }): Promise<QueuedOrder> {
    return this.current.enqueueOrder(order);
  }
  listQueuedOrders(): Promise<QueuedOrder[]> {
    return this.current.listQueuedOrders();
  }
  listAllQueue(): Promise<QueuedOrder[]> {
    return this.current.listAllQueue();
  }
  updateQueueStatus(localId: string, status: SyncStatus): Promise<void> {
    return this.current.updateQueueStatus(localId, status);
  }
  logSyncAudit(kind: SyncAuditKind, detail: unknown): Promise<void> {
    return this.current.logSyncAudit(kind, detail);
  }
  listSyncAudit(): Promise<SyncAuditEntry[]> {
    return this.current.listSyncAudit();
  }
  parkBasket(basket: {
    tenantId: string;
    locationId: string;
    registerId: string;
    basketJson: string;
    createdAt: string;
  }): Promise<ParkedBasket> {
    return this.current.parkBasket(basket);
  }
  listParkedBaskets(): Promise<ParkedBasket[]> {
    return this.current.listParkedBaskets();
  }
  deleteParkedBasket(localId: string): Promise<void> {
    return this.current.deleteParkedBasket(localId);
  }
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.current.transaction(fn);
  }
  close(): void {
    this.current.close();
  }
}

export interface RegisterUiServerOptions {
  /** API base URL (default REGISTER_API_BASE_URL / http://localhost:3127). */
  apiBaseUrl?: string;
  /** API key used as the Bearer fallback until a PIN login stores a token. */
  apiKey?: string | null;
  tenantId?: string;
  locationId?: string;
  registerId?: string;
  userId?: string;
  roles?: string[];
  /** Cashier's manual online/offline toggle initial value (default true). */
  manualOnline?: boolean;
  /** Storage adapter to use instead of the default in-memory one. */
  storage?: StorageAdapter;
  /**
   * SQLite file path for local storage. Undefined = in-memory storage
   * (the demo path). Null = in-memory storage explicitly.
   */
  sqlitePath?: string | null;
  /** Device secret for the local AES-256-GCM cipher (REGISTER_APP_DEVICE_SECRET). */
  deviceSecret?: string | null;
  /** Key id for the device secret (default 'k1'). */
  deviceKeyId?: string;
  /**
   * Seed the demo catalogue when storage is empty. Defaults to true
   * only for the default in-memory path — a SQLite file is never
   * seeded, so a live catalogue stays clean.
   */
  seedDemoCatalogue?: boolean;
  /** Sync transport to use instead of the HTTP one (tests / E2E). */
  syncTransport?: SyncTransport;
  /** Live sales client to use instead of the HTTP one. */
  salesClient?: LiveSalesClient;
  /** Live approvals client to use instead of the HTTP one. */
  approvalsClient?: LiveApprovalsClient;
  /** Typed API client to use instead of the HTTP one. */
  apiClient?: RegisterApiClient;
  /** Reporting client to use instead of the local tracker + live read. */
  reportingClient?: ReportingClient;
  /** Handshake at creation when the API is reachable (default true). */
  autoSync?: boolean;
  /** Fetch implementation for the live clients (default globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Clock for the view-models (default () => new Date()). */
  now?: () => Date;
}

export interface RegisterUiShell {
  server: Server;
  port: number;
  /** Current rendered state (for tests / embedding). */
  getState: () => Promise<RegisterUiState>;
  /** Probe GET /sales/status; updates apiReachable and returns it. */
  probeApi: () => Promise<boolean>;
  /** Run a catalogue handshake now; throws when offline. */
  syncCatalogue: () => Promise<void>;
  /** Flush the offline queue now; throws when offline. */
  syncFlush: () => Promise<RegisterUiFlushSummary>;
}

/**
 * Read the shell's options from the environment (see the header doc).
 *
 * Build-08 Objective 3: when DEMO_SEED_ON_BOOT=true, the actor ids and
 * API key default to the demo-seeded tenant (packages/db demo-seed.ts),
 * so booting the shell with only that flag runs live against the seeded
 * API. Explicit REGISTER_* vars still win; without the flag the old
 * demo-* defaults apply unchanged.
 */
export function registerUiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RegisterUiServerOptions {
  const demoSeed = env.DEMO_SEED_ON_BOOT === 'true';
  return {
    apiBaseUrl: env.REGISTER_API_BASE_URL ?? REGISTER_API_DEFAULT_BASE_URL,
    apiKey: env.REGISTER_API_KEY ?? (demoSeed ? DEMO_API_KEY : null),
    tenantId: env.REGISTER_TENANT_ID ?? (demoSeed ? DEMO_TENANT_ID : undefined),
    locationId: env.REGISTER_LOCATION_ID ?? (demoSeed ? DEMO_LOCATION_ID : undefined),
    registerId: env.REGISTER_REGISTER_ID ?? (demoSeed ? DEMO_REGISTER_ID : undefined),
    userId: env.REGISTER_USER_ID ?? (demoSeed ? DEMO_CASHIER_ID : undefined),
    roles:
      env.REGISTER_ROLES === undefined
        ? undefined
        : env.REGISTER_ROLES.split(',').map((role) => role.trim()).filter(Boolean),
    sqlitePath: env.REGISTER_SQLITE_PATH ?? undefined,
    deviceSecret: env.REGISTER_APP_DEVICE_SECRET ?? null,
    deviceKeyId: env.REGISTER_APP_DEVICE_KEY_ID,
    // With the flag the live catalogue comes from the API sync — the
    // in-memory demo catalogue would only pollute the till with
    // duplicate demo items under different ids.
    seedDemoCatalogue: demoSeed ? false : undefined,
  };
}

function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createRegisterUiServer(
  port: number = REGISTER_UI_DEFAULT_PORT,
  options: RegisterUiServerOptions = {},
): RegisterUiShell {
  const apiBaseUrl = (options.apiBaseUrl ?? REGISTER_API_DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  // -- Actor ---------------------------------------------------------------
  const KNOWN_ROLES: readonly string[] = ['cashier', 'manager', 'admin', 'owner'];
  /**
   * Roles, validated against the known set. The array is mutated in
   * place by pinLogin so the SellController (which holds the options
   * object by reference) sees the logged-in user's limits.
   */
  const roles: RoleName[] = (options.roles ?? ['cashier']).filter((role): role is RoleName =>
    KNOWN_ROLES.includes(role),
  );
  if (roles.length === 0) roles.push('cashier');
  const actor: ActorHeaders = {
    tenantId: options.tenantId ?? 'demo-tenant',
    userId: options.userId ?? 'demo-user',
    locationId: options.locationId ?? 'demo-location',
    roles,
  };
  /** The cashier who requested an approval (never the approver). */
  const cashierUserId = actor.userId;
  const registerId = options.registerId ?? 'demo-register-1';

  // -- Storage -------------------------------------------------------------
  const storageWarning: { value: string | null } = { value: null };
  let storageVerified = false;
  const seedDemoCatalogue =
    options.seedDemoCatalogue ?? (options.storage === undefined && options.sqlitePath == null);
  let innerStorage: StorageAdapter;
  if (options.storage !== undefined) {
    innerStorage = options.storage;
  } else if (options.sqlitePath != null) {
    mkdirSync(dirname(options.sqlitePath), { recursive: true });
    let cipher: Aes256GcmSqliteCipher | undefined;
    if (options.deviceSecret != null && options.deviceSecret !== '') {
      cipher = new Aes256GcmSqliteCipher({ secret: options.deviceSecret, keyId: options.deviceKeyId ?? 'k1' });
    } else {
      storageWarning.value =
        'Local storage is NOT encrypted — set REGISTER_APP_DEVICE_SECRET before trading so the offline queue is encrypted at rest.';
    }
    innerStorage = new NodeSqliteStorageAdapter(options.sqlitePath, { cipher });
  } else {
    innerStorage = new InMemoryStorageAdapter();
  }
  const storage = new SwitchableStorage(innerStorage);

  /**
   * Read the catalogue once to prove the storage decrypts. On a tamper
   * error the shell swaps to in-memory storage and records a warning
   * instead of failing the request.
   */
  async function ensureStorageHealthy(): Promise<void> {
    if (storageVerified) return;
    try {
      await storage.listCatalog();
      storageVerified = true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error as { code?: unknown }).code === LOCAL_STORAGE_TAMPERED
      ) {
        storage.replace(new InMemoryStorageAdapter());
        storageWarning.value =
          'Local storage could not be decrypted (wrong device key or tampered file) — switched to in-memory storage. Offline sales queued now will not survive a restart.';
        storageVerified = true;
        return;
      }
      throw error;
    }
  }

  // Seed the demo catalogue into empty storage (in-memory/demo path only).
  void (async () => {
    try {
      await ensureStorageHealthy();
      if (seedDemoCatalogue && (await storage.listCatalog()).length === 0) {
        await storage.upsertCatalog(DEMO_CATALOGUE);
      }
    } catch {
      // Seeding failure surfaces on the first request via ensureStorageHealthy.
    }
  })();

  // -- Connectivity --------------------------------------------------------
  let manualOnline = options.manualOnline ?? true;
  let apiReachable: boolean | null = null;
  let offlineSinceMs: number | null = null;
  const effectiveOnline = (): boolean => manualOnline && apiReachable !== false;
  function refreshOnline(): void {
    const online = effectiveOnline();
    if (!online && offlineSinceMs === null) offlineSinceMs = Date.now();
    if (online) offlineSinceMs = null;
  }
  // Stamp the offline start when the shell boots offline (manual toggle
  // off, or the API already known unreachable) so the 24h bound is real.
  refreshOnline();

  // -- Live clients --------------------------------------------------------
  const apiClient =
    options.apiClient ??
    new RegisterApiClient({ baseUrl: apiBaseUrl, sessionToken: options.apiKey ?? null });
  const getActor = (): ActorHeaders => actor;
  const syncTransport =
    options.syncTransport ??
    createHttpSyncTransport({
      baseUrl: apiBaseUrl,
      getToken: () => apiClient.sessionToken ?? options.apiKey ?? null,
      getActor,
      fetchImpl,
    });
  const salesClient =
    options.salesClient ??
    new LiveSalesClient({
      baseUrl: apiBaseUrl,
      getActor,
      // Build-10: sales routes are AuthGuarded — the PIN-session token
      // when logged in, else the REGISTER_API_KEY fallback.
      getToken: () => apiClient.sessionToken ?? options.apiKey ?? null,
      fetchImpl,
    });
  const approvalsClient =
    options.approvalsClient ?? new LiveApprovalsClient(apiBaseUrl, getActor, fetchImpl);

  const syncClient = new SyncClient(storage, syncTransport, actor.tenantId, actor.locationId, registerId, { now });

  // -- View-models ---------------------------------------------------------
  let notice: string | null = null;
  let pinApprovalRef: string | null = null;
  let split: SplitTenderController | null = null;
  let splitFirstTenderAtMs: number | null = null;
  let tillView: { expectedCashPence: bigint | null; zReport: { zReportId: string; zNumber: string } | null } = {
    expectedCashPence: null,
    zReport: null,
  };
  let receiptCounter = 1;

  // Live-sale state (reset after completion or a manager void).
  let liveOrderId: string | null = null;
  let liveOrderTotalPence: bigint | null = null;
  let liveOrder: RegisterUiLiveOrder | null = null;
  let liveOrderOpen: RegisterUiLiveOrderOpen | null = null;
  let pendingCardAttempts: RegisterUiPendingCardAttempt[] = [];
  /** How many of the current split's tenders have been sent to the server. */
  let sentTenderCount = 0;
  let liveCatalogue = false;
  let lastSyncAt: string | null = null;
  let lastSyncError: string | null = null;
  let lastFlush: RegisterUiFlushSummary | null = null;
  let searchQuery: string | null = null;
  let searchResults: Array<{ sku: string; name: string; pricePence: bigint }> | null = null;

  const reader = new SimulatedStripeTerminalAdapter();
  const sellOptions: SellControllerOptions = {
    tenantId: actor.tenantId,
    locationId: actor.locationId,
    registerId,
    roles,
    barcodeMode: 'price_embedded',
    isOnline: () => effectiveOnline(),
    offlineSinceMs: () => offlineSinceMs,
    now,
  };
  const sell = new SellController(storage, sellOptions);
  const reporting: ReportingClient =
    options.reportingClient ??
    new CompositeReportingClient({
      baseUrl: apiBaseUrl,
      getToken: () => apiClient.sessionToken ?? options.apiKey ?? null,
      fetchImpl,
    });
  const till = new TillSessionController(reporting, registerId);

  void reader.connect('S700', 'wifi');

  // -- Live operations -----------------------------------------------------

  async function probe(): Promise<boolean> {
    const ok = await probeApiEndpoint(apiBaseUrl, fetchImpl);
    apiReachable = ok;
    refreshOnline();
    return ok;
  }

  /**
   * Catalogue handshake. Updates the sell controller's barcode mode
   * (the options object is held by reference) and location, clears
   * the demo flag, and rebuilds the quick keys from the live catalogue.
   */
  async function syncCatalogue(): Promise<void> {
    if (!effectiveOnline()) {
      throw new Error('Register is offline — catalogue sync needs connectivity');
    }
    const response = await syncClient.handshake(lastSyncAt);
    if (response.catalogue.barcodeMode !== null) {
      sellOptions.barcodeMode = response.catalogue.barcodeMode;
    }
    if (response.locationId !== undefined && response.locationId !== '') {
      actor.locationId = response.locationId;
      sellOptions.locationId = response.locationId;
    }
    lastSyncAt = response.serverTime;
    lastSyncError = null;
    liveCatalogue = true;
  }

  async function syncFlush(): Promise<RegisterUiFlushSummary> {
    if (!effectiveOnline()) {
      throw new Error('Register is offline — flushing the queue needs connectivity');
    }
    const results = await syncClient.flushQueue();
    const summary: RegisterUiFlushSummary = {
      synced: 0,
      conflicts: 0,
      failed: 0,
      at: new Date().toISOString(),
    };
    for (const result of results) {
      if (result.outcome.status === 'synced' || result.outcome.status === 'replayed') summary.synced += 1;
      else if (result.outcome.status === 'conflict') summary.conflicts += 1;
      else summary.failed += 1;
    }
    lastFlush = summary;
    return summary;
  }

  /**
   * Age verifications to send with a tender / completion (Build-09,
   * Objective 2): one entry per age-restricted line in the basket,
   * carrying the gate's recorded threshold and confirmation time plus
   * the verifying cashier — never a date of birth. Empty when nothing
   * is verified (plain baskets, or a restricted basket before
   * approval — the server then rejects with 422).
   */
  function ageVerificationsForBasket(): AgeVerificationWire[] {
    const threshold = sell.ageGate.verifiedAgeThreshold;
    if (threshold === null) return [];
    const verifiedAt = sell.ageGate.verifiedAtIso ?? new Date().toISOString();
    return sell.ageGate.requiredLines(sell.listLines()).map((line) => ({
      variant_id: line.variantId,
      verified_age_threshold: threshold,
      verified_by_user_id: cashierUserId,
      verified_at: verifiedAt,
    }));
  }

  /** Complete the live order and reset the sale state for the next sale. */
  async function completeLiveOrder(): Promise<void> {
    if (liveOrderId === null) throw new Error('No live order to complete');
    // Build-09, Objective 2: carry the approved Challenge 25
    // verification to the server with the completion request, so the
    // threshold is persisted server-side (age_verification_events)
    // instead of living only in the register's in-memory gate.
    const completed = await salesClient.completeOrder(
      liveOrderId,
      ageVerificationsForBasket(),
    );
    liveOrder = {
      orderId: completed.order.id,
      receiptNumber: completed.receipt.receiptNumber,
      totalPence: BigInt(completed.order.total_pence),
      receiptLines: completed.receipt.lines.map((line) => ({
        taxRateKind: line.taxRateKind,
        taxRatePercent: line.taxRatePercent,
        grossPence: BigInt(line.grossPence),
        vatPence: BigInt(line.vatPence),
        netPence: BigInt(line.netPence),
      })),
    };
    sell.clearBasket();
    split = null;
    splitFirstTenderAtMs = null;
    sentTenderCount = 0;
    liveOrderId = null;
    liveOrderTotalPence = null;
    liveOrderOpen = null;
    pendingCardAttempts = [];
    notice = `Sale completed — receipt #${liveOrder.receiptNumber}, total £${(liveOrder.totalPence / 100n).toString()}.${(liveOrder.totalPence % 100n).toString().padStart(2, '0')}.`;
  }

  /**
   * Send the basket to the API as an order and take its tenders. With
   * no split open the whole server total is taken as a single cash
   * tender; with a split open, every tender is sent in order and card
   * tenders wait for their terminal result before completion.
   */
  async function checkoutOnline(): Promise<void> {
    if (!effectiveOnline()) {
      throw new Error('Register is offline — use the offline cash checkout');
    }
    const lines = sell.listLines();
    if (lines.length === 0) throw new Error('Cannot check out an empty basket');
    if (!sell.ageGate.isSatisfied(lines)) {
      const blocked = sell.ageGate.requiredLines(lines);
      throw new Error(
        `Age verification required before checkout: ${blocked.map((line) => line.sku).join(', ')} — confirm Challenge 25 or log a refusal`,
      );
    }
    if (liveOrderId === null) {
      const created = await salesClient.createOrder({
        locationId: actor.locationId,
        registerId,
        customerId: sell.attachedCustomerId,
        lines: lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity.toString(),
          manualDiscountPence:
            line.manualDiscountPence > 0n ? line.manualDiscountPence.toString() : undefined,
        })),
      });
      liveOrderId = created.id;
      liveOrderTotalPence = BigInt(created.total_pence);
      liveOrderOpen = { orderId: created.id, totalPence: liveOrderTotalPence };
    }
    const serverTotal = liveOrderTotalPence ?? sell.basketTotalPence;
    const tenders = split !== null ? split.listTenders() : [];
    if (split !== null && !split.isComplete) {
      throw new Error(
        `Split tender is not complete — ${split.remaining.toString()}p still to tender before checkout`,
      );
    }
    if (split !== null && split.total !== serverTotal) {
      throw new Error(
        `Server total ${serverTotal.toString()}p differs from the split total ${split.total.toString()}p — clear the split tender and check out again`,
      );
    }
    if (tenders.length === 0) {
      await salesClient.addTender(liveOrderId, {
        tenderType: 'cash',
        amountPence: serverTotal.toString(),
        age_verifications: ageVerificationsForBasket(),
      });
    } else {
      for (let index = sentTenderCount; index < tenders.length; index += 1) {
        const tender = tenders[index]!;
        const added = await salesClient.addTender(liveOrderId, {
          tenderType: tender.kind,
          amountPence: tender.amountPence.toString(),
          age_verifications: ageVerificationsForBasket(),
        });
        sentTenderCount = index + 1;
        if (tender.kind === 'card' && added.payment_attempt_id !== null) {
          pendingCardAttempts.push({
            attemptId: added.payment_attempt_id,
            amountPence: tender.amountPence,
          });
        }
      }
    }
    if (pendingCardAttempts.length > 0) {
      notice = `Card tender${pendingCardAttempts.length > 1 ? 's' : ''} sent — key in the terminal result for each attempt below; the sale cannot complete until every card attempt is approved.`;
      return;
    }
    await completeLiveOrder();
  }

  /**
   * Record a terminal result against a live card attempt. 'unknown'
   * locks the register on the W-12 modal; 'approved' completes the
   * sale once every attempt is approved; 'declined' leaves the order
   * open — the only live recovery is a manager void (W-12 → Manager).
   */
  async function recordCardOutcome(
    attemptId: string,
    outcome: 'approved' | 'declined' | 'unknown',
    providerReference?: string,
  ): Promise<void> {
    await salesClient.recordPaymentAttemptOutcome(attemptId, { outcome, providerReference });
    if (outcome === 'unknown') {
      if (split === null) {
        split = new SplitTenderController(liveOrderTotalPence ?? sell.basketTotalPence);
      }
      split.markCardAttemptUnknown(attemptId);
      notice = 'Payment outcome unknown — register locked (W-12). Resolve it from the modal.';
      return;
    }
    pendingCardAttempts = pendingCardAttempts.filter((attempt) => attempt.attemptId !== attemptId);
    if (outcome === 'approved') {
      if (pendingCardAttempts.length === 0 && liveOrderId !== null) {
        await completeLiveOrder();
      } else {
        notice = `Card attempt approved (${pendingCardAttempts.length} still pending).`;
      }
      return;
    }
    notice =
      'Card declined — the order cannot complete with this tender. Ask a manager to void the order (W-12 → Manager) and re-take the sale from the same basket.';
  }

  // Probe once at creation; handshake when reachable (guarded, never throws).
  void (async () => {
    const ok = await probe();
    if (ok && (options.autoSync ?? true)) {
      try {
        await syncCatalogue();
      } catch (error) {
        lastSyncError = error instanceof Error ? error.message : 'Catalogue sync failed.';
      }
    }
  })();

  const getState = async (): Promise<RegisterUiState> => {
    await ensureStorageHealthy();
    const catalogue = await storage.listCatalog();
    const visibleCatalogue = liveCatalogue
      ? catalogue.filter((entry) => !entry.variantId.startsWith('demo-'))
      : catalogue;
    return snapshotRegisterUiState({
      sell,
      storage,
      splitTender: split,
      splitTenderFirstTenderAtMs: splitFirstTenderAtMs,
      till,
      tillView,
      online: effectiveOnline(),
      offlineSinceMs,
      shopName: 'Demo Shop Ltd',
      receiptNumber: String(receiptCounter),
      quickKeys: [...visibleCatalogue]
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .slice(0, 12)
        .map((entry) => ({ sku: entry.sku, label: entry.name, pricePence: entry.pricePence })),
      readerStatus: reader.status().status,
      readerModel: reader.status().model,
      notice,
      pinApprovalRef,
      demo: !liveCatalogue,
      apiBaseUrl,
      apiReachable,
      manualOnline,
      liveCatalogue,
      lastSyncAt,
      lastSyncError,
      lastFlush,
      searchQuery,
      searchResults,
      liveOrder,
      liveOrderOpen,
      pendingCardAttempts,
      storageWarning: storageWarning.value,
      tenantId: actor.tenantId,
      userId: actor.userId,
    });
  };

  async function handleAction(params: URLSearchParams): Promise<void> {
    const action = params.get('action');
    notice = null;
    try {
      await ensureStorageHealthy();
      switch (action) {
        case 'scan': {
          const code = params.get('barcode') ?? '';
          const { entry, embeddedPricePence } = await sell.scanBarcode(code);
          sell.addLine(entry, 1n, embeddedPricePence);
          notice = `Added ${entry.name}.`;
          break;
        }
        case 'quick-key': {
          const sku = params.get('sku') ?? '';
          const entry = await storage.findCatalogBySku(sku);
          if (!entry) throw new Error(`Unknown quick key ${sku}`);
          sell.addLine(entry, 1n);
          notice = `Added ${entry.name}.`;
          break;
        }
        case 'search': {
          const query = params.get('search-query') ?? '';
          searchQuery = query;
          const results = await sell.search(query);
          const visible = liveCatalogue
            ? results.filter((entry) => !entry.variantId.startsWith('demo-'))
            : results;
          searchResults = visible.map((entry) => ({
            sku: entry.sku,
            name: entry.name,
            pricePence: entry.pricePence,
          }));
          notice = `${searchResults.length} result${searchResults.length === 1 ? '' : 's'} for “${query}”.`;
          break;
        }
        case 'park': {
          const id = await sell.parkBasket();
          notice = `Basket parked (${id}).`;
          break;
        }
        case 'resume-park': {
          const localId = params.get('local-id') ?? '';
          await sell.resumeParkedBasket(localId);
          notice = `Parked basket ${localId.slice(0, 8)} resumed.`;
          break;
        }
        case 'clear': {
          if (liveOrderId !== null && sentTenderCount > 0) {
            throw new Error('A live order with tenders is open — void it with manager approval first (W-12 → Manager)');
          }
          if (liveOrderId !== null) {
            await salesClient.voidOrder(liveOrderId, { reason: 'Basket cleared' });
            liveOrderId = null;
            liveOrderTotalPence = null;
            liveOrderOpen = null;
          }
          sell.clearBasket();
          split = null;
          splitFirstTenderAtMs = null;
          sentTenderCount = 0;
          pendingCardAttempts = [];
          notice = 'Basket cleared.';
          break;
        }
        case 'toggle-online':
          manualOnline = !manualOnline;
          refreshOnline();
          notice = effectiveOnline() ? 'Back online.' : 'Offline — cash only.';
          break;
        case 'sync-catalogue': {
          await syncCatalogue();
          notice = `Catalogue synced${lastSyncAt ? ` — ${lastSyncAt}` : ''}.`;
          break;
        }
        case 'sync-flush': {
          const summary = await syncFlush();
          notice = `Queue flushed: ${summary.synced} synced, ${summary.conflicts} conflict(s), ${summary.failed} failed.`;
          break;
        }
        case 'age-approve':
          sell.ageGate.confirm(25);
          notice = 'Challenge 25 verified (threshold 25).';
          break;
        case 'age-refuse': {
          const required = sell.ageGate.requiredLines(sell.listLines());
          if (required[0]) sell.ageGate.refuse(required[0], 'Customer could not verify age 25+');
          notice = 'Age verification refused — age-restricted lines must be removed before checkout.';
          break;
        }
        case 'split-tender':
          split = new SplitTenderController(sell.basketTotalPence);
          splitFirstTenderAtMs = null;
          sentTenderCount = 0;
          notice = 'Split tender opened.';
          break;
        case 'add-tender': {
          if (!split) throw new Error('No split tender open');
          const kind = (params.get('tender-kind') ?? 'cash') as TenderKind;
          const amount = BigInt(params.get('tender-amount-pence') ?? '0');
          if (split.listTenders().length === 0) splitFirstTenderAtMs = Date.now();
          split.addTender({ kind, amountPence: amount });
          notice = `Tender added: ${kind} ${amount.toString()}p.`;
          break;
        }
        case 'mark-unknown':
          if (!split) split = new SplitTenderController(sell.basketTotalPence);
          split.markCardAttemptUnknown(`demo-attempt-${Date.now()}`);
          notice = 'Card attempt marked unknown — register locked (W-12).';
          break;
        case 'checkout-online': {
          await checkoutOnline();
          break;
        }
        case 'checkout-cash': {
          const result = await sell.checkoutOfflineCash(ageVerificationsForBasket());
          receiptCounter += 1;
          split = null;
          splitFirstTenderAtMs = null;
          notice = `Offline cash sale queued (${result.idempotencyKey}).`;
          break;
        }
        case 'card-outcome': {
          const attemptId = params.get('attempt-id') ?? '';
          const outcome = params.get('outcome') ?? '';
          if (outcome !== 'approved' && outcome !== 'declined' && outcome !== 'unknown') {
            throw new Error('Card outcome must be approved, declined or unknown');
          }
          await recordCardOutcome(attemptId, outcome, params.get('provider-reference') || undefined);
          break;
        }
        case 'complete-order': {
          if (liveOrderId === null) throw new Error('No live order to complete');
          if (pendingCardAttempts.length > 0) {
            throw new Error('Card attempts are still pending — record every terminal result first');
          }
          await completeLiveOrder();
          break;
        }
        case 'w12-poll':
        case 'w12-reconcile': {
          const outcome = params.get('w12-outcome') ?? 'approved';
          if (outcome !== 'approved' && outcome !== 'declined') {
            throw new Error('Terminal result must be approved or declined');
          }
          const reference = params.get('terminal-evidence') || undefined;
          const receiptBefore = liveOrder;
          const attemptId = split?.unknownPaymentAttemptId ?? pendingCardAttempts[0]?.attemptId;
          if (attemptId !== undefined && liveOrderId !== null) {
            await recordCardOutcome(attemptId, outcome, reference);
          }
          if (split?.isLockedOnUnknown) {
            split.resolveUnknown(action === 'w12-poll' ? 'poll_provider_status' : 'reconcile_terminal');
          } else if (split === null && attemptId === undefined) {
            throw new Error('No unknown payment to resolve');
          }
          if (liveOrder === receiptBefore) {
            notice =
              action === 'w12-poll'
                ? 'Provider status polled — payment resolved, register unlocked.'
                : 'Terminal reconciled — payment resolved, register unlocked.';
          }
          break;
        }
        case 'w12-manager': {
          const pin = params.get('manager-pin') ?? params.get('pin') ?? '';
          if (liveOrderId !== null) {
            if (pin === '') {
              throw new Error('Manager PIN required — enter it in the W-12 manager form to void the order');
            }
            const approval = await approvalsClient.createApproval({
              action: 'void_post_tender',
              requestedByUserId: cashierUserId,
              approverPin: pin,
              orderId: liveOrderId,
              reason: 'W-12 manager void and retry',
            });
            await salesClient.voidOrder(liveOrderId, {
              reason: 'Manager void and retry',
              approvalEventsId: approval.id,
            });
            pinApprovalRef = approval.id;
            liveOrderId = null;
            liveOrderTotalPence = null;
            liveOrderOpen = null;
            pendingCardAttempts = [];
            sentTenderCount = 0;
            split = null;
            splitFirstTenderAtMs = null;
            notice = `Order voided under manager approval ${approval.id} — re-take the sale from the same basket.`;
          } else {
            if (!split) throw new Error('No unknown payment to resolve');
            if (!pinApprovalRef) throw new Error('Manager approval required — enter the manager PIN first');
            split.resolveUnknown('manager_void_or_retry', pinApprovalRef);
            notice = 'Manager resolution recorded — register unlocked.';
          }
          break;
        }
        case 'w12-manager-standalone': {
          const reference = params.get('standalone-reference') ?? '';
          const pin = params.get('manager-pin') ?? params.get('pin') ?? '';
          if (reference === '') throw new Error('Standalone terminal reference is required');
          if (liveOrderId !== null && split?.unknownPaymentAttemptId) {
            if (pin === '') {
              throw new Error('Manager PIN required — enter it in the W-12 manager form to record a standalone reference');
            }
            const approval = await approvalsClient.createApproval({
              action: 'void_post_tender',
              requestedByUserId: cashierUserId,
              approverPin: pin,
              orderId: liveOrderId,
              reason: 'W-12 manager standalone reference',
            });
            pinApprovalRef = approval.id;
            const receiptBefore = liveOrder;
            await recordCardOutcome(split.unknownPaymentAttemptId, 'approved', reference);
            if (split?.isLockedOnUnknown) {
              split.resolveUnknown('manager_standalone_reference', approval.id);
            }
            if (liveOrder === receiptBefore) {
              notice = `Standalone terminal reference ${reference} recorded under manager approval ${approval.id}.`;
            }
          } else {
            if (!split) throw new Error('No unknown payment to resolve');
            if (!pinApprovalRef) throw new Error('Manager approval required — enter the manager PIN first');
            split.resolveUnknown('manager_standalone_reference', pinApprovalRef);
            notice = 'Manager standalone reference recorded — register unlocked.';
          }
          break;
        }
        case 'pin-approve': {
          const pin = params.get('pin') ?? '';
          if (!/^\d{4,12}$/.test(pin)) throw new Error('Manager PIN must be 4–12 digits');
          const tenantId = params.get('tenant-id') || actor.tenantId;
          const managerUserId = params.get('manager-user-id') || actor.userId;
          if (effectiveOnline()) {
            const result = await apiClient.pinLogin({
              tenantId,
              userId: managerUserId,
              pin,
              locationId: actor.locationId,
              isTill: true,
            });
            actor.tenantId = result.actor.tenantId;
            actor.userId = result.actor.userId;
            if (result.actor.locationId !== null) actor.locationId = result.actor.locationId;
            // Mutate the roles array in place — the SellController holds
            // it by reference and must see the manager's limits.
            const nextRoles = result.actor.roles.filter((role): role is RoleName =>
              KNOWN_ROLES.includes(role),
            );
            roles.length = 0;
            roles.push(...(nextRoles.length > 0 ? nextRoles : (['cashier'] as const)));
            sellOptions.tenantId = actor.tenantId;
            sellOptions.locationId = actor.locationId;
            pinApprovalRef = `live-pin:${managerUserId}`;
            notice = 'Manager PIN verified live — session token stored for sync and price-book calls.';
          } else {
            pinApprovalRef = `demo-pin:${Date.now()}`;
            notice = 'Manager PIN approved (demo — format check only; API unreachable).';
          }
          break;
        }
        case 'till-open': {
          const floatPence = BigInt(params.get('opening-float-pence') ?? '0');
          const id = await till.openSession(floatPence, pinApprovalRef ?? undefined);
          notice = `Till session opened (${id}).`;
          break;
        }
        case 'till-end': {
          const expected = await till.endSession();
          tillView = { expectedCashPence: expected, zReport: null };
          notice = `Session ended — expected cash ${expected.toString()}p. Count the till blind and close.`;
          break;
        }
        case 'till-close': {
          const counted = BigInt(params.get('counted-cash-pence') ?? '0');
          const reason = params.get('variance-reason') || null;
          const result = await till.closeSession({
            countedCashPence: counted,
            varianceReason: reason,
            approvalEventId: pinApprovalRef,
          });
          tillView = { expectedCashPence: null, zReport: result };
          notice = `Session closed — Z-report ${result.zNumber} issued.`;
          break;
        }
        default:
          notice = action ? `Unknown action: ${action}` : 'No action given.';
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : 'Action failed.';
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ui: 'register', port }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/action') {
        const body = await readBody(req);
        await handleAction(parseForm(body));
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const state = await getState();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderRegisterPage(state));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'Server error');
    }
  });

  return { server, port, getState, probeApi: probe, syncCatalogue, syncFlush };
}

export async function startRegisterUiServer(
  port: number = Number(process.env.REGISTER_UI_PORT ?? REGISTER_UI_DEFAULT_PORT),
  options: RegisterUiServerOptions = {},
): Promise<RegisterUiShell> {
  const envOptions = registerUiOptionsFromEnv();
  const shell = createRegisterUiServer(port, {
    ...envOptions,
    ...options,
    sqlitePath:
      options.sqlitePath ??
      envOptions.sqlitePath ??
      join(process.cwd(), 'data', 'register.sqlite'),
    deviceSecret: options.deviceSecret ?? envOptions.deviceSecret ?? null,
  });
  await new Promise<void>((resolve) => shell.server.listen(port, resolve));
  const address = shell.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  // eslint-disable-next-line no-console
  console.log(`Register tablet UI listening on http://localhost:${actualPort} (GET / , GET /health)`);
  return { ...shell, port: actualPort };
}

// Run directly: `node dist/apps/register-app/src/ui/server.js`
if (require.main === module) {
  void startRegisterUiServer();
}
