/**
 * Register Session & Till Close Flow (Build-04, Objective 1).
 *
 * Framework-free view-model over the API's ReportingService — the
 * register NEVER reimplements Z-report logic locally. The
 * ReportingClient interface is the typed seam: in production it calls
 * the API's reporting endpoints; in tests it is a fake.
 *
 * - Open session: D-07 zero-float warning + manager override. A zero
 *   float without a manager approval reference is blocked locally
 *   before any API call, with the warning text surfaced.
 * - Cash in/out + petty cash movements (petty-cash-out above £50
 *   needs manager approval — Build-03 design decision, enforced
 *   server-side; the view-model flags it locally too).
 * - Two-step End vs blind Close: `endSession` computes the expected
 *   cash and freezes the session; `closeSession` takes the counted
 *   cash, computes the variance, and requires a manager approval
 *   reference when |variance| exceeds the D-08 threshold —
 *   max(£10, 2% of expected cash).
 * - Z-report generation is delegated: closeSession returns the
 *   server-issued Z-report view.
 */
import { PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE, TILL_VARIANCE_FLOOR_PENCE } from '../constants';

export interface ReportingClient {
  openSession(input: {
    registerId: string;
    openingFloatPence: bigint;
    approvalEventId?: string | null;
  }): Promise<{ sessionId: string; warning: string | null }>;
  recordCashMovement(input: {
    sessionId: string;
    type: 'cash_in' | 'cash_out' | 'petty_cash_in' | 'petty_cash_out';
    amountPence: bigint;
    note: string;
    approvalEventId?: string | null;
  }): Promise<{ movementId: string }>;
  endSession(sessionId: string): Promise<{ sessionId: string; expectedCashPence: bigint }>;
  closeSession(input: {
    sessionId: string;
    countedCashPence: bigint;
    varianceReason?: string | null;
    approvalEventId?: string | null;
    carryForward?: { attemptIds: string[]; approvalEventId: string; note: string } | null;
  }): Promise<{ sessionId: string; zReportId: string; zNumber: string }>;
  getZReport(zReportId: string): Promise<{ zReportId: string; zNumber: string }>;
}

/** D-08 threshold: higher of £10 or 2% of expected cash. */
export function varianceThresholdPence(expectedCashPence: bigint): bigint {
  const twoPercent = (expectedCashPence * 2n) / 100n;
  return twoPercent > TILL_VARIANCE_FLOOR_PENCE ? twoPercent : TILL_VARIANCE_FLOOR_PENCE;
}

export function varianceNeedsApproval(expectedCashPence: bigint, countedCashPence: bigint): boolean {
  const variance = countedCashPence - expectedCashPence;
  const abs = variance < 0n ? -variance : variance;
  return abs > varianceThresholdPence(expectedCashPence);
}

export type TillSessionState = 'closed' | 'open' | 'ended';

export class TillSessionController {
  private sessionId: string | null = null;
  private state: TillSessionState = 'closed';
  private expectedCashPence: bigint | null = null;
  private zeroFloatWarning: string | null = null;

  constructor(
    private readonly reporting: ReportingClient,
    private readonly registerId: string,
  ) {}

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentState(): TillSessionState {
    return this.state;
  }

  get lastZeroFloatWarning(): string | null {
    return this.zeroFloatWarning;
  }

  /**
   * Open a session. D-07: opening with no float warns and requires a
   * manager override (approval reference) — without one the open is
   * blocked locally.
   */
  async openSession(openingFloatPence: bigint, managerApprovalRef?: string): Promise<string> {
    if (this.state !== 'closed') {
      throw new Error('A session is already open on this register');
    }
    if (openingFloatPence < 0n) {
      throw new Error('Opening float must not be negative');
    }
    if (openingFloatPence === 0n) {
      this.zeroFloatWarning =
        'Session opened with no float: float must be counted and recorded before trading; manager approval recorded.';
      if (managerApprovalRef === undefined || managerApprovalRef === '') {
        throw new Error(
          'Opening a session with no float requires a manager override (D-07) — manager approval required',
        );
      }
    }
    const { sessionId, warning } = await this.reporting.openSession({
      registerId: this.registerId,
      openingFloatPence,
      approvalEventId: managerApprovalRef ?? null,
    });
    this.sessionId = sessionId;
    this.state = 'open';
    if (warning !== null) {
      this.zeroFloatWarning = warning;
    }
    return sessionId;
  }

  async recordCashMovement(input: {
    type: 'cash_in' | 'cash_out' | 'petty_cash_in' | 'petty_cash_out';
    amountPence: bigint;
    note: string;
    approvalEventId?: string | null;
  }): Promise<string> {
    if (this.sessionId === null || this.state !== 'open') {
      throw new Error('No open session — open a session before recording cash movements');
    }
    if (input.amountPence <= 0n) {
      throw new Error('Cash movement amount must be greater than zero');
    }
    if (input.note.trim() === '') {
      throw new Error('A note is required for every cash movement');
    }
    if (
      input.type === 'petty_cash_out' &&
      input.amountPence > PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE &&
      (input.approvalEventId === undefined || input.approvalEventId === null)
    ) {
      throw new Error(
        'Petty cash out above £50 requires a manager approval (Build-03 design decision)',
      );
    }
    const { movementId } = await this.reporting.recordCashMovement({
      sessionId: this.sessionId,
      ...input,
    });
    return movementId;
  }

  /** Step 1 of close: end the session — expected cash is computed and the session freezes. */
  async endSession(): Promise<bigint> {
    if (this.sessionId === null || this.state !== 'open') {
      throw new Error('Only an open session can be ended');
    }
    const { expectedCashPence } = await this.reporting.endSession(this.sessionId);
    this.expectedCashPence = expectedCashPence;
    this.state = 'ended';
    return expectedCashPence;
  }

  /**
   * Step 2 of close: blind count. The counted cash is compared with
   * the expected cash; any variance needs a reason, and a variance
   * above the D-08 threshold needs a manager approval reference.
   * Returns the issued Z-report.
   */
  async closeSession(input: {
    countedCashPence: bigint;
    varianceReason?: string | null;
    approvalEventId?: string | null;
    carryForward?: { attemptIds: string[]; approvalEventId: string; note: string } | null;
  }): Promise<{ zReportId: string; zNumber: string }> {
    if (this.sessionId === null || this.state !== 'ended' || this.expectedCashPence === null) {
      throw new Error('Only an ended session can be closed — end the session first');
    }
    const variance = input.countedCashPence - this.expectedCashPence;
    if (
      variance !== 0n &&
      (input.varianceReason === undefined || input.varianceReason === null || input.varianceReason.trim() === '')
    ) {
      throw new Error('A variance_reason is required whenever variance is not zero');
    }
    if (
      varianceNeedsApproval(this.expectedCashPence, input.countedCashPence) &&
      (input.approvalEventId === undefined || input.approvalEventId === null)
    ) {
      throw new Error(
        `Variance of ${variance.toString()}p exceeds the D-08 threshold ` +
          `(higher of £10 or 2% of expected cash, ${varianceThresholdPence(this.expectedCashPence).toString()}p) — manager approval required`,
      );
    }
    const result = await this.reporting.closeSession({
      sessionId: this.sessionId,
      countedCashPence: input.countedCashPence,
      varianceReason: input.varianceReason ?? null,
      approvalEventId: input.approvalEventId ?? null,
      carryForward: input.carryForward ?? null,
    });
    this.sessionId = null;
    this.expectedCashPence = null;
    this.state = 'closed';
    return { zReportId: result.zReportId, zNumber: result.zNumber };
  }
}
