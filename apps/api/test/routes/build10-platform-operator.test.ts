/**
 * Build-11 Objective 3 — platform-operator identity: rotatable
 * keyring, PlatformOperatorGuard, and operator_id in audit_events.
 *
 * The route already required the 'admin' scope (AuthGuard +
 * RequireScope, unchanged — unauthenticated → 401 and wrong scope →
 * 403 are proven by the guard tests). This file proves the
 * PLATFORM-OPERATOR layer on top of it:
 *
 *   - resolvePlatformOperatorKeyring: PLATFORM_OPERATOR_KEYS (JSON
 *     map operator_id -> secret_key) wins over the single
 *     PLATFORM_OPERATOR_KEY (operator id 'default'); the
 *     deterministic test fallback applies only when NODE_ENV ===
 *     'test' (operator id 'test'); null otherwise; a malformed
 *     keyring env throws at resolution.
 *   - verifyOperatorKey: an Id header must name the key's owner
 *     (no id spoofing); without an Id header the operator id is
 *     DERIVED from the key that matches.
 *   - PlatformOperatorGuard.canActivate: correct key → true and
 *     request.operatorId set; missing/wrong header → 403
 *     PLATFORM_OPERATOR_REQUIRED with a rejection audit row;
 *     unknown operator id → 403; no key configured outside test
 *     mode → 503 PLATFORM_OPERATOR_KEY_NOT_CONFIGURED (fail closed)
 *     with a rejection audit row; malformed keyring env → the
 *     constructor throws.
 *   - WebhooksController.reEncryptSecrets: with a verified
 *     operatorId on the request → 200 with the documented shape AND
 *     a 'platform_operator.re_encrypt_succeeded' audit row carrying
 *     the operator_id and the counts; without operatorId → 403
 *     (fail closed — the guard must have run).
 *
 * Audit rows are chained under the CALLING admin's tenant (the
 * re-encrypt route is platform-wide, so the caller's tenant is the
 * only tenant identity the call has). Unauthenticated (401)
 * attempts are not audited — AuthGuard rejects them before this
 * guard runs, so there is no actor or tenant to chain under.
 *
 * The live-HTTP proof (real server, real headers, 401
 * unauthenticated, 403 without the header, 200 with the operator
 * key, keyring via env) lives in build10-objective3-live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import type { Kysely } from 'kysely';
import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import {
  WebhookService,
  type DeliverRequest,
  type WebhookServiceOptions,
} from '../../src/modules/integrations/webhook.service';
import {
  PLATFORM_OPERATOR_TEST_KEY,
  WebhooksController,
} from '../../src/modules/integrations/webhooks.controller';
import {
  PLATFORM_OPERATOR_DEFAULT_ID,
  PLATFORM_OPERATOR_TEST_ID,
  PlatformOperatorGuard,
  resolvePlatformOperatorKeyring,
  verifyOperatorKey,
} from '../../src/modules/integrations/platform-operator.guard';
import { AuditService } from '../../src/modules/admin/audit.service';
import { UuidValidationInterceptor } from '../../src/common/uuid-validation.interceptor';
import { InvalidUuidException } from '../../src/common/uuid';
import { CatalogueController } from '../../src/modules/catalogue/catalogue.controller';
import { actorFor, reqFor, withDb } from './helpers';
import type { Actor } from '../../src/common/actor';

/** Deterministic master keys for these tests (explicit options, not the env fallback). */
const KEY_K1 = 'build-10-test-master-key-k1';
const KEY_K2 = 'build-10-test-master-key-k2';

function makeService(
  db: Kysely<DB>,
  requests: DeliverRequest[],
  getNow: () => Date,
  extra: WebhookServiceOptions = {},
) {
  return new WebhookService(db, undefined, {
    deliver: async (request) => {
      requests.push(request);
      return 200;
    },
    clock: getNow,
    encryptionKeys: { k1: KEY_K1 },
    activeKeyId: 'k1',
    ...extra,
  });
}

function makeRotatingController(db: Kysely<DB>, withAudit = false): WebhooksController {
  const getNow = () => new Date('2026-11-14T10:00:00.000Z');
  const rotating = makeService(db, [], getNow, {
    encryptionKeys: { k1: KEY_K1, k2: KEY_K2 },
    activeKeyId: 'k2',
  });
  return withAudit
    ? new WebhooksController(rotating, new AuditService(db), db)
    : new WebhooksController(rotating);
}

/** Minimal mock ExecutionContext for the operator guard, carrying actor + headers + body. */
function operatorContext(
  actor: Actor | undefined,
  headers: Record<string, string | string[] | undefined>,
  body?: unknown,
): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = { headers, body };
  if (actor !== undefined) request.actor = actor;
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => WebhooksController.prototype.reEncryptSecrets,
      getClass: () => WebhooksController,
    } as unknown as ExecutionContext,
    request,
  };
}

/** Run fn with the operator env vars set, restoring process.env afterwards. */
async function withOperatorEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key] as string;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key] as string;
      }
    }
  }
}

async function auditRows(
  db: Kysely<DB>,
  tenantId: string,
  eventType: string,
): Promise<Array<{ payload: Record<string, unknown> }>> {
  const rows = await db
    .selectFrom('audit_events')
    .select('payload')
    .where('tenant_id', '=', tenantId)
    .where('event_type', '=', eventType)
    .execute();
  return rows as Array<{ payload: Record<string, unknown> }>;
}

function httpErrorOf(thrown: unknown): { status: number; response: unknown } {
  return {
    status: (thrown as { getStatus?: () => number }).getStatus?.() ?? -1,
    response: (thrown as { getResponse?: () => unknown }).getResponse?.(),
  };
}

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it resolved');
}

describe('resolvePlatformOperatorKeyring', () => {
  it('PLATFORM_OPERATOR_KEYS (JSON map) wins over the single PLATFORM_OPERATOR_KEY', () => {
    const resolved = resolvePlatformOperatorKeyring({
      NODE_ENV: 'production',
      PLATFORM_OPERATOR_KEYS: JSON.stringify({ alice: 'alice-key', bob: 'bob-key' }),
      PLATFORM_OPERATOR_KEY: 'single-key',
    });
    expect(resolved?.source).toBe('keyring');
    expect([...(resolved?.entries.keys() ?? [])].sort()).toEqual(['alice', 'bob']);
    expect(resolved?.entries.get('alice')).toBe('alice-key');
    expect(resolved?.entries.has(PLATFORM_OPERATOR_DEFAULT_ID)).toBe(false);
  });

  it('the single PLATFORM_OPERATOR_KEY maps to operator id "default"', () => {
    const resolved = resolvePlatformOperatorKeyring({
      NODE_ENV: 'production',
      PLATFORM_OPERATOR_KEY: 'op-key-1',
    });
    expect(resolved?.source).toBe('single');
    expect([...(resolved?.entries.entries() ?? [])]).toEqual([
      [PLATFORM_OPERATOR_DEFAULT_ID, 'op-key-1'],
    ]);
  });

  it('falls back to the deterministic test key only when NODE_ENV is test', () => {
    const inTest = resolvePlatformOperatorKeyring({ NODE_ENV: 'test' });
    expect(inTest?.source).toBe('test-fallback');
    expect([...(inTest?.entries.entries() ?? [])]).toEqual([
      [PLATFORM_OPERATOR_TEST_ID, PLATFORM_OPERATOR_TEST_KEY],
    ]);
    expect(resolvePlatformOperatorKeyring({ NODE_ENV: 'production' })).toBeNull();
    expect(resolvePlatformOperatorKeyring({})).toBeNull();
  });

  it('an empty env value does not count as configured', () => {
    expect(
      resolvePlatformOperatorKeyring({ NODE_ENV: 'production', PLATFORM_OPERATOR_KEY: '' }),
    ).toBeNull();
    expect(
      resolvePlatformOperatorKeyring({ NODE_ENV: 'test', PLATFORM_OPERATOR_KEY: '' })?.source,
    ).toBe('test-fallback');
    expect(
      resolvePlatformOperatorKeyring({ NODE_ENV: 'test', PLATFORM_OPERATOR_KEYS: '' })?.source,
    ).toBe('test-fallback');
  });

  it('a malformed PLATFORM_OPERATOR_KEYS throws at resolution', () => {
    expect(() =>
      resolvePlatformOperatorKeyring({ NODE_ENV: 'production', PLATFORM_OPERATOR_KEYS: 'not json' }),
    ).toThrow('not valid JSON');
    expect(() =>
      resolvePlatformOperatorKeyring({ NODE_ENV: 'production', PLATFORM_OPERATOR_KEYS: '["a"]' }),
    ).toThrow('must be a JSON object');
    expect(() =>
      resolvePlatformOperatorKeyring({ NODE_ENV: 'production', PLATFORM_OPERATOR_KEYS: 'null' }),
    ).toThrow('must be a JSON object');
    expect(() =>
      resolvePlatformOperatorKeyring({
        NODE_ENV: 'production',
        PLATFORM_OPERATOR_KEYS: JSON.stringify({ alice: '' }),
      }),
    ).toThrow('must be a non-empty string');
    expect(() =>
      resolvePlatformOperatorKeyring({
        NODE_ENV: 'production',
        PLATFORM_OPERATOR_KEYS: JSON.stringify({ alice: 42 }),
      }),
    ).toThrow('must be a non-empty string');
    expect(() =>
      resolvePlatformOperatorKeyring({ NODE_ENV: 'production', PLATFORM_OPERATOR_KEYS: '{}' }),
    ).toThrow('at least one operator_id');
  });
});

describe('verifyOperatorKey', () => {
  const keyring = resolvePlatformOperatorKeyring({
    NODE_ENV: 'production',
    PLATFORM_OPERATOR_KEYS: JSON.stringify({ alice: 'alice-key', bob: 'bob-key' }),
  }) as NonNullable<ReturnType<typeof resolvePlatformOperatorKeyring>>;

  it('an Id header must name the key owner — no id spoofing', () => {
    expect(verifyOperatorKey(keyring, 'alice', 'alice-key')).toBe('alice');
    expect(verifyOperatorKey(keyring, 'alice', 'bob-key')).toBeNull();
    expect(verifyOperatorKey(keyring, 'carol', 'alice-key')).toBeNull();
  });

  it('without an Id header the operator id is derived from the key', () => {
    expect(verifyOperatorKey(keyring, undefined, 'bob-key')).toBe('bob');
    expect(verifyOperatorKey(keyring, undefined, 'no-such-key')).toBeNull();
    expect(verifyOperatorKey(keyring, undefined, undefined)).toBeNull();
    expect(verifyOperatorKey(keyring, undefined, '')).toBeNull();
  });
});

describe('PlatformOperatorGuard.canActivate', () => {
  it('correct test key, no Id header → true, operatorId derived as "test"', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      const guard = new PlatformOperatorGuard(new AuditService(db), db);
      const { context, request } = operatorContext(actor, {
        'x-platform-operator-key': PLATFORM_OPERATOR_TEST_KEY,
      });
      expect(await guard.canActivate(context)).toBe(true);
      expect(request.operatorId).toBe(PLATFORM_OPERATOR_TEST_ID);
      expect(
        await auditRows(db, tenant.tenantId, 'platform_operator.re_encrypt_rejected'),
      ).toHaveLength(0);
    });
  });

  it('keyring env: Id header must match the key owner; without an Id the id is derived', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      await withOperatorEnv(
        { PLATFORM_OPERATOR_KEYS: JSON.stringify({ alice: 'alice-key', bob: 'bob-key' }) },
        async () => {
          const guard = new PlatformOperatorGuard(new AuditService(db), db);
          const ok = operatorContext(actor, {
            'x-platform-operator-id': 'alice',
            'x-platform-operator-key': 'alice-key',
          });
          expect(await guard.canActivate(ok.context)).toBe(true);
          expect(ok.request.operatorId).toBe('alice');

          // Alice's id with Bob's key: id spoofing is blocked.
          const spoof = operatorContext(actor, {
            'x-platform-operator-id': 'alice',
            'x-platform-operator-key': 'bob-key',
          });
          const spoofError = httpErrorOf(await captureThrow(() => guard.canActivate(spoof.context)));
          expect(spoofError.status).toBe(403);
          expect(spoofError.response).toEqual({
            error: {
              code: 'PLATFORM_OPERATOR_REQUIRED',
              message: expect.stringContaining('X-Platform-Operator-Key'),
            },
          });

          // No Id header: Bob's key derives Bob.
          const derived = operatorContext(actor, {
            'x-platform-operator-key': 'bob-key',
          });
          expect(await guard.canActivate(derived.context)).toBe(true);
          expect(derived.request.operatorId).toBe('bob');

          // Unknown operator id → 403.
          const unknown = operatorContext(actor, {
            'x-platform-operator-id': 'carol',
            'x-platform-operator-key': 'alice-key',
          });
          const unknownError = httpErrorOf(
            await captureThrow(() => guard.canActivate(unknown.context)),
          );
          expect(unknownError.status).toBe(403);
        },
      );
    });
  });

  it('missing header → 403 PLATFORM_OPERATOR_REQUIRED + a rejection audit row', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      const guard = new PlatformOperatorGuard(new AuditService(db), db);
      const { context } = operatorContext(
        actor,
        {},
        { fromKeyId: 'k1' },
      );
      const error = httpErrorOf(await captureThrow(() => guard.canActivate(context)));
      expect(error.status).toBe(403);
      expect(error.response).toEqual({
        error: {
          code: 'PLATFORM_OPERATOR_REQUIRED',
          message: expect.stringContaining('X-Platform-Operator-Key'),
        },
      });
      const rows = await auditRows(db, tenant.tenantId, 'platform_operator.re_encrypt_rejected');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.operator_id).toBeNull();
      expect(rows[0]?.payload.verified_operator_id).toBeNull();
      expect(rows[0]?.payload.reason).toBe('missing_header');
      expect(rows[0]?.payload.from_key_id).toBe('k1');
    });
  });

  it('wrong header → 403 + a rejection audit row naming the presented id', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      const guard = new PlatformOperatorGuard(new AuditService(db), db);
      const { context } = operatorContext(actor, {
        'x-platform-operator-id': 'alice',
        'x-platform-operator-key': 'not-the-operator-key',
      });
      const error = httpErrorOf(await captureThrow(() => guard.canActivate(context)));
      expect(error.status).toBe(403);
      const rows = await auditRows(db, tenant.tenantId, 'platform_operator.re_encrypt_rejected');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.operator_id).toBe('alice');
      expect(rows[0]?.payload.verified_operator_id).toBeNull();
      expect(rows[0]?.payload.reason).toBe('unknown_operator_id');
    });
  });

  it('no key configured outside test mode → 503 PLATFORM_OPERATOR_KEY_NOT_CONFIGURED (fail closed) + a rejection audit row', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      await withOperatorEnv(
        { PLATFORM_OPERATOR_KEYS: undefined, PLATFORM_OPERATOR_KEY: undefined, NODE_ENV: 'production' },
        async () => {
          const guard = new PlatformOperatorGuard(new AuditService(db), db);
          const { context } = operatorContext(actor, {
            'x-platform-operator-key': 'anything',
          });
          const error = httpErrorOf(await captureThrow(() => guard.canActivate(context)));
          expect(error.status).toBe(503);
          expect(error.response).toEqual({
            error: {
              code: 'PLATFORM_OPERATOR_KEY_NOT_CONFIGURED',
              message: expect.stringContaining('PLATFORM_OPERATOR_KEY is not configured'),
            },
          });
          const rows = await auditRows(
            db,
            tenant.tenantId,
            'platform_operator.re_encrypt_rejected',
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]?.payload.reason).toBe('key_not_configured');
        },
      );
    });
  });

  it('no actor on the request → 401 (the guard never runs without AuthGuard first)', async () => {
    await withDb(async ({ db }) => {
      const guard = new PlatformOperatorGuard(new AuditService(db), db);
      const { context } = operatorContext(undefined, {
        'x-platform-operator-key': PLATFORM_OPERATOR_TEST_KEY,
      });
      const error = httpErrorOf(await captureThrow(() => guard.canActivate(context)));
      expect(error.status).toBe(401);
    });
  });

  it('a malformed PLATFORM_OPERATOR_KEYS throws at construction', async () => {
    await withDb(async ({ db }) => {
      await withOperatorEnv(
        { PLATFORM_OPERATOR_KEYS: 'not json' },
        async () => {
          expect(() => new PlatformOperatorGuard(new AuditService(db), db)).toThrow(
            'not valid JSON',
          );
        },
      );
    });
  });

  it('the guard runs before body validation: missing header + empty fromKeyId is 403, not 400', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      const guard = new PlatformOperatorGuard(new AuditService(db), db);
      const { context } = operatorContext(actor, {}, { fromKeyId: '' });
      const error = httpErrorOf(await captureThrow(() => guard.canActivate(context)));
      expect(error.status).toBe(403);
      expect(error.response).toEqual({
        error: {
          code: 'PLATFORM_OPERATOR_REQUIRED',
          message: expect.stringContaining('X-Platform-Operator-Key'),
        },
      });
    });
  });
});

describe('WebhooksController.reEncryptSecrets — operator guard + audit', () => {
  it('verified operatorId + admin actor → 200 with the documented shape + a success audit row', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const service = makeService(db, [], getNow);
      await service.registerEndpoint(tenantA.tenantId, 'https://example.com/hooks-a', [
        'order.completed',
      ]);
      await service.registerEndpoint(tenantB.tenantId, 'https://example.com/hooks-b', [
        'order.completed',
      ]);
      const actor: Actor = actorFor(tenantA, 'admin');
      const controller = makeRotatingController(db, true);
      const response = await controller.reEncryptSecrets(
        { ...reqFor(actor), operatorId: 'test' },
        { fromKeyId: 'k1' },
      );
      expect(response).toEqual({
        from_key_id: 'k1',
        to_key_id: 'k2',
        endpoints_examined: 2,
        endpoints_re_encrypted: 2,
        ciphertexts_re_encrypted: 2,
        endpoints_already_current: 0,
        unreadable_ciphertexts: [],
      });
      const rows = await auditRows(db, tenantA.tenantId, 'platform_operator.re_encrypt_succeeded');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.operator_id).toBe('test');
      expect(rows[0]?.payload.verified_operator_id).toBe('test');
      expect(rows[0]?.payload.from_key_id).toBe('k1');
      expect(rows[0]?.payload.to_key_id).toBe('k2');
      expect(rows[0]?.payload.endpoints_re_encrypted).toBe(2);
      expect(rows[0]?.payload.ciphertexts_re_encrypted).toBe(2);
      // The success is recorded under the CALLING tenant only — the
      // platform-wide walk does not fan audit rows out to every tenant.
      expect(
        await auditRows(db, tenantB.tenantId, 'platform_operator.re_encrypt_succeeded'),
      ).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('no operatorId on the request → 403 PLATFORM_OPERATOR_REQUIRED and nothing is re-encrypted (fail closed)', async () => {
    await withDb(async ({ db, tenant }) => {
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const service = makeService(db, [], getNow);
      const { endpoint } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );
      const actor: Actor = actorFor(tenant, 'admin');
      const controller = makeRotatingController(db, true);
      const error = httpErrorOf(
        await captureThrow(() => controller.reEncryptSecrets(reqFor(actor), { fromKeyId: 'k1' })),
      );
      expect(error.status).toBe(403);
      expect(error.response).toEqual({
        error: {
          code: 'PLATFORM_OPERATOR_REQUIRED',
          message: expect.stringContaining('X-Platform-Operator-Key'),
        },
      });
      // Nothing changed: the endpoint still sits under the old key.
      const row = await db
        .selectFrom('webhook_endpoints')
        .select('encryption_key_id')
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(row.encryption_key_id).toBe('k1');
      expect(
        await auditRows(db, tenant.tenantId, 'platform_operator.re_encrypt_succeeded'),
      ).toHaveLength(0);
    });
  });

  it('verified operatorId + empty fromKeyId → 400 (body validation still runs after the guard)', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor: Actor = actorFor(tenant, 'admin');
      const controller = makeRotatingController(db, true);
      const error = httpErrorOf(
        await captureThrow(() =>
          controller.reEncryptSecrets({ ...reqFor(actor), operatorId: 'test' }, { fromKeyId: '' }),
        ),
      );
      expect(error.status).toBe(400);
    });
  });
});

describe('UuidValidationInterceptor — @SkipUuidBodyValidation on re-encrypt', () => {
  function contextFor(handler: unknown, body: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ params: {}, body }) }),
      getHandler: () => handler,
      getClass: () => WebhooksController,
    } as unknown as ExecutionContext;
  }

  it('a fromKeyId body passes on the decorated re-encrypt handler', async () => {
    const interceptor = new UuidValidationInterceptor(new Reflector());
    const next: CallHandler = { handle: () => of('ok') };
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(WebhooksController.prototype.reEncryptSecrets, { fromKeyId: 'k1' }),
        next,
      ),
    );
    expect(result).toBe('ok');
  });

  it('the same body still 400s on an undecorated handler (the opt-out is per-route)', async () => {
    const interceptor = new UuidValidationInterceptor(new Reflector());
    const next: CallHandler = { handle: () => of('ok') };
    // intercept() throws synchronously. Nest's HttpException.message
    // degrades to the class name for a structured body, so assert on
    // the structured response, not the message string.
    let thrown: unknown = null;
    try {
      interceptor.intercept(
        contextFor(CatalogueController.prototype.createVariant, { fromKeyId: 'k1' }),
        next,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidUuidException);
    expect((thrown as InvalidUuidException).getResponse()).toEqual({
      error: {
        code: 'INVALID_UUID',
        message: 'fromKeyId must be a valid UUID',
        field: 'fromKeyId',
      },
    });
  });
});
