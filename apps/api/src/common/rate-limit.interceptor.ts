/**
 * Rate-limit interceptor (Build-03 Objective 1; Arch-02 §2.4).
 *
 * Wired globally in main.ts: every response carries X-RateLimit-Limit /
 * X-RateLimit-Remaining / X-RateLimit-Reset. When the per-tenant/per-key
 * bucket (or the platform bucket) is exhausted the request is rejected
 * with 429 + Retry-After (seconds) and body error.code "RATE_LIMITED"
 * (Arch-02 §2.4 body contract, plus error.request_id).
 *
 * Buckets: per-key (100/10, or the 10/1 bulk-import bucket for
 * POST /v1/imports) AND the platform bucket (500/50 per integration
 * key across tenants). Both must allow; the headers report the per-key
 * bucket, which is the limit the caller designs to.
 *
 * TILL TREATMENT (DESIGN DECISION, recorded here and in the Build-03
 * handover): checkout endpoints (POST /v1/orders, /v1/sales/orders*,
 * tender and payment-attempt endpoints) called with a till session
 * actor are EXEMPT from hard rejection — the request is still counted
 * against the bucket and the headers are still attached, but it is
 * never answered 429. Arch-02 §2.4: "The till must never lose a sale
 * because of a 429" — a rate limit is a delay, not a data loss, and a
 * till mid-sale has no safe place to queue a 429.
 */
import { HttpException, HttpStatus, Injectable, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Observable } from 'rxjs';
import {
  BULK_IMPORT_BUCKET,
  PER_KEY_BUCKET,
  PLATFORM_BUCKET,
  RateLimiter,
  type BucketConfig,
} from './rate-limiter';
import type { Actor } from './actor';

export const RATE_LIMIT_HEADERS = {
  limit: 'X-RateLimit-Limit',
  remaining: 'X-RateLimit-Remaining',
  reset: 'X-RateLimit-Reset',
  retryAfter: 'Retry-After',
} as const;

/** Checkout paths: POST /v1/orders, POST /v1/sales/orders*, tenders, payment attempts. */
export function isCheckoutPath(method: string, path: string): boolean {
  if (method !== 'POST') {
    return false;
  }
  return (
    /^\/v1\/orders(\/|$)/.test(path) ||
    /^\/v1\/sales\/orders(\/|$)/.test(path) ||
    /\/tenders(\/|$)/.test(path) ||
    /\/payment-attempts(\/|$)/.test(path)
  );
}

export function isBulkImportPath(method: string, path: string): boolean {
  return method === 'POST' && /^\/v1\/imports(\/|$)/.test(path);
}

interface RequestLike {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  actor?: Actor;
}

interface ResponseLike {
  setHeader(name: string, value: string | number): void;
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly limiter: RateLimiter = new RateLimiter()) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<RequestLike>();
    const res = ctx.getResponse<ResponseLike>();
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.path ?? (req.url ?? '/').split('?')[0] ?? '/';
    const actor = req.actor;
    const headers = req.headers ?? {};

    const authHeader = firstHeader(headers, 'authorization') ?? firstHeader(headers, 'x-api-key') ?? '';
    const keyFingerprint = authHeader.startsWith('ukp_')
      ? authHeader.slice(0, 12)
      : actor?.apiKeyId !== undefined
        ? `key:${actor.apiKeyId}`
        : 'anonymous';
    const tenantId = actor?.tenantId ?? firstHeader(headers, 'x-tenant-id') ?? 'anonymous';

    const bulk = isBulkImportPath(method, path);
    const perKeyConfig: BucketConfig = bulk ? BULK_IMPORT_BUCKET : PER_KEY_BUCKET;
    const perKey = this.limiter.consume(`tenant:${tenantId}:key:${keyFingerprint}`, perKeyConfig);
    const platform = this.limiter.consume(`platform:${keyFingerprint}`, PLATFORM_BUCKET);

    const allowed = perKey.allowed && platform.allowed;
    const decision = perKey; // Headers report the per-key bucket.
    res.setHeader(RATE_LIMIT_HEADERS.limit, decision.limit);
    res.setHeader(RATE_LIMIT_HEADERS.remaining, decision.remaining);
    res.setHeader(RATE_LIMIT_HEADERS.reset, decision.resetUnixSeconds);

    const tillExempt = actor?.isTillSession === true && isCheckoutPath(method, path);
    if (!allowed && !tillExempt) {
      const retryAfter = Math.max(perKey.retryAfterSeconds, platform.retryAfterSeconds);
      res.setHeader(RATE_LIMIT_HEADERS.retryAfter, retryAfter);
      const requestId = randomUUID();
      throw new HttpException(
        {
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
            retry_after_seconds: retryAfter,
            request_id: requestId,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
