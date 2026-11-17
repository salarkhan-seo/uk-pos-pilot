/**
 * Demo-seed CLI (Build-08, Objective 3): `pnpm --filter @uk-pos/db seed:demo`.
 *
 * Opens a PGlite database (file-backed), applies every migration, then
 * runs the idempotent demo seeder (packages/db/src/demo-seed.ts) and
 * prints the demo identity — tenant/location/register ids, demo PINs,
 * and the shell env vars — so an operator can point the UI shells at
 * the seeded database by hand.
 *
 * Data directory: PGLITE_DATA_DIR when set, otherwise
 * `<repo-root>/data/pglite` (the repo root is found by walking up from
 * the current directory until packages/db/migrations exists, the same
 * way findMigrationsDir does). The directory is created when missing.
 *
 * PGlite holds a lock on the directory: stop the API first if it is
 * running against the same directory, or the open fails with a lock
 * error — the message below says so plainly instead of crashing with
 * a bare stack trace. For the in-process path (no separate step),
 * boot the API with DEMO_SEED_ON_BOOT=true instead.
 */
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { applyMigrations, createPGliteDb, findMigrationsDir, seedDemo } from './index';

function findRepoRoot(startDir: string = process.cwd()): string {
  const migrationsDir = findMigrationsDir(startDir);
  // <repo-root>/packages/db/migrations
  return dirname(dirname(dirname(migrationsDir)));
}

async function main(): Promise<void> {
  const dataDir = process.env.PGLITE_DATA_DIR ?? join(findRepoRoot(), 'data', 'pglite');
  mkdirSync(dataDir, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`Demo seed: opening PGlite at ${dataDir}`);
  let tdb;
  try {
    tdb = await createPGliteDb(dataDir);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      'Demo seed: could not open the PGlite directory — is the API already running against it? ' +
        'PGlite holds a lock; stop the server first, then re-run. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    await applyMigrations(tdb.db, findMigrationsDir());
    const result = await seedDemo(tdb.db);
    // eslint-disable-next-line no-console
    console.log('Demo seed: done (idempotent — safe to re-run).');
    // eslint-disable-next-line no-console
    console.log(`  Tenant:   ${result.tenantId} (Demo Retail Ltd)`);
    // eslint-disable-next-line no-console
    console.log(`  Location: ${result.locationId} (Demo High Street)`);
    // eslint-disable-next-line no-console
    console.log(`  Register: ${result.registerId} (TILL-01)`);
    // eslint-disable-next-line no-console
    console.log(`  Open session: ${result.sessionId} (float £50.00)`);
    // eslint-disable-next-line no-console
    console.log('  Demo PINs: manager 2468, cashier 1234, owner/admin 1234');
    // eslint-disable-next-line no-console
    console.log('  Demo API key: see DEMO_API_KEY in packages/db/src/demo-seed.ts (demo only).');
    // eslint-disable-next-line no-console
    console.log('  Shell env (or boot the shells with DEMO_SEED_ON_BOOT=true instead):');
    // eslint-disable-next-line no-console
    console.log(`    REGISTER_API_BASE_URL=http://localhost:3127 REGISTER_TENANT_ID=${result.tenantId} \\`);
    // eslint-disable-next-line no-console
    console.log(`      REGISTER_LOCATION_ID=${result.locationId} REGISTER_REGISTER_ID=${result.registerId}`);
    // eslint-disable-next-line no-console
    console.log(`    ADMIN_API_BASE_URL=http://localhost:3127 ADMIN_TENANT_ID=${result.tenantId} \\`);
    // eslint-disable-next-line no-console
    console.log(`      ADMIN_LOCATION_ID=${result.locationId}`);
  } finally {
    await tdb.close();
  }
}

void main();
