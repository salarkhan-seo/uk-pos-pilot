/**
 * Tenant Exit & 30-Day Export Portal (Build-04 Objective 2).
 *
 * State machine (ExitService, D-11 block until resolved):
 *   active → termination_requested → export_window (30 days, read-only)
 *   → hard_delete_scheduled → deleted
 *
 * The portal's core job is to SURFACE the D-11 blockers: when
 * termination is requested while open register sessions or
 * pending/unknown payment attempts exist, the server answers 409 with
 * the EXACT blocking ids (TerminationBlockedError). The portal renders
 * those ids so the operator can resolve each one — it never hides them
 * behind a generic "blocked" message.
 *
 * The portal also:
 *  - initiates termination into the 30-day read-only export window;
 *  - triggers the single-click full export and verifies its
 *    manifest.json SHA-256 checksums (see finance/integrity.ts);
 *  - monitors the statutory 6-year VAT archive separation: hard
 *    deletion first separates the PII-stripped VAT archive
 *    (GdprService.buildStatutoryArchive — tables: vat_periods,
 *    vat_period_lines, orders, order_lines, order_tenders,
 *    payment_attempts, refunds) and only then hard-deletes the
 *    remaining tenant rows, verifying zero rows remain and retaining
 *    only the tenant tombstone. The archive is a checksummed JSON
 *    snapshot; persisting it to compliance storage is a coordinator
 *    follow-up (Build-03 honest limit) — the portal shows the archive
 *    status as reported by the API, it does not claim storage itself.
 *
 * ROUTE STATUS: all exit/export routes are not-exposed (services exist,
 * no controller). The live client throws NotExposedError; the fake
 * implements the full flow, including the D-11 409.
 */
import { TerminationBlockedError } from '../api/errors';
import type { AdminApiClient } from '../api/client';
import type { ExitStatusView, ExportResultView } from '../api/types';
import { verifyExportManifest, type ManifestReport } from './integrity';

export const EXPORT_WINDOW_DAYS = 30;
export const STATUTORY_VAT_ARCHIVE_YEARS = 6;

export const STATUTORY_ARCHIVE_TABLES = [
  'vat_periods',
  'vat_period_lines',
  'orders',
  'order_lines',
  'order_tenders',
  'payment_attempts',
  'refunds',
] as const;

export interface ExitPortalView {
  status: ExitStatusView;
  readOnly: boolean;
  blockers: { openSessionIds: string[]; blockingPaymentAttemptIds: string[] };
  exportWindowEndsAt: string | null;
}

export function toExitPortalView(status: ExitStatusView): ExitPortalView {
  return {
    status,
    readOnly: status.status !== 'active' && status.status !== 'termination_requested',
    blockers: {
      openSessionIds: status.openSessionIds,
      blockingPaymentAttemptIds: status.blockingPaymentAttemptIds,
    },
    exportWindowEndsAt: status.exportWindowEndsAt,
  };
}

export class ExitPortal {
  constructor(private readonly api: AdminApiClient) {}

  async status(): Promise<ExitPortalView> {
    return toExitPortalView(await this.api.getExitStatus());
  }

  /**
   * Request termination. On a D-11 block the 409's exact blocking ids
   * are re-thrown as TerminationBlockedError (not swallowed, not
   * generalised) so the caller can render every blocking id.
   */
  async requestTermination(): Promise<ExitPortalView> {
    try {
      return toExitPortalView(await this.api.requestTermination());
    } catch (error) {
      if (error instanceof TerminationBlockedError) {
        throw error;
      }
      throw error;
    }
  }

  async beginExportWindow(): Promise<ExitPortalView> {
    return toExitPortalView(await this.api.beginExportWindow());
  }

  /** Single-click full export + manifest checksum verification. */
  async runFullExport(): Promise<{ result: ExportResultView; manifest: ManifestReport }> {
    const result = await this.api.runFullExport();
    const manifest = verifyExportManifest(result.manifest, result.files);
    return { result, manifest };
  }

  async scheduleHardDelete(): Promise<ExitPortalView> {
    return toExitPortalView(await this.api.scheduleHardDelete());
  }
}
