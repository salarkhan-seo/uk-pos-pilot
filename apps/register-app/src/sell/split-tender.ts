/**
 * Split Tender & W-12 Unknown Payment Screen (Build-04, Objective 1).
 *
 * Multi-tender checkout with a 5-minute timeout from the first tender
 * (SPLIT_TENDER_TIMEOUT_MS). On ANY `unknown` card attempt the
 * register locks on the blocking modal — the exact W-12 message —
 * with the 3 explicit resolution actions:
 *   1. Poll Provider Status
 *   2. Reconcile Terminal
 *   3. Manager Approval to Void/Retry or Record Standalone Reference
 * No goods are handed over and no further tender is accepted while
 * locked. The controller is pure state — the API calls behind actions
 * 1–3 live in PaymentsService (resolveUnknownByProviderQuery /
 * reconcileTerminal / resolveUnknownByManagerDecision).
 */
import { SPLIT_TENDER_TIMEOUT_MS, UNKNOWN_PAYMENT_MESSAGE } from '../constants';

export type TenderKind = 'cash' | 'card' | 'gift_card' | 'store_credit' | 'loyalty_points';

export interface SplitTender {
  kind: TenderKind;
  amountPence: bigint;
  /** Card payment attempt id, when the tender is a card tender. */
  paymentAttemptId?: string | null;
}

export type UnknownResolutionAction =
  | 'poll_provider_status'
  | 'reconcile_terminal'
  | 'manager_void_or_retry'
  | 'manager_standalone_reference';

export const UNKNOWN_RESOLUTION_ACTIONS: ReadonlyArray<{
  action: UnknownResolutionAction;
  label: string;
}> = [
  { action: 'poll_provider_status', label: 'Poll Provider Status' },
  { action: 'reconcile_terminal', label: 'Reconcile Terminal' },
  { action: 'manager_void_or_retry', label: 'Manager Approval to Void/Retry' },
  { action: 'manager_standalone_reference', label: 'Manager Approval to Record Standalone Reference' },
] as const;

export class SplitTenderController {
  private readonly tenders: SplitTender[] = [];
  private firstTenderAtMs: number | null = null;
  private unknownAttemptId: string | null = null;
  private locked = false;

  constructor(
    private readonly totalPence: bigint,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  get total(): bigint {
    return this.totalPence;
  }

  get tenderedTotal(): bigint {
    return this.tenders.reduce((sum, tender) => sum + tender.amountPence, 0n);
  }

  get remaining(): bigint {
    return this.totalPence - this.tenderedTotal;
  }

  get isComplete(): boolean {
    return this.tenderedTotal === this.totalPence && !this.locked;
  }

  get isLockedOnUnknown(): boolean {
    return this.locked;
  }

  /** The exact W-12 blocking modal text, or null when not locked. */
  get blockingModal(): string | null {
    return this.locked ? UNKNOWN_PAYMENT_MESSAGE : null;
  }

  listTenders(): SplitTender[] {
    return [...this.tenders];
  }

  /** True once 5 minutes have passed since the first tender. */
  isTimedOut(): boolean {
    return (
      this.firstTenderAtMs !== null && this.nowMs() - this.firstTenderAtMs > SPLIT_TENDER_TIMEOUT_MS
    );
  }

  addTender(tender: SplitTender): void {
    if (this.locked) {
      throw new Error(
        'Register is locked on an unknown card payment — resolve it before taking another tender',
      );
    }
    if (this.isTimedOut()) {
      throw new Error('Split tender timed out after 5 minutes: the sale was unwound — start again from draft');
    }
    if (tender.amountPence <= 0n) {
      throw new Error('Tender amount must be greater than zero');
    }
    if (tender.amountPence > this.remaining) {
      throw new Error(
        `Tender of ${tender.amountPence.toString()}p exceeds the remaining ${this.remaining.toString()}p`,
      );
    }
    if (this.firstTenderAtMs === null) {
      this.firstTenderAtMs = this.nowMs();
    }
    this.tenders.push({ ...tender });
  }

  /**
   * A card attempt came back `unknown`: lock the register on the
   * blocking modal. No tender may be added and the sale may not
   * complete until a resolution action unlocks it.
   */
  markCardAttemptUnknown(paymentAttemptId: string): string {
    this.unknownAttemptId = paymentAttemptId;
    this.locked = true;
    return UNKNOWN_PAYMENT_MESSAGE;
  }

  get unknownPaymentAttemptId(): string | null {
    return this.unknownAttemptId;
  }

  /**
   * Resolve the unknown payment with one of the 3 explicit actions.
   * Actions 3–4 require a manager approval reference (the API
   * enforces the approval server-side; the register records the
   * reference). Returns true when the register is unlocked.
   */
  resolveUnknown(action: UnknownResolutionAction, managerApprovalRef?: string): boolean {
    if (!this.locked) {
      throw new Error('No unknown payment is locking the register');
    }
    if (
      (action === 'manager_void_or_retry' || action === 'manager_standalone_reference') &&
      (managerApprovalRef === undefined || managerApprovalRef === '')
    ) {
      throw new Error('Manager approval is required for this resolution');
    }
    this.locked = false;
    this.unknownAttemptId = null;
    return true;
  }
}
