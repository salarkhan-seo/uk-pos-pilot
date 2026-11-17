/**
 * Real-PostgreSQL G-A-13 concurrency check (Build-04, Objective 3).
 *
 * Proves the Arch-05 G-A-13 acceptance test — two registers selling the
 * last unit of a variant at the same time — against a LIVE multi-
 * connection PostgreSQL daemon, which PGlite cannot do (PGlite runs on
 * a single connection, so its FOR UPDATE locks never contend; see
 * README "PGlite honest limits" and the G-A-13 gate test in
 * apps/api/test/gates/gates.test.ts).
 *
 * What this script does (live mode, the default):
 *   1. Connects to PostgreSQL via the `pg` driver (Pool, max 5
 *      connections) using DATABASE_URL. The int8 type parser is set
 *      with `types.setTypeParser(20, BigInt)` per the Build-02 finding
 *      — without it, bigint columns come back as strings/numbers and
 *      the assertions below compare the wrong types.
 *   2. Applies every migration in packages/db/migrations/ (idempotent;
 *      already-applied files are skipped by the runner).
 *   3. Seeds one tenant, one variant, exactly 1 unit of stock, and two
 *      draft orders (one per "register").
 *   4. Runs the two sale decrements CONCURRENTLY (Promise.allSettled
 *      over two Kysely transactions, which the pg Pool serves from two
 *      separate connections — this is the true contention PGlite cannot
 *      provide). Each decrement runs the SAME locking code path as
 *      InventoryService.decrementStockForOrder: SELECT ... FOR UPDATE on
 *      stock_balances, availability checked INSIDE the lock, then the
 *      'sale' movement + balance update in the same transaction.
 *   5. Asserts: exactly one decrement succeeds; the other fails with
 *      InsufficientStock (available 0, requested 1); no negative stock
 *      (balance 0); exactly one 'sale' movement; the failed order is
 *      still 'draft' with no tender, no payment attempt and no receipt.
 *
 * Exit codes: 0 = G-A-13 PASSED against live PostgreSQL; 1 = any
 * assertion failed, or the database could not be reached. The script
 * NEVER silently falls back to PGlite in live mode: if DATABASE_URL is
 * unset or the connection fails, it prints a clear error and exits 1.
 *
 * `--smoke` mode: runs the SAME seed + assertions against PGlite
 * (createTestDb) with the two decrements run SEQUENTIALLY. This
 * verifies the script's SQL and assertion logic in an environment
 * with no PostgreSQL at all. It is CLEARLY LABELLED as the PGlite
 * equivalent in its output and is NOT a live run — it proves the
 * outcome under serialised execution only, exactly like the G-A-13
 * gate test. Use it to validate the script, never to claim G-A-13
 * passed against real PostgreSQL.
 *
 * Run:
 *   # Live (needs Docker or any reachable PostgreSQL 16):
 *   docker compose up -d   # from the repo root; Postgres on :5433
 *   DATABASE_URL=postgres://ukpos:ukpos-dev-only@localhost:5433/ukpos_pilot \
 *     pnpm --filter @uk-pos/db concurrency:live
 *   # Smoke (no Docker, no PostgreSQL needed):
 *   pnpm --filter @uk-pos/db concurrency:smoke
 *
 * The pnpm scripts build the package first (tsc) and run the compiled
 * dist/pg-concurrency-check.js with node — no tsx or
 * --experimental-strip-types is needed. The script is a standalone
 * check, not part of the vitest suites: it needs a live database, so
 * it must never run as part of `pnpm test`.
 *
 * HONEST LIMIT: this script proves the DECREMENT contention (the
 * locking code path), not the full SalesService checkout — the full
 * checkout (tenders, receipts, order completion) is proven by the
 * G-A-13 gate test in apps/api/test/gates/gates.test.ts, which runs
 * sequentially on PGlite. A live end-to-end checkout race through the
 * service layer still needs the API pointed at live PostgreSQL.
 */
import { Pool, types } from 'pg';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { applyMigrations } from './migrate';
import { createTestDb, findMigrationsDir } from './pglite';
import type { DB } from './schema';
import { seedTenant, seedVariant, setStock, type SeededTenant } from './testing';

/** Mirrors InventoryService.InsufficientStockError (apps/api) — same fields, same message shape. */
export class InsufficientStockError extends Error {
  readonly variantId: string;
  readonly available: bigint;
  readonly requested: bigint;

  constructor(variantId: string, available: bigint, requested: bigint) {
    super(
      `Insufficient stock for variant ${variantId}: available ${available.toString()}, requested ${requested.toString()}`,
    );
    this.name = 'InsufficientStockError';
    this.variantId = variantId;
    this.available = available;
    this.requested = requested;
  }
}

function fail(message: string): never {
  throw new Error(`G-A-13 CHECK FAILED: ${message}`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    fail(message);
  }
}

/**
 * One sale decrement through the production locking path:
 * SELECT ... FOR UPDATE on the balance row, availability checked inside
 * the lock, then the 'sale' movement + balance update in the same
 * transaction. Returns whether a granted RowShareLock was held while
 * the row was locked (the lock-held proof from the G-A-13 gate test).
 */
async function attemptSaleDecrement(
  db: Kysely<DB>,
  tenant: SeededTenant,
  variantId: string,
  orderId: string,
): Promise<{ lockHeld: boolean }> {
  return db.transaction().execute(async (trx: Transaction<DB>) => {
    const row = await trx
      .selectFrom('stock_balances')
      .selectAll()
      .where('variant_id', '=', variantId)
      .where('warehouse_id', '=', tenant.warehouseId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // Lock-held proof: a plain SELECT takes only AccessShareLock, while
    // SELECT ... FOR UPDATE takes RowShareLock on this backend.
    const locks = await sql<{ held: string }>`
      SELECT COUNT(*)::text AS held FROM pg_locks
      WHERE locktype = 'relation' AND mode = 'RowShareLock'
        AND granted AND pid = pg_backend_pid()
    `.execute(trx);
    const lockHeld = Number(locks.rows[0]?.held ?? '0') > 0;
    if (row.quantity_on_hand < 1n) {
      throw new InsufficientStockError(variantId, row.quantity_on_hand, 1n);
    }
    await trx
      .insertInto('stock_movements')
      .values({
        tenant_id: tenant.tenantId,
        variant_id: variantId,
        warehouse_id: tenant.warehouseId,
        location_id: tenant.locationId,
        cause: 'sale',
        quantity_change: -1n,
        quantity_in_base_units: -1n,
        unit_id: null,
        cost_pence_at_movement: null,
        order_id: orderId,
        reference_id: null,
        reference_type: null,
        created_by_user_id: tenant.users.manager.id,
      })
      .execute();
    await trx
      .updateTable('stock_balances')
      .set({ quantity_on_hand: row.quantity_on_hand - 1n })
      .where('variant_id', '=', variantId)
      .where('warehouse_id', '=', tenant.warehouseId)
      .execute();
    return { lockHeld };
  });
}

async function balanceOf(db: Kysely<DB>, variantId: string, warehouseId: string): Promise<bigint> {
  const row = await db
    .selectFrom('stock_balances')
    .select('quantity_on_hand')
    .where('variant_id', '=', variantId)
    .where('warehouse_id', '=', warehouseId)
    .executeTakeFirstOrThrow();
  return row.quantity_on_hand;
}

/** Seed one tenant + one variant with exactly 1 unit, plus two draft orders. */
async function seedLastUnitScenario(
  db: Kysely<DB>,
): Promise<{ tenant: SeededTenant; variantId: string; orderAId: string; orderBId: string }> {
  const tenant = await seedTenant(db);
  const variant = await seedVariant(db, tenant);
  await setStock(db, tenant, variant.variantId, { quantity: 1n });
  const businessDate = new Date().toISOString().slice(0, 10);
  const orderA = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      register_id: tenant.registerId,
      customer_id: null,
      order_number: 1n,
      business_date: businessDate,
      status: 'draft',
      subtotal_pence: 1000n,
      discount_pence: 0n,
      tax_pence: 0n,
      total_pence: 1000n,
      created_by_user_id: tenant.users.manager.id,
      completed_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const orderB = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      register_id: tenant.registerId,
      customer_id: null,
      order_number: 2n,
      business_date: businessDate,
      status: 'draft',
      subtotal_pence: 1000n,
      discount_pence: 0n,
      tax_pence: 0n,
      total_pence: 1000n,
      created_by_user_id: tenant.users.manager.id,
      completed_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { tenant, variantId: variant.variantId, orderAId: orderA.id, orderBId: orderB.id };
}

/**
 * Run the two decrements and assert the G-A-13 outcome. When
 * `concurrent` is true the attempts race on two pool connections
 * (live mode); when false they run one after the other (smoke mode —
 * PGlite serialises them anyway).
 */
async function runGa13Check(
  db: Kysely<DB>,
  label: string,
  concurrent: boolean,
): Promise<void> {
  const { tenant, variantId, orderAId, orderBId } = await seedLastUnitScenario(db);
  console.log(`[${label}] seeded 1 unit of stock; two draft orders (${orderAId}, ${orderBId})`);

  const attemptA = () => attemptSaleDecrement(db, tenant, variantId, orderAId);
  const attemptB = () => attemptSaleDecrement(db, tenant, variantId, orderBId);
  const results = concurrent
    ? await Promise.allSettled([attemptA(), attemptB()])
    : [await attemptA().then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ), await attemptB().then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )];

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert(succeeded.length === 1, `expected exactly 1 sale to succeed, got ${succeeded.length}`);
  assert(failed.length === 1, `expected exactly 1 sale to fail, got ${failed.length}`);
  const failure = (failed[0] as { reason: unknown }).reason;
  assert(
    failure instanceof InsufficientStockError,
    `failed sale must throw InsufficientStockError, got ${failure instanceof Error ? failure.message : String(failure)}`,
  );
  const insufficient = failure as InsufficientStockError;
  assert(insufficient.variantId === variantId, 'failed sale must name the contested variant');
  assert(insufficient.available === 0n, `failed sale must see 0 available, saw ${insufficient.available.toString()}`);
  assert(insufficient.requested === 1n, `failed sale must request 1, saw ${insufficient.requested.toString()}`);
  const winner = (succeeded[0] as { value: { lockHeld: boolean } }).value;
  assert(winner.lockHeld, 'winning decrement must have held a RowShareLock (FOR UPDATE proof)');

  // No negative stock; exactly one 'sale' movement for the last unit.
  const balance = await balanceOf(db, variantId, tenant.warehouseId);
  assert(balance === 0n, `balance must be 0 after the last unit sells, saw ${balance.toString()}`);
  const saleMovements = await db
    .selectFrom('stock_movements')
    .select('id')
    .where('variant_id', '=', variantId)
    .where('cause', '=', 'sale')
    .execute();
  assert(saleMovements.length === 1, `expected exactly 1 'sale' movement, got ${saleMovements.length}`);

  // The failed order is not completed and holds no tender, no payment
  // attempt and no receipt (nothing left pending to chase).
  const failedOrderId = results[0]?.status === 'rejected' ? orderAId : orderBId;
  const failedOrder = await db
    .selectFrom('orders')
    .select('status')
    .where('id', '=', failedOrderId)
    .executeTakeFirstOrThrow();
  assert(failedOrder.status === 'draft', `failed order must stay 'draft', is '${failedOrder.status}'`);
  const failedTenders = await db
    .selectFrom('order_tenders')
    .select('id')
    .where('order_id', '=', failedOrderId)
    .execute();
  assert(failedTenders.length === 0, `failed order must hold no tenders, has ${failedTenders.length}`);
  const failedAttempts = await db
    .selectFrom('payment_attempts')
    .select('id')
    .where('order_id', '=', failedOrderId)
    .execute();
  assert(failedAttempts.length === 0, `failed order must hold no payment attempts, has ${failedAttempts.length}`);
  const failedReceipts = await db
    .selectFrom('receipts')
    .select('id')
    .where('order_id', '=', failedOrderId)
    .execute();
  assert(failedReceipts.length === 0, `failed order must hold no receipt, has ${failedReceipts.length}`);

  console.log(
    `[${label}] G-A-13 PASSED: 1 succeeded, 1 failed cleanly (available 0), ` +
      `balance 0, exactly 1 'sale' movement, failed order still draft with no tender/attempt/receipt.`,
  );
}

async function runLive(databaseUrl: string): Promise<void> {
  // The Build-02 finding, applied: int8 (oid 20) must parse to BigInt,
  // or every bigint column comes back as a string/number.
  types.setTypeParser(20, BigInt);
  const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  try {
    // Fail fast with a clear message — never fall through to PGlite.
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Cannot connect to PostgreSQL at DATABASE_URL: ${message}`);
      console.error('Start it first (repo root: docker compose up -d), then re-run.');
      process.exitCode = 1;
      return;
    }
    const serverVersion = await pool.query<{ version: string }>('SELECT version() AS version');
    console.log(`[live] connected: ${(serverVersion.rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ')}`);
    const applied = await applyMigrations(db, findMigrationsDir());
    console.log(`[live] migrations applied: ${applied.length === 0 ? '(none — already up to date)' : applied.join(', ')}`);
    await runGa13Check(db, 'live', true);
  } finally {
    await db.destroy();
    await pool.end();
  }
}

async function runSmoke(): Promise<void> {
  console.log('[smoke] PGlite equivalent — NOT a live-PostgreSQL run (see file header).');
  const { db, close } = await createTestDb();
  try {
    await runGa13Check(db, 'smoke', false);
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--smoke')) {
    await runSmoke();
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    console.error(
      'DATABASE_URL is not set. Live mode needs a real PostgreSQL connection string, e.g.\n' +
        '  DATABASE_URL=postgres://ukpos:ukpos-dev-only@localhost:5433/ukpos_pilot pnpm --filter @uk-pos/db concurrency:live\n' +
        'Refusing to fall back to PGlite in live mode. For a PGlite check of the script logic, run:\n' +
        '  pnpm --filter @uk-pos/db concurrency:smoke',
    );
    process.exitCode = 1;
    return;
  }
  await runLive(databaseUrl);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
