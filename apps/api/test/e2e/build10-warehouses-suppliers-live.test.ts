/**
 * Build-10 Objective 2 — warehouse + supplier endpoints, live over HTTP.
 *
 * Boots the COMPILED API as a real child process and drives it over
 * REAL HTTP round-trips:
 *
 *   1. Create a warehouse (POST v1/inventory/warehouses) → 201;
 *      list/get round-trip; a second default for the same location →
 *      409 (the seeded tenant already has its default warehouse).
 *   2. Create a supplier (POST v1/purchasing/suppliers) → 201;
 *      list/get round-trip.
 *   3. Create a product + variant over HTTP, link the variant to the
 *      supplier (POST v1/purchasing/suppliers/:id/variants) → 201,
 *      is_preferred stored; re-linking upserts.
 *   4. Goods-in WITHOUT a purchase order (POST v1/inventory/goods-in,
 *      poId null) using the newly created warehouse + supplier →
 *      201; stock balances update over HTTP (10 → 20 across two
 *      receipts at different costs). The weighted-average cost itself
 *      is not exposed over HTTP, so its proof (500p) lives in the
 *      service test in test/routes/build10-warehouses-suppliers.test.ts.
 *   5. Error matrix over HTTP: unauthenticated → 401 on all seven
 *      routes; stock:read key on a write → 403; malformed :id → 400
 *      INVALID_UUID; unknown id and cross-tenant id → 404.
 *
 * Why a child process (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731, and
 * 3827/3830 (Build-10 Objective 1's live test, running concurrently)):
 *   API 3927.
 *
 * Only the tenant + API keys are seeded through PGlite
 * (infrastructure scaffolding, same as every E2E suite): no
 * warehouse, supplier, product, variant or stock is seeded — every
 * business row is created over HTTP, except the seeded tenant's own
 * default warehouse and location, which the seed always creates.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  applyMigrations,
  createPGliteDb,
  createTestApiKey,
  findMigrationsDir,
  seedTenant,
  type SeededTenant,
} from '@uk-pos/db';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_PORT = 3927;
const API_BASE = `http://localhost:${API_PORT}`;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');

// ---------------------------------------------------------------------
// Small helpers (same patterns as build09-age-verification-live.test.ts)
// ---------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const { createConnection } = await import('node:net');
  await waitFor(`port ${port} to free`, async () => {
    const free = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const done = (value: boolean): void => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(false));
      socket.once('error', () => done(true));
      socket.setTimeout(1000, () => done(false));
    });
    return free;
  }, timeoutMs);
}

interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

async function http(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

function expectJsonObject(result: HttpResult): Record<string, unknown> {
  expect(result.json).not.toBeNull();
  expect(typeof result.json).toBe('object');
  return result.json as Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Child-process management
// ---------------------------------------------------------------------

let apiChild: ChildProcess | null = null;

const childLogs: Record<string, string> = {};

function spawnLogged(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const logPath = join(TMP_DIR, `${name}.log`);
  let data = '';
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf8');
  });
  child.on('exit', () => {
    try {
      writeFileSync(logPath, data, 'utf8');
    } catch {
      // Best-effort log capture only.
    }
    childLogs[name] = logPath;
  });
  return child;
}

async function stopChild(child: ChildProcess | null, port: number): Promise<void> {
  if (child === null) return;
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      sleep(10_000).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
    if (child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(5_000),
      ]);
    }
  }
  await waitForPortFree(port);
}

function apiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: 'production',
    PGLITE_DATA_DIR: PG_DATA_DIR,
    WEBHOOK_ENCRYPTION_KEY: WEBHOOK_KEY,
    STATUTORY_ARCHIVE_DIR: ARCHIVE_DIR,
  };
}

async function startApi(): Promise<void> {
  // Hardening (Build-11 Objective 3 — the Build-10 401 flake):
  // the old bootstrap only awaited an UNAUTHENTICATED
  // GET /payments/status, which passes against ANY process holding
  // this port. Our child takes ~6s to reach listen() (NestFactory
  // + PGlite open + migrations) and then dies EADDRINUSE when the
  // port is held — the probe succeeds ~250ms in, ~5.6s before our
  // child even fails, and the first authenticated request then 401s
  // against the stranger's database (reproduced end to end before
  // this fix; the PGlite seed-flush alternative was ruled out by a
  // 20-round close/reopen probe). Three gates close that hole:
  //   (1) the port must be free BEFORE we spawn (a leftover process
  //       fails fast here instead of being talked to by mistake);
  //   (2) our child must still be alive after the status probe;
  //   (3) an AUTHENTICATED probe — GET /v1/tax-rates with the
  //       seeded admin key — must answer 200, proving the process
  //       on this port is OUR server with OUR database. A 401 here
  //       is definitive, not transient: module init (DB open +
  //       migrations) completes before listen(), so a live server
  //       that does not know our key is a stranger.
  await waitForPortFree(API_PORT);
  apiChild = spawnLogged('api', 'node', [API_ENTRY], apiEnv());
  await waitFor('API to answer /payments/status', async () => {
    const res = await http(`${API_BASE}/payments/status`);
    return res.status === 200;
  });
  if (apiChild === null || apiChild.exitCode !== null) {
    throw new Error(
      `API child exited during startup (exit code ${apiChild?.exitCode ?? 'unknown'} — see ${join(TMP_DIR, 'api.log')}); refusing to run against whatever answers on port ${API_PORT}`,
    );
  }
  const ready = await apiGet(tenant, '/v1/tax-rates');
  if (ready.status !== 200) {
    throw new Error(
      `API on port ${API_PORT} answered /v1/tax-rates with ${ready.status} for the seeded admin key — the process answering is not our seeded server (another process may hold the port, or the server opened a different database); refusing to proceed`,
    );
  }
}

// ---------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build10-wh-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const WEBHOOK_KEY = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  adminKey: string;
  readKey: string;
  writeKey: string;
}

let tenant: TenantSet;
let tenantB: TenantSet;
let warehouseId: string;
let supplierId: string;
let variantId: string;

// ---------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------

function apiHeaders(t: TenantSet, key: string): Record<string, string> {
  return {
    ...bearer(key),
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    'x-user-id': t.tenant.users.owner.id,
    'x-roles': 'owner',
    'Content-Type': 'application/json',
  };
}

async function apiPost(
  t: TenantSet,
  path: string,
  body: unknown = {},
  key?: string,
): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(t, key ?? t.adminKey),
    body: JSON.stringify(body),
  });
}

async function apiGet(t: TenantSet, path: string, key?: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders(t, key ?? t.adminKey) });
}

/** Live stock on hand for a variant, read over the API. */
async function stockOnHand(t: TenantSet, vid: string): Promise<string | null> {
  const res = await apiGet(t, `/v1/inventory/stock?variantId=${encodeURIComponent(vid)}`);
  expect(res.status, 'GET /v1/inventory/stock').toBe(200);
  const rows = expectJsonObject(res).stock as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(rows)).toBe(true);
  const row = (rows as Array<Record<string, unknown>>).find((r) => r.variantId === vid);
  if (row === undefined) return null;
  const value = row.quantityOnHand;
  return value === undefined || value === null ? null : String(value);
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-10 Objective 2 — warehouse + supplier endpoints, live over HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);

    // Seed ONLY the tenants + API keys (infrastructure scaffolding —
    // no business data: no warehouse beyond the seed's own default,
    // no supplier, product, variant or stock).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        for (const [name, slot] of [
          ['Warehouse Live Ltd', 'a'],
          ['Warehouse Live B Ltd', 'b'],
        ] as const) {
          const seeded = await seedTenant(db, { name });
          const admin = await createTestApiKey(db, seeded, {
            name: 'admin key',
            scopes: ['admin'],
          });
          const read = await createTestApiKey(db, seeded, {
            name: 'read key',
            scopes: ['stock:read'],
          });
          const write = await createTestApiKey(db, seeded, {
            name: 'write key',
            scopes: ['stock:write'],
          });
          const set: TenantSet = {
            tenant: seeded,
            adminKey: admin.key,
            readKey: read.key,
            writeKey: write.key,
          };
          if (slot === 'a') tenant = set;
          else tenantB = set;
        }
      } finally {
        await close();
      }
    }

    await startApi();

    // 1. Create a warehouse over HTTP (stock:write).
    const warehouse = await apiPost(tenant, '/v1/inventory/warehouses', {
      locationId: tenant.tenant.locationId,
      name: 'Live Store',
      type: 'store',
      isDefault: false,
    });
    expect(warehouse.status, 'create the warehouse via the API').toBe(201);
    warehouseId = (expectJsonObject(warehouse).id as string | undefined) ?? '';
    expect(warehouseId, 'created warehouse has an id').not.toBe('');

    // 2. Create a supplier over HTTP (stock:write).
    const supplier = await apiPost(tenant, '/v1/purchasing/suppliers', {
      name: 'Live Wholesale',
      currency: 'GBP',
      leadTimeDays: 2,
      minOrderValuePence: '2500',
    });
    expect(supplier.status, 'create the supplier via the API').toBe(201);
    supplierId = (expectJsonObject(supplier).id as string | undefined) ?? '';
    expect(supplierId, 'created supplier has an id').not.toBe('');

    // 3. Create a product + variant over HTTP (for the link + goods-in).
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Live Warehouse Product',
    });
    expect(product.status, 'create the product via the API').toBe(201);
    const productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');
    const variant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'WH-001',
      barcode: '5012345678904',
      name: 'Live Widget',
      pricePence: '1000',
      costPence: '400',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variant.status, 'create the variant via the API').toBe(201);
    variantId = (expectJsonObject(variant).id as string | undefined) ?? '';
    expect(variantId, 'created variant has an id').not.toBe('');
  }, 120_000);

  afterAll(async () => {
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }, 60_000);

  it('warehouse list/get round-trip; a second default for the same location is 409', async () => {
    const listed = await apiGet(tenant, '/v1/inventory/warehouses');
    expect(listed.status, 'list warehouses').toBe(200);
    const rows = expectJsonObject(listed) as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((r) => r.name)).toContain('Live Store');
    // The seeded tenant's own default warehouse ('Main Store').
    expect(rows.some((r) => r.is_default === true)).toBe(true);

    const fetched = await apiGet(tenant, `/v1/inventory/warehouses/${warehouseId}`);
    expect(fetched.status, 'get warehouse by id').toBe(200);
    expect(expectJsonObject(fetched).name).toBe('Live Store');

    const secondDefault = await apiPost(tenant, '/v1/inventory/warehouses', {
      locationId: tenant.tenant.locationId,
      name: 'Second default',
      type: 'store',
      isDefault: true,
    });
    expect(secondDefault.status, 'second default warehouse for the location').toBe(409);
  });

  it('supplier list/get round-trip; link the variant (201, is_preferred) and re-link upserts', async () => {
    const listed = await apiGet(tenant, '/v1/purchasing/suppliers');
    expect(listed.status, 'list suppliers').toBe(200);
    const rows = expectJsonObject(listed) as unknown as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((r) => r.name)).toContain('Live Wholesale');

    const fetched = await apiGet(tenant, `/v1/purchasing/suppliers/${supplierId}`);
    expect(fetched.status, 'get supplier by id').toBe(200);
    expect(expectJsonObject(fetched).minimum_order_value_pence).toBe('2500');

    const link = await apiPost(tenant, `/v1/purchasing/suppliers/${supplierId}/variants`, {
      variantId,
      supplierSku: 'LW-001',
      costPence: '350',
      isPreferred: true,
    });
    expect(link.status, 'link variant to supplier').toBe(201);
    const linkBody = expectJsonObject(link);
    expect(linkBody.is_preferred).toBe(true);
    expect(linkBody.cost_pence).toBe('350');
    expect(linkBody.currency).toBe('GBP');

    const relink = await apiPost(tenant, `/v1/purchasing/suppliers/${supplierId}/variants`, {
      variantId,
      supplierSku: 'LW-001-B',
      costPence: '300',
      isPreferred: false,
    });
    expect(relink.status, 're-link the same variant (upsert)').toBe(201);
    expect(expectJsonObject(relink).supplier_sku).toBe('LW-001-B');
    expect(expectJsonObject(relink).is_preferred).toBe(false);
  });

  it('goods-in WITHOUT a purchase order updates stock over HTTP', async () => {
    expect(await stockOnHand(tenant, variantId), 'stock before goods-in').toBeNull();
    // Goods-in is AuthGuard + TenantWriteGuard guarded since Build-12
    // Objective 1 (was a demo-header route): the Bearer <redacted> key
    // (admin scope → stock:write) plus x-tenant-id carry the request.
    for (const [qty, cost] of [
      [10, '400'],
      [10, '600'],
    ] as const) {
      const receipt = await apiPost(tenant, '/v1/inventory/goods-in', {
        poId: null,
        supplierId,
        locationId: tenant.tenant.locationId,
        warehouseId,
        lines: [{ variantId, quantityReceived: String(qty), costPence: cost }],
      });
      expect(receipt.status, `goods-in ${qty} units at ${cost}p without a PO`).toBe(201);
      expect((expectJsonObject(receipt).receiptId as string | undefined) ?? '').not.toBe('');
    }
    expect(await stockOnHand(tenant, variantId), 'stock after two goods-in receipts').toBe('20');
  });

  it('error matrix: unauthenticated 401, wrong scope 403, malformed id 400, unknown/cross-tenant 404', async () => {
    const paths = [
      { method: 'POST', path: '/v1/inventory/warehouses' },
      { method: 'GET', path: '/v1/inventory/warehouses' },
      { method: 'GET', path: `/v1/inventory/warehouses/${warehouseId}` },
      { method: 'POST', path: '/v1/purchasing/suppliers' },
      { method: 'GET', path: '/v1/purchasing/suppliers' },
      { method: 'GET', path: `/v1/purchasing/suppliers/${supplierId}` },
      { method: 'POST', path: `/v1/purchasing/suppliers/${supplierId}/variants` },
    ] as const;
    for (const { method, path } of paths) {
      // No credential at all → 401.
      const bare = await http(`${API_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      });
      expect(bare.status, `${method} ${path} unauthenticated`).toBe(401);
    }
    // stock:read key on a write → 403; stock:write key on a read → 403.
    const readOnWrite = await apiPost(
      tenant,
      '/v1/inventory/warehouses',
      { locationId: tenant.tenant.locationId, name: 'Nope' },
      tenant.readKey,
    );
    expect(readOnWrite.status, 'stock:read key on POST warehouses').toBe(403);
    const writeOnRead = await apiGet(tenant, '/v1/purchasing/suppliers', tenant.writeKey);
    expect(writeOnRead.status, 'stock:write key on GET suppliers').toBe(403);

    // Malformed :id → 400 INVALID_UUID on both get-by-id routes.
    for (const path of ['/v1/inventory/warehouses/not-a-uuid', '/v1/purchasing/suppliers/not-a-uuid']) {
      const res = await apiGet(tenant, path);
      expect(res.status, `GET ${path}`).toBe(400);
      expect(expectJsonObject(res)).toMatchObject({ error: { code: 'INVALID_UUID' } });
    }
    // Unknown id → 404; another tenant's id → 404.
    const unknown = await apiGet(tenant, '/v1/purchasing/suppliers/00000000-0000-0000-0000-000000000000');
    expect(unknown.status, 'unknown supplier id').toBe(404);
    const cross = await apiGet(
      tenantB,
      `/v1/inventory/warehouses/${warehouseId}`,
      tenantB.adminKey,
    );
    expect(cross.status, "another tenant's warehouse id").toBe(404);
  });
});
