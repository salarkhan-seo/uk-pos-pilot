/**
 * Sell-line price view-model (Build-04, Objective 1).
 *
 * Mirrors the server pricing pipeline's per-line shape (Arch-10):
 * base → price book → automatic promotion → manual discount → final.
 * This is a VIEW-MODEL for the register screen: the server reprices
 * authoritatively at flush/createOrder time, so an offline line's
 * snapshot prices are what the customer paid, and any drift is
 * reconciled as a discrepancy warning on sync (see sync-client.ts).
 *
 * Manual discounts are role-bounded (cashier 0%, manager 10%, admin
 * 25%, owner unlimited — DEFAULT_ROLE_DISCOUNT_LIMITS in
 * apps/api/src/common/roles.ts, imported here so the register and the
 * API can never disagree). A discount above the cashier's limit needs
 * a manager PIN: the PIN is verified against the manager's stored
 * scrypt hash (shared-kernel verifyPin) and only the approval
 * reference is recorded — the PIN itself is never stored.
 */
import { discountLimitForRoles, type RoleName } from '../../../api/src/common/roles';
import { verifyPin } from '@uk-pos/shared-kernel';

export interface SellLineInput {
  variantId: string;
  sku: string;
  name: string;
  quantity: bigint;
  basePricePence: bigint;
  priceBookPricePence: bigint | null;
  promotionDiscountPence: bigint;
  manualDiscountPence: bigint;
  taxRateKind: string | null;
  requiresChallenge25: boolean;
  /**
   * Minimum legal age in years for this variant, or null when it has
   * no age restriction. Carried from the cached catalogue entry so
   * the basket line stays faithful to it; the gate itself always
   * verifies the 25 threshold.
   */
  minAge: number | null;
}

export interface SellLineView extends SellLineInput {
  /** Per-unit price after the price book (step 2), before promotions/manual. */
  unitPricePence: bigint;
  /** Per-unit price after steps 2–5 (before any basket allocation). */
  finalPricePence: bigint;
  /** Line total after ALL line discounts. */
  lineTotalPence: bigint;
}

/** Pure per-line pricing: base → price book → promotion → manual → final. */
export function priceSellLine(input: SellLineInput): SellLineView {
  const unitPricePence = input.priceBookPricePence ?? input.basePricePence;
  const gross = unitPricePence * input.quantity;
  const afterPromotion = gross - input.promotionDiscountPence;
  const lineTotal = afterPromotion - input.manualDiscountPence;
  if (lineTotal < 0n) {
    throw new Error('Line total must not be negative: discounts exceed the line price');
  }
  const finalPricePence =
    input.quantity === 0n ? 0n : (lineTotal + input.quantity - 1n) / input.quantity;
  return { ...input, unitPricePence, finalPricePence, lineTotalPence: lineTotal };
}

/**
 * Check a manual discount against the actor's role limit. Returns the
 * outcome the UI needs: allowed as-is, or allowed only with a manager
 * PIN approval (verifyPin against the approver's stored hash).
 */
export function checkManualDiscount(input: {
  roles: RoleName[];
  lineTotalBeforeManualPence: bigint;
  manualDiscountPence: bigint;
  approverPin?: string;
  approverPinHash?: string;
  approverRoles?: RoleName[];
}): { allowed: boolean; needsApproval: boolean; approvalRef: string | null; reason: string | null } {
  const limit = discountLimitForRoles(input.roles);
  if (input.manualDiscountPence < 0n) {
    return { allowed: false, needsApproval: false, approvalRef: null, reason: 'Manual discount must not be negative' };
  }
  if (input.manualDiscountPence === 0n) {
    return { allowed: true, needsApproval: false, approvalRef: null, reason: null };
  }
  if (limit === null) {
    return { allowed: true, needsApproval: false, approvalRef: null, reason: null };
  }
  const maxPence = (input.lineTotalBeforeManualPence * BigInt(limit)) / 100n;
  if (input.manualDiscountPence <= maxPence) {
    return { allowed: true, needsApproval: false, approvalRef: null, reason: null };
  }
  // Above the role limit: a manager/admin/owner PIN approval is required.
  if (
    input.approverPin !== undefined &&
    input.approverPinHash !== undefined &&
    input.approverRoles !== undefined &&
    input.approverRoles.some((role) => role === 'manager' || role === 'admin' || role === 'owner') &&
    verifyPin(input.approverPin, input.approverPinHash)
  ) {
    return {
      allowed: true,
      needsApproval: true,
      // Opaque local reference (never the PIN, never the hash).
      approvalRef: `offline-pin:${input.approverRoles.join('+')}:${Date.now()}`,
      reason: null,
    };
  }
  return {
    allowed: false,
    needsApproval: true,
    approvalRef: null,
    reason: `Manual discount of ${input.manualDiscountPence.toString()}p exceeds the ${limit}% role limit (${maxPence.toString()}p) — manager PIN approval required`,
  };
}
