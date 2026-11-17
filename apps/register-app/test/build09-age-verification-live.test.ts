/**
 * Build-09 Objective 2 — server-side age verification, zero-DB-seed
 * Challenge 25 lifecycle over real HTTP.
 *
 * Boots the COMPILED API + the live register UI shell (3130) as real
 * child processes and drives them over REAL HTTP round-trips:
 *
 *   1. Create the product (POST v1/catalogue/products), the variant
 *      (POST v1/catalogue/variants) and the Challenge 25 rule
 *      (POST v1/catalogue/age-restrictions) — all over HTTP. No
 *      business data is seeded through the database: the only
 *      PGlite writes are the tenant + API key (infrastructure
 *      scaffolding, same as every E2E suite).
 *   2. Sync the register (POST /v1/sync/handshake) and prove the
 *      delta carries requiresChallenge25 + minAge.
 *   3. Unverified checkout fails with 422 AGE_VERIFICATION_REQUIRED
 *      over the API (create order + addTender with no verifications)
 *      — the order stays draft and no stock moves.
 *   4. The register UI's own gate blocks checkout until approval;
 *      approve Challenge 25 on the UI, complete the sale, and prove
 *      the event persisted server-side via
 *      GET /v1/sales/orders/:id/age-verifications with
 *      verified_age_threshold = 25 and zero DOB data.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631):
 *   API 3727, register UI (live) 3730.
 *
 * HTML harness: Node ships NO built-in DOM parser, so assertions are
 * targeted string/regex checks on the real HTTP responses (the same
 * zero-dependency harness as the Build-07/08 UI tests). Localhost
 * only, no external network.
 *
 * Honest limit (documented, not hidden): stock has no public API
 * route for a direct set — POST /v1/inventory/goods-in needs a
 * supplier + warehouse, and neither has a create route — so stock is
 * seeded via PGlite in the stopped-API window, exactly the pattern
 * Build-08 used for the same reason. Everything else in this file
 * (product, variant, restriction, sale, verification) is pure HTTP.
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

const API_PORT = 3727;
const REGISTER_PORT = 3730;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');

const C25_SKU = 'C25-001';
const C25_BARCODE = '5012345678903';
const C25_NAME = 'Challenge 25 Vape Liquid';
const C25_PRICE_PENCE = 800;
const STOCK_QTY = 5n;

// ---------------------------------------------------------------------
// Small helpers (same patterns as build08-age-gate-live.test.ts)
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build09-age-'));
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
let c25VariantId: string;

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

describe('Build-09 Objective 2 — server-side age verification, zero-DB-seed Challenge 25 lifecycle', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);

    // Seed ONLY the tenant + API key (infrastructure scaffolding —
    // no business data: no product, variant, restriction or stock).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        const seeded = await seedTenant(db, { name: 'Age Verify Ltd' });
        const created = await createTestApiKey(db, seeded, {
          name: 'age verification key',
          scopes: ['admin'],
        });
        tenant = { tenant: seeded, key: created.key };
      } finally {
        await close();
      }
    }

    await startApi();

    // 1. Create the product over HTTP (Obj 1 route, catalogue:write).
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Challenge 25 Product',
      description: 'Created over HTTP by the Build-09 E2E test',
    });
    expect(product.status, 'create the product via the Admin API').toBe(201);
    productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');

    // 2. Create the variant over HTTP (201).
    const variant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: C25_SKU,
      barcode: C25_BARCODE,
      name: C25_NAME,
      pricePence: C25_PRICE_PENCE.toString(),
      costPence: '400',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variant.status, 'create the variant via the Admin API').toBe(201);
    c25VariantId = (expectJsonObject(variant).id as string | undefined) ?? '';
    expect(c25VariantId, 'created variant has an id').not.toBe('');

    // 3. Attach the Challenge 25 rule over HTTP (Obj 1 route).
    //    createAgeRestriction always returns an ARRAY.
    const restriction = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      variantId: c25VariantId,
      requiresChallenge25: true,
      minAge: 18,
    });
    expect(restriction.status, 'attach the Challenge 25 rule via the Admin API').toBe(201);
    const rows = restriction.json as Array<Record<string, unknown>> | null;
    expect(Array.isArray(rows), 'age-restriction create returns an array').toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.variant_id).toBe(c25VariantId);
    expect(rows?.[0]?.requires_challenge_25).toBe(true);
    expect(rows?.[0]?.min_age).toBe(18);

    // Stock has no public API route for a direct set (goods-in needs
    // a supplier + warehouse, neither of which has a create route),
    // so it is seeded in the stopped-API window — the same pattern
    // Build-08 used. Everything else in this file is pure HTTP.
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await setStock(db, tenant.tenant, c25VariantId, { quantity: STOCK_QTY, costPence: 400n });
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
      return page.includes(C25_NAME) && !page.includes('API unreachable');
    }, 60_000);
  }, 240_000);

  afterAll(async () => {
    await stopChild(registerChild, REGISTER_PORT);
    await stopChild(apiChild, API_PORT);
    // /tmp is a 512MB tmpfs: each run leaves a 40–60MB pgdata behind.
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-09 age-verification temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('handshake delta carries requiresChallenge25 + minAge for the HTTP-created rule', async () => {
    const res = await apiPost(tenant, '/v1/sync/handshake', {
      registerId: tenant.tenant.registerId,
    });
    expect(res.status, 'POST /v1/sync/handshake').toBe(201);
    const variants = (expectJsonObject(res).catalogue as Record<string, unknown>)
      .variants as Array<Record<string, unknown>>;
    expect(Array.isArray(variants)).toBe(true);
    const bySku = new Map(variants.map((v) => [v.sku, v]));
    const restricted = bySku.get(C25_SKU);
    expect(restricted, 'restricted variant is in the delta').toBeDefined();
    expect(restricted?.requiresChallenge25, 'age row → true, always present').toBe(true);
    expect(restricted?.minAge, 'age row → min_age_years').toBe(18);
  }, 120_000);

  it('unverified checkout fails with 422 AGE_VERIFICATION_REQUIRED; order stays draft, stock untouched', async () => {
    // Create the order over the API, then tender with NO verifications.
    const created = await apiPost(tenant, '/v1/sales/orders', {
      locationId: tenant.tenant.locationId,
      lines: [{ variantId: c25VariantId, quantity: '1' }],
    });
    expect(created.status, 'create the order via the API').toBe(201);
    const orderId = expectJsonObject(created).id as string;
    expect(orderId, 'created order has an id').not.toBe('');

    const tender = await apiPost(tenant, `/v1/sales/orders/${orderId}/tenders`, {
      tenderType: 'cash',
      amountPence: C25_PRICE_PENCE.toString(),
    });
    expect(tender.status, 'unverified tender is rejected').toBe(422);
    const body = expectJsonObject(tender);
    const error = body.error as Record<string, unknown> | undefined;
    expect(error?.code).toBe('AGE_VERIFICATION_REQUIRED');
    expect(String(error?.message ?? '')).toContain('Age verification required');
    expect(error?.variantIds as Array<unknown> | undefined).toContain(c25VariantId);

    // The order is still a draft and no stock moved.
    expect(await stockOnHand(tenant, c25VariantId), 'rejected sale moves no stock').toBe('5');

    // A verification carrying a DOB is rejected with 400, never
    // silently dropped.
    const dob = await apiPost(tenant, `/v1/sales/orders/${orderId}/tenders`, {
      tenderType: 'cash',
      amountPence: C25_PRICE_PENCE.toString(),
      age_verifications: [
        {
          variant_id: c25VariantId,
          verified_age_threshold: 25,
          verified_by_user_id: tenant.tenant.users.cashier.id,
          verified_at: new Date().toISOString(),
          dob: '2000-01-01',
        },
      ],
    });
    expect(dob.status, 'a DOB field is rejected with 400').toBe(400);
    expect(await stockOnHand(tenant, c25VariantId), 'DOB rejection moves no stock').toBe('5');
  }, 120_000);

  it('Challenge 25 gate blocks the register checkout until approval, then the live sale completes', async () => {
    const scan = await registerAction({ action: 'scan', barcode: C25_BARCODE });
    expect(scan.status, 'scan restricted barcode').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${C25_NAME}.`);
    expect(page, 'Challenge 25 modal renders in LIVE mode').toContain('id="challenge-25-modal"');
    expect(page, 'modal names the restricted SKU').toContain(C25_SKU);
    expect(page, 'modal is not yet verified').not.toContain('data-verified-threshold');
    expect(page, 'no date-of-birth text on the page').not.toMatch(/date of birth/i);
    expect(page, 'no DOB field on the page').not.toMatch(/dob/i);

    // Checkout stays blocked until approval (the register's own gate).
    const blocked = await registerAction({ action: 'checkout-online' });
    expect(blocked.status, 'blocked checkout posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'blocked-checkout error banner').toContain(
      `Age verification required before checkout: ${C25_SKU}`,
    );
    expect(await stockOnHand(tenant, c25VariantId), 'blocked sale moves no stock').toBe('5');

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
    expect(await stockOnHand(tenant, c25VariantId), 'restricted stock decremented by 1').toBe('4');
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
    expect(verifications?.[0]?.variant_id).toBe(c25VariantId);
    expect(verifications?.[0]?.verified_age_threshold).toBe(25);
    expect(verifications?.[0]?.verified_by_user_id).toBe(tenant.tenant.users.owner.id);
    expect(verifications?.[0]?.method).toBe('manual_confirmation');
    expect(verifications?.[0]?.outcome).toBe('verified');
    // Zero DOB data anywhere in the inspection response.
    expect(JSON.stringify(listed.json).toLowerCase()).not.toContain('dob');
    expect(JSON.stringify(listed.json).toLowerCase()).not.toContain('birth');
  }, 120_000);

  it('GET age-verifications: malformed :id → 400 INVALID_UUID, other tenant → 404', async () => {
    const malformed = await apiGet(tenant, '/v1/sales/orders/not-a-uuid/age-verifications');
    expect(malformed.status, 'malformed :id is rejected').toBe(400);
    const error = expectJsonObject(malformed).error as Record<string, unknown> | undefined;
    expect(error?.code).toBe('INVALID_UUID');

    const otherTenant = await apiGet(tenant, `/v1/sales/orders/${randomUUID()}/age-verifications`, {
      'x-tenant-id': randomUUID(),
    });
    expect(otherTenant.status, 'an order from another tenant is not visible').toBe(404);
  }, 120_000);
});
