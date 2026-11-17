/**
 * PaymentAdapter — the provider-agnostic payment adapter interface
 * (Build-03 Objective 2; Arch-02 §6.1, Arch-03).
 *
 * The pilot's state machine (orders, payment_attempts, refunds) is
 * provider-agnostic; only the confirmation path differs per provider
 * (Arch-02 §6.1: Stripe listens on webhooks + status query; SumUp polls
 * + verifies). The adapter translates provider events into the state
 * machine — the till and the server enforce it, never the adapter.
 *
 * Implementations in this module are DETERMINISTIC and SIMULATED only:
 * SimulatedStripeTerminalAdapter (scripted outcome queue, in-memory) and
 * StandaloneTerminalAdapter (manual-reference fallback, Option C). No
 * implementation here makes any network call — a real provider adapter
 * is a later build (V4 provider terms first) and must implement this
 * same interface.
 *
 * Money is integer pence (bigint, D-13) throughout; dates are
 * Europe/London business dates (YYYY-MM-DD strings).
 */

/** Outcome of a card attempt as the provider reports it. */
export type ProviderOutcomeStatus = 'approved' | 'declined' | 'unknown' | 'pending';

export interface CreateAttemptInput {
  /** Client-generated idempotency key (also the metadata custom ID used
   * by the W-12 provider status query, Arch-02 §6.3 step 2). */
  idempotencyKey: string;
  orderId: string;
  amountPence: bigint;
  currency?: string;
  /** Europe/London business date of the sale (settlement ledger key). */
  businessDate: string;
  metadataCustomId?: string;
}

export interface CreateAttemptResult {
  status: ProviderOutcomeStatus;
  /** Provider reference (e.g. PaymentIntent id); null until the provider
   * returns one — offline attempts have a null id until forwarded. */
  providerReference: string | null;
}

export interface QueryStatusInput {
  paymentAttemptId?: string;
  providerReference?: string | null;
  /** Metadata custom identifier — the attempt's idempotency key — used
   * when the provider reference is null (Arch-02 §6.3 step 2). */
  metadataCustomId?: string | null;
}

export interface QueryStatusResult {
  status: ProviderOutcomeStatus;
  providerReference: string | null;
}

/** Refund outcome as the provider reports it (Arch-02 §6.4). */
export type AdapterRefundOutcome =
  | 'completed'
  | 'pending'
  | 'failed_insufficient_balance'
  | 'failed_provider_unavailable'
  | 'failed';

export interface AdapterRefundInput {
  /** The refund's own idempotency key — a retry reuses it, so the
   * provider dedupes instead of double-refunding. */
  idempotencyKey: string;
  paymentAttemptId: string;
  amountPence: bigint;
}

export interface AdapterRefundResult {
  outcome: AdapterRefundOutcome;
  providerReference: string | null;
  failureReason?: string | null;
}

/** A provider webhook event, as received (before reconciliation). */
export interface ProviderWebhookEvent {
  /** Provider event id — the dedupe key (G-A-08: same id twice is one event). */
  eventId: string;
  /** e.g. 'payment_intent.succeeded', 'payment_intent.payment_failed',
   * 'refund.failed', 'payment.dispute.created'. */
  type: string;
  paymentAttemptId?: string;
  orderId?: string;
  providerReference?: string | null;
  refundId?: string | null;
  failureReason?: string | null;
  amountPence?: bigint;
  /** The raw webhook payload, kept for the discrepancy audit record. */
  raw?: Record<string, unknown>;
}

/** Provider payout for one business date (Arch-02 §6.5, G-A-17). */
export interface PayoutSchedule {
  businessDate: string;
  /** Stripe UK standard is T+3 (T-06 §8.4): calendar days, not
   * business days — business-day counting is a V4 question. */
  settlementDate: string;
  grossPence: bigint;
}

export interface PaymentAdapter {
  readonly provider: 'stripe' | 'standalone';

  /** Send a card attempt to the provider/terminal. */
  createAttempt(input: CreateAttemptInput): Promise<CreateAttemptResult>;

  /** Provider status query by attempt id / provider reference /
   * metadata custom ID (W-12 resolution path (a), Arch-02 §6.3). */
  queryStatus(input: QueryStatusInput): Promise<QueryStatusResult>;

  /** Send a linked refund to the provider. */
  refund(input: AdapterRefundInput): Promise<AdapterRefundResult>;

  /**
   * Webhook-ingest entry point. Records the event id and reports
   * whether this delivery is a duplicate (G-A-08). The adapter does
   * NOT reconcile the event against orders — the service does that, so
   * a late webhook can become a discrepancy alert instead of a silent
   * second sale (Arch-02 §6.3 step 6).
   */
  ingestWebhook(event: ProviderWebhookEvent): Promise<{ duplicate: boolean; eventId: string }>;

  /** Record an approved sale against its business date, so the payout
   * schedule can be reported. Called by the service whenever an attempt
   * becomes approved (create, status query, or webhook). */
  recordApprovedSale(businessDate: string, amountPence: bigint): void;

  /** Payout schedule for a business date (T+3 settlement). */
  payoutScheduleFor(businessDate: string): PayoutSchedule;
}
