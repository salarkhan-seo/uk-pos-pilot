/**
 * Build-12 Objective 2 — product-creation nested age restriction &
 * age-restriction removal, live over HTTP.
 *
 * Boots the COMPILED API as a real child process and drives it over
 * REAL HTTP round-trips:
 *
 *   1. POST /v1/catalogue/products with a nested ageRestriction
 *      { minAge: 21 } → 201; GET /v1/catalogue/age-restrictions
 *      ?productId= shows the product-level row (variant_id null,
 *      rule_source 'explicit', min_age 21).
 *   2. A variant created afterwards inherits the rule
 *      (rule_source 'inherited', min_age 21).
 *   3. An explicit variant-target rule (minAge 18) overrides it;
 *      a second variant inherits 21.
 *   4. DELETE the product-level rule → 200; the product row and the
 *      inherited variant row are gone, the explicit 18 override
 *      survives (verified via the list route).
 *   5. DELETE the surviving variant row → 200; the list is empty.
 *   6. Error matrix over HTTP: unauthenticated DELETE → 401;
 *      malformed id → 400 INVALID_UUID; another tenant's key →
 *      404; bad nested ageRestriction (minAge 0) on product creation
 *      → 400 with no product created.
 *
 * Why a child process (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Bootstrap (Build-11 Objective 3 — the Build-10 401 flake): three
 * gates — (1) the port must be free BEFORE spawn, (2) the child
 * must still be alive after the status probe, (3) an AUTHENTICATED
 * probe (GET /v1/tax-rates with the seeded admin key) must answer
 * 200, proving the process on the port is OUR server with OUR
 * database. A 401 there is definitive, not transient.
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731,
 * 3827/3830, 3927, 4027, 4127/4130/4131, 4227, 4327/4330, 4427/4430):
 * API 4527 only — this proof needs the API alone; no register/admin
 * UI is booted.
 *
 * Only the tenants + API keys are seeded through PGlite
 * (infrastructure scaffolding, same as every E2E suite): no product,
 * variant or rule is seeded — every business row is created over HTTP.
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

const API_PORT = 4527;
const API_BASE = `http://localhost:${API_PORT}`;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');

// ---------------------------------------------------------------------
// Small helpers (same patterns as build11-balances-valuation-live.test.ts)
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

// ---------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build12-age-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const WEBHOOK_KEY = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  adminKey: string;
}

let tenant: TenantSet;
let tenantB: TenantSet;
let productId = '';
let productRuleId = '';
let variantAId = '';
let variantBId = '';

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

async function apiDelete(t: TenantSet, path: string, key?: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { method: 'DELETE', headers: apiHeaders(t, key ?? t.adminKey) });
}

type RuleRow = Record<string, unknown>;

async function listRules(t: TenantSet, product: string): Promise<RuleRow[]> {
  const res = await apiGet(t, `/v1/catalogue/age-restrictions?productId=${product}`);
  expect(res.status, 'GET /v1/catalogue/age-restrictions?productId=').toBe(200);
  const rows = res.json as RuleRow[] | undefined;
  expect(Array.isArray(rows)).toBe(true);
  return rows as RuleRow[];
}

async function startApi(): Promise<void> {
  // Hardening (Build-11 Objective 3): three gates — port free before
  // spawn, child alive after the status probe, authenticated
  // GET /v1/tax-rates probe with the seeded admin key.
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
// Suite
// ---------------------------------------------------------------------

describe('Build-12 Objective 2 — nested age restriction + removal, live over HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);

    // Seed ONLY the tenants + API keys (infrastructure scaffolding —
    // no business data: no product, variant or rule is seeded).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        for (const [name, slot] of [
          ['Age Live Ltd', 'a'],
          ['Age Live B Ltd', 'b'],
        ] as const) {
          const seeded = await seedTenant(db, { name });
          const admin = await createTestApiKey(db, seeded, {
            name: 'admin key',
            scopes: ['admin'],
          });
          const set: TenantSet = { tenant: seeded, adminKey: admin.key };
          if (slot === 'a') tenant = set;
          else tenantB = set;
        }
      } finally {
        await close();
      }
    }

    await startApi();
  }, 120_000);

  afterAll(async () => {
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    rmSync(TMP_DIR, { recursive: true, force: true });
  }, 60_000);

  it('nested creation stores the product-level rule; a later variant inherits it', async () => {
    const created = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Live Vape Liquid',
      ageRestriction: { minAge: 21 },
    });
    expect(created.status, 'POST /v1/catalogue/products with nested ageRestriction').toBe(201);
    productId = (expectJsonObject(created).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');

    const rules = await listRules(tenant, productId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      id: rules[0]?.id,
      variant_id: null,
      product_id: productId,
      requires_challenge_25: true,
      min_age: 21,
      rule_source: 'explicit',
    });
    productRuleId = rules[0]?.id as string;

    const variantA = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'LIVE-VAPE-A',
      name: 'Live Vape A',
      pricePence: '800',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variantA.status, 'create variant A').toBe(201);
    variantAId = (expectJsonObject(variantA).id as string | undefined) ?? '';
    expect(variantAId, 'variant A has an id').not.toBe('');

    const after = await listRules(tenant, productId);
    expect(after).toHaveLength(2);
    const inherited = after.find((r) => r.variant_id === variantAId);
    expect(inherited).toEqual({
      id: inherited?.id,
      variant_id: variantAId,
      product_id: productId,
      requires_challenge_25: true,
      min_age: 21,
      rule_source: 'inherited',
    });
  }, 120_000);

  it('an explicit variant override survives the product-rule delete; inherited rows do not', async () => {
    // Explicit 18 override on variant A.
    const override = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      variantId: variantAId,
      minAge: 18,
    });
    expect(override.status, 'POST explicit variant rule').toBe(201);
    // Second variant inherits 21 from the product rule.
    const variantB = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'LIVE-VAPE-B',
      name: 'Live Vape B',
      pricePence: '800',
      taxRateId: tenant.tenant.taxRates.standard,
    });
    expect(variantB.status, 'create variant B').toBe(201);
    variantBId = (expectJsonObject(variantB).id as string | undefined) ?? '';
    const before = await listRules(tenant, productId);
    expect(before).toHaveLength(3);

    const deleted = await apiDelete(tenant, `/v1/catalogue/age-restrictions/${productRuleId}`);
    expect(deleted.status, 'DELETE the product-level rule').toBe(200);
    const summary = expectJsonObject(deleted);
    expect(summary.deleted_rule).toEqual({
      id: productRuleId,
      variant_id: null,
      product_id: productId,
      requires_challenge_25: true,
      min_age: 21,
      rule_source: 'explicit',
    });
    expect((summary.deleted_inherited_rule_ids as string[]).length).toBe(1);

    // Only the explicit 18 override on variant A survives.
    const after = await listRules(tenant, productId);
    expect(after).toHaveLength(1);
    expect(after[0]?.variant_id).toBe(variantAId);
    expect(after[0]?.min_age).toBe(18);
    expect(after[0]?.rule_source).toBe('explicit');
  }, 120_000);

  it('deleting a variant-level rule removes only that row', async () => {
    const rules = await listRules(tenant, productId);
    expect(rules).toHaveLength(1);
    const variantRuleId = rules[0]?.id as string;
    const deleted = await apiDelete(tenant, `/v1/catalogue/age-restrictions/${variantRuleId}`);
    expect(deleted.status, 'DELETE the variant-level rule').toBe(200);
    expect(expectJsonObject(deleted).deleted_inherited_rule_ids).toEqual([]);
    expect(await listRules(tenant, productId)).toHaveLength(0);
  }, 120_000);

  it('error matrix: unauthenticated 401, malformed id 400, cross-tenant 404, bad nested 400', async () => {
    // Unauthenticated DELETE → 401 (no credential at all).
    const noAuth = await http(`${API_BASE}/v1/catalogue/age-restrictions/${productRuleId}`, {
      method: 'DELETE',
    });
    expect(noAuth.status, 'DELETE without a credential').toBe(401);

    // Malformed id → 400 INVALID_UUID (global interceptor, before the handler).
    const malformed = await apiDelete(tenant, '/v1/catalogue/age-restrictions/not-a-uuid');
    expect(malformed.status, 'DELETE with a malformed id').toBe(400);
    expect(expectJsonObject(malformed).error).toMatchObject({ code: 'INVALID_UUID' });

    // Another tenant's key → 404 (G-B, never 403). The rule id below
    // belongs to tenant A; tenant B must not see it. Re-create a rule
    // first so there is something to 404 on. (POST with a product
    // target returns one row per current variant — the product-level
    // row itself is read back through the list route.)
    const recreated = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      productId,
      minAge: 21,
    });
    expect(recreated.status, 're-create the product rule for the 404 check').toBe(201);
    const recreatedList = await listRules(tenant, productId);
    const recreatedProductRow = recreatedList.find((r) => r.variant_id === null);
    expect(recreatedProductRow, 're-created product-level row').toBeDefined();
    const crossTenant = await apiDelete(
      tenantB,
      `/v1/catalogue/age-restrictions/${recreatedProductRow?.id as string}`,
    );
    expect(crossTenant.status, "another tenant's key DELETEs tenant A's rule").toBe(404);
    // And tenant A's own delete still works afterwards (the 404 left it alone).
    const ownDelete = await apiDelete(
      tenant,
      `/v1/catalogue/age-restrictions/${recreatedProductRow?.id as string}`,
    );
    expect(ownDelete.status, "tenant A deletes its own rule after the cross-tenant 404").toBe(
      200,
    );

    // Bad nested ageRestriction on product creation → 400, no product row.
    const bad = await apiPost(tenant, '/v1/catalogue/products', {
      name: 'Bad Vape',
      ageRestriction: { minAge: 0 },
    });
    expect(bad.status, 'POST product with minAge 0').toBe(400);
    const products = await apiGet(tenant, '/v1/catalogue/products');
    expect(products.status, 'GET products after the bad create').toBe(200);
    const names = (products.json as Array<Record<string, unknown>>).map((p) => p.name);
    expect(names).not.toContain('Bad Vape');
  }, 120_000);
});
