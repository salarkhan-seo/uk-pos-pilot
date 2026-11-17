/**
 * Finance view-models: Z-Reports & Corrections, VAT Period closure,
 * Settlement & Dispute Reconciliation (Build-04 Objective 2).
 *
 * All three are read/compute views over ReportingService. The service
 * is the authority (immutable Z-reports, VAT restatement never
 * rewriting a closed period, T+3 settlement with reserve holds and
 * dispute debits as distinct lines, fee-adjustment entries when settled
 * fees differ from estimates). The dashboard shapes requests and
 * renders results; it never recomputes a Z-report total, a VAT figure
 * or a settlement from raw orders.
 *
 * ROUTE STATUS: ReportingService has no controller — every method here
 * is a not-exposed route (see route-table.ts). The live client throws
 * NotExposedError; the fake implements them so the views are testable.
 *
 * Corrections rule (ReportingService.recordCorrection): a post-close
 * error is a manager-approved `z_report_corrections` row, carried
 * forward into the NEXT Z-report — never an edit to the issued report.
 */
import type { AdminApiClient } from '../api/client';
import type { SettlementView, VatPeriodView, ZReportSummaryView } from '../api/types';

export const SETTLEMENT_LAG_DAYS = 3;

export interface SettlementPayoutInput {
  providerReference: string;
  settlementDate: string;
  grossPence: string;
  feePence: string;
  reserveHoldPence: string;
  disputeDebitPence: string;
}

export function settlementSummary(view: SettlementView): string {
  const base =
    `Business date ${view.businessDate} settles ${view.settlementDate} (T+${SETTLEMENT_LAG_DAYS}): ` +
    `card gross ${view.cardGrossPence}p, settled fees ${view.settledFeePence}p, ` +
    `reserve holds ${view.reserveHoldTotalPence}p, dispute debits ${view.disputeDebitTotalPence}p, ` +
    `expected net payout ${view.expectedNetPayoutPence}p.`;
  return view.status === 'reconciled' ? `${base} Reconciled.` : `${base} DISCREPANCY: ${view.discrepancyReason ?? 'no reason given'}.`;
}

export class FinanceConsole {
  constructor(private readonly api: AdminApiClient) {}

  async getZReport(zReportId: string): Promise<ZReportSummaryView> {
    return this.api.getZReport(zReportId);
  }

  /** Record a correction (manager approval required; carried to the next Z-report). */
  async recordCorrection(zReportId: string, input: { correctionType: string; amountPence: string; reason: string; approvalEventId: string }): Promise<{ id: string }> {
    if (input.reason.trim() === '') {
      throw new Error('A correction reason is required.');
    }
    if (input.approvalEventId.trim() === '') {
      throw new Error('A manager approval_event_id is required for a Z-report correction.');
    }
    return this.api.recordZReportCorrection(zReportId, input);
  }

  async closeVatPeriod(vatPeriodId: string): Promise<VatPeriodView> {
    return this.api.closeVatPeriod(vatPeriodId);
  }

  async reconcileSettlement(businessDate: string, payouts: SettlementPayoutInput[]): Promise<SettlementView> {
    if (payouts.length === 0) {
      throw new Error('At least one payout is required to reconcile a settlement.');
    }
    return this.api.reconcileSettlement({ businessDate, payouts });
  }
}
