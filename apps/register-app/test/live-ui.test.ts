/**
 * Live UI tests (Build-06, Objective 3).
 *
 * The register shell wired to a stub API (recording fetch + a
 * recording RegisterApiClient transport) — no live server. Proves:
 * catalogue sync populates the Sell screen, search, embedded-price
 * barcode scan, park/resume, offline cash queueing in encrypted
 * node:sqlite with FIFO flush, online checkout with the server
 * receipt, W-12 unknown/declined resolution against the API, live
 * PIN login storing the session token, the unreachable-API banner,
 * and local till sessions with `local-` Z-reports.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_PAYMENT_MESSAGE } from '../src/constants';
import { RegisterApiClient, type RegisterApiTransport } from '../src/api/client';
import { Aes256GcmSqliteCipher } from '../src/storage/sqlite-cipher';
import { NodeSqliteStorageAdapter } from '../src/storage/sqlite-storage';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import type { CatalogCacheEntry } from '../src/storage/storage-adapter';
import { createRegisterUiServer, type RegisterUiServerOptions } from '../src/ui/server';
import type {
  FlushResponse,
  HandshakeResponse,
} from '../../api/src/modules/sync/sync.dto';

const BASE = 'http://localhost:3127';

// -- Stub API ---------------------------------------------------------------

interface StubVariant {
  variantId: string;
  sku: string;
  barcode: string | null;
  name: string;
  pricePence: string;
  priceBookPricePence: string | null;
  taxRateKind: string;
  taxRatePercent: string;
  requiresChallenge25: boolean;
  minAge: number | null;
}

const STUB_VARIANTS: StubVariant[] = [
  {
    variantId: 'live-v-1', sku: 'LIVE-1', barcode: '5012345678903', name: 'Live Widget',
    pricePence: '1500', priceBookPricePence: '1200', taxRateKind: 'standard', taxRatePercent: '20.00',
    requiresChallenge25: false, minAge: null,
  },
  {
    variantId: 'live-v-2', sku: 'LIVE-2', barcode: '5012345678904', name: 'Live Gadget',
    pricePence: '1050', priceBookPricePence: null, taxRateKind: 'reduced', taxRatePercent: '5.00',
    requiresChallenge25: false, minAge: null,
  },
  {
    variantId: 'live-v-3', sku: '12345', barcode: null, name: 'Live Weighed Cheese',
    pricePence: '1000', priceBookPricePence: null, taxRateKind: 'standard', taxRatePercent: '20.00',
    requiresChallenge25: false, minAge: null,
  },
];

interface StubOrder {
  id: string;
  lines: Array<{ variantId: string; quantity: string }>;
  totalPence: string;
}

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function handshakeResponse(): HandshakeResponse {
  return {
    serverTime: '2026-11-14T10:00:00.000Z',
    tenantId: 'tenant-1',
    tenantStatus: 'active',
    registerId: 'register-1',
    registerName: 'Till 1',
    registerStatus: 'active',
    locationId: 'loc-1',
    catalogue: {
      variants: STUB_VARIANTS.map((variant) => ({
        variantId: variant.variantId,
        sku: variant.sku,
        barcode: variant.barcode,
        name: variant.name,
        pricePence: variant.pricePence,
        taxRateId: null,
        taxRateKind: variant.taxRateKind,
        taxRatePercent: variant.taxRatePercent,
        priceBookPricePence: variant.priceBookPricePence,
        stockOnHand: '25',
        stockComputedAt: '2026-11-14T09:00:00.000Z',
        requiresChallenge25: variant.requiresChallenge25,
        minAge: variant.minAge,
        updatedAt: '2026-11-14T09:00:00.000Z',
      })),
      taxRates: [],
      priceBookEntries: [],
      barcodeMode: 'price_embedded',
      fullSnapshot: true,
    },
  };
}

function createStubApi(): {
  fetchImpl: typeof fetch;
  seen: SeenRequest[];
  orders: StubOrder[];
} {
  const seen: SeenRequest[] = [];
  const orders: StubOrder[] = [];
  let orderSeq = 0;
  let attemptSeq = 0;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    seen.push({ url, method, headers, body });
    const path = new URL(url).pathname;
    let status = 200;
    let responseBody: unknown = {};

    if (path === '/sales/status' && method === 'GET') {
      responseBody = { module: 'sales', status: 'ok' };
    } else if (path === '/v1/sync/handshake') {
      responseBody = handshakeResponse();
    } else if (path === '/v1/sync/flush') {
      const request = body as { orders: Array<{ idempotencyKey: string; tenderTotalPence: string }> };
      responseBody = {
        serverTime: '2026-11-14T10:00:00.000Z',
        outcomes: request.orders.map((order, index) => ({
          idempotencyKey: order.idempotencyKey,
          status: 'synced',
          orderId: `server-order-${index + 1}`,
          receiptNumber: `R-flush-${index + 1}`,
          orderTotalPence: order.tenderTotalPence,
          warnings: [],
          conflict: null,
          error: null,
          error_code: null,
        })),
      } satisfies FlushResponse;
    } else if (path === '/v1/sales/orders' && method === 'POST') {
      const request = body as {
        lines: Array<{ variantId: string; quantity: string }>;
      };
      let total = 0n;
      for (const line of request.lines) {
        const variant = STUB_VARIANTS.find((item) => item.variantId === line.variantId);
        if (!variant) throw new Error(`stub: unknown variant ${line.variantId}`);
        const unit = BigInt(variant.priceBookPricePence ?? variant.pricePence);
        total += unit * BigInt(line.quantity);
      }
      orderSeq += 1;
      const order: StubOrder = { id: `order-${orderSeq}`, lines: request.lines, totalPence: total.toString() };
      orders.push(order);
      responseBody = {
        id: order.id,
        status: 'pending_payment',
        total_pence: order.totalPence,
        order_number: `R-${orderSeq}`,
      };
    } else if (/^\/v1\/sales\/orders\/[^/]+\/tenders$/.test(path)) {
      const request = body as { tenderType: string; amountPence: string };
      const orderId = path.split('/')[4] ?? '';
      attemptSeq += 1;
      responseBody = {
        id: `tender-${attemptSeq}`,
        order_id: orderId,
        tender_type: request.tenderType,
        amount_pence: request.amountPence,
        payment_attempt_id: request.tenderType === 'card' ? `attempt-${attemptSeq}` : null,
      };
    } else if (/^\/v1\/sales\/payment-attempts\/[^/]+\/outcome$/.test(path)) {
      responseBody = { status: 'ok' };
    } else if (/^\/v1\/sales\/orders\/[^/]+\/complete$/.test(path)) {
      const orderId = path.split('/')[4] ?? '';
      const order = orders.find((item) => item.id === orderId);
      if (!order) throw new Error(`stub: unknown order ${orderId}`);
      const byRate = new Map<string, { gross: bigint; rate: number; kind: string; percent: string }>();
      for (const line of order.lines) {
        const variant = STUB_VARIANTS.find((item) => item.variantId === line.variantId);
        if (!variant) throw new Error(`stub: unknown variant ${line.variantId}`);
        const unit = BigInt(variant.priceBookPricePence ?? variant.pricePence);
        const gross = unit * BigInt(line.quantity);
        const key = `${variant.taxRateKind}:${variant.taxRatePercent}`;
        const existing = byRate.get(key) ?? {
          gross: 0n,
          rate: Number(variant.taxRatePercent),
          kind: variant.taxRateKind,
          percent: variant.taxRatePercent,
        };
        existing.gross += gross;
        byRate.set(key, existing);
      }
      const lines = [...byRate.values()].map((rate) => {
        const net = (rate.gross * 100n) / BigInt(100 + rate.rate);
        return {
          taxRateKind: rate.kind,
          taxRatePercent: rate.percent,
          grossPence: rate.gross.toString(),
          vatPence: (rate.gross - net).toString(),
          netPence: net.toString(),
        };
      });
      responseBody = {
        order: { id: order.id, status: 'completed', total_pence: order.totalPence },
        receipt: {
          receiptNumber: `R-${order.id.split('-')[1] ?? '1'}`,
          orderId: order.id,
          issuedAt: '2026-11-14T10:00:00.000Z',
          lines,
          totalPence: order.totalPence,
          vatInvoiceNotice: 'This is not a VAT invoice',
        },
      };
    } else if (/^\/v1\/sales\/orders\/[^/]+\/void$/.test(path)) {
      responseBody = { orderId: path.split('/')[4] ?? '', status: 'voided' };
    } else if (path === '/v1/approvals') {
      const request = body as { action: string };
      responseBody = { id: 'approval-1', action: request.action };
    } else {
      status = 404;
      responseBody = { message: `stub: no route for ${method} ${path}` };
    }
    return { status, text: async () => JSON.stringify(responseBody) } as unknown as Response;
  }) as typeof fetch;

  return { fetchImpl, seen, orders };
}

function recordingApiClient(): { client: RegisterApiClient; seen: Array<{ path: string; body: unknown }> } {
  const seen: Array<{ path: string; body: unknown }> = [];
  const transport: RegisterApiTransport = async (request) => {
    seen.push({ path: request.path, body: request.body });
    return {
      status: 200,
      body: {
        token: 'sess_live',
        actor: { tenantId: 'tenant-1', userId: 'manager-1', locationId: 'loc-1', roles: ['manager'] },
      },
    };
  };
  return { client: new RegisterApiClient({ baseUrl: BASE, transport }), seen };
}

// -- Shell harness ----------------------------------------------------------

async function startShell(
  stub: ReturnType<typeof createStubApi>,
  options: RegisterUiServerOptions = {},
  apiClient?: RegisterApiClient,
): Promise<{ shell: ReturnType<typeof createRegisterUiServer>; base: string }> {
  const shell = createRegisterUiServer(0, {
    apiBaseUrl: BASE,
    tenantId: 'tenant-1',
    locationId: 'loc-1',
    registerId: 'register-1',
    userId: 'cashier-1',
    roles: ['cashier'],
    fetchImpl: stub.fetchImpl,
    autoSync: false,
    apiClient,
    ...options,
  });
  await new Promise<void>((resolve) => shell.server.listen(0, resolve));
  const address = shell.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
  return { shell, base: `http://127.0.0.1:${address.port}` };
}

async function closeShell(shell: ReturnType<typeof createRegisterUiServer>): Promise<void> {
  await new Promise<void>((resolve) => shell.server.close(() => resolve()));
}

async function postAction(base: string, params: Record<string, string>): Promise<string> {
  const response = await fetch(`${base}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // Serialised to a string (identical on the wire): react-native's
    // global fetch typing (loaded by the RN component layer in this
    // package) does not accept a URLSearchParams body.
    body: new URLSearchParams(params).toString(),
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function getPage(base: string): Promise<string> {
  const response = await fetch(`${base}/`);
  expect(response.status).toBe(200);
  return response.text();
}

function entryFromVariant(variant: StubVariant): CatalogCacheEntry {
  return {
    variantId: variant.variantId,
    sku: variant.sku,
    barcode: variant.barcode,
    name: variant.name,
    pricePence: BigInt(variant.pricePence),
    priceBookPricePence: variant.priceBookPricePence === null ? null : BigInt(variant.priceBookPricePence),
    taxRateKind: variant.taxRateKind,
    taxRatePercent: variant.taxRatePercent,
    stockOnHand: 25n,
    stockComputedAt: '2026-11-14T09:00:00.000Z',
    requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-14T09:00:00.000Z',
  };
}

describe('Live UI — catalogue sync and search', () => {
  it('catalogue sync populates the Sell screen and clears the demo flag', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      expect(await shell.probeApi()).toBe(true);
      await shell.syncCatalogue();
      const state = await shell.getState();
      expect(state.apiReachable).toBe(true);
      expect(state.liveCatalogue).toBe(true);
      expect(state.demo).toBe(false);
      expect(state.quickKeys.map((key) => key.sku)).toContain('LIVE-1');
      const html = await getPage(base);
      expect(html).toContain('Live Widget');
      expect(html).toContain('Live — connected to the API');
      expect(html).not.toContain('Demo Widget');
    } finally {
      await closeShell(shell);
    }
  });

  it('catalogue search finds live variants by name or SKU', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      await shell.syncCatalogue();
      await postAction(base, { action: 'search', 'search-query': 'Widget' });
      const state = await shell.getState();
      expect(state.searchQuery).toBe('Widget');
      expect(state.searchResults?.map((result) => result.sku)).toEqual(['LIVE-1']);
      const html = await getPage(base);
      expect(html).toContain('id="search-results"');
      expect(html).toContain('Live Widget');
      await postAction(base, { action: 'search', 'search-query': 'no-such-item' });
      const empty = await shell.getState();
      expect(empty.searchResults).toEqual([]);
      expect(await getPage(base)).toContain('No matches for');
    } finally {
      await closeShell(shell);
    }
  });

  it('an embedded-price barcode scan overrides the unit price (shared parser)', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      await shell.syncCatalogue();
      // EAN-13 in-store code: prefix 20, SKU 12345, embedded price 00750p, check digit 5.
      await postAction(base, { action: 'scan', barcode: '2012345007505' });
      const state = await shell.getState();
      expect(state.lines).toHaveLength(1);
      expect(state.lines[0]?.sku).toBe('12345');
      expect(state.lines[0]?.lineTotalPence).toBe(750n);
      const html = await getPage(base);
      expect(html).toContain('Live Weighed Cheese');
      expect(html).toContain('£7.50');
    } finally {
      await closeShell(shell);
    }
  });

  it('a parked basket can be saved and resumed', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      await shell.syncCatalogue();
      await postAction(base, { action: 'quick-key', sku: 'LIVE-1' });
      await postAction(base, { action: 'park' });
      const parked = await shell.getState();
      expect(parked.parkedCount).toBe(1);
      expect(parked.lines).toHaveLength(0);
      const localId = parked.parkedLocalIds[0];
      expect(localId).toBeTruthy();
      await postAction(base, { action: 'resume-park', 'local-id': localId ?? '' });
      const resumed = await shell.getState();
      expect(resumed.parkedCount).toBe(0);
      expect(resumed.lines).toHaveLength(1);
      expect(resumed.lines[0]?.sku).toBe('LIVE-1');
    } finally {
      await closeShell(shell);
    }
  });
});

describe('Live UI — offline queue and FIFO flush', () => {
  it('offline toggle queues a cash sale in encrypted SQLite and FIFO flush sends it', async () => {
    const stub = createStubApi();
    const dir = mkdtempSync(join(tmpdir(), 'register-ui-'));
    const dbPath = join(dir, 'register.sqlite');
    const { shell, base } = await startShell(stub, {
      sqlitePath: dbPath,
      deviceSecret: 'test-device-secret-123',
    });
    const wrongKey = new NodeSqliteStorageAdapter(dbPath, {
      cipher: new Aes256GcmSqliteCipher({ secret: 'wrong-secret' }),
    });
    const rightKey = new NodeSqliteStorageAdapter(dbPath, {
      cipher: new Aes256GcmSqliteCipher({ secret: 'test-device-secret-123' }),
    });
    try {
      await shell.probeApi();
      await shell.syncCatalogue();
      await postAction(base, { action: 'toggle-online' });
      expect((await shell.getState()).online).toBe(false);
      await postAction(base, { action: 'quick-key', sku: 'LIVE-1' });
      await postAction(base, { action: 'checkout-cash' });
      const queued = await shell.getState();
      expect(queued.queuedCount).toBe(1);
      // The queue is ciphertext at rest: the wrong device key cannot read it.
      await expect(wrongKey.listAllQueue()).rejects.toMatchObject({
        code: 'LOCAL_STORAGE_TAMPERED',
      });
      const rows = await rightKey.listAllQueue();
      expect(rows).toHaveLength(1);
      const key = rows[0]?.idempotencyKey;
      expect(key).toBeTruthy();
      // Back online: the FIFO flush sends the queued order in order.
      await postAction(base, { action: 'toggle-online' });
      expect((await shell.getState()).online).toBe(true);
      await postAction(base, { action: 'sync-flush' });
      const flushed = await shell.getState();
      expect(flushed.lastFlush?.synced).toBe(1);
      expect(flushed.queuedCount).toBe(0);
      const flushCalls = stub.seen.filter((request) => request.url.endsWith('/v1/sync/flush'));
      expect(flushCalls).toHaveLength(1);
      const flushedOrders = (flushCalls[0]?.body as { orders: Array<{ idempotencyKey: string }> }).orders;
      expect(flushedOrders.map((order) => order.idempotencyKey)).toEqual([key]);
    } finally {
      wrongKey.close();
      rightKey.close();
      await closeShell(shell);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two offline sales flush in FIFO order', async () => {
    const stub = createStubApi();
    const storage = new InMemoryStorageAdapter();
    await storage.upsertCatalog([entryFromVariant(STUB_VARIANTS[0]!), entryFromVariant(STUB_VARIANTS[1]!)]);
    const { shell, base } = await startShell(stub, {
      storage,
      seedDemoCatalogue: false,
      manualOnline: false,
    });
    try {
      await shell.probeApi();
      await postAction(base, { action: 'quick-key', sku: 'LIVE-1' });
      await postAction(base, { action: 'checkout-cash' });
      await postAction(base, { action: 'quick-key', sku: 'LIVE-2' });
      await postAction(base, { action: 'checkout-cash' });
      const queued = await storage.listAllQueue();
      expect(queued).toHaveLength(2);
      const keys = queued.map((row) => row.idempotencyKey);
      await postAction(base, { action: 'toggle-online' });
      await postAction(base, { action: 'sync-flush' });
      const flushed = await shell.getState();
      expect(flushed.lastFlush?.synced).toBe(2);
      const flushCalls = stub.seen.filter((request) => request.url.endsWith('/v1/sync/flush'));
      expect(flushCalls).toHaveLength(1);
      const flushedOrders = (flushCalls[0]?.body as { orders: Array<{ idempotencyKey: string }> }).orders;
      expect(flushedOrders.map((order) => order.idempotencyKey)).toEqual(keys);
    } finally {
      await closeShell(shell);
    }
  });
});

describe('Live UI — online checkout and W-12', () => {
  it('online cash checkout completes against the API and shows the server receipt', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      await shell.syncCatalogue();
      await postAction(base, { action: 'quick-key', sku: 'LIVE-1' });
      await postAction(base, { action: 'checkout-online' });
      const state = await shell.getState();
      expect(state.liveOrder?.receiptNumber).toBe('R-1');
      expect(state.liveOrder?.totalPence).toBe(1200n);
      expect(state.liveOrder?.receiptLines).toEqual([
        { taxRateKind: 'standard', taxRatePercent: '20.00', grossPence: 1200n, vatPence: 200n, netPence: 1000n },
      ]);
      expect(state.lines).toHaveLength(0);
      const html = await getPage(base);
      expect(html).toContain('Last completed sale (live)');
      expect(html).toContain('receipt #R-1');
      const paths = stub.seen.map((request) => new URL(request.url).pathname);
      expect(paths).toEqual(
        expect.arrayContaining(['/v1/sales/orders', '/v1/sales/orders/order-1/tenders', '/v1/sales/orders/order-1/complete']),
      );
      const tender = stub.seen.find((request) => request.url.endsWith('/tenders'));
      expect(tender?.body).toMatchObject({ tenderType: 'cash', amountPence: '1200' });
    } finally {
      await closeShell(shell);
    }
  });

  it('an unknown card attempt locks the register (W-12); polling with approved completes the sale', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      await shell.syncCatalogue();
      await postAction(base, { action: 'quick-key', sku: 'LIVE-1' });
      await postAction(base, { action: 'split-tender' });
      await postAction(base, { action: 'add-tender', 'tender-kind': 'card', 'tender-amount-pence': '1200' });
      await postAction(base, { action: 'checkout-online' });
      const pending = await shell.getState();
      expect(pending.pendingCardAttempts).toHaveLength(1);
      expect(pending.pendingCardAttempts[0]?.attemptId).toBe('attempt-1');
      expect(pending.notice).toContain('terminal result');
      await postAction(base, {
        action: 'card-outcome',
        'attempt-id': 'attempt-1',
        outcome: 'unknown',
      });
      const locked = await shell.getState();
      expect(locked.splitTender?.locked).toBe(true);
      expect(locked.splitTender?.blockingMessage).toBe(UNKNOWN_PAYMENT_MESSAGE);
      expect(await getPage(base)).toContain('id="w12-modal"');
      await postAction(base, {
        action: 'w12-poll',
        'w12-outcome': 'approved',
        'terminal-evidence': 'S700-2026-11-14/07',
      });
      const done = await shell.getState();
      expect(done.liveOrder?.receiptNumber).toBe('R-1');
      expect(done.splitTender).toBeNull();
      const outcomeCalls = stub.seen.filter((request) => request.url.includes('/payment-attempts/'));
      expect(outcomeCalls).toHaveLength(2);
      expect(outcomeCalls[1]?.body).toMatchObject({
        outcome: 'approved',
        providerReference: 'S700-2026-11-14/07',
      });
    } finally {
      await closeShell(shell);
    }
  });

  it('a declined card is voided by a manager and the same basket is re-taken', async () => {
    const stub = createStubApi();
    const { client: apiClient } = recordingApiClient();
    const { shell, base } = await startShell(stub, {}, apiClient);
    try {
      await shell.probeApi();
      await shell.syncCatalogue();
      await postAction(base, {
        action: 'pin-approve',
        'tenant-id': 'tenant-1',
        'manager-user-id': 'manager-1',
        pin: '1234',
      });
      expect(apiClient.sessionToken).toBe('sess_live');
      expect((await shell.getState()).pinApprovalRef).toBe('live-pin:manager-1');
      await postAction(base, { action: 'quick-key', sku: 'LIVE-1' });
      await postAction(base, { action: 'split-tender' });
      await postAction(base, { action: 'add-tender', 'tender-kind': 'card', 'tender-amount-pence': '1200' });
      await postAction(base, { action: 'checkout-online' });
      await postAction(base, {
        action: 'card-outcome',
        'attempt-id': 'attempt-1',
        outcome: 'declined',
      });
      const declined = await shell.getState();
      expect(declined.liveOrderOpen?.orderId).toBe('order-1');
      expect(declined.lines).toHaveLength(1);
      expect(declined.notice).toContain('void');
      expect(await getPage(base)).toContain('id="open-live-order"');
      await postAction(base, { action: 'w12-manager', 'manager-pin': '1234' });
      const voided = await shell.getState();
      expect(voided.liveOrderOpen).toBeNull();
      expect(voided.lines).toHaveLength(1);
      const approvalCalls = stub.seen.filter((request) => request.url.endsWith('/v1/approvals'));
      expect(approvalCalls).toHaveLength(1);
      expect(approvalCalls[0]?.body).toMatchObject({
        action: 'void_post_tender',
        requestedByUserId: 'cashier-1',
        approverPin: '1234',
        orderId: 'order-1',
      });
      const voidCalls = stub.seen.filter((request) => request.url.endsWith('/void'));
      expect(voidCalls).toHaveLength(1);
      expect(voidCalls[0]?.body).toMatchObject({ approvalEventsId: 'approval-1' });
      // Re-take the same basket as a fresh order.
      await postAction(base, { action: 'checkout-online' });
      const retaken = await shell.getState();
      expect(retaken.liveOrder?.receiptNumber).toBe('R-2');
      const createCalls = stub.seen.filter(
        (request) => request.url.endsWith('/v1/sales/orders') && request.method === 'POST',
      );
      expect(createCalls).toHaveLength(2);
    } finally {
      await closeShell(shell);
    }
  });
});

describe('Live UI — PIN login, unreachable API, local till', () => {
  it('live PIN login stores the token and later sync calls carry the Bearer token', async () => {
    const stub = createStubApi();
    const { client: apiClient } = recordingApiClient();
    const { shell, base } = await startShell(stub, {}, apiClient);
    try {
      await shell.probeApi();
      await postAction(base, {
        action: 'pin-approve',
        'tenant-id': 'tenant-1',
        'manager-user-id': 'manager-1',
        pin: '1234',
      });
      expect(apiClient.sessionToken).toBe('sess_live');
      await shell.syncCatalogue();
      const handshakeCalls = stub.seen.filter((request) => request.url.endsWith('/v1/sync/handshake'));
      expect(handshakeCalls.length).toBeGreaterThanOrEqual(1);
      expect(handshakeCalls.at(-1)?.headers['Authorization']).toBe('Bearer sess_live');
    } finally {
      await closeShell(shell);
    }
  });

  it('an unreachable API still boots and serves the page with an explicit banner', async () => {
    const throwing = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const shell = createRegisterUiServer(0, { fetchImpl: throwing, autoSync: false });
    await new Promise<void>((resolve) => shell.server.listen(0, resolve));
    try {
      const address = shell.server.address();
      if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      expect(await shell.probeApi()).toBe(false);
      const html = await getPage(base);
      expect(html).toContain('API unreachable');
      expect(html).toContain('Demo data');
      expect(html).toContain('id="sell-screen"');
      await postAction(base, { action: 'pin-approve', pin: '1234' });
      expect((await shell.getState()).notice).toContain('demo — format check only');
    } finally {
      await closeShell(shell);
    }
  });

  it('till sessions stay local and the Z-report id is prefixed local-', async () => {
    const stub = createStubApi();
    const { shell, base } = await startShell(stub);
    try {
      await postAction(base, { action: 'till-open', 'opening-float-pence': '10000' });
      await postAction(base, { action: 'till-end' });
      await postAction(base, { action: 'till-close', 'counted-cash-pence': '10000' });
      const state = await shell.getState();
      expect(state.till.zReport?.zReportId.startsWith('local-')).toBe(true);
      expect(state.till.zReport?.zNumber.startsWith('LOCAL-Z-')).toBe(true);
      const html = await getPage(base);
      expect(html).toContain('Local till record');
    } finally {
      await closeShell(shell);
    }
  });
});
