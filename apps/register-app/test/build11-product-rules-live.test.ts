/**
 * Build-11 Objective 2 — first-class product-level age restrictions +
 * client verified_at persistence, zero-DB-seed lifecycle over real HTTP.
 *
 * Boots the COMPILED API + the live register UI shell as real child
 * processes and drives them over REAL HTTP round-trips:
 *
 *   1. Create a product with ZERO variants, attach a product-level
 *      rule (POST v1/catalogue/age-restrictions) — 201 (Build-09
 *      400d this). The stored product-level row (variant_id NULL,
 *      rule_source 'explicit') is the authoritative source of truth.
 *   2. Create variant A (no nested rule) → it inherits the product
 *      rule with rule_source 'inherited'. Create variant B with an
 *      explicit nested rule (18) → 'explicit'.
 *   3. Change the product rule (21 → 25): the inherited row on A
 *      refreshes to 25; B's explicit 18 row is NEVER overwritten.
 *   4. Unauthenticated POST → 401; cross-tenant POST → 404.
 *   5. API sale with a client verified_at 6 hours in the past →
 *      GET /v1/sales/orders/:id/age-verifications returns that exact
 *      verified_at, distinct from created_at.
 *   6. Offline flush (POST /v1/sync/flush) with a verified_at 5
 *      hours before the flush → the stored event keeps the original
 *      till timestamp.
 *   7. The register UI gates the inherited-rule sale (Challenge 25
 *      modal) until approval, then completes the live sale.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731,
 * 3827/3830, 3927, 4027, 4127/4130/4131):
 *   API 4327, register UI (live) 4330.
 *
 * HTML harness: Node ships NO built-in DOM parser, so assertions are
 * targeted string/regex checks on the real HTTP responses (the same
 * zero-dependency harness as the Build-07/08/09 UI tests). Localhost
 * only, no external network.
 *
 * Honest limit (documented, not hidden): stock has no public API
 * route for a direct set — POST /v1/inventory/goods-in needs a
 * supplier + warehouse, and neither has a create route — so stock is
 * seeded via PGlite in the stopped-API window, exactly the pattern
 * Build-08/09 used for the same reason. Everything else in this file
 * (product, rule, variants, propagation, sale, verification, flush)
 * is pure HTTP.
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
  setStock,
  type SeededTenant,
} from '@uk-pos/db';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_PORT = 4327;
const REGISTER_PORT = 4330;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');

const PRODUCT_NAME = 'Build-11 Vape Liquid';
const VARIANT_A_SKU = 'B11-V-001';
const VARIANT_A_BARCODE = '5012345678903';
const VARIANT_A_NAME = 'Build-11 Vape 001';
const VARIANT_B_SKU = 'B11-V-002';
const VARIANT_B_BARCODE = '5012345678904';
const VARIANT_B_NAME = 'Build-11 Vape 002';
const PRICE_PENCE = 800;
const STOCK_QTY = 5n;

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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build11-obj2-'));
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
let productId: string;
let variantAId: string;
let variantBId: string;

// ---------------------------------------------------------------------
// API helpers (Bearer key + tenant/location headers)
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

/** Live stock on hand for a variant, read over the API. */
async function stockOnHand(t: TenantSet, variantId: string): Promise<string | null> {
  const res = await apiGet(t, `/v1/inventory/stock?variantId=${encodeURIComponent(variantId)}`);
  expect(res.status, 'GET /v1/inventory/stock').toBe(200);
  const rows = expectJsonObject(res).stock as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(rows)).toBe(true);
  const row = (rows as Array<Record<string, unknown>>).find((r) => r.variantId === variantId);
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

describe('Build-11 Objective 2 — stored product-level age rules + verified_at, zero-DB-seed lifecycle', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);

    // Seed ONLY the tenant + API key (infrastructure scaffolding —
    // no business data: no product, variant, restriction or stock).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        const seeded = await seedTenant(db, { name: 'Build-11 Obj2 Ltd' });
        const created = await createTestApiKey(db, seeded, {
          name: 'build-11 objective 2 key',
          scopes: ['admin'],
        });
        tenant = { tenant: seeded, key: created.key };
      } finally {
        await close();
      }
    }

    await startApi();

    // 1. Create the product with ZERO variants over HTTP.
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: PRODUCT_NAME,
      description: 'Created over HTTP by the Build-11 Obj 2 E2E test',
    });
    expect(product.status, 'create the product via the Admin API').toBe(201);
    productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');

    // 2. Attach a product-level rule to the variant-less product —
    //    201 (Build-09 400d this). Returns the single product-level
    //    row: variant_id NULL, rule_source 'explicit'.
    const rule = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      productId,
      minAge: 21,
    });
    expect(rule.status, 'attach the product-level rule via the Admin API').toBe(201);
    const ruleRows = rule.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(ruleRows), 'age-restriction create returns an array').toBe(true);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows?.[0]?.variant_id).toBeNull();
    expect(ruleRows?.[0]?.product_id).toBe(productId);
    expect(ruleRows?.[0]?.requires_challenge_25).toBe(true);
    expect(ruleRows?.[0]?.min_age).toBe(21);
    expect(ruleRows?.[0]?.rule_source).toBe('explicit');

    // 3. Variant A: NO nested rule — it inherits the stored product
    //    rule with rule_source 'inherited'.
    const variantA = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: VARIANT_A_SKU,
      barcode: VARIANT_A_BARCODE,
      name: VARIANT_A_NAME,
      pricePence: PRICE_PENCE.toString(),
      costPence: '400',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variantA.status, 'create variant A via the Admin API').toBe(201);
    variantAId = (expectJsonObject(variantA).id as string | undefined) ?? '';
    expect(variantAId, 'created variant A has an id').not.toBe('');

    // 4. Variant B: an EXPLICIT nested rule (18) — it wins over the
    //    product rule and must never be overwritten by propagation.
    const variantB = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: VARIANT_B_SKU,
      barcode: VARIANT_B_BARCODE,
      name: VARIANT_B_NAME,
      pricePence: PRICE_PENCE.toString(),
      costPence: '400',
      taxRateId: tenant.tenant.taxRates.standard,
      ageRestriction: { minAge: 18 },
    });
    expect(variantB.status, 'create variant B via the Admin API').toBe(201);
    variantBId = (expectJsonObject(variantB).id as string | undefined) ?? '';
    expect(variantBId, 'created variant B has an id').not.toBe('');

    // 5. Change the product rule (21 → 25): the inherited row on A
    //    refreshes; B's explicit 18 row is untouched. The POST
    //    returns one row per current variant (2), not the product row.
    const changed = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      productId,
      minAge: 25,
    });
    expect(changed.status, 'change the product-level rule via the Admin API').toBe(201);
    const changedRows = changed.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(changedRows), 'product-rule change returns an array').toBe(true);
    expect(changedRows).toHaveLength(2);
    const changedA = changedRows?.find((r) => r.variant_id === variantAId);
    expect(changedA?.min_age).toBe(25);
    expect(changedA?.rule_source).toBe('inherited');
    const changedB = changedRows?.find((r) => r.variant_id === variantBId);
    expect(changedB?.min_age).toBe(18);
    expect(changedB?.rule_source).toBe('explicit');

    // Stock has no public API route for a direct set (goods-in needs
    // a supplier + warehouse, neither of which has a create route),
    // so it is seeded in the stopped-API window — the same pattern
    // Build-08/09 used. Everything else in this file is pure HTTP.
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await setStock(db, tenant.tenant, variantAId, { quantity: STOCK_QTY, costPence: 400n });
        await setStock(db, tenant.tenant, variantBId, { quantity: STOCK_QTY, costPence: 400n });
      } finally {
        await close();
      }
    }
    await startApi();

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
    // The live catalogue syncs on boot; wait until the restricted
    // variant is actually on the page before any sale drives it.
    await waitFor('live register page to show the synced restricted variant', async () => {
      const page = await registerPage();
      return page.includes(VARIANT_A_NAME) && !page.includes('API unreachable');
    }, 60_000);
  }, 240_000);

  afterAll(async () => {
    await stopChild(registerChild, REGISTER_PORT);
    await stopChild(apiChild, API_PORT);
    // /tmp is a 512MB tmpfs: each run leaves a 40–60MB pgdata behind.
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-11 Obj 2 temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('stored product rule + inheritance + explicit protection are visible in the list', async () => {
    const list = await apiGet(
      tenant,
      `/v1/catalogue/age-restrictions?productId=${encodeURIComponent(productId)}`,
    );
    expect(list.status, 'list age restrictions by product').toBe(200);
    const rows = list.json as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
    const productRow = rows.find((r) => r.variant_id === null);
    expect(productRow, 'product-level row present').toBeDefined();
    expect(productRow?.product_id).toBe(productId);
    expect(productRow?.min_age).toBe(25);
    expect(productRow?.rule_source).toBe('explicit');
    const rowA = rows.find((r) => r.variant_id === variantAId);
    expect(rowA, 'variant A carries the inherited rule').toBeDefined();
    expect(rowA?.min_age).toBe(25);
    expect(rowA?.rule_source).toBe('inherited');
    const rowB = rows.find((r) => r.variant_id === variantBId);
    expect(rowB, 'variant B keeps its explicit rule').toBeDefined();
    expect(rowB?.min_age).toBe(18);
    expect(rowB?.rule_source).toBe('explicit');
    // The handshake delta carries the inherited flag for A and the
    // explicit flag for B.
    const handshake = await apiPost(tenant, '/v1/sync/handshake', {
      registerId: tenant.tenant.registerId,
    });
    expect(handshake.status, 'POST /v1/sync/handshake').toBe(201);
    const variants = (expectJsonObject(handshake).catalogue as Record<string, unknown>)
      .variants as Array<Record<string, unknown>>;
    const deltaA = variants.find((v) => v.variantId === variantAId);
    expect(deltaA?.requiresChallenge25).toBe(true);
    expect(deltaA?.minAge).toBe(25);
    const deltaB = variants.find((v) => v.variantId === variantBId);
    expect(deltaB?.requiresChallenge25).toBe(true);
    expect(deltaB?.minAge).toBe(18);
  }, 120_000);

  it('POST age-restrictions: unauthenticated → 401, cross-tenant → 404', async () => {
    const noAuth = await http(`${API_BASE}/v1/catalogue/age-restrictions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, minAge: 18 }),
    });
    expect(noAuth.status, 'no credential is rejected').toBe(401);

    const crossTenant = await apiPost(
      tenant,
      '/v1/catalogue/age-restrictions',
      { productId, minAge: 18 },
      { 'x-tenant-id': randomUUID() },
    );
    expect(crossTenant.status, 'another tenant cannot set the rule').toBe(404);
  }, 120_000);

  it('API sale with a client verified_at 6 hours in the past: GET returns that exact verified_at, distinct from created_at', async () => {
    const created = await apiPost(tenant, '/v1/sales/orders', {
      locationId: tenant.tenant.locationId,
      lines: [{ variantId: variantAId, quantity: '1' }],
    });
    expect(created.status, 'create the order via the API').toBe(201);
    const orderId = expectJsonObject(created).id as string;
    expect(orderId, 'created order has an id').not.toBe('');

    // The till verified the customer 6 hours before the tender.
    const past = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const tender = await apiPost(tenant, `/v1/sales/orders/${orderId}/tenders`, {
      tenderType: 'cash',
      amountPence: PRICE_PENCE.toString(),
      age_verifications: [
        {
          variant_id: variantAId,
          verified_age_threshold: 25,
          verified_by_user_id: tenant.tenant.users.owner.id,
          verified_at: past,
        },
      ],
    });
    expect(tender.status, 'verified tender is accepted').toBe(201);

    const completed = await apiPost(tenant, `/v1/sales/orders/${orderId}/complete`, {});
    expect(completed.status, 'complete the order via the API').toBe(201);

    const listed = await apiGet(tenant, `/v1/sales/orders/${orderId}/age-verifications`);
    expect(listed.status, 'GET /v1/sales/orders/:id/age-verifications').toBe(200);
    const view = expectJsonObject(listed);
    expect(view.orderId).toBe(orderId);
    const verifications = view.verifications as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(verifications), 'verifications is an array').toBe(true);
    expect(verifications).toHaveLength(1);
    expect(verifications?.[0]?.variant_id).toBe(variantAId);
    expect(verifications?.[0]?.verified_age_threshold).toBe(25);
    // The exact client timestamp is preserved, hours before the
    // server record time.
    expect(verifications?.[0]?.verified_at).toBe(past);
    expect(verifications?.[0]?.created_at).not.toBe(past);
    expect(
      new Date(verifications?.[0]?.created_at as string).getTime(),
    ).toBeGreaterThan(new Date(past).getTime() + 5 * 60 * 60 * 1000);
    expect(await stockOnHand(tenant, variantAId), 'verified sale decrements stock').toBe('4');
  }, 120_000);

  it('offline flush preserves a verified_at from 5 hours before the flush', async () => {
    const handshake = await apiPost(tenant, '/v1/sync/handshake', {
      registerId: tenant.tenant.registerId,
    });
    expect(handshake.status, 'POST /v1/sync/handshake before flush').toBe(201);

    // The till verified the customer 5 hours before the device
    // reconnected and flushed.
    const past = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const flush = await apiPost(tenant, '/v1/sync/flush', {
      registerId: tenant.tenant.registerId,
      orders: [
        {
          idempotencyKey: 'b11-obj2-offline-verified-at',
          locationId: tenant.tenant.locationId,
          registerId: tenant.tenant.registerId,
          customerId: null,
          tenderTotalPence: PRICE_PENCE.toString(),
          createdAt: past,
          lines: [
            {
              variantId: variantBId,
              quantity: '1',
              snapshotUnitPricePence: PRICE_PENCE.toString(),
              snapshotLineTotalPence: PRICE_PENCE.toString(),
            },
          ],
          age_verifications: [
            {
              variant_id: variantBId,
              verified_age_threshold: 25,
              verified_by_user_id: tenant.tenant.users.owner.id,
              verified_at: past,
            },
          ],
        },
      ],
    });
    expect(flush.status, 'POST /v1/sync/flush').toBe(201);
    const outcomes = expectJsonObject(flush).outcomes as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(outcomes), 'flush returns outcomes').toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes?.[0]?.status).toBe('synced');
    const orderId = outcomes?.[0]?.orderId as string | undefined;
    expect(orderId, 'flushed order has an id').not.toBe('');

    const listed = await apiGet(tenant, `/v1/sales/orders/${orderId}/age-verifications`);
    expect(listed.status, 'GET age-verifications for the flushed order').toBe(200);
    const verifications = (expectJsonObject(listed).verifications as Array<
      Record<string, unknown>
    > | null) ?? [];
    expect(verifications).toHaveLength(1);
    expect(verifications?.[0]?.variant_id).toBe(variantBId);
    expect(verifications?.[0]?.verified_at).toBe(past);
    expect(verifications?.[0]?.created_at).not.toBe(past);
    expect(await stockOnHand(tenant, variantBId), 'flushed sale decrements stock').toBe('4');
  }, 120_000);

  it('Challenge 25 gate blocks the register checkout until approval, then the inherited-rule sale completes', async () => {
    const scan = await registerAction({ action: 'scan', barcode: VARIANT_A_BARCODE });
    expect(scan.status, 'scan restricted barcode').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${VARIANT_A_NAME}.`);
    expect(page, 'Challenge 25 modal renders in LIVE mode').toContain('id="challenge-25-modal"');
    expect(page, 'modal names the restricted SKU').toContain(VARIANT_A_SKU);
    expect(page, 'modal is not yet verified').not.toContain('data-verified-threshold');
    expect(page, 'no date-of-birth text on the page').not.toMatch(/date of birth/i);
    expect(page, 'no DOB field on the page').not.toMatch(/dob/i);

    // Checkout stays blocked until approval (the register's own gate).
    const blocked = await registerAction({ action: 'checkout-online' });
    expect(blocked.status, 'blocked checkout posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'blocked-checkout error banner').toContain(
      `Age verification required before checkout: ${VARIANT_A_SKU}`,
    );
    expect(await stockOnHand(tenant, variantAId), 'blocked sale moves no stock').toBe('4');

    // Approve on the register, then complete — the UI now SENDS the
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
    expect(await stockOnHand(tenant, variantAId), 'restricted stock decremented by 1').toBe('3');
  }, 120_000);
});
