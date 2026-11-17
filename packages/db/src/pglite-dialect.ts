/**
 * Kysely dialect for @electric-sql/pglite (Build-02, Objective 1).
 *
 * kysely-pglite's bundled driver returns PostgreSQL int8 columns as JS
 * `number` when the value fits in the safe-integer range (and as `bigint`
 * only for larger values), because PGlite's default int8 parser does that.
 * The Kysely schema types every money/quantity column as JS `bigint`
 * (D-13), so a read that returns a `number` breaks the types at runtime —
 * `row.quantity_on_hand - 1n` throws "Cannot mix BigInt and other types".
 *
 * This dialect fixes the mismatch in ONE place, at the driver boundary:
 * every result column whose PostgreSQL type is int8 (oid 20) is converted
 * to `bigint` on read. All other types pass through untouched (int2/int4
 * stay `number`, numeric stays `string`, timestamptz stays `Date`).
 *
 * The same conversion must be applied when the production `pg` driver is
 * wired: node-postgres returns int8 as `string` by default, so the
 * production connection must call `types.setTypeParser(20, BigInt)`.
 * Until then, this dialect is the single place the int8→bigint rule lives.
 *
 * The dialect is deliberately small and mirrors kysely-pglite's own
 * PGliteDriver (same transaction handling, same single-connection model).
 * PGlite runs on a single connection, so concurrent Kysely transactions
 * are serialised by the driver queue — see pglite.ts.
 */
import type { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

/** PostgreSQL type oid for int8 (bigint). */
const INT8_OID = 20;

interface PGliteField {
  name: string;
  dataTypeID: number;
}

interface PGliteResult {
  rows: Record<string, unknown>[];
  fields: PGliteField[];
  affectedRows: number;
}

class PGliteConnection implements DatabaseConnection {
  readonly #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const result = (await this.#client.query(compiledQuery.sql, [
      ...compiledQuery.parameters,
    ])) as unknown as PGliteResult;
    const rows = result.rows.map((row) => {
      const converted: Record<string, unknown> = {};
      for (const field of result.fields) {
        const value = row[field.name];
        converted[field.name] =
          field.dataTypeID === INT8_OID && value !== null && value !== undefined
            ? BigInt(value as string | number)
            : value;
      }
      return converted as O;
    });
    return {
      rows,
      numAffectedRows: BigInt(result.affectedRows ?? 0),
    };
  }

  async *streamQuery<O>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('PGlite does not support streaming.');
  }
}

class PGliteDriver implements Driver {
  readonly #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PGliteConnection(this.#client);
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {}

  async destroy(): Promise<void> {
    await this.#client.close();
  }
}

/** Kysely dialect backed by a PGlite instance, with int8 → bigint on read. */
export class PGliteDialect implements Dialect {
  readonly #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new PGliteDriver(this.#client);
  }

  createIntrospector(db: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }
}
