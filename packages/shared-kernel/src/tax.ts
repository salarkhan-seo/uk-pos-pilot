/**
 * D-13 — per-line round-half-up tax calculation for TAX-INCLUSIVE UK prices
 * (D-13 Option A: round half up per line, then sum).
 *
 * UK till prices are tax-inclusive: the price on the shelf already includes
 * VAT. Given a tax-inclusive line total in pence and a rate, the VAT portion
 * is:
 *
 *   vat = round_half_up(total * rate / (100 + rate))
 *   net = total - vat
 *
 * All arithmetic is exact integer (bigint) arithmetic — no float anywhere.
 * `exempt` lines carry no VAT and are reported separately from `zero`-rated
 * lines (they are different for a VAT return even though both charge 0p).
 */
import { divRoundHalfUp, sumMoney } from './money';
import { TAX_RATES, type Money, type TaxRateKind } from './types';

export interface TaxBreakdown {
  /** Tax-inclusive line total, pence. */
  grossPence: Money;
  /** VAT portion of the total, pence. */
  vatPence: Money;
  /** Net (ex-VAT) portion of the total, pence. Always gross - vat. */
  netPence: Money;
  /** The rate kind this breakdown was computed with. */
  rateKind: TaxRateKind;
}

/**
 * Compute the VAT portion of a single tax-inclusive line total.
 * Throws on a negative total (a return line is a separate, negative amount
 * computed from its own positive total — see `taxBreakdownForReturn`).
 */
export function taxBreakdownForLine(totalPence: Money, rateKind: TaxRateKind): TaxBreakdown {
  if (totalPence < 0n) {
    throw new Error('taxBreakdownForLine: total must be non-negative; use taxBreakdownForReturn for returns');
  }
  const rate = TAX_RATES[rateKind];
  // vat = round_half_up(total * rateNum / (rateDen + rateNum))
  // e.g. standard: total * 20 / 120; reduced: total * 5 / 105; zero/exempt: 0.
  const vatPence =
    rate.rateNum === 0n ? 0n : divRoundHalfUp(totalPence * rate.rateNum, rate.rateDen + rate.rateNum);
  return {
    grossPence: totalPence,
    vatPence,
    netPence: totalPence - vatPence,
    rateKind,
  };
}

/**
 * VAT breakdown for a return line. A return reverses the original sale's
 * VAT exactly: the return's VAT is the negative of the VAT computed on the
 * original (positive) line total, so the Z-report and VAT return net to zero
 * for that line. Never recompute VAT on a negative total.
 */
export function taxBreakdownForReturn(originalTotalPence: Money, rateKind: TaxRateKind): TaxBreakdown {
  const original = taxBreakdownForLine(originalTotalPence, rateKind);
  return {
    grossPence: -original.grossPence,
    vatPence: -original.vatPence,
    netPence: -original.netPence,
    rateKind,
  };
}

export interface MixedBasketLine {
  /** Tax-inclusive line total in pence (quantity × unit price, after any
   *  line discount already allocated — see discounts.ts for D-14). */
  totalPence: Money;
  rateKind: TaxRateKind;
}

export interface MixedBasketBreakdown {
  /** Per-rate-kind totals. A kind with no lines is absent. */
  byRate: Partial<Record<TaxRateKind, { grossPence: Money; vatPence: Money; netPence: Money }>>;
  /** Basket totals: gross = sum of line totals; vat = sum of per-line VAT
   *  (D-13: round per line, THEN sum — never round the basket total). */
  totals: { grossPence: Money; vatPence: Money; netPence: Money };
  /** One breakdown per input line, in input order. */
  lines: TaxBreakdown[];
}

/**
 * Mixed-basket VAT breakdown (D-13). Each line is rounded half-up on its
 * own, then the per-line VAT figures are summed — the basket total is never
 * rounded as a whole, so the per-rate figures and the totals always agree
 * to the penny.
 */
export function mixedBasketBreakdown(lines: readonly MixedBasketLine[]): MixedBasketBreakdown {
  const breakdowns = lines.map((line) => taxBreakdownForLine(line.totalPence, line.rateKind));
  const byRate: MixedBasketBreakdown['byRate'] = {};
  for (const b of breakdowns) {
    const existing = byRate[b.rateKind] ?? { grossPence: 0n, vatPence: 0n, netPence: 0n };
    byRate[b.rateKind] = {
      grossPence: existing.grossPence + b.grossPence,
      vatPence: existing.vatPence + b.vatPence,
      netPence: existing.netPence + b.netPence,
    };
  }
  const totals = {
    grossPence: sumMoney(breakdowns.map((b) => b.grossPence)),
    vatPence: sumMoney(breakdowns.map((b) => b.vatPence)),
    netPence: sumMoney(breakdowns.map((b) => b.netPence)),
  };
  return { byRate, totals, lines: breakdowns };
}
