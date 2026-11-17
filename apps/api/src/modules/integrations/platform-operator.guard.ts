/**
 * PlatformOperatorGuard — platform-operator identity for POST
 * /v1/webhooks/re-encrypt-secrets (Build-10 Objective 3 inline check,
 * upgraded to a proper guard in Build-11 Objective 3).
 *
 * Why a guard, not inline logic: the operator check is an
 * authentication/authorization decision, and it must run BEFORE body
 * validation and BEFORE the handler — a CanActivate guard is the
 * Nest-native place for that. The guard runs AFTER the class-level
 * AuthGuard (controller guards run before method guards), so by the
 * time it runs, request.actor is set and the 'admin' scope has
 * already been checked: unauthenticated → 401 and wrong scope → 403
 * come from AuthGuard, unchanged.
 *
 * Keyring (Build-11 Objective 3): PLATFORM_OPERATOR_KEYS is a JSON
 * map of operator_id -> secret_key. Precedence — first match wins:
 *   1. PLATFORM_OPERATOR_KEYS env var (JSON map);
 *   2. PLATFORM_OPERATOR_KEY env var (single key, backward
 *      compatibility — the recorded operator id is 'default');
 *   3. the deterministic test fallback — ONLY when NODE_ENV ===
 *      'test' (the recorded operator id is 'test').
 * Outside tests a missing key yields no keyring (never a well-known
 * key protecting a real platform operation); the route then fails
 * CLOSED with 503 PLATFORM_OPERATOR_KEY_NOT_CONFIGURED. A malformed
 * PLATFORM_OPERATOR_KEYS (bad JSON, not an object, empty values,
 * empty object) throws at construction — a bad keyring fails boot
 * loudly, the same pattern as WebhookService.resolveSecretCipher.
 *
 * Identity rule: the caller sends X-Platform-Operator-Key and
 * (optionally) X-Platform-Operator-Id.
 *   - Id header PRESENT: it must name an entry in the keyring AND
 *     the presented key must match that entry's secret — an id can
 *     never be spoofed with another operator's key.
 *   - Id header ABSENT: the key is matched against every entry and
 *     the operator id is DERIVED from the key that matches. This
 *     keeps Build-10 callers working (they sent only the key header)
 *     while still recording an exact operator id.
 * Every candidate comparison is constant-time (length-checked
 * timingSafeEqual, one comparison per candidate key).
 *
 * Audit: the verified operator_id is recorded in audit_events for
 * every re-encrypt call the guard sees — success AND rejection.
 *   - Success: the CONTROLLER records
 *     'platform_operator.re_encrypt_succeeded' after the
 *     re-encryption completes, with the counts (a rejection audit
 *     cannot carry counts that do not exist yet, so the two halves
 *     live where the facts live).
 *   - Rejection (this guard): 'platform_operator.re_encrypt_rejected'
 *     with the PRESENTED operator id (null when none was sent), the
 *     reason, and the from_key_id when the body carried one. A
 *     rejected attempt has no VERIFIED operator id by definition —
 *     the payload says so (verified_operator_id is null; the
 *     presented id is recorded for forensics, never trusted).
 *   - Unauthenticated (401) attempts are NOT audited: AuthGuard
 *     rejects them before this guard runs, so there is no actor and
 *     no tenant to chain the event under. Wrong-scope (403) attempts
 *     are likewise not operator-audit events — the scope check is
 *     AuthGuard's, and the operator guard never ran.
 * Both audit writes are chained under the CALLING admin's tenant
 * (actor.tenantId): audit_events is a per-tenant hash chain, and the
 * re-encrypt route is platform-wide, so the caller's tenant is the
 * only tenant identity the call has. A failed audit write on the
 * REJECTION path never masks the auth decision (the 403/503 stands);
 * a failed audit write on the SUCCESS path propagates (the
 * controller's choice — a 200 with no audit trail would be a silent
 * integrity gap, and the re-encryption is idempotent, so a retry is
 * safe).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { AuditService } from '../admin/audit.service';
import type { Actor } from '../../common/actor';

/** Header carrying the platform-operator key (Build-10 Objective 3). */
export const PLATFORM_OPERATOR_KEY_HEADER = 'x-platform-operator-key';
/** Header carrying the platform-operator id (Build-11 Objective 3). Optional — see the identity rule above. */
export const PLATFORM_OPERATOR_ID_HEADER = 'x-platform-operator-id';

/**
 * Deterministic test-only platform-operator key. Well-known by design:
 * it exists so the test suite can exercise the operator guard without
 * an env var. It must NEVER be used outside tests —
 * resolvePlatformOperatorKeyring only applies it when NODE_ENV ===
 * 'test' (same pattern as WEBHOOK_SECRET_CIPHER_TEST_KEY). ASCII-only
 * on purpose: the value travels as an HTTP header, and a header cannot
 * carry non-Latin-1 characters.
 */
export const PLATFORM_OPERATOR_TEST_KEY = 'build-10-test-only-platform-operator-key';
/** Operator id recorded when the deterministic test fallback key is the one that verified. */
export const PLATFORM_OPERATOR_TEST_ID = 'test';
/** Operator id recorded when only the single PLATFORM_OPERATOR_KEY env var is configured. */
export const PLATFORM_OPERATOR_DEFAULT_ID = 'default';

export interface PlatformOperatorKeyring {
  /** operator_id -> secret_key. Never empty. */
  entries: Map<string, string>;
  /** Which configuration source produced this keyring. */
  source: 'keyring' | 'single' | 'test-fallback';
}

export interface PlatformOperatorRequest {
  actor?: Actor;
  /** Set by this guard on success: the verified operator id. */
  operatorId?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

function firstHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Resolve the platform-operator keyring (Build-11 Objective 3).
 * Precedence — first match wins: PLATFORM_OPERATOR_KEYS (JSON map),
 * then PLATFORM_OPERATOR_KEY (single key, operator id 'default'),
 * then the deterministic test fallback when NODE_ENV === 'test'.
 * Returns null when no key is configured — the route fails CLOSED
 * (503) in that case, never open. A malformed PLATFORM_OPERATOR_KEYS
 * throws: bad JSON, not a plain object, an empty object, or any entry
 * whose value is not a non-empty string.
 */
export function resolvePlatformOperatorKeyring(
  env: NodeJS.ProcessEnv = process.env,
): PlatformOperatorKeyring | null {
  const keysJson = env.PLATFORM_OPERATOR_KEYS;
  if (keysJson !== undefined && keysJson.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keysJson);
    } catch {
      throw new Error(
        'PLATFORM_OPERATOR_KEYS is not valid JSON — it must be a JSON object mapping operator_id to secret_key',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'PLATFORM_OPERATOR_KEYS must be a JSON object mapping operator_id to secret_key',
      );
    }
    const entries = new Map<string, string>();
    for (const [operatorId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(
          `PLATFORM_OPERATOR_KEYS entry ${JSON.stringify(operatorId)} must be a non-empty string secret_key`,
        );
      }
      entries.set(operatorId, value);
    }
    if (entries.size === 0) {
      throw new Error(
        'PLATFORM_OPERATOR_KEYS must contain at least one operator_id -> secret_key entry',
      );
    }
    return { entries, source: 'keyring' };
  }
  const single = env.PLATFORM_OPERATOR_KEY;
  if (single !== undefined && single.length > 0) {
    return {
      entries: new Map([[PLATFORM_OPERATOR_DEFAULT_ID, single]]),
      source: 'single',
    };
  }
  if (env.NODE_ENV === 'test') {
    return {
      entries: new Map([[PLATFORM_OPERATOR_TEST_ID, PLATFORM_OPERATOR_TEST_KEY]]),
      source: 'test-fallback',
    };
  }
  return null;
}

/** Constant-time comparison (length-checked first — timingSafeEqual throws on mismatch). */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a presented (operator id, key) pair against a keyring.
 * Id PRESENT: the id must exist and its secret must match — one
 * comparison, no probing of other operators' keys. Id ABSENT: the
 * key is compared against every entry (constant-time per candidate)
 * and the matching entry's id is returned. Returns the VERIFIED
 * operator id, or null when nothing matches.
 */
export function verifyOperatorKey(
  keyring: PlatformOperatorKeyring,
  presentedId: string | undefined,
  presentedKey: string | undefined,
): string | null {
  if (presentedKey === undefined || presentedKey.length === 0) return null;
  if (presentedId !== undefined && presentedId.length > 0) {
    const expected = keyring.entries.get(presentedId);
    if (expected === undefined) return null;
    return secretMatches(presentedKey, expected) ? presentedId : null;
  }
  for (const [operatorId, expected] of keyring.entries) {
    if (secretMatches(presentedKey, expected)) return operatorId;
  }
  return null;
}

export type OperatorRejectionReason =
  | 'missing_header'
  | 'unknown_operator_id'
  | 'key_mismatch'
  | 'key_not_configured';

@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  private readonly keyring: PlatformOperatorKeyring | null;

  constructor(
    @Optional() private readonly auditService?: AuditService,
    @Optional() @Inject(DATABASE) private readonly db?: Kysely<DB>,
  ) {
    // Throws at construction on a malformed PLATFORM_OPERATOR_KEYS —
    // a bad keyring fails boot loudly, never a silent open route.
    this.keyring = resolvePlatformOperatorKeyring();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlatformOperatorRequest>();
    const actor = req.actor;
    if (actor === undefined) {
      // Unreachable in production: the class-level AuthGuard runs
      // first and 401s without an actor. Fail closed if the guard is
      // ever wired without it.
      throw new UnauthorizedException('Authenticated actor is required');
    }
    const presentedId = firstHeader(req.headers, PLATFORM_OPERATOR_ID_HEADER);
    const presentedKey = firstHeader(req.headers, PLATFORM_OPERATOR_KEY_HEADER);

    if (this.keyring === null) {
      await this.recordRejection(actor, presentedId, 'key_not_configured', req);
      throw new ServiceUnavailableException({
        error: {
          code: 'PLATFORM_OPERATOR_KEY_NOT_CONFIGURED',
          message:
            'PLATFORM_OPERATOR_KEY is not configured — platform-operator operations are unavailable',
        },
      });
    }

    let reason: OperatorRejectionReason;
    if (presentedKey === undefined || presentedKey.length === 0) {
      reason = 'missing_header';
    } else if (
      presentedId !== undefined &&
      presentedId.length > 0 &&
      !this.keyring.entries.has(presentedId)
    ) {
      reason = 'unknown_operator_id';
    } else {
      reason = 'key_mismatch';
    }
    const verifiedId = verifyOperatorKey(this.keyring, presentedId, presentedKey);
    if (verifiedId === null) {
      await this.recordRejection(actor, presentedId, reason, req);
      throw new ForbiddenException({
        error: {
          code: 'PLATFORM_OPERATOR_REQUIRED',
          message:
            'X-Platform-Operator-Key header is required for platform-wide re-encryption',
        },
      });
    }
    req.operatorId = verifiedId;
    return true;
  }

  /**
   * Record a rejected operator attempt in audit_events, chained
   * under the calling admin's tenant. Best-effort by design: a
   * failed audit write must never mask the auth decision — the
   * 403/503 stands either way.
   */
  private async recordRejection(
    actor: Actor,
    presentedId: string | undefined,
    reason: OperatorRejectionReason,
    req: PlatformOperatorRequest,
  ): Promise<void> {
    if (this.auditService === undefined || this.db === undefined) return;
    const body = req.body;
    const fromKeyId =
      body !== null &&
      typeof body === 'object' &&
      'fromKeyId' in body &&
      typeof (body as Record<string, unknown>).fromKeyId === 'string'
        ? ((body as Record<string, unknown>).fromKeyId as string)
        : null;
    try {
      await this.auditService.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'platform_operator.re_encrypt_rejected',
        entityType: 'webhook',
        entityId: null,
        payload: {
          operator_id: presentedId ?? null,
          verified_operator_id: null,
          reason,
          from_key_id: fromKeyId,
        },
      });
    } catch {
      // Audit is best-effort on the rejection path — the 403/503 is
      // the truth, and a broken audit chain must not turn a rejected
      // call into a 500.
    }
  }
}
