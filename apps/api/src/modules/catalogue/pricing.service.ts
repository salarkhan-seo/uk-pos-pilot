import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import {
  allocateBasketDiscount,
  divRoundHalfUp,
  taxBreakdownForLine,
  type TaxRateKind,
} from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { discountLimitForRoles } from '../../common/roles';

/**
 * PricingService — the Arch-10 Deterministic Pricing Pipeline (Build-02,
 * Objective 3). Evaluated server-side, in this EXACT order:
 *
 *   1. base variant price
 *   2. active price book (highest priority wins, ties by latest
 *      effective_from)
 *   3. automatic promotions (BOGO/multibuy BEFORE percentage/fixed)
 *   4. voucher code (basket-level, after automatic promotions)
 *   5. manual discounts (per-line, role-limit checked)
 *   6. D-14 basket-discount allocation (pro-rata, remainder to the
 *      largest line) + D-13 per-line tax snapshot (tax-inclusive)
 *
 * DESIGN DECISIONS (recorded here, not research facts):
 *  - Unit conversion: when a line names a unit, the quantity is converted
 *    to base units (quantity × conversion_factor, an integer) and priced
 *    at the variant's per-base-unit price. The priced line echoes the
 *    caller's quantity/unit; totals use the converted quantity.
 *  - Stacking: among automatic promotions on one line, promotions that
 *    share a non-null stack_group sum; promotions with a null stack_group
 *    never stack with each other — only the largest single one is taken.
 *    The line takes the single best stack (largest total discount).
 *  - BOGO/multibuy precedence (Arch-10's ordering rule): a BOGO or
 *    multibuy discount on a line BLOCKS percentage/fixed promotions on
 *    that line UNLESS they share its stack_group. A percentage/fixed
 *    promotion never displaces an applicable BOGO/multibuy, even when
 *    its discount is larger.
 *  - Voucher discount is basket-level: it is allocated across lines
 *    pro-rata by after-promotion line total (the same D-14 allocator),
 *    so per-line totals stay exact and the manual-discount limit in
 *    step 5 is measured on the line price after steps 1–4 (voucher
 *    included).
 *  - Subtotal is the sum of line totals after step 2 (price book) and
 *    before steps 3–6, so subtotal − discount = total holds exactly,
 *    with discount = automatic promotions + voucher + manual + basket
 *    allocation.
 *  - Tax is computed from the rate KIND via the shared kernel (D-13);
 *    the DB rate_percent is snapshotted on the priced line for the
 *    order record, not used for the arithmetic.
 *
 * priceBasket VALIDATES ONLY — it writes no applied_promotions rows (the
 * order does not exist yet). The priced result carries appliedPromotions
 * per line and the voucher promotion on the basket; the sales module
 * writes the rows when it creates the order. redeemVoucher likewise only
 * increments uses_count; the caller records applied_promotions.
 */

export interface PriceBasketLineInput {
  variantId: string;
  quantity: bigint;
  unitId?: string | null;
  manualDiscountPence?: bigint;
}

export interface AppliedPromotionResult {
  promotionId: string;
  promotionVersion: number;
  discountPence: bigint;
}

export interface PricedLine {
  variantId: string;
  quantity: bigint;
  unitId: string | null;
  basePricePence: bigint;
  priceBookId: string | null;
  priceBookPricePence: bigint | null;
  promotionDiscountPence: bigint;
  manualDiscountPence: bigint;
  /** Per-unit price after steps 2–5 (before basket allocation). */
  finalPricePence: bigint;
  /** Line total after ALL discounts, including the basket allocation. */
  lineTotalPence: bigint;
  taxRateKind: TaxRateKind;
  taxRatePercent: string;
  taxAmountPence: bigint;
  appliedPromotions: AppliedPromotionResult[];
}

export interface PricedBasket {
  lines: PricedLine[];
  /** Sum of line totals after the price book, before steps 3–6. */
  subtotalPence: bigint;
  /** Automatic promotions + voucher + manual + basket allocation. */
  discountPence: bigint;
  taxPence: bigint;
  /** Sum of lineTotalPence; equals subtotalPence − discountPence. */
  totalPence: bigint;
  voucherPromotionId?: string | null;
  voucherDiscountPence?: bigint;
}

export interface PriceBasketOptions {
  voucherCode?: string;
  basketDiscountPence?: bigint;
  approvalEventsId?: string | null;
}

export interface RedeemVoucherInput {
  orderId: string;
  voucherCode: string;
  userId: string;
}

type PromotionRow = {
  id: string;
  type: string;
  version: number;
  stack_group: string | null;
};

type ConditionMap = Map<string, Array<{ condition_type: string; condition_value: Record<string, unknown> }>>;
type TargetMap = Map<string, Array<{ target_type: string; target_id: string }>>;

interface PromoCandidate {
  promotionId: string;
  promotionVersion: number;
  stackGroup: string | null;
  kind: 'qty' | 'rate';
  discountPence: bigint;
}

/** The best stack wins: null-group candidates compete singly (largest), named groups sum. */
function bestStack(candidates: PromoCandidate[]): PromoCandidate[] {
  if (candidates.length === 0) {
    return [];
  }
  const namedGroups = new Map<string, PromoCandidate[]>();
  let bestSingle: PromoCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.stackGroup === null) {
      if (bestSingle === null || candidate.discountPence > bestSingle.discountPence) {
        bestSingle = candidate;
      }
    } else {
      const group = namedGroups.get(candidate.stackGroup) ?? [];
      group.push(candidate);
      namedGroups.set(candidate.stackGroup, group);
    }
  }
  let best: PromoCandidate[] = bestSingle === null ? [] : [bestSingle];
  let bestTotal = best.reduce((sum, c) => sum + c.discountPence, 0n);
  for (const group of namedGroups.values()) {
    const total = group.reduce((sum, c) => sum + c.discountPence, 0n);
    if (total > bestTotal) {
      best = group;
      bestTotal = total;
    }
  }
  return best;
}

function conditionObject(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function bigintField(obj: Record<string, unknown>, key: string): bigint | undefined {
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'bigint') {
    return value;
  }
  return undefined;
}

function getConditions(conditions: ConditionMap, promotionId: string, type: string): Record<string, unknown> | undefined {
  const rows = conditions.get(promotionId) ?? [];
  for (const row of rows) {
    if (row.condition_type === type) {
      return conditionObject(row.condition_value);
    }
  }
  return undefined;
}

@Injectable()
export class PricingService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async priceBasket(
    actor: Actor,
    lines: PriceBasketLineInput[],
    opts: PriceBasketOptions = {},
    trx?: Kysely<DB>,
  ): Promise<PricedBasket> {
    const q = trx ?? this.db;
    const now = new Date();
    if (lines.length === 0) {
      throw new BadRequestException('Basket must contain at least one line');
    }

    // -- Load variants, tax rates, price books, and unit conversions. ----
    interface LoadedLine {
      input: PriceBasketLineInput;
      productId: string;
      categoryId: string | null;
      basePricePence: bigint;
      taxRateKind: TaxRateKind;
      taxRatePercent: string;
      unitPricePence: bigint;
      priceBookId: string | null;
      priceBookPricePence: bigint | null;
      effectiveQuantity: bigint;
      lineTotalAtBook: bigint;
    }
    const loaded: LoadedLine[] = [];
    for (const input of lines) {
      if (input.quantity <= 0n) {
        throw new BadRequestException('Line quantity must be positive');
      }
      const manual = input.manualDiscountPence ?? 0n;
      if (manual < 0n) {
        throw new BadRequestException('Manual discount must not be negative');
      }
      const variant = await q
        .selectFrom('product_variants')
        .selectAll()
        .where('id', '=', input.variantId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (variant === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (variant.tax_rate_id === null) {
        throw new BadRequestException('Variant has no tax rate');
      }
      const taxRate = await q
        .selectFrom('tax_rates')
        .selectAll()
        .where('id', '=', variant.tax_rate_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (taxRate === undefined) {
        throw new NotFoundException('Resource not found');
      }
      const product = await q
        .selectFrom('products')
        .selectAll()
        .where('id', '=', variant.product_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (product === undefined) {
        throw new NotFoundException('Resource not found');
      }
      // Unit conversion (design decision): a named unit converts the
      // quantity to base units at the variant's per-base-unit price.
      let effectiveQuantity = input.quantity;
      if (input.unitId !== undefined && input.unitId !== null) {
        const variantUnit = await q
          .selectFrom('variant_units')
          .selectAll()
          .where('variant_id', '=', variant.id)
          .where('unit_id', '=', input.unitId)
          .executeTakeFirst();
        if (variantUnit === undefined) {
          throw new NotFoundException('Resource not found');
        }
        const factor = Number(variantUnit.conversion_factor);
        if (!Number.isInteger(factor) || factor <= 0) {
          throw new BadRequestException('Variant unit conversion factor must be a positive integer');
        }
        effectiveQuantity = input.quantity * BigInt(factor);
      }
      // Step 2 — active price book: highest priority wins, ties by
      // latest effective_from.
      const priceBook = await q
        .selectFrom('price_books')
        .innerJoin('price_book_entries', 'price_book_entries.price_book_id', 'price_books.id')
        .select([
          'price_books.id as priceBookId',
          'price_book_entries.price_pence as pricePence',
          'price_books.priority as priority',
          'price_books.effective_from as effectiveFrom',
        ])
        .where('price_books.tenant_id', '=', actor.tenantId)
        .where('price_book_entries.variant_id', '=', variant.id)
        .where('price_books.status', '=', 'active')
        .where('price_books.effective_from', '<=', now)
        .where((eb) =>
          eb.or([eb('price_books.effective_to', 'is', null), eb('price_books.effective_to', '>=', now)]),
        )
        .orderBy('price_books.priority', 'desc')
        .orderBy('price_books.effective_from', 'desc')
        .executeTakeFirst();
      const unitPricePence = priceBook === undefined ? variant.price_pence : priceBook.pricePence;
      loaded.push({
        input,
        productId: product.id,
        categoryId: product.category_id,
        basePricePence: variant.price_pence,
        taxRateKind: taxRate.kind,
        taxRatePercent: taxRate.rate_percent,
        unitPricePence,
        priceBookId: priceBook === undefined ? null : priceBook.priceBookId,
        priceBookPricePence: priceBook === undefined ? null : priceBook.pricePence,
        effectiveQuantity,
        lineTotalAtBook: unitPricePence * effectiveQuantity,
      });
    }
    const subtotalPence = loaded.reduce((sum, l) => sum + l.lineTotalAtBook, 0n);

    // -- Step 3 — automatic promotions. ----------------------------------
    const promos: PromotionRow[] = await q
      .selectFrom('promotions')
      .select(['id', 'type', 'version', 'stack_group'])
      .where('tenant_id', '=', actor.tenantId)
      .where('status', '=', 'active')
      .where('start_at', '<=', now)
      .where((eb) => eb.or([eb('end_at', 'is', null), eb('end_at', '>=', now)]))
      .execute();
    const conditions: ConditionMap = new Map();
    const targets: TargetMap = new Map();
    if (promos.length > 0) {
      const promoIds = promos.map((p) => p.id);
      const conditionRows = await q
        .selectFrom('promotion_conditions')
        .select(['promotion_id', 'condition_type', 'condition_value'])
        .where('promotion_id', 'in', promoIds)
        .execute();
      for (const row of conditionRows) {
        const list = conditions.get(row.promotion_id) ?? [];
        list.push({ condition_type: row.condition_type, condition_value: row.condition_value });
        conditions.set(row.promotion_id, list);
      }
      const targetRows = await q
        .selectFrom('promotion_targets')
        .select(['promotion_id', 'target_type', 'target_id'])
        .where('promotion_id', 'in', promoIds)
        .execute();
      for (const row of targetRows) {
        const list = targets.get(row.promotion_id) ?? [];
        list.push({ target_type: row.target_type, target_id: row.target_id });
        targets.set(row.promotion_id, list);
      }
    }

    const promotionDiscounts: bigint[] = [];
    const appliedPerLine: AppliedPromotionResult[][] = [];
    const afterPromoTotals: bigint[] = [];
    for (const line of loaded) {
      const candidates: PromoCandidate[] = [];
      for (const promo of promos) {
        // Target match: no target rows = scope all. A customer_group
        // target never matches here — the basket carries no customer.
        const promoTargets = targets.get(promo.id) ?? [];
        if (promoTargets.length > 0) {
          const matches = promoTargets.some((t) => {
            if (t.target_type === 'variant') return t.target_id === line.input.variantId;
            if (t.target_type === 'product') return t.target_id === line.productId;
            if (t.target_type === 'category') return line.categoryId !== null && t.target_id === line.categoryId;
            return false;
          });
          if (!matches) continue;
        }
        // Gating conditions (all must hold).
        const minQty = getConditions(conditions, promo.id, 'min_quantity');
        if (minQty !== undefined) {
          const min = numberField(minQty, 'minQty');
          if (min !== undefined && line.effectiveQuantity < BigInt(min)) continue;
        }
        const minBasket = getConditions(conditions, promo.id, 'min_basket_total');
        if (minBasket !== undefined) {
          const min = bigintField(minBasket, 'minTotalPence');
          if (min !== undefined && subtotalPence < min) continue;
        }
        // Discount parameters by promotion type.
        const qty = line.effectiveQuantity;
        const unit = line.unitPricePence;
        const lineTotal = line.lineTotalAtBook;
        let discount = 0n;
        let kind: 'qty' | 'rate';
        if (promo.type === 'percentage') {
          const params = getConditions(conditions, promo.id, 'percent');
          const percent = params === undefined ? undefined : numberField(params, 'percent');
          if (percent === undefined) continue;
          discount = divRoundHalfUp(lineTotal * BigInt(Math.trunc(percent)), 100n);
          kind = 'rate';
        } else if (promo.type === 'fixed') {
          const params = getConditions(conditions, promo.id, 'fixed_amount');
          const amount = params === undefined ? undefined : bigintField(params, 'amountPence');
          if (amount === undefined) continue;
          discount = amount > lineTotal ? lineTotal : amount;
          kind = 'rate';
        } else if (promo.type === 'bogo') {
          const params = getConditions(conditions, promo.id, 'bogo');
          const buyQty = params === undefined ? undefined : numberField(params, 'buyQty');
          const getQty = params === undefined ? undefined : numberField(params, 'getQty');
          if (buyQty === undefined || getQty === undefined || buyQty <= 0 || getQty <= 0) continue;
          const setSize = BigInt(buyQty + getQty);
          const sets = qty / setSize;
          discount = sets * BigInt(getQty) * unit;
          kind = 'qty';
        } else if (promo.type === 'multibuy') {
          const params = getConditions(conditions, promo.id, 'multibuy');
          const requiredQty = params === undefined ? undefined : numberField(params, 'requiredQty');
          const bundlePrice = params === undefined ? undefined : bigintField(params, 'bundlePricePence');
          if (requiredQty === undefined || bundlePrice === undefined || requiredQty <= 0) continue;
          const sets = qty / BigInt(requiredQty);
          const perSet = BigInt(requiredQty) * unit - bundlePrice;
          discount = sets * (perSet > 0n ? perSet : 0n);
          kind = 'qty';
        } else {
          // bundle / loyalty_bonus / staff promotions are not automatic
          // line promotions in Build-02 — they are never applied here.
          continue;
        }
        if (discount <= 0n) continue;
        if (discount > lineTotal) discount = lineTotal;
        candidates.push({
          promotionId: promo.id,
          promotionVersion: promo.version,
          stackGroup: promo.stack_group,
          kind,
          discountPence: discount,
        });
      }
      // Evaluation order: BOGO/multibuy BEFORE percentage/fixed. A qty
      // discount blocks rate promotions unless they share its stack_group.
      const qtyCandidates = candidates.filter((c) => c.kind === 'qty');
      const rateCandidates = candidates.filter((c) => c.kind === 'rate');
      let applied: PromoCandidate[];
      if (qtyCandidates.length > 0) {
        applied = bestStack(qtyCandidates);
        const sharedGroups = new Set(applied.map((c) => c.stackGroup).filter((g): g is string => g !== null));
        const sharingRates = rateCandidates.filter(
          (c) => c.stackGroup !== null && sharedGroups.has(c.stackGroup),
        );
        applied = [...applied, ...bestStack(sharingRates)];
      } else {
        applied = bestStack(rateCandidates);
      }
      const discountTotal = applied.reduce((sum, c) => sum + c.discountPence, 0n);
      promotionDiscounts.push(discountTotal);
      appliedPerLine.push(
        applied.map((c) => ({
          promotionId: c.promotionId,
          promotionVersion: c.promotionVersion,
          discountPence: c.discountPence,
        })),
      );
      afterPromoTotals.push(line.lineTotalAtBook - discountTotal);
    }

    // -- Step 4 — voucher code (basket-level, validates only). ------------
    let voucherPromotionId: string | null = null;
    let voucherDiscountPence = 0n;
    let voucherAllocations: bigint[] = loaded.map(() => 0n);
    if (opts.voucherCode !== undefined && opts.voucherCode !== '') {
      const { voucher, promotion, params } = await this.loadVoucher(q, actor, opts.voucherCode, now);
      this.checkVoucherUses(voucher);
      voucherPromotionId = promotion.id;
      const afterPromoBasket = afterPromoTotals.reduce((sum, t) => sum + t, 0n);
      if (promotion.type === 'percentage') {
        const percent = numberField(params, 'percent');
        if (percent === undefined) {
          throw new BadRequestException('Voucher promotion has no percent parameter');
        }
        voucherDiscountPence = divRoundHalfUp(afterPromoBasket * BigInt(Math.trunc(percent)), 100n);
      } else {
        const amount = bigintField(params, 'amountPence');
        if (amount === undefined) {
          throw new BadRequestException('Voucher promotion has no fixed amount parameter');
        }
        voucherDiscountPence = amount > afterPromoBasket ? afterPromoBasket : amount;
      }
      if (voucherDiscountPence > 0n && afterPromoBasket > 0n) {
        try {
          voucherAllocations = allocateBasketDiscount(
            voucherDiscountPence,
            afterPromoTotals.map((total) => ({ lineTotalPence: total })),
          );
        } catch (error) {
          throw new BadRequestException(
            `Voucher discount cannot be allocated: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // -- Step 5 — manual discounts (role-limit checked). ------------------
    // DESIGN DECISION: the limit is a percentage of the line's price after
    // steps 1–4 (base → price book → automatic promotions → voucher).
    // When any line exceeds its role limit, an approval_events row is
    // REQUIRED: action 'discount_above_limit', amount_pence covering the
    // TOTAL manual discount across the basket, approved by someone other
    // than the actor.
    const afterVoucherTotals = afterPromoTotals.map(
      (total, i) => total - (voucherAllocations[i] ?? 0n),
    );
    const manualPerLine = loaded.map((l) => l.input.manualDiscountPence ?? 0n);
    const totalManual = manualPerLine.reduce((sum, m) => sum + m, 0n);
    for (let i = 0; i < loaded.length; i += 1) {
      const manual = manualPerLine[i] ?? 0n;
      const afterSteps14 = afterVoucherTotals[i] ?? 0n;
      if (manual > afterSteps14) {
        throw new BadRequestException('Manual discount exceeds the line total');
      }
    }
    const limitPercent = discountLimitForRoles(actor.roles);
    let needsApproval = false;
    if (limitPercent !== null) {
      for (let i = 0; i < loaded.length; i += 1) {
        const manual = manualPerLine[i] ?? 0n;
        const afterSteps14 = afterVoucherTotals[i] ?? 0n;
        const limitPence = divRoundHalfUp(afterSteps14 * BigInt(limitPercent), 100n);
        if (manual > limitPence) {
          needsApproval = true;
          break;
        }
      }
    }
    if (needsApproval) {
      if (opts.approvalEventsId === undefined || opts.approvalEventsId === null) {
        throw new ForbiddenException('Manual discount above the role limit requires an approval');
      }
      const approval = await q
        .selectFrom('approval_events')
        .selectAll()
        .where('id', '=', opts.approvalEventsId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (
        approval === undefined ||
        approval.action !== 'discount_above_limit' ||
        approval.amount_pence === null ||
        approval.amount_pence < totalManual ||
        approval.approved_by_user_id === actor.userId
      ) {
        throw new ForbiddenException('Manual discount above the role limit requires a valid approval');
      }
    }

    // -- Step 6 — D-14 basket allocation + D-13 per-line tax. -------------
    const preBasketTotals = afterVoucherTotals.map((total, i) => total - (manualPerLine[i] ?? 0n));
    const basketDiscountPence = opts.basketDiscountPence ?? 0n;
    if (basketDiscountPence < 0n) {
      throw new BadRequestException('Basket discount must not be negative');
    }
    let basketAllocations: bigint[] = loaded.map(() => 0n);
    if (basketDiscountPence > 0n) {
      try {
        basketAllocations = allocateBasketDiscount(
          basketDiscountPence,
          preBasketTotals.map((total) => ({ lineTotalPence: total })),
        );
      } catch (error) {
        throw new BadRequestException(
          `Basket discount cannot be allocated: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const pricedLines: PricedLine[] = [];
    let taxPence = 0n;
    for (let i = 0; i < loaded.length; i += 1) {
      const line = loaded[i];
      if (line === undefined) continue;
      const preBasket = preBasketTotals[i] ?? 0n;
      const finalTotal = preBasket - (basketAllocations[i] ?? 0n);
      const breakdown = taxBreakdownForLine(finalTotal, line.taxRateKind);
      taxPence += breakdown.vatPence;
      pricedLines.push({
        variantId: line.input.variantId,
        quantity: line.input.quantity,
        unitId: line.input.unitId ?? null,
        basePricePence: line.basePricePence,
        priceBookId: line.priceBookId,
        priceBookPricePence: line.priceBookPricePence,
        promotionDiscountPence: promotionDiscounts[i] ?? 0n,
        manualDiscountPence: manualPerLine[i] ?? 0n,
        finalPricePence: divRoundHalfUp(preBasket, line.effectiveQuantity),
        lineTotalPence: finalTotal,
        taxRateKind: line.taxRateKind,
        taxRatePercent: line.taxRatePercent,
        taxAmountPence: breakdown.vatPence,
        appliedPromotions: appliedPerLine[i] ?? [],
      });
    }

    const promoTotal = promotionDiscounts.reduce((sum, d) => sum + d, 0n);
    const discountPence = promoTotal + voucherDiscountPence + totalManual + basketDiscountPence;
    const totalPence = pricedLines.reduce((sum, l) => sum + l.lineTotalPence, 0n);
    return {
      lines: pricedLines,
      subtotalPence,
      discountPence,
      taxPence,
      totalPence,
      voucherPromotionId,
      voucherDiscountPence,
    };
  }

  /**
   * Load and validate a voucher code, in the fixed order the spec requires:
   * exists → status 'active' → now within valid_from/valid_to → the linked
   * promotion exists and is percentage or fixed. The uses_count check is
   * NOT done here: priceBasket checks it, and redeemVoucher checks it
   * only after the idempotency check, so a replay of an already-recorded
   * redemption still returns the existing result when the code is spent.
   */
  private async loadVoucher(
    q: Kysely<DB>,
    actor: Actor,
    code: string,
    now: Date,
  ): Promise<{
    voucher: { id: string; uses_count: number; max_uses: number };
    promotion: { id: string; type: string };
    params: Record<string, unknown>;
  }> {
    const codeHash = createHash('sha256').update(code).digest('hex');
    const voucher = await q
      .selectFrom('voucher_codes')
      .select(['id', 'promotion_id', 'status', 'max_uses', 'uses_count', 'valid_from', 'valid_to'])
      .where('tenant_id', '=', actor.tenantId)
      .where('code_hash', '=', codeHash)
      .executeTakeFirst();
    if (voucher === undefined) {
      throw new BadRequestException('Voucher code not found');
    }
    if (voucher.status !== 'active') {
      throw new BadRequestException(`Voucher code is ${voucher.status}`);
    }
    if (voucher.valid_from > now || (voucher.valid_to !== null && voucher.valid_to < now)) {
      throw new BadRequestException('Voucher code is outside its validity window');
    }
    if (voucher.promotion_id === null) {
      throw new BadRequestException('Voucher code has no promotion');
    }
    const promotion = await q
      .selectFrom('promotions')
      .select(['id', 'type'])
      .where('id', '=', voucher.promotion_id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (promotion === undefined) {
      throw new BadRequestException('Voucher promotion not found');
    }
    if (promotion.type !== 'percentage' && promotion.type !== 'fixed') {
      throw new BadRequestException('Voucher promotion must be percentage or fixed');
    }
    const conditionRows = await q
      .selectFrom('promotion_conditions')
      .select(['condition_type', 'condition_value'])
      .where('promotion_id', '=', promotion.id)
      .execute();
    const conditionMap: ConditionMap = new Map([
      [
        promotion.id,
        conditionRows.map((r) => ({ condition_type: r.condition_type, condition_value: r.condition_value })),
      ],
    ]);
    const params =
      getConditions(conditionMap, promotion.id, promotion.type === 'percentage' ? 'percent' : 'fixed_amount') ?? {};
    return {
      voucher: { id: voucher.id, uses_count: voucher.uses_count, max_uses: voucher.max_uses },
      promotion: { id: promotion.id, type: promotion.type },
      params,
    };
  }

  /** Check the uses_count limit for a validated voucher (priceBasket path). */
  private checkVoucherUses(voucher: { uses_count: number; max_uses: number }): void {
    if (voucher.uses_count >= voucher.max_uses) {
      throw new BadRequestException('Voucher code has no uses remaining');
    }
  }

  /**
   * Redeem a voucher inside the order's transaction (called by
   * SalesService). Re-validates the code, then atomically increments
   * uses_count with UPDATE ... WHERE uses_count < max_uses — 0 updated
   * rows means the code was exhausted by a concurrent redemption.
   *
   * Single-use idempotency: if an applied_promotions row already exists
   * for (orderId, promotionId), this is a replay — return the recorded
   * discount WITHOUT incrementing. The discount amount is recomputed by
   * the caller from the priced basket (a percentage voucher's amount
   * depends on the basket); for a fixed voucher the parameter amount is
   * returned, and for a replay the recorded amount is returned.
   */
  async redeemVoucher(
    actor: Actor,
    trx: Kysely<DB>,
    input: RedeemVoucherInput,
  ): Promise<{ promotionId: string; discountPence: bigint }> {
    const now = new Date();
    const { voucher, promotion, params } = await this.loadVoucher(trx, actor, input.voucherCode, now);
    const existing = await trx
      .selectFrom('applied_promotions')
      .select(['discount_pence'])
      .where('tenant_id', '=', actor.tenantId)
      .where('order_id', '=', input.orderId)
      .where('promotion_id', '=', promotion.id)
      .executeTakeFirst();
    if (existing !== undefined) {
      return { promotionId: promotion.id, discountPence: existing.discount_pence };
    }
    this.checkVoucherUses(voucher);
    const updated = await trx
      .updateTable('voucher_codes')
      .set({ uses_count: sql`uses_count + 1` })
      .where('id', '=', voucher.id)
      .where('tenant_id', '=', actor.tenantId)
      .where((eb) => eb('uses_count', '<', eb.ref('max_uses')))
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) {
      throw new BadRequestException('Voucher code has no uses remaining');
    }
    if (promotion.type === 'fixed') {
      const amount = bigintField(params, 'amountPence');
      return { promotionId: promotion.id, discountPence: amount ?? 0n };
    }
    // Percentage voucher: the amount depends on the basket, so the
    // caller (SalesService) recomputes it from the priced basket.
    return { promotionId: promotion.id, discountPence: 0n };
  }
}
