/**
 * Build-13 — DATABASE_URL factory selection + sslmode=require parsing.
 *
 * Proves, with NO live PostgreSQL server and NO network access:
 *  (a) DATABASE_URL factory selection — with DATABASE_URL set to a
 *      dead-local/unreachable value the factory attempts a real `pg`
 *      connection and fails closed with a clear DATABASE_URL error
 *      (never PGlite); DATABASE_URL also wins over PGLITE_DATA_DIR.
 *  (b) sslmode=require parsing — the connection options the factory
 *      builds from a `sslmode=require` URL carry SSL enabled with
 *      libpq `require` semantics, asserted on the parsed/constructed
 *      options AND on a real `pg` Client's derived connection
 *      parameters (which is where pg's own merge could have silently
 *      overwritten them — see packages/db/src/pg.ts).
 *  (c) With DATABASE_URL unset the factory still returns the
 *      PGlite-backed instance (existing behaviour — it boots and runs
 *      a trivial query).
 *
 * What this does NOT prove (stated honestly): the pg path against a
 * live Neon/Supabase database — no live DATABASE_URL exists in this
 * environment. The live proof is `pnpm staging:check` (migrations +
 * live G-A-13) once the owner creates the cloud database.
 *
 * `pg` is a dependency of @uk-pos/db, not of apps/api, so the Client
 * used for the merge proof is resolved through the db package's own
 * require (createRequire from its package.json). Constructing a
 * Client opens no connection.
 */
import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { buildPgPoolOptions, createPgDb } from '@uk-pos/db';
import { createApiDatabase } from '../../src/database/database.module';

type PgClientCtor = new (config: unknown) => {
  connectionParameters: { ssl: unknown };
};
const dbRequire = createRequire(
  new URL('../../../packages/db/package.json', import.meta.url).pathname,
);
const { Client } = dbRequire('pg') as { Client: PgClientCtor };

const DEAD_URL = 'postgresql://127.0.0.1:1/ukpos_test?sslmode=disable';
const DEAD_SSL_URL = 'postgresql://127.0.0.1:1/ukpos_test?sslmode=require';

describe('buildPgPoolOptions — sslmode parsing (no connection opened)', () => {
  it('sslmode=require → ssl { rejectUnauthorized: false } (libpq require semantics)', () => {
    const options = buildPgPoolOptions(
      'postgresql://user:pass@db.example.eu-west-2.neon.tech:5432/ukpos?sslmode=require&application_name=uk-pos-api',
    );
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
    // The sslmode param is stripped from the string handed to pg (its
    // own parse would otherwise overwrite the explicit ssl option);
    // every other param passes through untouched.
    expect(options.connectionString).not.toContain('sslmode');
    expect(options.connectionString).toContain('application_name=uk-pos-api');
  });

  it('sslmode=disable → ssl false', () => {
    const options = buildPgPoolOptions('postgresql://127.0.0.1:5432/ukpos?sslmode=disable');
    expect(options.ssl).toBe(false);
    expect(options.connectionString).not.toContain('sslmode');
  });

  it('sslmode=verify-full → ssl { rejectUnauthorized: true }', () => {
    const options = buildPgPoolOptions('postgresql://127.0.0.1:5432/ukpos?sslmode=verify-full');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('sslmode=verify-ca → ssl { rejectUnauthorized: true }', () => {
    const options = buildPgPoolOptions('postgresql://127.0.0.1:5432/ukpos?sslmode=verify-ca');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('sslmode=prefer → ssl { rejectUnauthorized: false } (pg has no plaintext fallback)', () => {
    const options = buildPgPoolOptions('postgresql://127.0.0.1:5432/ukpos?sslmode=prefer');
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('no sslmode → no ssl key, connection string untouched', () => {
    const url = 'postgresql://127.0.0.1:5432/ukpos';
    const options = buildPgPoolOptions(url);
    expect('ssl' in options).toBe(false);
    expect(options.connectionString).toBe(url);
  });

  it('unknown sslmode fails closed with a DATABASE_URL error', () => {
    expect(() => buildPgPoolOptions('postgresql://127.0.0.1:5432/ukpos?sslmode=bogus')).toThrow(
      /DATABASE_URL.*sslmode='bogus'/,
    );
  });

  it('malformed URL and non-postgres scheme fail closed with a DATABASE_URL error', () => {
    expect(() => buildPgPoolOptions('not a url')).toThrow(/DATABASE_URL is not a valid URL/);
    expect(() => buildPgPoolOptions('mysql://127.0.0.1:3306/ukpos')).toThrow(
      /DATABASE_URL must use the postgres:\/\/ or postgresql:\/\/ scheme/,
    );
  });

  it('sslrootcert file contents are read into ssl.ca', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build13-ssl-'));
    try {
      const certPath = join(dir, 'ca.pem');
      writeFileSync(certPath, '---FAKE CA FOR PARSING TEST ONLY---');
      const options = buildPgPoolOptions(
        `postgresql://127.0.0.1:5432/ukpos?sslmode=verify-ca&sslrootcert=${encodeURIComponent(certPath)}`,
      );
      expect(options.ssl).toEqual({
        rejectUnauthorized: true,
        ca: '---FAKE CA FOR PARSING TEST ONLY---',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unreadable sslrootcert fails closed with a DATABASE_URL error', () => {
    expect(() =>
      buildPgPoolOptions(
        'postgresql://127.0.0.1:5432/ukpos?sslmode=verify-ca&sslrootcert=%2Fdoes%2Fnot%2Fexist%2Fca.pem',
      ),
    ).toThrow(/DATABASE_URL sslrootcert file could not be read/);
  });
});

describe('pg merge proof — the built options survive pg\u2019s own parsing', () => {
  it('a real pg Client derives rejectUnauthorized: false from the require options', () => {
    const client = new Client(
      buildPgPoolOptions('postgresql://user:pass@127.0.0.1:5432/ukpos?sslmode=require'),
    );
    // No connection is opened by constructing a Client.
    expect(client.connectionParameters.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('a real pg Client derives rejectUnauthorized: true from the verify-full options', () => {
    const client = new Client(
      buildPgPoolOptions('postgresql://user:pass@127.0.0.1:5432/ukpos?sslmode=verify-full'),
    );
    expect(client.connectionParameters.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('createPgDb — fail closed without a live server', () => {
  it('dead DATABASE_URL rejects with a clear DATABASE_URL error (never PGlite)', async () => {
    await expect(createPgDb(DEAD_URL)).rejects.toThrow(/DATABASE_URL connection failed/);
  });

  it('dead DATABASE_URL with sslmode=require also fails closed', async () => {
    await expect(createPgDb(DEAD_SSL_URL)).rejects.toThrow(/DATABASE_URL connection failed/);
  });
});

describe('createApiDatabase — factory selection', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDir: string | undefined;

  beforeEach(() => {
    for (const key of ['DATABASE_URL', 'PGLITE_DATA_DIR', 'DEMO_SEED_ON_BOOT'] as const) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ['DATABASE_URL', 'PGLITE_DATA_DIR', 'DEMO_SEED_ON_BOOT'] as const) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('DATABASE_URL unset → PGlite-backed instance boots and runs a trivial query', async () => {
    const db = await createApiDatabase();
    try {
      const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
      expect(result.rows[0]?.one).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('DATABASE_URL set to a dead value → boot fails closed with a DATABASE_URL error', async () => {
    process.env.DATABASE_URL = DEAD_URL;
    await expect(createApiDatabase()).rejects.toThrow(/DATABASE_URL connection failed/);
  });

  it('DATABASE_URL wins over PGLITE_DATA_DIR (no silent local fallback)', async () => {
    process.env.DATABASE_URL = DEAD_URL;
    tempDir = mkdtempSync(join(tmpdir(), 'build13-pglite-'));
    process.env.PGLITE_DATA_DIR = tempDir;
    await expect(createApiDatabase()).rejects.toThrow(/DATABASE_URL connection failed/);
  });
});
