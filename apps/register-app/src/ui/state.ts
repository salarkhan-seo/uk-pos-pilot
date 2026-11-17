/**
 * Register Tablet UI — state model (Build-05, Objective 4).
 *
 * Framework-light HTML5/TypeScript touch UI bound to the existing
 * RegisterApp view-models. This file only *describes* UI state and
 * snapshots it from the real controllers — it never reimplements
 * pricing, age-gate, split-tender or till logic.
 *
 * GAPS (view-models the UI needs a hook for, worked around here —
 * the view-models were NOT modified, per the Build-05 scope):
 * - SplitTenderController keeps `firstTenderAtMs` private with no
 *   getter, so the 5-minute countdown start must be supplied by the
 *   caller (the server records it when the first tender is added).
 *   When it is unknown the countdown shows the full 5:00.
 * - TillSessionController exposes no getter for the expected cash
 *   after `endSession` or for the issued Z-report, so the caller
 *   supplies those as overrides (`tillView`) after calling the
 *   controller methods. The controller remains the source of truth
 *   for state transitions; the UI only displays what it returned.
 */
import type { SellLineView } from '../sell/line-pricing';
import type { AgeRefusal } from '../sell/age-gate';
import type { SellController } from '../sell/sell-controller';
import type { SplitTenderController, TenderKind } from '../sell/split-tender';
import type { TillSessionController, TillSessionState } from '../session/till-session';
import type { StorageAdapter } from '../storage/storage-adapter';

export interface RegisterUiQuickKey {
  sku: string;
  label: string;
  pricePence: bigint | null;
}

export interface RegisterUiSplitTender {
  totalPence: bigint;
  tenderedPence: bigint;
  remainingPence: bigint;
  tenders: Array<{ kind: TenderKind; amountPence: bigint }>;
  /** Epoch ms of the first tender, or null when no tender yet / unknown. */
  firstTenderAtMs: number | null;
  nowMs: number;
  locked: boolean;
  blockingMessage: string | null;
  timedOut: boolean;
  complete: boolean;
}

export interface RegisterUiTill {
  state: TillSessionState;
  sessionId: string | null;
  expectedCashPence: bigint | null;
  zReport: { zReportId: string; zNumber: string } | null;
  zeroFloatWarning: string | null;
}

export interface RegisterUiLiveOrderOpen {
  orderId: string;
  totalPence: bigint;
}

export interface RegisterUiLiveOrder {
  orderId: string;
  receiptNumber: string;
  totalPence: bigint;
  receiptLines: Array<{
    taxRateKind: string;
    taxRatePercent: string;
    grossPence: bigint;
    vatPence: bigint;
    netPence: bigint;
  }>;
}

export interface RegisterUiPendingCardAttempt {
  attemptId: string;
  amountPence: bigint;
}

export interface RegisterUiFlushSummary {
  synced: number;
  conflicts: number;
  failed: number;
  at: string;
}

export interface RegisterUiState {
  /** True when the register believes it has connectivity. */
  online: boolean;
  /** When connectivity was last lost (epoch ms), or null. */
  offlineSinceMs: number | null;
  /** Offline orders currently queued locally. */
  queuedCount: number;
  shopName: string;
  receiptNumber: string;
  lines: SellLineView[];
  quickKeys: RegisterUiQuickKey[];
  parkedCount: number;
  parkedLocalIds: string[];
  ageGate: {
    required: boolean;
    requiredSkus: string[];
    verifiedThreshold: number | null;
    refusals: AgeRefusal[];
  };
  splitTender: RegisterUiSplitTender | null;
  till: RegisterUiTill;
  readerStatus: string;
  readerModel: string;
  /** Last action result / error, shown as a banner (never a PIN). */
  notice: string | null;
  /** Opaque manager-approval reference from the PIN pad, if any. */
  pinApprovalRef: string | null;
  /**
   * True when the rendered data is labelled demo/simulated data
   * (the shell's seeded catalogue and simulated hardware) rather
   * than a live backend. The page always shows this label when set.
   */
  demo: boolean;
  // -- Live API wiring (Build-06, Objective 3) -------------------------
  /** API base URL the shell is configured against. */
  apiBaseUrl: string;
  /**
   * Last API reachability probe: true = the API answered, false =
   * unreachable, null = not probed yet. Effective online is
   * manualOnline && apiReachable !== false.
   */
  apiReachable: boolean | null;
  /** Cashier's manual online/offline toggle (independent of reachability). */
  manualOnline: boolean;
  /** True once a catalogue handshake has replaced the demo catalogue. */
  liveCatalogue: boolean;
  /** Server time of the last successful catalogue handshake, or null. */
  lastSyncAt: string | null;
  /** Last catalogue-sync failure message, or null. */
  lastSyncError: string | null;
  /** Last FIFO flush outcome summary, or null when never flushed. */
  lastFlush: RegisterUiFlushSummary | null;
  /** Last catalogue search query, or null when no search ran. */
  searchQuery: string | null;
  /** Last catalogue search results, or null when no search ran. */
  searchResults: Array<{ sku: string; name: string; pricePence: bigint }> | null;
  /** Last online sale completed against the API, or null. */
  liveOrder: RegisterUiLiveOrder | null;
  /** Live order created but not yet completed or voided (declined/unresolved card), or null. */
  liveOrderOpen: RegisterUiLiveOrderOpen | null;
  /** Card attempts created on the live order whose terminal result is still unknown. */
  pendingCardAttempts: RegisterUiPendingCardAttempt[];
  /** Storage problem that forced a fallback (e.g. tampered ciphertext), or null. */
  storageWarning: string | null;
  /** Tenant / user ids the shell is configured/logged in as (PIN form prefill). */
  tenantId: string;
  userId: string;
}

/** Empty / initial UI state (no basket, till closed, online). */
export function emptyRegisterUiState(overrides: Partial<RegisterUiState> = {}): RegisterUiState {
  return {
    online: true,
    offlineSinceMs: null,
    queuedCount: 0,
    shopName: 'Demo Shop Ltd',
    receiptNumber: '1',
    lines: [],
    quickKeys: [],
    parkedCount: 0,
    parkedLocalIds: [],
    ageGate: { required: false, requiredSkus: [], verifiedThreshold: null, refusals: [] },
    splitTender: null,
    till: { state: 'closed', sessionId: null, expectedCashPence: null, zReport: null, zeroFloatWarning: null },
    readerStatus: 'disconnected',
    readerModel: 'S700',
    notice: null,
    pinApprovalRef: null,
    demo: false,
    apiBaseUrl: '',
    apiReachable: null,
    manualOnline: true,
    liveCatalogue: false,
    lastSyncAt: null,
    lastSyncError: null,
    lastFlush: null,
    searchQuery: null,
    searchResults: null,
    liveOrder: null,
    liveOrderOpen: null,
    pendingCardAttempts: [],
    storageWarning: null,
    tenantId: '',
    userId: '',
    ...overrides,
  };
}

export interface SnapshotInput {
  sell: SellController;
  storage: StorageAdapter;
  splitTender?: SplitTenderController | null;
  /** Countdown start — see the gap note at the top of this file. */
  splitTenderFirstTenderAtMs?: number | null;
  till?: TillSessionController | null;
  /** Expected cash / Z-report returned by the till controller — see gap note. */
  tillView?: Partial<Pick<RegisterUiTill, 'expectedCashPence' | 'zReport'>>;
  online: boolean;
  offlineSinceMs?: number | null;
  shopName?: string;
  receiptNumber?: string;
  quickKeys?: RegisterUiQuickKey[];
  readerStatus?: string;
  readerModel?: string;
  notice?: string | null;
  pinApprovalRef?: string | null;
  demo?: boolean;
  apiBaseUrl?: string;
  apiReachable?: boolean | null;
  manualOnline?: boolean;
  liveCatalogue?: boolean;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  lastFlush?: RegisterUiFlushSummary | null;
  searchQuery?: string | null;
  searchResults?: Array<{ sku: string; name: string; pricePence: bigint }> | null;
  liveOrder?: RegisterUiLiveOrder | null;
  liveOrderOpen?: RegisterUiLiveOrderOpen | null;
  pendingCardAttempts?: RegisterUiPendingCardAttempt[];
  storageWarning?: string | null;
  tenantId?: string;
  userId?: string;
  nowMs?: number;
}

/**
 * Snapshot live UI state from the real view-models. Reads only:
 * SellController lines + age gate, storage parked baskets + queue,
 * SplitTenderController getters, TillSessionController getters.
 */
export async function snapshotRegisterUiState(input: SnapshotInput): Promise<RegisterUiState> {
  const lines = input.sell.listLines();
  const required = input.sell.ageGate.requiredLines(lines);
  const parked = await input.storage.listParkedBaskets();
  const queued = await input.storage.listAllQueue();
  const queuedCount = queued.filter((row) => row.syncStatus === 'queued' || row.syncStatus === 'syncing').length;

  let splitTender: RegisterUiSplitTender | null = null;
  if (input.splitTender) {
    const split = input.splitTender;
    splitTender = {
      totalPence: split.total,
      tenderedPence: split.tenderedTotal,
      remainingPence: split.remaining,
      tenders: split.listTenders().map((t) => ({ kind: t.kind, amountPence: t.amountPence })),
      firstTenderAtMs: input.splitTenderFirstTenderAtMs ?? null,
      nowMs: input.nowMs ?? Date.now(),
      locked: split.isLockedOnUnknown,
      blockingMessage: split.blockingModal,
      timedOut: split.isTimedOut(),
      complete: split.isComplete,
    };
  }

  const till: RegisterUiTill = {
    state: input.till ? input.till.currentState : 'closed',
    sessionId: input.till ? input.till.currentSessionId : null,
    expectedCashPence: input.tillView?.expectedCashPence ?? null,
    zReport: input.tillView?.zReport ?? null,
    zeroFloatWarning: input.till ? input.till.lastZeroFloatWarning : null,
  };

  return {
    online: input.online,
    offlineSinceMs: input.offlineSinceMs ?? null,
    queuedCount,
    shopName: input.shopName ?? 'Demo Shop Ltd',
    receiptNumber: input.receiptNumber ?? '1',
    lines,
    quickKeys: input.quickKeys ?? [],
    parkedCount: parked.length,
    parkedLocalIds: parked.map((row) => row.localId),
    ageGate: {
      required: required.length > 0,
      requiredSkus: required.map((line) => line.sku),
      verifiedThreshold: input.sell.ageGate.verifiedAgeThreshold,
      refusals: input.sell.ageGate.listRefusals(),
    },
    splitTender,
    till,
    readerStatus: input.readerStatus ?? 'disconnected',
    readerModel: input.readerModel ?? 'S700',
    notice: input.notice ?? null,
    pinApprovalRef: input.pinApprovalRef ?? null,
    demo: input.demo ?? false,
    apiBaseUrl: input.apiBaseUrl ?? '',
    apiReachable: input.apiReachable ?? null,
    manualOnline: input.manualOnline ?? true,
    liveCatalogue: input.liveCatalogue ?? false,
    lastSyncAt: input.lastSyncAt ?? null,
    lastSyncError: input.lastSyncError ?? null,
    lastFlush: input.lastFlush ?? null,
    searchQuery: input.searchQuery ?? null,
    searchResults: input.searchResults ?? null,
    liveOrder: input.liveOrder ?? null,
    liveOrderOpen: input.liveOrderOpen ?? null,
    pendingCardAttempts: input.pendingCardAttempts ?? [],
    storageWarning: input.storageWarning ?? null,
    tenantId: input.tenantId ?? '',
    userId: input.userId ?? '',
  };
}
