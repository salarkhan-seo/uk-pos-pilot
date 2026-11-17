import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createHashChain,
  GENESIS_PREV_HASH,
  hashChainLink,
  sha256Hex,
  verifyHashChain,
} from '../src/hash-chain';

interface AuditPayload {
  seq: number;
  tenantId: string;
  actor: string;
  action: string;
  amountPence: number;
}

const payloads: AuditPayload[] = [
  { seq: 1, tenantId: 'tenant-a', actor: 'cashier-1', action: 'order.completed', amountPence: 1250 },
  { seq: 2, tenantId: 'tenant-a', actor: 'cashier-1', action: 'payment.approved', amountPence: 1250 },
  { seq: 3, tenantId: 'tenant-a', actor: 'manager-1', action: 'discount.approved', amountPence: 200 },
  { seq: 4, tenantId: 'tenant-a', actor: 'cashier-1', action: 'z_report.issued', amountPence: 0 },
];

describe('SHA-256 audit hash chain', () => {
  it('canonical JSON is stable regardless of key insertion order', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson({ a: { z: 1, y: 2 }, b: [3, 2, 1] })).toBe('{"a":{"y":2,"z":1},"b":[3,2,1]}');
  });

  it('sha256Hex matches the known digest of a fixed string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('builds a chain whose first link starts at GENESIS and each link chains to the previous', () => {
    const chain = createHashChain(payloads);
    expect(chain).toHaveLength(4);
    expect(chain[0]?.prevHash).toBe(GENESIS_PREV_HASH);
    expect(chain[1]?.prevHash).toBe(chain[0]?.eventHash);
    expect(chain[2]?.prevHash).toBe(chain[1]?.eventHash);
    expect(chain[3]?.prevHash).toBe(chain[2]?.eventHash);
    for (const link of chain) {
      expect(link.eventHash).toBe(hashChainLink(link.prevHash, link.payload));
      expect(link.eventHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('verifies an untampered chain of 4 events', () => {
    const chain = createHashChain(payloads);
    expect(verifyHashChain(chain)).toEqual({ ok: true });
  });

  it('an empty chain verifies as ok', () => {
    expect(verifyHashChain([])).toEqual({ ok: true });
  });

  it('detects a tampered payload and names the first broken link', () => {
    const chain = createHashChain(payloads);
    // Tamper with the second event's payload (e.g. change the amount).
    if (chain[1] !== undefined) {
      chain[1].payload = { ...chain[1].payload, amountPence: 99999 };
    }
    const result = verifyHashChain(chain);
    expect(result.ok).toBe(false);
    expect(result.brokenIndex).toBe(1);
    expect(result.reason).toMatch(/link 1/);
    expect(result.reason).toMatch(/tampered/);
  });

  it('detects a tampered stored hash and names the broken link', () => {
    const chain = createHashChain(payloads);
    if (chain[2] !== undefined) {
      chain[2].eventHash = '0'.repeat(64);
    }
    const result = verifyHashChain(chain);
    expect(result.ok).toBe(false);
    expect(result.brokenIndex).toBe(2);
  });

  it('detects a reordered chain at the first link whose prev_hash no longer matches', () => {
    const chain = createHashChain(payloads);
    const reordered = [chain[0]!, chain[2]!, chain[1]!, chain[3]!];
    const result = verifyHashChain(reordered);
    expect(result.ok).toBe(false);
    expect(result.brokenIndex).toBe(1);
  });

  it('detects a deleted event: the link after the gap no longer chains', () => {
    const chain = createHashChain(payloads);
    const shortened = [chain[0]!, chain[2]!, chain[3]!];
    const result = verifyHashChain(shortened);
    expect(result.ok).toBe(false);
    expect(result.brokenIndex).toBe(1);
  });
});
