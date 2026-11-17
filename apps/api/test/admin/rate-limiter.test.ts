/**
 * Build-03 Objective 1 — leaky-bucket rate limiter (Arch-02 §2.4).
 *
 * Pure RateLimiter: burst then 429 with Retry-After, leak refills over
 * time, bulk-import bucket separate. RateLimitInterceptor: headers on
 * every response, 429 body error.code RATE_LIMITED, till checkout
 * exempt from hard rejection (still counted, headers still attached).
 */
import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import {
  BULK_IMPORT_BUCKET,
  PER_KEY_BUCKET,
  RateLimiter,
} from '../../src/common/rate-limiter';
import { RateLimitInterceptor } from '../../src/common/rate-limit.interceptor';
import type { Actor } from '../../src/common/actor';

describe('RateLimiter — leaky bucket', () => {
  it('allows a burst of 100, then denies with retryAfterSeconds > 0', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 100; i++) {
      const decision = limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET);
      expect(decision.allowed).toBe(true);
      expect(decision.limit).toBe(100);
      expect(decision.remaining).toBe(99 - i);
    }
    const denied = limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // 101 requests in the bucket at 10/s: ~0.1s to drain one slot, so
    // the retry-after is 1s (ceil, minimum 1).
    expect(denied.retryAfterSeconds).toBe(1);
    expect(denied.resetUnixSeconds).toBeGreaterThan(0);
  });

  it('leaks over time: after 1s at 10/s, 10 more requests are allowed', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 100; i++) {
      limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET);
    }
    expect(limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET).allowed).toBe(false);
    now += 1000; // 1 second passes: 10 requests leak out.
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET).allowed).toBe(true);
    }
    expect(limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET).allowed).toBe(false);
    now += 10_000; // 10 more seconds: the bucket drains fully.
    expect(limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET).allowed).toBe(true);
  });

  it('the bulk-import bucket (10/1) is separate from the per-key bucket', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 10; i++) {
      expect(limiter.consume('bulk:t1', BULK_IMPORT_BUCKET).allowed).toBe(true);
    }
    const denied = limiter.consume('bulk:t1', BULK_IMPORT_BUCKET);
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(10);
    expect(denied.retryAfterSeconds).toBe(1);
    // The per-key bucket for the same tenant is untouched.
    expect(limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET).allowed).toBe(true);
  });

  it('buckets are keyed independently per tenant/key', () => {
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 100; i++) {
      limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET);
    }
    expect(limiter.consume('tenant:t1:key:k1', PER_KEY_BUCKET).allowed).toBe(false);
    expect(limiter.consume('tenant:t2:key:k1', PER_KEY_BUCKET).allowed).toBe(true);
    expect(limiter.consume('tenant:t1:key:k2', PER_KEY_BUCKET).allowed).toBe(true);
  });
});

describe('RateLimitInterceptor', () => {
  interface MockRes {
    headers: Record<string, string | number>;
    setHeader(name: string, value: string | number): void;
  }

  function mockRes(): MockRes {
    const headers: Record<string, string | number> = {};
    return {
      headers,
      setHeader(name: string, value: string | number): void {
        headers[name] = value;
      },
    };
  }

  function contextFor(
    req: {
      method?: string;
      path?: string;
      headers?: Record<string, string | undefined>;
      actor?: Actor;
    },
    res: MockRes,
  ): Parameters<RateLimitInterceptor['intercept']>[0] {
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => ((): void => undefined),
      getClass: () => class {},
    } as unknown as Parameters<RateLimitInterceptor['intercept']>[0];
  }

  const handler = { handle: () => of({ ok: true }) };

  it('attaches X-RateLimit-* headers on every allowed response', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const interceptor = new RateLimitInterceptor(limiter);
    const res = mockRes();
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          { method: 'GET', path: '/v1/catalogue/variants', headers: { 'x-tenant-id': 't-1' } },
          res,
        ),
        handler,
      ),
    );
    expect(result).toEqual({ ok: true });
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(99);
    expect(typeof res.headers['X-RateLimit-Reset']).toBe('number');
    expect((res.headers['X-RateLimit-Reset'] as number) * 1000).toBeGreaterThan(Date.now());
    expect(res.headers['Retry-After']).toBeUndefined();
  });

  it('returns 429 with Retry-After and error.code RATE_LIMITED when exhausted', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const interceptor = new RateLimitInterceptor(limiter);
    const actor: Actor = {
      tenantId: 'tenant-429',
      userId: 'user-1',
      locationId: 'loc-1',
      roles: ['manager'],
      authKind: 'api-key',
      apiKeyId: 'key-429',
    };
    // Exhaust the bucket first (same bucket key the interceptor derives).
    for (let i = 0; i < 100; i++) {
      limiter.consume('tenant:tenant-429:key:key:key-429', PER_KEY_BUCKET);
    }
    const res = mockRes();
    let thrown: unknown;
    try {
      await lastValueFrom(
        interceptor.intercept(
          contextFor({ method: 'GET', path: '/v1/catalogue/variants', headers: {}, actor }, res),
          handler,
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(429);
    const body = exception.getResponse() as {
      error: { code: string; message: string; retry_after_seconds: number; request_id: string };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(typeof body.error.request_id).toBe('string');
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
    expect(res.headers['Retry-After']).toBe(body.error.retry_after_seconds);
  });

  it('bulk-import requests use the 10/1 bucket (limit header 10)', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const interceptor = new RateLimitInterceptor(limiter);
    const res = mockRes();
    await lastValueFrom(
      interceptor.intercept(
        contextFor(
          { method: 'POST', path: '/v1/imports', headers: { 'x-tenant-id': 't-bulk' } },
          res,
        ),
        handler,
      ),
    );
    expect(res.headers['X-RateLimit-Limit']).toBe(10);
    expect(res.headers['X-RateLimit-Remaining']).toBe(9);
  });

  it('till checkout is exempt from hard 429 (still counted, headers attached)', async () => {
    const limiter = new RateLimiter(() => Date.now());
    const interceptor = new RateLimitInterceptor(limiter);
    const tillActor: Actor = {
      tenantId: 'tenant-till',
      userId: 'user-till',
      locationId: 'loc-1',
      roles: ['cashier'],
      authKind: 'session',
      isTillSession: true,
    };
    // Exhaust the till's bucket completely first.
    for (let i = 0; i < 100; i++) {
      limiter.consume('tenant:tenant-till:key:anonymous', PER_KEY_BUCKET);
    }
    const res = mockRes();
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(
          { method: 'POST', path: '/v1/sales/orders/abc/tenders', headers: {}, actor: tillActor },
          res,
        ),
        handler,
      ),
    );
    expect(result).toEqual({ ok: true });
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(0);
    expect(res.headers['Retry-After']).toBeUndefined();

    // The same exhausted bucket DOES 429 a non-till checkout call.
    // (intercept throws synchronously, so catch it directly — .rejects
    // would never see a synchronously-thrown error.)
    const backOffice: Actor = { ...tillActor, isTillSession: false };
    const res2 = mockRes();
    let thrown: unknown;
    try {
      await lastValueFrom(
        interceptor.intercept(
          contextFor(
            { method: 'POST', path: '/v1/sales/orders/abc/tenders', headers: {}, actor: backOffice },
            res2,
          ),
          handler,
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect(res2.headers['Retry-After']).toBeGreaterThan(0);
  });
});
