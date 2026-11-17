/**
 * AuditService — append-only, hash-chained audit log (Build-02, Objective 2;
 * Arch-01 §2.7).
 *
 * Every audited event is one row in audit_events, chained by
 * event_hash = sha256(prev_hash + canonical JSON of the event). The chain
 * is computed by the shared kernel (packages/shared-kernel/hash-chain.ts);
 * this service only decides WHAT is hashed and serialises writers per
 * tenant with an advisory lock so two concurrent writers cannot fork the
 * chain. The trigger on audit_events blocks UPDATE/DELETE; INSERT of a
 * row with a wrong hash is possible (and is exactly what verifyChain
 * detects).
 *
 * The hashed payload is ONE canonical object — { eventType, entityType,
 * entityId, userId, ...payload } — and that same object is stored in the
 * payload column, so verification recomputes the hash from exactly what
 * was stored. Payload values must be JSON-safe (no bigint — callers pass
 * money as strings).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import { sql, Transaction } from 'kysely';
import type { AuditEventsTable, DB } from '@uk-pos/db';
import type { ChainVerification } from '@uk-pos/shared-kernel';
import { GENESIS_PREV_HASH, hashChainLink, verifyHashChain } from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import { userIdAsUuid } from '../../common/uuid';

export interface AuditRecordInput {
  tenantId: string;
  userId?: string | null;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  /** JSON-safe extra fields (no bigint). Stored verbatim inside the hashed payload. */
  payload: Record<string, unknown>;
}

export interface AuditListOptions {
  limit?: number;
  eventType?: string;
}

/**
 * Type guard for a Kysely Transaction. Written as a predicate (rather
 * than an inline `instanceof`) because narrowing `Kysely<DB>` with
 * `instanceof Transaction` yields `Transaction<any>`, which Kysely
 * 0.28's types refuse to assign back to `Kysely<DB>` (a generic
 * variance quirk in `withTables().fn.any`); the predicate narrows to
 * `Transaction<DB>`, which is assignable, as every other module's
 * `trx: Kysely<DB>` parameters already rely on.
 */
function isTransaction(db: Kysely<DB>): db is Transaction<DB> {
  return db instanceof Transaction;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /**
   * Append one hash-chained audit event.
   *
   * When the caller passes a plain database, a transaction is opened here.
   * When the caller passes its own transaction, the row is written
   * directly on it, so the audit row commits or rolls back WITH the
   * caller's work (an approval and its audit row, an order and its audit
   * rows). Kysely 0.28 does NOT support calling .transaction() on a
   * Transaction (it throws unconditionally — its docstring's savepoint
   * claim is wrong), so the Transaction case must be detected with
   * `isTransaction` and run without re-wrapping. The
   * per-tenant advisory lock serialises writers for this tenant only.
   */
  async record(
    dbOrTrx: Kysely<DB>,
    input: AuditRecordInput,
  ): Promise<{ id: string; eventHash: string }> {
    if (isTransaction(dbOrTrx)) {
      return this.insertEvent(dbOrTrx, input);
    }
    return dbOrTrx.transaction().execute((trx) => this.insertEvent(trx, input));
  }

  private async insertEvent(
    trx: Kysely<DB>,
    input: AuditRecordInput,
  ): Promise<{ id: string; eventHash: string }> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${input.tenantId}))`.execute(trx);

    const last = await trx
      .selectFrom('audit_events')
      .select(['event_hash'])
      .where('tenant_id', '=', input.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const prevHash = last?.event_hash ?? GENESIS_PREV_HASH;

    // ONE canonical payload object: hashed and stored, never rebuilt.
    const canonicalPayload: Record<string, unknown> = {
      eventType: input.eventType,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      userId: input.userId ?? null,
      ...input.payload,
    };
    const eventHash = hashChainLink(prevHash, canonicalPayload);

    const inserted = await trx
      .insertInto('audit_events')
      .values({
        tenant_id: input.tenantId,
        // Build-06 Objective 4: the user_id column is uuid, but an
        // API-key actor's id is the synthetic `api-key:<keyId>` string
        // — storing it verbatim fails with a 22P02 cast error and
        // rolls back the caller's whole transaction. Store the UUID
        // when the actor is a real user, else null; the full actor
        // identity stays in the hashed canonical payload above, so
        // traceability is not lost.
        user_id: userIdAsUuid(input.userId),
        event_type: input.eventType,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        payload: canonicalPayload,
        prev_hash: prevHash,
        event_hash: eventHash,
      })
      .returning(['id', 'event_hash'])
      .executeTakeFirstOrThrow();
    return { id: inserted.id, eventHash: inserted.event_hash };
  }

  /**
   * Verify the tenant's audit chain in creation order. Reports the first
   * broken link (tampered payload, wrong prev_hash, or a deleted/reordered
   * event). An empty chain verifies as ok.
   */
  async verifyChain(tenantId: string): Promise<ChainVerification> {
    const rows = await this.db
      .selectFrom('audit_events')
      .select(['payload', 'prev_hash', 'event_hash'])
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return verifyHashChain(
      rows.map((row) => ({
        payload: row.payload,
        prevHash: row.prev_hash,
        eventHash: row.event_hash,
      })),
    );
  }

  /** Tenant-scoped audit listing, newest first. Read-only. */
  async listEvents(
    tenantId: string,
    opts: AuditListOptions = {},
  ): Promise<Array<Selectable<AuditEventsTable>>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let query = this.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (opts.eventType !== undefined) {
      query = query.where('event_type', '=', opts.eventType);
    }
    return query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }
}
