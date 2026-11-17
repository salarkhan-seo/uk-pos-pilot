/**
 * Build-08 Objective 2 — Challenge 25 flag in the sync delta, live
 * register age gate over real HTTP.
 *
 * Boots the COMPILED API + the live register UI shell (3130) as real
 * child processes and drives them over REAL HTTP round-trips:
 *
 *   1. The restricted variant is created through the Admin API
 *      (POST /v1/catalogue/variants — 201). There is no product-create
 *      route, so the parent product row is seeded via PGlite, exactly
 *      like the Build-07 UI tests seed their product.
 *   2. The age_restrictions row has no API route either (nothing in
 *      the pilot writes it except a direct insert), so it is seeded
 *      via PGlite while the API is stopped — the proven restart
 *      pattern from the Build-07 keyring tests. Stock is seeded in
 *      the same stopped window.
 *   3. The register UI boots live and syncs the catalogue; scanning
 *      the restricted barcode triggers the Challenge 25 gate in LIVE
 *      mode, checkout stays blocked until approval, approval records
 *      verified_age_threshold (never a date of birth — asserted: no
 *      DOB field anywhere in the flow), and the sale then completes
 *      with stock decremented on the server.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults):
 *   API 3427, register UI (live) 3430.
 *
 * HTML harness: Node ships NO built-in DOM parser, so assertions are
 * targeted string/regex checks on the real HTTP responses (the same
 * zero-dependency harness as the Build-07 UI tests). Localhost only,
 * no external network.
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
  setStock,
  type SeededTenant,
} from '@uk-pos/db';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_PORT = 3427;
const REGISTER_PORT = 3430;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');

const C25_SKU = 'C25-001';
const C25_BARCODE = '5012345678903';
const C25_NAME = 'Challenge 25 Vape Liquid';
const C25_PRICE_PENCE = 800;
const PLAIN_SKU = 'PLAIN-001';
const PLAIN_BARCODE = '5012345678904';
const PLAIN_NAME = 'Plain Bread Loaf';
const PLAIN_PRICE_PENCE = 500;
const STOCK_QTY = 5n;

// ---------------------------------------------------------------------
// Small helpers (same patterns as apps/api/test/e2e/build06-e2e.test.ts
// and apps/admin-web/test/build07-ui-interactions.test.ts)
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build08-age-'));
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
let plainVariantId: string;

// ---------------------------------------------------------------------
// API helpers (Bearer key + tenant/location headers)
// ---------------------------------------------------------------------

function apiHeaders(t: TenantSet): Record<string, string> {
  return {
    ...bearer(t.key),
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    'x-user-id': t.tenant.users.owner.id,
    'x-roles': 'owner',
    'Content-Type': 'application/json',
  };
}

async function apiPost(t: TenantSet, path: string, body: unknown = {}): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(t),
    body: JSON.stringify(body),
  });
}

async function apiGet(t: TenantSet, path: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders(t) });
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

describe('Build-08 Objective 2 — Challenge 25 flag in the sync delta, live age gate', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);

    // Seed tenant + product row (no product-create route exists).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        const seeded = await seedTenant(db, { name: 'Age Gate Ltd' });
        const created = await createTestApiKey(db, seeded, {
          name: 'age gate key',
          scopes: ['admin'],
        });
        tenant = { tenant: seeded, key: created.key };
        const product = await db
          .insertInto('products')
          .values({ tenant_id: seeded.tenantId, name: 'Age Gate Product', is_active: true })
          .returning('id')
          .executeTakeFirstOrThrow();
        productId = product.id;
      } finally {
        await close();
      }
    }

    await startApi();

    // Create BOTH variants through the Admin API (201 each). The
    // restricted one gets its age row afterwards; the plain one is
    // the false/null control for the same delta.
    const c25 = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: C25_SKU,
      barcode: C25_BARCODE,
      name: C25_NAME,
      pricePence: C25_PRICE_PENCE.toString(),
      costPence: '400',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(c25.status, 'create the Challenge 25 variant via the Admin API').toBe(201);
    c25VariantId = (expectJsonObject(c25).id as string | undefined) ?? '';
    expect(c25VariantId, 'created variant has an id').not.toBe('');

    const plain = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: PLAIN_SKU,
      barcode: PLAIN_BARCODE,
      name: PLAIN_NAME,
      pricePence: PLAIN_PRICE_PENCE.toString(),
      costPence: '250',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(plain.status, 'create the plain variant via the Admin API').toBe(201);
    plainVariantId = (expectJsonObject(plain).id as string | undefined) ?? '';
    expect(plainVariantId, 'created plain variant has an id').not.toBe('');

    // The age_restrictions row has no API route: stop the API and
    // seed it (plus stock for both variants) via PGlite, then restart
    // — the proven restart pattern from the Build-07 keyring tests.
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await db
          .insertInto('age_restrictions')
          .values({
            tenant_id: tenant.tenant.tenantId,
            variant_id: c25VariantId,
            min_age_years: 18,
            challenge_25: true,
          })
          .execute();
        await setStock(db, tenant.tenant, c25VariantId, { quantity: STOCK_QTY, costPence: 400n });
        await setStock(db, tenant.tenant, plainVariantId, { quantity: STOCK_QTY, costPence: 250n });
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
    console.log(`Build-08 age-gate temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('handshake delta carries requiresChallenge25 + minAge over real HTTP (live API)', async () => {
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
    // The wire shape is the DTO's camelCase (Nest serializes as-is).
    expect(restricted?.requiresChallenge25, 'age row → true, always present').toBe(true);
    expect(restricted?.minAge, 'age row → min_age_years').toBe(18);
    const plain = bySku.get(PLAIN_SKU);
    expect(plain, 'plain variant is in the delta').toBeDefined();
    expect(plain?.requiresChallenge25, 'no age row → false, never omitted').toBe(false);
    expect(plain?.minAge, 'no age row → null, never omitted').toBeNull();
  }, 120_000);

  it('plain variant sells in live mode with no age gate', async () => {
    const scan = await registerAction({ action: 'scan', barcode: PLAIN_BARCODE });
    expect(scan.status, 'scan plain barcode').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${PLAIN_NAME}.`);
    expect(page, 'no Challenge 25 modal for a plain variant').not.toContain('id="challenge-25-modal"');

    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online for the plain sale').toBe(303);
    page = await registerPage();
    expect(page, 'plain sale completes without any age step').toContain('Sale completed');
    expect(page, 'plain sale total').toContain('£5.00');
    expect(await stockOnHand(tenant, plainVariantId), 'plain stock decremented by 1').toBe('4');
  }, 120_000);

  it('Challenge 25 gate triggers in live mode on the synced restricted variant', async () => {
    const cleared = await registerAction({ action: 'clear' });
    expect(cleared.status, 'clear basket before the restricted sale').toBe(303);

    const scan = await registerAction({ action: 'scan', barcode: C25_BARCODE });
    expect(scan.status, 'scan restricted barcode').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${C25_NAME}.`);
    expect(page, 'Challenge 25 modal renders in LIVE mode').toContain('id="challenge-25-modal"');
    expect(page, 'modal names the restricted SKU').toContain(C25_SKU);
    expect(page, 'modal is not yet verified').not.toContain('data-verified-threshold');

    // No date of birth anywhere in the flow — the gate records a
    // threshold, never a DOB.
    expect(page, 'no date-of-birth text on the page').not.toMatch(/date of birth/i);
    expect(page, 'no DOB field on the page').not.toMatch(/dob/i);
    expect(page, 'no birth-date input on the page').not.toMatch(/birth/i);

    // Checkout stays blocked until approval.
    const blocked = await registerAction({ action: 'checkout-online' });
    expect(blocked.status, 'blocked checkout posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'blocked-checkout error banner').toContain(
      `Age verification required before checkout: ${C25_SKU}`,
    );
    expect(page, 'modal still unverified after the blocked checkout').not.toContain(
      'data-verified-threshold',
    );
    expect(await stockOnHand(tenant, c25VariantId), 'blocked sale moves no stock').toBe('5');
  }, 120_000);

  it('approval records verified_age_threshold (never DOB) and the live sale completes', async () => {
    const approve = await registerAction({ action: 'age-approve' });
    expect(approve.status, 'age-approve posts and redirects').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'approval notice').toContain('Challenge 25 verified (threshold 25).');
    expect(page, 'modal shows the recorded verified threshold').toContain(
      'data-verified-threshold="25"',
    );
    expect(page, 'no DOB field after approval either').not.toMatch(/date of birth/i);

    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online after approval').toBe(303);
    page = await registerPage();
    expect(page, 'approved restricted sale completes').toContain('Sale completed');
    expect(page, 'restricted sale total').toContain('£8.00');
    expect(page, 'modal is gone after the completed sale').not.toContain('id="challenge-25-modal"');
    expect(await stockOnHand(tenant, c25VariantId), 'restricted stock decremented by 1').toBe('4');
  }, 120_000);
});
