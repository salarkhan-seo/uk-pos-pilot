/**
 * Database injection token for the API (Build-02).
 *
 * Services take `Kysely<DB>` via `@Inject(DATABASE)`. In tests, services
 * are constructed directly with a PGlite-backed test database from
 * `@uk-pos/db` (createTestDb); in the running API the DatabaseModule
 * provides the same kind of instance (PGlite in-memory with migrations
 * applied on boot — the local/test engine; production wires `pg` here).
 */
export const DATABASE = 'DATABASE';
