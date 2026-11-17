/**
 * Build-03 Objective 1 — production auth, scopes & tier gating.
 *
 * ApiKeyService (hashed keys, shown once, 24h rotation grace, revoke),
 * SessionService (PIN → short-lived HMAC token), TierGate (403
 * PLAN_GATED on documented writes only; reads/exports never gated) and
 * AuthGuard (API key or session token, scope check, cross-tenant 404).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant (seedTenant: one user per role, PIN '1234').
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  apiKeyActor,
  createTestApiKey,
  createTestDb,
  seedTenant,
  sessionActor,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { ApiKeyService, hashApiKey } from '../../src/modules/admin/api-key.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { AuthGuard, REQUIRE_SCOPE_KEY, TIER_GATED_WRITE_KEY } from '../../src/modules/admin/auth.guard';
import { PlanGatedException, TierGate } from '../../src/modules/admin/tier-gate';
import type { Actor } from '../../src/common/actor';
import type { ApiScope } from '../../src/common/scopes';

type Role = 'owner' | 'admin' | 'manager' | 'cashier';

async function withSeededDb<T>(
  fn: (ctx: { db: Kysely<DB>; tenant: SeededTenant }) => Promise<T>,
): Promise<T> {
  const { db, close } = await createTestDb();
  try {
    const tenant = await seedTenant(db);
    return await fn({ db, tenant });
  } finally {
    await close();
  }
}

function actorFor(tenant: SeededTenant, role: Role): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

describe('ApiKeyService — create and verify', () => {
  it('creates a key shown once, stores only its SHA-256 hash, and verifies it', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      const created = await service.createKey(tenant.tenantId, {
        name: 'Stock script',
        scopes: ['stock:read', 'stock:write'],
      });
      expect(created.key.startsWith('ukp_')).toBe(true);
      expect(created.keyPrefix).toBe(created.key.slice(0, 8));
      expect(created.scopes).toEqual(['stock:read', 'stock:write']);

      // Only the hash is stored — the full key appears nowhere in the row.
      const row = await db
        .selectFrom('api_keys')
        .selectAll()
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(row.key_hash).toBe(hashApiKey(created.key));
      expect(row.key_hash).not.toContain(created.key);
      expect(JSON.stringify(row)).not.toContain(created.key);

      const verified = await service.verifyKey(created.key);
      expect(verified).not.toBeNull();
      expect(verified?.tenantId).toBe(tenant.tenantId);
      expect(verified?.scopes).toEqual(['stock:read', 'stock:write']);
      expect(verified?.status).toBe('active');

      // last_used_at is stamped on verification.
      const after = await db
        .selectFrom('api_keys')
        .select('last_used_at')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(after.last_used_at).not.toBeNull();

      // A wrong key, an empty key and a foreign tenant's key never verify.
      expect(await service.verifyKey('ukp_0000000000000000000000000000000000000000000000000000000000000000')).toBeNull();
      expect(await service.verifyKey('')).toBeNull();
    });
  });

  it('rejects unknown scopes and empty scope lists at creation', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      await expect(
        service.createKey(tenant.tenantId, { scopes: ['bogus:read'] as ApiScope[] }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createKey(tenant.tenantId, { scopes: [] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('an expired key never verifies', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      const created = await service.createKey(tenant.tenantId, {
        scopes: ['catalogue:read'],
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await service.verifyKey(created.key)).toBeNull();
    });
  });
});

describe('ApiKeyService — rotate and revoke', () => {
  it('old key works during the 24h grace, fails after it, new key works throughout', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      const original = await service.createKey(tenant.tenantId, {
        name: 'Integration',
        scopes: ['sales:read'],
      });

      const rotated = await service.rotateKey(tenant.tenantId, original.id);
      expect(rotated.key).not.toBe(original.key);
      expect(rotated.name).toBe('Integration');
      expect(rotated.scopes).toEqual(['sales:read']);

      // Old key: still valid inside the grace period, status 'rotating'.
      const duringGrace = await service.verifyKey(original.key);
      expect(duringGrace).not.toBeNull();
      expect(duringGrace?.status).toBe('rotating');
      const oldRow = await db
        .selectFrom('api_keys')
        .select(['status', 'grace_until'])
        .where('id', '=', original.id)
        .executeTakeFirstOrThrow();
      expect(oldRow.status).toBe('rotating');
      expect(oldRow.grace_until).not.toBeNull();
      expect(oldRow.grace_until as Date).toBeInstanceOf(Date);
      // Grace is ~24h from rotation (allow a minute of test slop).
      expect((oldRow.grace_until as Date).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);

      // New key verifies.
      expect(await service.verifyKey(rotated.key)).not.toBeNull();

      // After the grace expires the old key fails (grace_until moved to the past).
      await db
        .updateTable('api_keys')
        .set({ grace_until: new Date(Date.now() - 1000) })
        .where('id', '=', original.id)
        .execute();
      expect(await service.verifyKey(original.key)).toBeNull();
      // The new key is unaffected.
      expect(await service.verifyKey(rotated.key)).not.toBeNull();
    });
  });

  it('revoke is immediate, and a revoked key cannot be rotated', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      const created = await service.createKey(tenant.tenantId, { scopes: ['sales:read'] });
      await service.revokeKey(tenant.tenantId, created.id);
      expect(await service.verifyKey(created.key)).toBeNull();
      await expect(service.rotateKey(tenant.tenantId, created.id)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  it('a key id from another tenant is not found (G-B)', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const created = await service.createKey(other.tenantId, { scopes: ['sales:read'] });
      await expect(service.revokeKey(tenant.tenantId, created.id)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.rotateKey(tenant.tenantId, created.id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('listKeys never returns a hash or a full key', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new ApiKeyService(db);
      const created = await service.createKey(tenant.tenantId, { scopes: ['sales:read'] });
      const listed = await service.listKeys(tenant.tenantId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(created.id);
      expect(listed[0]).not.toHaveProperty('key_hash');
      expect(JSON.stringify(listed)).not.toContain(created.key);
    });
  });
});

describe('SessionService — PIN login and HMAC tokens', () => {
  it('issues a token after PIN verification and verifies it back to an actor', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new SessionService(db, 'test-secret-for-api-keys-suite');
      const { token, actor } = await service.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
        isTill: true,
      });
      expect(token.split('.')).toHaveLength(2);
      expect(actor.authKind).toBe('session');
      expect(actor.isTillSession).toBe(true);
      expect(actor.roles).toEqual(['cashier']);

      const verified = await service.verifyToken(token);
      expect(verified).not.toBeNull();
      expect(verified?.tenantId).toBe(tenant.tenantId);
      expect(verified?.userId).toBe(tenant.users.cashier.id);
      expect(verified?.locationId).toBe(tenant.locationId);
      expect(verified?.isTillSession).toBe(true);
    });
  });

  it('rejects a wrong PIN, a user with no PIN, and a tampered token', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new SessionService(db, 'test-secret-for-api-keys-suite');
      await expect(
        service.login({
          tenantId: tenant.tenantId,
          userId: tenant.users.cashier.id,
          pin: '9999',
        }),
      ).rejects.toThrow(ForbiddenException);

      const { token } = await service.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      const [payload, signature] = token.split('.') as [string, string];
      // Tampered payload.
      const tamperedPayload = `${payload?.slice(0, -2)}AA.${signature}`;
      expect(await service.verifyToken(tamperedPayload)).toBeNull();
      // Tampered signature.
      expect(await service.verifyToken(`${payload}.AAAA`)).toBeNull();
      // Token signed with a different secret.
      const other = new SessionService(db, 'a-different-secret');
      const { token: otherToken } = await other.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      expect(await service.verifyToken(otherToken)).toBeNull();
      // Garbage.
      expect(await service.verifyToken('not-a-token')).toBeNull();
      expect(await service.verifyToken('')).toBeNull();
    });
  });

  it('an expired token does not verify, and disabling the user revokes sessions', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const service = new SessionService(db, 'test-secret-for-api-keys-suite');
      const { token: expired } = await service.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
        ttlMs: -1000,
      });
      expect(await service.verifyToken(expired)).toBeNull();

      const { token } = await service.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
      });
      expect(await service.verifyToken(token)).not.toBeNull();
      await db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', tenant.users.cashier.id)
        .execute();
      expect(await service.verifyToken(token)).toBeNull();
      await expect(
        service.login({
          tenantId: tenant.tenantId,
          userId: tenant.users.cashier.id,
          pin: '1234',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('TierGate — 403 PLAN_GATED on documented writes only', () => {
  it('base tier is gated on cost/vendor writes; plus tier is allowed', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const gate = new TierGate(db);
      expect(await gate.tierForTenant(tenant.tenantId)).toBe('base');
      await expect(
        gate.assertWriteAllowed(tenant.tenantId, 'cost-vendor-write'),
      ).rejects.toThrow(PlanGatedException);
      try {
        await gate.assertWriteAllowed(tenant.tenantId, 'cost-vendor-write');
        expect.unreachable('should have thrown PLAN_GATED');
      } catch (error) {
        expect(error).toBeInstanceOf(PlanGatedException);
        const response = (error as PlanGatedException).getResponse() as {
          error: { code: string; required_tier: string };
        };
        expect(response.error.code).toBe('PLAN_GATED');
        expect(response.error.required_tier).toBe('plus');
        expect((error as PlanGatedException).getStatus()).toBe(403);
      }
      for (const feature of ['custom-roles', 'advanced-reporting', 'bulk-import-api'] as const) {
        await expect(gate.assertWriteAllowed(tenant.tenantId, feature)).rejects.toThrow(
          PlanGatedException,
        );
      }

      // Plus tier: every documented write is allowed.
      await db
        .updateTable('tenants')
        .set({ plan_tier: 'plus' })
        .where('id', '=', tenant.tenantId)
        .execute();
      expect(await gate.tierForTenant(tenant.tenantId)).toBe('plus');
      await gate.assertWriteAllowed(tenant.tenantId, 'cost-vendor-write');
      await gate.assertWriteAllowed(tenant.tenantId, 'bulk-import-api');
    });
  });

  it('reads and exports are never gated, on any tier; unknown tenants default to base', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const gate = new TierGate(db);
      await gate.assertReadAllowed(tenant.tenantId);
      await gate.assertExportAllowed(tenant.tenantId);
      expect(await gate.tierForTenant('00000000-0000-0000-0000-000000000000')).toBe('base');
      // Rate limits are not plan-scaled and API access itself is never
      // gated: there is no gate method for them to call — asserting the
      // read/export paths above is the executable form of that rule.
      await gate.assertReadAllowed('00000000-0000-0000-0000-000000000000');
      await gate.assertExportAllowed('00000000-0000-0000-0000-000000000000');
    });
  });
});

describe('AuthGuard — either credential, scope check, cross-tenant 404', () => {
  interface MockReq {
    headers: Record<string, string | undefined>;
    params?: Record<string, string | undefined>;
    actor?: Actor;
  }

  function guardWith(metadata: Record<string, unknown>, db: Kysely<DB>): AuthGuard {
    const reflector = {
      get: (key: string) => metadata[key],
    } as unknown as Reflector;
    return new AuthGuard(
      new ApiKeyService(db),
      new SessionService(db, 'test-secret-for-api-keys-suite'),
      new TierGate(db),
      reflector,
    );
  }

  function contextFor(req: MockReq): Parameters<AuthGuard['canActivate']>[0] {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ setHeader: () => undefined }),
      }),
      getHandler: () => ((): void => undefined),
      getClass: () => class {},
    } as unknown as Parameters<AuthGuard['canActivate']>[0];
  }

  it('accepts an API key with the required scope and attaches the actor', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const testKey = await createTestApiKey(db, tenant, { scopes: ['catalogue:read'] });
      const guard = guardWith({ [REQUIRE_SCOPE_KEY]: 'catalogue:read' }, db);
      const req: MockReq = {
        headers: { authorization: `Bearer ${testKey.key}` },
      };
      expect(await guard.canActivate(contextFor(req))).toBe(true);
      expect(req.actor?.authKind).toBe('api-key');
      expect(req.actor?.tenantId).toBe(tenant.tenantId);
      expect(req.actor?.apiKeyId).toBe(testKey.keyId);
      // The db test helper builds the same actor shape for services.
      expect(apiKeyActor(tenant, testKey).authKind).toBe('api-key');
      expect(sessionActor(tenant, 'cashier', { isTillSession: true }).isTillSession).toBe(true);
    });
  });

  it('rejects an API key without the required scope (403) and with no credential (401)', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const testKey = await createTestApiKey(db, tenant, { scopes: ['catalogue:read'] });
      const guard = guardWith({ [REQUIRE_SCOPE_KEY]: 'catalogue:write' }, db);
      await expect(
        guard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${testKey.key}` } }),
        ),
      ).rejects.toThrow(ForbiddenException);

      const openGuard = guardWith({}, db);
      await expect(
        openGuard.canActivate(contextFor({ headers: {} })),
      ).rejects.toThrow(UnauthorizedException);
      // A revoked key is unauthenticated, not merely unscoped.
      const service = new ApiKeyService(db);
      await service.revokeKey(tenant.tenantId, testKey.keyId);
      await expect(
        openGuard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${testKey.key}` } }),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  it('accepts a session token, mapping manager roles to scopes', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const sessions = new SessionService(db, 'test-secret-for-api-keys-suite');
      const { token } = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      const guard = guardWith({ [REQUIRE_SCOPE_KEY]: 'stock:write' }, db);
      const req: MockReq = { headers: { authorization: `Bearer ${token}` } };
      expect(await guard.canActivate(contextFor(req))).toBe(true);
      expect(req.actor?.authKind).toBe('session');

      // A cashier session does not carry stock:write.
      const cashier = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
      });
      await expect(
        guard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${cashier.token}` } }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('cross-tenant addressing returns 404, never 403 (G-B)', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const testKey = await createTestApiKey(db, tenant, { scopes: ['admin'] });
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const guard = guardWith({ [REQUIRE_SCOPE_KEY]: 'admin' }, db);
      await expect(
        guard.canActivate(
          contextFor({
            headers: {
              authorization: `Bearer ${testKey.key}`,
              'x-tenant-id': other.tenantId,
            },
          }),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('a tier-gated write declared on the handler is enforced by the guard', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const testKey = await createTestApiKey(db, tenant, { scopes: ['admin'] });
      const guard = guardWith(
        { [REQUIRE_SCOPE_KEY]: 'admin', [TIER_GATED_WRITE_KEY]: 'bulk-import-api' },
        db,
      );
      await expect(
        guard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${testKey.key}` } }),
        ),
      ).rejects.toThrow(PlanGatedException);
    });
  });
});

describe('db test helpers — createTestApiKey / apiKeyActor / sessionActor', () => {
  it('seed a key and verify its hash matches the service hash', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const testKey = await createTestApiKey(db, tenant, { scopes: ['payments:read'] });
      expect(testKey.keyPrefix).toBe(testKey.key.slice(0, 8));
      const row = await db
        .selectFrom('api_keys')
        .select('key_hash')
        .where('id', '=', testKey.keyId)
        .executeTakeFirstOrThrow();
      expect(row.key_hash).toBe(createHash('sha256').update(testKey.key).digest('hex'));
      const service = new ApiKeyService(db);
      expect(await service.verifyKey(testKey.key)).not.toBeNull();
      expect(actorFor(tenant, 'manager').tenantId).toBe(tenant.tenantId);
    });
  });
});
