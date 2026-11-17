/**
 * Build-08 Objective 3 — Demo seed + fresh dist boot bootstrap.
 *
 * Boots the COMPILED API + Register UI (3130) + Admin Shell (3131) as
 * real child processes with ONLY `DEMO_SEED_ON_BOOT=true` set (plus
 * the API base URL and a temp SQLite path for the register — no
 * REGISTER_* or ADMIN_* ids, keys or tokens) and proves over real HTTP:
 *
 *   - the API seeds the demo on boot (no separate seed step);
 *   - the register root shows the seeded catalogue, including the
 *     Challenge 25 item, synced live from the API;
 *   - the admin /catalogue lists the seeded variants and the tax
 *     rates come back from GET /v1/tax-rates;
 *   - live variant creation through the admin form works with a real
 *     tax rate id (201/303, never the Build-07 400);
 *   - a live sale completes through the register UI and stock drops;
 *   - the seeded open session is live (a second open is refused).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults):
 *   API 3527, register UI 3530, admin UI 3531.
 *
 * NOTE on the admin tax-rate select: the catalogue view populates its
 * tax-rate options from `catalogue.listTaxRates`, whose route-table
 * entry is Obj 4's work — until then the shell renders the select
 * empty and records a section error (the page still answers 200).
 * This file therefore proves the rates through GET /v1/tax-rates
 * directly and proves variant creation by POSTing the form with a
 * real rate id (the POST path needs no list route). The select
 * population itself is covered by the Obj 1/Obj 4 tax-rates tests.
 *
 * Why child processes (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06). The
 * register/admin shells are plain node:http servers, so they boot
 * from dist/ directly. HTML assertions are targeted string checks —
 * Node ships no built-in DOM parser. Zero new dependencies; localhost
 * only, no external network.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  DEMO_API_KEY,
  DEMO_LOCATION_ID,
  DEMO_OWNER_ID,
  DEMO_REGISTER_ID,
  DEMO_TAX_EXEMPT_ID,
  DEMO_TAX_REDUCED_ID,
  DEMO_TAX_STANDARD_ID,
  DEMO_TAX_ZERO_ID,
  DEMO_TENANT_ID,
  DEMO_VARIANT_WIDGET_ID,
} from '@uk-pos/db';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_PORT = 3527;
const REGISTER_PORT = 3530;
const ADMIN_PORT = 3531;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;
const ADMIN_BASE = `http://localhost:${ADMIN_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');
const ADMIN_ENTRY = join(ROOT, 'apps/admin-web/dist/ui/server.js');

// ---------------------------------------------------------------------
// Small helpers (same patterns as build07-ui-interactions.test.ts)
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

function apiHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${DEMO_API_KEY}`,
    'x-tenant-id': DEMO_TENANT_ID,
    'x-location-id': DEMO_LOCATION_ID,
    'x-user-id': DEMO_OWNER_ID,
    'x-roles': 'owner',
    'Content-Type': 'application/json',
  };
}

async function apiGet(path: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders() });
}

async function apiPost(path: string, body: unknown = {}): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });
}

function expectJsonObject(result: HttpResult): Record<string, unknown> {
  expect(result.json).not.toBeNull();
  expect(typeof result.json).toBe('object');
  return result.json as Record<string, unknown>;
}

async function postForm(base: string, path: string, params: Record<string, string>): Promise<HttpResult> {
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

async function registerPage(): Promise<string> {
  const res = await http(`${REGISTER_BASE}/`);
  expect(res.status, 'GET register /').toBe(200);
  return res.text;
}

async function registerAction(params: Record<string, string>): Promise<HttpResult> {
  return postForm(REGISTER_BASE, '/action', params);
}

/** Live stock on hand for a variant, read over the API. */
async function stockOnHand(variantId: string): Promise<string | null> {
  const res = await apiGet(`/v1/inventory/stock?variantId=${encodeURIComponent(variantId)}`);
  expect(res.status, 'GET /v1/inventory/stock').toBe(200);
  const rows = expectJsonObject(res).stock as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(rows)).toBe(true);
  const row = (rows as Array<Record<string, unknown>>).find((r) => r.variantId === variantId);
  if (row === undefined) return null;
  const value = row.quantityOnHand;
  return value === undefined || value === null ? null : String(value);
}

// ---------------------------------------------------------------------
// Child-process management
// ---------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build08-demo-seed-'));
const REGISTER_SQLITE_PATH = join(TMP_DIR, 'register.sqlite');
mkdirSync(TMP_DIR, { recursive: true });

let apiChild: ChildProcess | null = null;
let registerChild: ChildProcess | null = null;
let adminChild: ChildProcess | null = null;
const childLogs: Record<string, string> = {};

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
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
// Suite
// ---------------------------------------------------------------------

describe('Build-08 Objective 3 — demo seed on boot, fresh dist servers', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);
    expect(existsSync(ADMIN_ENTRY)).toBe(true);

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
    //       seeded demo key — must answer 200, proving the process
    //       on this port is OUR server with OUR database. A 401 here
    //       is definitive, not transient: module init (DB open +
    //       migrations + demo seed) completes before listen(), so a
    //       live server that does not know our key is a stranger.
    // The TOCTOU gap remains (a process can bind between the free
    // check and the spawn) — collisions fail fast naming the cause,
    // they are not eliminated.
    await waitForPortFree(API_PORT);
    // The API seeds itself on boot (in-memory PGlite, no data dir):
    // the ONLY flag is DEMO_SEED_ON_BOOT=true.
    apiChild = spawnLogged('api', 'node', [API_ENTRY], {
      ...process.env,
      PORT: String(API_PORT),
      NODE_ENV: 'production',
      DEMO_SEED_ON_BOOT: 'true',
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
    const apiReady = await apiGet('/v1/tax-rates');
    if (apiReady.status !== 200) {
      throw new Error(
        `API on port ${API_PORT} answered /v1/tax-rates with ${apiReady.status} for the seeded demo key — the process answering is not our seeded server (another process may hold the port, or the server opened a different database); refusing to proceed`,
      );
    }

    // Gate 1 for the register UI too (port free before spawn — a
    // leftover fails fast here naming the port, instead of the
    // /health wait timing out with no cause).
    await waitForPortFree(REGISTER_PORT);
    // Register UI: only the flag + API base URL + a temp SQLite file.
    // No REGISTER_* ids, key or roles — the flag supplies them.
    registerChild = spawnLogged('register', 'node', [REGISTER_ENTRY], {
      ...process.env,
      REGISTER_UI_PORT: String(REGISTER_PORT),
      REGISTER_API_BASE_URL: API_BASE,
      REGISTER_SQLITE_PATH,
      DEMO_SEED_ON_BOOT: 'true',
    });
    await waitFor('register UI to answer /health', async () => {
      const res = await http(`${REGISTER_BASE}/health`);
      return res.status === 200;
    });
    // The live catalogue syncs on boot; wait until the seeded items
    // are actually on the page before any sale drives them.
    await waitFor('register page to show the seeded catalogue', async () => {
      const page = await registerPage();
      return page.includes('Demo Vape Liquid') && !page.includes('API unreachable');
    }, 60_000);

    // Gate 1 for the admin UI too (port free before spawn — a
    // leftover fails fast here naming the port, instead of the
    // /health wait timing out with no cause).
    await waitForPortFree(ADMIN_PORT);
    // Admin shell: only the flag + API base URL. No ADMIN_* vars —
    // the flag supplies the demo key, tenant, location and operator.
    adminChild = spawnLogged('admin', 'node', [ADMIN_ENTRY], {
      ...process.env,
      ADMIN_WEB_PORT: String(ADMIN_PORT),
      ADMIN_API_BASE_URL: API_BASE,
      DEMO_SEED_ON_BOOT: 'true',
    });
    await waitFor('admin UI to answer /health', async () => {
      const res = await http(`${ADMIN_BASE}/health`);
      return res.status === 200;
    });
  }, 180_000);

  afterAll(async () => {
    await stopChild(registerChild, REGISTER_PORT);
    await stopChild(adminChild, ADMIN_PORT);
    await stopChild(apiChild, API_PORT);
    // /tmp is a 512MB tmpfs: remove the temp dir (incl. the register
    // SQLite file) so repeated runs cannot leak disk.
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-08 demo-seed temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('boots all three servers from dist with only DEMO_SEED_ON_BOOT=true; register shows the seeded catalogue live', async () => {
    const apiStatus = await http(`${API_BASE}/payments/status`);
    expect(apiStatus.status).toBe(200);

    const registerHealth = await http(`${REGISTER_BASE}/health`);
    expect(registerHealth.status).toBe(200);
    const page = await registerPage();
    expect(page, 'live badge, not demo').toContain('Live — connected to the API');
    expect(page, 'register shows the seeded widget').toContain('Demo Widget');
    expect(page, 'register shows the seeded gadget').toContain('Demo Gadget');
    expect(page, 'register shows the Challenge 25 item').toContain('Demo Vape Liquid');
    expect(page, 'register shows the case-breakdown item').toContain('Demo Coffee Beans');
    expect(page, 'register shows the seeded SKUs').toContain('DEMO-WIDGET-1');
    expect(page, 'register shows the vape SKU').toContain('DEMO-VAPE-1');

    for (const view of ['/', '/catalogue', '/inventory', '/crm', '/finance', '/webhooks', '/exit']) {
      const res = await http(`${ADMIN_BASE}${view}`);
      expect(res.status, `admin view ${view}`).toBe(200);
    }
    const adminHome = await http(`${ADMIN_BASE}/`);
    expect(adminHome.text, 'admin shell is live, not demo').toContain('LIVE');
    expect(adminHome.text, 'admin shell shows no demo badge').not.toContain('DEMO DATA');
  }, 120_000);

  it('tax rates: GET /v1/tax-rates returns the four seeded UK rates', async () => {
    const res = await apiGet('/v1/tax-rates');
    expect(res.status, 'GET /v1/tax-rates').toBe(200);
    // The endpoint returns a bare array of TaxRateView rows.
    expect(Array.isArray(res.json)).toBe(true);
    const rates = res.json as Array<Record<string, unknown>>;
    expect(rates).toHaveLength(4);
    const byId = new Map(rates.map((r) => [r.id, r]));
    expect(byId.get(DEMO_TAX_STANDARD_ID)).toMatchObject({ name: 'Standard 20%', rate_bps: 2000, is_exempt: false, is_default_no_tax: false });
    expect(byId.get(DEMO_TAX_REDUCED_ID)).toMatchObject({ name: 'Reduced 5%', rate_bps: 500 });
    expect(byId.get(DEMO_TAX_ZERO_ID)).toMatchObject({ name: 'Zero-rated 0%', rate_bps: 0, is_default_no_tax: true });
    expect(byId.get(DEMO_TAX_EXEMPT_ID)).toMatchObject({ name: 'Exempt', rate_bps: 0, is_exempt: true, is_default_no_tax: true });
    const names = rates.map((r) => r.name).sort();
    expect(names).toEqual(['Exempt', 'Reduced 5%', 'Standard 20%', 'Zero-rated 0%']);
  }, 60_000);

  it('admin /catalogue lists the seeded variants; variant creation through the form works with a real rate', async () => {
    const catalogue = await http(`${ADMIN_BASE}/catalogue`);
    expect(catalogue.status, 'GET admin /catalogue').toBe(200);
    for (const sku of ['DEMO-WIDGET-1', 'DEMO-GADGET-1', 'DEMO-VAPE-1', 'DEMO-COFFEE-CASE']) {
      expect(catalogue.text, `admin catalogue lists ${sku}`).toContain(sku);
    }
    expect(catalogue.text, 'variant-create form renders').toContain('/catalogue/variants/create');
    expect(catalogue.text, 'variant-create form has the tax-rate select').toContain('name="taxRateId"');

    // A product id for the new variant, read over the API (the
    // endpoint returns a bare array of variants).
    const variants = await apiGet('/v1/catalogue/variants');
    expect(variants.status, 'GET /v1/catalogue/variants').toBe(200);
    expect(Array.isArray(variants.json)).toBe(true);
    const rows = variants.json as Array<Record<string, unknown>>;
    const widget = rows.find((r) => r.sku === 'DEMO-WIDGET-1');
    expect(widget, 'seeded widget variant exists').toBeDefined();
    const productId = (widget as Record<string, unknown>).product_id as string;
    expect(productId).toMatch(/^[0-9a-f-]{36}$/);

    // The Build-07 failure was a 400 here ("tax_rate_id is required");
    // with a real rate id from GET /v1/tax-rates the form completes.
    const created = await postForm(ADMIN_BASE, '/catalogue/variants/create', {
      productId,
      sku: 'DEMO-BOOT-1',
      name: 'Boot Test Variant',
      barcode: '',
      pricePence: '999',
      costPence: '0',
      taxRateId: DEMO_TAX_STANDARD_ID,
    });
    expect(created.status, 'variant create posts and redirects').toBe(303);
    const after = await http(`${ADMIN_BASE}/catalogue`);
    expect(after.text, 'new variant appears in the catalogue view').toContain('DEMO-BOOT-1');
  }, 120_000);

  it('live sale completes through the register UI and stock drops', async () => {
    expect(await stockOnHand(DEMO_VARIANT_WIDGET_ID), 'widget stock before the sale').toBe('25');
    const cleared = await registerAction({ action: 'clear' });
    expect(cleared.status, 'clear basket').toBe(303);
    const add = await registerAction({ action: 'quick-key', sku: 'DEMO-WIDGET-1' });
    expect(add.status, 'quick-key the seeded widget').toBe(303);
    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online').toBe(303);
    const page = await registerPage();
    expect(page, 'sale completes').toContain('Sale completed');
    expect(await stockOnHand(DEMO_VARIANT_WIDGET_ID), 'widget stock after the sale').toBe('24');
  }, 120_000);

  it('seeded open session is live: opening a second session is refused', async () => {
    const opened = await apiPost('/v1/reporting/sessions', {
      registerId: DEMO_REGISTER_ID,
      openingFloatPence: '5000',
    });
    expect(opened.status, 'second open session is refused').toBe(400);
    expect(opened.text, 'refusal names the open session').toContain('already has an open session');
  }, 60_000);
});
