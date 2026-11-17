/**
 * Age Verification Gate tests (Build-04, Objective 1).
 * The gate never stores a customer date of birth — asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { AgeVerificationGate } from '../src/sell/age-gate';

const restricted = { variantId: 'v-age', sku: 'WINE-001', requiresChallenge25: true };
const unrestricted = { variantId: 'v-ok', sku: 'BREAD-001', requiresChallenge25: false };

describe('AgeVerificationGate', () => {
  it('is satisfied when no line requires Challenge 25', () => {
    const gate = new AgeVerificationGate();
    expect(gate.isSatisfied([unrestricted])).toBe(true);
    expect(gate.requiredLines([unrestricted])).toEqual([]);
  });

  it('blocks checkout until Challenge 25 is confirmed, then records the threshold', () => {
    const gate = new AgeVerificationGate();
    expect(gate.isSatisfied([restricted, unrestricted])).toBe(false);
    expect(gate.requiredLines([restricted, unrestricted])).toEqual([restricted]);
    const { verifiedAgeThreshold } = gate.confirm(25);
    expect(verifiedAgeThreshold).toBe(25);
    expect(gate.verifiedAgeThreshold).toBe(25);
    expect(gate.isSatisfied([restricted])).toBe(true);
  });

  it('rejects a threshold below 25', () => {
    const gate = new AgeVerificationGate();
    expect(() => gate.confirm(18)).toThrow('at least 25');
  });

  it('logs a refusal without storing any date of birth', () => {
    const gate = new AgeVerificationGate();
    const refusal = gate.refuse(restricted, 'Customer could not show ID');
    expect(refusal.variantId).toBe('v-age');
    expect(refusal.reason).toContain('could not show ID');
    expect(gate.listRefusals()).toHaveLength(1);
    // No DOB anywhere in the gate's state, serialised or otherwise.
    const serialised = JSON.stringify({ gate: gate.listRefusals(), threshold: gate.verifiedAgeThreshold });
    expect(serialised.toLowerCase()).not.toContain('dob');
    expect(serialised).not.toContain('dateOfBirth');
    expect(serialised).not.toContain('date_of_birth');
  });

  it('stamps the confirmation time on confirm and clears it on reset (Build-09 Obj 2)', () => {
    const gate = new AgeVerificationGate();
    expect(gate.verifiedAtIso).toBeNull();
    const before = Date.now();
    gate.confirm(25);
    const after = Date.now();
    const stamped = gate.verifiedAtIso;
    expect(stamped).not.toBeNull();
    const parsed = Date.parse(stamped as string);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
    gate.reset();
    expect(gate.verifiedAgeThreshold).toBeNull();
    expect(gate.verifiedAtIso).toBeNull();
  });
});
