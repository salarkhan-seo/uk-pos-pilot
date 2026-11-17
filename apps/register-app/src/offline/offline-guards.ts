/**
 * Offline queue limits & online-only guards (Build-04, Objective 1;
 * Arch-04 §4.2, Arch-09/10, D-06).
 *
 * HARD BOUNDS — a new offline sale is blocked with an explicit reason
 * banner as soon as ANY bound is reached:
 *  - 50 queued orders
 *  - 24 hours offline
 *  - £250 (25000p) single offline cash sale
 *
 * ONLINE-ONLY FEATURES — while offline each of these returns an
 * explicit offline status banner explaining why it is unavailable.
 * Card payments are blocked because D-06 defers offline card (the
 * offline_payment_records schema must stay empty); loyalty, gift
 * cards, store credit and vouchers all need live balances/validation;
 * counts and transfers need the live ledger.
 */
import {
  MAX_OFFLINE_DURATION_MS,
  MAX_OFFLINE_QUEUE_ORDERS,
  MAX_OFFLINE_SINGLE_SALE_PENCE,
} from '../constants';

export interface OfflineSaleCheckInput {
  /** Orders already in the local queue. */
  queuedCount: number;
  /** When the register last had connectivity (epoch ms), or null when never offline-tracked. */
  offlineSinceMs: number | null;
  /** The sale's cash total in pence. */
  tenderTotalPence: bigint;
  nowMs: number;
}

/**
 * Returns the blocking reason banner, or null when the offline sale
 * may proceed. The first breached bound wins; the banner names the
 * bound so the cashier knows exactly what to do (sync, or split the
 * sale).
 */
export function offlineSaleBlockReason(input: OfflineSaleCheckInput): string | null {
  if (input.queuedCount >= MAX_OFFLINE_QUEUE_ORDERS) {
    return (
      `Offline queue full — ${MAX_OFFLINE_QUEUE_ORDERS} offline orders already queued. ` +
      `No new offline sales until the register syncs.`
    );
  }
  if (input.offlineSinceMs !== null && input.nowMs - input.offlineSinceMs > MAX_OFFLINE_DURATION_MS) {
    return (
      `Offline for over 24 hours — no new offline sales until the register reconnects and syncs. ` +
      `Queued orders are safe and will sync when connectivity returns.`
    );
  }
  if (input.tenderTotalPence > MAX_OFFLINE_SINGLE_SALE_PENCE) {
    return (
      `Offline cash sale limit is £250 — this sale is £${(Number(input.tenderTotalPence) / 100).toFixed(2)}. ` +
      `Split the sale or reconnect to take it online.`
    );
  }
  return null;
}

export type OnlineOnlyFeature =
  | 'card_payment'
  | 'gift_card_issue'
  | 'gift_card_redeem'
  | 'store_credit_issue'
  | 'store_credit_redeem'
  | 'loyalty_enrol'
  | 'loyalty_earn'
  | 'loyalty_redeem'
  | 'voucher_validation'
  | 'stock_count'
  | 'stock_transfer'
  | 'customer_lookup';

export const ONLINE_ONLY_FEATURES: readonly OnlineOnlyFeature[] = [
  'card_payment',
  'gift_card_issue',
  'gift_card_redeem',
  'store_credit_issue',
  'store_credit_redeem',
  'loyalty_enrol',
  'loyalty_earn',
  'loyalty_redeem',
  'voucher_validation',
  'stock_count',
  'stock_transfer',
  'customer_lookup',
] as const;

export const OFFLINE_BANNERS: Record<OnlineOnlyFeature, string> = {
  card_payment:
    'Card payments are unavailable offline — offline card is deferred (D-06). Cash only until the register reconnects.',
  gift_card_issue:
    'Gift card issue is unavailable offline — gift card balances are checked live. Cash sale only until reconnect.',
  gift_card_redeem:
    'Gift card redemption is unavailable offline — gift card balances are checked live. Cash sale only until reconnect.',
  store_credit_issue:
    'Store credit issue is unavailable offline — customer balances are checked live.',
  store_credit_redeem:
    'Store credit redemption is unavailable offline — customer balances are checked live.',
  loyalty_enrol:
    'Loyalty enrolment is unavailable offline — enrolment needs the live customer record.',
  loyalty_earn:
    'Loyalty earn is unavailable offline — points are calculated live. The sale can still complete as cash.',
  loyalty_redeem:
    'Loyalty redemption is unavailable offline — points balances are checked live.',
  voucher_validation:
    'Voucher codes cannot be validated offline — codes are checked live. The sale can still complete as cash without the voucher.',
  stock_count:
    'Stock counts are unavailable offline — counts write to the live ledger.',
  stock_transfer:
    'Stock transfers are unavailable offline — transfers move live warehouse stock.',
  customer_lookup:
    'Customer lookup is unavailable offline — customer records live on the server. The sale can still complete as cash without a customer attached.',
};

/** The explicit offline status banner for an online-only feature. */
export function offlineBannerFor(feature: OnlineOnlyFeature): string {
  return OFFLINE_BANNERS[feature];
}

/** Thrown when a caller attempts an online-only feature while offline. */
export class OfflineBlockedError extends Error {
  readonly feature: OnlineOnlyFeature;
  readonly banner: string;

  constructor(feature: OnlineOnlyFeature) {
    super(offlineBannerFor(feature));
    this.name = 'OfflineBlockedError';
    this.feature = feature;
    this.banner = offlineBannerFor(feature);
  }
}
