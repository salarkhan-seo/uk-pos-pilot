/**
 * StandaloneTerminalAdapter — Option C manual-reference fallback
 * (Build-03 Objective 2; D-05 Option C, Arch-03 §5).
 *
 * The standalone terminal is NOT integrated: there is no provider call
 * to make. The till records the card total manually against a physical
 * terminal reference, and the payment is reconciled from that reference
 * (Arch-02 §6.3 resolution path (c)). This adapter therefore never
 * approves anything on its own — approval comes only from
 * recordManualReference, which the manager decision path calls with the
 * reference printed by the physical terminal.
 *
 * Refunds on a standalone terminal are manual by definition: the adapter
 * reports them as failed with failure_reason 'standalone_manual_refund'
 * so the service routes them to manual escalation instead of retrying a
 * provider call that does not exist. Standalone sales settle outside any
 * provider, so the payout schedule reports no provider payout.
 */

import type {
  AdapterRefundInput,
  AdapterRefundResult,
  CreateAttemptInput,
  CreateAttemptResult,
  PaymentAdapter,
  PayoutSchedule,
  ProviderWebhookEvent,
  QueryStatusInput,
  QueryStatusResult,
} from './payment-adapter.interface';
import { addDaysToBusinessDate } from './simulated-stripe-terminal.adapter';

export class StandaloneTerminalAdapter implements PaymentAdapter {
  readonly provider = 'standalone' as const;

  /** Manual references recorded, keyed by idempotency key / attempt id. */
  private manualReferences = new Map<string, string>();
  private seenEventIds = new Set<string>();

  async createAttempt(_input: CreateAttemptInput): Promise<CreateAttemptResult> {
    // No provider call is made. The attempt waits for the operator to
    // key in the physical terminal's reference (recordManualReference).
    return { status: 'pending', providerReference: null };
  }

  /**
   * Record the physical terminal's reference for an attempt. This is
   * the ONLY way a standalone attempt becomes approved — and only a
   * manager-approved decision (W-12 path (c)) may call it.
   */
  recordManualReference(input: {
    key: string;
    terminalReference: string;
  }): { status: 'approved'; providerReference: string } {
    if (input.terminalReference.trim() === '') {
      throw new Error('StandaloneTerminalAdapter: terminalReference must not be empty');
    }
    this.manualReferences.set(input.key, input.terminalReference);
    return { status: 'approved', providerReference: input.terminalReference };
  }

  async queryStatus(input: QueryStatusInput): Promise<QueryStatusResult> {
    const keys = [input.paymentAttemptId, input.providerReference, input.metadataCustomId].filter(
      (key): key is string => key !== undefined && key !== null && key !== '',
    );
    for (const key of keys) {
      const reference = this.manualReferences.get(key);
      if (reference !== undefined) {
        return { status: 'approved', providerReference: reference };
      }
    }
    return { status: 'pending', providerReference: null };
  }

  async refund(_input: AdapterRefundInput): Promise<AdapterRefundResult> {
    // A standalone terminal has no refund API: the manager performs the
    // refund on the physical terminal and records the reference. The
    // service must route this to manual escalation, never retry it.
    return {
      outcome: 'failed',
      providerReference: null,
      failureReason: 'standalone_manual_refund',
    };
  }

  async ingestWebhook(event: ProviderWebhookEvent): Promise<{ duplicate: boolean; eventId: string }> {
    // A standalone terminal sends no webhooks; the dedupe set is kept
    // only so the interface is uniform.
    if (this.seenEventIds.has(event.eventId)) {
      return { duplicate: true, eventId: event.eventId };
    }
    this.seenEventIds.add(event.eventId);
    return { duplicate: false, eventId: event.eventId };
  }

  recordApprovedSale(_businessDate: string, _amountPence: bigint): void {
    // Standalone sales settle outside any provider — no provider payout
    // is ever reported for them.
  }

  payoutScheduleFor(businessDate: string): PayoutSchedule {
    return {
      businessDate,
      settlementDate: addDaysToBusinessDate(businessDate, 3),
      grossPence: 0n,
    };
  }
}
