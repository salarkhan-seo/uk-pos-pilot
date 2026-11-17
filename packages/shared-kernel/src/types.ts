/**
 * Domain types for the UK POS pilot.
 *
 * Money is ALWAYS integer minor units (pence) as bigint — never float, never
 * a decimal string (D-13 Option A). A Money value is a plain bigint; the
 * branded alias exists so call sites read clearly.
 */

/** Money in integer pence. bigint — never number, never float. */
export type Money = bigint;

/** Zero pence. */
export const ZERO_MONEY: Money = 0n;

/** UK VAT rate kinds. `exempt` means no VAT is charged at all. */
export type TaxRateKind = 'standard' | 'reduced' | 'zero' | 'exempt';

/**
 * The UK VAT rate for a kind, as an exact rational `rateNum / rateDen`
 * (e.g. standard = 20/100). Rates are exact rationals so the D-13
 * calculation stays in integer arithmetic end to end.
 */
export const TAX_RATES: Readonly<Record<TaxRateKind, { rateNum: bigint; rateDen: bigint; label: string }>> = {
  standard: { rateNum: 20n, rateDen: 100n, label: '20% standard' },
  reduced: { rateNum: 5n, rateDen: 100n, label: '5% reduced' },
  zero: { rateNum: 0n, rateDen: 100n, label: '0% zero-rated' },
  exempt: { rateNum: 0n, rateDen: 100n, label: 'exempt' },
} as const;

/** Order lifecycle states (Arch-01 §2.5, Arch-02 §6.1). */
export type OrderStatus =
  | 'draft'
  | 'pending_payment'
  | 'completed'
  | 'voided'
  | 'partially_returned'
  | 'returned';

/**
 * Payment-attempt lifecycle states (Arch-01 §2.5, Arch-02 §6.1).
 * `unknown` is a FIRST-CLASS state: the outcome is not known, the order
 * stays `pending_payment`, and goods must NOT be handed over on card until
 * the attempt is resolved (W-12). No path marks an order paid without
 * provider evidence.
 */
export type PaymentAttemptStatus =
  | 'created'
  | 'pending'
  | 'approved'
  | 'declined'
  | 'unknown'
  | 'refunded';

/** Tender types on an order (Arch-01 §2.5). `loyalty_points` added in
 * Build-02 (Objective 5): loyalty points are a tender type, redeemed at
 * 1 point = 1p in this build (a design decision — the earn rate is
 * Phase 2). */
export type TenderType = 'cash' | 'card' | 'store_credit' | 'gift_card' | 'loyalty_points';

/** Stock movement causes (Arch-01 §2.4, Arch-06 §2.2 — closed list). */
export type StockMovementCause =
  | 'sale'
  | 'return'
  | 'adjustment'
  | 'count'
  | 'goods_in'
  | 'transfer_out'
  | 'transfer_in'
  | 'damage'
  | 'shrinkage'
  | 'found'
  | 'supplier_error'
  | 'offline_sync_conflict'
  | 'case_breakdown';

/** Register session states (Arch-01 §2.6). */
export type RegisterSessionStatus = 'open' | 'ended' | 'closed';

/** Z-report states (Arch-01 §2.6). Issued Z-reports are immutable. */
export type ZReportStatus = 'draft' | 'issued';

/** Tenant exit states (Arch-01 §4.1). */
export type TenantExitStatus =
  | 'active'
  | 'termination_requested'
  | 'export_window'
  | 'hard_delete_scheduled'
  | 'deleted';

/** Offline card payment record states (Arch-01 §5.2). Offline card is
 * FEATURE-DISABLED in this pilot (D-06 Option B) — the schema exists so the
 * design is not lost, but no offline-card logic is built in Build-01. */
export type OfflinePaymentStatus =
  | 'pending_forward'
  | 'forwarded'
  | 'declined_after_forward'
  | 'lost';

/** Gift-card / store-credit ledger entry kinds (Arch-09 §4). */
export type StoredValueLedgerKind =
  | 'issue'
  | 'redeem'
  | 'refund'
  | 'correction'
  | 'expiry';

/** Loyalty ledger entry kinds (Arch-09 §3.2). */
export type LoyaltyLedgerKind = 'earn' | 'redeem' | 'correction' | 'expiry';

/** Business date, YYYY-MM-DD in Europe/London. */
export type BusinessDate = string;
