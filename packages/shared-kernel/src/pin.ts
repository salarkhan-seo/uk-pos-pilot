/**
 * Till PIN hashing for manager approvals (Build-02, Objective 2).
 *
 * A till PIN is a short numeric second factor for manager approvals at the
 * till — never the sole admin credential. Stored as a salted scrypt hash:
 * `scrypt$v1$<salt hex>$<hash hex>`.
 *
 * DESIGN DECISION (not a research fact): this is a pilot-grade scheme.
 * Production must use a stronger scheme (e.g. Argon2id with a server-side
 * pepper, rate-limited attempts, and hardware-backed storage). PINs are
 * 4–6 digits; brute-force resistance here comes from the per-PIN salt and
 * from the application rate-limiting failed attempts, not from the hash
 * alone. This module is the ONE implementation — the seed helper and the
 * ApprovalService both use it, so the format cannot drift.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PIN_FORMAT = 'scrypt$v1$';

/** Hash a PIN with a fresh random 16-byte salt (scrypt, N=16384, r=8, p=1). */
export function hashPin(pin: string): string {
  if (!/^\d{4,6}$/.test(pin)) {
    throw new Error('hashPin: PIN must be 4–6 digits');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `${PIN_FORMAT}${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verify a PIN against a stored hash. False for a malformed stored hash. */
export function verifyPin(pin: string, storedHash: string): boolean {
  try {
    if (!storedHash.startsWith(PIN_FORMAT)) {
      return false;
    }
    const parts = storedHash.split('$');
    const saltHex = parts[2];
    const hashHex = parts[3];
    if (saltHex === undefined || hashHex === undefined) {
      return false;
    }
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
