/**
 * ExportService — single-click full tenant export + backup/restore
 * verification (Build-03 Objective 4; Arch-01 §4.3, §6.3/G-E).
 *
 * Full export (Arch-01 §4.3): one CSV + one JSON file per tenant
 * table, plus manifest.json with row counts and SHA-256 checksums.
 * No per-file object cap, no date-range cap, free and unlimited.
 * The export runs as an export_jobs row (pending -> running ->
 * completed/failed) with one export_manifests row per file.
 *
 * Excluded by design (Arch-01 §4.3): password hashes, MFA secrets,
 * API keys (key_hash), webhook endpoint secrets (secret_hash), and
 * full gift/voucher codes — only the stored hash + last-4 are
 * exported, never the code itself. Cardholder data is never held, so
 * there is nothing to export. Platform-internal data (the migrations
 * table, other tenants) is never included.
 *
 * manifest.json lists every DATA file; it is not itself a row in
 * export_manifests (a manifest cannot checksum itself). The returned
 * files map does include manifest.json as a file.
 *
 * Backup/restore verification (G-E): verifyBackupRestore() restores
 * a snapshot's JSON files into a fresh PGlite instance (supplied by
 * the caller, migrations already applied) and reconciles row counts,
 * ledger sums and Z-report totals, reporting pass/fail with named
 * discrepancies. It never touches the live database.
 *
 * Table order: RESTORE_ORDER is a topological (parents-first) order
 * used for restore; DELETE_ORDER is its reverse and is used by
 * GdprService.hardDelete(). Both are exported for reuse.
 */
import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { AuditService } from './audit.service';
import { userIdAsUuid } from '../../common/uuid';

/* ------------------------------------------------------------------ */
/* Serialisation helpers (exported for GdprService reuse)              */
/* ------------------------------------------------------------------ */

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** JSON-safe value: bigint -> decimal string, Date -> ISO string, recurse into arrays/objects. */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return value;
}

export type Row = Record<string, unknown>;

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text =
    typeof value === 'object' ? JSON.stringify(toJsonValue(value)) : String(toJsonValue(value));
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** CSV for one table: header from information_schema column order, one row per record. */
export function rowsToCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  return lines.join('\n') + '\n';
}

/** JSON for one table: an array of row objects (bigint -> string, Date -> ISO). */
export function rowsToJson(rows: Row[]): string {
  return JSON.stringify(rows.map((row) => toJsonValue(row)), null, 2) + '\n';
}

/* ------------------------------------------------------------------ */
/* Table registry                                                      */
/* ------------------------------------------------------------------ */

/**
 * How a table's rows are scoped to a tenant:
 *  - 'tenant': the table has its own tenant_id column.
 *  - 'tenants-row': the tenants table itself (id = tenantId).
 *  - { via: ... }: the table has no tenant_id; rows belong to the
 *    tenant through a parent table that does (one hop).
 */
export type TableScope =
  | { kind: 'tenant' }
  | { kind: 'tenants-row' }
  | { kind: 'via'; parent: string; parentKey: string; childKey: string };

export interface TableSpec {
  table: string;
  scope: TableScope;
}

const direct = (table: string): TableSpec => ({ table, scope: { kind: 'tenant' } });
const via = (table: string, parent: string, parentKey: string, childKey: string): TableSpec => ({
  table,
  scope: { kind: 'via', parent, parentKey, childKey },
});

/**
 * Every tenant table, in RESTORE order (parents first). The full
 * export covers all of these; the restore verifier inserts in this
 * order; hard deletion deletes in the reverse order.
 */
export const RESTORE_ORDER: TableSpec[] = [
  { table: 'tenants', scope: { kind: 'tenants-row' } },
  direct('locations'),
  direct('registers'),
  direct('roles'),
  via('role_permissions', 'roles', 'id', 'role_id'),
  direct('users'),
  via('user_roles', 'users', 'id', 'user_id'),
  via('user_locations', 'users', 'id', 'user_id'),
  direct('categories'),
  direct('tax_rates'),
  direct('units_of_measure'),
  direct('products'),
  direct('product_attributes'),
  via('attribute_values', 'product_attributes', 'id', 'product_attribute_id'),
  direct('product_variants'),
  via('variant_attribute_values', 'product_variants', 'id', 'variant_id'),
  via('variant_units', 'product_variants', 'id', 'variant_id'),
  direct('age_restrictions'),
  via('bundle_components', 'product_variants', 'id', 'bundle_variant_id'),
  direct('barcode_rules'),
  direct('suppliers'),
  via('supplier_variants', 'suppliers', 'id', 'supplier_id'),
  direct('warehouses'),
  direct('stock_balances'),
  direct('stock_valuation'),
  direct('stock_counts'),
  via('stock_count_lines', 'stock_counts', 'id', 'count_id'),
  direct('stock_transfers'),
  via('stock_transfer_lines', 'stock_transfers', 'id', 'transfer_id'),
  direct('reorder_points'),
  direct('purchase_order_suggestions'),
  direct('purchase_orders'),
  via('purchase_order_lines', 'purchase_orders', 'id', 'po_id'),
  direct('goods_in_receipts'),
  via('goods_in_lines', 'goods_in_receipts', 'id', 'receipt_id'),
  direct('customers'),
  direct('marketing_consents'),
  direct('loyalty_memberships'),
  direct('customer_groups'),
  via('customer_group_memberships', 'customers', 'id', 'customer_id'),
  direct('customer_notes'),
  direct('customer_purchase_summaries'),
  direct('loyalty_earning_rules'),
  direct('loyalty_tiers'),
  direct('gift_cards'),
  direct('price_books'),
  via('price_book_entries', 'price_books', 'id', 'price_book_id'),
  direct('promotions'),
  via('promotion_conditions', 'promotions', 'id', 'promotion_id'),
  via('promotion_targets', 'promotions', 'id', 'promotion_id'),
  direct('loyalty_campaigns'),
  direct('voucher_codes'),
  direct('orders'),
  direct('order_lines'),
  direct('payment_attempts'),
  direct('order_tenders'),
  direct('refunds'),
  direct('receipts'),
  via('receipt_vat_lines', 'receipts', 'id', 'receipt_id'),
  direct('serial_numbers'),
  direct('stock_movements'),
  direct('age_verification_events'),
  direct('approval_events'),
  direct('offline_payment_records'),
  direct('applied_promotions'),
  direct('loyalty_ledger'),
  direct('gift_card_ledger'),
  direct('store_credit_ledger'),
  direct('register_sessions'),
  direct('cash_movements'),
  direct('z_reports'),
  via('z_report_vat_lines', 'z_reports', 'id', 'z_report_id'),
  via('z_report_tender_lines', 'z_reports', 'id', 'z_report_id'),
  via('z_report_corrections', 'z_reports', 'id', 'z_report_id'),
  direct('vat_periods'),
  via('vat_period_lines', 'vat_periods', 'id', 'vat_period_id'),
  direct('vat_return_exports'),
  direct('audit_events'),
  direct('export_jobs'),
  via('export_manifests', 'export_jobs', 'id', 'export_job_id'),
  direct('tenant_export_windows'),
  direct('data_retention_policies'),
  direct('deletion_jobs'),
  direct('api_keys'),
  direct('webhook_endpoints'),
  direct('webhook_events'),
  direct('webhook_deliveries'),
];

/** Hard-deletion order: children first (reverse of restore order, tenants handled as a tombstone). */
export const DELETE_ORDER: TableSpec[] = [...RESTORE_ORDER].reverse().filter((spec) => spec.table !== 'tenants');

/** Columns never exported (credentials/secrets — Arch-01 §4.3). */
export const EXPORT_COLUMN_EXCLUSIONS: Record<string, string[]> = {
  users: ['password_hash', 'pin_hash'],
  api_keys: ['key_hash'],
  // Build-05: the retiring secret's hash is a secret hash too — it
  // must never be exported (its grace window is still live when a
  // rotation happens). previous_secret_expires_at is only a
  // timestamp and stays exportable.
  webhook_endpoints: ['secret_hash', 'previous_secret_hash'],
};

/** jsonb columns: their values must be JSON-stringified when passed as query parameters on restore. */
const JSON_COLUMNS = new Set([
  'audit_events.payload',
  'webhook_events.payload',
  'loyalty_earning_rules.category_multipliers',
  'promotion_conditions.condition_value',
]);

/** Self-referencing columns: rows with a NULL self-reference are inserted before the rest. */
const SELF_REF_COLUMNS: Record<string, string> = {
  categories: 'parent_id',
  loyalty_ledger: 'reverses_ledger_id',
};

export interface ExportedFile {
  fileName: string;
  tableName: string;
  rowCount: number;
  sha256Checksum: string;
  content: string;
}

export interface ManifestEntry {
  file_name: string;
  table_name: string;
  row_count: number;
  sha256_checksum: string;
}

export interface ExportResult {
  jobId: string;
  /** Every file by name, including manifest.json. */
  files: Record<string, string>;
  manifest: ManifestEntry[];
  totalRows: number;
  fileCount: number;
}

export interface BackupRestoreReport {
  pass: boolean;
  discrepancies: string[];
  tablesChecked: number;
  rowsRestored: number;
}

/** Ledger-sum checks for the restore verifier (G-E): snapshot sums vs restored sums, in pence/points. */
const LEDGER_SUM_CHECKS: Array<{ table: string; column: string }> = [
  { table: 'orders', column: 'total_pence' },
  { table: 'order_lines', column: 'line_total_pence' },
  { table: 'stock_movements', column: 'quantity_change' },
  { table: 'loyalty_ledger', column: 'points' },
  { table: 'z_reports', column: 'gross_pence' },
  { table: 'payment_attempts', column: 'amount_pence' },
];

@Injectable()
export class ExportService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly auditService: AuditService,
  ) {}

  /** Column names for a table, in ordinal order (also the CSV header — even for empty tables). */
  async fetchTableColumns(db: Kysely<DB>, table: string): Promise<string[]> {
    const rows = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
      ORDER BY ordinal_position
    `.execute(db);
    return rows.rows.map((row) => row.column_name);
  }

  /** Row count for one table belonging to a tenant, per the registry scope. */
  async countTenantTableRows(db: Kysely<DB>, spec: TableSpec, tenantId: string): Promise<number> {
    const table = spec.table;
    let result;
    if (spec.scope.kind === 'tenants-row') {
      result = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM ${sql.table(table)} WHERE ${sql.id('id')} = ${tenantId}
      `.execute(db);
    } else if (spec.scope.kind === 'tenant') {
      result = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM ${sql.table(table)} WHERE ${sql.id('tenant_id')} = ${tenantId}
      `.execute(db);
    } else {
      const { parent, parentKey, childKey } = spec.scope;
      result = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM ${sql.table(table)} t
        WHERE EXISTS (
          SELECT 1 FROM ${sql.table(parent)} p
          WHERE p.${sql.id(parentKey)} = t.${sql.id(childKey)}
            AND p.${sql.id('tenant_id')} = ${tenantId}
        )
      `.execute(db);
    }
    return Number(result.rows[0]?.count ?? '0');
  }

  /**
   * Delete every row of one table belonging to a tenant, per the
   * registry scope. `excludeIds` keeps listed rows (used for the
   * current deletion_jobs row, which must survive as the platform
   * deletion log). Returns the deleted row count.
   */
  async deleteTenantTableRows(
    db: Kysely<DB>,
    spec: TableSpec,
    tenantId: string,
    excludeIds: string[] = [],
  ): Promise<number> {
    const table = spec.table;
    const exclude =
      excludeIds.length > 0
        ? sql`AND ${sql.id('id')} NOT IN (${sql.join(excludeIds)})`
        : sql``;
    let result;
    if (spec.scope.kind === 'tenants-row') {
      // The tenants row itself is tombstoned, never deleted — see GdprService.
      return 0;
    }
    if (spec.scope.kind === 'tenant') {
      result = await sql<{ count: string }>`
        WITH deleted AS (
          DELETE FROM ${sql.table(table)}
          WHERE ${sql.id('tenant_id')} = ${tenantId} ${exclude}
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `.execute(db);
    } else {
      const { parent, parentKey, childKey } = spec.scope;
      result = await sql<{ count: string }>`
        WITH deleted AS (
          DELETE FROM ${sql.table(table)} t
          WHERE EXISTS (
            SELECT 1 FROM ${sql.table(parent)} p
            WHERE p.${sql.id(parentKey)} = t.${sql.id(childKey)}
              AND p.${sql.id('tenant_id')} = ${tenantId}
          ) ${exclude}
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `.execute(db);
    }
    return Number(result.rows[0]?.count ?? '0');
  }


  /** All rows of one table belonging to a tenant, per the registry scope. */
  async fetchTenantTableRows(db: Kysely<DB>, spec: TableSpec, tenantId: string): Promise<Row[]> {
    const table = spec.table;
    if (spec.scope.kind === 'tenants-row') {
      const result = await sql<Row>`
        SELECT * FROM ${sql.table(table)} WHERE ${sql.id('id')} = ${tenantId}
      `.execute(db);
      return result.rows;
    }
    if (spec.scope.kind === 'tenant') {
      const result = await sql<Row>`
        SELECT * FROM ${sql.table(table)} WHERE ${sql.id('tenant_id')} = ${tenantId}
      `.execute(db);
      return result.rows;
    }
    const { parent, parentKey, childKey } = spec.scope;
    const result = await sql<Row>`
      SELECT t.* FROM ${sql.table(table)} t
      WHERE EXISTS (
        SELECT 1 FROM ${sql.table(parent)} p
        WHERE p.${sql.id(parentKey)} = t.${sql.id(childKey)}
          AND p.${sql.id('tenant_id')} = ${tenantId}
      )
    `.execute(db);
    return result.rows;
  }

  /**
   * Build the CSV + JSON files for one table's rows, applying the
   * column exclusions. Returns the two files (CSV first, JSON second).
   */
  buildTableFiles(table: string, columns: string[], rows: Row[]): ExportedFile[] {
    const excluded = new Set(EXPORT_COLUMN_EXCLUSIONS[table] ?? []);
    const keptColumns = columns.filter((column) => !excluded.has(column));
    const keptRows = rows.map((row) => {
      const kept: Row = {};
      for (const column of keptColumns) {
        kept[column] = row[column];
      }
      return kept;
    });
    const csv = rowsToCsv(keptColumns, keptRows);
    const json = rowsToJson(keptRows);
    return [
      {
        fileName: `${table}.csv`,
        tableName: table,
        rowCount: rows.length,
        sha256Checksum: sha256Hex(csv),
        content: csv,
      },
      {
        fileName: `${table}.json`,
        tableName: table,
        rowCount: rows.length,
        sha256Checksum: sha256Hex(json),
        content: json,
      },
    ];
  }

  /** manifest.json content for a set of exported files. */
  buildManifestJson(jobId: string, tenantId: string, files: ExportedFile[], generatedAt: Date): string {
    const manifest = {
      export_job_id: jobId,
      tenant_id: tenantId,
      generated_at: generatedAt.toISOString(),
      files: files.map((file) => ({
        file_name: file.fileName,
        table_name: file.tableName,
        row_count: file.rowCount,
        sha256_checksum: file.sha256Checksum,
      })),
    };
    return JSON.stringify(manifest, null, 2) + '\n';
  }

  /**
   * Single-click full export (Arch-01 §4.3). Creates the export_jobs
   * row, writes one CSV + one JSON per tenant table plus manifest.json,
   * records the manifest rows, and marks the job completed. The
   * export does NOT end the export window early and is regenerable.
   */
  async runFullExport(tenantId: string, requestedByUserId: string | null = null): Promise<ExportResult> {
    const tenant = await this.db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant === undefined) {
      throw new NotFoundException('Tenant not found');
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
      const files: ExportedFile[] = [];
      let totalRows = 0;
      for (const spec of RESTORE_ORDER) {
        const columns = await this.fetchTableColumns(this.db, spec.table);
        const rows = await this.fetchTenantTableRows(this.db, spec, tenantId);
        const tableFiles = this.buildTableFiles(spec.table, columns, rows);
        files.push(...tableFiles);
        totalRows += rows.length;
      }

      const generatedAt = new Date();
      const manifestContent = this.buildManifestJson(job.id, tenantId, files, generatedAt);
      const manifest: ManifestEntry[] = files.map((file) => ({
        file_name: file.fileName,
        table_name: file.tableName,
        row_count: file.rowCount,
        sha256_checksum: file.sha256Checksum,
      }));

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
            file_count: files.length,
            total_rows: BigInt(totalRows),
            completed_at: generatedAt,
          })
          .where('id', '=', job.id)
          .execute();
      });

      await this.auditService.record(this.db, {
        tenantId,
        userId: requestedByUserId,
        eventType: 'export.completed',
        entityType: 'export_job',
        entityId: job.id,
        payload: { fileCount: files.length, totalRows },
      });

      const filesByName: Record<string, string> = {};
      for (const file of files) {
        filesByName[file.fileName] = file.content;
      }
      filesByName['manifest.json'] = manifestContent;
      return { jobId: job.id, files: filesByName, manifest, totalRows, fileCount: files.length };
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
  // Backup / restore verification (G-E)
  // ------------------------------------------------------------------

  /**
   * Restore a snapshot (an ExportResult's files) into a fresh
   * database and reconcile it against the LIVE source tenant:
   * row counts, ledger sums and Z-report totals. `restoreDb` must
   * be a fresh PGlite instance with all migrations applied and no
   * tenant data; `sourceDb` is the live database the snapshot was
   * exported from. Returns pass/fail with every discrepancy named.
   * Never touches the live database (reads only).
   *
   * Why reconcile against live, not against the snapshot itself?
   * A restore that faithfully reproduces a tampered snapshot would
   * pass a snapshot-vs-restore comparison — the tamper is only
   * visible against independent truth (the live data, plus the
   * manifest checksums, which catch files modified after export).
   */
  async verifyBackupRestore(
    snapshot: ExportResult,
    restoreDb: Kysely<DB>,
    sourceDb: Kysely<DB>,
    tenantId: string,
  ): Promise<BackupRestoreReport> {
    const discrepancies: string[] = [];
    let tablesChecked = 0;
    let rowsRestored = 0;

    // Parse the snapshot's JSON files, verifying each file against
    // the manifest checksum first (a file modified after export is
    // itself a discrepancy, even if it still parses).
    const snapshotRows = new Map<string, Row[]>();
    for (const entry of snapshot.manifest) {
      if (!entry.file_name.endsWith('.json')) {
        continue;
      }
      const content = snapshot.files[entry.file_name];
      if (content !== undefined && sha256Hex(content) !== entry.sha256_checksum) {
        discrepancies.push(
          `${entry.file_name}: checksum mismatch (file was modified after export; manifest=${entry.sha256_checksum.slice(0, 12)}…)`,
        );
      }
    }
    for (const spec of RESTORE_ORDER) {
      const content = snapshot.files[`${spec.table}.json`];
      if (content === undefined) {
        discrepancies.push(`${spec.table}: snapshot is missing ${spec.table}.json`);
        continue;
      }
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        discrepancies.push(`${spec.table}: ${spec.table}.json is not a JSON array`);
        continue;
      }
      snapshotRows.set(spec.table, parsed as Row[]);
    }

    // Restore in parents-first order. A snapshot that cannot be
    // restored (e.g. a tampered file that breaks a foreign key) is
    // a failed verification, not a crash: record the failure as a
    // named discrepancy and continue reconciling the rest.
    for (const spec of RESTORE_ORDER) {
      const rows = snapshotRows.get(spec.table) ?? [];
      tablesChecked += 1;
      try {
        await this.insertRows(restoreDb, spec.table, rows);
        rowsRestored += rows.length;
      } catch (error) {
        discrepancies.push(
          `${spec.table}: restore failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    // Reconcile row counts.
    //
    // Two kinds of truth, by table:
    //  - Most tables: live tenant rows vs restored rows. (The
    //    restore database holds only this tenant's data, so a plain
    //    COUNT(*) there is the tenant's count.)
    //  - export_jobs, export_manifests, audit_events: SNAPSHOT rows
    //    vs restored rows. These three are the export's own
    //    bookkeeping, written AFTER the table fetch (the manifest
    //    rows are inserted and the job is marked completed and the
    //    export.completed audit event is recorded once the files
    //    exist) — so live has necessarily moved on by exactly those
    //    rows and a live comparison would always fail. For these
    //    tables the restore must faithfully reproduce the snapshot
    //    files, and the manifest checksums (verified above) are what
    //    catch file tampering.
    const SELF_REFERENTIAL_TABLES = new Set(['export_jobs', 'export_manifests', 'audit_events']);
    for (const spec of RESTORE_ORDER) {
      const counted = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM ${sql.table(spec.table)}
      `.execute(restoreDb);
      const restored = Number(counted.rows[0]?.count ?? '0');
      if (SELF_REFERENTIAL_TABLES.has(spec.table)) {
        const expected = snapshotRows.get(spec.table)?.length ?? 0;
        if (restored !== expected) {
          discrepancies.push(
            `${spec.table}: row count mismatch (snapshot=${expected}, restored=${restored})`,
          );
        }
        continue;
      }
      const live = await this.countTenantTableRows(sourceDb, spec, tenantId);
      if (restored !== live) {
        discrepancies.push(
          `${spec.table}: row count mismatch (live=${live}, restored=${restored})`,
        );
      }
    }

    // Reconcile ledger sums (live sums vs restored sums).
    for (const check of LEDGER_SUM_CHECKS) {
      const live = await sql<{ total: string | null }>`
        SELECT COALESCE(SUM(${sql.id(check.column)}), 0)::text AS total
        FROM ${sql.table(check.table)}
        WHERE ${sql.id('tenant_id')} = ${tenantId}
      `.execute(sourceDb);
      const liveSum = BigInt(live.rows[0]?.total ?? '0');
      const restored = await sql<{ total: string | null }>`
        SELECT COALESCE(SUM(${sql.id(check.column)}), 0)::text AS total
        FROM ${sql.table(check.table)}
      `.execute(restoreDb);
      const restoredSum = BigInt(restored.rows[0]?.total ?? '0');
      if (liveSum !== restoredSum) {
        discrepancies.push(
          `${check.table}.${check.column} sum mismatch (live=${liveSum.toString()}, restored=${restoredSum.toString()})`,
        );
      }
    }

    // Reconcile Z-report totals per report (live vs restored).
    const liveZ = await sql<Row>`
      SELECT * FROM z_reports WHERE ${sql.id('tenant_id')} = ${tenantId}
    `.execute(sourceDb);
    for (const row of liveZ.rows) {
      const id = row['id'];
      if (typeof id !== 'string') {
        continue;
      }
      const restored = await sql<{ gross: string; net: string; vat: string }>`
        SELECT gross_pence::text AS gross, net_pence::text AS net, vat_pence::text AS vat
        FROM z_reports WHERE id = ${id}
      `.execute(restoreDb);
      const found = restored.rows[0];
      if (found === undefined) {
        discrepancies.push(`z_reports: report ${id} missing after restore`);
        continue;
      }
      for (const [column, key] of [
        ['gross_pence', 'gross'],
        ['net_pence', 'net'],
        ['vat_pence', 'vat'],
      ] as const) {
        const expected = toBigInt(row[column]).toString();
        if (found[key] !== expected) {
          discrepancies.push(
            `z_reports ${id} ${column} mismatch (live=${expected}, restored=${found[key]})`,
          );
        }
      }
    }

    return { pass: discrepancies.length === 0, discrepancies, tablesChecked, rowsRestored };
  }

  /**
   * Convenience: export a tenant, then verify the snapshot restores
   * cleanly into `restoreDb` (reconciled against this live database).
   * Returns the snapshot and the report.
   */
  async snapshotAndVerify(
    tenantId: string,
    restoreDb: Kysely<DB>,
    requestedByUserId: string | null = null,
  ): Promise<{ snapshot: ExportResult; report: BackupRestoreReport }> {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    const snapshot = await this.runFullExport(tenantId, requestedByUserId);
    const report = await this.verifyBackupRestore(snapshot, restoreDb, this.db, tenantId);
    return { snapshot, report };
  }

  private async insertRows(db: Kysely<DB>, table: string, rows: Row[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const selfRef = SELF_REF_COLUMNS[table];
    const sorted =
      selfRef === undefined
        ? rows
        : [...rows].sort((a, b) => {
            const aNull = a[selfRef] === null || a[selfRef] === undefined ? 0 : 1;
            const bNull = b[selfRef] === null || b[selfRef] === undefined ? 0 : 1;
            return aNull - bNull;
          });
    const valueTuples = sorted.map((row) =>
      sql`(${sql.join(columns.map((column) => toDbValue(table, column, row[column])) )})`,
    );
    await sql`
      INSERT INTO ${sql.table(table)} (${sql.join(columns.map((column) => sql.id(column)))})
      VALUES ${sql.join(valueTuples, sql`, `)}
    `.execute(db);
  }
}

/** Sum helper: JSON numbers/strings/null -> bigint (null/undefined -> 0). */
function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return 0n;
}

/** Convert a snapshot JSON value into a query parameter for restore. */
function toDbValue(table: string, column: string, value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    // jsonb columns must arrive as a JSON string; every other object
    // value in the snapshot is already a plain JSON value.
    return JSON_COLUMNS.has(`${table}.${column}`) ? JSON.stringify(value) : value;
  }
  return value;
}
