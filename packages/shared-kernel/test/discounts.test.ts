import { describe, expect, it } from 'vitest';
import { allocateBasketDiscount, applyBasketDiscount } from '../src/discounts';

describe('D-14 pro-rata basket discount allocation', () => {
  it('allocates exactly, no remainder, when shares are whole pence', () => {
    const allocations = allocateBasketDiscount(210n, [
      { lineTotalPence: 1200n },
      { lineTotalPence: 600n },
      { lineTotalPence: 300n },
    ]);
    expect(allocations).toEqual([120n, 60n, 30n]);
  });

  it('assigns a positive rounding remainder to the largest line', () => {
    // Shares: 7*333/1000 = 2.331 -> 2, 2.331 -> 2, 7*334/1000 = 2.338 -> 2.
    // Rounded sum is 6, remainder +1 goes to the largest line (334p, index 2).
    const allocations = allocateBasketDiscount(7n, [
      { lineTotalPence: 333n },
      { lineTotalPence: 333n },
      { lineTotalPence: 334n },
    ]);
    expect(allocations).toEqual([2n, 2n, 3n]);
    expect(allocations.reduce((s, a) => s + a, 0n)).toBe(7n);
  });

  it('assigns a negative rounding remainder to the largest line', () => {
    // Shares: 5*33/100 = 1.65 -> 2, 1.65 -> 2, 5*34/100 = 1.70 -> 2.
    // Rounded sum is 6, remainder -1 comes off the largest line (34p, index 2).
    const allocations = allocateBasketDiscount(5n, [
      { lineTotalPence: 33n },
      { lineTotalPence: 33n },
      { lineTotalPence: 34n },
    ]);
    expect(allocations).toEqual([2n, 2n, 1n]);
    expect(allocations.reduce((s, a) => s + a, 0n)).toBe(5n);
  });

  it('ties on the largest line go to the first largest line', () => {
    // Three equal lines: each share 10*100/300 = 3.33 -> 3; remainder +1.
    const allocations = allocateBasketDiscount(10n, [
      { lineTotalPence: 100n },
      { lineTotalPence: 100n },
      { lineTotalPence: 100n },
    ]);
    expect(allocations).toEqual([4n, 3n, 3n]);
  });

  it('zero penny drift across several baskets, including remainders', () => {
    const baskets: { discount: bigint; totals: bigint[] }[] = [
      { discount: 100n, totals: [1000n, 999n] },
      { discount: 7n, totals: [333n, 333n, 334n] },
      { discount: 5n, totals: [33n, 33n, 34n] },
      { discount: 10n, totals: [100n, 100n, 100n] },
      { discount: 1n, totals: [1n, 1n, 1n] },
      { discount: 999n, totals: [1234n, 567n, 89n, 4321n] },
      { discount: 250n, totals: [199n, 2999n, 50n] },
      { discount: 3n, totals: [7n, 11n, 13n, 17n, 19n] },
      { discount: 500n, totals: [10000n] },
      { discount: 123n, totals: [45n, 67n, 89n, 101n, 202n, 303n] },
    ];
    for (const basket of baskets) {
      const allocations = allocateBasketDiscount(
        basket.discount,
        basket.totals.map((t) => ({ lineTotalPence: t })),
      );
      expect(allocations).toHaveLength(basket.totals.length);
      expect(allocations.reduce((s, a) => s + a, 0n)).toBe(basket.discount);
      for (const a of allocations) {
        expect(a).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('a discount equal to the basket total allocates every line in full', () => {
    expect(
      allocateBasketDiscount(300n, [{ lineTotalPence: 100n }, { lineTotalPence: 200n }]),
    ).toEqual([100n, 200n]);
  });

  it('a zero discount allocates zero everywhere', () => {
    expect(
      allocateBasketDiscount(0n, [{ lineTotalPence: 100n }, { lineTotalPence: 200n }]),
    ).toEqual([0n, 0n]);
  });

  it('applyBasketDiscount returns the discounted line totals', () => {
    expect(
      applyBasketDiscount(210n, [
        { lineTotalPence: 1200n },
        { lineTotalPence: 600n },
        { lineTotalPence: 300n },
      ]),
    ).toEqual([1080n, 540n, 270n]);
  });

  it('rejects a discount larger than the basket, a negative discount, and negative lines', () => {
    expect(() =>
      allocateBasketDiscount(301n, [{ lineTotalPence: 100n }, { lineTotalPence: 200n }]),
    ).toThrow(/exceeds the basket total/);
    expect(() => allocateBasketDiscount(-1n, [{ lineTotalPence: 100n }])).toThrow(/negative/);
    expect(() =>
      allocateBasketDiscount(10n, [{ lineTotalPence: 100n }, { lineTotalPence: -5n }]),
    ).toThrow(/negative/);
  });
});
