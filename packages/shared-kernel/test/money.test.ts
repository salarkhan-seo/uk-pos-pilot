import { describe, expect, it } from 'vitest';
import {
  addMoney,
  divRoundHalfUp,
  formatPounds,
  isNegativeMoney,
  isZeroMoney,
  multiplyMoneyByQuantity,
  subtractMoney,
  sumMoney,
} from '../src/money';

describe('integer-pence arithmetic (D-13)', () => {
  it('adds and subtracts pence as bigint, never float', () => {
    expect(addMoney(10n, 20n)).toBe(30n);
    expect(subtractMoney(100n, 1n)).toBe(99n);
    expect(subtractMoney(50n, 100n)).toBe(-50n);
  });

  it('multiplies unit price by integer quantity', () => {
    expect(multiplyMoneyByQuantity(199n, 3n)).toBe(597n);
    expect(multiplyMoneyByQuantity(199n, 0n)).toBe(0n);
  });

  it('rejects a negative quantity factor', () => {
    expect(() => multiplyMoneyByQuantity(199n, -1n)).toThrow(/non-negative/);
  });

  it('sums a list of amounts, empty list is zero', () => {
    expect(sumMoney([100n, 250n, 33n])).toBe(383n);
    expect(sumMoney([])).toBe(0n);
  });

  it('reports zero and negative amounts', () => {
    expect(isZeroMoney(0n)).toBe(true);
    expect(isZeroMoney(1n)).toBe(false);
    expect(isNegativeMoney(-1n)).toBe(true);
    expect(isNegativeMoney(0n)).toBe(false);
  });

  it('round-half-up divides exactly at the half', () => {
    expect(divRoundHalfUp(105n, 10n)).toBe(11n); // 10.5 -> 11, not banker's 10
    expect(divRoundHalfUp(104n, 10n)).toBe(10n); // 10.4 -> 10
    expect(divRoundHalfUp(115n, 10n)).toBe(12n); // 11.5 -> 12
    expect(divRoundHalfUp(0n, 120n)).toBe(0n);
  });

  it('formats pence as GBP display strings', () => {
    expect(formatPounds(1234n)).toBe('£12.34');
    expect(formatPounds(100n)).toBe('£1.00');
    expect(formatPounds(5n)).toBe('£0.05');
    expect(formatPounds(0n)).toBe('£0.00');
    expect(formatPounds(-50n)).toBe('-£0.50');
  });
});
