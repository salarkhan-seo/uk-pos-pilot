/**
 * Build-07 Objective 3 — Interactive browser DOM & end-to-end UI execution.
 *
 * Boots the COMPILED API + both register UI shells (live + demo) + two admin
 * UI shells (one per tenant) as real child processes and drives them over
 * REAL HTTP round-trips — form POSTs, query transitions, error banners,
 * Challenge 25, all four W-12 resolutions, the goods-in 0-default, bulk
 * voucher show-once masking, and D-11 exit blockers.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator metadata,
 * so Nest cannot boot inside vitest (proven Build-06). The register/admin
 * shells are plain node:http servers, so they boot from dist/ directly.
 *
 * Ports (test-only; never the 3127/3130/3131 defaults):
 *   API 3327, register UI (live) 3330, admin UI tenant U 3331,
 *   admin UI tenant X 3332, register UI (demo) 3333.
 *
 * HTML harness: Node ships NO built-in DOM parser, so assertions are
 * targeted string/regex checks on the real HTTP responses (notice banner,
 * error div, modal ids, form inputs, table cells). Zero new dependencies;
 * localhost only, no external network.
 *
 * Modes per proof (see each test):
 *   - Live (real API + seeded admin-scope key): every admin proof, the
 *     register sales/W-12/query proofs.
 *   - Demo (no API; temp SQLite seeded with the demo catalogue via the
 *     product's own NodeSqliteStorageAdapter): Challenge 25 only. The
 *     demo catalogue is the ONLY catalogue carrying an age-restricted
 *     item (VAPE-1); the live handshake delta does not carry the
 *     age-restriction flag (documented known gap, README "known gaps").
 *     Note: a fresh demo boot from dist/ does NOT seed the demo catalogue
 *     (seedDemoCatalogue is false whenever a sqlite path is set — the
 *     in-memory path only), so the test seeds the temp file itself.
 *
 * Tenants (seeded in PGlite, each with an 'admin'-scope API key):
 *   U — UI Sales Ltd: variant UI-001, supplier, product, open VAT period.
 *   X — UI Exit Ltd: one OPEN register session (the D-11 blocker).
 *
 * Bugs this file exposed and fixed in this session:
 *   1. The manual goods-in form (no PO) sent no supplier/location/
 *      warehouse ids, so in live mode it always 400d with "Resource not
 *      found" (the handler fell back to demo ids). Fixed: the form now
 *      carries the ids — supplier as a text field (no supplier-list
 *      route exists), location/warehouse as hidden inputs fed by
 *      loadInventoryData (default warehouse's location when no PO);
 *      see views.ts / shell.ts. The same pass also found the handler
 *      dropped the manual form's quantityOrdered (it always fell back
 *      to the loaded PO lines, empty for a manual receipt), so any
 *      manual receipt with received > 0 failed validation — fixed in
 *      server.ts by carrying the form's ordered quantity through.
 *   2. The live admin shell never sent x-user-id, so every live render
 *      that loads a Build-02 route (e.g. listVariants) failed with
 *      "Missing required header: x-user-id" — surfacing as "Variants
 *      unavailable: ..." and swallowing real error banners. Fixed:
 *      createShellFromEnv now passes demoActor from ADMIN_USER_ID /
 *      ADMIN_USER_ROLES; see server.ts.
 *   3. Live variant creation via the admin shell always 400s with
 *      "tax_rate_id is required for a variant": the form has no tax-rate
 *      field and the handler passes null, and no tax-rates list route
 *      exists. Asserted as the error-banner proof; the full fix needs a
 *      new API route, so it is reported, not half-fixed here.
 *   4. Voucher codes are four dashed groups of four (XXXX-XXXX-XXXX-
 *      XXXX, 19 chars) — not bare 16-char strings; the extractor and
 *      assertions use the dashed format.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  applyMigrations,
  createPGliteDb,
  createTestApiKey,
  findMigrationsDir,
  seedTenant,
  seedVariant,
  setStock,
  type SeededTenant,
} from '@uk-pos/db';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_PORT = 3327;
const REGISTER_LIVE_PORT = 3330;
const ADMIN_U_PORT = 3331;
const ADMIN_X_PORT = 3332;
const REGISTER_DEMO_PORT = 3333;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_LIVE_PORT}`;
const REGISTER_DEMO_BASE = `http://localhost:${REGISTER_DEMO_PORT}`;
const ADMIN_U_BASE = `http://localhost:${ADMIN_U_PORT}`;
const ADMIN_X_BASE = `http://localhost:${ADMIN_X_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');
const ADMIN_ENTRY = join(ROOT, 'apps/admin-web/dist/ui/server.js');

const UI_SKU = 'UI-001';
const UI_BARCODE = '5012345678900';
const UI_NAME = 'UI Widget';
const UI_PRICE_PENCE = 1200n;
const FLOAT_PENCE = 5000n;
const VAPE_BARCODE = '5012345678902';
const MANAGER_PIN = '1234';

// ---------------------------------------------------------------------
// Small helpers (same patterns as apps/api/test/e2e/build06-e2e.test.ts)
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
// HTML harness — targeted string/regex assertions on real responses.
// Node has no built-in DOM parser; this is the zero-dependency harness.
// ---------------------------------------------------------------------

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

/** Text of the admin shell's error banner (`<div class="error">`), or null. */
function adminError(html: string): string | null {
  const match = /<div class="error">([\s\S]*?)<\/div>/.exec(html);
  if (match === null || match[1] === undefined) return null;
  return decodeEntities(match[1].replace(/<[^>]*>/g, ''));
}

/** True when the HTML contains an element with the given id. */
function hasId(html: string, id: string): boolean {
  return html.includes(`id="${id}"`);
}

/** The hidden attempt-id of the first pending card attempt form, or null. */
function extractAttemptId(html: string): string | null {
  const match = /name="attempt-id" value="([^"]+)"/.exec(html);
  return match === null || match[1] === undefined ? null : match[1];
}

/**
 * Full voucher codes from the "Issued voucher codes — shown once" table:
 * each row is [code, last4, expires]. Codes are rendered as four dashed
 * groups of four unambiguous-alphabet chars (XXXX-XXXX-XXXX-XXXX,
 * 19 chars); the last-4 cell is only 4 chars and expires is a date or
 * '—', so the dashed pattern alone identifies the code cells.
 */
function extractIssuedCodes(html: string): string[] {
  const start = html.indexOf('Issued voucher codes');
  if (start === -1) return [];
  const section = html.slice(start, html.indexOf('</table>', start));
  const group = '[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}';
  return [...section.matchAll(new RegExp(`${group}-${group}-${group}-${group}`, 'g'))].map(
    (match) => match[0],
  );
}

/**
 * Inputs of the first `<form method="post" action="...">` whose HTML
 * contains the given marker string: name -> value ('' when no value).
 * Lets a test submit exactly the fields the rendered form carries.
 */
function parseFormInputs(html: string, action: string, marker: string): Map<string, string> {
  const inputs = new Map<string, string>();
  const formRe = new RegExp(`<form[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`, 'g');
  for (const form of html.matchAll(formRe)) {
    const body = form[1] ?? '';
    if (!body.includes(marker)) continue;
    for (const input of body.matchAll(/<input[^>]*>/g)) {
      const tag = input[0] ?? '';
      const name = /name="([^"]+)"/.exec(tag)?.[1];
      if (name === undefined) continue;
      const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
      inputs.set(name, decodeEntities(value));
    }
    return inputs;
  }
  return inputs;
}

// ---------------------------------------------------------------------
// Child-process management
// ---------------------------------------------------------------------

let apiChild: ChildProcess | null = null;
let registerLiveChild: ChildProcess | null = null;
let registerDemoChild: ChildProcess | null = null;
let adminUChild: ChildProcess | null = null;
let adminXChild: ChildProcess | null = null;

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

// ---------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build07-ui-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const REGISTER_SQLITE_PATH = join(TMP_DIR, 'register.sqlite');
const DEMO_SQLITE_PATH = join(TMP_DIR, 'demo-register.sqlite');
const WEBHOOK_KEY = randomBytes(32).toString('hex');
const DEVICE_SECRET = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  key: string;
}

let tenantU: TenantSet;
let tenantX: TenantSet;
let variantU: { variantId: string };
let supplierUId: string;
let productUId: string;
let vatPeriodUId: string;
let sessionXId: string;

// ---------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------

async function seedAll(): Promise<void> {
  const { db, close } = await createPGliteDb(PG_DATA_DIR);
  try {
    await applyMigrations(db, findMigrationsDir(ROOT));

    const mk = async (name: string): Promise<TenantSet> => {
      const tenant = await seedTenant(db, { name });
      const created = await createTestApiKey(db, tenant, { name: `${name} ui key`, scopes: ['admin'] });
      return { tenant, key: created.key };
    };

    tenantU = await mk('UI Sales Ltd');
    tenantX = await mk('UI Exit Ltd');

    const seeded = await seedVariant(db, tenantU.tenant, {
      sku: UI_SKU,
      barcode: UI_BARCODE,
      name: UI_NAME,
      pricePence: UI_PRICE_PENCE,
      costPence: 800n,
      taxRateId: tenantU.tenant.taxRates.standard,
    });
    variantU = { variantId: seeded.variantId };
    await setStock(db, tenantU.tenant, seeded.variantId, { quantity: 10n, costPence: 800n });

    const supplier = await db
      .insertInto('suppliers')
      .values({ tenant_id: tenantU.tenant.tenantId, name: 'UI Supplies Ltd', currency: 'GBP' })
      .returning('id')
      .executeTakeFirstOrThrow();
    supplierUId = supplier.id;

    const product = await db
      .insertInto('products')
      .values({ tenant_id: tenantU.tenant.tenantId, name: 'UI Product', is_active: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    productUId = product.id;

    const period = await db
      .insertInto('vat_periods')
      .values({
        tenant_id: tenantU.tenant.tenantId,
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        status: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    vatPeriodUId = period.id;

    const session = await db
      .insertInto('register_sessions')
      .values({
        tenant_id: tenantX.tenant.tenantId,
        register_id: tenantX.tenant.registerId,
        opened_by_user_id: tenantX.tenant.users.owner.id,
        float_pence: FLOAT_PENCE,
        status: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    sessionXId = session.id;
  } finally {
    await close();
  }
}

/**
 * Seed the demo catalogue into the demo register's temp SQLite file with
 * the product's own storage adapter. A fresh demo boot from dist/ does
 * NOT seed it (seedDemoCatalogue is false whenever a sqlite path is set),
 * so without this the demo till has an empty catalogue and nothing to
 * scan — the Challenge 25 proof would have nothing to act on.
 */
async function seedDemoCatalogue(): Promise<void> {
  const require = createRequire(join(ROOT, 'package.json'));
  const mod = require(join(
    ROOT,
    'apps/register-app/dist/apps/register-app/src/storage/sqlite-storage.js',
  )) as {
    NodeSqliteStorageAdapter: new (
      path: string,
      options?: Record<string, unknown>,
    ) => {
      upsertCatalog: (entries: Array<Record<string, unknown>>) => Promise<void>;
      close: () => void;
    };
  };
  const adapter = new mod.NodeSqliteStorageAdapter(DEMO_SQLITE_PATH);
  try {
    await adapter.upsertCatalog([
      {
        variantId: 'demo-v-1', sku: 'WIDGET-1', barcode: '5012345678900', name: 'Demo Widget',
        pricePence: 1200n, priceBookPricePence: 1000n, taxRateKind: 'standard', taxRatePercent: '20.00',
        stockOnHand: 25n, stockComputedAt: '2026-11-13T12:00:00.000Z', requiresChallenge25: false,
        // Build-08 Obj 3 must-fix: upsertCatalog binds 13 columns since
        // Obj 2 added min_age_years — an entry without minAge throws
        // "Provided value cannot be bound to SQLite parameter 12".
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
    ]);
  } finally {
    adapter.close();
  }
}

// ---------------------------------------------------------------------
// API helpers (Bearer key + tenant/location headers)
// ---------------------------------------------------------------------

function apiHeaders(t: TenantSet): Record<string, string> {
  return {
    ...bearer(t.key),
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    // Build-02 routes (inventory stock, events list) build their actor
    // from these headers and 400 without x-user-id.
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
  // The route wraps the rows: { stock: [{ variantId, warehouseId, quantityOnHand }] }.
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

async function registerAction(params: Record<string, string>, base = REGISTER_BASE): Promise<HttpResult> {
  return postForm(base, '/action', params);
}

async function registerPage(base = REGISTER_BASE): Promise<string> {
  const res = await http(`${base}/`);
  expect(res.status, `GET ${base}/`).toBe(200);
  return res.text;
}

async function adminGet(base: string, path: string): Promise<HttpResult> {
  return http(`${base}${path}`);
}

async function adminPost(base: string, path: string, params: Record<string, string> = {}): Promise<HttpResult> {
  return postForm(base, path, params);
}

/** Drive one live card sale to the W-12 locked state; returns the attempt id. */
async function driveToUnknown(): Promise<string> {
  // Basket hygiene: a leftover line from an earlier test would corrupt
  // the split (the split must equal this sale's £12.00 exactly).
  const cleared = await registerAction({ action: 'clear' });
  expect(cleared.status, 'clear basket before the W-12 sale').toBe(303);
  const add = await registerAction({ action: 'quick-key', sku: UI_SKU });
  expect(add.status, 'quick-key for W-12 sale').toBe(303);
  const split = await registerAction({ action: 'split-tender' });
  expect(split.status, 'split-tender for W-12 sale').toBe(303);
  const tender = await registerAction({
    action: 'add-tender',
    'tender-kind': 'card',
    'tender-amount-pence': '1200',
  });
  expect(tender.status, 'add card tender for W-12 sale').toBe(303);
  const checkout = await registerAction({ action: 'checkout-online' });
  expect(checkout.status, 'checkout-online for W-12 sale').toBe(303);
  let page = await registerPage();
  expect(page, 'card tender sent — result needed').toContain('Card tender sent');
  const attemptId = extractAttemptId(page);
  expect(attemptId, 'pending card attempt id is rendered').not.toBeNull();
  const unknown = await registerAction({
    action: 'card-outcome',
    'attempt-id': attemptId as string,
    outcome: 'unknown',
  });
  expect(unknown.status, 'card-outcome unknown').toBe(303);
  page = await registerPage();
  expect(page, 'W-12 modal renders when locked').toContain('id="w12-modal"');
  expect(registerNotice(page), 'W-12 lock notice').toContain('Payment outcome unknown');
  return attemptId as string;
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-07 Objective 3 — interactive UI execution over real HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);
    expect(existsSync(ADMIN_ENTRY)).toBe(true);

    await seedAll();
    await seedDemoCatalogue();

    // Hardening (Build-12 Objective 4 — the Build-11 3-gate
    // bootstrap): the old bootstrap only awaited an UNAUTHENTICATED
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
    apiChild = spawnLogged('api', 'node', [API_ENTRY], {
      ...process.env,
      PORT: String(API_PORT),
      NODE_ENV: 'production',
      PGLITE_DATA_DIR: PG_DATA_DIR,
      WEBHOOK_ENCRYPTION_KEY: WEBHOOK_KEY,
      STATUTORY_ARCHIVE_DIR: ARCHIVE_DIR,
    });
    await waitFor('API to answer /payments/status', async () => {
      const res = await http(`${API_BASE}/payments/status`);
      return res.status === 200;
    });
    if (apiChild === null || apiChild.exitCode !== null) {
      throw new Error(
        `API child exited during startup (exit code ${apiChild?.exitCode ?? 'unknown'} — see ${join(TMP_DIR, 'api.log')}); refusing to run against whatever answers on port ${API_PORT}`,
      );
    }
    const apiReady = await apiGet(tenantU, '/v1/tax-rates');
    if (apiReady.status !== 200) {
      throw new Error(
        `API on port ${API_PORT} answered /v1/tax-rates with ${apiReady.status} for the seeded admin key — the process answering is not our seeded server (another process may hold the port, or the server opened a different database); refusing to proceed`,
      );
    }

    // Gate 1 for each UI child too (port free before spawn — a
    // leftover fails fast here naming the port, instead of the
    // /health wait timing out with no cause).
    await waitForPortFree(REGISTER_LIVE_PORT);
    registerLiveChild = spawnLogged('register-live', 'node', [REGISTER_ENTRY], {
      ...process.env,
      REGISTER_UI_PORT: String(REGISTER_LIVE_PORT),
      REGISTER_API_BASE_URL: API_BASE,
      REGISTER_API_KEY: tenantU.key,
      REGISTER_TENANT_ID: tenantU.tenant.tenantId,
      REGISTER_LOCATION_ID: tenantU.tenant.locationId,
      REGISTER_REGISTER_ID: tenantU.tenant.registerId,
      REGISTER_USER_ID: tenantU.tenant.users.owner.id,
      REGISTER_ROLES: 'cashier',
      REGISTER_SQLITE_PATH,
      REGISTER_APP_DEVICE_SECRET: DEVICE_SECRET,
    });
    await waitFor('register UI (live) to answer /health', async () => {
      const res = await http(`${REGISTER_BASE}/health`);
      return res.status === 200;
    });
    // The live catalogue syncs on boot; wait until the seeded variant
    // is actually on the page before any sale drives it.
    await waitFor('live register page to show the seeded variant', async () => {
      const page = await registerPage();
      return page.includes(UI_NAME) && !page.includes('API unreachable');
    }, 60_000);

    await waitForPortFree(REGISTER_DEMO_PORT);
    registerDemoChild = spawnLogged('register-demo', 'node', [REGISTER_ENTRY], {
      ...process.env,
      REGISTER_UI_PORT: String(REGISTER_DEMO_PORT),
      REGISTER_API_BASE_URL: 'http://localhost:3999',
      REGISTER_SQLITE_PATH: DEMO_SQLITE_PATH,
    });
    await waitFor('register UI (demo) to answer /health', async () => {
      const res = await http(`${REGISTER_DEMO_BASE}/health`);
      return res.status === 200;
    });
    await waitFor('demo register page to show the seeded demo catalogue', async () => {
      const page = await registerPage(REGISTER_DEMO_BASE);
      return page.includes('Demo Vape Liquid');
    }, 60_000);

    await waitForPortFree(ADMIN_U_PORT);
    adminUChild = spawnLogged('admin-u', 'node', [ADMIN_ENTRY], {
      ...process.env,
      ADMIN_WEB_PORT: String(ADMIN_U_PORT),
      ADMIN_API_BASE_URL: API_BASE,
      ADMIN_API_TOKEN: tenantU.key,
      ADMIN_TENANT_ID: tenantU.tenant.tenantId,
      ADMIN_LOCATION_ID: tenantU.tenant.locationId,
      // The live shell must identify its operator: the Build-02 routes
      // (e.g. listVariants) require x-user-id, and without it every
      // live render that loads them fails (fixed in this session).
      ADMIN_USER_ID: tenantU.tenant.users.owner.id,
      ADMIN_USER_ROLES: 'owner',
    });
    await waitFor('admin UI (tenant U) to answer /health', async () => {
      const res = await http(`${ADMIN_U_BASE}/health`);
      return res.status === 200;
    });

    await waitForPortFree(ADMIN_X_PORT);
    adminXChild = spawnLogged('admin-x', 'node', [ADMIN_ENTRY], {
      ...process.env,
      ADMIN_WEB_PORT: String(ADMIN_X_PORT),
      ADMIN_API_BASE_URL: API_BASE,
      ADMIN_API_TOKEN: tenantX.key,
      ADMIN_TENANT_ID: tenantX.tenant.tenantId,
      ADMIN_LOCATION_ID: tenantX.tenant.locationId,
      ADMIN_USER_ID: tenantX.tenant.users.owner.id,
      ADMIN_USER_ROLES: 'owner',
    });
    await waitFor('admin UI (tenant X) to answer /health', async () => {
      const res = await http(`${ADMIN_X_BASE}/health`);
      return res.status === 200;
    });
  }, 180_000);

  afterAll(async () => {
    await stopChild(registerLiveChild, REGISTER_LIVE_PORT);
    await stopChild(registerDemoChild, REGISTER_DEMO_PORT);
    await stopChild(adminUChild, ADMIN_U_PORT);
    await stopChild(adminXChild, ADMIN_X_PORT);
    await stopChild(apiChild, API_PORT);
    // /tmp is a 512MB tmpfs: each run leaves a 40–60MB pgdata behind.
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-07 UI temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('boots all five servers; live shells show LIVE, demo shell shows the demo catalogue', async () => {
    const apiStatus = await http(`${API_BASE}/payments/status`);
    expect(apiStatus.status).toBe(200);

    const registerHealth = await http(`${REGISTER_BASE}/health`);
    expect(registerHealth.status).toBe(200);
    const livePage = await registerPage();
    expect(livePage).not.toContain('API unreachable');
    expect(livePage).toContain('Live — connected to the API');

    for (const view of ['/', '/catalogue', '/inventory', '/crm', '/finance', '/webhooks', '/exit']) {
      const page = await adminGet(ADMIN_U_BASE, view);
      expect(page.status, `admin U view ${view}`).toBe(200);
    }
    const adminHome = await adminGet(ADMIN_U_BASE, '/');
    expect(adminHome.text).toContain('LIVE');
    expect(adminHome.text).not.toContain('DEMO DATA');
    // The catalogue view actually lists the live variants — proving
    // listVariants works over the live client (it needs x-user-id).
    const catalogue = await adminGet(ADMIN_U_BASE, '/catalogue');
    expect(catalogue.text, 'live catalogue lists the seeded variant').toContain(UI_SKU);

    const demoPage = await registerPage(REGISTER_DEMO_BASE);
    expect(demoPage).toContain('API unreachable');
    expect(demoPage).toContain('Demo Vape Liquid');

    const adminXHome = await adminGet(ADMIN_X_BASE, '/');
    expect(adminXHome.status).toBe(200);
    expect(adminXHome.text).toContain('LIVE');
  }, 120_000);

  it('(1) register form posts: scan + search round-trips change page state (live)', async () => {
    const scan = await registerAction({ action: 'scan', barcode: UI_BARCODE });
    expect(scan.status, 'scan action posts and redirects').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'scan notice').toContain(`Added ${UI_NAME}.`);
    expect(page, 'basket shows the scanned line').toContain(UI_SKU);

    const search = await registerAction({ action: 'search', 'search-query': 'Widget' });
    expect(search.status, 'search action posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'search notice').toContain('1 result for “Widget”.');
    expect(page, 'search results render the variant').toContain(UI_NAME);

    const miss = await registerAction({ action: 'search', 'search-query': 'zzz-no-match' });
    expect(miss.status, 'empty search posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'empty search notice').toContain('0 results for “zzz-no-match”.');
  }, 120_000);

  it('(3) register error banners: empty checkout + bad manager PIN (live)', async () => {
    const cleared = await registerAction({ action: 'clear' });
    expect(cleared.status, 'clear basket').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'clear notice').toContain('Basket cleared.');

    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'empty checkout posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'empty-basket error banner').toContain('Cannot check out an empty basket');

    const pin = await registerAction({ action: 'pin-approve', pin: '12' });
    expect(pin.status, 'bad PIN posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'bad-PIN error banner').toContain('Manager PIN must be 4–12 digits');
  }, 120_000);

  it('(1) admin form post: price-book create round-trips to the catalogue view (live)', async () => {
    const created = await adminPost(ADMIN_U_BASE, '/catalogue/price-books/create', {
      name: 'UI-BOOK',
      priority: '1',
      effectiveFrom: '2026-11-01',
      effectiveTo: '',
    });
    expect(created.status, 'price-book create redirects').toBe(303);
    const page = await adminGet(ADMIN_U_BASE, '/catalogue');
    expect(page.status).toBe(200);
    expect(page.text, 'new price book renders on the catalogue view').toContain('UI-BOOK');
  }, 120_000);

  it('(3) admin error banners: client validation + live tax-rate gap (live)', async () => {
    // Client-side validation: empty SKU/name never reach the API.
    const invalid = await adminPost(ADMIN_U_BASE, '/catalogue/variants/create', {
      productId: productUId,
      sku: '',
      barcode: '',
      name: '',
      pricePence: '100',
      costPence: '0',
    });
    expect(invalid.status, 'invalid variant create answers 400').toBe(400);
    expect(adminError(invalid.text), 'client-validation error banner').toContain('SKU is required.');

    // A complete, valid-looking form still 400s live: the form has no
    // tax-rate field and the handler passes taxRateId null, while the
    // API requires one — and no tax-rates list route exists to fill a
    // selector from. This assertion documents the gap (fix needs a new
    // API route, out of Objective 3 scope); the banner itself is the
    // proof that failures surface on the page instead of crashing.
    const noTax = await adminPost(ADMIN_U_BASE, '/catalogue/variants/create', {
      productId: productUId,
      sku: 'UI-VAR-2',
      barcode: '',
      name: 'UI Variant 2',
      pricePence: '1500',
      costPence: '800',
    });
    expect(noTax.status, 'variant create without a tax rate answers 400').toBe(400);
    expect(adminError(noTax.text), 'tax-rate error banner').toContain('tax_rate_id is required for a variant');
  }, 120_000);

  it('(2) query state transitions: finance ?z= / ?vat= (live, real Z-report)', async () => {
    // Real Z-report: open a session, sell £12.00 cash through the
    // register UI inside it, end + close over the API.
    const opened = await apiPost(tenantU, '/v1/reporting/sessions', {
      registerId: tenantU.tenant.registerId,
      openingFloatPence: FLOAT_PENCE.toString(),
    });
    expect(opened.status, 'open session for tenant U').toBe(201);
    const sessionId = (expectJsonObject(opened).session as Record<string, unknown>).id as string;

    const sync = await registerAction({ action: 'sync-catalogue' });
    expect(sync.status, 'sync-catalogue before the sale').toBe(303);
    const add = await registerAction({ action: 'quick-key', sku: UI_SKU });
    expect(add.status, 'quick-key for the session sale').toBe(303);
    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online for the session sale').toBe(303);
    let page = await registerPage();
    expect(page, 'session sale completes').toContain('Sale completed');

    const ended = await apiPost(tenantU, `/v1/reporting/sessions/${sessionId}/end`, {});
    expect(ended.status, 'end session').toBe(201);
    expect((expectJsonObject(ended).session as Record<string, unknown>).expected_cash_pence).toBe('6200');
    const closed = await apiPost(tenantU, `/v1/reporting/sessions/${sessionId}/close`, {
      countedCashPence: '6200',
    });
    expect(closed.status, 'close session').toBe(201);
    const zReport = expectJsonObject(closed).zReport as Record<string, unknown>;
    expect(zReport.gross_pence).toBe('1200');
    const zReportId = zReport.id as string;

    // No query: neither detail is loaded.
    const bare = await adminGet(ADMIN_U_BASE, '/finance');
    expect(bare.status).toBe(200);
    expect(bare.text, 'bare finance shows no Z-report').toContain('No Z-report loaded.');
    expect(bare.text, 'bare finance shows no VAT period').toContain('No VAT period loaded.');

    // ?z=: the same page now renders this Z-report (and only it).
    const withZ = await adminGet(ADMIN_U_BASE, `/finance?z=${encodeURIComponent(zReportId)}`);
    expect(withZ.status).toBe(200);
    expect(withZ.text, '?z= renders the Z-report CSV link').toContain(`/download/z-report/${zReportId}`);
    expect(withZ.text, '?z= renders the gross').toContain('£12.00');

    // ?vat=: the same page now renders this VAT period, open, with its
    // close button — then the shell closes it and the badge flips.
    const withVat = await adminGet(ADMIN_U_BASE, `/finance?vat=${encodeURIComponent(vatPeriodUId)}`);
    expect(withVat.status).toBe(200);
    expect(withVat.text, '?vat= renders the period range').toContain('2026-11-01 → 2026-11-30');
    expect(withVat.text, '?vat= renders the close button while open').toContain('Close VAT period');

    const vatClose = await adminPost(ADMIN_U_BASE, `/finance/vat-periods/${vatPeriodUId}/close`);
    expect(vatClose.status, 'VAT close through the shell').toBe(200);
    expect(vatClose.text, 'VAT close confirmation').toContain(`VAT period ${vatPeriodUId} closed in place`);
    expect(vatClose.text, 'CLOSED badge renders after close').toContain('CLOSED');

    const vatAgain = await adminGet(ADMIN_U_BASE, `/finance?vat=${encodeURIComponent(vatPeriodUId)}`);
    expect(vatAgain.status).toBe(200);
    expect(vatAgain.text, 'CLOSED badge persists on re-read').toContain('CLOSED');
    expect(vatAgain.text, 'close button is gone once closed').not.toContain('Close VAT period');

    // Unknown id: the page still answers 200 with no Z-report loaded —
    // never a crash.
    const unknownZ = await adminGet(
      ADMIN_U_BASE,
      '/finance?z=11111111-2222-3333-4444-555555555555',
    );
    expect(unknownZ.status, 'unknown ?z= still answers 200').toBe(200);
    expect(unknownZ.text, 'unknown ?z= loads no Z-report').toContain('No Z-report loaded.');
  }, 180_000);

  it('(4) Challenge 25 approval AND refusal through the register UI (demo)', async () => {
    const scan = await registerAction({ action: 'scan', barcode: VAPE_BARCODE }, REGISTER_DEMO_BASE);
    expect(scan.status, 'scan VAPE-1 in demo mode').toBe(303);
    let page = await registerPage(REGISTER_DEMO_BASE);
    expect(registerNotice(page), 'scan notice').toContain('Added Demo Vape Liquid.');
    expect(page, 'Challenge 25 modal renders unverified').toContain('id="challenge-25-modal"');
    expect(page, 'modal names the restricted SKU').toContain('VAPE-1');
    expect(page, 'modal has Approve + Refuse buttons').toContain('data-testid="age-approve"');
    expect(page, 'modal has Refuse button').toContain('data-testid="age-refuse"');
    expect(page, 'modal is not yet verified').not.toContain('data-verified-threshold');

    // Refusal: checkout stays blocked.
    const refuse = await registerAction({ action: 'age-refuse' }, REGISTER_DEMO_BASE);
    expect(refuse.status, 'age-refuse posts and redirects').toBe(303);
    page = await registerPage(REGISTER_DEMO_BASE);
    expect(registerNotice(page), 'refusal notice').toContain('Age verification refused');
    expect(page, 'modal still unverified after refusal').not.toContain('data-verified-threshold');

    const blocked = await registerAction({ action: 'checkout-cash' }, REGISTER_DEMO_BASE);
    expect(blocked.status, 'blocked checkout posts and redirects').toBe(303);
    page = await registerPage(REGISTER_DEMO_BASE);
    expect(registerNotice(page), 'refused sale cannot check out').toContain(
      'Age verification required before checkout: VAPE-1',
    );

    // Approval: the same basket now checks out.
    const approve = await registerAction({ action: 'age-approve' }, REGISTER_DEMO_BASE);
    expect(approve.status, 'age-approve posts and redirects').toBe(303);
    page = await registerPage(REGISTER_DEMO_BASE);
    expect(registerNotice(page), 'approval notice').toContain('Challenge 25 verified (threshold 25).');
    expect(page, 'modal shows the verified threshold').toContain('data-verified-threshold="25"');

    const checkout = await registerAction({ action: 'checkout-cash' }, REGISTER_DEMO_BASE);
    expect(checkout.status, 'approved checkout posts and redirects').toBe(303);
    page = await registerPage(REGISTER_DEMO_BASE);
    expect(registerNotice(page), 'approved offline sale queues').toContain('Offline cash sale queued');
  }, 120_000);

  it('(5) W-12 resolution 1: poll provider status → approved, sale completes (live)', async () => {
    await driveToUnknown();
    const resolved = await registerAction({
      action: 'w12-poll',
      'w12-outcome': 'approved',
    });
    expect(resolved.status, 'w12-poll posts and redirects').toBe(303);
    const page = await registerPage();
    expect(page, 'poll-approved completes the sale').toContain('Sale completed');
    expect(page, 'poll-approved receipt total').toContain('£12.00');
    expect(page, 'W-12 modal is gone after poll-approved').not.toContain('id="w12-modal"');
    expect(page, 'no pending card attempts remain').not.toContain('id="pending-card-attempts"');
  }, 120_000);

  it('(5) W-12 resolutions 2+3: reconcile declined, then manager void + retry (live)', async () => {
    await driveToUnknown();
    const reconciled = await registerAction({
      action: 'w12-reconcile',
      'w12-outcome': 'declined',
      'terminal-evidence': 'S700 report 2026-11-14/07',
    });
    expect(reconciled.status, 'w12-reconcile posts and redirects').toBe(303);
    let page = await registerPage();
    expect(registerNotice(page), 'reconcile notice').toContain(
      'Terminal reconciled — payment resolved, register unlocked.',
    );
    expect(page, 'W-12 modal is gone after reconcile').not.toContain('id="w12-modal"');
    expect(page, 'declined order stays open for a manager void').toContain('is waiting on the API');

    // The manager void creates an approval, and the API only lets a
    // manager/admin/owner approve — the register UI's actor is the
    // cashier until a manager PIN logs in. So verify the manager PIN
    // first (pin-approve stores the manager session token), then void.
    const pinApproved = await registerAction({
      action: 'pin-approve',
      'tenant-id': tenantU.tenant.tenantId,
      'manager-user-id': tenantU.tenant.users.manager.id,
      pin: MANAGER_PIN,
    });
    expect(pinApproved.status, 'pin-approve posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'manager PIN verified live').toContain('Manager PIN verified live');

    const voided = await registerAction({ action: 'w12-manager', 'manager-pin': MANAGER_PIN });
    expect(voided.status, 'w12-manager posts and redirects').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'manager void notice').toContain('Order voided under manager approval');
    expect(page, 'voided order no longer waits').not.toContain('is waiting on the API');

    const cleared = await registerAction({ action: 'clear' });
    expect(cleared.status, 'clear after manager void').toBe(303);
    page = await registerPage();
    expect(registerNotice(page), 'basket cleared after void').toContain('Basket cleared.');
  }, 120_000);

  it('(5) W-12 resolution 4: manager standalone reference → approved (live)', async () => {
    await driveToUnknown();
    // Same manager-session prerequisite as the void path: the
    // standalone resolution also creates a void_post_tender approval.
    const pinApproved = await registerAction({
      action: 'pin-approve',
      'tenant-id': tenantU.tenant.tenantId,
      'manager-user-id': tenantU.tenant.users.manager.id,
      pin: MANAGER_PIN,
    });
    expect(pinApproved.status, 'pin-approve posts and redirects').toBe(303);
    const pinPage = await registerPage();
    expect(registerNotice(pinPage), 'manager PIN verified live').toContain('Manager PIN verified live');

    const resolved = await registerAction({
      action: 'w12-manager-standalone',
      'standalone-reference': 'STAND-001',
      'manager-pin': MANAGER_PIN,
    });
    expect(resolved.status, 'w12-manager-standalone posts and redirects').toBe(303);
    const page = await registerPage();
    expect(page, 'standalone-approved completes the sale').toContain('Sale completed');
    expect(page, 'W-12 modal is gone after standalone').not.toContain('id="w12-modal"');

    // The reference the manager typed in is on the attempt's AUDIT
    // event (payment_attempt.outcome is recorded via the audit log,
    // not the webhook outbox — GET /v1/events correctly returns none).
    const events = await apiGet(
      tenantU,
      '/v1/audit-events?eventType=payment_attempt.outcome&limit=5',
    );
    expect(events.status, 'GET /v1/audit-events for the standalone reference').toBe(200);
    expect(events.text, 'standalone reference recorded on the outcome event').toContain('STAND-001');
  }, 120_000);

  it('(6) goods-in 0-default: the rendered manual form submits with received=0 and books no stock (live)', async () => {
    // Submit exactly what the rendered manual form carries. Pre-fix the
    // form had no supplier/location/warehouse inputs, so a live submit
    // fell back to demo ids and 400d "Resource not found".
    const inventory = await adminGet(ADMIN_U_BASE, '/inventory');
    expect(inventory.status).toBe(200);
    const form = parseFormInputs(inventory.text, '/inventory/goods-in', 'name="variantId"');
    expect(form.size, 'manual goods-in form renders').toBeGreaterThan(0);
    expect(form.has('supplierId'), 'manual form carries a supplier id field (fix)').toBe(true);
    expect(form.has('locationId'), 'manual form carries a location id field (fix)').toBe(true);
    expect(form.has('warehouseId'), 'manual form carries a warehouse id field (fix)').toBe(true);
    expect(form.get('quantityReceived'), 'received defaults to 0 (D-AW-05)').toBe('0');

    const submitParams: Record<string, string> = { ...Object.fromEntries(form) };
    submitParams.variantId = variantU.variantId;
    submitParams.quantityOrdered = '1';
    submitParams.quantityReceived = '0';
    submitParams.costPence = '800';
    submitParams.supplierId = supplierUId;
    // Stock is whatever the earlier sales left (10 seeded minus the
    // completed sales so far) — the invariant is the DELTA, not 10.
    const before = await stockOnHand(tenantU, variantU.variantId);
    expect(before, 'stock on hand before the 0 receipt').not.toBeNull();

    const submitted = await adminPost(ADMIN_U_BASE, '/inventory/goods-in', submitParams);
    expect(submitted.status, '0-quantity goods-in posts and redirects').toBe(303);

    const afterZero = await stockOnHand(tenantU, variantU.variantId);
    expect(afterZero, 'a 0-quantity receipt books no stock movement').toBe(before);

    // The same form with a real quantity does move stock — proving the
    // 0 was a no-op by design, not a dead form. (Ordered must cover
    // received: the form rejects received > ordered.)
    const submitTwo = { ...submitParams, quantityOrdered: '2', quantityReceived: '2' };
    const submittedTwo = await adminPost(ADMIN_U_BASE, '/inventory/goods-in', submitTwo);
    expect(submittedTwo.status, '2-quantity goods-in posts and redirects').toBe(303);
    const afterTwo = await stockOnHand(tenantU, variantU.variantId);
    expect(afterTwo, 'a 2-quantity receipt adds 2 to stock').toBe(String(BigInt(before as string) + 2n));
  }, 120_000);

  it('(7) bulk voucher show-once: codes in the POST response only, never on a later GET (live)', async () => {
    const generated = await adminPost(ADMIN_U_BASE, '/catalogue/vouchers/generate', {
      count: '2',
      maxUses: '1',
    });
    expect(generated.status, 'voucher generate renders 200').toBe(200);
    expect(generated.text, 'show-once section renders').toContain('Issued voucher codes');
    const codes = extractIssuedCodes(generated.text);
    expect(codes.length, 'two codes issued').toBe(2);
    expect(codes[0]).not.toBe(codes[1]);
    for (const code of codes) {
      // Four dashed groups of four unambiguous chars (19 chars total).
      expect(code.length, 'each code is 4x4 dashed').toBe(19);
      expect(code, 'code groups are four chars each').toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }

    const later = await adminGet(ADMIN_U_BASE, '/catalogue');
    expect(later.status).toBe(200);
    for (const code of codes) {
      expect(later.text, `full code ${code} never re-appears`).not.toContain(code);
      expect(later.text, `only the last 4 of ${code} are readable later`).toContain(code.slice(-4));
    }
    expect(later.text, 'show-once section is absent on a later GET').not.toContain('Issued voucher codes');
  }, 120_000);

  it('(8) D-11 exit blocker renders on the exit page and blocks termination (live)', async () => {
    const exitPage = await adminGet(ADMIN_X_BASE, '/exit');
    expect(exitPage.status).toBe(200);
    expect(exitPage.text, 'exit page shows the D-11 BLOCKED badge').toContain('D-11 BLOCKED');
    expect(exitPage.text, 'exit page names the open session').toContain(sessionXId);
    expect(exitPage.text, 'exit page labels the blocker').toContain('Open register session:');

    const blocked = await adminPost(ADMIN_X_BASE, '/exit/request-termination');
    expect(blocked.status, 'blocked termination renders 200 with the error').toBe(200);
    expect(adminError(blocked.text), 'D-11 block message names the session').toContain(
      `Termination blocked (D-11): open sessions ${sessionXId}`,
    );

    // Resolve the blocker over the API; the exit page flips to clear.
    const ended = await apiPost(tenantX, `/v1/reporting/sessions/${sessionXId}/end`, {});
    expect(ended.status, 'end the blocking session').toBe(201);
    expect((expectJsonObject(ended).session as Record<string, unknown>).expected_cash_pence).toBe('5000');
    const closed = await apiPost(tenantX, `/v1/reporting/sessions/${sessionXId}/close`, {
      countedCashPence: '5000',
    });
    expect(closed.status, 'close the blocking session').toBe(201);

    const clearPage = await adminGet(ADMIN_X_BASE, '/exit');
    expect(clearPage.status).toBe(200);
    expect(clearPage.text, 'no blockers once the session is closed').toContain('NO D-11 BLOCKERS');
    expect(clearPage.text, 'D-11 BLOCKED badge is gone').not.toContain('D-11 BLOCKED');
  }, 120_000);
});
