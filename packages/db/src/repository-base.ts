/**
 * Tenant-scoped repository base (Arch-01 §2.1, package §9 invariant:
 * tenant isolation on every query, export, report and webhook).
 *
 * Every repository in the pilot extends this class. The class holds the
 * tenant id and exposes ONE way to start a tenant-scoped select:
 * `scopedSelect(table)` applies `tenant_id = <this tenant>` before any
 * other condition. A query that forgets the tenant filter is a cross-tenant
 * leak — the filter lives here so it cannot be forgotten in one place and
 * remembered in another.
 *
 * Two hard rules, enforced by the DATABASE (not just by convention):
 *  - completed orders are immutable (trigger in migration 004);
 *  - append-only tables reject UPDATE/DELETE (triggers in migrations
 *    003/005/006/007).
 * Repositories must never try to work around those triggers.
 */
import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';
import type { DB } from './schema';

/**
 * Tables that carry a tenant_id column. Computed from the DB type so a
 * table added without tenant_id cannot be passed to scopedSelect — the
 * compiler refuses it.
 */
export type TenantScopedTable = {
  [K in keyof DB]: 'tenant_id' extends keyof DB[K] ? K : never;
}[keyof DB];

export abstract class TenantScopedRepository {
  protected constructor(
    protected readonly db: Kysely<DB>,
    protected readonly tenantId: string,
  ) {}

  /**
   * Start a SELECT on a tenant-scoped table with the tenant filter already
   * applied. Every further condition chains onto this builder.
   *
   * Implementation note: Kysely's typed `.where('tenant_id', '=', ...)`
   * cannot be written once for "any table that has a tenant_id" — over a
   * generic table the overloads do not resolve. The builder is therefore
   * called through a concrete table type ('tenants', which has tenant_id)
   * with a raw `sql<boolean>` filter, then cast back to the caller's
   * table. The cast is safe: the builder was created from `table` itself;
   * only the intermediate type is borrowed. The compile-time guarantee
   * still holds — `TenantScopedTable` only admits tables that carry a
   * `tenant_id` column, so a table without one cannot reach this method.
   */
  protected scopedSelect<T extends TenantScopedTable>(table: T): SelectQueryBuilder<DB, T, {}> {
    const concrete = this.db.selectFrom(table) as SelectQueryBuilder<DB, 'tenants', {}>;
    const filtered = concrete.where(sql<boolean>`"tenant_id" = ${this.tenantId}`);
    return filtered as unknown as SelectQueryBuilder<DB, T, {}>;
  }

  /**
   * Start an INSERT on a tenant-scoped table with tenant_id pre-filled.
   * The caller supplies the remaining columns; tenant_id cannot be
   * overridden to another tenant's id through this helper.
   */
  protected scopedInsert<T extends TenantScopedTable>(table: T) {
    return this.db.insertInto(table);
  }
}
