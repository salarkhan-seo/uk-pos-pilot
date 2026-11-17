/**
 * D-14 — exact pro-rata basket discount allocation (D-14 Option A).
 *
 * A basket discount is allocated across lines in proportion to each line's
 * total. Each line's share is rounded half-up, and the rounding remainder —
 * positive or negative — is assigned to the LARGEST line, so the allocated
 * amounts always sum to exactly the basket discount (zero penny drift).
 *
 * The remainder is applied penny by penny to the largest line first (then
 * the next largest if a single line cannot absorb it without going below
 * zero). In the normal case the remainder is a few pennies on the largest
 * line, exactly as the spec states.
 */
import { divRoundHalfUp } from './money';
import type { Money } from './types';

export interface DiscountLine {
  /** Tax-inclusive line total in pence, before this basket discount. */
  lineTotalPence: Money;
}

/**
 * Allocate `discountPence` across `lines` pro-rata by line total.
 * Returns one allocation per line, in input order, summing exactly to
 * `discountPence`.
 *
 * Throws when the discount is negative, when it exceeds the basket total,
 * or when a line total is negative. A discount of 0 allocates 0 everywhere.
 * A discount equal to the basket total allocates every line's full total.
 */
export function allocateBasketDiscount(
  discountPence: Money,
  lines: readonly DiscountLine[],
): Money[] {
  if (discountPence < 0n) {
    throw new Error('allocateBasketDiscount: discount must not be negative');
  }
  if (lines.length === 0) {
    if (discountPence !== 0n) {
      throw new Error('allocateBasketDiscount: cannot allocate a discount across no lines');
    }
    return [];
  }
  let basketTotal: Money = 0n;
  for (const line of lines) {
    if (line.lineTotalPence < 0n) {
      throw new Error('allocateBasketDiscount: line totals must not be negative');
    }
    basketTotal += line.lineTotalPence;
  }
  if (discountPence > basketTotal) {
    throw new Error('allocateBasketDiscount: discount exceeds the basket total');
  }
  if (discountPence === 0n || basketTotal === 0n) {
    return lines.map(() => 0n);
  }

  // Exact pro-rata share per line, rounded half-up.
  const allocations: Money[] = lines.map((line) =>
    divRoundHalfUp(discountPence * line.lineTotalPence, basketTotal),
  );

  // Rounding remainder: allocated sum minus the discount. Assign it to the
  // largest line (subtract a positive remainder, add back a negative one).
  let remainder: Money = allocations.reduce((sum, a) => sum + a, 0n) - discountPence;

  // Lines ordered by size, largest first; ties keep input order (the first
  // largest line absorbs the remainder, per the spec).
  const order = lines
    .map((line, index) => ({ index, total: line.lineTotalPence }))
    .sort((a, b) => {
      if (a.total !== b.total) return a.total > b.total ? -1 : 1;
      return a.index - b.index;
    });

  let cursor = 0;
  while (remainder !== 0n) {
    const target = order[cursor % order.length];
    if (target === undefined) {
      throw new Error('allocateBasketDiscount: internal error — line index out of range');
    }
    const allocation = allocations[target.index];
    if (allocation === undefined) {
      throw new Error('allocateBasketDiscount: internal error — line index out of range');
    }
    // Move one penny of the remainder onto this line if it stays >= 0.
    const step: Money = remainder > 0n ? -1n : 1n;
    if (allocation + step >= 0n) {
      allocations[target.index] = allocation + step;
      remainder += step;
    }
    cursor += 1;
    // Safety: a remainder can never need more than one full pass per penny,
    // and its magnitude is bounded by the number of lines. If we have
    // circled the whole list without moving, no line can absorb it.
    if (cursor > order.length * 2 && remainder !== 0n) {
      throw new Error('allocateBasketDiscount: remainder could not be absorbed by any line');
    }
  }

  return allocations;
}

/**
 * Apply a basket discount to lines and return the discounted line totals.
 * Convenience wrapper: each discounted total is `lineTotal - allocation`.
 */
export function applyBasketDiscount(
  discountPence: Money,
  lines: readonly DiscountLine[],
): Money[] {
  const allocations = allocateBasketDiscount(discountPence, lines);
  return lines.map((line, i) => line.lineTotalPence - (allocations[i] ?? 0n));
}
