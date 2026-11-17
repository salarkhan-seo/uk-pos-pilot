/**
 * Roles, discount limits and approval actions (Build-02, Objective 2).
 *
 * DESIGN DECISIONS (not research facts) — recorded here, in the code
 * comments where they are applied, and in the README:
 *
 *  - Per-role manual-discount limits are PERCENTAGES of the line total:
 *    cashier 0% (a cashier can never discount without approval), manager
 *    10%, admin 25%, owner unlimited. Lightspeed's permissive 100%
 *    default is explicitly rejected (T-07 §4). The percentages live here
 *    in code; role_permissions.discount_limit_pence is NOT used for
 *    manual discounts in Build-02 (it remains available for future
 *    absolute per-permission caps).
 *  - Approval actions are the six events Arch-04 §2.8 requires as
 *    first-class approval records: discounts above the role limit, price
 *    overrides, refunds above threshold, post-tender voids, cash paid
 *    out, and till-close variance (D-08: higher of £10 or 2%).
 */
import type { RoleName as DbRoleName } from '@uk-pos/db';

export type RoleName = DbRoleName;

/** Manual-discount limit as a percentage of the line total; null = unlimited. */
export const DEFAULT_ROLE_DISCOUNT_LIMITS: Readonly<Record<RoleName, number | null>> = {
  cashier: 0,
  manager: 10,
  admin: 25,
  owner: null,
} as const;

export const APPROVAL_ACTIONS = [
  'discount_above_limit',
  'price_override',
  'refund_above_threshold',
  'void_post_tender',
  'cash_paid_out',
  'till_close_variance',
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** The highest discount limit among the actor's roles (owner wins). */
export function discountLimitForRoles(roles: readonly RoleName[]): number | null {
  let limit: number | null = 0;
  for (const role of roles) {
    const roleLimit = DEFAULT_ROLE_DISCOUNT_LIMITS[role];
    if (roleLimit === null) {
      return null;
    }
    if (roleLimit > (limit ?? 0)) {
      limit = roleLimit;
    }
  }
  return limit;
}
