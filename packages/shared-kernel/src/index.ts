/**
 * @uk-pos/shared-kernel — public API.
 *
 * Pure, dependency-free domain logic for the UK POS pilot:
 * integer-pence money (D-13), per-line VAT (D-13), pro-rata basket discounts
 * (D-14), Europe/London business dates, and the SHA-256 audit hash chain.
 * No I/O, no database, no framework — safe to import anywhere, including
 * the register app.
 */
export * from './types';
export * from './money';
export * from './tax';
export * from './discounts';
export * from './business-date';
export * from './hash-chain';
export * from './pin';
