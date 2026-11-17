/**
 * Offline cash-queue bounds (Build-04, Objective 3 — Arch-04 §4.2).
 *
 * PURE module (no I/O, no database): the offline queue lives on the
 * register tablet (Worker 1, apps/register-app, local SQLite
 * `local_cash_queue`). This module is the shared statement of the
 * bounds the register app enforces, kept here under
 * apps/api/test/e2e/support so the server-side E2E suite can assert
 * the same limits the tablet enforces — the server cannot observe
 * "offline", so the bounds themselves are only provable at this layer
 * and in the register app's own suite. The API-level proofs that the
 * server refuses the online-only work are in offline-bounds.test.ts.
 *
 * Bounds (Arch-04 §4.2, hard limits):
 *   - max 50 queued offline orders
 *   - max 24 hours offline duration
 *   - max £250 (25000 pence) single offline cash sale
 *
 * DESIGN DECISIONS (not research facts):
 *   - Boundary values are INCLUSIVE: the 50th queued order, exactly
 *     24h offline, and exactly £250.00 are all still allowed; the
 *     51st order, 24h + 1ms, and £250.01 are blocked. A till that
 *     blocks the 50th sale would strand a legal sale, so the limit is
 *     "at most", not "fewer than".
 *   - A blocked offline sale returns an explicit reason banner, never
 *     a silent failure — the cashier must be told WHY the sale cannot
 *     proceed offline (Arch-04 §4.2: "Block new offline sales with an
 *     explicit reason banner once any bound is reached").
 */

export const MAX_OFFLINE_ORDERS = 50;
export const MAX_OFFLINE_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_SINGLE_OFFLINE_SALE_PENCE = 25000n;

export type OfflineBlockReason = 'queue_full' | 'offline_too_long' | 'single_sale_too_large';

export interface OfflineQueuedOrder {
  localId: string;
  idempotencyKey: string;
  tenderTotalPence: bigint;
  createdAt: Date;
}

export type OfflineSaleCheck =
  | { allowed: true }
  | { allowed: false; reason: OfflineBlockReason; message: string };

/**
 * May a new offline cash sale of `tenderTotalPence` be queued now?
 * `queue` is the tablet's current local_cash_queue (any status that
 * still occupies a slot: queued/syncing/conflict), `offlineSince` is
 * when the tablet last had connectivity, `now` is the sale time.
 * Checks run in the order the cashier experiences them: queue full,
 * then offline too long, then single-sale cap.
 */
export function checkOfflineSaleAllowed(
  queue: readonly OfflineQueuedOrder[],
  offlineSince: Date,
  now: Date,
  tenderTotalPence: bigint,
): OfflineSaleCheck {
  if (queue.length >= MAX_OFFLINE_ORDERS) {
    return {
      allowed: false,
      reason: 'queue_full',
      message: `Offline queue full: ${MAX_OFFLINE_ORDERS} orders queued. Reconnect to sync before taking more offline sales.`,
    };
  }
  if (now.getTime() - offlineSince.getTime() > MAX_OFFLINE_DURATION_MS) {
    return {
      allowed: false,
      reason: 'offline_too_long',
      message:
        'Offline for over 24 hours. Reconnect to sync before taking more offline sales.',
    };
  }
  if (tenderTotalPence > MAX_SINGLE_OFFLINE_SALE_PENCE) {
    return {
      allowed: false,
      reason: 'single_sale_too_large',
      message:
        'Offline cash sales are limited to £250.00 per sale. Take this sale online, or split it.',
    };
  }
  return { allowed: true };
}

/** FIFO flush order (Arch-04 §4.3): oldest created_at first, stable for ties. */
export function sortQueueFifo(
  queue: readonly OfflineQueuedOrder[],
): OfflineQueuedOrder[] {
  return [...queue]
    .map((order, index) => ({ order, index }))
    .sort((a, b) => {
      const byTime = a.order.createdAt.getTime() - b.order.createdAt.getTime();
      return byTime !== 0 ? byTime : a.index - b.index;
    })
    .map((entry) => entry.order);
}

/** Online-only features while offline (Arch-04 §4.2, Arch-09/10). */
export type OfflineBlockedFeature =
  | 'card'
  | 'gift_card'
  | 'store_credit'
  | 'loyalty'
  | 'voucher'
  | 'stock_count'
  | 'stock_transfer';

export const OFFLINE_BLOCKED_FEATURES: ReadonlyArray<{
  feature: OfflineBlockedFeature;
  banner: string;
}> = [
  { feature: 'card', banner: 'Card payments are unavailable offline. Take cash only.' },
  {
    feature: 'gift_card',
    banner: 'Gift cards are unavailable offline. Gift card issue and redemption need a connection.',
  },
  {
    feature: 'store_credit',
    banner: 'Store credit is unavailable offline. Store credit issue and redemption need a connection.',
  },
  {
    feature: 'loyalty',
    banner: 'Loyalty is unavailable offline. Enrolment, earn and redemption need a connection.',
  },
  {
    feature: 'voucher',
    banner: 'Voucher validation is unavailable offline. Voucher redemption needs a connection.',
  },
  {
    feature: 'stock_count',
    banner: 'Stock counts are unavailable offline. Counts need a connection.',
  },
  {
    feature: 'stock_transfer',
    banner: 'Stock transfers are unavailable offline. Transfers need a connection.',
  },
];

/** The explicit offline banner for a feature, or null when the feature is allowed offline. */
export function offlineFeatureBanner(feature: OfflineBlockedFeature): string | null {
  return OFFLINE_BLOCKED_FEATURES.find((entry) => entry.feature === feature)?.banner ?? null;
}

/** Features that ARE allowed offline: cash sales, price-book pricing, role-bounded manual discounts. */
export function isAllowedOffline(
  feature: 'cash_sale' | 'price_book_pricing' | 'manual_discount' | OfflineBlockedFeature,
): boolean {
  return offlineFeatureBanner(feature as OfflineBlockedFeature) === null;
}
