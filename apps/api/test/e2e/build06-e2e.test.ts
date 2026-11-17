/**
 * E2E — Build-06 Objective 4: HTTP lifecycle over REAL processes.
 *
 * Boots the COMPILED API (apps/api/dist/main.js) as a child process
 * alongside the compiled register-app UI shell and admin-web UI shell,
 * plus a local HTTPS webhook receiver, and drives the whole lifecycle
 * over real HTTP — no in-process Nest app (impossible in vitest here:
 * esbuild emits no decorator metadata, so NestFactory.create throws
 * UndefinedDependencyException before serving).
 *
 * Ports (test-only; never the 3127/3130/3131 defaults):
 *   API 3227, register UI 3230, admin UI 3231, webhook receiver 3239.
 * One file-backed PGlite directory (PGLITE_DATA_DIR) is shared by a
 * seed step in this process and by every API boot; migrations are
 * idempotent, so re-opening the directory only opens it. Never point
 * two processes at the directory at once — PGlite holds a lock, so
 * the API is always fully stopped before this process re-opens the
 * directory (window dance, final verification).
 *
 * Tenants (all seeded, each with an 'admin'-scope API key):
 *   A  — sales tenant: register UI flow, session/Z-report/VAT/CSV.
 *   B  — exit tenant: seeded with one OPEN session; full D-11 exit lifecycle.
 *   W1 — webhook restart-recovery tenant (re-provisioned after restart).
 *   W2 — webhook no-reprovision tenant (proves the current secret is
 *        genuinely lost on restart: no delivery, pending + last_error).
 *   W3 — webhook grace-expiry tenant (tiny grace, previous header gone).
 *
 * What each section proves:
 *   (2b) malformed UUID -> 400 INVALID_UUID across sales / inventory /
 *        purchasing / crm / api-keys / reporting (+ sessions body);
 *        well-formed unknown -> 404; the compliance :tenantId route
 *        answers 404 (guard fires first — documented G-B behaviour).
 *   (2a) webhook rotation dual-signing across a real process restart:
 *        both X-Webhook-Signature and X-Webhook-Signature-Previous
 *        verify (HMAC-SHA256, 5-min window) before AND after the
 *        restart — after it, the previous secret comes from the
 *        encrypted DB ciphertext (migration 015), not process memory —
 *        and the previous header stops once the grace window expires.
 *   (2c) register UI -> API: online cash sale, offline cash sale into
 *        the ENCRYPTED SQLite file (no plaintext SKU/name in the raw
 *        bytes), reconnect FIFO sync flush (1 synced), session end /
 *        close -> Z-report -> VAT period close (via the admin shell) ->
 *        CSV exports.
 *   (2d) tenant exit lifecycle over HTTP: D-11 409 block with the open
 *        session id -> close session -> terminate -> 30-day read-only
 *        export window (manifest.json SHA-256 verified file by file;
 *        a write inside the window is 403) -> window-end simulated by
 *        moving the stored window end into the past (no test waits 30
 *        days — the service tests do the same with a fake clock) ->
 *        schedule hard delete -> hard delete -> the on-disk statutory
 *        archive bundle re-hashed against the returned SHA-256.
 *
 * Gaps this test exposed and fixed (see the individual files):
 *   1. The EventPublisher was never wired in production: ExitService /
 *      GdprService / PaymentsService expose setEventPublisher() and the
 *      payments module comment says it "is set later by the
 *      integrations module", but no code ever called it — the live API
 *      published ZERO webhook events. AppModule.onModuleInit now wires
 *      WebhookService as the publisher for all three.
 *   2. No HTTP route re-provisioned a webhook secret after a restart
 *      (POST /v1/webhooks/endpoints/:id/secret) and no route executed
 *      a hard deletion (POST /v1/admin/exit/hard-delete), and no
 *      controller exposed register sessions (POST
 *      /v1/reporting/sessions, :id/end, :id/close) — all added as thin
 *      controllers over the existing services.
 *   3. API-key actors carry userId `api-key:<keyId>`, which is not a
 *      UUID: every audited write and every uuid *_by_user_id column
 *      500d (22P02). AuditService now stores userIdAsUuid() in the
 *      uuid column (full identity stays in the hashed payload) and the
 *      same helper guards the session / VAT / export / deletion job
 *      user columns.
 *   4. GET /v1/events 500d over HTTP: the per-tenant sequence is a
 *      bigint and JSON.stringify throws on bigint. The controller now
 *      serialises it as a decimal string.
 *
 * Honest limits of this file:
 *   - The 30-day export window is simulated (stored window end moved
 *     into the past while the API is stopped), never waited out.
 *   - `tenant.deleted` is created as an event but can never be
 *     DELIVERED to the deleted tenant's own endpoints: hardDelete
 *     deletes the endpoint rows before publishing, so publish finds
 *     no subscribers. The test asserts the event exists with zero
 *     deliveries (final DB check).
 *   - After hard deletion the tenant's API key is deleted with it, so
 *     GET /v1/compliance/statutory-archives/:tenantId cannot be
 *     authenticated as that tenant afterwards (asserted 401) — the
 *     archive is verified instead via the hard-delete response's
 *     SHA-256 + the on-disk bundle + the DB row (final DB check).
 *     Post-deletion compliance reads need a platform credential that
 *     does not exist yet.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
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

const API_PORT = 3227;
const REGISTER_PORT = 3230;
const ADMIN_PORT = 3231;
const RECEIVER_PORT = 3239;
const API_BASE = `http://localhost:${API_PORT}`;
const REGISTER_BASE = `http://localhost:${REGISTER_PORT}`;
const ADMIN_BASE = `http://localhost:${ADMIN_PORT}`;
const RECEIVER_BASE = `https://127.0.0.1:${RECEIVER_PORT}`;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');
const REGISTER_ENTRY = join(ROOT, 'apps/register-app/dist/apps/register-app/src/ui/server.js');
const ADMIN_ENTRY = join(ROOT, 'apps/admin-web/dist/ui/server.js');

const E2E_SKU = 'E2E-001';
const E2E_BARCODE = '5012345678900';
const E2E_NAME = 'E2E Widget';
const E2E_PRICE_PENCE = 1200n;
const FLOAT_PENCE = 5000n;

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  // Raw TCP connect: no HTTP semantics, so a server that accepts but never
  // answers cannot hang this check.
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

function verifyWebhookSignature(
  secret: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
  headerName = 'x-webhook-signature',
): boolean {
  const signature = headers[headerName];
  const timestamp = headers['x-webhook-timestamp'];
  if (signature === undefined || timestamp === undefined) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // 5-minute replay window, either direction (Arch-02 §3.3).
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

async function http(
  url: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  // A wedged server must fail fast, never hang the suite to the test timeout.
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

function demoHeaders(tenant: SeededTenant, roles = 'admin'): Record<string, string> {
  return {
    'x-tenant-id': tenant.tenantId,
    'x-user-id': tenant.users.owner.id,
    'x-location-id': tenant.locationId,
    'x-roles': roles,
  };
}

// ---------------------------------------------------------------------
// Child-process management
// ---------------------------------------------------------------------

let apiChild: ChildProcess | null = null;
let registerChild: ChildProcess | null = null;
let adminChild: ChildProcess | null = null;
let receiver: HttpsServer | null = null;

const childLogs: Record<string, string> = {};

function spawnLogged(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const logPath = join(TMP_DIR, `${name}.log`);
  const out = { data: '' };
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => {
    out.data += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    out.data += chunk.toString('utf8');
  });
  child.on('exit', () => {
    try {
      writeFileSync(logPath, out.data, 'utf8');
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
      // SIGKILL cannot be ignored; if 'exit' still has not fired, do not
      // hang the suite — the port check below is the real gate.
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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build06-e2e-'));
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

let tenantA: TenantSet;
let tenantB: TenantSet;
let tenantW1: TenantSet;
let tenantW2: TenantSet;
let tenantW3: TenantSet;
let tenantW4: TenantSet;
let variantA: { variantId: string };
let vatPeriodAId: string;
let sessionBId: string;

interface CapturedDelivery {
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

const deliveries: CapturedDelivery[] = [];

function deliveriesFor(tenantId: string): CapturedDelivery[] {
  return deliveries.filter((d) => {
    try {
      return (JSON.parse(d.body) as { tenant_id?: string }).tenant_id === tenantId;
    } catch {
      return false;
    }
  });
}

async function waitForDeliveries(
  tenantId: string,
  count: number,
  timeoutMs = 15_000,
): Promise<CapturedDelivery[]> {
  await waitFor(`${count} deliveries for ${tenantId}`, async () => deliveriesFor(tenantId).length >= count, timeoutMs);
  return deliveriesFor(tenantId);
}

// ---------------------------------------------------------------------
// API boot / restart
// ---------------------------------------------------------------------

function apiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(API_PORT),
    NODE_ENV: 'production',
    PGLITE_DATA_DIR: PG_DATA_DIR,
    WEBHOOK_ENCRYPTION_KEY: WEBHOOK_KEY,
    STATUTORY_ARCHIVE_DIR: ARCHIVE_DIR,
    // The receiver uses a test self-signed cert; the API's fetch must
    // accept it (test-only env var on the child process).
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
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
  const ready = await apiGet(tenantA, '/v1/tax-rates');
  if (ready.status !== 200) {
    throw new Error(
      `API on port ${API_PORT} answered /v1/tax-rates with ${ready.status} for the seeded admin key — the process answering is not our seeded server (another process may hold the port, or the server opened a different database); refusing to proceed`,
    );
  }
}

async function stopApi(): Promise<void> {
  await stopChild(apiChild, API_PORT);
  apiChild = null;
}

async function restartApi(between?: () => Promise<void>): Promise<void> {
  await stopApi();
  if (between !== undefined) {
    await between();
  }
  await startApi();
}

/**
 * Clear one endpoint's stored current-secret ciphertext (simulates
 * a legacy pre-Build-07 endpoint whose secret was never persisted
 * encrypted). API must be stopped — same pattern as
 * simulateWindowEnded.
 */
async function nullCurrentSecretCiphertext(endpointId: string): Promise<void> {
  const { db, close } = await createPGliteDb(PG_DATA_DIR);
  try {
    await sql`UPDATE webhook_endpoints SET current_secret_ciphertext = NULL WHERE id = ${endpointId}`.execute(db);
  } finally {
    await close();
  }
}

/** Move a tenant's stored export-window end into the past (simulates 30 days passing). API must be stopped. */
async function simulateWindowEnded(tenantId: string): Promise<void> {
  const { db, close } = await createPGliteDb(PG_DATA_DIR);
  try {
    await sql`UPDATE tenants SET export_window_ends_at = now() - interval '1 hour' WHERE id = ${tenantId}`.execute(db);
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------

async function seedAll(): Promise<void> {
  const { db, close } = await createPGliteDb(PG_DATA_DIR);
  try {
    await applyMigrations(db, findMigrationsDir(ROOT));

    const mk = async (name: string): Promise<TenantSet> => {
      const tenant = await seedTenant(db, { name });
      const created = await createTestApiKey(db, tenant, { name: `${name} e2e key`, scopes: ['admin'] });
      return { tenant, key: created.key };
    };

    tenantA = await mk('E2E Sales Ltd');
    tenantB = await mk('E2E Exit Ltd');
    tenantW1 = await mk('E2E Webhook One Ltd');
    tenantW2 = await mk('E2E Webhook Two Ltd');
    tenantW3 = await mk('E2E Webhook Three Ltd');
    tenantW4 = await mk('E2E Webhook Four Ltd');

    const seeded = await seedVariant(db, tenantA.tenant, {
      sku: E2E_SKU,
      barcode: E2E_BARCODE,
      name: E2E_NAME,
      pricePence: E2E_PRICE_PENCE,
      costPence: 800n,
      taxRateId: tenantA.tenant.taxRates.standard,
    });
    variantA = { variantId: seeded.variantId };
    await setStock(db, tenantA.tenant, seeded.variantId, { quantity: 10n, costPence: 800n });

    // One open VAT period for tenant A (November 2026 covers today).
    const period = await db
      .insertInto('vat_periods')
      .values({
        tenant_id: tenantA.tenant.tenantId,
        period_start: '2026-11-01',
        period_end: '2026-11-30',
        status: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    vatPeriodAId = period.id;

    // One OPEN session for tenant B (the D-11 blocker for the exit test).
    const session = await db
      .insertInto('register_sessions')
      .values({
        tenant_id: tenantB.tenant.tenantId,
        register_id: tenantB.tenant.registerId,
        opened_by_user_id: tenantB.tenant.users.owner.id,
        float_pence: FLOAT_PENCE,
        status: 'open',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    sessionBId = session.id;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------
// Receiver (HTTPS, self-signed cert generated with openssl)
// ---------------------------------------------------------------------

async function startReceiver(): Promise<void> {
  // Hardening (Build-11 Objective 3 — the 3239 EADDRINUSE failure):
  // the old code called receiver.listen() with no error handling, so
  // a leftover process holding 3239 crashed the suite with an
  // uncaught EADDRINUSE. Fail fast first when the port is held, then
  // await the listen and surface a bind error as a test failure
  // instead of an uncaught exception.
  await waitForPortFree(RECEIVER_PORT);
  execSync(
    'openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"',
    { cwd: TMP_DIR, stdio: 'ignore' },
  );
  const key = readFileSync(join(TMP_DIR, 'key.pem'));
  const cert = readFileSync(join(TMP_DIR, 'cert.pem'));
  receiver = createHttpsServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value;
      }
      deliveries.push({ path: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    receiver?.once('error', reject);
    receiver?.listen(RECEIVER_PORT, '127.0.0.1', () => resolve());
  });
}

// ---------------------------------------------------------------------
// API call helpers (Bearer key + tenant/location headers)
// ---------------------------------------------------------------------

function apiHeaders(t: TenantSet): Record<string, string> {
  return {
    ...bearer(t.key),
    'x-tenant-id': t.tenant.tenantId,
    'x-location-id': t.tenant.locationId,
    'Content-Type': 'application/json',
  };
}

async function apiPost(
  t: TenantSet,
  path: string,
  body: unknown = {},
): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'POST',
    headers: apiHeaders(t),
    body: JSON.stringify(body),
  });
}

async function apiGet(t: TenantSet, path: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders(t) });
}

function expectJsonObject(result: HttpResult): Record<string, unknown> {
  expect(result.json).not.toBeNull();
  expect(typeof result.json).toBe('object');
  return result.json as Record<string, unknown>;
}

// ---------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------

async function registerAction(params: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`${REGISTER_BASE}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, text, json: null };
}

async function registerPage(): Promise<string> {
  const res = await http(`${REGISTER_BASE}/`);
  expect(res.status).toBe(200);
  return res.text;
}

async function adminGet(path: string): Promise<HttpResult> {
  return http(`${ADMIN_BASE}${path}`);
}

async function adminPost(path: string): Promise<HttpResult> {
  const res = await fetch(`${ADMIN_BASE}${path}`, { method: 'POST', redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, json: null };
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-06 Objective 4 — E2E HTTP lifecycle (real child processes)', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);
    expect(existsSync(REGISTER_ENTRY)).toBe(true);
    expect(existsSync(ADMIN_ENTRY)).toBe(true);

    await seedAll();
    await startReceiver();
    await waitFor('webhook receiver to listen', async () => receiver?.listening === true);

    await startApi();

    registerChild = spawnLogged('register-ui', 'node', [REGISTER_ENTRY], {
      ...process.env,
      REGISTER_UI_PORT: String(REGISTER_PORT),
      REGISTER_API_BASE_URL: API_BASE,
      REGISTER_API_KEY: tenantA.key,
      REGISTER_TENANT_ID: tenantA.tenant.tenantId,
      REGISTER_LOCATION_ID: tenantA.tenant.locationId,
      REGISTER_REGISTER_ID: tenantA.tenant.registerId,
      REGISTER_USER_ID: tenantA.tenant.users.owner.id,
      REGISTER_ROLES: 'cashier',
      REGISTER_SQLITE_PATH,
      REGISTER_APP_DEVICE_SECRET: DEVICE_SECRET,
    });
    await waitFor('register UI to answer /health', async () => {
      const res = await http(`${REGISTER_BASE}/health`);
      return res.status === 200;
    });

    adminChild = spawnLogged('admin-ui', 'node', [ADMIN_ENTRY], {
      ...process.env,
      ADMIN_WEB_PORT: String(ADMIN_PORT),
      ADMIN_API_BASE_URL: API_BASE,
      ADMIN_API_TOKEN: tenantA.key,
      ADMIN_TENANT_ID: tenantA.tenant.tenantId,
      ADMIN_LOCATION_ID: tenantA.tenant.locationId,
    });
    await waitFor('admin UI to answer /health', async () => {
      const res = await http(`${ADMIN_BASE}/health`);
      return res.status === 200;
    });
  }, 180_000);

  afterAll(async () => {
    console.log('[e2e] afterAll: stopping register UI');
    await stopChild(registerChild, REGISTER_PORT);
    console.log('[e2e] afterAll: stopping admin UI');
    await stopChild(adminChild, ADMIN_PORT);
    console.log('[e2e] afterAll: stopping API');
    await stopApi();
    console.log('[e2e] afterAll: closing webhook receiver');
    if (receiver !== null) {
      await new Promise<void>((resolve) => receiver?.close(() => resolve()));
    }

    // Final DB verification (API stopped, directory free): the exit
    // tenant is a tombstone with no surviving rows, its statutory
    // archive row + on-disk bundle exist, and tenant.deleted was
    // created as an event with zero deliveries (endpoints are deleted
    // before the publish, so it can never be delivered).
    const { db, close } = await createPGliteDb(PG_DATA_DIR);
    try {
      const tombstone = await db
        .selectFrom('tenants')
        .select(['name', 'status'])
        .where('id', '=', tenantB.tenant.tenantId)
        .executeTakeFirst();
      expect(tombstone?.name).toBe('[deleted]');
      expect(tombstone?.status).toBe('deleted');

      const keysB = await db
        .selectFrom('api_keys')
        .select('id')
        .where('tenant_id', '=', tenantB.tenant.tenantId)
        .execute();
      expect(keysB.length).toBe(0);

      const archivesB = await db
        .selectFrom('statutory_vat_archives')
        .selectAll()
        .where('tenant_id', '=', tenantB.tenant.tenantId)
        .execute();
      expect(archivesB.length).toBe(1);
      const archiveRow = archivesB[0]!;
      expect(archiveRow.archive_sha256).toBe(lastHardDeleteArchiveSha);
      expect(archiveRow.retention_until.getTime()).toBeGreaterThan(Date.now());
      // Retention is 6 years (Arch-01 §6.3): within a day of archived_at + 6y.
      const sixYearsMs = 6 * 365.25 * 24 * 60 * 60 * 1000;
      expect(
        Math.abs(archiveRow.retention_until.getTime() - archiveRow.archived_at.getTime() - sixYearsMs),
      ).toBeLessThan(24 * 60 * 60 * 1000);
      expect(existsSync(archiveRow.storage_bundle_path)).toBe(true);
      expect(sha256Hex(readFileSync(archiveRow.storage_bundle_path, 'utf8'))).toBe(
        archiveRow.archive_sha256,
      );

      const deletedEvents = await db
        .selectFrom('webhook_events')
        .select('id')
        .where('tenant_id', '=', tenantB.tenant.tenantId)
        .where('event_type', '=', 'tenant.deleted')
        .execute();
      expect(deletedEvents.length).toBe(1);
      const deletedDeliveries = await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('event_id', 'in', deletedEvents.map((e) => e.id))
        .execute();
      expect(deletedDeliveries.length).toBe(0);
    } finally {
      await close();
    }
    // /tmp is a 512MB tmpfs: each run leaves a 40–60MB pgdata behind.
    // Remove the whole temp dir now that the final checks have read it,
    // or a handful of runs fills /tmp and PGlite stops initializing
    // (proven 2026-11-14: /tmp at 100% broke the (2d) reopen).
    rmSync(TMP_DIR, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`Build-06 E2E temp dir removed: ${TMP_DIR}`);
    // eslint-disable-next-line no-console
    console.log(`Child logs: ${JSON.stringify(childLogs)}`);
  }, 180_000);

  it('boots all three servers in live mode', async () => {
    const apiStatus = await http(`${API_BASE}/payments/status`);
    expect(apiStatus.status).toBe(200);

    const registerHealth = await http(`${REGISTER_BASE}/health`);
    expect(registerHealth.status).toBe(200);
    const registerHtml = await registerPage();
    expect(registerHtml).not.toContain('API unreachable');
    expect(registerHtml).not.toContain('Sync error');

    for (const view of ['/', '/catalogue', '/inventory', '/crm', '/finance', '/webhooks', '/exit']) {
      const page = await adminGet(view);
      expect(page.status, `admin view ${view}`).toBe(200);
    }
    const adminHome = await adminGet('/');
    expect(adminHome.text).toContain('LIVE');
    expect(adminHome.text).not.toContain('DEMO DATA');
  }, 60_000);

  it('(2b) malformed UUIDs are 400 INVALID_UUID across the older controllers', async () => {
    const bad = 'not-a-uuid';
    const cases: Array<{ label: string; run: () => Promise<HttpResult> }> = [
      {
        label: 'sales receipt',
        run: () =>
          // AuthGuarded (Build-10): demo headers alone 401 — the Bearer
          // admin key carries the request to the interceptor → 400.
          http(`${API_BASE}/v1/sales/orders/${bad}/receipt`, { headers: apiHeaders(tenantA) }),
      },
      {
        label: 'inventory count submit',
        run: () => apiPost(tenantA, `/v1/inventory/counts/${bad}/submit`, {}),
      },
      {
        label: 'purchasing reorder-suggestion accept',
        run: () => apiPost(tenantA, `/v1/inventory/reorder-suggestions/${bad}/accept`, {}),
      },
      {
        label: 'crm customer consents',
        run: () => apiGet(tenantA, `/v1/crm/customers/${bad}/consents`),
      },
      {
        label: 'api-keys rotate',
        run: () => apiPost(tenantA, `/v1/api-keys/${bad}/rotate`, {}),
      },
      {
        label: 'reporting z-report',
        run: () => apiGet(tenantA, `/v1/reporting/z-reports/${bad}`),
      },
      {
        label: 'webhooks endpoint re-provision',
        run: () => apiPost(tenantA, `/v1/webhooks/endpoints/${bad}/secret`, { secret: 'x' }),
      },
      {
        label: 'sessions open with malformed registerId in the body',
        run: () =>
          apiPost(tenantA, '/v1/reporting/sessions', {
            registerId: bad,
            openingFloatPence: '5000',
          }),
      },
    ];
    for (const c of cases) {
      const res = await c.run();
      expect(res.status, c.label).toBe(400);
      const body = expectJsonObject(res);
      const error = body.error as Record<string, unknown>;
      expect(error.code, c.label).toBe('INVALID_UUID');
    }

    // Well-formed but unknown UUIDs still reach the handler and answer 404.
    const unknown = '11111111-2222-3333-4444-555555555555';
    const notFound = await http(`${API_BASE}/v1/sales/orders/${unknown}/receipt`, {
      // AuthGuarded (Build-10): the Bearer admin key (sales:read via
      // admin scope) carries the request to the handler → 404.
      headers: apiHeaders(tenantA),
    });
    expect(notFound.status).toBe(404);

    // The compliance :tenantId route is also guarded by the global
    // interceptor: a malformed :tenantId answers 400 INVALID_UUID
    // (the guard passes a valid key+scope, the interceptor fires
    // before the handler) — and no malformed id can 500.
    const compliance = await apiGet(tenantA, `/v1/compliance/statutory-archives/${bad}`);
    expect(compliance.status).toBe(400);
    expect((expectJsonObject(compliance).error as Record<string, unknown>).code).toBe('INVALID_UUID');
  }, 60_000);

  it('(2a) webhook rotation dual-signs before a restart', async () => {
    // W1, W2, W4: register + rotate (24h grace) + request-termination.
    // Only W2 begins pre-restart: its delivery must carry a current
    // signature (new secret) AND a previous signature (retiring secret).
    // W1 stays in termination_requested so the post-restart test can
    // begin it (each tenant's export window can begin exactly once);
    // W4 stays too, as the no-reprovision case after the restart.
    for (const [index, t] of [tenantW1, tenantW2, tenantW4].entries()) {
      const label = ['W1', 'W2', 'W4'][index]!;
      const reg = await apiPost(t, '/v1/webhooks/endpoints', {
        url: `${RECEIVER_BASE}/hook`,
        eventTypes: ['tenant.export_window_started'],
      });
      expect(reg.status, `register endpoint for ${label}`).toBe(201);
      const regBody = expectJsonObject(reg);
      (t as unknown as { endpointId: string }).endpointId = regBody.endpoint
        ? (regBody.endpoint as Record<string, unknown>).id as string
        : '';
      (t as unknown as { secret0: string }).secret0 = regBody.secret as string;

      const rot = await apiPost(t, `/v1/webhooks/subscriptions/${(t as unknown as { endpointId: string }).endpointId}/rotate-secret`, {
        gracePeriodHours: 24,
      });
      expect(rot.status, `rotate for ${label}`).toBe(201);
      const rotBody = expectJsonObject(rot);
      (t as unknown as { secret1: string }).secret1 = rotBody.secret as string;

      const term = await apiPost(t, '/v1/admin/exit/request-termination', {});
      expect(term.status, `request-termination for ${label}`).toBe(201);
    }

    // Plain-HTTP receiver URLs are rejected (Arch-02 §3.3: HTTPS only).
    const httpReg = await apiPost(tenantW3, '/v1/webhooks/endpoints', {
      url: 'http://127.0.0.1:3239/hook',
      eventTypes: ['tenant.export_window_started'],
    });
    expect(httpReg.status).toBe(400);

    // W2 only: trigger pre-restart and verify both signatures.
    {
      const t = tenantW2;
      const before = deliveriesFor(t.tenant.tenantId).length;
      const begin = await apiPost(t, '/v1/admin/exit/begin-export-window', {});
      expect(begin.status, 'begin-export-window for W2 (pre-restart)').toBe(201);
      const found = await waitForDeliveries(t.tenant.tenantId, before + 1);
      const delivery = found[found.length - 1]!;
      const event = JSON.parse(delivery.body) as { event_type?: string };
      expect(event.event_type).toBe('tenant.export_window_started');
      expect(
        verifyWebhookSignature((t as unknown as { secret1: string }).secret1, delivery.headers, delivery.body),
        'W2: current signature verifies',
      ).toBe(true);
      expect(
        verifyWebhookSignature((t as unknown as { secret0: string }).secret0, delivery.headers, delivery.body, 'x-webhook-signature-previous'),
        'W2: previous signature verifies',
      ).toBe(true);
    }
  }, 120_000);

  it('(2a) webhook rotation dual-signs across a restart — previous secret from the encrypted DB row', async () => {
    // Build-07 persists the current secret encrypted at
    // registration, so a restart alone no longer loses it. W4 keeps
    // proving the "secret genuinely unavailable" path by simulating
    // a legacy pre-Build-07 endpoint: its stored current ciphertext
    // is cleared while the API is stopped, between stop and start.
    await restartApi(async () => {
      await nullCurrentSecretCiphertext(
        (tenantW4 as unknown as { endpointId: string }).endpointId,
      );
    });

    // W1: re-provision the current secret (lost with the old process),
    // then trigger. The previous secret must come from the encrypted
    // DB ciphertext — this process never held it in memory.
    const w1 = tenantW1 as unknown as TenantSet & { endpointId: string; secret0: string; secret1: string };
    const repro = await apiPost(tenantW1, `/v1/webhooks/endpoints/${w1.endpointId}/secret`, {
      secret: w1.secret1,
    });
    expect(repro.status, 're-provision W1 current secret').toBe(201);
    expect(expectJsonObject(repro).status).toBe('re-provisioned');

    // W1: re-provisioned, then begin — the new process signs with the
    // re-provisioned current secret and the previous secret recovered
    // from the encrypted DB ciphertext (it never held it in memory).
    const beforeW1 = deliveriesFor(tenantW1.tenant.tenantId).length;
    const beginW1 = await apiPost(tenantW1, '/v1/admin/exit/begin-export-window', {});
    expect(beginW1.status, 'W1 begin-export-window after restart').toBe(201);
    const foundW1 = await waitForDeliveries(tenantW1.tenant.tenantId, beforeW1 + 1);
    const d1 = foundW1[foundW1.length - 1]!;
    expect(
      verifyWebhookSignature(w1.secret1, d1.headers, d1.body),
      'W1 post-restart: current signature verifies',
    ).toBe(true);
    expect(
      verifyWebhookSignature(w1.secret0, d1.headers, d1.body, 'x-webhook-signature-previous'),
      'W1 post-restart: previous signature verifies (DB ciphertext recovery)',
    ).toBe(true);

    // W2 began pre-restart: its state must have survived the restart,
    // and the restart must not have re-delivered anything.
    const statusW2 = await apiGet(tenantW2, '/v1/admin/exit/status');
    expect(statusW2.status, 'W2 exit status after restart').toBe(200);
    expect((expectJsonObject(statusW2).status as string)).toBe('export_window');
    expect(
      deliveriesFor(tenantW2.tenant.tenantId).length,
      'W2: no re-delivery on restart',
    ).toBe(1);

    // W4 is deliberately NOT re-provisioned, and its stored current
    // ciphertext was cleared during the restart (legacy endpoint):
    // its trigger must send nothing, and the delivery must sit
    // pending with the exact re-provision error.
    const beforeW4 = deliveriesFor(tenantW4.tenant.tenantId).length;
    const beginW4 = await apiPost(tenantW4, '/v1/admin/exit/begin-export-window', {});
    expect(beginW4.status, 'W4 begin-export-window after restart').toBe(201);
    await sleep(2000);
    expect(
      deliveriesFor(tenantW4.tenant.tenantId).length,
      'W4: no delivery without re-provisioning',
    ).toBe(beforeW4);
    const eventsW4 = await http(
      `${API_BASE}/v1/events?event_type=tenant.export_window_started&limit=5`,
      { headers: demoHeaders(tenantW4.tenant) },
    );
    expect(eventsW4.status, 'GET /v1/events for W4').toBe(200);
    const eventsBody = expectJsonObject(eventsW4);
    const events = eventsBody.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const deliveriesW4 = events[0]!.deliveries as Array<Record<string, unknown>>;
    expect(deliveriesW4.length).toBe(1);
    expect(deliveriesW4[0]!.status).toBe('pending');
    expect(String(deliveriesW4[0]!.last_error)).toContain('re-provision with setEndpointSecret');

    // W3: fresh endpoint, tiny grace — after it expires only the new
    // signature is sent.
    const reg3 = await apiPost(tenantW3, '/v1/webhooks/endpoints', {
      url: `${RECEIVER_BASE}/hook`,
      eventTypes: ['tenant.export_window_started'],
    });
    expect(reg3.status).toBe(201);
    const reg3Body = expectJsonObject(reg3);
    const endpoint3 = (reg3Body.endpoint as Record<string, unknown>).id as string;
    const secret0 = reg3Body.secret as string;
    const rot3 = await apiPost(
      tenantW3,
      `/v1/webhooks/subscriptions/${endpoint3}/rotate-secret`,
      { gracePeriodHours: 0.001 },
    );
    expect(rot3.status).toBe(201);
    const secret1 = (expectJsonObject(rot3).secret as string);
    await sleep(5000);
    await apiPost(tenantW3, '/v1/admin/exit/request-termination', {});
    const beforeW3 = deliveriesFor(tenantW3.tenant.tenantId).length;
    const beginW3 = await apiPost(tenantW3, '/v1/admin/exit/begin-export-window', {});
    expect(beginW3.status).toBe(201);
    const foundW3 = await waitForDeliveries(tenantW3.tenant.tenantId, beforeW3 + 1);
    const d3 = foundW3[foundW3.length - 1]!;
    expect(verifyWebhookSignature(secret1, d3.headers, d3.body), 'W3: current signature verifies').toBe(true);
    expect(d3.headers['x-webhook-signature-previous'], 'W3: no previous signature after grace expiry').toBeUndefined();
    expect(
      verifyWebhookSignature(secret0, d3.headers, d3.body, 'x-webhook-signature-previous'),
      'W3: old secret no longer verifies as previous',
    ).toBe(false);
  }, 180_000);

  it('(2c) register UI -> API: online sale, offline cash sale, encrypted SQLite, FIFO sync, session/Z/VAT/CSV', async () => {
    // Server session first: expected cash counts sales inside it.
    const opened = await apiPost(tenantA, '/v1/reporting/sessions', {
      registerId: tenantA.tenant.registerId,
      openingFloatPence: FLOAT_PENCE.toString(),
    });
    expect(opened.status, 'open session for tenant A').toBe(201);
    const sessionId = (expectJsonObject(opened).session as Record<string, unknown>).id as string;

    // Catalogue sync, then an online cash sale through the UI.
    const syncAction = await registerAction({ action: 'sync-catalogue' });
    expect(syncAction.status, 'sync-catalogue action').toBe(303);
    let page = await registerPage();
    expect(page).toContain(E2E_NAME);

    const add = await registerAction({ action: 'quick-key', sku: E2E_SKU });
    expect(add.status, 'quick-key action').toBe(303);
    page = await registerPage();
    expect(page).toContain(`Added ${E2E_NAME}.`);

    const checkout = await registerAction({ action: 'checkout-online' });
    expect(checkout.status, 'checkout-online action').toBe(303);
    page = await registerPage();
    expect(page).toContain('Sale completed');
    expect(page).toContain('£12.00');

    // Offline: toggle off, sell for cash, prove the local file holds
    // the product name and the queued order payload only as AES-256-GCM
    // envelopes (sku/barcode stay plaintext lookup keys by design).
    const off = await registerAction({ action: 'toggle-online' });
    expect(off.status).toBe(303);
    page = await registerPage();
    expect(page).toContain('Offline');

    const addOff = await registerAction({ action: 'quick-key', sku: E2E_SKU });
    expect(addOff.status).toBe(303);
    const queued = await registerAction({ action: 'checkout-cash' });
    expect(queued.status).toBe(303);
    page = await registerPage();
    expect(page).toContain('Offline cash sale queued');
    expect(existsSync(REGISTER_SQLITE_PATH), 'register SQLite file exists').toBe(true);
    const rawBytes = readFileSync(REGISTER_SQLITE_PATH);
    expect(rawBytes.length).toBeGreaterThan(0);
    // Adapter design (sqlite-storage.ts): sku/barcode are plaintext
    // lookup keys by design; the encrypted columns are name and the
    // offline queue's order_payload_json. The payload's JSON form of
    // the snapshot price exists ONLY inside that encrypted envelope
    // (FlushOrder has no sku/barcode fields at all).
    expect(rawBytes.includes(Buffer.from(E2E_SKU)), 'SQLite: SKU lookup key present by design').toBe(true);
    expect(rawBytes.includes(Buffer.from(E2E_BARCODE)), 'SQLite: barcode lookup key present by design').toBe(true);
    expect(rawBytes.includes(Buffer.from(E2E_NAME)), 'SQLite bytes contain no plaintext product name').toBe(false);
    expect(rawBytes.includes(Buffer.from('"snapshotUnitPricePence":"1200"')), 'SQLite: order payload snapshot price is encrypted').toBe(false);
    expect(rawBytes.includes(Buffer.from('"tenderTotalPence":"1200"')), 'SQLite: order payload tender total is encrypted').toBe(false);

    // Reconnect + FIFO flush.
    const on = await registerAction({ action: 'toggle-online' });
    expect(on.status).toBe(303);
    const flush = await registerAction({ action: 'sync-flush' });
    expect(flush.status).toBe(303);
    page = await registerPage();
    expect(page).toContain('Queue flushed: 1 synced, 0 conflict(s), 0 failed.');

    // End the session: float 5000 + 1200 online cash + 1200 offline cash.
    const ended = await apiPost(tenantA, `/v1/reporting/sessions/${sessionId}/end`, {});
    expect(ended.status, 'end session').toBe(201);
    const endedSession = (expectJsonObject(ended).session as Record<string, unknown>);
    expect(endedSession.expected_cash_pence).toBe('7400');

    const closed = await apiPost(tenantA, `/v1/reporting/sessions/${sessionId}/close`, {
      countedCashPence: '7400',
    });
    expect(closed.status, 'close session').toBe(201);
    const closedBody = expectJsonObject(closed);
    const zReport = closedBody.zReport as Record<string, unknown>;
    expect(zReport.gross_pence).toBe('2400');
    expect(zReport.order_count).toBe(2);
    expect(zReport.cash_variance_pence).toBe('0');
    const zReportId = zReport.id as string;

    const zGet = await apiGet(tenantA, `/v1/reporting/z-reports/${zReportId}`);
    expect(zGet.status, 'GET z-report').toBe(200);
    expect((expectJsonObject(zGet).gross_pence as string)).toBe('2400');
    const zCsv = await apiGet(tenantA, `/v1/reporting/z-reports/${zReportId}/csv`);
    expect(zCsv.status, 'GET z-report CSV').toBe(200);
    expect(zCsv.text).toContain('z_number');

    // VAT period close goes through the ADMIN SHELL (live mode), not
    // the API directly — this proves the shell's live wiring. The
    // shell renders the finance view (200), not a redirect.
    const vatClose = await adminPost(`/finance/vat-periods/${vatPeriodAId}/close`);
    expect(vatClose.status, 'admin shell VAT close').toBe(200);
    expect(vatClose.text).toContain(`VAT period ${vatPeriodAId} closed in place`);
    const financePage = await adminGet(`/finance?z=${zReportId}&vat=${vatPeriodAId}`);
    expect(financePage.status).toBe(200);
    // The finance view only renders a Z-report when loaded via ?z=
    // (a bare /finance shows 'No Z-report loaded').
    expect(financePage.text).toContain(zReportId);
    expect(financePage.text).toContain('£24.00');
    expect(financePage.text).toContain('CLOSED');
    const vatCsv = await apiGet(tenantA, `/v1/reporting/vat-periods/${vatPeriodAId}/csv`);
    expect(vatCsv.status, 'GET VAT period CSV').toBe(200);
    expect(vatCsv.text.length).toBeGreaterThan(0);
  }, 180_000);

  it('(2d) tenant exit lifecycle over HTTP: D-11 block, close, terminate, export, hard delete, archive', async () => {
    const status = await apiGet(tenantB, '/v1/admin/exit/status');
    expect(status.status).toBe(200);
    const statusBody = expectJsonObject(status);
    expect(statusBody.openSessionIds as string[]).toContain(sessionBId);

    // D-11: termination is blocked while the session is open.
    const blocked = await apiPost(tenantB, '/v1/admin/exit/request-termination', {});
    expect(blocked.status, 'D-11 block').toBe(409);
    const blockedBody = expectJsonObject(blocked);
    expect(JSON.stringify(blockedBody)).toContain(sessionBId);

    // Close the session over HTTP (end -> close, counted == expected).
    const ended = await apiPost(tenantB, `/v1/reporting/sessions/${sessionBId}/end`, {});
    expect(ended.status, 'end session B').toBe(201);
    expect((expectJsonObject(ended).session as Record<string, unknown>).expected_cash_pence).toBe('5000');
    const closed = await apiPost(tenantB, `/v1/reporting/sessions/${sessionBId}/close`, {
      countedCashPence: '5000',
    });
    expect(closed.status, 'close session B').toBe(201);
    expect(
      ((expectJsonObject(closed).zReport as Record<string, unknown>).order_count as number),
    ).toBe(0);

    const term = await apiPost(tenantB, '/v1/admin/exit/request-termination', {});
    expect(term.status, 'request-termination B').toBe(201);
    expect((expectJsonObject(term).status as string)).toBe('termination_requested');

    const begin = await apiPost(tenantB, '/v1/admin/exit/begin-export-window', {});
    expect(begin.status, 'begin-export-window B').toBe(201);
    expect((expectJsonObject(begin).status as string)).toBe('export_window');

    // 30-day read-only export: every manifest file re-hashed.
    const exported = await apiPost(tenantB, '/v1/admin/exit/full-export', {});
    expect(exported.status, 'full-export B').toBe(201);
    const exportBody = expectJsonObject(exported);
    const files = exportBody.files as Record<string, string>;
    const manifest = exportBody.manifest as Array<Record<string, unknown>>;
    expect(files['manifest.json']).toBeDefined();
    expect(manifest.length).toBeGreaterThan(0);
    for (const entry of manifest) {
      const name = entry.file_name as string;
      expect(files[name], `manifest file ${name} present`).toBeDefined();
      expect(sha256Hex(files[name]!), `manifest SHA-256 for ${name}`).toBe(entry.sha256_checksum);
    }

    // Read-only enforcement inside the window: a sale is 403.
    // AuthGuarded (Build-10): the Bearer admin key passes AuthGuard
    // (sales:write via admin scope), then TenantWriteGuard answers 403.
    const writeBlocked = await http(`${API_BASE}/v1/sales/orders`, {
      method: 'POST',
      headers: apiHeaders(tenantB),
      body: JSON.stringify({
        locationId: tenantB.tenant.locationId,
        registerId: tenantB.tenant.registerId,
        lines: [{ variantId: variantA.variantId, quantity: '1' }],
      }),
    });
    expect(writeBlocked.status, 'write inside export window is 403').toBe(403);

    // Simulate the 30 days passing, then schedule + execute the delete.
    await stopApi();
    await simulateWindowEnded(tenantB.tenant.tenantId);
    await startApi();

    const scheduled = await apiPost(tenantB, '/v1/admin/exit/schedule-hard-delete', {});
    expect(scheduled.status, 'schedule-hard-delete B').toBe(201);
    expect((expectJsonObject(scheduled).status as string)).toBe('hard_delete_scheduled');

    const deleted = await apiPost(tenantB, '/v1/admin/exit/hard-delete', {});
    expect(deleted.status, 'hard-delete B').toBe(201);
    const deletedBody = expectJsonObject(deleted);
    expect(deletedBody.verifiedRowCount).toBe(0);
    const archive = deletedBody.statutoryArchive as Record<string, unknown>;
    expect(typeof archive.archiveSha256).toBe('string');
    expect(typeof archive.storageBundlePath).toBe('string');
    lastHardDeleteArchiveSha = archive.archiveSha256 as string;
    const bundlePath = archive.storageBundlePath as string;
    expect(bundlePath.startsWith(ARCHIVE_DIR), 'bundle lives under STATUTORY_ARCHIVE_DIR').toBe(true);
    expect(existsSync(bundlePath), 'on-disk bundle exists').toBe(true);
    expect(sha256Hex(readFileSync(bundlePath, 'utf8')), 'on-disk bundle SHA-256 matches the response').toBe(
      archive.archiveSha256,
    );

    // The tenant's key died with the tenant: compliance reads as that
    // tenant are now 401 (no platform credential exists yet).
    const afterDelete = await apiGet(tenantB, `/v1/compliance/statutory-archives/${tenantB.tenant.tenantId}`);
    expect(afterDelete.status, 'compliance read after hard delete is 401').toBe(401);
  }, 180_000);
});

let lastHardDeleteArchiveSha = '';
