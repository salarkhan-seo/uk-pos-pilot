/**
 * Build-10 Objective 3 — live HTTP proof over the compiled API.
 *
 * Boots the COMPILED API as a real child process (API 4027) and
 * drives it over REAL HTTP round-trips:
 *
 *   1. Inheritance: create product → create variant V-001 → attach
 *      the product-level Challenge 25 rule (POST age-restrictions
 *      with productId) → create variant V-002 with NO nested rule →
 *      V-002 carries requires_challenge_25 = true, min_age = 18,
 *      proven both via GET /v1/catalogue/age-restrictions and via
 *      the sync handshake delta.
 *   2. Sync error codes: flush an offline cash order for the
 *      restricted V-002 with no verifications → the outcome is
 *      status 'failed' with error_code 'AGE_VERIFICATION_REQUIRED'
 *      (and the message carries the human-readable text, not the
 *      exception class name).
 *   3. Platform-operator guard: POST /v1/webhooks/re-encrypt-secrets
 *      with an admin key — unauthenticated → 401; no operator header
 *      → 403 PLATFORM_OPERATOR_REQUIRED; wrong header → 403; the
 *      test fallback key → 403 (an env key IS configured, so the
 *      fallback does not apply); the configured operator key → 200.
 *      The operator_id is recorded in audit_events for every call
 *      the guard sees (afterAll re-opens the stopped database and
 *      asserts exactly 3 rejection rows + 1 success row, the
 *      success row carrying operator_id 'default' — the single env
 *      key, no Id header sent, so the id is derived from the key;
 *      the unauthenticated 401 leaves no row: no actor, no tenant
 *      to chain under).
 *
 * Why a child process (not in-vitest): esbuild emits no decorator
 * metadata, so Nest cannot boot inside vitest (proven Build-06).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults, and distinct
 * from every earlier E2E file — 3227/3230/3231/3239, 3327/3330–3333,
 * 3427/3430/3431, 3527/3530/3531, 3627/3631, 3727/3730/3731,
 * 3827/3830, 3927):
 *   API 4027.
 *
 * The only PGlite writes are the tenant + API key (infrastructure
 * scaffolding, same as every E2E suite). The API boots with
 * NODE_ENV=production, a two-key webhook keyring (k1 retiring, k2
 * active) and PLATFORM_OPERATOR_KEY set — so the live proof exercises
 * the env-var path, not the test fallback.
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
import { PLATFORM_OPERATOR_TEST_KEY } from '../../src/modules/integrations/webhooks.controller';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_PORT = 4027;
const API_BASE = `http://localhost:${API_PORT}`;

const ROOT = join(__dirname, '..', '..', '..', '..');
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');

const OPERATOR_KEY = 'build10-e2e-platform-operator-key';
const WEBHOOK_KEY_K1 = randomBytes(32).toString('hex');
const WEBHOOK_KEY_K2 = randomBytes(32).toString('hex');

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

// ---------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build10-obj3-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');

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
let standardTaxRateId: string;

function apiHeaders(t: TenantSet, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${t.key}`,
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    'x-user-id': t.tenant.users.owner.id,
    'x-roles': 'owner',
    'Content-Type': 'application/json',
    ...overrides,
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

function apiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: 'production',
    PGLITE_DATA_DIR: PG_DATA_DIR,
    WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({ k1: WEBHOOK_KEY_K1, k2: WEBHOOK_KEY_K2 }),
    WEBHOOK_ACTIVE_KEY_ID: 'k2',
    PLATFORM_OPERATOR_KEY: OPERATOR_KEY,
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
// Suite
// ---------------------------------------------------------------------

describe('Build-10 Objective 3 — inheritance + sync error codes + operator guard, live HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);

    // Seed tenant + API key (infrastructure scaffolding only).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        const seeded = await seedTenant(db, { name: 'Build-10 Obj 3 Ltd' });
        const created = await createTestApiKey(db, seeded, {
          name: 'obj3 e2e key',
          scopes: ['admin'],
        });
        tenant = { tenant: seeded, key: created.key };
      } finally {
        await close();
      }
    }

    await startApi();

    // Standard 20% tax rate id (needed to create variants). The list
    // endpoint returns a bare array of TaxRateView rows.
    const rates = await apiGet(tenant, '/v1/tax-rates');
    expect(rates.status, 'GET /v1/tax-rates').toBe(200);
    expect(Array.isArray(rates.json)).toBe(true);
    const rateRows = rates.json as Array<Record<string, unknown>>;
    const standard = rateRows.find((r) => r.rate_bps === 2000);
    expect(standard, 'standard 20% tax rate exists').toBeDefined();
    standardTaxRateId = String((standard as Record<string, unknown>).id);
  }, 120_000);

  afterAll(async () => {
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    // Operator audit proof (Build-11 Objective 3): re-open the
    // stopped database and read audit_events directly — the API
    // holds the PGlite lock while it runs. Skipped when beforeAll
    // never got as far as seeding a tenant.
    if (tenant !== undefined) {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        const rows = await db
          .selectFrom('audit_events')
          .select(['event_type', 'payload'])
          .where('tenant_id', '=', tenant.tenant.tenantId)
          .where('event_type', 'in', [
            'platform_operator.re_encrypt_succeeded',
            'platform_operator.re_encrypt_rejected',
          ])
          .execute();
        const succeeded = rows.filter(
          (r) => r.event_type === 'platform_operator.re_encrypt_succeeded',
        );
        const rejected = rows.filter(
          (r) => r.event_type === 'platform_operator.re_encrypt_rejected',
        );
        expect(succeeded).toHaveLength(1);
        expect(
          (succeeded[0]?.payload as Record<string, unknown> | undefined)?.operator_id,
        ).toBe('default');
        expect(
          (succeeded[0]?.payload as Record<string, unknown> | undefined)?.from_key_id,
        ).toBe('k1');
        // 3 rejections: no header, wrong header, test fallback key.
        // The unauthenticated 401 leaves no row (no actor, no tenant).
        expect(rejected).toHaveLength(3);
        for (const row of rejected) {
          expect(
            (row.payload as Record<string, unknown> | undefined)?.verified_operator_id,
          ).toBeNull();
        }
        const reasons = rejected.map(
          (r) => (r.payload as Record<string, unknown> | undefined)?.reason,
        );
        expect(reasons.filter((r) => r === 'missing_header')).toHaveLength(1);
        expect(reasons.filter((r) => r === 'key_mismatch')).toHaveLength(2);
      } finally {
        await close();
      }
    }
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('inherits the product-level Challenge 25 rule onto a later variant over HTTP', async () => {
    const product = await apiPost(tenant, '/v1/catalogue/products', { name: 'E2E Vape Liquid' });
    expect(product.status, 'create product').toBe(201);
    productId = expectJsonObject(product).id as string;

    const variantA = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'E2E-V-001',
      barcode: '5012345678903',
      name: 'E2E Vape 001',
      pricePence: '800',
      costPence: '400',
      taxRateId: standardTaxRateId,
    });
    expect(variantA.status, 'create variant A').toBe(201);
    variantAId = expectJsonObject(variantA).id as string;

    const rule = await apiPost(tenant, '/v1/catalogue/age-restrictions', {
      productId,
      minAge: 18,
    });
    expect(rule.status, 'attach product-level rule').toBe(201);
    const ruleRows = rule.json as Array<Record<string, unknown>>;
    expect(Array.isArray(ruleRows)).toBe(true);
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]?.requires_challenge_25).toBe(true);
    expect(ruleRows[0]?.min_age).toBe(18);

    // Variant B: NO nested ageRestriction — inheritance must apply it.
    const variantB = await apiPost(tenant, '/v1/catalogue/variants', {
      productId,
      sku: 'E2E-V-002',
      barcode: '5012345678904',
      name: 'E2E Vape 002',
      pricePence: '800',
      costPence: '400',
      taxRateId: standardTaxRateId,
    });
    expect(variantB.status, 'create variant B').toBe(201);
    variantBId = expectJsonObject(variantB).id as string;

    // Proven via the age-restrictions list — Build-11 Objective 2:
    // the list now carries the stored product-level row (variant_id
    // NULL) as well as the two inherited variant rows, so 3 rows.
    const list = await apiGet(
      tenant,
      `/v1/catalogue/age-restrictions?productId=${encodeURIComponent(productId)}`,
    );
    expect(list.status, 'list age restrictions').toBe(200);
    const rows = list.json as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
    const productRow = rows.find((r) => r.variant_id === null);
    expect(productRow, 'product-level row present').toBeDefined();
    expect(productRow?.rule_source).toBe('explicit');
    expect(productRow?.min_age).toBe(18);
    const rowB = rows.find((r) => r.variant_id === variantBId);
    expect(rowB, 'variant B carries the inherited rule').toBeDefined();
    expect(rowB?.requires_challenge_25).toBe(true);
    expect(rowB?.min_age).toBe(18);
    expect(rowB?.rule_source).toBe('inherited');

    // … and via the sync handshake delta (POST → 201, Nest default).
    const handshake = await apiPost(tenant, '/v1/sync/handshake', {
      registerId: tenant.tenant.registerId,
    });
    expect(handshake.status, 'sync handshake').toBe(201);
    const catalogue = expectJsonObject(handshake).catalogue as Record<string, unknown>;
    const variants = catalogue.variants as Array<Record<string, unknown>>;
    const deltaB = variants.find((v) => v.variantId === variantBId);
    expect(deltaB, 'variant B in the handshake delta').toBeDefined();
    expect(deltaB?.requiresChallenge25).toBe(true);
    expect(deltaB?.minAge).toBe(18);
  });

  it('a failed flush item carries error_code AGE_VERIFICATION_REQUIRED', async () => {
    expect(variantBId, 'variant B created by the previous test').toBeDefined();
    const flush = await apiPost(tenant, '/v1/sync/flush', {
      registerId: tenant.tenant.registerId,
      orders: [
        {
          idempotencyKey: 'e2e-obj3-age-001',
          locationId: tenant.tenant.locationId,
          registerId: tenant.tenant.registerId,
          customerId: null,
          tenderTotalPence: '800',
          createdAt: new Date().toISOString(),
          lines: [
            {
              variantId: variantBId,
              quantity: '1',
              snapshotUnitPricePence: '800',
              snapshotLineTotalPence: '800',
            },
          ],
        },
      ],
    });
    expect(flush.status, 'POST /v1/sync/flush').toBe(201);
    const outcomes = expectJsonObject(flush).outcomes as Array<Record<string, unknown>>;
    expect(Array.isArray(outcomes)).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.error_code).toBe('AGE_VERIFICATION_REQUIRED');
    expect(outcomes[0]?.error).toContain('Age verification required');
    expect(outcomes[0]?.error).not.toContain('AgeVerificationRequiredException');
    expect(outcomes[0]?.error).not.toContain('AgeVerificationRequired');
  });

  it('re-encrypt guard over HTTP: 401 unauthenticated, 403 without/wrong header, 200 with the operator key', async () => {
    // Unauthenticated → 401 (AuthGuard, unchanged by the guard).
    const unauth = await http(`${API_BASE}/v1/webhooks/re-encrypt-secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKeyId: 'k1' }),
    });
    expect(unauth.status, 're-encrypt unauthenticated').toBe(401);

    // Admin scope, no operator header → 403 PLATFORM_OPERATOR_REQUIRED.
    const noHeader = await apiPost(tenant, '/v1/webhooks/re-encrypt-secrets', {
      fromKeyId: 'k1',
    });
    expect(noHeader.status, 're-encrypt without operator header').toBe(403);
    expect(expectJsonObject(noHeader).error).toEqual({
      code: 'PLATFORM_OPERATOR_REQUIRED',
      message: expect.stringContaining('X-Platform-Operator-Key'),
    });

    // Admin scope, wrong operator header → 403.
    const wrong = await http(`${API_BASE}/v1/webhooks/re-encrypt-secrets`, {
      method: 'POST',
      headers: apiHeaders(tenant, { 'x-platform-operator-key': 'wrong-operator-key' }),
      body: JSON.stringify({ fromKeyId: 'k1' }),
    });
    expect(wrong.status, 're-encrypt with wrong operator header').toBe(403);

    // The test fallback key does NOT apply: an env key IS configured.
    const fallback = await http(`${API_BASE}/v1/webhooks/re-encrypt-secrets`, {
      method: 'POST',
      headers: apiHeaders(tenant, {
        'x-platform-operator-key': PLATFORM_OPERATOR_TEST_KEY,
      }),
      body: JSON.stringify({ fromKeyId: 'k1' }),
    });
    expect(fallback.status, 're-encrypt with the test fallback key while an env key is set').toBe(403);

    // Correct operator key → 200 (k1 retiring, k2 active, no endpoints yet).
    const ok = await http(`${API_BASE}/v1/webhooks/re-encrypt-secrets`, {
      method: 'POST',
      headers: apiHeaders(tenant, { 'x-platform-operator-key': OPERATOR_KEY }),
      body: JSON.stringify({ fromKeyId: 'k1' }),
    });
    expect(ok.status, 're-encrypt with the operator key').toBe(200);
    expect(expectJsonObject(ok)).toEqual({
      from_key_id: 'k1',
      to_key_id: 'k2',
      endpoints_examined: 0,
      endpoints_re_encrypted: 0,
      ciphertexts_re_encrypted: 0,
      endpoints_already_current: 0,
      unreadable_ciphertexts: [],
    });
  });
});
