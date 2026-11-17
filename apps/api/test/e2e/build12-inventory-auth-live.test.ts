/**
 * Build-12 Objective 1 — uniform AuthGuard + RequireScope on the
 * remaining inventory routes, live over HTTP.
 *
 * Boots the COMPILED API as a real child process and drives it over
 * REAL HTTP round-trips, proving the Build-11 demo-header exception
 * is gone from InventoryController:
 *
 *   - GET /v1/inventory/stock: unauthenticated → 401, demo headers
 *     alone → 401, wrong scope (catalogue:read, stock:write-only)
 *     → 403, stock:read key → 200, cross-tenant read key → 200
 *     with an empty list (no leakage).
 *   - POST /v1/inventory/counts, counts/:id/lines, counts/:id/submit,
 *     goods-in: unauthenticated → 401, demo headers alone → 401,
 *     stock:read-only key → 403, stock:write key → 201; a write
 *     with a Bearer key but no x-tenant-id → 400, proving
 *     TenantWriteGuard is in the chain (it needs the tenant id).
 *
 * The balances / valuation routes (Build-11 Objective 1) are already
 * guarded and are NOT re-proven here — see
 * build11-balances-valuation-live.test.ts.
 *
 * Why a child process (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731,
 * 3827/3830, 3927, 4027, 4127/4130, 4227, 4327/4330, 4427/4430):
 * API 4527 only — this proof needs the API alone; no register/admin
 * UI is booted.
 *
 * Only the tenants + API keys are seeded through PGlite
 * (infrastructure scaffolding, same as every E2E suite): the
 * warehouse, supplier, product and variant are created over HTTP.
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

const API_PORT = 4527;
const API_BASE = `http://localhost:${API_PORT}`;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');

// ---------------------------------------------------------------------
// Small helpers (same patterns as build11-balances-valuation-live.test.ts)
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
  // against the stranger's database. Three gates close that hole:
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build12-inv-auth-'));
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
  otherKey: string;
}

let tenant: TenantSet;
let tenantB: TenantSet;
let warehouseId: string;
let supplierId: string;
let variantId: string;
let countId: string;

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

/** The Build-02 demo headers (no Bearer key) — must NOT authenticate any route now. */
function demoHeaders(t: TenantSet): Record<string, string> {
  return {
    'x-tenant-id': t.tenant.tenantId,
    'x-user-id': t.tenant.users.owner.id,
    'x-location-id': t.tenant.locationId,
    'x-roles': 'owner',
    'Content-Type': 'application/json',
  };
}

function goodsInBody(): Record<string, unknown> {
  return {
    poId: null,
    supplierId,
    locationId: tenant.tenant.locationId,
    warehouseId,
    lines: [
      {
        variantId,
        quantityReceived: '10',
        quantityDamaged: '0',
        quantityShort: '0',
        costPence: '400',
      },
    ],
  };
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-12 Objective 1 — inventory routes AuthGuard + RequireScope, live over HTTP', () => {
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
          ['Inventory Auth Live Ltd', 'a'],
          ['Inventory Auth Live B Ltd', 'b'],
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
          const other = await createTestApiKey(db, seeded, {
            name: 'other-scope key',
            scopes: ['catalogue:read'],
          });
          const set: TenantSet = {
            tenant: seeded,
            adminKey: admin.key,
            readKey: read.key,
            writeKey: write.key,
            otherKey: other.key,
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

    // 3. Create a product + variant over HTTP (catalogue:write).
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Live Inventory Auth Product',
    });
    expect(product.status, 'create the product via the API').toBe(201);
    const productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');
    const variant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'INV-AUTH-001',
      barcode: '5012345678906',
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

  it('GET /v1/inventory/stock: unauthenticated → 401, demo headers alone → 401, wrong scope → 403, stock:read → 200', async () => {
    const path = `/v1/inventory/stock?variantId=${encodeURIComponent(variantId)}`;
    const noAuth = await http(`${API_BASE}${path}`);
    expect(noAuth.status, 'unauthenticated GET /v1/inventory/stock').toBe(401);
    const demoOnly = await http(`${API_BASE}${path}`, { headers: demoHeaders(tenant) });
    expect(demoOnly.status, 'demo headers alone GET /v1/inventory/stock').toBe(401);
    const otherScope = await apiGet(tenant, path, tenant.otherKey);
    expect(otherScope.status, 'catalogue:read key GET /v1/inventory/stock').toBe(403);
    const writeOnly = await apiGet(tenant, path, tenant.writeKey);
    expect(writeOnly.status, 'stock:write-only key GET /v1/inventory/stock').toBe(403);
    const readOnly = await apiGet(tenant, path, tenant.readKey);
    expect(readOnly.status, 'stock:read key GET /v1/inventory/stock').toBe(200);
    // Another tenant's key sees an empty list — no leakage. Lists
    // have no :id to 404 on, same as GET /v1/inventory/balances.
    const other = await apiGet(tenantB, path, tenantB.readKey);
    expect(other.status, 'cross-tenant GET /v1/inventory/stock').toBe(200);
    expect(
      (expectJsonObject(other).stock as unknown[] | undefined),
      'cross-tenant stock is empty',
    ).toHaveLength(0);
  });

  it('POST /v1/inventory/goods-in: unauthenticated → 401, demo headers alone → 401, stock:read-only → 403, stock:write → 201', async () => {
    const noAuth = await http(`${API_BASE}/v1/inventory/goods-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodsInBody()),
    });
    expect(noAuth.status, 'unauthenticated POST /v1/inventory/goods-in').toBe(401);
    const demoOnly = await http(`${API_BASE}/v1/inventory/goods-in`, {
      method: 'POST',
      headers: demoHeaders(tenant),
      body: JSON.stringify(goodsInBody()),
    });
    expect(demoOnly.status, 'demo headers alone POST /v1/inventory/goods-in').toBe(401);
    const readOnly = await apiPost(tenant, '/v1/inventory/goods-in', goodsInBody(), tenant.readKey);
    expect(readOnly.status, 'stock:read-only key POST /v1/inventory/goods-in').toBe(403);
    const receipt = await apiPost(tenant, '/v1/inventory/goods-in', goodsInBody(), tenant.writeKey);
    expect(receipt.status, 'stock:write key POST /v1/inventory/goods-in').toBe(201);
    expect((expectJsonObject(receipt).receiptId as string | undefined) ?? '').not.toBe('');
    // The write is real: the read key now sees stock 10 for the variant.
    const stock = await apiGet(
      tenant,
      `/v1/inventory/stock?variantId=${encodeURIComponent(variantId)}`,
      tenant.readKey,
    );
    expect(stock.status, 'GET /v1/inventory/stock after goods-in').toBe(200);
    const rows = expectJsonObject(stock).stock as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.quantityOnHand).toBe('10');
  });

  it('POST /v1/inventory/counts: unauthenticated → 401, stock:read-only → 403, no x-tenant-id → 400, stock:write → 201', async () => {
    const body = { locationId: tenant.tenant.locationId, warehouseId };
    const noAuth = await http(`${API_BASE}/v1/inventory/counts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(noAuth.status, 'unauthenticated POST /v1/inventory/counts').toBe(401);
    const readOnly = await apiPost(tenant, '/v1/inventory/counts', body, tenant.readKey);
    expect(readOnly.status, 'stock:read-only key POST /v1/inventory/counts').toBe(403);
    // Bearer key but no x-tenant-id: TenantWriteGuard answers 400 —
    // proof the guard is in the chain, not just AuthGuard.
    const noTenant = await http(`${API_BASE}/v1/inventory/counts`, {
      method: 'POST',
      headers: {
        ...bearer(tenant.writeKey),
        'x-location-id': tenant.tenant.locationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(noTenant.status, 'write key without x-tenant-id POST /v1/inventory/counts').toBe(400);
    const started = await apiPost(tenant, '/v1/inventory/counts', body, tenant.writeKey);
    expect(started.status, 'stock:write key POST /v1/inventory/counts').toBe(201);
    countId = (expectJsonObject(started).id as string | undefined) ?? '';
    expect(countId, 'created count has an id').not.toBe('');
  });

  it('POST /v1/inventory/counts/:id/lines: unauthenticated → 401, stock:read-only → 403, stock:write → 201', async () => {
    const path = `/v1/inventory/counts/${countId}/lines`;
    const body = { variantId, warehouseId, countedQuantity: '9' };
    const noAuth = await http(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(noAuth.status, 'unauthenticated POST count lines').toBe(401);
    const readOnly = await apiPost(tenant, path, body, tenant.readKey);
    expect(readOnly.status, 'stock:read-only key POST count lines').toBe(403);
    const line = await apiPost(tenant, path, body, tenant.writeKey);
    expect(line.status, 'stock:write key POST count lines').toBe(201);
    const lineBody = expectJsonObject(line);
    expect(lineBody.countedQuantity, 'counted quantity recorded').toBe('9');
    expect(lineBody.expectedQuantity, 'expected quantity is the goods-in stock').toBe('10');
  });

  it('POST /v1/inventory/counts/:id/submit: unauthenticated → 401, stock:read-only → 403, stock:write → 201 with variance -1', async () => {
    const path = `/v1/inventory/counts/${countId}/submit`;
    const noAuth = await http(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noAuth.status, 'unauthenticated POST count submit').toBe(401);
    const readOnly = await apiPost(tenant, path, {}, tenant.readKey);
    expect(readOnly.status, 'stock:read-only key POST count submit').toBe(403);
    const submitted = await apiPost(tenant, path, {}, tenant.writeKey);
    expect(submitted.status, 'stock:write key POST count submit').toBe(201);
    const adjustments = expectJsonObject(submitted).adjustments as
      | Array<Record<string, unknown>>
      | undefined;
    expect(Array.isArray(adjustments)).toBe(true);
    expect(adjustments).toHaveLength(1);
    expect(adjustments?.[0]?.variance, 'counted 9 against expected 10').toBe('-1');
  });
});
