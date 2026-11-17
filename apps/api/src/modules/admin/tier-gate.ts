/**
 * TierGate — per-resource tier gating (Build-03 Objective 1;
 * Arch-02 §4.4).
 *
 * THE TIER ITSELF IS UNDECIDED: Arch-02 §4.4 states the tier names are
 * planning labels, not prices — the package's £29/£39/£49 are planning
 * points, and "the actual tier names, prices and the decision itself
 * are for the owner". This implementation therefore resolves the tier
 * from tenant metadata (tenants.plan_tier, 'base' | 'plus', default
 * 'base' when the tenant is unknown) and gates ONLY the documented
 * writes:
 *   cost-vendor-write  (cost/vendor data on inventory adjustments)
 *   custom-roles       (custom user roles / permission sets)
 *   advanced-reporting (custom reports, period compare, forecasting)
 *   bulk-import-api    (catalogue/stock import via API; CSV via the
 *                       dashboard is a Base P0 feature and is NOT gated)
 *
 * NEVER GATED — enforced by having no code path that gates them, and
 * covered by tests: API access itself (read + write, all scopes),
 * webhook subscriptions + Events API, the single-click full export,
 * read access to the merchant's own data, and rate limits (same for
 * all tiers, Arch-02 §2.4).
 *
 * A gated write returns 403 with error.code "PLAN_GATED" and a message
 * naming the tier that unlocks it — never a silent failure and never a
 * misleading 404 (Arch-02 §4.4 rules).
 *
 * WIRING NOTE: the documented gated writes have no Build-02 endpoint
 * yet (there is no bulk-import API, no custom-roles endpoint and no
 * advanced-reporting endpoint in this build, and gating goods-in or
 * stock counts would block P0 pilot flows for base-tier merchants —
 * those are ordinary stock movements, not the cost/vendor adjustment
 * write Square gates). TierGate is therefore enforced through the
 * AuthGuard's @TierGated() decorator, so the first endpoint that
 * implements one of these writes declares it and gets the check
 * server-side on every request. The gate itself is fully tested here.
 */
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';

export type PlanTier = 'base' | 'plus';

/** Documented gated writes (Arch-02 §4.4). The value is the tier that unlocks the write. */
export const TIER_GATED_WRITES = {
  'cost-vendor-write': 'plus',
  'custom-roles': 'plus',
  'advanced-reporting': 'plus',
  'bulk-import-api': 'plus',
} as const;

export type GatedWriteFeature = keyof typeof TIER_GATED_WRITES;

/** Reads and exports are never gated — these are the always-allowed operations. */
export const NEVER_GATED = [
  'api-access',
  'webhooks-and-events',
  'full-export',
  'read-own-data',
  'rate-limits',
] as const;

export class PlanGatedException extends HttpException {
  constructor(feature: GatedWriteFeature) {
    super(
      {
        error: {
          code: 'PLAN_GATED',
          message: `This write requires the ${TIER_GATED_WRITES[feature]} tier: ${feature}.`,
          required_tier: TIER_GATED_WRITES[feature],
          feature,
        },
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

@Injectable()
export class TierGate {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** Per-tenant tier from tenant metadata; unknown tenants default to 'base'. */
  async tierForTenant(tenantId: string): Promise<PlanTier> {
    const row = await this.db
      .selectFrom('tenants')
      .select('plan_tier')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    return row?.plan_tier ?? 'base';
  }

  /** Pure decision: is this write allowed on this tier? Every documented gated write requires 'plus'. */
  static isWriteAllowed(tier: PlanTier, feature: GatedWriteFeature): boolean {
    return tier === TIER_GATED_WRITES[feature];
  }

  /** Throw PlanGatedException (403 PLAN_GATED) when the tenant's tier lacks the write. */
  async assertWriteAllowed(tenantId: string, feature: GatedWriteFeature): Promise<void> {
    const tier = await this.tierForTenant(tenantId);
    if (!TierGate.isWriteAllowed(tier, feature)) {
      throw new PlanGatedException(feature);
    }
  }

  /**
   * Reads are never gated (Arch-02 §4.4). This method exists so call
   * sites state the rule explicitly instead of silently skipping a
   * check — it always resolves.
   */
  async assertReadAllowed(_tenantId: string): Promise<void> {
    return undefined;
  }

  /** Exports are never gated (Arch-02 §4.4 / Arch-01 §4.1 — the merchant's own data). */
  async assertExportAllowed(_tenantId: string): Promise<void> {
    return undefined;
  }
}
