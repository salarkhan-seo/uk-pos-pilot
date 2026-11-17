/**
 * DatabaseModule (Build-02) — provides the Kysely instance for the API.
 *
 * Build-13: the factory is selected from the environment, in this order:
 *   1. DATABASE_URL set (non-empty) → real `pg` Pool-backed Kysely
 *      (createPgDb from @uk-pos/db), pending migrations (001–019)
 *      applied on boot. DATABASE_URL wins over PGLITE_DATA_DIR: it is
 *      the explicit staging/production signal, and silently using the
 *      local file database instead would hide a broken staging deploy.
 *      A malformed or unreachable DATABASE_URL fails the boot loudly
 *      (createPgDb throws a DATABASE_URL error) — never a silent
 *      fallback to PGlite.
 *   2. PGLITE_DATA_DIR set → file-backed PGlite (Build-06).
 *   3. Otherwise → in-memory PGlite (createTestDb, migrations applied).
 *
 * Build-06 Objective 4: when PGLITE_DATA_DIR is set, the database is
 * FILE-BACKED at that directory instead of in-memory, so a seed step
 * (or a test process) and the API server process can share one
 * database: the seeder writes the data, closes, and the server opens
 * the same directory. Migrations are idempotent (applyMigrations
 * records applied filenames and never applies one twice), so booting
 * against an already-seeded directory only opens it. Never point two
 * processes at the same directory at once — PGlite holds a lock and
 * the second open fails; stop the server before re-opening the
 * directory from another process.
 *
 * The module is @Global: every feature module injects DATABASE without
 * importing this module.
 */
import { Global, Module } from '@nestjs/common';
import {
  applyMigrations,
  createPgDb,
  createPGliteDb,
  createTestDb,
  findMigrationsDir,
  seedDemo,
} from '@uk-pos/db';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from './database';

/**
 * Build the API's Kysely instance from the environment (Build-13).
 *
 * Exported so the factory-selection test can drive it without booting
 * Nest — vitest cannot boot a Nest app (esbuild emits no decorator
 * metadata; see the uuid-validation test header). The useFactory below
 * calls exactly this function, so the test proves the production path.
 */
export async function createApiDatabase(): Promise<Kysely<DB>> {
  const databaseUrl = process.env.DATABASE_URL;
  let db: Kysely<DB>;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
    const created = await createPgDb(databaseUrl);
    await applyMigrations(created.db, findMigrationsDir());
    db = created.db;
  } else {
    const dataDir = process.env.PGLITE_DATA_DIR;
    if (dataDir !== undefined && dataDir !== '') {
      const created = await createPGliteDb(dataDir);
      await applyMigrations(created.db, findMigrationsDir());
      db = created.db;
    } else {
      const created = await createTestDb();
      db = created.db;
    }
  }
  // Build-08 Objective 3: DEMO_SEED_ON_BOOT=true seeds the demo
  // tenant/catalogue/session (idempotent) before the server
  // starts serving. The flag is the gate — it is off unless
  // explicitly set to the string 'true', so production boots
  // never seed. The seeder is safe to re-run on every boot.
  // Identical in the pg and PGlite paths.
  if (process.env.DEMO_SEED_ON_BOOT === 'true') {
    const seeded = await seedDemo(db);
    // eslint-disable-next-line no-console
    console.log(
      `Demo seed on boot: tenant ${seeded.tenantId}, register ${seeded.registerId}, ` +
        `open session ${seeded.sessionId} (demo PINs: manager 2468, cashier 1234)`,
    );
  }
  return db;
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: async (): Promise<Kysely<DB>> => createApiDatabase(),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
