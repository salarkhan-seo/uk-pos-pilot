/**
 * Shared helpers for the Build-04 Worker 4 route tests
 * (apps/api/test/routes/*).
 *
 * Same pattern as apps/api/test/gates/gates.test.ts: each test creates
 * its own PGlite database (createTestDb) and seeds one tenant (two for
 * cross-tenant checks). Controllers are constructed directly with the
 * real services — no Nest app, no HTTP — and the AuthGuard is exercised
 * directly with a mock ExecutionContext so scope / cross-tenant
 * behaviour is proven at the guard layer, exactly where Nest runs it.
 */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Kysely } from 'kysely';
import {
  createTestDb,
  seedTenant,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { ApiKeyService } from '../../src/modules/admin/api-key.service';
import { AuthGuard } from '../../src/modules/admin/auth.guard';
import { SessionService } from '../../src/modules/admin/session.service';
import { TierGate } from '../../src/modules/admin/tier-gate';
import type { Actor } from '../../src/common/actor';
import type { RoleName } from '../../src/common/roles';
import type { ApiScope } from '../../src/common/scopes';

export async function withDb<T>(
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

export function actorFor(tenant: SeededTenant, role: RoleName): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

export function reqFor(actor: Actor): { actor: Actor } {
  return { actor };
}

export function makeGuard(db: Kysely<DB>): AuthGuard {
  return new AuthGuard(
    new ApiKeyService(db),
    new SessionService(db),
    new TierGate(db),
    new Reflector(),
  );
}

/** Minimal mock ExecutionContext carrying headers (+ optional params) for the guard. */
export function guardContext(
  handler: (...args: never[]) => unknown,
  headers: Record<string, string | string[] | undefined>,
): ExecutionContext {
  const request = { headers, params: {} as Record<string, string | undefined> };
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getType: () => 'http',
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => {
      throw new Error('no rpc context in these tests');
    },
    switchToWs: () => {
      throw new Error('no ws context in these tests');
    },
  } as unknown as ExecutionContext;
}

/** Create a real scoped API key for a tenant; returns the full key once. */
export async function makeApiKey(
  db: Kysely<DB>,
  tenantId: string,
  scopes: ApiScope[],
): Promise<string> {
  const service = new ApiKeyService(db);
  const created = await service.createKey(tenantId, { name: 'route-test key', scopes });
  return created.key;
}
