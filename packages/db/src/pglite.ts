/**
 * PGlite driver for @uk-pos/db (Build-02, Objective 1).
 *
 * There is no local PostgreSQL server in this environment (no initdb /
 * pg_ctl / psql), so the test/local driver is @electric-sql/pglite —
 * compiled WASM PostgreSQL supporting full DDL, PL/pgSQL triggers and
 * transactional locking. The same Kysely instance type is used against a
 * real PostgreSQL server in production (D-03 Option A); only the dialect
 * changes, never the queries.
 *
 * Two honest limits of PGlite, recorded here and in the README:
 *  - PGlite runs on a single connection: concurrent transactions are
 *    serialised by the driver queue. A test that runs two transactions
 *    "at the same time" therefore proves the OUTCOME (one succeeds, one
 *    fails cleanly, no negative stock) under serialised execution — true
 *    lock-contention behaviour must be re-verified against real
 *    PostgreSQL before the pilot goes live.
 *  - PGlite is the local/test engine only. It is not a deployment target.
 */
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from './schema';
import { applyMigrations } from './migrate';
import { PGliteDialect } from './pglite-dialect';

export interface TestDatabase {
  db: Kysely<DB>;
  pglite: PGlite;
  close(): Promise<void>;
}

/**
 * Find the migrations directory by walking up from `startDir` until
 * `packages/db/migrations` exists. Works no matter which workspace
 * directory the tests (or the API) run from.
 */
export function findMigrationsDir(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'packages', 'db', 'migrations');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find packages/db/migrations above ${startDir}`);
    }
    dir = parent;
  }
}

/**
 * Create a Kysely instance backed by an in-memory PGlite engine.
 *
 * The dialect is the local one in ./pglite-dialect.ts (not kysely-pglite's
 * bundled driver): it converts int8 columns to JS `bigint` on read, which
 * is what the Kysely schema types promise (D-13). See that file for the
 * full explanation.
 */
export async function createPGliteDb(dataDir?: string): Promise<TestDatabase> {
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
  const db = new Kysely<DB>({ dialect: new PGliteDialect(pglite) });
  return {
    db,
    pglite,
    close: async () => {
      await db.destroy();
      // db.destroy() already closes the underlying PGlite client via the
      // local dialect driver; a second close throws "PGlite is closed".
      try {
        await pglite.close();
      } catch {
        // Already closed by the driver — nothing left to do.
      }
    },
  };
}

/**
 * Create a fresh in-memory database and apply every migration in filename
 * order (001–008, plus any later Build-02 fix files). Used by every
 * integration test in this package and by the API service tests.
 *
 * The migrations directory is found by walking up from the current
 * working directory (see findMigrationsDir) — no import.meta is used
 * here, so this file typechecks under the workspace's CommonJS config.
 */
export async function createTestDb(migrationsDir: string = findMigrationsDir()): Promise<TestDatabase> {
  const tdb = await createPGliteDb();
  await applyMigrations(tdb.db, migrationsDir);
  return tdb;
}
