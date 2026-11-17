/**
 * Build-10 Objective 1 — AuthGuard + RequireScope across the sales
 * module, proven over real HTTP.
 *
 * Boots the COMPILED API + the live register UI shell (3130) as real
 * child processes and drives them over REAL HTTP round-trips:
 *
 *   1. Guard proof on the read route (GET
 *      /v1/sales/orders/:id/age-verifications): no credential → 401;
 *      a catalogue:read key → 403 naming sales:read; a sales:write
 *      key → 403 (a scope grants exactly itself); a sales:read key
 *      → 200; an admin key → 200.
 *   2. Guard proof on the write route (POST /v1/sales/orders): no
 *      credential → 401; a sales:read key → 403 naming sales:write;
 *      a sales:write key → 201.
 *   3. PIN-session auth over HTTP: POST /v1/auth/pin-login with the
 *      cashier PIN issues a 2h HMAC token, and that token (Bearer +
 *      x-tenant-id + x-location-id) creates an order → 201. A wrong
 *      PIN → 403.
 *   4. The register UI's live sale still works end to end (scan →
 *      checkout-online → "Sale completed", stock decremented) — which
 *      proves LiveSalesClient now sends the Bearer token (Build-10
 *      wiring); without it every sales call would 401.
 *
 * Note on the 403 body: there is no global exception filter, so a
 * guard rejection answers Nest's default shape — `{ statusCode: 403,
 * message: 'This credential does not carry the required scope:
 * sales:read', error: 'Forbidden' }` — the scope is named in the
 * message, not in a separate `code` field. That is the same shape
 * every other AuthGuarded route returns (catalogue, reporting,
 * compliance); the brief's "403 INSUFFICIENT_SCOPE" is the status +
 * reason, not a body code.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730):
 *   API 3827, register UI (live) 3830.
 *
 * HTML harness: Node ships NO built-in DOM parser, so assertions are
 * targeted string/regex checks on the real HTTP responses (the same
 * zero-dependency harness as the Build-07/08/09 UI tests). Localhost
 * only, no external network.
 *
 * Honest limit (documented, not hidden): stock has no public API
 * route for a direct set — POST /v1/inventory/goods-in needs a
 * supplier + warehouse, and neither has a create route (Build-10
 * Objective 2 adds them) — so stock is seeded via PGlite in the
 * stopped-API window, exactly the pattern Build-08/09 used for the
 * same reason. Everything else in this file (product, variant, sale)
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

const API_PORT = 3827;
const REGISTER_PORT = 3830;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');

const SKU = 'AUTH-001';
const BARCODE = '5012345678904';
const NAME = 'Auth Proof Widget';
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build10-auth-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const REGISTER_SQLITE_PATH = join(TMP_DIR, 'register.sqlite');
const WEBHOOK_KEY = randomBytes(32).toString('hex');
const DEVICE_SECRET = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  /** Admin-scope key (implies every scope). */
  key: string;
  readKey: string;
  writeKey: string;
  catalogueKey: string;
}

let tenant: TenantSet;
let productId: string;
let variantId: string;
let orderId: string;

// ---------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------

/** Admin-key calls (Bearer + tenant/location headers). */
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

/** Scoped-key calls: exactly the credential under test, nothing else. */
function keyHeaders(t: TenantSet, key: string): Record<string, string> {
  return {
    ...bearer(key),
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    'Content-Type': 'application/json',
  };
}

/** No credential at all (tenant header only — the guard must 401). */
function noAuthHeaders(t: TenantSet): Record<string, string> {
  return {
    'x-tenant-id': t.tenant.tenantId,
    'Content-Type': 'application/json',
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
async function stockOnHand(t: TenantSet, id: string): Promise<string | null> {
  const res = await apiGet(t, `/v1/inventory/stock?variantId=${encodeURIComponent(id)}`);
  expect(res.status, 'GET /v1/inventory/stock').toBe(200);
  const rows = expectJsonObject(res).stock as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(rows)).toBe(true);
  const row = (rows as Array<Record<string, unknown>>).find((r) => r.variantId === id);
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

describe('Build-10 Objective 1 — AuthGuard + RequireScope on the sales module, over real HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);

    // Seed ONLY the tenant + API keys (infrastructure scaffolding —
    // no business data: no product, variant or stock).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        const seeded = await seedTenant(db, { name: 'Sales Auth Ltd' });
        const admin = await createTestApiKey(db, seeded, {
          name: 'sales auth admin key',
          scopes: ['admin'],
        });
        const read = await createTestApiKey(db, seeded, {
          name: 'sales auth read key',
          scopes: ['sales:read'],
        });
        const write = await createTestApiKey(db, seeded, {
          name: 'sales auth write key',
          scopes: ['sales:write'],
        });
        const catalogue = await createTestApiKey(db, seeded, {
          name: 'sales auth catalogue key',
          scopes: ['catalogue:read'],
        });
        tenant = {
          tenant: seeded,
          key: admin.key,
          readKey: read.key,
          writeKey: write.key,
          catalogueKey: catalogue.key,
        };
      } finally {
        await close();
      }
    }

    await startApi();

    // Create the product + variant over HTTP (catalogue:write).
    const product = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Auth Proof Product',
      description: 'Created over HTTP by the Build-10 E2E test',
    });
    expect(product.status, 'create the product via the Admin API').toBe(201);
    productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');

    const variant = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: SKU,
      barcode: BARCODE,
      name: NAME,
      pricePence: PRICE_PENCE.toString(),
      costPence: '400',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variant.status, 'create the variant via the Admin API').toBe(201);
    variantId = (expectJsonObject(variant).id as string | undefined) ?? '';
    expect(variantId, 'created variant has an id').not.toBe('');

    // Stock has no public API route for a direct set (goods-in needs
    // a supplier + warehouse, neither of which has a create route),
    // so it is seeded in the stopped-API window — the same pattern
    // Build-08/09 used. Everything else in this file is pure HTTP.
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await setStock(db, tenant.tenant, variantId, { quantity: STOCK_QTY, costPence: 400n });
      } finally {
        await close();
      }
    }
    await startApi();

    // One completed order, so the read-route proof has a real id.
    const created = await apiPost(tenant, '/v1/sales/orders', {
      locationId: tenant.tenant.locationId,
      lines: [{ variantId, quantity: '1' }],
    });
    expect(created.status, 'create the order via the API').toBe(201);
    orderId = expectJsonObject(created).id as string;
    expect(orderId, 'created order has an id').not.toBe('');
    const tender = await apiPost(tenant, `/v1/sales/orders/${orderId}/tenders`, {
      tenderType: 'cash',
      amountPence: PRICE_PENCE.toString(),
    });
    expect(tender.status, 'cash tender on the order').toBe(201);
    const completed = await apiPost(tenant, `/v1/sales/orders/${orderId}/complete`, {});
    expect(completed.status, 'complete the order').toBe(201);

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
    // The live catalogue syncs on boot; wait until the variant is
    // actually on the page before any sale drives it.
    await waitFor('live register page to show the synced variant', async () => {
      const page = await registerPage();
      return page.includes(NAME) && !page.includes('API unreachable');
    }, 60_000);
  }, 240_000);

  afterAll(async () => {
    await stopChild(registerChild, REGISTER_PORT);
    await stopChild(apiChild, API_PORT);
    // /tmp is a 512MB tmpfs: each run leaves a 40–60MB pgdata behind.
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-10 sales-auth temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('GET age-verifications: no credential → 401; wrong scope → 403 naming sales:read; sales:read/admin → 200', async () => {
    const path = `/v1/sales/orders/${orderId}/age-verifications`;

    const unauth = await http(`${API_BASE}${path}`, { headers: noAuthHeaders(tenant) });
    expect(unauth.status, 'no credential → 401').toBe(401);

    const wrongScope = await http(`${API_BASE}${path}`, {
      headers: keyHeaders(tenant, tenant.catalogueKey),
    });
    expect(wrongScope.status, 'catalogue:read key → 403').toBe(403);
    expect(
      String((expectJsonObject(wrongScope).message as string | undefined) ?? ''),
      '403 names the required scope',
    ).toContain('sales:read');

    const writeOnly = await http(`${API_BASE}${path}`, {
      headers: keyHeaders(tenant, tenant.writeKey),
    });
    expect(writeOnly.status, 'sales:write does NOT imply sales:read → 403').toBe(403);
    expect(
      String((expectJsonObject(writeOnly).message as string | undefined) ?? ''),
      '403 names the required scope',
    ).toContain('sales:read');

    const read = await http(`${API_BASE}${path}`, {
      headers: keyHeaders(tenant, tenant.readKey),
    });
    expect(read.status, 'sales:read key → 200').toBe(200);
    const view = expectJsonObject(read);
    expect(view.orderId).toBe(orderId);
    expect(view.verifications).toEqual([]);

    const admin = await apiGet(tenant, path);
    expect(admin.status, 'admin key → 200').toBe(200);
  }, 120_000);

  it('POST orders: no credential → 401; sales:read key → 403 naming sales:write; sales:write key → 201', async () => {
    const body = {
      locationId: tenant.tenant.locationId,
      lines: [{ variantId, quantity: '1' }],
    };
    const unauth = await http(`${API_BASE}/v1/sales/orders`, {
      method: 'POST',
      headers: noAuthHeaders(tenant),
      body: JSON.stringify(body),
    });
    expect(unauth.status, 'no credential → 401').toBe(401);

    const readOnly = await http(`${API_BASE}/v1/sales/orders`, {
      method: 'POST',
      headers: keyHeaders(tenant, tenant.readKey),
      body: JSON.stringify(body),
    });
    expect(readOnly.status, 'sales:read key → 403').toBe(403);
    expect(
      String((expectJsonObject(readOnly).message as string | undefined) ?? ''),
      '403 names the required scope',
    ).toContain('sales:write');

    const wrongScope = await http(`${API_BASE}/v1/sales/orders`, {
      method: 'POST',
      headers: keyHeaders(tenant, tenant.catalogueKey),
      body: JSON.stringify(body),
    });
    expect(wrongScope.status, 'catalogue:read key → 403').toBe(403);

    const write = await http(`${API_BASE}/v1/sales/orders`, {
      method: 'POST',
      headers: keyHeaders(tenant, tenant.writeKey),
      body: JSON.stringify(body),
    });
    expect(write.status, 'sales:write key → 201').toBe(201);
  }, 120_000);

  it('PIN session over HTTP: cashier pin-login issues a token that creates an order; wrong PIN → 403', async () => {
    const login = await http(`${API_BASE}/v1/auth/pin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: tenant.tenant.tenantId,
        userId: tenant.tenant.users.cashier.id,
        pin: '1234',
        locationId: tenant.tenant.locationId,
      }),
    });
    expect(login.status, 'cashier pin-login → 201').toBe(201);
    const token = (expectJsonObject(login).token as string | undefined) ?? '';
    expect(token, 'login returns a session token').not.toBe('');

    // The session token carries the cashier's roles (sales:write via
    // scopesForRoles) and its location from the login payload.
    const created = await http(`${API_BASE}/v1/sales/orders`, {
      method: 'POST',
      headers: {
        ...bearer(token),
        'x-tenant-id': tenant.tenant.tenantId,
        'x-location-id': tenant.tenant.locationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationId: tenant.tenant.locationId,
        lines: [{ variantId, quantity: '1' }],
      }),
    });
    expect(created.status, 'PIN-session token creates an order → 201').toBe(201);

    const badPin = await http(`${API_BASE}/v1/auth/pin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: tenant.tenant.tenantId,
        userId: tenant.tenant.users.cashier.id,
        pin: '0000',
        locationId: tenant.tenant.locationId,
      }),
    });
    expect(badPin.status, 'wrong PIN → 403').toBe(403);
  }, 120_000);

  it('register UI live sale still works — scan → checkout-online completes, stock decremented', async () => {
    // Stock is 5 less the one completed order in beforeAll = 4.
    expect(await stockOnHand(tenant, variantId), 'stock before the UI sale').toBe('4');
    const scan = await registerAction({ action: 'scan', barcode: BARCODE });
    expect(scan.status, 'scan barcode').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${NAME}.`);

    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online posts and redirects').toBe(303);
    page = await registerPage();
    expect(page, 'live sale completes through the guarded routes').toContain('Sale completed');
    expect(page, 'sale total').toContain('£8.00');
    expect(await stockOnHand(tenant, variantId), 'stock decremented by 1').toBe('3');
  }, 120_000);
});
