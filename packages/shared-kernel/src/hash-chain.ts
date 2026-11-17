/**
 * SHA-256 tamper-evident hash chain for audit_events and export_manifests
 * (Arch-01 §2.7).
 *
 * Chain rule: event_hash = sha256(prev_hash + canonical JSON of the event).
 * The genesis event's prev_hash is the literal string 'GENESIS'. Canonical
 * JSON is a stable stringification (object keys sorted recursively), so the
 * same event always hashes the same way regardless of key insertion order.
 *
 * Verification walks the chain in order and reports the FIRST broken link:
 * either a stored hash that does not match the recomputed hash for that
 * event, or a prev_hash that does not equal the previous event's hash.
 * A tampered payload, a reordered event, or a deleted event all break the
 * chain at the first affected link.
 */
import { createHash } from 'node:crypto';

/** prev_hash value for the first event in a chain. */
export const GENESIS_PREV_HASH = 'GENESIS';

/**
 * Stable, deterministic JSON stringification: object keys sorted
 * recursively, arrays kept in order. `undefined` values and functions are
 * dropped (matching JSON.stringify behaviour for object properties).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? 'null' : rendered;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
    .join(',');
  return `{${body}}`;
}

/** SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hash one event onto the chain: sha256(prev_hash + canonical JSON(event)).
 * The event object itself must NOT contain prev_hash/event_hash — those are
 * the chain fields, not the payload.
 */
export function hashChainLink(prevHash: string, eventPayload: unknown): string {
  return sha256Hex(`${prevHash}${canonicalJson(eventPayload)}`);
}

export interface ChainedEvent<T = unknown> {
  /** The event payload (never includes prev_hash/event_hash). */
  payload: T;
  /** Hash of the previous event in the chain, or GENESIS_PREV_HASH. */
  prevHash: string;
  /** Hash of this event: sha256(prevHash + canonicalJson(payload)). */
  eventHash: string;
}

/**
 * Build a hash chain over an ordered list of event payloads. Returns the
 * chained events in the same order, each carrying its prevHash/eventHash.
 */
export function createHashChain<T>(payloads: readonly T[]): ChainedEvent<T>[] {
  const chained: ChainedEvent<T>[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (const payload of payloads) {
    const eventHash = hashChainLink(prevHash, payload);
    chained.push({ payload, prevHash, eventHash });
    prevHash = eventHash;
  }
  return chained;
}

export interface ChainVerification {
  ok: boolean;
  /** Index of the first broken link, when ok is false. */
  brokenIndex?: number;
  /** Human-readable reason for the first break, when ok is false. */
  reason?: string;
}

/**
 * Verify a hash chain. Walks in order and reports the first broken link:
 * - a prevHash that does not equal the previous event's eventHash (or
 *   GENESIS_PREV_HASH for the first event);
 * - an eventHash that does not match the recomputed hash for that payload.
 * An empty chain verifies as ok.
 */
export function verifyHashChain<T>(chain: readonly ChainedEvent<T>[]): ChainVerification {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < chain.length; i += 1) {
    const link = chain[i];
    if (link === undefined) {
      return { ok: false, brokenIndex: i, reason: `link ${i} is missing` };
    }
    if (link.prevHash !== expectedPrev) {
      return {
        ok: false,
        brokenIndex: i,
        reason:
          `link ${i}: prev_hash ${link.prevHash} does not match previous event hash ${expectedPrev}`,
      };
    }
    const recomputed = hashChainLink(link.prevHash, link.payload);
    if (recomputed !== link.eventHash) {
      return {
        ok: false,
        brokenIndex: i,
        reason:
          `link ${i}: event_hash ${link.eventHash} does not match recomputed hash ${recomputed} — payload was tampered with`,
      };
    }
    expectedPrev = link.eventHash;
  }
  return { ok: true };
}
