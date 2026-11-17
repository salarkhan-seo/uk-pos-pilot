/**
 * SimulatedStripeTerminalAdapter — deterministic, in-memory stand-in
 * for the Stripe Terminal direct adapter (Build-03 Objective 2; D-05
 * Option A, Arch-03).
 *
 * SIMULATED ONLY. This adapter makes NO network call: it imports nothing
 * from 'node:http', 'node:https', 'fetch', or any HTTP client, and its
 * outcomes come ONLY from the scripted queues below (asserted by test).
 * A real Stripe adapter must implement the same PaymentAdapter interface
 * and is a later build — provider eligibility in writing first (V4).
 *
 * Scripting (tests drive every outcome explicitly):
 *  - scriptOutcome / scriptOutcomes — the next createAttempt outcome(s),
 *    consumed in order: 'approved' | 'declined' | 'unknown' | 'pending'.
 *    With no scripted outcome the attempt stays 'pending': the adapter
 *    never invents an approval.
 *  - scriptQueryResult — what queryStatus returns for an attempt id,
 *    provider reference, or metadata custom id (the attempt's
 *    idempotency key). Unscripted queries answer 'unknown': the provider
 *    has no answer, and the attempt must stay unknown (W-12).
 *  - scriptRefundOutcome / scriptRefundOutcomes — the next refund
 *    outcome(s). Unscripted refunds stay 'pending' (queued).
 *
 * Determinism: provider references are sequential (`pi_sim_1`,
 * `re_sim_1`, ...) from an in-memory counter, never random.
 * Settlement: approved sales are recorded per business date and the
 * payout schedule reports T+3 (Stripe UK standard, T-06 §8.4).
 */

import type {
  AdapterRefundInput,
  AdapterRefundOutcome,
  AdapterRefundResult,
  CreateAttemptInput,
  CreateAttemptResult,
  PaymentAdapter,
  PayoutSchedule,
  ProviderOutcomeStatus,
  ProviderWebhookEvent,
  QueryStatusInput,
  QueryStatusResult,
} from './payment-adapter.interface';

/** Business-date arithmetic: add calendar days to a YYYY-MM-DD date. */
export function addDaysToBusinessDate(businessDate: string, days: number): string {
  const [year, month, day] = businessDate.split('-').map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export class SimulatedStripeTerminalAdapter implements PaymentAdapter {
  readonly provider = 'stripe' as const;

  private outcomeQueue: ProviderOutcomeStatus[] = [];
  private queryResults = new Map<string, QueryStatusResult>();
  private refundOutcomeQueue: AdapterRefundResult[] = [];
  private seenEventIds = new Set<string>();
  private approvedByBusinessDate = new Map<string, bigint>();
  private referenceCounter = 0;

  /** Queue one createAttempt outcome (consumed in order). */
  scriptOutcome(outcome: ProviderOutcomeStatus): void {
    this.outcomeQueue.push(outcome);
  }

  /** Queue several createAttempt outcomes (consumed in order). */
  scriptOutcomes(outcomes: ProviderOutcomeStatus[]): void {
    this.outcomeQueue.push(...outcomes);
  }

  /**
   * Script what queryStatus returns for a key — the attempt id, a
   * provider reference, or the metadata custom id (idempotency key).
   */
  scriptQueryResult(key: string, result: QueryStatusResult): void {
    this.queryResults.set(key, result);
  }

  /** Queue one refund outcome (consumed in order). */
  scriptRefundOutcome(outcome: AdapterRefundOutcome, failureReason?: string): void {
    this.refundOutcomeQueue.push({
      outcome,
      providerReference: null,
      failureReason: failureReason ?? null,
    });
  }

  /** Queue several refund outcomes (consumed in order). */
  scriptRefundOutcomes(outcomes: AdapterRefundOutcome[]): void {
    for (const outcome of outcomes) {
      this.scriptRefundOutcome(outcome);
    }
  }

  /** Clear all scripted state (fresh adapter between tests). */
  reset(): void {
    this.outcomeQueue = [];
    this.queryResults.clear();
    this.refundOutcomeQueue = [];
    this.seenEventIds.clear();
    this.approvedByBusinessDate.clear();
    this.referenceCounter = 0;
  }

  async createAttempt(input: CreateAttemptInput): Promise<CreateAttemptResult> {
    const outcome = this.outcomeQueue.shift() ?? 'pending';
    if (outcome === 'approved') {
      const providerReference = this.nextPaymentReference();
      this.recordApprovedSale(input.businessDate, input.amountPence);
      return { status: 'approved', providerReference };
    }
    if (outcome === 'declined') {
      return { status: 'declined', providerReference: null };
    }
    // 'unknown' (timeout / disconnect) and 'pending' carry no reference:
    // the provider has not confirmed anything.
    return { status: outcome, providerReference: null };
  }

  async queryStatus(input: QueryStatusInput): Promise<QueryStatusResult> {
    const keys = [input.paymentAttemptId, input.providerReference, input.metadataCustomId].filter(
      (key): key is string => key !== undefined && key !== null && key !== '',
    );
    for (const key of keys) {
      const scripted = this.queryResults.get(key);
      if (scripted !== undefined) {
        return scripted;
      }
    }
    // No scripted answer: the provider has no answer — the attempt stays
    // unknown (W-12: never assume approved or declined).
    return { status: 'unknown', providerReference: null };
  }

  async refund(input: AdapterRefundInput): Promise<AdapterRefundResult> {
    const scripted = this.refundOutcomeQueue.shift();
    if (scripted === undefined) {
      return { outcome: 'pending', providerReference: null, failureReason: null };
    }
    if (scripted.outcome === 'completed') {
      return {
        outcome: 'completed',
        providerReference: this.nextRefundReference(),
        failureReason: null,
      };
    }
    if (scripted.outcome === 'failed_insufficient_balance') {
      return {
        outcome: 'failed_insufficient_balance',
        providerReference: null,
        failureReason: 'insufficient_balance',
      };
    }
    if (scripted.outcome === 'failed_provider_unavailable') {
      return {
        outcome: 'failed_provider_unavailable',
        providerReference: null,
        failureReason: 'provider_unavailable',
      };
    }
    if (scripted.outcome === 'failed') {
      return {
        outcome: 'failed',
        providerReference: null,
        failureReason: scripted.failureReason ?? 'refund_failed',
      };
    }
    return { outcome: 'pending', providerReference: null, failureReason: null };
  }

  async ingestWebhook(event: ProviderWebhookEvent): Promise<{ duplicate: boolean; eventId: string }> {
    if (this.seenEventIds.has(event.eventId)) {
      return { duplicate: true, eventId: event.eventId };
    }
    this.seenEventIds.add(event.eventId);
    return { duplicate: false, eventId: event.eventId };
  }

  recordApprovedSale(businessDate: string, amountPence: bigint): void {
    const current = this.approvedByBusinessDate.get(businessDate) ?? 0n;
    this.approvedByBusinessDate.set(businessDate, current + amountPence);
  }

  payoutScheduleFor(businessDate: string): PayoutSchedule {
    return {
      businessDate,
      settlementDate: addDaysToBusinessDate(businessDate, 3),
      grossPence: this.approvedByBusinessDate.get(businessDate) ?? 0n,
    };
  }

  private nextPaymentReference(): string {
    this.referenceCounter += 1;
    return `pi_sim_${this.referenceCounter}`;
  }

  private nextRefundReference(): string {
    this.referenceCounter += 1;
    return `re_sim_${this.referenceCounter}`;
  }
}
