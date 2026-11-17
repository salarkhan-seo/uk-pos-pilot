/**
 * Statutory VAT archive helpers (Build-05, Objective 2; Arch-01 §6.4).
 *
 * Pure functions + small disk I/O, kept out of GdprService so the
 * hashing / retention / verification rules are unit-testable without
 * a database:
 *
 *  - Retention is 6 calendar years from the archive date (VAT Notice
 *    700/21). `retentionUntilFor` adds 6 years on the calendar, so
 *    an archive taken 2026-11-13 is retained until 2032-11-13.
 *  - The archive SHA-256 is taken over a CANONICAL JSON encoding
 *    (object keys sorted recursively), so the hash is reproducible
 *    from the stored payload no matter what order the keys were
 *    written in. The same canonical encoding is used for the
 *    on-disk bundle and for the database payload, so one hash
 *    verifies both.
 *  - The bundle directory defaults to
 *    <pilot-root>/data/statutory-archives (found by walking up from
 *    the working directory to the pnpm workspace root) and is
 *    overridable with STATUTORY_ARCHIVE_DIR. Tests override it with
 *    GdprService.setArchiveDir().
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExportResult } from './export.service';

/** Statutory VAT retention (VAT Notice 700/21): 6 years. */
export const STATUTORY_RETENTION_YEARS = 6;

export function retentionUntilFor(archivedAt: Date): Date {
  const until = new Date(archivedAt);
  until.setUTCFullYear(until.getUTCFullYear() + STATUTORY_RETENTION_YEARS);
  return until;
}

/** Canonical JSON: object keys sorted recursively, so hashing is order-independent. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 of the canonical JSON encoding of a value. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export interface StatutoryArchiveBundle {
  tenant_id: string;
  job_id: string;
  archived_at: string;
  retention_until: string;
  total_rows: number;
  file_count: number;
  manifest: ExportResult['manifest'];
  files: ExportResult['files'];
}

export interface BuiltStatutoryArchive {
  bundle: StatutoryArchiveBundle;
  /** SHA-256 over the canonical JSON of the bundle — the archive's single checksum. */
  archiveSha256: string;
  retentionUntil: Date;
  rowCounts: Record<string, number>;
}

export function buildStatutoryArchiveBundle(
  tenantId: string,
  jobId: string,
  archive: ExportResult,
  archivedAt: Date,
): BuiltStatutoryArchive {
  const retentionUntil = retentionUntilFor(archivedAt);
  const rowCounts: Record<string, number> = {};
  for (const entry of archive.manifest) {
    rowCounts[entry.table_name] = entry.row_count;
  }
  const bundle: StatutoryArchiveBundle = {
    tenant_id: tenantId,
    job_id: jobId,
    archived_at: archivedAt.toISOString(),
    retention_until: retentionUntil.toISOString(),
    total_rows: archive.totalRows,
    file_count: archive.fileCount,
    manifest: archive.manifest,
    files: archive.files,
  };
  return { bundle, archiveSha256: canonicalSha256(bundle), retentionUntil, rowCounts };
}

/** Default on-disk archive directory: <pilot-root>/data/statutory-archives. */
export function defaultStatutoryArchiveDir(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, 'data', 'statutory-archives');
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return join(startDir, 'data', 'statutory-archives');
    }
    dir = parent;
  }
}

export function statutoryArchiveDir(): string {
  return process.env.STATUTORY_ARCHIVE_DIR ?? defaultStatutoryArchiveDir();
}

export function bundleFileName(jobId: string): string {
  return `${jobId}-statutory-archive.json`;
}

/** Write the bundle (canonical JSON) to <dir>/<tenantId>/<jobId>-statutory-archive.json. Returns the full path. */
export async function writeArchiveBundle(
  dir: string,
  tenantId: string,
  jobId: string,
  bundle: StatutoryArchiveBundle,
): Promise<string> {
  const tenantDir = join(dir, tenantId);
  await mkdir(tenantDir, { recursive: true });
  const path = join(tenantDir, bundleFileName(jobId));
  await writeFile(path, canonicalJson(bundle), 'utf8');
  return path;
}

/** Verify an on-disk bundle file against the expected SHA-256. False when the file is missing or differs. */
export async function verifyArchiveBundleFile(
  path: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    const content = await readFile(path, 'utf8');
    return sha256Hex(content) === expectedSha256;
  } catch {
    return false;
  }
}
