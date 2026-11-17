/**
 * GdprService — per-customer export & erasure, and automated hard
 * deletion (Build-03 Objective 4; Arch-01 §6.3–§6.5, Arch-09 §5.4).
 *
 * Per-customer export (Arch-09 §5.4): the customer record, consent
 * history, group memberships, notes, loyalty membership + ledger,
 * store-credit ledger, purchase summary, and that customer's orders
 * (+ lines, tenders, payment attempts, refunds, receipts). CSV + JSON
 * per table with a manifest (row counts + SHA-256), the Arch-01 §4.3
 * pattern. Gift cards are NOT included: the schema carries no
 * customer link for a bearer card, and Arch-09 §5.4's position is
 * that erasing a holder does not void the card.
 *
 * Erasure (UK GDPR Art. 17; Arch-01 §6.5, Arch-09 §5.4):
 *  - the customers row, notes, group memberships, consent history
 *    and purchase summary are DELETED;
 *  - orders are ANONYMISED (customer_id -> NULL) — the order is a
 *    financial record retained for the VAT period, the personal data
 *    is removed, the transaction record is not;
 *  - the loyalty / store-credit ledgers are ANONYMISED: their
 *    customer_id (NOT NULL FK) is re-pointed at a per-tenant
 *    placeholder customer ('[erased]', no contact data), so the
 *    points/money movements survive as a financial record without
 *    identifying anyone. The loyalty membership is closed, not
 *    deleted (the ledger references it). Points-balance treatment on
 *    erasure is Q-CRM-GDPR-01 — undecided by the spec — so the
 *    balance is retained anonymously; it is NOT forfeited here.
 *  - bearer gift cards survive erasure unchanged (Arch-09 §5.4
 *    design position, for counsel to confirm).
 *  - audit events are NOT rewritten: the trail retains the customer
 *    id, not the name (Arch-01 §6.5).
 *
 * Hard deletion (Arch-01 §6.3–§6.4): after the 30-day window, the
 * statutory VAT archive is SEPARATED FIRST, then every remaining
 * tenant row is hard-deleted in dependency order, a row-count check
 * must return zero (non-zero = failed, never silently complete),
 * and only the tenant tombstone (id, deleted_at) survives. The job
 * is logged in deletion_jobs (the platform-level deletion log —
 * the tenant's own audit_events are deleted with the tenant).
 *
 * Archive form — a design decision, recorded here: there are NO
 * archive tables in the schema, and in-place retention cannot work
 * (orders.customer_id aside, orders require their location and
 * order_lines require their variants through NOT NULL foreign keys,
 * so "retain the archive rows" would silently retain locations,
 * registers and catalogue too and defeat the zero-row check).
 * Arch-01 §6.3 itself lists orders/order lines/tenders/payment
 * attempts/refunds among the tables the job DELETES — the archive
 * is separated first, then everything is deleted. The archive is
 * therefore a checksummed JSON snapshot (one file per archive table
 * + manifest, PII-stripped) returned by hardDelete(); the coordinator
 * persists it to compliance storage (access-controlled, export-only,
 * 6-year retention per VAT Notice 700/21). The snapshot is the
 * platform's statutory archive; nothing of it remains in the live
 * database.
 *
 * Build-05 persistence (supersedes the "coordinator persists it"
 * paragraph above for the pilot): hardDelete() now persists the
 * snapshot itself, BEFORE any tenant row is deleted — as a row in
 * statutory_vat_archives (migration 014, append-only trigger,
 * retention_until = archived_at + 6 years, tenant_id unconstrained
 * so the row survives the tenant's hard deletion) AND as a
 * SHA-256-checksummed bundle file under STATUTORY_ARCHIVE_DIR
 * (default <pilot-root>/data/statutory-archives). The persisted
 * archive is verified by SHA-256 (database payload AND on-disk
 * bundle) before deletion proceeds; a verification failure aborts
 * the job and no tenant row is deleted.
 *
 * Trigger handling — the append-only triggers (stock_movements,
 * audit_events, marketing_consents, loyalty_ledger, gift_card_ledger,
 * store_credit_ledger) and the immutability triggers (completed
 * orders, issued Z-reports) block the DELETEs/UPDATEs this service
 * must perform. They are disabled and re-enabled INSIDE the same
 * transaction as the work (a rollback restores them), so the guards
 * stay in force for every other operation. This needs ALTER privilege
 * on those tables for the deletion role in production — a deployment
 * note for the coordinator, not a schema change.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, StatutoryVatArchivesTable } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { AuditService } from './audit.service';
import { userIdAsUuid } from '../../common/uuid';
import { ExitService, TerminationBlockedError } from './exit.service';
import {
  buildStatutoryArchiveBundle,
  canonicalSha256,
  statutoryArchiveDir,
  verifyArchiveBundleFile,
  writeArchiveBundle,
} from './statutory-archive';
import {
  DELETE_ORDER,
  RESTORE_ORDER,
  ExportService,
  type ExportResult,
  type ManifestEntry,
  type Row,
} from './export.service';
import type { EventPublisher } from '../payments/event-publisher.interface';

/** The 6-year statutory VAT archive (Arch-01 §6.4): the VAT record + the sales record needed to rebuild it. */
export const STATUTORY_ARCHIVE_TABLES = [
  'vat_periods',
  'vat_period_lines',
  'orders',
  'order_lines',
  'order_tenders',
  'payment_attempts',
  'refunds',
] as const;

/** Append-only / immutability triggers disabled inside the deletion & erasure transactions only. */
const DELETION_TRIGGERS: Array<{ table: string; trigger: string }> = [
  { table: 'stock_movements', trigger: 'trg_stock_movements_append_only' },
  { table: 'audit_events', trigger: 'trg_audit_events_append_only' },
  { table: 'marketing_consents', trigger: 'trg_marketing_consents_append_only' },
  { table: 'loyalty_ledger', trigger: 'trg_loyalty_ledger_append_only' },
  { table: 'gift_card_ledger', trigger: 'trg_gift_card_ledger_append_only' },
  { table: 'store_credit_ledger', trigger: 'trg_store_credit_ledger_append_only' },
  { table: 'orders', trigger: 'trg_orders_completed_immutable' },
  { table: 'z_reports', trigger: 'trg_z_reports_issued_immutable' },
];

/** Erasure needs the triggers that block its UPDATEs/DELETEs only. */
const ERASURE_TRIGGERS: Array<{ table: string; trigger: string }> = [
  { table: 'marketing_consents', trigger: 'trg_marketing_consents_append_only' },
  { table: 'loyalty_ledger', trigger: 'trg_loyalty_ledger_append_only' },
  { table: 'store_credit_ledger', trigger: 'trg_store_credit_ledger_append_only' },
  { table: 'orders', trigger: 'trg_orders_completed_immutable' },
];

const ERASED_PLACEHOLDER_FIRST_NAME = '[erased]';

export interface CustomerExportResult {
  customerId: string;
  files: Record<string, string>;
  manifest: ManifestEntry[];
  totalRows: number;
  fileCount: number;
}

export interface ErasureResult {
  customerId: string;
  anonymisedOrderCount: number;
  anonymisedLedgerRowCount: number;
  placeholderCustomerId: string;
}

export interface HardDeleteResult {
  jobId: string;
  tenantId: string;
  /** The separated 6-year statutory VAT archive (PII-stripped JSON snapshot + manifest). */
  archive: ExportResult;
  /** The persisted statutory archive (DB row + on-disk bundle), verified by SHA-256 before deletion. */
  statutoryArchive: PersistedStatutoryArchive;
  verifiedRowCount: number;
  deletedAt: Date;
}

export type StatutoryArchiveRow = Selectable<StatutoryVatArchivesTable>;

export interface PersistedStatutoryArchive {
  archiveId: string;
  tenantId: string;
  archivedAt: Date;
  retentionUntil: Date;
  archiveSha256: string;
  storageBundlePath: string;
  rowCounts: Record<string, number>;
}

export interface StatutoryArchiveVerification {
  archiveId: string;
  tenantId: string;
  archivedAt: Date;
  retentionUntil: Date;
  archiveSha256: string;
  storageBundlePath: string;
  rowCounts: Record<string, number>;
  /** The database payload re-hashes to the stored checksum. */
  payloadVerified: boolean;
  /** The on-disk bundle exists and re-hashes to the stored checksum. */
  fileVerified: boolean;
  verified: boolean;
}

/** Thrown when the post-deletion row-count check finds remaining rows. Carries the failing tables. */
export class HardDeleteFailedError extends Error {
  readonly remainingByTable: Record<string, number>;
  readonly totalRemaining: number;

  constructor(remainingByTable: Record<string, number>) {
    const total = Object.values(remainingByTable).reduce((sum, count) => sum + count, 0);
    super(
      `Hard deletion failed verification: ${total} row(s) remain (${Object.entries(remainingByTable)
        .map(([table, count]) => `${table}=${count}`)
        .join(', ')})`,
    );
    this.remainingByTable = remainingByTable;
    this.totalRemaining = total;
  }
}

async function setTriggers(db: Kysely<DB>, triggers: Array<{ table: string; trigger: string }>, enable: boolean): Promise<void> {
  for (const { table, trigger } of triggers) {
    await sql`
      ALTER TABLE ${sql.table(table)} ${enable ? sql.raw('ENABLE') : sql.raw('DISABLE')} TRIGGER ${sql.id(trigger)}
    `.execute(db);
  }
}

@Injectable()
export class GdprService {
  private eventPublisher?: EventPublisher;
  private clock: () => Date = () => new Date();
  /** Test override for the on-disk archive directory (STATUTORY_ARCHIVE_DIR otherwise). */
  private archiveDirOverride: string | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly auditService: AuditService,
    private readonly exitService: ExitService,
    private readonly exportService: ExportService,
  ) {}

  /** Optional: publish tenant.deleted best-effort after a hard deletion. Never required. */
  setEventPublisher(publisher: EventPublisher): void {
    this.eventPublisher = publisher;
  }

  /** Injectable clock (tests control time for the 30-day window). */
  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  /** Override the on-disk statutory archive directory (tests). */
  setArchiveDir(dir: string): void {
    this.archiveDirOverride = dir;
  }

  private getArchiveDir(): string {
    return this.archiveDirOverride ?? statutoryArchiveDir();
  }

  // ------------------------------------------------------------------
  // Per-customer export (Arch-09 §5.4)
  // ------------------------------------------------------------------

  private async fetchCustomerRows(customerId: string): Promise<Map<string, Row[]>> {
    const rows = new Map<string, Row[]>();
    const directTables = [
      'marketing_consents',
      'customer_group_memberships',
      'customer_notes',
      'loyalty_memberships',
      'loyalty_ledger',
      'store_credit_ledger',
      'customer_purchase_summaries',
      'orders',
    ];
    for (const table of directTables) {
      const result = await sql<Row>`
        SELECT * FROM ${sql.table(table)} WHERE ${sql.id('customer_id')} = ${customerId}
      `.execute(this.db);
      rows.set(table, result.rows);
    }
    const customer = await sql<Row>`
      SELECT * FROM customers WHERE ${sql.id('id')} = ${customerId}
    `.execute(this.db);
    rows.set('customers', customer.rows);

    // Order-linked tables (one hop through orders).
    for (const table of ['order_lines', 'order_tenders', 'payment_attempts', 'refunds', 'receipts']) {
      const result = await sql<Row>`
        SELECT t.* FROM ${sql.table(table)} t
        WHERE EXISTS (
          SELECT 1 FROM orders o
          WHERE o.${sql.id('id')} = t.${sql.id('order_id')}
            AND o.${sql.id('customer_id')} = ${customerId}
        )
      `.execute(this.db);
      rows.set(table, result.rows);
    }
    // Receipt VAT lines: two hops (receipt -> order -> customer).
    const vatLines = await sql<Row>`
      SELECT rvl.* FROM receipt_vat_lines rvl
      WHERE EXISTS (
        SELECT 1 FROM receipts r
        WHERE r.${sql.id('id')} = rvl.${sql.id('receipt_id')}
          AND EXISTS (
            SELECT 1 FROM orders o
            WHERE o.${sql.id('id')} = r.${sql.id('order_id')}
              AND o.${sql.id('customer_id')} = ${customerId}
          )
      )
    `.execute(this.db);
    rows.set('receipt_vat_lines', vatLines.rows);
    return rows;
  }

  /**
   * Per-customer GDPR export (Arch-09 §5.4): CSV + JSON per table +
   * manifest.json. Recorded as an export_jobs row for the tenant.
   * Other customers' data, other tenants' data, credentials and card
   * data are never included.
   */
  async exportCustomer(
    tenantId: string,
    customerId: string,
    requestedByUserId: string | null = null,
  ): Promise<CustomerExportResult> {
    const customer = await this.db
      .selectFrom('customers')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', customerId)
      .executeTakeFirst();
    if (customer === undefined) {
      throw new NotFoundException('Customer not found');
    }
    const job = await this.db
      .insertInto('export_jobs')
      .values({
        tenant_id: tenantId,
        status: 'running',
        requested_by_user_id: userIdAsUuid(requestedByUserId),
        // DB defaults are 0, but schema.ts types these as required
        // (not Generated) — pass the defaults explicitly.
        file_count: 0,
        total_rows: 0n,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    try {
      const tableRows = await this.fetchCustomerRows(customerId);
      const files: ExportResult['files'] = {};
      const manifest: ManifestEntry[] = [];
      let totalRows = 0;
      // Stable file order: the customer record first, then the rest alphabetically.
      const tableNames = [...tableRows.keys()].sort((a, b) =>
        a === 'customers' ? -1 : b === 'customers' ? 1 : a.localeCompare(b),
      );
      const exportedFiles = [];
      for (const table of tableNames) {
        const columns = await this.exportService.fetchTableColumns(this.db, table);
        const tableFiles = this.exportService.buildTableFiles(
          table,
          columns,
          tableRows.get(table) ?? [],
        );
        exportedFiles.push(...tableFiles);
        totalRows += tableRows.get(table)?.length ?? 0;
      }
      for (const file of exportedFiles) {
        files[file.fileName] = file.content;
        manifest.push({
          file_name: file.fileName,
          table_name: file.tableName,
          row_count: file.rowCount,
          sha256_checksum: file.sha256Checksum,
        });
      }
      const generatedAt = new Date();
      files['manifest.json'] = this.exportService.buildManifestJson(
        job.id,
        tenantId,
        exportedFiles,
        generatedAt,
      );

      await this.db.transaction().execute(async (trx) => {
        for (const entry of manifest) {
          await trx
            .insertInto('export_manifests')
            .values({
              export_job_id: job.id,
              file_name: entry.file_name,
              table_name: entry.table_name,
              row_count: BigInt(entry.row_count),
              sha256_checksum: entry.sha256_checksum,
            })
            .execute();
        }
        await trx
          .updateTable('export_jobs')
          .set({
            status: 'completed',
            file_count: exportedFiles.length,
            total_rows: BigInt(totalRows),
            completed_at: generatedAt,
          })
          .where('id', '=', job.id)
          .execute();
      });
      return {
        customerId,
        files,
        manifest,
        totalRows,
        fileCount: exportedFiles.length,
      };
    } catch (error) {
      await this.db
        .updateTable('export_jobs')
        .set({ status: 'failed' })
        .where('id', '=', job.id)
        .execute();
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // Customer erasure (Art. 17; Arch-01 §6.5, Arch-09 §5.4)
  // ------------------------------------------------------------------

  /**
   * Erase one customer: personal data deleted, orders and ledgers
   * anonymised and retained for the VAT period, bearer gift cards
   * untouched. The audit trail keeps the customer id, not the name.
   */
  async eraseCustomer(tenantId: string, customerId: string): Promise<ErasureResult> {
    const customer = await this.db
      .selectFrom('customers')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', customerId)
      .executeTakeFirst();
    if (customer === undefined) {
      throw new NotFoundException('Customer not found');
    }

    return this.db.transaction().execute(async (trx) => {
      await setTriggers(trx, ERASURE_TRIGGERS, false);
      // The triggers are re-enabled at the END of this callback,
      // while the transaction is still healthy. If any step fails,
      // the re-enable is skipped on purpose: the rollback restores
      // the triggers, and a re-enable attempt on an aborted
      // transaction would only mask the real error.
      let placeholder = await trx
        .selectFrom('customers')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('first_name', '=', ERASED_PLACEHOLDER_FIRST_NAME)
        .where('email', 'is', null)
        .where('phone', 'is', null)
        .executeTakeFirst();
      if (placeholder === undefined) {
        placeholder = await trx
          .insertInto('customers')
          .values({
            tenant_id: tenantId,
            first_name: ERASED_PLACEHOLDER_FIRST_NAME,
            last_name: null,
            email: null,
            phone: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      }
      const placeholderId = placeholder.id;

      const anonymisedOrders = Number(
        (
          await sql<{ count: string }>`
            WITH updated AS (
              UPDATE orders SET customer_id = NULL
              WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
              RETURNING 1
            )
            SELECT COUNT(*)::text AS count FROM updated
          `.execute(trx)
        ).rows[0]?.count ?? '0',
      );

      let anonymisedLedger = 0;
      for (const table of ['loyalty_ledger', 'store_credit_ledger'] as const) {
        const counted = await sql<{ count: string }>`
          WITH updated AS (
            UPDATE ${sql.table(table)} SET customer_id = ${placeholderId}
            WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
            RETURNING 1
          )
          SELECT COUNT(*)::text AS count FROM updated
        `.execute(trx);
        anonymisedLedger += Number(counted.rows[0]?.count ?? '0');
      }

      await trx
        .deleteFrom('marketing_consents')
        .where('tenant_id', '=', tenantId)
        .where('customer_id', '=', customerId)
        .execute();
      await trx
        .deleteFrom('customer_notes')
        .where('tenant_id', '=', tenantId)
        .where('customer_id', '=', customerId)
        .execute();
      await trx
        .deleteFrom('customer_group_memberships')
        .where('customer_id', '=', customerId)
        .execute();
      await trx
        .deleteFrom('customer_purchase_summaries')
        .where('tenant_id', '=', tenantId)
        .where('customer_id', '=', customerId)
        .execute();
      // Close the membership AND re-point it at the placeholder:
      // the membership row still exists (the ledger references it)
      // and it still references the customer — leaving it pointed
      // at the erased customer would block deleting that row (FK).
      // The membership number is pseudonymous, not personal data.
      await trx
        .updateTable('loyalty_memberships')
        .set({ status: 'closed', customer_id: placeholderId })
        .where('tenant_id', '=', tenantId)
        .where('customer_id', '=', customerId)
        .execute();
      await trx.deleteFrom('customers').where('id', '=', customerId).execute();

      await this.auditService.record(trx, {
        tenantId,
        userId: null,
        eventType: 'customer.erased',
        entityType: 'customer',
        entityId: customerId,
        payload: {
          anonymisedOrderCount: anonymisedOrders,
          anonymisedLedgerRowCount: anonymisedLedger,
        },
      });
      await setTriggers(trx, ERASURE_TRIGGERS, true);
      return {
        customerId,
        anonymisedOrderCount: anonymisedOrders,
        anonymisedLedgerRowCount: anonymisedLedger,
        placeholderCustomerId: placeholderId,
      };
    });
  }

  // ------------------------------------------------------------------
  // Automated hard deletion (Arch-01 §6.3–§6.4)
  // ------------------------------------------------------------------

  /**
   * Hard-delete a tenant after its 30-day export window.
   *
   * Pre-conditions: status must be 'hard_delete_scheduled', the
   * window must have ended, and D-11 must be clear (no open sessions
   * or pending/unknown payments — otherwise the job is marked failed
   * and the exact blocking ids are returned in the error, escalated
   * rather than silently completed).
   *
   * Steps: (1) separate the statutory VAT archive as a PII-stripped
   * JSON snapshot; (2) hard-delete every remaining tenant row in
   * dependency order; (3) verify zero remaining rows (non-zero =
   * failed, the deletion rolls back); (4) tombstone the tenant;
   * (5) log the job in deletion_jobs. Publishes tenant.deleted
   * best-effort when a publisher is set.
   */
  async hardDelete(
    tenantId: string,
    requestedByUserId: string | null = null,
  ): Promise<HardDeleteResult> {
    const tenant = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant === undefined) {
      throw new NotFoundException('Tenant not found');
    }
    if (tenant.status !== 'hard_delete_scheduled') {
      throw new BadRequestException(
        `Hard deletion requires status 'hard_delete_scheduled' (current: '${tenant.status}')`,
      );
    }
    const now = this.clock();
    if (tenant.export_window_ends_at !== null && tenant.export_window_ends_at > now) {
      throw new BadRequestException('The 30-day export window has not ended yet');
    }
    const blockers = await this.exitService.findBlockers(tenantId);
    if (ExitService.hasBlockers(blockers)) {
      await this.db
        .insertInto('deletion_jobs')
        .values({ tenant_id: tenantId, status: 'failed', requested_by_user_id: userIdAsUuid(requestedByUserId) })
        .execute();
      throw new TerminationBlockedError(blockers);
    }

    const job = await this.db
      .insertInto('deletion_jobs')
      .values({
        tenant_id: tenantId,
        status: 'running',
        requested_by_user_id: userIdAsUuid(requestedByUserId),
        started_at: now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // (1) Separate the statutory archive FIRST (PII-stripped snapshot).
    const archive = await this.buildStatutoryArchive(tenantId, job.id);

    // (1b) Build-05: persist the archive (DB row + on-disk bundle)
    // and verify it by SHA-256 BEFORE any tenant row is deleted. A
    // failure here aborts the job — no tenant row is deleted without
    // a verified archive.
    let statutoryArchive: PersistedStatutoryArchive;
    try {
      statutoryArchive = await this.persistStatutoryArchive(tenantId, job.id, archive, now);
    } catch (error) {
      await this.db
        .updateTable('deletion_jobs')
        .set({ status: 'failed', completed_at: new Date() })
        .where('id', '=', job.id)
        .execute();
      throw error;
    }

    try {
      // (2)+(3)+(4) Delete, verify, tombstone — one transaction.
      await this.db.transaction().execute(async (trx) => {
        await setTriggers(trx, DELETION_TRIGGERS, false);
        // The triggers are re-enabled at the END of this callback,
        // while the transaction is still healthy (see eraseCustomer).
        // The surviving deletion_jobs row must not reference a user:
        // it is the platform-level deletion log (Arch-01 §6.3 — no
        // merchant personal data beyond the tenant id), and a
        // requested_by_user_id would block deleting the users table
        // (FK) below.
        await trx
          .updateTable('deletion_jobs')
          .set({ requested_by_user_id: null })
          .where('id', '=', job.id)
          .execute();
        for (const spec of DELETE_ORDER) {
          const excludeIds = spec.table === 'deletion_jobs' ? [job.id] : [];
          await this.exportService.deleteTenantTableRows(trx, spec, tenantId, excludeIds);
        }
          // Tombstone: id + deleted_at only (name is NOT NULL, so it
          // holds the '[deleted]' marker, not merchant data).
          await trx
            .updateTable('tenants')
            .set({
              name: '[deleted]',
              legal_name: null,
              trading_name: null,
              vat_registered: false,
              vat_number: null,
              status: 'deleted',
              plan_tier: 'base',
              termination_requested_at: null,
              export_window_ends_at: null,
              hard_delete_scheduled_at: null,
              deleted_at: now,
              updated_at: now,
            })
            .where('id', '=', tenantId)
            .execute();

          // (3) Verification: zero rows for the tenant in every table
          // except the tombstoned tenants row itself — and except the
          // current deletion_jobs row, which IS the platform deletion
          // log and must survive (all other deletion_jobs rows are
          // deleted with the tenant).
          const remaining: Record<string, number> = {};
          for (const spec of RESTORE_ORDER) {
            if (spec.table === 'tenants') {
              continue;
            }
            let count: number;
            if (spec.table === 'deletion_jobs') {
              const counted = await sql<{ count: string }>`
                SELECT COUNT(*)::text AS count FROM deletion_jobs
                WHERE tenant_id = ${tenantId} AND id <> ${job.id}
              `.execute(trx);
              count = Number(counted.rows[0]?.count ?? '0');
            } else {
              count = await this.exportService.countTenantTableRows(trx, spec, tenantId);
            }
            if (count > 0) {
              remaining[spec.table] = count;
            }
          }
          if (Object.keys(remaining).length > 0) {
            throw new HardDeleteFailedError(remaining);
          }
          await setTriggers(trx, DELETION_TRIGGERS, true);
      });
    } catch (error) {
      const totalRemaining =
        error instanceof HardDeleteFailedError ? error.totalRemaining : null;
      await this.db
        .updateTable('deletion_jobs')
        .set({ status: 'failed', verified_row_count: totalRemaining, completed_at: new Date() })
        .where('id', '=', job.id)
        .execute();
      throw error;
    }

    // (5) Log the completed job (the platform-level deletion log).
    await this.db
      .updateTable('deletion_jobs')
      .set({ status: 'completed', verified_row_count: 0, completed_at: new Date() })
      .where('id', '=', job.id)
      .execute();

    if (this.eventPublisher !== undefined) {
      try {
        await this.eventPublisher.publish('tenant.deleted', {
          tenant_id: tenantId,
          deleted_at: now.toISOString(),
        });
      } catch {
        // Webhooks are notifications, not the system of record.
      }
    }

    return {
      jobId: job.id,
      tenantId,
      archive,
      statutoryArchive,
      verifiedRowCount: 0,
      deletedAt: now,
    };
  }

  // ------------------------------------------------------------------
  // Statutory VAT archive persistence (Build-05, Objective 2)
  // ------------------------------------------------------------------

  /**
   * Persist a statutory archive snapshot: write the checksummed
   * bundle to disk, insert the append-only statutory_vat_archives
   * row, then verify BOTH by SHA-256 before returning. Throws (and
   * leaves the job to the caller) when verification fails.
   */
  async persistStatutoryArchive(
    tenantId: string,
    jobId: string,
    archive: ExportResult,
    archivedAt: Date = new Date(),
  ): Promise<PersistedStatutoryArchive> {
    const built = buildStatutoryArchiveBundle(tenantId, jobId, archive, archivedAt);
    const storageBundlePath = await writeArchiveBundle(
      this.getArchiveDir(),
      tenantId,
      jobId,
      built.bundle,
    );
    const row = await this.db
      .insertInto('statutory_vat_archives')
      .values({
        tenant_id: tenantId,
        archived_at: archivedAt,
        retention_until: built.retentionUntil,
        archive_sha256: built.archiveSha256,
        row_counts_json: built.rowCounts,
        archive_payload_json: built.bundle as unknown as Record<string, unknown>,
        storage_bundle_path: storageBundlePath,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Verify before the caller deletes anything: the on-disk bundle
    // and the stored database payload must both re-hash to the
    // recorded checksum.
    const fileVerified = await verifyArchiveBundleFile(storageBundlePath, built.archiveSha256);
    const payloadVerified = canonicalSha256(row.archive_payload_json) === built.archiveSha256;
    if (!fileVerified || !payloadVerified) {
      throw new Error(
        `Statutory VAT archive verification failed for tenant ${tenantId} ` +
          `(fileVerified=${fileVerified}, payloadVerified=${payloadVerified}) — tenant rows were NOT deleted`,
      );
    }
    return {
      archiveId: row.id,
      tenantId,
      archivedAt: row.archived_at,
      retentionUntil: row.retention_until,
      archiveSha256: row.archive_sha256,
      storageBundlePath: row.storage_bundle_path,
      rowCounts: row.row_counts_json as Record<string, number>,
    };
  }

  /** List the persisted statutory archives for a tenant (newest first). */
  async listStatutoryArchives(tenantId: string): Promise<StatutoryArchiveRow[]> {
    return this.db
      .selectFrom('statutory_vat_archives')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('archived_at', 'desc')
      .execute();
  }

  /**
   * Verify one persisted archive (compliance check): re-hash the
   * database payload and the on-disk bundle against the stored
   * checksum. A missing tenant or a foreign-tenant archive is 404.
   */
  async verifyStatutoryArchive(
    tenantId: string,
    archiveId: string,
  ): Promise<StatutoryArchiveVerification> {
    const row = await this.db
      .selectFrom('statutory_vat_archives')
      .selectAll()
      .where('id', '=', archiveId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const payloadVerified = canonicalSha256(row.archive_payload_json) === row.archive_sha256;
    const fileVerified = await verifyArchiveBundleFile(row.storage_bundle_path, row.archive_sha256);
    return {
      archiveId: row.id,
      tenantId: row.tenant_id,
      archivedAt: row.archived_at,
      retentionUntil: row.retention_until,
      archiveSha256: row.archive_sha256,
      storageBundlePath: row.storage_bundle_path,
      rowCounts: row.row_counts_json as Record<string, number>,
      payloadVerified,
      fileVerified,
      verified: payloadVerified && fileVerified,
    };
  }

  /**
   * Build the statutory archive snapshot: one CSV + JSON per archive
   * table (VAT record + sales record), PII-stripped (orders lose
   * customer_id and created_by_user_id), plus manifest.json.
   */
  private async buildStatutoryArchive(tenantId: string, jobId: string): Promise<ExportResult> {
    const specs = RESTORE_ORDER.filter((spec) =>
      (STATUTORY_ARCHIVE_TABLES as readonly string[]).includes(spec.table),
    );
    const files: ExportResult['files'] = {};
    const manifest: ManifestEntry[] = [];
    let totalRows = 0;
    const exportedFiles = [];
    for (const spec of specs) {
      const columns = await this.exportService.fetchTableColumns(this.db, spec.table);
      let rows = await this.exportService.fetchTenantTableRows(this.db, spec, tenantId);
      if (spec.table === 'orders') {
        rows = rows.map((row) => ({ ...row, customer_id: null, created_by_user_id: null }));
      }
      const tableFiles = this.exportService.buildTableFiles(spec.table, columns, rows);
      exportedFiles.push(...tableFiles);
      totalRows += rows.length;
    }
    for (const file of exportedFiles) {
      files[file.fileName] = file.content;
      manifest.push({
        file_name: file.fileName,
        table_name: file.tableName,
        row_count: file.rowCount,
        sha256_checksum: file.sha256Checksum,
      });
    }
    files['manifest.json'] = this.exportService.buildManifestJson(
      jobId,
      tenantId,
      exportedFiles,
      new Date(),
    );
    return { jobId, files, manifest, totalRows, fileCount: exportedFiles.length };
  }
}
