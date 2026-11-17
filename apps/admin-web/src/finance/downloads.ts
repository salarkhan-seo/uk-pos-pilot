/**
 * 1-click Xero / QBO reproducible CSV downloads (Build-04 Objective 2).
 *
 * The CSVs are produced server-side by ReportingService
 * (exportZReportCsv / exportVatPeriodCsv) under the exact Arch-02 §5.3
 * column contract (integer pence, `GBP`, Europe/London dates) and are
 * reproducible — re-running an export yields identical content. The
 * dashboard's job is only to trigger the right export endpoint for the
 * chosen report and hand the returned text to the browser download;
 * it never builds CSV content itself.
 *
 * ROUTE STATUS (13 Nov 2026): ReportingService has NO controller —
 * `reporting.exportZReportCsv` / `reporting.exportVatPeriodCsv` are
 * not-exposed routes (see route-table.ts). The live client therefore
 * throws NotExposedError until the coordinator adds them; the fake
 * client implements them so the download flow (right endpoint, right
 * id, filename, reproducibility check) is testable today.
 * The download controller records which endpoint it triggered, so a
 * test can assert the Z-report button never triggers the VAT endpoint.
 */
import type { AdminApiClient } from '../api/client';
import { Z_REPORT_CSV_COLUMNS, VAT_PERIOD_CSV_COLUMNS } from './csv-columns';

export type CsvKind = 'z-report' | 'vat-period';

export interface CsvDownload {
  kind: CsvKind;
  /** The route key that was triggered. */
  routeKey: string;
  /** The report/period id the export was run for. */
  reportId: string;
  /** Suggested download filename. */
  filename: string;
  content: string;
  /** Header row of the returned CSV, for the reproducibility check. */
  header: string;
}

export function csvFilename(kind: CsvKind, reportId: string): string {
  return kind === 'z-report' ? `z-report-${reportId}.csv` : `vat-period-${reportId}.csv`;
}

export function csvHeaderLine(content: string): string {
  return content.split('\n')[0] ?? '';
}

/** The expected header for each CSV kind, from the Arch-02 §5.3 contract. */
export function expectedCsvHeader(kind: CsvKind): string {
  return kind === 'z-report' ? Z_REPORT_CSV_COLUMNS.join(',') : VAT_PERIOD_CSV_COLUMNS.join(',');
}

export class CsvDownloadController {
  constructor(private readonly api: AdminApiClient) {}

  async download(kind: CsvKind, reportId: string): Promise<CsvDownload> {
    const content =
      kind === 'z-report' ? await this.api.exportZReportCsv(reportId) : await this.api.exportVatPeriodCsv(reportId);
    const routeKey = kind === 'z-report' ? 'reporting.exportZReportCsv' : 'reporting.exportVatPeriodCsv';
    return {
      kind,
      routeKey,
      reportId,
      filename: csvFilename(kind, reportId),
      content,
      header: csvHeaderLine(content),
    };
  }

  /** Reproducibility check: two exports of the same report must be byte-identical. */
  async verifyReproducible(kind: CsvKind, reportId: string): Promise<{ reproducible: boolean; first: CsvDownload; second: CsvDownload }> {
    const first = await this.download(kind, reportId);
    const second = await this.download(kind, reportId);
    return { reproducible: first.content === second.content, first, second };
  }
}
