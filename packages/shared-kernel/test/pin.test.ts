import { describe, expect, it } from 'vitest';
import { hashPin, verifyPin } from '../src/pin';

describe('hashPin / verifyPin', () => {
  it('verifies the correct PIN and rejects a wrong one', () => {
    const stored = hashPin('1234');
    expect(verifyPin('1234', stored)).toBe(true);
    expect(verifyPin('4321', stored)).toBe(false);
    expect(verifyPin('12345', stored)).toBe(false);
  });

  it('salts every hash, so the same PIN hashes differently twice', () => {
    expect(hashPin('1234')).not.toBe(hashPin('1234'));
  });

  it('rejects PINs that are not 4–6 digits', () => {
    expect(() => hashPin('123')).toThrow();
    expect(() => hashPin('1234567')).toThrow();
    expect(() => hashPin('abcd')).toThrow();
  });

  it('returns false for a malformed stored hash instead of throwing', () => {
    expect(verifyPin('1234', 'not-a-hash')).toBe(false);
    expect(verifyPin('1234', '')).toBe(false);
  });
});
