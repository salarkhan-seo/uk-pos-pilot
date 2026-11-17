/**
 * Build-09 Objective 1 — products + age-restriction endpoints, live over real HTTP.
 *
 * Boots the COMPILED API + one admin UI shell as real child processes
 * and drives them over REAL HTTP round-trips (same pattern as the
 * Build-08 tax-rates file: esbuild emits no decorator metadata, so
 * Nest cannot boot inside vitest).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from the Build-06 E2E 3227/3230/3231/3239, Build-07 UI 3327/3330–3333,
 * Build-08 tax-rates 3427/3431 and demo-seed-boot 3527/3530/3531 ports
 * so parallel workers cannot collide):
 *   API 3627, admin UI 3631.
 *
 * Real mounted paths (the commission's shorthand "POST /v1/products"
 * is NOT the path — the variant precedent POST v1/catalogue/variants
 * governs):
 *   POST v1/catalogue/products          (catalogue:write)
 *   GET  v1/catalogue/products          (catalogue:read)
 *   GET  v1/catalogue/products/:id      (catalogue:read)
 *   POST v1/catalogue/age-restrictions  (catalogue:write)
 *   GET  v1/catalogue/age-restrictions  (catalogue:read)
 *
 * Proofs:
 *   1. POST /v1/catalogue/products → 201 with the exact view; GET list
 *      and GET by id round-trip it.
 *   2. All five routes without a credential → 401.
 *   3. GET /v1/catalogue/products/:id with a malformed id → 400 INVALID_UUID.
 *   4. Cross-tenant / unknown → 404 (products and age restrictions).
 *   5. POST /v1/catalogue/age-restrictions (variant target) → 201
 *      array; list filters by variantId/productId; product target
 *      applies to every current variant; both/neither target, bad
 *      minAge, and a product with no variants → 400.
 *   6. Nested ageRestriction on variant creation → 201 and the
 *      restriction row is visible via GET age-restrictions; a bad
 *      nested object → 400 and NO variant row is left behind.
 *   7. The catalogue page renders the Products section and the Create
 *      product form.
 *   8. BLOCKED (see NOTE on the test): live product creation through
 *      the shell form needs the `catalogue.createProduct` route-table
 *      entry (Obj 3's job) — the shell dispatches via the route table.
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

const API_PORT = 3627;
const ADMIN_PORT = 3631;
const API_BASE = `http://localhost:${API_PORT}`;
const ADMIN_BASE = `http://localhost:${ADMIN_PORT}`;

const ROOT = join(__dirname, '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const ADMIN_ENTRY = join(ROOT, 'apps/admin-web/dist/ui/server.js');

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build09-products-'));
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
let variantAId: string;

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

async function seedAll(): Promise<void> {
  const { db, close } = await createPGliteDb(PG_DATA_DIR);
  try {
    await applyMigrations(db, findMigrationsDir(ROOT));
    const mk = async (name: string): Promise<TenantSet> => {
      const tenant = await seedTenant(db, { name });
      const created = await createTestApiKey(db, tenant, { name: `${name} products key`, scopes: ['admin'] });
      return { tenant, key: created.key };
    };
    tenantA = await mk('Products Ltd');
    tenantB = await mk('Other Tenant Ltd');
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

async function apiPost(t: TenantSet, path: string, body: unknown): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(t),
    body: JSON.stringify(body),
  });
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

describe('Build-09 Objective 1 — products + age restrictions over real HTTP', () => {
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
    console.log(`Build-09 products temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('POST /v1/catalogue/products → 201 with the exact view; GET list and GET by id round-trip it', async () => {
    const created = await apiPost(tenantA, '/v1/catalogue/products', {
      name: 'Vape Liquid',
      description: '18+ only',
    });
    expect(created.status, 'POST /v1/catalogue/products').toBe(201);
    const product = expectJsonObject(created);
    expect(product.name).toBe('Vape Liquid');
    expect(product.description).toBe('18+ only');
    expect(product.category_id).toBeNull();
    expect(product.is_active).toBe(true);
    expect(typeof product.id).toBe('string');
    productAId = product.id as string;

    const listed = await apiGet(tenantA, '/v1/catalogue/products');
    expect(listed.status, 'GET /v1/catalogue/products').toBe(200);
    const products = listed.json as Array<Record<string, unknown>>;
    expect(products).toHaveLength(1);
    expect(products[0]?.id).toBe(productAId);

    const single = await apiGet(tenantA, `/v1/catalogue/products/${productAId}`);
    expect(single.status, 'GET /v1/catalogue/products/:id').toBe(200);
    expect(single.json).toEqual(product);
  }, 120_000);

  it('all five routes without a credential → 401', async () => {
    for (const path of [
      '/v1/catalogue/products',
      `/v1/catalogue/products/${productAId}`,
      '/v1/catalogue/age-restrictions',
    ]) {
      const res = await http(`${API_BASE}${path}`);
      expect(res.status, `unauthenticated GET ${path}`).toBe(401);
    }
    const postProduct = await http(`${API_BASE}/v1/catalogue/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Auth' }),
    });
    expect(postProduct.status, 'unauthenticated POST products').toBe(401);
    const postAge = await http(`${API_BASE}/v1/catalogue/age-restrictions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(postAge.status, 'unauthenticated POST age-restrictions').toBe(401);
  }, 120_000);

  it('GET /v1/catalogue/products/:id with a malformed id → 400 INVALID_UUID', async () => {
    const res = await apiGet(tenantA, '/v1/catalogue/products/not-a-uuid');
    expect(res.status, 'malformed product id').toBe(400);
    const body = expectJsonObject(res);
    expect((body.error as Record<string, unknown> | undefined)?.code).toBe('INVALID_UUID');
  }, 120_000);

  it('cross-tenant / unknown → 404 (products and age restrictions)', async () => {
    const cross = await apiGet(tenantB, `/v1/catalogue/products/${productAId}`);
    expect(cross.status, 'tenant B reading tenant A product').toBe(404);
    const unknown = await apiGet(
      tenantA,
      '/v1/catalogue/products/00000000-0000-0000-0000-000000000000',
    );
    expect(unknown.status, 'unknown product id').toBe(404);
    const listedB = await apiGet(tenantB, '/v1/catalogue/products');
    expect(listedB.status, 'tenant B list').toBe(200);
    expect(listedB.json).toEqual([]);
    // NOTE: no variant exists yet at this point in the file (the first
    // variant is created in the next test), so create one here for the
    // cross-tenant age-restriction check. It lives under its OWN probe
    // product — a variant under productAId would pollute the later
    // "product target applies to every current variant" count.
    const probeProduct = await apiPost(tenantA, '/v1/catalogue/products', {
      name: 'Probe Product',
    });
    expect(probeProduct.status, 'probe product created').toBe(201);
    const probeProductId = expectJsonObject(probeProduct).id as string;
    const variant = await apiPost(tenantA, '/v1/catalogue/variants', {
      productId: probeProductId,
      sku: 'X-TENANT-001',
      name: 'Cross-tenant probe',
      pricePence: '100',
      taxRateId: tenantA.tenant.taxRates.standard,
    });
    expect(variant.status, 'probe variant created').toBe(201);
    const probeId = expectJsonObject(variant).id as string;
    const crossAge = await apiPost(tenantB, '/v1/catalogue/age-restrictions', {
      variantId: probeId,
    });
    expect(crossAge.status, 'tenant B restricting tenant A variant').toBe(404);
  }, 120_000);

  it('POST /v1/catalogue/age-restrictions (variant target) → 201 array; list filters work', async () => {
    const variant = await apiPost(tenantA, '/v1/catalogue/variants', {
      productId: productAId,
      sku: 'VAPE-001',
      name: 'Vape Liquid 10ml',
      pricePence: '800',
      taxRateId: tenantA.tenant.taxRates.standard,
    });
    expect(variant.status, 'POST /v1/catalogue/variants').toBe(201);
    variantAId = (expectJsonObject(variant).id as string);

    const created = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {
      variantId: variantAId,
      minAge: 18,
    });
    expect(created.status, 'POST /v1/catalogue/age-restrictions').toBe(201);
    const rows = created.json as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: rows[0]?.id,
      variant_id: variantAId,
      product_id: productAId,
      requires_challenge_25: true,
      min_age: 18,
      rule_source: 'explicit',
    });

    const byVariant = await apiGet(tenantA, `/v1/catalogue/age-restrictions?variantId=${variantAId}`);
    expect(byVariant.status, 'GET age-restrictions?variantId=').toBe(200);
    expect((byVariant.json as Array<unknown>)).toHaveLength(1);
    const byProduct = await apiGet(tenantA, `/v1/catalogue/age-restrictions?productId=${productAId}`);
    expect(byProduct.status, 'GET age-restrictions?productId=').toBe(200);
    expect((byProduct.json as Array<unknown>)).toHaveLength(1);
    const all = await apiGet(tenantA, '/v1/catalogue/age-restrictions');
    expect((all.json as Array<unknown>)).toHaveLength(1);
  }, 120_000);

  it('product target applies to every current variant; validation failures → 400', async () => {
    const second = await apiPost(tenantA, '/v1/catalogue/variants', {
      productId: productAId,
      sku: 'VAPE-002',
      name: 'Vape Liquid 20ml',
      pricePence: '1200',
      taxRateId: tenantA.tenant.taxRates.standard,
    });
    expect(second.status, 'second variant').toBe(201);
    const secondId = expectJsonObject(second).id as string;

    const applied = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {
      productId: productAId,
      minAge: 21,
    });
    expect(applied.status, 'POST age-restrictions with productId').toBe(201);
    const rows = applied.json as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.variant_id).sort()).toEqual([variantAId, secondId].sort());
    // Build-11 Objective 2: variantAId already carries an EXPLICIT
    // 18 rule (previous test), so the product-level propagation does
    // NOT overwrite it — only the second variant gains an inherited
    // 21 row.
    const rowA = rows.find((r) => r.variant_id === variantAId);
    expect(rowA?.min_age).toBe(18);
    expect(rowA?.rule_source).toBe('explicit');
    const rowSecond = rows.find((r) => r.variant_id === secondId);
    expect(rowSecond?.min_age).toBe(21);
    expect(rowSecond?.rule_source).toBe('inherited');

    const both = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {
      productId: productAId,
      variantId: variantAId,
    });
    expect(both.status, 'both productId and variantId').toBe(400);
    const neither = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {});
    expect(neither.status, 'neither productId nor variantId').toBe(400);
    const badAge = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {
      variantId: variantAId,
      minAge: 0,
    });
    expect(badAge.status, 'minAge 0').toBe(400);
    const empty = await apiPost(tenantA, '/v1/catalogue/products', { name: 'Empty Product' });
    expect(empty.status, 'empty product created').toBe(201);
    const emptyId = expectJsonObject(empty).id as string;
    // Build-11 Objective 2 supersedes Build-09's 400: a variant-less
    // product CAN carry a product-level rule now (201, returns the
    // product-level row with defaults true / 18).
    const noVariants = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {
      productId: emptyId,
    });
    expect(noVariants.status, 'product with no variants').toBe(201);
    const emptyRows = noVariants.json as Array<Record<string, unknown>>;
    expect(emptyRows).toHaveLength(1);
    expect(emptyRows[0]?.variant_id).toBeNull();
    expect(emptyRows[0]?.product_id).toBe(emptyId);
    expect(emptyRows[0]?.min_age).toBe(18);
    expect(emptyRows[0]?.rule_source).toBe('explicit');
    const unknownVariant = await apiPost(tenantA, '/v1/catalogue/age-restrictions', {
      variantId: '00000000-0000-0000-0000-000000000000',
    });
    expect(unknownVariant.status, 'unknown variant').toBe(404);
  }, 120_000);

  it('nested ageRestriction on variant creation → 201 + row; bad nested → 400 with no variant row', async () => {
    const created = await apiPost(tenantA, '/v1/catalogue/variants', {
      productId: productAId,
      sku: 'VAPE-003',
      name: 'Vape Liquid 30ml',
      pricePence: '1500',
      taxRateId: tenantA.tenant.taxRates.standard,
      ageRestriction: { minAge: 18 },
    });
    expect(created.status, 'variant with nested ageRestriction').toBe(201);
    const nestedId = expectJsonObject(created).id as string;
    const rows = await apiGet(tenantA, `/v1/catalogue/age-restrictions?variantId=${nestedId}`);
    expect((rows.json as Array<unknown>)).toHaveLength(1);

    const bad = await apiPost(tenantA, '/v1/catalogue/variants', {
      productId: productAId,
      sku: 'VAPE-004',
      name: 'Bad Vape',
      pricePence: '1500',
      taxRateId: tenantA.tenant.taxRates.standard,
      ageRestriction: { minAge: 0 },
    });
    expect(bad.status, 'variant with bad nested ageRestriction').toBe(400);
    const listed = await apiGet(tenantA, '/v1/catalogue/variants');
    const variants = listed.json as Array<Record<string, unknown>>;
    expect(variants.find((v) => v.sku === 'VAPE-004'), 'no orphan variant row').toBeUndefined();
    expect(variants.find((v) => v.sku === 'VAPE-003'), 'good variant kept').toBeDefined();
  }, 120_000);

  it('catalogue page renders the Products section and the Create product form', async () => {
    const page = await http(`${ADMIN_BASE}/catalogue`);
    expect(page.status, 'GET /catalogue').toBe(200);
    expect(page.text, 'Products section present').toContain('Products');
    expect(page.text, 'product form present').toContain('/catalogue/products/create');
    expect(page.text, 'product name field present').toContain('name="name"');
  }, 120_000);

  it('live product creation through the shell form completes with 201 (303) and lists the product', async () => {
    // NOTE: this proof needs the `catalogue.createProduct` route-table
    // entry (Obj 3's job): the shell dispatches through the typed
    // client, which resolves routes via the route table. Until the
    // entry lands, the shell answers the form with the "Unknown route
    // key" error banner instead of 303 — the test fails, naming the
    // missing entry rather than the endpoint.
    const created = await postForm(ADMIN_BASE, '/catalogue/products/create', {
      name: 'Shell Widget',
      description: 'Created through the admin shell',
    });
    expect(created.status, 'product create through the shell redirects').toBe(303);
    const page = await http(`${ADMIN_BASE}/catalogue`);
    expect(page.status, 'GET /catalogue after create').toBe(200);
    expect(page.text, 'new product renders on the catalogue view').toContain('Shell Widget');
    const listed = await apiGet(tenantA, '/v1/catalogue/products');
    const products = listed.json as Array<Record<string, unknown>>;
    const row = products.find((p) => p.name === 'Shell Widget');
    expect(row, 'product stored').toBeDefined();
    expect(row?.description).toBe('Created through the admin shell');
  }, 120_000);
});
