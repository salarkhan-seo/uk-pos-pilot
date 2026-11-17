/**
 * Line-pricing view-model tests (Build-04, Objective 1).
 * Price-book pricing + role-bounded manual discounts with offline PIN approval.
 */
import { describe, expect, it } from 'vitest';
import { hashPin } from '@uk-pos/shared-kernel';
import { checkManualDiscount, priceSellLine } from '../src/sell/line-pricing';

describe('priceSellLine', () => {
  it('applies base → price book → promotion → manual in order', () => {
    const line = priceSellLine({
      variantId: 'v-1',
      sku: 'SKU-1',
      name: 'Widget',
      quantity: 2n,
      basePricePence: 1000n,
      priceBookPricePence: 900n,
      promotionDiscountPence: 100n,
      manualDiscountPence: 50n,
      taxRateKind: 'standard',
      requiresChallenge25: false,
      minAge: null,
    });
    expect(line.unitPricePence).toBe(900n); // price-book price wins over base
    expect(line.finalPricePence).toBe(825n); // (1800 - 100 - 50) / 2
    expect(line.lineTotalPence).toBe(1650n);
  });

  it('falls back to the base price when no price book applies', () => {
    const line = priceSellLine({
      variantId: 'v-1',
      sku: 'SKU-1',
      name: 'Widget',
      quantity: 1n,
      basePricePence: 1000n,
      priceBookPricePence: null,
      promotionDiscountPence: 0n,
      manualDiscountPence: 0n,
      taxRateKind: 'standard',
      requiresChallenge25: false,
      minAge: null,
    });
    expect(line.unitPricePence).toBe(1000n);
    expect(line.lineTotalPence).toBe(1000n);
  });

  it('rejects discounts that exceed the line price', () => {
    expect(() =>
      priceSellLine({
        variantId: 'v-1',
        sku: 'SKU-1',
        name: 'Widget',
        quantity: 1n,
        basePricePence: 1000n,
        priceBookPricePence: null,
        promotionDiscountPence: 0n,
        manualDiscountPence: 1001n,
        taxRateKind: 'standard',
        requiresChallenge25: false,
        minAge: null,
      }),
    ).toThrow('must not be negative');
  });
});

describe('checkManualDiscount', () => {
  it('allows a cashier no manual discount (0% limit)', () => {
    const result = checkManualDiscount({
      roles: ['cashier'],
      lineTotalBeforeManualPence: 1000n,
      manualDiscountPence: 1n,
    });
    expect(result.allowed).toBe(false);
    expect(result.needsApproval).toBe(true);
    expect(result.reason).toContain('0% role limit');
  });

  it('allows a manager discount within 10% without approval', () => {
    const result = checkManualDiscount({
      roles: ['manager'],
      lineTotalBeforeManualPence: 1000n,
      manualDiscountPence: 100n,
    });
    expect(result).toMatchObject({ allowed: true, needsApproval: false, approvalRef: null });
  });

  it('allows an owner any discount (unlimited)', () => {
    const result = checkManualDiscount({
      roles: ['owner'],
      lineTotalBeforeManualPence: 1000n,
      manualDiscountPence: 999n,
    });
    expect(result.allowed).toBe(true);
  });

  it('allows an above-limit discount with a valid manager PIN, and never records the PIN', () => {
    const pinHash = hashPin('1234');
    const result = checkManualDiscount({
      roles: ['cashier'],
      lineTotalBeforeManualPence: 1000n,
      manualDiscountPence: 200n,
      approverPin: '1234',
      approverPinHash: pinHash,
      approverRoles: ['manager'],
    });
    expect(result.allowed).toBe(true);
    expect(result.needsApproval).toBe(true);
    expect(result.approvalRef).toContain('offline-pin:manager');
    expect(JSON.stringify(result)).not.toContain('1234');
  });

  it('rejects an above-limit discount with a wrong PIN or a non-manager approver', () => {
    const pinHash = hashPin('1234');
    const wrongPin = checkManualDiscount({
      roles: ['cashier'],
      lineTotalBeforeManualPence: 1000n,
      manualDiscountPence: 200n,
      approverPin: '9999',
      approverPinHash: pinHash,
      approverRoles: ['manager'],
    });
    expect(wrongPin.allowed).toBe(false);

    const cashierApprover = checkManualDiscount({
      roles: ['cashier'],
      lineTotalBeforeManualPence: 1000n,
      manualDiscountPence: 200n,
      approverPin: '1234',
      approverPinHash: pinHash,
      approverRoles: ['cashier'],
    });
    expect(cashierApprover.allowed).toBe(false);
  });
});
