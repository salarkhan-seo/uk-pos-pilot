/**
 * Audit hash-chain integrity verifier + export manifest verifier.
 *
 * Both verifiers use the SHARED KERNEL — never a local reimplementation
 * (D-AW-07):
 *  - Audit chain: `verifyHashChain` from `@uk-pos/shared-kernel`
 *    (sha256(prev_hash + canonical JSON(payload))). The dashboard fetches
 *    audit events via GET /v1/audit-events (live) and verifies the chain
 *    exactly as AuditService.verifyChain does server-side. A tampered
 *    payload, a tampered hash, a reordered event or a deleted event
 *    breaks the chain at the first affected link, which the verifier
 *    reports with its index and reason.
 *  - Export manifest: `sha256Hex` from the shared kernel recomputes
 *    each file's checksum and compares it with manifest.json's
 *    `sha256_checksum` entry. A mismatch means the export was altered
 *    after it was produced.
 */
import { sha256Hex, verifyHashChain, type ChainVerification } from '@uk-pos/shared-kernel';
import type { AdminApiClient } from '../api/client';
import type { AuditEventView, ExportManifestEntryView } from '../api/types';

export interface AuditChainReport {
  eventCount: number;
  verification: ChainVerification;
}

export function verifyAuditEvents(events: AuditEventView[]): AuditChainReport {
  const verification = verifyHashChain(
    events.map((event) => ({
      payload: event.payload,
      prevHash: event.prev_hash,
      eventHash: event.event_hash,
    })),
  );
  return { eventCount: events.length, verification };
}

export interface ManifestCheck {
  fileName: string;
  expectedChecksum: string;
  actualChecksum: string;
  ok: boolean;
}

export interface ManifestReport {
  filesChecked: number;
  ok: boolean;
  checks: ManifestCheck[];
  missingFromExport: string[];
}

/**
 * Verify a full-export manifest against the exported file contents.
 * `files` maps file name → file content (as produced by
 * ExportService.runFullExport; manifest.json itself is excluded from
 * the checksum list by the exporter).
 */
export function verifyExportManifest(
  manifest: ExportManifestEntryView[],
  files: Record<string, string>,
): ManifestReport {
  const checks: ManifestCheck[] = [];
  const missingFromExport: string[] = [];
  for (const entry of manifest) {
    const content = files[entry.file_name];
    if (content === undefined) {
      missingFromExport.push(entry.file_name);
      continue;
    }
    const actualChecksum = sha256Hex(content);
    checks.push({
      fileName: entry.file_name,
      expectedChecksum: entry.sha256_checksum,
      actualChecksum,
      ok: actualChecksum === entry.sha256_checksum,
    });
  }
  return {
    filesChecked: checks.length,
    ok: checks.every((c) => c.ok) && missingFromExport.length === 0,
    checks,
    missingFromExport,
  };
}

export class IntegrityController {
  constructor(private readonly api: AdminApiClient) {}

  /** Fetch the tenant's audit events and verify the hash chain. */
  async verifyAuditChain(opts: { limit?: number } = {}): Promise<AuditChainReport> {
    const events = await this.api.listAuditEvents({ limit: opts.limit ?? 200 });
    // listEvents returns newest first; verification needs creation order.
    const inCreationOrder = [...events].reverse();
    return verifyAuditEvents(inCreationOrder);
  }
}
