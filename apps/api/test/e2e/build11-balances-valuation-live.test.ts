/**
 * Build-11 Objective 1 — weighted-average cost & stock valuation, live over HTTP.
 *
 * Boots the COMPILED API as a real child process and drives it over
 * REAL HTTP round-trips:
 *
 *   1. Create a warehouse + supplier + product + variant over HTTP.
 *   2. Goods-in 10 @ 400p (no PO) → GET /v1/inventory/balances shows
 *      quantity 10, weighted_avg_cost_pence 400, total_value_pence 4000.
 *   3. Goods-in 10 @ 600p → balances show quantity 20, average 500
 *      (the quantity-weighted mean, NOT the last cost), value 10000.
 *   4. GET /v1/inventory/valuation shows the per-variant roll-up
 *      (total quantity 20, average 500, value 10000) and matching
 *      tenant totals.
 *   5. Error matrix over HTTP: unauthenticated → 401 on both routes;
 *      stock:write-only key → 403 on both; another tenant's key sees
 *      an empty list on both (no leakage — lists have no :id to 404
 *      on, same as GET /v1/inventory/stock); unknown variant filter
 *      → empty list.
 *
 * Why a child process (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731,
 * 3827/3830, 3927, 4027, 4127/4130/4131): API 4227 only — this proof
 * needs the API alone; no register/admin UI is booted.
 *
 * Only the tenant + API keys are seeded through PGlite
 * (infrastructure scaffolding, same as every E2E suite): no
 * warehouse beyond the seed's own default, no supplier, product,
 * variant or stock is seeded — every business row is created over
 * HTTP.
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

const API_PORT = 4227;
const API_BASE = `http://localhost:${API_PORT}`;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');

// ---------------------------------------------------------------------
// Small helpers (same patterns as build10-warehouses-suppliers-live.test.ts)
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build11-bal-'));
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

async function goodsIn(costPence: string, quantityReceived = '10'): Promise<HttpResult> {
  return apiPost(tenant, '/v1/inventory/goods-in', {
    poId: null,
    supplierId,
    locationId: tenant.tenant.locationId,
    warehouseId,
    lines: [
      {
        variantId,
        quantityReceived,
        quantityDamaged: '0',
        quantityShort: '0',
        costPence,
      },
    ],
  });
}

type BalanceRow = Record<string, unknown>;

async function balances(t: TenantSet, key?: string): Promise<BalanceRow[]> {
  const res = await apiGet(t, '/v1/inventory/balances', key);
  expect(res.status, 'GET /v1/inventory/balances').toBe(200);
  const rows = expectJsonObject(res).balances as BalanceRow[] | undefined;
  expect(Array.isArray(rows)).toBe(true);
  return rows as BalanceRow[];
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-11 Objective 1 — balances + valuation, live over HTTP', () => {
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
          ['Balances Live Ltd', 'a'],
          ['Balances Live B Ltd', 'b'],
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

    // 3. Create a product + variant over HTTP (catalogue:write).
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Live Balances Product',
    });
    expect(product.status, 'create the product via the API').toBe(201);
    const productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');
    const variant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'BAL-001',
      barcode: '5012345678905',
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

  it('first receipt: balances show quantity 10, average 400, value 4000', async () => {
    const receipt = await goodsIn('400');
    expect(receipt.status, 'goods-in 10 @ 400p').toBe(201);
    const rows = await balances(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variant_id).toBe(variantId);
    expect(rows[0]?.warehouse_id).toBe(warehouseId);
    expect(rows[0]?.quantity_on_hand).toBe('10');
    expect(rows[0]?.weighted_avg_cost_pence).toBe('400');
    expect(rows[0]?.total_value_pence).toBe('4000');
    expect(typeof rows[0]?.computed_at).toBe('string');
  });

  it('second receipt at a different cost: quantity 20, average is the weighted mean 500, value 10000', async () => {
    const receipt = await goodsIn('600');
    expect(receipt.status, 'goods-in 10 @ 600p').toBe(201);
    const rows = await balances(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity_on_hand).toBe('20');
    // (10*400 + 10*600) / 20 = 500 — the weighted mean, not the last cost.
    expect(rows[0]?.weighted_avg_cost_pence).toBe('500');
    expect(rows[0]?.total_value_pence).toBe('10000');
  });

  it('valuation rolls the variant up and the tenant totals match the balances', async () => {
    const res = await apiGet(tenant, '/v1/inventory/valuation');
    expect(res.status, 'GET /v1/inventory/valuation').toBe(200);
    const body = expectJsonObject(res);
    const rows = body.valuation as BalanceRow[] | undefined;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.variant_id).toBe(variantId);
    expect(rows?.[0]?.total_quantity_on_hand).toBe('20');
    expect(rows?.[0]?.weighted_avg_cost_pence).toBe('500');
    expect(rows?.[0]?.total_value_pence).toBe('10000');
    const totals = body.totals as Record<string, unknown> | undefined;
    expect(totals?.total_quantity_on_hand).toBe('20');
    expect(totals?.total_value_pence).toBe('10000');
  });

  it('error matrix: unauthenticated → 401, stock:write-only key → 403, cross-tenant sees an empty list', async () => {
    for (const path of ['/v1/inventory/balances', '/v1/inventory/valuation']) {
      const noAuth = await http(`${API_BASE}${path}`);
      expect(noAuth.status, `unauthenticated GET ${path}`).toBe(401);
      const writeOnly = await apiGet(tenant, path, tenant.writeKey);
      expect(writeOnly.status, `stock:write-only key GET ${path}`).toBe(403);
      const readOnly = await apiGet(tenant, path, tenant.readKey);
      expect(readOnly.status, `stock:read key GET ${path}`).toBe(200);
      // Another tenant's key sees an empty list — no leakage. Lists
      // have no :id to 404 on, same as GET /v1/inventory/stock.
      const other = await apiGet(tenantB, path, tenantB.readKey);
      expect(other.status, `cross-tenant GET ${path}`).toBe(200);
      const otherBody = expectJsonObject(other);
      const otherRows = (otherBody.balances ?? otherBody.valuation) as unknown[] | undefined;
      expect(Array.isArray(otherRows)).toBe(true);
      expect(otherRows).toHaveLength(0);
    }
    // Unknown variant filter → empty list, never 404.
    const filtered = await apiGet(
      tenant,
      `/v1/inventory/balances?variantId=${encodeURIComponent('00000000-0000-0000-0000-000000000000')}`,
    );
    expect(filtered.status, 'unknown variant filter').toBe(200);
    expect((expectJsonObject(filtered).balances as unknown[] | undefined)).toHaveLength(0);
  });
});
