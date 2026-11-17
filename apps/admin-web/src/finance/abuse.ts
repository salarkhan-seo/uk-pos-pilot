/**
 * Cashier Discount / Comp / Void abuse reports (Build-04 Objective 2).
 *
 * The report is an AGGREGATION of the API's audit data — the dashboard
 * never edits audit events and never infers abuse from anything else.
 * Source: GET /v1/audit-events (live). The audit payloads carry the
 * actor, the action and the amount; the report groups by user and by
 * action and flags counts/amounts above the review thresholds.
 *
 * DESIGN DECISION (D-AW-08): thresholds are dashboard display rules,
 * not server policy — 5+ manual discounts, 3+ voids, or £100+ of
 * comps/discounts in the window each raise a `review` flag for a
 * manager to look at. They do not block anything and are not presented
 * as findings of misconduct.
 *
 * Event types recognised (from ApprovalService / AuditService usage in
 * apps/api): approval events are recorded with event_type values such
 * as `approval.granted` with the action in the payload; void/comp
 * activity is recorded as order events. The aggregator matches on
 * both the event type and the payload's `action` field so either
 * spelling is counted, and it reports unmatched event types in
 * `unrecognised` rather than silently dropping them.
 */
import type { AdminApiClient } from '../api/client';
import type { AuditEventView } from '../api/types';

export const ABUSE_REVIEW_DISCOUNT_COUNT = 5;
export const ABUSE_REVIEW_VOID_COUNT = 3;
export const ABUSE_REVIEW_AMOUNT_PENCE = 10000n; // £100

export type AbuseAction = 'manual_discount' | 'comp' | 'void' | 'refund' | 'other';

export function classifyAbuseAction(event: AuditEventView): AbuseAction {
  const payload = event.payload ?? {};
  const action = typeof payload['action'] === 'string' ? payload['action'] : '';
  const type = event.event_type;
  if (/void/i.test(action) || /void/i.test(type)) return 'void';
  if (/discount/i.test(action) || /discount/i.test(type)) return 'manual_discount';
  if (/comp/i.test(action) || /comp/i.test(type)) return 'comp';
  if (/refund/i.test(action) || /refund/i.test(type)) return 'refund';
  return 'other';
}

export interface UserAbuseSummary {
  userId: string;
  manualDiscountCount: number;
  manualDiscountPence: string;
  compCount: number;
  compPence: string;
  voidCount: number;
  refundCount: number;
  refundPence: string;
  review: boolean;
  reviewReasons: string[];
}

export interface AbuseReport {
  windowEventCount: number;
  users: UserAbuseSummary[];
  unrecognisedEventTypes: string[];
}

function amountOf(event: AuditEventView): bigint {
  const payload = event.payload ?? {};
  const raw = payload['amount_pence'] ?? payload['amountPence'];
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === 'number' && Number.isInteger(raw)) return BigInt(raw);
  return 0n;
}

export function aggregateAbuseReport(events: AuditEventView[]): AbuseReport {
  const byUser = new Map<string, UserAbuseSummary>();
  const unrecognised = new Set<string>();
  for (const event of events) {
    const action = classifyAbuseAction(event);
    if (action === 'other') {
      unrecognised.add(event.event_type);
      continue;
    }
    const userId = event.user_id ?? 'unknown';
    let summary = byUser.get(userId);
    if (summary === undefined) {
      summary = {
        userId,
        manualDiscountCount: 0,
        manualDiscountPence: '0',
        compCount: 0,
        compPence: '0',
        voidCount: 0,
        refundCount: 0,
        refundPence: '0',
        review: false,
        reviewReasons: [],
      };
      byUser.set(userId, summary);
    }
    const amount = amountOf(event);
    if (action === 'manual_discount') {
      summary.manualDiscountCount += 1;
      summary.manualDiscountPence = (BigInt(summary.manualDiscountPence) + amount).toString();
    } else if (action === 'comp') {
      summary.compCount += 1;
      summary.compPence = (BigInt(summary.compPence) + amount).toString();
    } else if (action === 'void') {
      summary.voidCount += 1;
    } else if (action === 'refund') {
      summary.refundCount += 1;
      summary.refundPence = (BigInt(summary.refundPence) + amount).toString();
    }
  }
  const users = [...byUser.values()];
  for (const summary of users) {
    if (summary.manualDiscountCount >= ABUSE_REVIEW_DISCOUNT_COUNT) {
      summary.review = true;
      summary.reviewReasons.push(`${summary.manualDiscountCount} manual discounts in window (threshold ${ABUSE_REVIEW_DISCOUNT_COUNT})`);
    }
    if (summary.voidCount >= ABUSE_REVIEW_VOID_COUNT) {
      summary.review = true;
      summary.reviewReasons.push(`${summary.voidCount} voids in window (threshold ${ABUSE_REVIEW_VOID_COUNT})`);
    }
    const totalGiven = BigInt(summary.manualDiscountPence) + BigInt(summary.compPence);
    if (totalGiven >= ABUSE_REVIEW_AMOUNT_PENCE) {
      summary.review = true;
      summary.reviewReasons.push(`£${(totalGiven / 100n).toString()} given away in discounts/comps (threshold £${(ABUSE_REVIEW_AMOUNT_PENCE / 100n).toString()})`);
    }
  }
  users.sort((a, b) => b.voidCount + b.manualDiscountCount - (a.voidCount + a.manualDiscountCount));
  return { windowEventCount: events.length, users, unrecognisedEventTypes: [...unrecognised] };
}

export class AbuseReportController {
  constructor(private readonly api: AdminApiClient) {}

  async buildReport(opts: { limit?: number } = {}): Promise<AbuseReport> {
    const events = await this.api.listAuditEvents({ limit: opts.limit ?? 200 });
    return aggregateAbuseReport(events);
  }
}
