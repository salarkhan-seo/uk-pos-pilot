import { describe, expect, it } from 'vitest';
import { applyBasketDiscount, allocateBasketDiscount } from '../src/discounts';
import { mixedBasketBreakdown, taxBreakdownForLine, taxBreakdownForReturn } from '../src/tax';

describe('D-13 per-line round-half-up VAT on tax-inclusive prices', () => {
  it('£10.00 at 20% standard: VAT £1.67, net £8.33', () => {
    const b = taxBreakdownForLine(1000n, 'standard');
    expect(b.vatPence).toBe(167n); // 1000 * 20/120 = 166.67 -> 167
    expect(b.netPence).toBe(833n);
    expect(b.grossPence).toBe(1000n);
  });

  it('£5.00 at 5% reduced: VAT £0.24, net £4.76', () => {
    const b = taxBreakdownForLine(500n, 'reduced');
    expect(b.vatPence).toBe(24n); // 500 * 5/105 = 23.81 -> 24
    expect(b.netPence).toBe(476n);
  });

  it('£1.00 at 20%: VAT 17p, net 83p', () => {
    const b = taxBreakdownForLine(100n, 'standard');
    expect(b.vatPence).toBe(17n);
    expect(b.netPence).toBe(83n);
  });

  it('rounds exactly at the half, half-up (63p at 20% -> 10.5p -> 11p)', () => {
    const b = taxBreakdownForLine(63n, 'standard');
    expect(b.vatPence).toBe(11n);
    expect(b.netPence).toBe(52n);
  });

  it('zero-rated and exempt lines carry no VAT but stay distinct', () => {
    expect(taxBreakdownForLine(200n, 'zero').vatPence).toBe(0n);
    expect(taxBreakdownForLine(300n, 'exempt').vatPence).toBe(0n);
    expect(taxBreakdownForLine(200n, 'zero').rateKind).toBe('zero');
    expect(taxBreakdownForLine(300n, 'exempt').rateKind).toBe('exempt');
  });

  it('a return reverses the original sale VAT exactly', () => {
    const sale = taxBreakdownForLine(1000n, 'standard');
    const ret = taxBreakdownForReturn(1000n, 'standard');
    expect(ret.grossPence).toBe(-sale.grossPence);
    expect(ret.vatPence).toBe(-sale.vatPence);
    expect(ret.netPence).toBe(-sale.netPence);
  });

  it('rejects a negative total (returns use taxBreakdownForReturn)', () => {
    expect(() => taxBreakdownForLine(-100n, 'standard')).toThrow(/non-negative/);
  });
});

describe('mixed-basket VAT breakdown with pro-rata basket discounts (D-13 + D-14)', () => {
  it('breaks a mixed basket down by rate: 20% / 5% / 0% / exempt', () => {
    const basket = mixedBasketBreakdown([
      { totalPence: 1000n, rateKind: 'standard' },
      { totalPence: 500n, rateKind: 'reduced' },
      { totalPence: 200n, rateKind: 'zero' },
      { totalPence: 300n, rateKind: 'exempt' },
    ]);
    expect(basket.byRate.standard).toEqual({ grossPence: 1000n, vatPence: 167n, netPence: 833n });
    expect(basket.byRate.reduced).toEqual({ grossPence: 500n, vatPence: 24n, netPence: 476n });
    expect(basket.byRate.zero).toEqual({ grossPence: 200n, vatPence: 0n, netPence: 200n });
    expect(basket.byRate.exempt).toEqual({ grossPence: 300n, vatPence: 0n, netPence: 300n });
    expect(basket.totals).toEqual({ grossPence: 2000n, vatPence: 191n, netPence: 1809n });
    // Totals are the sum of per-line figures (round per line, then sum).
    expect(basket.totals.vatPence).toBe(
      basket.lines.reduce((sum, l) => sum + l.vatPence, 0n),
    );
  });

  it('applies a pro-rata basket discount first, then breaks down VAT per line', () => {
    const lines = [
      { totalPence: 1200n, rateKind: 'standard' as const },
      { totalPence: 600n, rateKind: 'reduced' as const },
      { totalPence: 300n, rateKind: 'zero' as const },
    ];
    // £2.10 discount across £21.00: exact shares 120 / 60 / 30.
    const discounted = applyBasketDiscount(
      210n,
      lines.map((line) => ({ lineTotalPence: line.totalPence })),
    );
    expect(discounted).toEqual([1080n, 540n, 270n]);

    const basket = mixedBasketBreakdown(
      lines.map((line, i) => ({ totalPence: discounted[i] ?? 0n, rateKind: line.rateKind })),
    );
    expect(basket.byRate.standard?.vatPence).toBe(180n); // 1080 * 20/120
    expect(basket.byRate.reduced?.vatPence).toBe(26n); // 540 * 5/105 = 25.71 -> 26
    expect(basket.byRate.zero?.vatPence).toBe(0n);
    expect(basket.totals).toEqual({ grossPence: 1890n, vatPence: 206n, netPence: 1684n });
  });

  it('discounts a basket where the discount leaves a rounding remainder, VAT still sums exactly', () => {
    const lines = [
      { totalPence: 1000n, rateKind: 'standard' as const },
      { totalPence: 999n, rateKind: 'reduced' as const },
    ];
    const discounted = applyBasketDiscount(
      100n,
      lines.map((line) => ({ lineTotalPence: line.totalPence })),
    );
    // Shares: 50.03 -> 50 and 49.97 -> 50; no remainder. Discounted: 950 / 949.
    expect(discounted).toEqual([950n, 949n]);
    const basket = mixedBasketBreakdown(
      lines.map((line, i) => ({ totalPence: discounted[i] ?? 0n, rateKind: line.rateKind })),
    );
    expect(basket.totals.grossPence).toBe(1899n);
    expect(basket.totals.vatPence).toBe(
      basket.lines.reduce((sum, l) => sum + l.vatPence, 0n),
    );
  });

  it('keeps the allocation helper and the VAT helper consistent (allocate sums to the discount)', () => {
    const allocations = allocateBasketDiscount(100n, [
      { lineTotalPence: 1000n },
      { lineTotalPence: 999n },
    ]);
    expect(allocations.reduce((sum, a) => sum + a, 0n)).toBe(100n);
  });
});
