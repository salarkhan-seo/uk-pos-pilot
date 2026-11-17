/**
 * Leaky-bucket rate limiter (Build-03 Objective 1; Arch-02 §2.4).
 *
 * Pure class — no I/O, no framework, no clock dependency beyond an
 * injectable nowMs (tests drive time explicitly). A leaky bucket smooths
 * bursts instead of allowing a 2x burst at a fixed-window boundary,
 * which is exactly the failure a till produces when it retries a burst
 * of queued sales after an outage.
 *
 * Published numbers (Arch-02 §2.4 — design decisions, not research
 * facts; deliberately NOT plan-scaled, contrast Shopify):
 *   per-tenant/per-key  100 burst, 10 req/s leak
 *   platform (per key)  500 burst, 50 req/s leak
 *   bulk import         10 burst, 1 req/s leak
 *
 * State: one level per bucket key. The level drains continuously at the
 * leak rate; a request is allowed when level + 1 <= capacity. Reset is
 * the Unix timestamp (seconds) when the bucket drains to empty.
 */
export interface BucketConfig {
  capacity: number;
  leakPerSecond: number;
}

export const PER_KEY_BUCKET: BucketConfig = { capacity: 100, leakPerSecond: 10 };
export const PLATFORM_BUCKET: BucketConfig = { capacity: 500, leakPerSecond: 50 };
export const BULK_IMPORT_BUCKET: BucketConfig = { capacity: 10, leakPerSecond: 1 };

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket capacity (X-RateLimit-Limit). */
  limit: number;
  /** Requests left in the bucket (X-RateLimit-Remaining). */
  remaining: number;
  /** Unix timestamp (seconds) when the bucket refills to capacity (X-RateLimit-Reset). */
  resetUnixSeconds: number;
  /** Seconds to wait before retrying when denied (Retry-After); 0 when allowed. */
  retryAfterSeconds: number;
}

interface BucketState {
  level: number;
  updatedAtMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  consume(key: string, config: BucketConfig, nowOverrideMs?: number): RateLimitDecision {
    if (config.capacity <= 0 || config.leakPerSecond <= 0) {
      throw new Error('RateLimiter: capacity and leakPerSecond must be positive');
    }
    const now = nowOverrideMs ?? this.nowMs();
    const state = this.buckets.get(key) ?? { level: 0, updatedAtMs: now };
    const elapsedSeconds = Math.max(0, (now - state.updatedAtMs) / 1000);
    const drained = Math.max(0, state.level - elapsedSeconds * config.leakPerSecond);
    const resetUnixSeconds = Math.ceil((now + (drained / config.leakPerSecond) * 1000) / 1000);

    if (drained + 1 <= config.capacity) {
      const level = drained + 1;
      this.buckets.set(key, { level, updatedAtMs: now });
      return {
        allowed: true,
        limit: config.capacity,
        remaining: Math.max(0, Math.floor(config.capacity - level)),
        resetUnixSeconds: Math.ceil((now + (level / config.leakPerSecond) * 1000) / 1000),
        retryAfterSeconds: 0,
      };
    }

    this.buckets.set(key, { level: drained, updatedAtMs: now });
    return {
      allowed: false,
      limit: config.capacity,
      remaining: 0,
      resetUnixSeconds,
      retryAfterSeconds: Math.max(1, Math.ceil((drained + 1 - config.capacity) / config.leakPerSecond)),
    };
  }

  /** Peek without consuming (used by tests only). */
  level(key: string): number {
    return this.buckets.get(key)?.level ?? 0;
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}
