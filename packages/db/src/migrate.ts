/**
 * Migration runner for packages/db/migrations/.
 *
 * Migration order is by filename (001_tenancy.sql ... 008_phase2_promotions).
 * Applied filenames are recorded in the `migrations` table created by
 * 001_tenancy.sql; a migration is never applied twice.
 *
 * This runner takes a Kysely instance supplied by the caller — it does NOT
 * create a connection itself. In Build-02 the instance is backed by
 * PGlite (packages/db/src/pglite.ts); in production it is backed by a real
 * PostgreSQL server. The runner is dialect-agnostic: each file's
 * statements are executed one at a time inside one transaction, so it
 * works on any Kysely dialect.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { DB } from './schema';

export interface MigrationFile {
  filename: string;
  sql: string;
}

const MIGRATION_FILENAME = /^\d{3}_[a-z0-9_]+\.sql$/;

/**
 * Split a SQL script into individual statements.
 *
 * A naive split on `;` would break PL/pgSQL function bodies (which contain
 * `;` inside dollar-quoted blocks). This splitter tracks
 * single-quoted strings (with doubled-quote escapes), double-quoted
 * identifiers, dash-dash line comments, slash-star block comments and
 * dollar-quoted strings, and splits only on `;` in normal code.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = script.length;
  let dollarTag: string | null = null;

  const matchDollarOpen = (pos: number): string | null => {
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(pos, pos + 32));
    return match === null ? null : match[0];
  };

  while (i < n) {
    const ch = script[i] as string;
    const next = script[i + 1] as string;

    if (dollarTag !== null) {
      if (script.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      const end = script.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = script.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += script.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      if (next === "'") {
        current += "''";
        i += 2;
        continue;
      }
      // Single-quoted string: consume to the closing quote.
      let j = i + 1;
      while (j < n) {
        if (script[j] === "'" && script[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (script[j] === "'") {
          break;
        }
        j += 1;
      }
      current += script.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (script[j] === '"' && script[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (script[j] === '"') {
          break;
        }
        j += 1;
      }
      current += script.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const tag = matchDollarOpen(i);
      if (tag !== null) {
        dollarTag = tag;
        current += tag;
        i += tag.length;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

const TRANSACTION_MARKER = /^(BEGIN|COMMIT|ROLLBACK)\b/i;

/**
 * List migration files in a directory, in application order (filename
 * order). Files that do not match the `NNN_name.sql` pattern are ignored.
 */
export async function listMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  const names = (await readdir(migrationsDir))
    .filter((name) => MIGRATION_FILENAME.test(name))
    .sort();
  const files: MigrationFile[] = [];
  for (const filename of names) {
    const content = await readFile(join(migrationsDir, filename), 'utf8');
    if (content.trim().length === 0) {
      throw new Error(`Migration ${filename} is empty`);
    }
    files.push({ filename, sql: content });
  }
  return files;
}

/**
 * Filenames already applied, from the `migrations` table. Returns an empty
 * list when the table does not exist yet (first run, before 001 applies).
 */
export async function appliedMigrations(db: Kysely<DB>): Promise<string[]> {
  try {
    const rows = await db.selectFrom('migrations').select('filename').orderBy('filename').execute();
    return rows.map((row) => row.filename);
  } catch {
    // The migrations table is created by 001_tenancy.sql itself, so on the
    // very first run it does not exist yet. Anything else that fails here
    // will fail again loudly when the migration itself is applied.
    return [];
  }
}

/**
 * Apply every not-yet-applied migration in order, recording each filename
 * in the `migrations` table. Returns the filenames that were applied.
 *
 * Each file runs inside ONE Kysely transaction (the file's own BEGIN /
 * COMMIT markers are stripped — they are file-level markers, and nesting
 * them inside a driver transaction would commit early). Statements are
 * executed one at a time: a whole file sent as a single prepared statement
 * is rejected by PostgreSQL ("cannot insert multiple commands into a
 * prepared statement"), which is what the Build-01 runner did.
 */
export async function applyMigrations(db: Kysely<DB>, migrationsDir: string): Promise<string[]> {
  const files = await listMigrations(migrationsDir);
  const applied = new Set(await appliedMigrations(db));
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file.filename)) {
      continue;
    }
    const statements = splitSqlStatements(file.sql).filter(
      (statement) => !TRANSACTION_MARKER.test(statement.trim()),
    );
    await db.transaction().execute(async (trx) => {
      for (const statement of statements) {
        await sql.raw(statement).execute(trx);
      }
      await trx.insertInto('migrations').values({ filename: file.filename }).execute();
    });
    newlyApplied.push(file.filename);
  }
  return newlyApplied;
}
