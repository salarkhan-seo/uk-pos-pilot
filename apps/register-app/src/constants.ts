/**
 * Register constants (Build-04, Objective 1).
 *
 * OFFLINE BOUNDS (Arch-04 §4.2 — research facts, enforced here):
 *  - max 50 queued offline orders
 *  - max 24 hours offline
 *  - max £250 (25000p) single offline cash sale
 *
 * W-12 message: the exact blocking text from the sales service
 * (UNKNOWN_PAYMENT_MESSAGE) — the register modal must show it verbatim.
 */
export const MAX_OFFLINE_QUEUE_ORDERS = 50;
export const MAX_OFFLINE_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_OFFLINE_SINGLE_SALE_PENCE = 25000n;

/** W-12 blocking modal text — verbatim from apps/api SalesService. */
export const UNKNOWN_PAYMENT_MESSAGE =
  'Payment outcome unknown — do not hand over goods on card until checked';

/** Split-tender timeout: 5 minutes from the first tender (Square's documented rule, adopted as a design rule — same as the API). */
export const SPLIT_TENDER_TIMEOUT_MS = 5 * 60 * 1000;

/** D-08 till variance threshold base: higher of £10 or 2% of expected cash. */
export const TILL_VARIANCE_FLOOR_PENCE = 1000n;

/** Petty-cash-out manager-approval threshold (Build-03 design decision): £50. */
export const PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE = 5000n;
