/**
 * Real PostgreSQL (`pg` Pool) driver for @uk-pos/db (Build-13).
 *
 * This is the ONE place the production `pg` connection lives. The API's
 * database module (apps/api/src/database/database.module.ts) calls
 * `createPgDb(DATABASE_URL)` when DATABASE_URL is set; everything else
 * (local/test) keeps using the PGlite factories in ./pglite.ts. The
 * queries never change, only the dialect — and the int8 → bigint rule
 * from the PGlite dialect is reproduced here with
 * `types.setTypeParser(20, BigInt)`, exactly as pg-concurrency-check.ts
 * already does for the live G-A-13 run. (That call mutates pg's global
 * type registry for the whole process; there is no per-pool equivalent,
 * and every pg client in this repo wants int8 as bigint.)
 *
 * SSL — verified against the INSTALLED pg 8.23.1 / pg-connection-string
 * 2.14.1 by direct node checks, not assumed (Build-13):
 *  - `pg` merges a connection string with
 *    `Object.assign({}, config, parse(connectionString))`: the PARSED
 *    string WINS over explicitly passed options. Passing the raw
 *    DATABASE_URL plus an explicit `ssl` therefore does NOT work —
 *    pg's own parse of `sslmode=require` yields `ssl: {}` and silently
 *    overwrites the explicit value (proven: unstripped
 *    `sslmode=verify-full` + explicit `{ rejectUnauthorized: true }`
 *    came back as `{}`). So this factory STRIPS the ssl-related query
 *    params it translates (sslmode, ssl, sslcert, sslkey, sslrootcert)
 *    from the string it hands to the Pool, and passes them as explicit
 *    options instead. Every other query param passes through untouched.
 *  - pg's default parse of `sslmode=require` is `ssl: {}` — SSL on,
 *    certificate verified against Node's default CA store — plus a
 *    once-per-process deprecation warning that in pg v9 these modes
 *    will adopt libpq semantics. This factory pins libpq semantics
 *    explicitly TODAY, so the behaviour does not change under a pg
 *    major upgrade:
 *      disable     → ssl: false (plaintext)
 *      prefer      → ssl: { rejectUnauthorized: false } (libpq would
 *                    fall back to plaintext; pg has no fallback, so
 *                    prefer behaves as require here)
 *      require     → ssl: { rejectUnauthorized: false } (encryption
 *                    required, certificate not verified — exactly what
 *                    libpq `require` means; NOT a downgrade of the
 *                    requested mode, and NOT pg's implicit verify-full)
 *      verify-ca   → ssl: { rejectUnauthorized: true } (verify against
 *                    the CA store; sslrootcert, if given, is read and
 *                    used as `ca`)
 *      verify-full → ssl: { rejectUnauthorized: true } (Node's TLS
 *                    stack also verifies the hostname by default)
 *    When no sslmode (and no ssl/sslcert/sslkey/sslrootcert) is in the
 *    URL, no `ssl` key is set at all and pg's default applies (no SSL).
 *    The stripped string also means pg's parse never sees sslmode, so
 *    its deprecation warning does not fire on boot.
 *
 * Pool shape (max 5, 5s connect timeout) is the same as the live G-A-13
 * runner (pg-concurrency-check.ts).
 *
 * Public-type boundary (Build-13 fix): this module's EXPORTED types
 * deliberately do not name any `pg` type. `buildPgPoolOptions` returns
 * the local `PgPoolOptions` interface and `PgDatabase` exposes only
 * `db` + `close()` (the Pool itself is an implementation detail — no
 * caller outside this file needs it). Reason, proven by experiment:
 * when `pg.ts` was exported with `Pool`/`PoolConfig` in its public
 * types, `@uk-pos/db`'s .d.ts pulled `@types/pg` into every consumer's
 * program, and `apps/register-app`'s typecheck broke with AbortSignal /
 * fetch overload mismatches in files this build never touched (14
 * errors; 0 errors with the pg export removed from the db dist).
 * Keeping `pg` out of the public types keeps the factory usable from
 * every package without perturbing their type environment. The runtime
 * still uses `pg` — only the declarations are decoupled.
 */
import { readFileSync } from 'node:fs';
import { Pool, types } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './schema';

/** TLS options this factory ever sets on the pool (subset of tls.ConnectionOptions). */
export interface PgSslOptions {
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

/**
 * Pool options this factory builds. Deliberately NOT `pg`'s PoolConfig
 * (see the file header: naming a `pg` type here would pull @types/pg
 * into every consumer's program). Structurally assignable to PoolConfig.
 */
export interface PgPoolOptions {
  connectionString: string;
  ssl?: boolean | PgSslOptions;
  max: number;
  connectionTimeoutMillis: number;
}

export interface PgDatabase {
  db: Kysely<DB>;
  close(): Promise<void>;
}

const SSL_MODES: ReadonlySet<string> = new Set([
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);

const SSL_PARAMS: readonly string[] = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert'];

type SslOptions = boolean | PgSslOptions;

/** Read an sslcert/sslkey/sslrootcert file, or fail closed naming the param. */
function readSslFile(path: string, param: string): string {
  try {
    return readFileSync(path).toString();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DATABASE_URL ${param} file could not be read ('${path}'): ${detail}`);
  }
}

/** Attach cert/key/ca material from the URL's ssl* params, if any are present. */
function attachSslFiles(url: URL, ssl: Record<string, unknown>): void {
  const rootCert = url.searchParams.get('sslrootcert');
  if (rootCert !== null) {
    ssl.ca = readSslFile(rootCert, 'sslrootcert');
  }
  const cert = url.searchParams.get('sslcert');
  if (cert !== null) {
    ssl.cert = readSslFile(cert, 'sslcert');
  }
  const key = url.searchParams.get('sslkey');
  if (key !== null) {
    ssl.key = readSslFile(key, 'sslkey');
  }
}

/**
 * Translate the URL's ssl-related query params into the `ssl` pool
 * option. Throws a DATABASE_URL error on any value this factory does
 * not understand, instead of guessing.
 */
function buildSslOption(url: URL): SslOptions {
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null) {
    if (!SSL_MODES.has(sslmode)) {
      throw new Error(
        `DATABASE_URL has unsupported sslmode='${sslmode}' ` +
          `(expected one of disable, prefer, require, verify-ca, verify-full)`,
      );
    }
    if (sslmode === 'disable') {
      return false;
    }
    // prefer / require: encryption required, no certificate verification
    // (libpq semantics — see the file header). verify-ca / verify-full:
    // verify against the CA store.
    const ssl: Record<string, unknown> = {
      rejectUnauthorized: sslmode === 'verify-ca' || sslmode === 'verify-full',
    };
    attachSslFiles(url, ssl);
    return ssl as SslOptions;
  }
  const sslParam = url.searchParams.get('ssl');
  if (sslParam !== null) {
    if (sslParam === 'true' || sslParam === '1') {
      return true;
    }
    if (sslParam === '0') {
      return false;
    }
    if (sslParam === 'no-verify') {
      return { rejectUnauthorized: false };
    }
    throw new Error(
      `DATABASE_URL has unsupported ssl='${sslParam}' (expected true, 1, 0 or no-verify)`,
    );
  }
  // Certificate params with no sslmode/ssl: mirror pg — SSL on, using
  // the given material.
  const ssl: Record<string, unknown> = {};
  attachSslFiles(url, ssl);
  return ssl as SslOptions;
}

/**
 * Build the `pg` Pool options for a DATABASE_URL connection string.
 *
 * Pure function (no connection is opened), so the sslmode mapping is
 * unit-testable without a live server. The returned `connectionString`
 * has the ssl-related query params stripped (see the file header: pg's
 * own parse would otherwise overwrite the explicit `ssl` option);
 * every other param is passed through untouched.
 */
export function buildPgPoolOptions(connectionString: string): PgPoolOptions {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `DATABASE_URL must use the postgres:// or postgresql:// scheme (got '${url.protocol}')`,
    );
  }
  const hasSslParams = SSL_PARAMS.some((param) => url.searchParams.get(param) !== null);
  const options: PgPoolOptions = {
    connectionString,
    // Same pool shape as the live G-A-13 runner (pg-concurrency-check.ts).
    max: 5,
    connectionTimeoutMillis: 5000,
  };
  if (hasSslParams) {
    options.ssl = buildSslOption(url);
    const stripped = new URL(connectionString);
    for (const param of SSL_PARAMS) {
      stripped.searchParams.delete(param);
    }
    options.connectionString = stripped.toString();
  }
  return options;
}

/**
 * Create a Kysely instance backed by a real `pg` Pool for the given
 * DATABASE_URL, and prove the server is reachable before returning.
 *
 * Fails closed: when the server cannot be reached (wrong host, refused
 * connection, bad credentials, TLS failure) the pool is ended and a
 * `DATABASE_URL connection failed` error is thrown — the caller must
 * NOT fall back to PGlite, or a broken staging deploy would silently
 * run against an empty in-memory database. Migrations are NOT applied
 * here (the caller does that, as the PGlite path does); the probe is a
 * bare `SELECT 1` so a database that has not been migrated yet still
 * proves reachability.
 */
export async function createPgDb(connectionString: string): Promise<PgDatabase> {
  // Same int8 → bigint rule as the PGlite dialect and the live G-A-13
  // runner: without it every money/stock bigint column reads back as a
  // string and `row.quantity_on_hand - 1n` throws at runtime.
  types.setTypeParser(20, BigInt);
  const pool = new Pool(buildPgPoolOptions(connectionString));
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DATABASE_URL connection failed: ${detail} — the API will not fall back to PGlite.`,
    );
  }
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    close: async () => {
      await db.destroy();
      await pool.end();
    },
  };
}
