/**
 * Build-08 Objective 1 — tax-rates list endpoint + live variant creation.
 *
 * Boots the COMPILED API + one admin UI shell as real child processes
 * and drives them over REAL HTTP round-trips (same pattern as the
 * Build-07 Obj 3 file: esbuild emits no decorator metadata, so Nest
 * cannot boot inside vitest).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from the Build-06 E2E 3227/3230/3231/3239 and Build-07 UI
 * 3327/3330–3333 ports so parallel workers cannot collide):
 *   API 3427, admin UI 3431.
 *
 * Proofs:
 *   1. GET /v1/tax-rates with an admin-scope key → 200, the tenant's
 *      4 seeded rates with the exact view (id, name, rate_bps,
 *      is_exempt, is_default_no_tax).
 *   2. GET /v1/tax-rates without a credential → 401.
 *   3. GET /v1/tax-rates/:id with a malformed id → 400 INVALID_UUID.
 *   4. GET /v1/tax-rates/:id cross-tenant / unknown → 404.
 *   5. The admin catalogue page renders the tax-rate picker populated
 *      from GET /v1/tax-rates (needs the `catalogue.listTaxRates`
 *      route-table entry — Obj 4's job; see the note on the test).
 *   6. Live variant creation through the shell form completes with
 *      201 Created server-side (303 back to /catalogue) and the
 *      variant is stored with the chosen tax_rate_id; submitting
 *      without a tax rate still 400s with the error banner.
 *
 * HTML harness: targeted string/regex assertions on real responses
 * (Node ships no built-in DOM parser). Zero new dependencies;
 * localhost only, no external network.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

const API_PORT = 3427;
const ADMIN_PORT = 3431;
const API_BASE = `http://localhost:${API_PORT}`;
const ADMIN_BASE = `http://localhost:${ADMIN_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const ADMIN_ENTRY = join(ROOT, 'apps/admin-web/dist/ui/server.js');

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build08-taxrates-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const WEBHOOK_KEY = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  key: string;
}

let tenantA: TenantSet;
let tenantB: TenantSet;
let productAId: string;

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

/** Text of the admin shell's error banner (`<div class="error">`), or null. */
function adminError(html: string): string | null {
  const match = /<div class="error">([\s\S]*?)<\/div>/.exec(html);
  if (match === null || match[1] === undefined) return null;
  return decodeEntities(match[1].replace(/<[^>]*>/g, ''));
}

/** Options of the tax-rate picker: [value, label] pairs. */
function taxRateOptions(html: string): Array<[string, string]> {
  const select = /<select name="taxRateId">([\s\S]*?)<\/select>/.exec(html);
  if (select === null || select[1] === undefined) return [];
  return [...select[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(
    (m) => [m[1] as string, decodeEntities(m[2] as string)] as [string, string],
  );
}

async function seedAll(): Promise<void> {
  const { db, close } = await createPGliteDb(PG_DATA_DIR);
  try {
    await applyMigrations(db, findMigrationsDir(ROOT));
    const mk = async (name: string): Promise<TenantSet> => {
      const tenant = await seedTenant(db, { name });
      const created = await createTestApiKey(db, tenant, { name: `${name} tax key`, scopes: ['admin'] });
      return { tenant, key: created.key };
    };
    tenantA = await mk('Tax Rates Ltd');
    tenantB = await mk('Other Tenant Ltd');
    const product = await db
      .insertInto('products')
      .values({ tenant_id: tenantA.tenant.tenantId, name: 'Tax Product', is_active: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    productAId = product.id;
  } finally {
    await close();
  }
}

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

async function apiGet(t: TenantSet, path: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders(t) });
}

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

let apiChild: ChildProcess | null = null;
let adminChild: ChildProcess | null = null;
const childLogs: Record<string, string> = {};

function spawnLogged(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let data = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf8');
  });
  child.on('exit', () => {
    childLogs[name] = data;
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

describe('Build-08 Objective 1 — tax rates + live variant creation over real HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(ADMIN_ENTRY)).toBe(true);
    await seedAll();

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
        `API child exited during startup (exit code ${apiChild?.exitCode ?? 'unknown'}); refusing to run against whatever answers on port ${API_PORT}`,
      );
    }
    const apiReady = await apiGet(tenantA, '/v1/tax-rates');
    if (apiReady.status !== 200) {
      throw new Error(
        `API on port ${API_PORT} answered /v1/tax-rates with ${apiReady.status} for the seeded admin key — the process answering is not our seeded server (another process may hold the port, or the server opened a different database); refusing to proceed`,
      );
    }

    // Gate 1 for the admin UI too (port free before spawn — a
    // leftover fails fast here naming the port, instead of the
    // /health wait timing out with no cause).
    await waitForPortFree(ADMIN_PORT);
    adminChild = spawnLogged('admin', 'node', [ADMIN_ENTRY], {
      ...process.env,
      ADMIN_WEB_PORT: String(ADMIN_PORT),
      ADMIN_API_BASE_URL: API_BASE,
      ADMIN_API_TOKEN: tenantA.key,
      ADMIN_TENANT_ID: tenantA.tenant.tenantId,
      ADMIN_LOCATION_ID: tenantA.tenant.locationId,
      ADMIN_USER_ID: tenantA.tenant.users.owner.id,
      ADMIN_USER_ROLES: 'owner',
    });
    await waitFor('admin UI to answer /health', async () => {
      const res = await http(`${ADMIN_BASE}/health`);
      return res.status === 200;
    });
  }, 180_000);

  afterAll(async () => {
    await stopChild(adminChild, ADMIN_PORT);
    await stopChild(apiChild, API_PORT);
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-08 tax-rates temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('GET /v1/tax-rates lists the tenant 4 seeded rates with the exact view', async () => {
    const res = await apiGet(tenantA, '/v1/tax-rates');
    expect(res.status, 'GET /v1/tax-rates').toBe(200);
    const rates = res.json as Array<Record<string, unknown>>;
    expect(Array.isArray(rates)).toBe(true);
    expect(rates).toHaveLength(4);
    expect(rates).toEqual([
      { id: tenantA.tenant.taxRates.exempt, name: 'Exempt', rate_bps: 0, is_exempt: true, is_default_no_tax: true },
      { id: tenantA.tenant.taxRates.reduced, name: 'Reduced 5%', rate_bps: 500, is_exempt: false, is_default_no_tax: false },
      { id: tenantA.tenant.taxRates.standard, name: 'Standard 20%', rate_bps: 2000, is_exempt: false, is_default_no_tax: false },
      { id: tenantA.tenant.taxRates.zero, name: 'Zero-rated 0%', rate_bps: 0, is_exempt: false, is_default_no_tax: true },
    ]);
    const single = await apiGet(tenantA, `/v1/tax-rates/${tenantA.tenant.taxRates.standard}`);
    expect(single.status, 'GET /v1/tax-rates/:id').toBe(200);
    expect(single.json).toEqual({
      id: tenantA.tenant.taxRates.standard,
      name: 'Standard 20%',
      rate_bps: 2000,
      is_exempt: false,
      is_default_no_tax: false,
    });
  }, 120_000);

  it('GET /v1/tax-rates without a credential → 401', async () => {
    const res = await http(`${API_BASE}/v1/tax-rates`);
    expect(res.status, 'unauthenticated tax-rates list').toBe(401);
    const single = await http(`${API_BASE}/v1/tax-rates/${tenantA.tenant.taxRates.standard}`);
    expect(single.status, 'unauthenticated tax-rate read').toBe(401);
  }, 120_000);

  it('GET /v1/tax-rates/:id with a malformed id → 400 INVALID_UUID', async () => {
    const res = await apiGet(tenantA, '/v1/tax-rates/not-a-uuid');
    expect(res.status, 'malformed tax-rate id').toBe(400);
    const body = expectJsonObject(res);
    expect((body.error as Record<string, unknown> | undefined)?.code).toBe('INVALID_UUID');
  }, 120_000);

  it('GET /v1/tax-rates/:id cross-tenant / unknown → 404', async () => {
    const cross = await apiGet(tenantB, `/v1/tax-rates/${tenantA.tenant.taxRates.standard}`);
    expect(cross.status, 'tenant B reading tenant A rate').toBe(404);
    const unknown = await apiGet(
      tenantA,
      '/v1/tax-rates/00000000-0000-0000-0000-000000000000',
    );
    expect(unknown.status, 'unknown tax-rate id').toBe(404);
    const listedB = await apiGet(tenantB, '/v1/tax-rates');
    expect(listedB.status, 'tenant B list').toBe(200);
    const ids = (listedB.json as Array<Record<string, unknown>>).map((r) => r.id);
    expect(ids).not.toContain(tenantA.tenant.taxRates.standard);
  }, 120_000);

  it('catalogue page renders the tax-rate picker populated from GET /v1/tax-rates', async () => {
    // NOTE: this proof needs the `catalogue.listTaxRates` route-table
    // entry (Obj 4's job): the shell loads the picker through the typed
    // client, which dispatches via the route table. Until the entry
    // lands, the shell degrades to a "Tax rates" section error and the
    // select carries only the placeholder — the test fails, naming the
    // missing entry rather than the endpoint.
    const page = await http(`${ADMIN_BASE}/catalogue`);
    expect(page.status, 'GET /catalogue').toBe(200);
    expect(page.text, 'tax-rate picker present').toContain('name="taxRateId"');
    const options = taxRateOptions(page.text);
    expect(options, 'picker options (placeholder + 4 rates)').toEqual([
      ['', '— choose a tax rate —'],
      [tenantA.tenant.taxRates.exempt, 'Exempt (0%)'],
      [tenantA.tenant.taxRates.reduced, 'Reduced 5% (5%)'],
      [tenantA.tenant.taxRates.standard, 'Standard 20% (20%)'],
      [tenantA.tenant.taxRates.zero, 'Zero-rated 0% (0%)'],
    ]);
  }, 120_000);

  it('live variant creation through the shell form completes with 201 (303) and stores the tax rate', async () => {
    const created = await postForm(ADMIN_BASE, '/catalogue/variants/create', {
      productId: productAId,
      sku: 'TAX-001',
      barcode: '',
      name: 'Tax Widget',
      pricePence: '1500',
      costPence: '800',
      taxRateId: tenantA.tenant.taxRates.standard,
    });
    expect(created.status, 'variant create with a tax rate redirects').toBe(303);
    const page = await http(`${ADMIN_BASE}/catalogue`);
    expect(page.status, 'GET /catalogue after create').toBe(200);
    expect(page.text, 'new variant renders on the catalogue view').toContain('TAX-001');
    const listed = await apiGet(tenantA, '/v1/catalogue/variants');
    expect(listed.status, 'GET /v1/catalogue/variants').toBe(200);
    const variants = listed.json as Array<Record<string, unknown>>;
    const row = variants.find((v) => v.sku === 'TAX-001');
    expect(row, 'variant stored').toBeDefined();
    expect(row?.tax_rate_id).toBe(tenantA.tenant.taxRates.standard);
    expect(row?.price_pence).toBe('1500');
  }, 120_000);

  it('variant creation without a tax rate still 400s with the error banner', async () => {
    const res = await postForm(ADMIN_BASE, '/catalogue/variants/create', {
      productId: productAId,
      sku: 'TAX-002',
      barcode: '',
      name: 'No Tax Widget',
      pricePence: '1500',
      costPence: '800',
    });
    expect(res.status, 'variant create without a tax rate answers 400').toBe(400);
    expect(adminError(res.text), 'tax-rate error banner').toContain(
      'tax_rate_id is required for a variant',
    );
  }, 120_000);
});
