/**
 * Build-11 Objective 4 — pure-HTTP zero-DB-seed merchant lifecycle E2E.
 *
 * Boots the COMPILED API + the live register UI shell (4130) as real
 * child processes and drives them over REAL HTTP round-trips:
 *
 *   1. Create a warehouse (POST v1/inventory/warehouses) and a
 *      supplier (POST v1/purchasing/suppliers) — both Build-10 Obj 2
 *      routes. The seeded tenant already has a default warehouse
 *      ("Main Store", from seedTenant), so the HTTP-created one is a
 *      second, non-default warehouse of type 'warehouse'.
 *   2. Create a product (POST v1/catalogue/products) and attach the
 *      product-level Challenge 25 rule (POST
 *      v1/catalogue/age-restrictions with productId) BEFORE any
 *      variant exists — the commission's literal step order, now
 *      possible since Build-11 Obj 2 (migration 018 stores the rule
 *      on product_id with variant_id NULL). The rule stores one
 *      product-level row (rule_source 'explicit').
 *   3. Create TWO variants AFTER the rule and prove each inherits
 *      requires_challenge_25 = true with rule_source 'inherited'
 *      (via the age-restrictions list and the sync handshake delta).
 *   4. Link the second variant to the supplier, receive initial
 *      stock via HTTP goods-in (POST v1/inventory/goods-in, no PO —
 *      into the DEFAULT warehouse, discovered over HTTP via the
 *      list route, because the sale reserves stock from the
 *      default warehouse) and verify the stock balance AND the
 *      weighted-average cost over HTTP: GET /v1/inventory/balances
 *      shows weighted_avg_cost_pence = 400 and total_value_pence =
 *      4000 for the received 10 units, and GET
 *      /v1/inventory/valuation rolls the same numbers up.
 *   5. Sync the register (POST /v1/sync/handshake), verify an
 *      unverified checkout returns 422 AGE_VERIFICATION_REQUIRED
 *      (and an unauthenticated GET age-verifications returns 401),
 *      approve Challenge 25 on the register UI, complete the sale,
 *      and verify stock decremented and the age verification
 *      persisted via the GET route.
 *
 * ACCURACY NOTE — the Build-10 deviation ("a seed variant is needed
 * to establish a product rule") is SUPERSEDED by Build-11 Obj 2:
 * migration 018 stores a product-level rule directly on
 * product_id (variant_id NULL), so POST /v1/catalogue/age-restrictions
 * with a productId 201s on a variant-less product and returns the
 * single product-level row. Variants created afterwards inherit it
 * (rule_source 'inherited') in the same transaction. Derived
 * uniformity inference is gone — the rule is stored, not derived.
 *
 * ACCURACY NOTE — weighted-average cost IS now exposed over HTTP
 * (Build-11 Obj 1): step 4 asserts GET /v1/inventory/balances
 * (weighted_avg_cost_pence + total_value_pence) and GET
 * /v1/inventory/valuation over real HTTP after the goods-in
 * receipt. The Build-10 cost limitation note no longer applies.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731,
 * 3827/3830, 3927, 4027):
 *   API 4127, register UI (live) 4130.
 *
 * HTML harness: Node ships NO built-in DOM parser, so assertions are
 * targeted string/regex checks on the real HTTP responses (the same
 * zero-dependency harness as the Build-07/08/09 UI tests). Localhost
 * only, no external network.
 *
 * Zero direct PGlite inserts for catalogue or stock: the only PGlite
 * writes are the tenant + API key (infrastructure scaffolding, same
 * as every E2E suite). Warehouse, supplier, product, variants, rule,
 * supplier link and stock receipt are all created over HTTP.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const API_PORT = 4127;
const REGISTER_PORT = 4130;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');

const SEED_SKU = 'C25-SEED';
const SEED_BARCODE = '5012345678901';
const SEED_NAME = 'Challenge 25 Seed Vape Liquid';
const VARIANT_SKU = 'C25-002';
const VARIANT_BARCODE = '5012345678902';
const VARIANT_NAME = 'Challenge 25 Vape Liquid';
const VARIANT_PRICE_PENCE = 800;
const STOCK_QTY = 10;
const GOODS_IN_COST_PENCE = 400;

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

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Text of the register shell's action notice banner, or null. */
function registerNotice(html: string): string | null {
  const match = /id="action-notice">([^<]*)</.exec(html);
  return match === null || match[1] === undefined ? null : decodeEntities(match[1]);
}

// ---------------------------------------------------------------------
// Child-process management
// ---------------------------------------------------------------------

let apiChild: ChildProcess | null = null;
let registerChild: ChildProcess | null = null;

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
  // Hardening (Build-12 Objective 4 — the Build-11 3-gate bootstrap):
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
  // The TOCTOU gap remains (a process can bind between the free
  // check and the spawn) — collisions fail fast naming the cause,
  // they are not eliminated.
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build11-lifecycle-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const REGISTER_SQLITE_PATH = join(TMP_DIR, 'register.sqlite');
const WEBHOOK_KEY = randomBytes(32).toString('hex');
const DEVICE_SECRET = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  key: string;
}

let tenant: TenantSet;
let warehouseId: string;
let defaultWarehouseId: string;
let supplierId: string;
let productId: string;
let seedVariantId: string;
let variantId: string;

// ---------------------------------------------------------------------
// API helpers (Bearer key + tenant/location headers — the Obj 1
// AuthGuard pattern: demo headers alone 401 since Build-10)
// ---------------------------------------------------------------------

function apiHeaders(t: TenantSet, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...bearer(t.key),
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    'x-user-id': t.tenant.users.owner.id,
    'x-roles': 'owner',
    'Content-Type': 'application/json',
    ...overrides,
  };
}

async function apiPost(
  t: TenantSet,
  path: string,
  body: unknown = {},
  overrides: Record<string, string> = {},
): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(t, overrides),
    body: JSON.stringify(body),
  });
}

async function apiGet(
  t: TenantSet,
  path: string,
  overrides: Record<string, string> = {},
): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders(t, overrides) });
}

/** Live balance row for a variant, read over the API (Build-11 Obj 1). */
async function balanceRow(
  t: TenantSet,
  variantIdArg: string,
): Promise<Record<string, unknown> | null> {
  const res = await apiGet(t, `/v1/inventory/balances?variantId=${encodeURIComponent(variantIdArg)}`);
  expect(res.status, 'GET /v1/inventory/balances').toBe(200);
  const body = expectJsonObject(res);
  const rows = body.balances as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(rows)).toBe(true);
  return (rows as Array<Record<string, unknown>>).find((r) => r.variant_id === variantIdArg) ?? null;
}
async function stockOnHand(t: TenantSet, variantIdArg: string): Promise<string | null> {
  const res = await apiGet(t, `/v1/inventory/stock?variantId=${encodeURIComponent(variantIdArg)}`);
  expect(res.status, 'GET /v1/inventory/stock').toBe(200);
  const rows = expectJsonObject(res).stock as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(rows)).toBe(true);
  const row = (rows as Array<Record<string, unknown>>).find((r) => r.variantId === variantIdArg);
  if (row === undefined) return null;
  const value = row.quantityOnHand;
  return value === undefined || value === null ? null : String(value);
}

// ---------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------

async function postForm(
  base: string,
  path: string,
  params: Record<string, string>,
): Promise<HttpResult> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, text, json: null };
}

async function registerAction(params: Record<string, string>): Promise<HttpResult> {
  return postForm(REGISTER_BASE, '/action', params);
}

async function registerPage(): Promise<string> {
  const res = await http(`${REGISTER_BASE}/`);
  expect(res.status, 'GET register /').toBe(200);
  return res.text;
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-11 Objective 4 — pure-HTTP zero-DB-seed merchant lifecycle', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);

    // Seed ONLY the tenant + API key (infrastructure scaffolding —
    // no business data: no warehouse, supplier, product, variant,
    // restriction or stock). Note seedTenant itself creates one
    // default warehouse ("Main Store"), so the HTTP-created warehouse
    // below is a second, non-default one.
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        const seeded = await seedTenant(db, { name: 'Zero Seed Ltd' });
        const created = await createTestApiKey(db, seeded, {
          name: 'zero seed lifecycle key',
          scopes: ['admin'],
        });
        tenant = { tenant: seeded, key: created.key };
      } finally {
        await close();
      }
    }

    await startApi();

    // 1. Warehouse + supplier over HTTP (Build-10 Obj 2 routes).
    // The seeded tenant already has a default warehouse ("Main
    // Store", from seedTenant), so the HTTP-created one is a second,
    // non-default warehouse of type 'warehouse' — creating a second
    // DEFAULT would 409. The sale reserves stock from the location's
    // DEFAULT warehouse (sales.service.ts: defaultWarehouseId), so
    // the goods-in in step 4 targets the default warehouse,
    // discovered over HTTP via the list route — the second warehouse
    // proves the create route, the default one feeds the till.
    const warehouse = await apiPost(tenant, '/v1/inventory/warehouses', {
      locationId: tenant.tenant.locationId,
      name: 'Back Store Warehouse',
      type: 'warehouse',
      isDefault: false,
    });
    expect(warehouse.status, 'create the warehouse via the API').toBe(201);
    warehouseId = (expectJsonObject(warehouse).id as string | undefined) ?? '';
    expect(warehouseId, 'created warehouse has an id').not.toBe('');

    const warehouses = await apiGet(tenant, '/v1/inventory/warehouses');
    expect(warehouses.status, 'list the warehouses via the API').toBe(200);
    const warehouseRows = warehouses.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(warehouseRows), 'warehouse list is an array').toBe(true);
    const defaultWarehouse = warehouseRows?.find((w) => w.is_default === true);
    expect(defaultWarehouse, 'a default warehouse exists for the location').toBeDefined();
    defaultWarehouseId = defaultWarehouse?.id as string;
    expect(defaultWarehouseId, 'default warehouse has an id').not.toBe('');
    expect(warehouseRows?.some((w) => w.id === warehouseId), 'created warehouse is listed').toBe(
      true,
    );

    const supplier = await apiPost(tenant, '/v1/purchasing/suppliers', {
      name: 'Acme Wholesale',
      currency: 'GBP',
      leadTimeDays: 3,
      minOrderValuePence: '1000',
    });
    expect(supplier.status, 'create the supplier via the API').toBe(201);
    supplierId = (expectJsonObject(supplier).id as string | undefined) ?? '';
    expect(supplierId, 'created supplier has an id').not.toBe('');

    // 2. Product over HTTP, then the product-level Challenge 25
    // rule BEFORE any variant exists — the commission's literal
    // step order (Build-11 Obj 2, migration 018: the rule stores
    // on product_id with variant_id NULL). createAgeRestriction
    // returns an ARRAY: one product-level row, rule_source
    // 'explicit', variant_id null.
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Zero Seed Product',
      description: 'Created over HTTP by the Build-11 lifecycle E2E test',
    });
    expect(product.status, 'create the product via the API').toBe(201);
    productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');

    const restriction = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      productId,
      requiresChallenge25: true,
      minAge: 18,
    });
    expect(restriction.status, 'attach the product-level rule via the API').toBe(201);
    const ruleRows = restriction.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(ruleRows), 'age-restriction create returns an array').toBe(true);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows?.[0]?.variant_id).toBeNull();
    expect(ruleRows?.[0]?.product_id).toBe(productId);
    expect(ruleRows?.[0]?.requires_challenge_25).toBe(true);
    expect(ruleRows?.[0]?.min_age).toBe(18);
    expect(ruleRows?.[0]?.rule_source).toBe('explicit');

    // 3. TWO variants, both created AFTER the rule — each inherits
    // it (rule_source 'inherited') in the same transaction.
    const seedVariant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: SEED_SKU,
      barcode: SEED_BARCODE,
      name: SEED_NAME,
      pricePence: VARIANT_PRICE_PENCE.toString(),
      costPence: GOODS_IN_COST_PENCE.toString(),
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(seedVariant.status, 'create the seed variant via the API').toBe(201);
    seedVariantId = (expectJsonObject(seedVariant).id as string | undefined) ?? '';
    expect(seedVariantId, 'seed variant has an id').not.toBe('');

    const variant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: VARIANT_SKU,
      barcode: VARIANT_BARCODE,
      name: VARIANT_NAME,
      pricePence: VARIANT_PRICE_PENCE.toString(),
      costPence: GOODS_IN_COST_PENCE.toString(),
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variant.status, 'create the second variant via the API').toBe(201);
    variantId = (expectJsonObject(variant).id as string | undefined) ?? '';
    expect(variantId, 'second variant has an id').not.toBe('');

    // Link the second variant to the supplier (Build-10 Obj 2 route).
    const link = await apiPost(tenant, `/v1/purchasing/suppliers/${supplierId}/variants`, {
      variantId,
      supplierSku: 'ACME-C25-002',
      costPence: GOODS_IN_COST_PENCE.toString(),
      isPreferred: true,
    });
    expect(link.status, 'link the variant to the supplier via the API').toBe(201);
    expect(expectJsonObject(link).variant_id).toBe(variantId);

    // 4. Receive initial stock via HTTP goods-in, no PO — into the
    // DEFAULT warehouse (the sale reserves from there). Build-11
    // Obj 1 exposes the weighted-average cost over HTTP: the
    // balances read must show the receipt's cost (400p) and the
    // total value (10 x 400p = 4000p), and the valuation roll-up
    // must reconcile with the same numbers.
    const receipt = await apiPost(tenant, '/v1/inventory/goods-in', {
      poId: null,
      supplierId,
      locationId: tenant.tenant.locationId,
      warehouseId: defaultWarehouseId,
      lines: [{ variantId, quantityReceived: STOCK_QTY, costPence: GOODS_IN_COST_PENCE }],
    });
    expect(receipt.status, 'receive stock via HTTP goods-in').toBe(201);
    expect(expectJsonObject(receipt).receiptId, 'goods-in returns a receipt id').not.toBe('');
    expect(await stockOnHand(tenant, variantId), 'stock balance after goods-in').toBe(
      String(STOCK_QTY),
    );
    const balance = await balanceRow(tenant, variantId);
    expect(balance, 'balances carries a row for the received variant').not.toBeNull();
    expect(balance?.warehouse_id, 'balance is in the default warehouse').toBe(defaultWarehouseId);
    expect(balance?.quantity_on_hand, 'balance quantity after goods-in').toBe(String(STOCK_QTY));
    expect(balance?.weighted_avg_cost_pence, 'weighted-average cost after first receipt').toBe(
      String(GOODS_IN_COST_PENCE),
    );
    expect(balance?.total_value_pence, 'total value = quantity x average cost').toBe(
      String(STOCK_QTY * GOODS_IN_COST_PENCE),
    );
    const valuationRes = await apiGet(
      tenant,
      `/v1/inventory/valuation?variantId=${encodeURIComponent(variantId)}`,
    );
    expect(valuationRes.status, 'GET /v1/inventory/valuation').toBe(200);
    const valuationBody = expectJsonObject(valuationRes);
    const valuationRows = valuationBody.valuation as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(valuationRows), 'valuation is an array').toBe(true);
    expect(valuationRows).toHaveLength(1);
    expect(valuationRows?.[0]?.variant_id).toBe(variantId);
    expect(valuationRows?.[0]?.total_quantity_on_hand).toBe(String(STOCK_QTY));
    expect(valuationRows?.[0]?.weighted_avg_cost_pence).toBe(String(GOODS_IN_COST_PENCE));
    expect(valuationRows?.[0]?.total_value_pence).toBe(String(STOCK_QTY * GOODS_IN_COST_PENCE));
    const totals = valuationBody.totals as Record<string, unknown> | undefined;
    expect(totals?.total_quantity_on_hand).toBe(String(STOCK_QTY));
    expect(totals?.total_value_pence).toBe(String(STOCK_QTY * GOODS_IN_COST_PENCE));

    // Gate 1 for the register UI too (port free before spawn — a
    // leftover fails fast here naming the port, instead of the
    // /health wait timing out with no cause).
    await waitForPortFree(REGISTER_PORT);
    registerChild = spawnLogged('register-live', 'node', [REGISTER_ENTRY], {
      ...process.env,
      REGISTER_UI_PORT: String(REGISTER_PORT),
      REGISTER_API_BASE_URL: API_BASE,
      REGISTER_API_KEY: tenant.key,
      REGISTER_TENANT_ID: tenant.tenant.tenantId,
      REGISTER_LOCATION_ID: tenant.tenant.locationId,
      REGISTER_REGISTER_ID: tenant.tenant.registerId,
      REGISTER_USER_ID: tenant.tenant.users.owner.id,
      REGISTER_ROLES: 'cashier',
      REGISTER_SQLITE_PATH,
      REGISTER_APP_DEVICE_SECRET: DEVICE_SECRET,
    });
    await waitFor('register UI (live) to answer /health', async () => {
      const res = await http(`${REGISTER_BASE}/health`);
      return res.status === 200;
    });
    // The live catalogue syncs on boot; wait until the inherited-rule
    // variant is actually on the page before any sale drives it.
    await waitFor('live register page to show the synced inherited-rule variant', async () => {
      const page = await registerPage();
      return page.includes(VARIANT_NAME) && !page.includes('API unreachable');
    }, 60_000);
  }, 240_000);

  afterAll(async () => {
    await stopChild(registerChild, REGISTER_PORT);
    await stopChild(apiChild, API_PORT);
    // /tmp is a 512MB tmpfs: each run leaves a 40–60MB pgdata behind.
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-11 lifecycle temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('the variants created after the product rule inherit requires_challenge_25 = true with rule_source inherited', async () => {
    // Proof 1: the age-restrictions list carries an inherited row
    // for the second variant (stored at creation, same transaction).
    const listed = await apiGet(
      tenant,
      `/v1/catalogue/age-restrictions?variantId=${encodeURIComponent(variantId)}`,
    );
    expect(listed.status, 'GET /v1/catalogue/age-restrictions?variantId=').toBe(200);
    const rows = listed.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(rows), 'age-restrictions list is an array').toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.variant_id).toBe(variantId);
    expect(rows?.[0]?.requires_challenge_25).toBe(true);
    expect(rows?.[0]?.min_age).toBe(18);
    expect(rows?.[0]?.rule_source).toBe('inherited');

    // The seed variant, created after the rule as well, inherited
    // the same way.
    const seedListed = await apiGet(
      tenant,
      `/v1/catalogue/age-restrictions?variantId=${encodeURIComponent(seedVariantId)}`,
    );
    expect(seedListed.status, 'GET /v1/catalogue/age-restrictions?variantId= (seed)').toBe(200);
    const seedRows = seedListed.json as Array<Record<string, unknown>> | null;
    expect(seedRows).toHaveLength(1);
    expect(seedRows?.[0]?.requires_challenge_25).toBe(true);
    expect(seedRows?.[0]?.min_age).toBe(18);
    expect(seedRows?.[0]?.rule_source).toBe('inherited');

    // Proof 2: the sync handshake delta carries the inherited flag.
    const res = await apiPost(tenant, '/v1/sync/handshake', {
      registerId: tenant.tenant.registerId,
    });
    expect(res.status, 'POST /v1/sync/handshake').toBe(201);
    const variants = (expectJsonObject(res).catalogue as Record<string, unknown>)
      .variants as Array<Record<string, unknown>>;
    expect(Array.isArray(variants)).toBe(true);
    const bySku = new Map(variants.map((v) => [v.sku, v]));
    const inherited = bySku.get(VARIANT_SKU);
    expect(inherited, 'inherited-rule variant is in the delta').toBeDefined();
    expect(inherited?.requiresChallenge25, 'inherited rule → true, always present').toBe(true);
    expect(inherited?.minAge, 'inherited rule → min_age_years').toBe(18);
  }, 120_000);

  it('unverified checkout fails with 422 AGE_VERIFICATION_REQUIRED; unauthenticated GET age-verifications → 401', async () => {
    // Create the order over the API, then tender with NO verifications.
    const created = await apiPost(tenant, '/v1/sales/orders', {
      locationId: tenant.tenant.locationId,
      lines: [{ variantId, quantity: '1' }],
    });
    expect(created.status, 'create the order via the API').toBe(201);
    const orderId = expectJsonObject(created).id as string;
    expect(orderId, 'created order has an id').not.toBe('');

    const tender = await apiPost(tenant, `/v1/sales/orders/${orderId}/tenders`, {
      tenderType: 'cash',
      amountPence: VARIANT_PRICE_PENCE.toString(),
    });
    expect(tender.status, 'unverified tender is rejected').toBe(422);
    const body = expectJsonObject(tender);
    const error = body.error as Record<string, unknown> | undefined;
    expect(error?.code).toBe('AGE_VERIFICATION_REQUIRED');
    expect(String(error?.message ?? '')).toContain('Age verification required');
    expect(error?.variantIds as Array<unknown> | undefined).toContain(variantId);

    // The order is still a draft and no stock moved.
    expect(await stockOnHand(tenant, variantId), 'rejected sale moves no stock').toBe(
      String(STOCK_QTY),
    );

    // Obj 1: the sales module now enforces AuthGuard — no credential
    // at all answers 401 on the compliance read.
    const unauthenticated = await http(
      `${API_BASE}/v1/sales/orders/${orderId}/age-verifications`,
    );
    expect(unauthenticated.status, 'unauthenticated GET age-verifications is rejected').toBe(
      401,
    );
  }, 120_000);

  it('Challenge 25 gate blocks the register checkout until approval, then the live sale completes', async () => {
    const scan = await registerAction({ action: 'scan', barcode: VARIANT_BARCODE });
    expect(scan.status, 'scan restricted barcode').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${VARIANT_NAME}.`);
    expect(page, 'Challenge 25 modal renders in LIVE mode').toContain('id="challenge-25-modal"');
    expect(page, 'modal names the restricted SKU').toContain(VARIANT_SKU);
    expect(page, 'modal is not yet verified').not.toContain('data-verified-threshold');
    expect(page, 'no date-of-birth text on the page').not.toMatch(/date of birth/i);
    expect(page, 'no DOB field on the page').not.toMatch(/dob/i);

    // Checkout stays blocked until approval (the register's own gate).
    const blocked = await registerAction({ action: 'checkout-online' });
    expect(blocked.status, 'blocked checkout posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'blocked-checkout error banner').toContain(
      `Age verification required before checkout: ${VARIANT_SKU}`,
    );
    expect(await stockOnHand(tenant, variantId), 'blocked sale moves no stock').toBe(
      String(STOCK_QTY),
    );

    // Approve on the register, then complete — the UI SENDS the
    // verification with the tender/completion (Build-09 Obj 2 wiring).
    const approve = await registerAction({ action: 'age-approve' });
    expect(approve.status, 'age-approve posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'approval notice').toContain('Challenge 25 verified (threshold 25).');
    expect(page, 'modal shows the recorded verified threshold').toContain(
      'data-verified-threshold="25"',
    );

    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online after approval').toBe(303);
    page = await registerPage();
    expect(page, 'approved restricted sale completes').toContain('Sale completed');
    expect(page, 'restricted sale total').toContain('£8.00');
    expect(page, 'modal is gone after the completed sale').not.toContain('id="challenge-25-modal"');
    expect(await stockOnHand(tenant, variantId), 'restricted stock decremented by 1').toBe(
      String(STOCK_QTY - 1),
    );
  }, 120_000);

  it('the verification persisted server-side: GET age-verifications shows threshold 25, zero DOB', async () => {
    // Find the completed order through its audit trail (the register
    // UI does not surface the order id): the age-verification event
    // is recorded against the order.
    const audits = await apiGet(
      tenant,
      '/v1/audit-events?eventType=age_verification.recorded&limit=10',
    );
    expect(audits.status, 'GET /v1/audit-events?eventType=age_verification.recorded').toBe(200);
    const events = audits.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(events), 'audit list is an array').toBe(true);
    expect(events?.length ?? 0, 'at least one age-verification audit event').toBeGreaterThan(0);
    const orderId = events?.[0]?.entity_id as string | undefined;
    expect(orderId, 'audit event names the order').not.toBe('');

    const listed = await apiGet(tenant, `/v1/sales/orders/${orderId}/age-verifications`);
    expect(listed.status, 'GET /v1/sales/orders/:id/age-verifications').toBe(200);
    const view = expectJsonObject(listed);
    expect(view.orderId).toBe(orderId);
    const verifications = view.verifications as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(verifications), 'verifications is an array').toBe(true);
    expect(verifications).toHaveLength(1);
    expect(verifications?.[0]?.variant_id).toBe(variantId);
    expect(verifications?.[0]?.verified_age_threshold).toBe(25);
    expect(verifications?.[0]?.verified_by_user_id).toBe(tenant.tenant.users.owner.id);
    expect(verifications?.[0]?.method).toBe('manual_confirmation');
    expect(verifications?.[0]?.outcome).toBe('verified');
    // Zero DOB data anywhere in the inspection response.
    expect(JSON.stringify(listed.json).toLowerCase()).not.toContain('dob');
    expect(JSON.stringify(listed.json).toLowerCase()).not.toContain('birth');
  }, 120_000);
});
