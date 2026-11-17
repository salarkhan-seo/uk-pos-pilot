/**
 * Build-12 Objective 3 — the three remaining G-UI-06 endpoints, live over HTTP.
 *
 * Boots the COMPILED API as a real child process and drives it over
 * REAL HTTP round-trips:
 *
 *   1. PATCH /v1/catalogue/variants/:id — happy path (price + SKU),
 *      only the supplied fields change, `updated_at` is stamped later
 *      than the create stamp, and the /v1/sync/handshake delta sees
 *      the variant when `since` predates the PATCH but not when it
 *      postdates it; status 'inactive' flips is_active.
 *   2. POST /v1/inventory/purchase-orders — standalone DRAFT PO
 *      creation: po_number '1', status 'draft', the warehouse and the
 *      expected delivery date are recorded on the PO, lines echo the
 *      given quantities/costs; a second PO numbers '2'.
 *   3. POST /v1/crm/customers/:id/groups — assignment, then a repeat
 *      call returns the SAME membership (same created_at), with still
 *      one membership row in the database.
 *   4. Error matrix over HTTP, per endpoint: unauthenticated → 401;
 *      wrong scope → 403; malformed id → 400 INVALID_UUID;
 *      cross-tenant → 404; plus the endpoint-specific 400s/409s/404s
 *      (duplicate SKU/barcode → 409, unknown tax rate → 404, empty
 *      PATCH → 400, unknown supplier/warehouse/variant → 404,
 *      non-positive quantity / negative cost / duplicate line variant
 *      / bad expected date → 400, unknown customer/group → 404).
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
 * 3827/3830, 3927, 4027, 4127/4130/4131, 4227, 4327/4330, 4427/4430,
 * 4527): API 4627 only — this proof needs the API alone; no
 * register/admin UI is booted.
 *
 * Only the tenants + API keys + one customer + one group are seeded
 * through PGlite (infrastructure scaffolding, same as every E2E
 * suite — there is no create-customer or create-group route, so the
 * customer and group rows are seeded, not created over HTTP): every
 * other business row is created over HTTP.
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

const API_PORT = 4627;
const API_BASE = `http://localhost:${API_PORT}`;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const API_ENTRY = join(ROOT, 'apps/api/dist/main.js');

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED_ID = 'not-a-uuid';

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

const TMP_DIR = mkdtempSync(join(tmpdir(), 'ukpos-build12-gui06-'));
const PG_DATA_DIR = join(TMP_DIR, 'pgdata');
const ARCHIVE_DIR = join(TMP_DIR, 'statutory-archives');
const WEBHOOK_KEY = randomBytes(32).toString('hex');

mkdirSync(PG_DATA_DIR, { recursive: true });
mkdirSync(ARCHIVE_DIR, { recursive: true });

interface TenantSet {
  tenant: SeededTenant;
  adminKey: string;
  catalogueWriteKey: string;
  catalogueReadKey: string;
  stockWriteKey: string;
  stockReadKey: string;
  salesReadKey: string;
}

let tenant: TenantSet;
let tenantB: TenantSet;
let warehouseId: string;
let supplierId: string;
let productId: string;
let variantId: string;
let variant2Id: string;
let customerId: string;
let groupId: string;

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

async function apiPatch(
  t: TenantSet,
  path: string,
  body: unknown = {},
  key?: string,
): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: apiHeaders(t, key ?? t.adminKey),
    body: JSON.stringify(body),
  });
}

async function apiGet(t: TenantSet, path: string, key?: string): Promise<HttpResult> {
  return http(`${API_BASE}${path}`, { headers: apiHeaders(t, key ?? t.adminKey) });
}

type VariantRow = Record<string, unknown>;

async function listVariants(t: TenantSet): Promise<VariantRow[]> {
  const res = await apiGet(t, '/v1/catalogue/variants');
  expect(res.status, 'GET /v1/catalogue/variants').toBe(200);
  expect(Array.isArray(res.json)).toBe(true);
  return res.json as VariantRow[];
}

async function handshakeVariants(t: TenantSet, since: string | null): Promise<VariantRow[]> {
  const res = await apiPost(
    t,
    '/v1/sync/handshake',
    { registerId: t.tenant.registerId, since },
    t.salesReadKey,
  );
  // Nest answers a POST with 201 by default (no @HttpCode(200) on
  // the handshake handler) — the handshake is a read, but its
  // status is the framework default, not an error.
  expect(res.status, 'POST /v1/sync/handshake').toBe(201);
  const body = expectJsonObject(res);
  const catalogue = body.catalogue as Record<string, unknown> | undefined;
  expect(catalogue).toBeDefined();
  const variants = catalogue?.variants as VariantRow[] | undefined;
  expect(Array.isArray(variants)).toBe(true);
  return variants as VariantRow[];
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

describe('Build-12 Objective 3 — G-UI-06 endpoints, live over HTTP', () => {
  beforeAll(async () => {
    expect(existsSync(API_ENTRY)).toBe(true);

    // Seed ONLY the tenants + API keys + one customer + one group
    // (infrastructure scaffolding — there is no create-customer or
    // create-group route, so those two rows are seeded; every other
    // business row is created over HTTP).
    {
      const { db, close } = await createPGliteDb(PG_DATA_DIR);
      try {
        await applyMigrations(db, findMigrationsDir(ROOT));
        for (const [name, slot] of [
          ['GUI06 Live Ltd', 'a'],
          ['GUI06 Live B Ltd', 'b'],
        ] as const) {
          const seeded = await seedTenant(db, { name });
          const admin = await createTestApiKey(db, seeded, { name: 'admin key', scopes: ['admin'] });
          const catalogueWrite = await createTestApiKey(db, seeded, {
            name: 'catalogue write key',
            scopes: ['catalogue:write'],
          });
          const catalogueRead = await createTestApiKey(db, seeded, {
            name: 'catalogue read key',
            scopes: ['catalogue:read'],
          });
          const stockWrite = await createTestApiKey(db, seeded, {
            name: 'stock write key',
            scopes: ['stock:write'],
          });
          const stockRead = await createTestApiKey(db, seeded, {
            name: 'stock read key',
            scopes: ['stock:read'],
          });
          const salesRead = await createTestApiKey(db, seeded, {
            name: 'sales read key',
            scopes: ['sales:read'],
          });
          const set: TenantSet = {
            tenant: seeded,
            adminKey: admin.key,
            catalogueWriteKey: catalogueWrite.key,
            catalogueReadKey: catalogueRead.key,
            stockWriteKey: stockWrite.key,
            stockReadKey: stockRead.key,
            salesReadKey: salesRead.key,
          };
          if (slot === 'a') {
            tenant = set;
            const customer = await db
              .insertInto('customers')
              .values({
                tenant_id: seeded.tenantId,
                first_name: 'Ada',
                last_name: 'Lovelace',
                email: 'ada@example.test',
                phone: null,
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            customerId = customer.id;
            const group = await db
              .insertInto('customer_groups')
              .values({ tenant_id: seeded.tenantId, name: 'VIP Customers', description: null })
              .returning('id')
              .executeTakeFirstOrThrow();
            groupId = group.id;
          } else {
            tenantB = set;
          }
        }
      } finally {
        await close();
      }
    }

    await startApi();

    // 1. Create a warehouse over HTTP (stock:write).
    const warehouse = await apiPost(tenant, '/v1/inventory/warehouses', {
      locationId: tenant.tenant.locationId,
      name: 'Live Store',
      type: 'store',
      isDefault: false,
    });
    expect(warehouse.status, 'create the warehouse via the API').toBe(201);
    warehouseId = (expectJsonObject(warehouse).id as string | undefined) ?? '';
    expect(warehouseId, 'created warehouse has an id').not.toBe('');

    // 2. Create a supplier over HTTP (stock:write).
    const supplier = await apiPost(tenant, '/v1/purchasing/suppliers', {
      name: 'Live Wholesale',
      currency: 'GBP',
      leadTimeDays: 2,
      minOrderValuePence: '2500',
    });
    expect(supplier.status, 'create the supplier via the API').toBe(201);
    supplierId = (expectJsonObject(supplier).id as string | undefined) ?? '';
    expect(supplierId, 'created supplier has an id').not.toBe('');

    // 3. Create a product + two variants over HTTP (catalogue:write).
    const product = await apiPost(tenant, '/v1/catalogue/products', { name: 'Live GUI06 Product' });
    expect(product.status, 'create the product via the API').toBe(201);
    productId = (expectJsonObject(product).id as string | undefined) ?? '';
    expect(productId, 'created product has an id').not.toBe('');
    for (const [sku, slot] of [
      ['GUI06-001', 'a'],
      ['GUI06-002', 'b'],
    ] as const) {
      const variant = await apiPost(tenant, '/v1/catalogue/variants', {
        productId,
        sku,
        barcode: sku === 'GUI06-001' ? '5012345678905' : '5012345678906',
        name: `Live Widget ${sku}`,
        pricePence: '1000',
        costPence: '400',
        taxRateId: tenant.tenant.taxRates.standard,
      });
      expect(variant.status, `create variant ${sku} via the API`).toBe(201);
      const id = (expectJsonObject(variant).id as string | undefined) ?? '';
      expect(id, `created variant ${sku} has an id`).not.toBe('');
      if (slot === 'a') variantId = id;
      else variant2Id = id;
    }
  }, 120_000);

  afterAll(async () => {
    await stopChild(apiChild, API_PORT);
    apiChild = null;
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }, 60_000);

  it('PATCH variant: happy path updates only the supplied fields and stamps updated_at', async () => {
    const before = (await listVariants(tenant)).find((v) => v.id === variantId);
    expect(before).toBeDefined();
    expect(before?.sku).toBe('GUI06-001');
    expect(before?.price_pence).toBe('1000');
    const beforeUpdatedAt = String(before?.updated_at ?? '');
    expect(beforeUpdatedAt).not.toBe('');
    // Separate the stamps: the PATCH must stamp a LATER updated_at
    // than the create stamp (PGlite timestamps resolve to the ms).
    await sleep(15);
    const patched = await apiPatch(tenant, `/v1/catalogue/variants/${variantId}`, {
      pricePence: '1250',
      sku: 'GUI06-001B',
    });
    expect(patched.status, 'PATCH the variant').toBe(200);
    const body = expectJsonObject(patched);
    expect(body.price_pence).toBe('1250');
    expect(body.sku).toBe('GUI06-001B');
    // Unsupplied fields keep their values.
    expect(body.barcode).toBe('5012345678905');
    expect(body.cost_pence).toBe('400');
    expect(body.tax_rate_id).toBe(tenant.tenant.taxRates.standard);
    expect(body.is_active).toBe(true);
    const afterUpdatedAt = String(body.updated_at ?? '');
    expect(new Date(afterUpdatedAt).getTime()).toBeGreaterThan(new Date(beforeUpdatedAt).getTime());
  });

  it('PATCH variant: the handshake delta sees the change (since before the PATCH, not after)', async () => {
    const rows = await listVariants(tenant);
    const row = rows.find((v) => v.id === variantId);
    expect(row).toBeDefined();
    const updatedAt = String(row?.updated_at ?? '');
    expect(updatedAt).not.toBe('');
    // A delta from just BEFORE the PATCH stamp includes the variant…
    const justBefore = new Date(new Date(updatedAt).getTime() - 1).toISOString();
    const inDelta = await handshakeVariants(tenant, justBefore);
    expect(inDelta.map((v) => v.variantId)).toContain(variantId);
    // …and the PATCHED price travels with it.
    expect(inDelta.find((v) => v.variantId === variantId)?.pricePence).toBe('1250');
    // A delta from the PATCH stamp itself excludes it (updated_at > since, strictly).
    const fromStamp = await handshakeVariants(tenant, updatedAt);
    expect(fromStamp.map((v) => v.variantId)).not.toContain(variantId);
  });

  it('PATCH variant: status flips is_active; barcode clears to null', async () => {
    const inactive = await apiPatch(tenant, `/v1/catalogue/variants/${variant2Id}`, {
      status: 'inactive',
    });
    expect(inactive.status, 'PATCH status inactive').toBe(200);
    expect(expectJsonObject(inactive).is_active).toBe(false);
    const cleared = await apiPatch(tenant, `/v1/catalogue/variants/${variant2Id}`, {
      barcode: null,
      status: 'active',
    });
    expect(cleared.status, 'PATCH barcode null + status active').toBe(200);
    const clearedBody = expectJsonObject(cleared);
    expect(clearedBody.barcode).toBeNull();
    expect(clearedBody.is_active).toBe(true);
  });

  it('PATCH variant: error matrix — 401/403/400/404/409', async () => {
    // Unauthenticated → 401.
    const noAuth = await http(`${API_BASE}/v1/catalogue/variants/${variantId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pricePence: '1300' }),
    });
    expect(noAuth.status, 'unauthenticated PATCH').toBe(401);
    // Wrong scope (catalogue:read) → 403.
    const readOnly = await apiPatch(
      tenant,
      `/v1/catalogue/variants/${variantId}`,
      { pricePence: '1300' },
      tenant.catalogueReadKey,
    );
    expect(readOnly.status, 'catalogue:read-only key PATCH').toBe(403);
    // Malformed id → 400 INVALID_UUID (global interceptor).
    const malformed = await apiPatch(tenant, `/v1/catalogue/variants/${MALFORMED_ID}`, {
      pricePence: '1300',
    });
    expect(malformed.status, 'malformed id PATCH').toBe(400);
    expect((expectJsonObject(malformed).error as Record<string, unknown> | undefined)?.code).toBe(
      'INVALID_UUID',
    );
    // Cross-tenant → 404 (G-B).
    const cross = await apiPatch(
      tenantB,
      `/v1/catalogue/variants/${variantId}`,
      { pricePence: '1300' },
      tenantB.catalogueWriteKey,
    );
    expect(cross.status, 'cross-tenant PATCH').toBe(404);
    // Unknown variant → 404.
    const unknown = await apiPatch(tenant, `/v1/catalogue/variants/${UNKNOWN_UUID}`, {
      pricePence: '1300',
    });
    expect(unknown.status, 'unknown variant PATCH').toBe(404);
    // Duplicate SKU → 409; duplicate barcode → 409.
    const dupSku = await apiPatch(tenant, `/v1/catalogue/variants/${variant2Id}`, {
      sku: 'GUI06-001B',
    });
    expect(dupSku.status, 'duplicate SKU PATCH').toBe(409);
    const dupBarcode = await apiPatch(tenant, `/v1/catalogue/variants/${variant2Id}`, {
      barcode: '5012345678905',
    });
    expect(dupBarcode.status, 'duplicate barcode PATCH').toBe(409);
    // Unknown tax rate → 404; null tax rate → 400; empty body → 400;
    // bad status → 400; negative price → 400.
    const badRate = await apiPatch(tenant, `/v1/catalogue/variants/${variantId}`, {
      taxRateId: UNKNOWN_UUID,
    });
    expect(badRate.status, 'unknown tax rate PATCH').toBe(404);
    const nullRate = await apiPatch(tenant, `/v1/catalogue/variants/${variantId}`, {
      taxRateId: null,
    });
    expect(nullRate.status, 'null tax rate PATCH').toBe(400);
    const empty = await apiPatch(tenant, `/v1/catalogue/variants/${variantId}`, {});
    expect(empty.status, 'empty PATCH').toBe(400);
    const badStatus = await apiPatch(tenant, `/v1/catalogue/variants/${variantId}`, {
      status: 'archived',
    });
    expect(badStatus.status, 'bad status PATCH').toBe(400);
    const negative = await apiPatch(tenant, `/v1/catalogue/variants/${variantId}`, {
      pricePence: '-5',
    });
    expect(negative.status, 'negative price PATCH').toBe(400);
    // A cashier PIN session may not reprice (same rule as
    // updateVariantPrice) — proven at the service layer in the unit
    // tests; the scope check above is the HTTP-level proof.
  });

  it('POST purchase-orders: standalone DRAFT PO with warehouse + expected date recorded', async () => {
    const created = await apiPost(
      tenant,
      '/v1/inventory/purchase-orders',
      {
        supplierId,
        warehouseId,
        expectedDeliveryDate: '2026-12-01T00:00:00.000Z',
        lines: [
          { variantId, quantityOrdered: '10', unitCostPence: '400' },
          { variantId: variant2Id, quantityOrdered: '5', unitCostPence: '600' },
        ],
      },
      tenant.stockWriteKey,
    );
    expect(created.status, 'POST the purchase order').toBe(201);
    const body = expectJsonObject(created);
    expect(body.status).toBe('draft');
    expect(body.po_number).toBe('1');
    expect(body.location_id).toBe(tenant.tenant.locationId);
    expect(body.supplier_id).toBe(supplierId);
    expect(body.warehouse_id).toBe(warehouseId);
    expect(body.expected_delivery_date).toBe('2026-12-01T00:00:00.000Z');
    expect(body.sent_at).toBeNull();
    const lines = body.lines as Array<Record<string, unknown>> | undefined;
    expect(lines).toHaveLength(2);
    // Lines come back ordered by variant_id (the service orders the
    // read that way), not in request order — look each line up by
    // variant instead of assuming a position.
    const lineFor = (id: string): Record<string, unknown> | undefined =>
      lines?.find((l) => l.variant_id === id);
    expect(lineFor(variantId)?.quantity_ordered).toBe('10');
    expect(lineFor(variantId)?.quantity_received).toBe('0');
    expect(lineFor(variantId)?.cost_pence).toBe('400');
    expect(lineFor(variant2Id)?.quantity_ordered).toBe('5');
    expect(lineFor(variant2Id)?.cost_pence).toBe('600');
    // A second PO numbers sequentially.
    const second = await apiPost(
      tenant,
      '/v1/inventory/purchase-orders',
      {
        supplierId,
        warehouseId,
        lines: [{ variantId, quantityOrdered: '1', unitCostPence: '400' }],
      },
      tenant.stockWriteKey,
    );
    expect(second.status, 'POST the second purchase order').toBe(201);
    expect(expectJsonObject(second).po_number).toBe('2');
    expect(expectJsonObject(second).expected_delivery_date).toBeNull();
    // The list route shows both, newest first.
    const listed = await apiGet(tenant, '/v1/inventory/purchase-orders', tenant.stockReadKey);
    expect(listed.status, 'GET the purchase orders').toBe(200);
    expect(Array.isArray(listed.json)).toBe(true);
    const orders = listed.json as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(2);
    expect(orders[0]?.po_number).toBe('2');
  });

  it('POST purchase-orders: error matrix — 401/403/400/404', async () => {
    const goodBody = {
      supplierId,
      warehouseId,
      lines: [{ variantId, quantityOrdered: '10', unitCostPence: '400' }],
    };
    // Unauthenticated → 401.
    const noAuth = await http(`${API_BASE}/v1/inventory/purchase-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodBody),
    });
    expect(noAuth.status, 'unauthenticated POST PO').toBe(401);
    // Wrong scope (stock:read) → 403.
    const readOnly = await apiPost(
      tenant,
      '/v1/inventory/purchase-orders',
      goodBody,
      tenant.stockReadKey,
    );
    expect(readOnly.status, 'stock:read-only key POST PO').toBe(403);
    // Unknown supplier / warehouse / variant → 404.
    const badSupplier = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      supplierId: UNKNOWN_UUID,
    });
    expect(badSupplier.status, 'unknown supplier POST PO').toBe(404);
    const badWarehouse = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      warehouseId: UNKNOWN_UUID,
    });
    expect(badWarehouse.status, 'unknown warehouse POST PO').toBe(404);
    const badVariant = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      lines: [{ variantId: UNKNOWN_UUID, quantityOrdered: '10', unitCostPence: '400' }],
    });
    expect(badVariant.status, 'unknown variant POST PO').toBe(404);
    // Cross-tenant supplier → 404 (G-B): tenant B's key against tenant A's supplier.
    const cross = await apiPost(
      tenantB,
      '/v1/inventory/purchase-orders',
      goodBody,
      tenantB.stockWriteKey,
    );
    expect(cross.status, 'cross-tenant POST PO').toBe(404);
    // Empty lines → 400; zero quantity → 400; negative cost → 400;
    // duplicate variant in the lines → 400; bad date → 400.
    const emptyLines = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      supplierId,
      warehouseId,
      lines: [],
    });
    expect(emptyLines.status, 'empty lines POST PO').toBe(400);
    const zeroQty = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      lines: [{ variantId, quantityOrdered: '0', unitCostPence: '400' }],
    });
    expect(zeroQty.status, 'zero quantity POST PO').toBe(400);
    const negCost = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      lines: [{ variantId, quantityOrdered: '10', unitCostPence: '-1' }],
    });
    expect(negCost.status, 'negative cost POST PO').toBe(400);
    const dupVariant = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      supplierId,
      warehouseId,
      lines: [
        { variantId, quantityOrdered: '10', unitCostPence: '400' },
        { variantId, quantityOrdered: '5', unitCostPence: '400' },
      ],
    });
    expect(dupVariant.status, 'duplicate variant POST PO').toBe(400);
    const badDate = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      expectedDeliveryDate: 'not-a-date',
    });
    expect(badDate.status, 'bad date POST PO').toBe(400);
    // Malformed supplierId → 400 INVALID_UUID (global interceptor,
    // recursive body check).
    const malformed = await apiPost(tenant, '/v1/inventory/purchase-orders', {
      ...goodBody,
      supplierId: MALFORMED_ID,
    });
    expect(malformed.status, 'malformed supplierId POST PO').toBe(400);
    expect((expectJsonObject(malformed).error as Record<string, unknown> | undefined)?.code).toBe(
      'INVALID_UUID',
    );
  });

  it('POST customers/:id/groups: assignment is idempotent on repeat', async () => {
    const first = await apiPost(tenant, `/v1/crm/customers/${customerId}/groups`, {
      groupId,
    });
    expect(first.status, 'POST the group assignment').toBe(201);
    const firstBody = expectJsonObject(first);
    expect(firstBody.customer_id).toBe(customerId);
    expect(firstBody.group_id).toBe(groupId);
    expect(typeof firstBody.created_at).toBe('string');
    const second = await apiPost(tenant, `/v1/crm/customers/${customerId}/groups`, {
      groupId,
    });
    expect(second.status, 'POST the group assignment again').toBe(201);
    const secondBody = expectJsonObject(second);
    // Idempotent: the same membership, same created_at — no duplicate row.
    // (The single-row proof at the database level lives in the unit
    // tests; this test asserts the wire idempotency.)
    expect(secondBody.created_at).toBe(firstBody.created_at);
  });

  it('POST customers/:id/groups: error matrix — 401/403/400/404', async () => {
    // Unauthenticated → 401.
    const noAuth = await http(`${API_BASE}/v1/crm/customers/${customerId}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    expect(noAuth.status, 'unauthenticated POST group assignment').toBe(401);
    // Wrong scope (sales:read — the CRM reads' scope, not a write scope) → 403.
    const readOnly = await apiPost(
      tenant,
      `/v1/crm/customers/${customerId}/groups`,
      { groupId },
      tenant.salesReadKey,
    );
    expect(readOnly.status, 'sales:read-only key POST group assignment').toBe(403);
    // Malformed customer id → 400 INVALID_UUID (global interceptor).
    const malformed = await apiPost(tenant, `/v1/crm/customers/${MALFORMED_ID}/groups`, {
      groupId,
    });
    expect(malformed.status, 'malformed customer id POST group assignment').toBe(400);
    expect((expectJsonObject(malformed).error as Record<string, unknown> | undefined)?.code).toBe(
      'INVALID_UUID',
    );
    // Unknown customer → 404; unknown group → 404.
    const unknownCustomer = await apiPost(tenant, `/v1/crm/customers/${UNKNOWN_UUID}/groups`, {
      groupId,
    });
    expect(unknownCustomer.status, 'unknown customer POST group assignment').toBe(404);
    const unknownGroup = await apiPost(tenant, `/v1/crm/customers/${customerId}/groups`, {
      groupId: UNKNOWN_UUID,
    });
    expect(unknownGroup.status, 'unknown group POST group assignment').toBe(404);
    // Cross-tenant → 404 (G-B): tenant B's key against tenant A's customer.
    const cross = await apiPost(
      tenantB,
      `/v1/crm/customers/${customerId}/groups`,
      { groupId },
      tenantB.adminKey,
    );
    expect(cross.status, 'cross-tenant POST group assignment').toBe(404);
    // Missing groupId → 400.
    const missing = await apiPost(tenant, `/v1/crm/customers/${customerId}/groups`, {});
    expect(missing.status, 'missing groupId POST group assignment').toBe(400);
  });
});
