/**
 * Integer-pence arithmetic (D-13 Option A).
 *
 * All money is bigint pence. These helpers are the ONLY way money is added,
 * subtracted or multiplied in the pilot — no float arithmetic anywhere.
 */
import type { Money } from './types';

/** Add two pence amounts. */
export function addMoney(a: Money, b: Money): Money {
  return a + b;
}

/** Subtract `b` from `a` (pence). */
export function subtractMoney(a: Money, b: Money): Money {
  return a - b;
}

/**
 * Multiply a pence amount by an integer quantity (e.g. unit price × quantity
 * sold). The quantity must be a non-negative integer; a negative quantity
 * (a return) is expressed by negating the resulting amount, not the factor.
 */
export function multiplyMoneyByQuantity(amount: Money, quantity: bigint): Money {
  if (quantity < 0n) {
    throw new Error('multiplyMoneyByQuantity: quantity must be a non-negative integer');
  }
  return amount * quantity;
}

/** Sum a list of pence amounts (empty list sums to 0). */
export function sumMoney(amounts: readonly Money[]): Money {
  let total: Money = 0n;
  for (const amount of amounts) {
    total += amount;
  }
  return total;
}

/** True when the amount is exactly zero. */
export function isZeroMoney(amount: Money): boolean {
  return amount === 0n;
}

/** True when the amount is negative (a refund/credit line, never a price). */
export function isNegativeMoney(amount: Money): boolean {
  return amount < 0n;
}

/**
 * Round-half-up integer division for non-negative values:
 * round_half_up(n / d) = floor((2n + d) / 2d).
 * Both operands must be non-negative; a negative numerator is a caller error
 * (money that must round is always a non-negative amount here).
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) {
    throw new Error('divRoundHalfUp: numerator must be non-negative');
  }
  if (denominator <= 0n) {
    throw new Error('divRoundHalfUp: denominator must be positive');
  }
  return (2n * numerator + denominator) / (2n * denominator);
}

/**
 * Format pence as a GBP display string, e.g. 1234n -> "£12.34".
 * Display only — never parse this back into money.
 */
export function formatPounds(amount: Money): string {
  const sign = amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  const pounds = abs / 100n;
  const pence = abs % 100n;
  return `${sign}£${pounds.toString()}.${pence.toString().padStart(2, '0')}`;
}
