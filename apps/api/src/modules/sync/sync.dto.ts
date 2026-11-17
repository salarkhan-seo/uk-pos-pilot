/**
 * Sync DTOs (Build-04, Objective 1) — the wire contract between the
 * register tablet app (`apps/register-app`) and the API.
 *
 * Money crosses the JSON boundary as DECIMAL STRINGS (JSON has no
 * bigint), exactly like the sales controller. The register app imports
 * these types only (`import type`) — there is no runtime dependency
 * from the register app on the API.
 *
 * NOTE on naming: the commission calls the stock shortfall record a
 * `stock_movements` adjustment with `movement_type =
 * 'offline_sync_conflict'`. The Build-01 schema names that column
 * `cause`, and `'offline_sync_conflict'` is already one of its CHECK
 * values (migration 003) — so the wire/DB value is
 * `cause = 'offline_sync_conflict'`.
 */

import type { AgeVerificationWire } from '../sales/sales.service';

export interface HandshakeRequest {
  registerId: string;
  /** ISO timestamp of the register's last successful catalogue sync; omit for a full snapshot. */
  since?: string | null;
}

export interface CatalogueDeltaVariant {
  variantId: string;
  sku: string;
  barcode: string | null;
  name: string;
  /** Current server price in pence, as a decimal string. */
  pricePence: string;
  taxRateId: string | null;
  taxRateKind: string | null;
  taxRatePercent: string | null;
  /** Active price-book price when one applies, else null. */
  priceBookPricePence: string | null;
  /** Cached on-hand in the location's default warehouse (display hint only). */
  stockOnHand: string | null;
  /** When the cached stock level was computed (server time). */
  stockComputedAt: string | null;
  /**
   * True when an age_restrictions row exists for this variant with
   * challenge_25 set. ALWAYS present — false when no row exists, so
   * the register never has to guess whether the flag was omitted or
   * is genuinely off (Build-08, Objective 2).
   */
  requiresChallenge25: boolean;
  /**
   * Minimum legal age in years from age_restrictions.min_age_years,
   * or null when no age-restriction row exists for this variant.
   * Informational: the Challenge 25 gate itself always verifies the
   * 25 threshold — minAge is the product's legal minimum, not the
   * verification threshold.
   */
  minAge: number | null;
  updatedAt: string;
}

export interface CatalogueDeltaPriceBookEntry {
  priceBookId: string;
  variantId: string;
  pricePence: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface CatalogueDelta {
  /** Variants created/updated since `since` (or all active variants on a full snapshot). */
  variants: CatalogueDeltaVariant[];
  taxRates: Array<{ id: string; kind: string; ratePercent: string; isActive: boolean }>;
  priceBookEntries: CatalogueDeltaPriceBookEntry[];
  /** The tenant's single active barcode mode, or null when none is set. */
  barcodeMode: 'price_embedded' | 'weight_embedded' | null;
  /** True when this is a full snapshot (no `since` was supplied). */
  fullSnapshot: boolean;
}

export interface HandshakeResponse {
  serverTime: string;
  tenantId: string;
  tenantStatus: string;
  registerId: string;
  registerName: string;
  registerStatus: string;
  locationId: string;
  catalogue: CatalogueDelta;
}

export interface FlushOrderLine {
  variantId: string;
  /** Quantity in base units, as a decimal string. */
  quantity: string;
  /** The per-unit price the customer actually paid offline (snapshot), pence as a decimal string. */
  snapshotUnitPricePence: string;
  /** The line total the customer actually paid offline (snapshot), pence as a decimal string. */
  snapshotLineTotalPence: string;
  /** Manual discount applied offline on this line, pence as a decimal string. */
  manualDiscountPence?: string;
  /** Manager PIN approval recorded locally for an offline manual discount (opaque reference, never the PIN). */
  offlineApprovalRef?: string | null;
}

export interface FlushOrder {
  /** The queue row's unique idempotency key — a replay returns the original outcome. */
  idempotencyKey: string;
  locationId: string;
  registerId: string;
  customerId?: string | null;
  /** The total cash the customer physically handed over offline, pence as a decimal string. */
  tenderTotalPence: string;
  /** When the sale happened offline (client clock), ISO string. */
  createdAt: string;
  lines: FlushOrderLine[];
  /**
   * Age verifications recorded offline for this sale (Build-09,
   * Objective 2) — wire shape, snake_case, exactly as the checkout
   * endpoints accept. The flush enforces Challenge 25 the same way:
   * an unverified restricted line fails the order (it is never
   * silently completed).
   */
  age_verifications?: AgeVerificationWire[];
}

export interface FlushRequest {
  registerId: string;
  orders: FlushOrder[];
}

export type FlushOrderStatus = 'synced' | 'conflict' | 'failed' | 'replayed';

export interface FlushOrderOutcome {
  idempotencyKey: string;
  status: FlushOrderStatus;
  /** Server order id, when the order was created. */
  orderId: string | null;
  receiptNumber: string | null;
  /** Server order total, pence as a decimal string. */
  orderTotalPence: string | null;
  /** Non-blocking warnings: price discrepancies, cash overpayments, conflicts. */
  warnings: string[];
  /** Stock shortfall details, when the offline_sync_conflict rule fired. */
  conflict: {
    variantId: string;
    requested: string;
    available: string;
    shortfall: string;
  }[] | null;
  error: string | null;
  /**
   * Structured domain error code for a 'failed' outcome (Build-10
   * Objective 3) — e.g. AGE_VERIFICATION_REQUIRED, INSUFFICIENT_STOCK,
   * NOT_FOUND, LOCATION_MISMATCH — alongside the human-readable
   * `error` message. Null on synced / conflict / replayed outcomes.
   * The code is machine-readable: the register can branch on it
   * (e.g. surface the Challenge 25 prompt again) instead of parsing
   * the message or the exception class name.
   */
  error_code: string | null;
}

export interface FlushResponse {
  serverTime: string;
  outcomes: FlushOrderOutcome[];
}
