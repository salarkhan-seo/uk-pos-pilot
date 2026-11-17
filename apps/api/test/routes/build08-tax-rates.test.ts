/**
 * Build-08 Objective 1 — GET /v1/tax-rates + GET /v1/tax-rates/:id.
 *
 * Layers, each proven where it actually lives (no Nest app boots under
 * vitest — esbuild emits no decorator metadata; see uuid-validation
 * test header for the proof):
 *
 *  (a) Service — list returns the tenant's ACTIVE rates ordered by
 *      name with the exact view mapping (rate_bps from numeric(5,2),
 *      is_exempt, is_default_no_tax); inactive rates are excluded from
 *      the list but still readable by id; cross-tenant and unknown ids
 *      are 404 (G-B).
 *  (b) Controller — direct construction with the real service; the
 *      view shape is what the wire returns.
 *  (c) AuthGuard — driven directly with mock ExecutionContexts on the
 *      real decorated handlers: no credential → 401, wrong scope →
 *      403, catalogue:read key or manager PIN session → pass,
 *      x-tenant-id for another tenant → 404.
 *  (d) UuidValidationInterceptor — malformed :id → 400 INVALID_UUID
 *      naming the field; a well-formed UUID passes through.
 *
 * The wire-level proof (real HTTP against the compiled server, incl.
 * the admin-shell variant-create flow that consumes this route) lives
 * in apps/admin-web/test/build08-tax-rates.test.ts.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import {
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import { CatalogueController } from '../../src/modules/catalogue/catalogue.controller';
import {
  CatalogueService,
  ratePercentToBps,
  toTaxRateView,
} from '../../src/modules/catalogue/catalogue.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { UuidValidationInterceptor } from '../../src/common/uuid-validation.interceptor';
import { InvalidUuidException } from '../../src/common/uuid';
import { actorFor, guardContext, makeApiKey, makeGuard, reqFor, withDb } from './helpers';

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED = 'not-a-uuid';

async function seedInactiveRate(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const row = await db
    .insertInto('tax_rates')
    .values({
      tenant_id: tenant.tenantId,
      name: 'Old Standard 17.5%',
      kind: 'standard',
      rate_percent: '17.50',
      is_active: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function mockContext(params: Record<string, unknown>): ExecutionContext {
  const request = { params, body: undefined, method: 'GET', path: '/v1/tax-rates/not-a-uuid' };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => undefined,
    getClass: () => Object,
    getType: () => 'http',
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => undefined,
    switchToWs: () => undefined,
  } as unknown as ExecutionContext;
}

const NEXT: CallHandler = { handle: () => of('ok') };

describe('ratePercentToBps — exact integer conversion from numeric(5,2)', () => {
  it.each([
    ['20.00', 2000],
    ['5.00', 500],
    ['0.00', 0],
    ['0', 0],
    ['20', 2000],
    ['5.50', 550],
    ['17.50', 1750],
    ['2.25', 225],
  ])('%s → %d bps', (input, expected) => {
    expect(ratePercentToBps(input)).toBe(expected);
  });

  it('rejects a non-numeric percent', () => {
    expect(() => ratePercentToBps('twenty')).toThrow('Invalid tax rate percent');
  });
});

describe('CatalogueService — tax rates', () => {
  it('lists the tenant active rates ordered by name with the exact view', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const rates = await service.listTaxRates(actor);
      expect(rates.map((r) => r.name)).toEqual([
        'Exempt',
        'Reduced 5%',
        'Standard 20%',
        'Zero-rated 0%',
      ]);
      expect(rates.map((r) => toTaxRateView(r))).toEqual([
        { id: tenant.taxRates.exempt, name: 'Exempt', rate_bps: 0, is_exempt: true, is_default_no_tax: true },
        { id: tenant.taxRates.reduced, name: 'Reduced 5%', rate_bps: 500, is_exempt: false, is_default_no_tax: false },
        { id: tenant.taxRates.standard, name: 'Standard 20%', rate_bps: 2000, is_exempt: false, is_default_no_tax: false },
        { id: tenant.taxRates.zero, name: 'Zero-rated 0%', rate_bps: 0, is_exempt: false, is_default_no_tax: true },
      ]);
    });
  });

  it('excludes inactive rates from the list but still reads one by id', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const inactiveId = await seedInactiveRate(db, tenant);
      const listed = await service.listTaxRates(actor);
      expect(listed.map((r) => r.id)).not.toContain(inactiveId);
      const read = await service.getTaxRate(actor, inactiveId);
      expect(toTaxRateView(read)).toEqual({
        id: inactiveId,
        name: 'Old Standard 17.5%',
        rate_bps: 1750,
        is_exempt: false,
        is_default_no_tax: false,
      });
    });
  });

  it('getTaxRate is 404 for an unknown id and for another tenant rate (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const service = new CatalogueService(db);
      await expect(
        service.getTaxRate(actorFor(tenantA, 'owner'), UNKNOWN_UUID),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.getTaxRate(actorFor(tenantB, 'owner'), tenantA.taxRates.standard),
      ).rejects.toBeInstanceOf(NotFoundException);
      const listedB = await service.listTaxRates(actorFor(tenantB, 'owner'));
      expect(listedB.map((r) => r.id)).not.toContain(tenantA.taxRates.standard);
    } finally {
      await close();
    }
  });
});

describe('CatalogueController — tax rates (direct construction)', () => {
  it('listTaxRates and getTaxRate return the wire view', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new CatalogueController(new CatalogueService(db));
      const actor = actorFor(tenant, 'cashier');
      const listed = await controller.listTaxRates(reqFor(actor));
      expect(listed).toHaveLength(4);
      expect(listed[2]).toEqual({
        id: tenant.taxRates.standard,
        name: 'Standard 20%',
        rate_bps: 2000,
        is_exempt: false,
        is_default_no_tax: false,
      });
      const single = await controller.getTaxRate(reqFor(actor), tenant.taxRates.exempt);
      expect(single).toEqual({
        id: tenant.taxRates.exempt,
        name: 'Exempt',
        rate_bps: 0,
        is_exempt: true,
        is_default_no_tax: true,
      });
    });
  });

  it('getTaxRate is 404 for another tenant rate', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const controller = new CatalogueController(new CatalogueService(db));
      await expect(
        controller.getTaxRate(reqFor(actorFor(tenantB, 'owner')), tenantA.taxRates.standard),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('CatalogueController tax rates — AuthGuard scope checks', () => {
  it('unauthenticated → 401, wrong scope → 403, catalogue:read → pass, cross-tenant → 404', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const listHandler = CatalogueController.prototype.listTaxRates;
      const getHandler = CatalogueController.prototype.getTaxRate;
      await expect(guard.canActivate(guardContext(listHandler, {}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(guard.canActivate(guardContext(getHandler, {}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      const salesKey = await makeApiKey(db, tenant.tenantId, ['sales:read']);
      await expect(
        guard.canActivate(guardContext(listHandler, { authorization: `Bearer ${salesKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const readKey = await makeApiKey(db, tenant.tenantId, ['catalogue:read']);
      expect(
        await guard.canActivate(guardContext(listHandler, { authorization: `Bearer ${readKey}` })),
      ).toBe(true);
      expect(
        await guard.canActivate(guardContext(getHandler, { authorization: `Bearer ${readKey}` })),
      ).toBe(true);
      // An admin-scope key implies every scope (scopes.ts).
      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      expect(
        await guard.canActivate(guardContext(listHandler, { authorization: `Bearer ${adminKey}` })),
      ).toBe(true);
      // A manager PIN session carries catalogue:read via scopesForRoles.
      const sessions = new SessionService(db);
      const manager = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      expect(
        await guard.canActivate(
          guardContext(listHandler, { authorization: `Bearer ${manager.token}` }),
        ),
      ).toBe(true);
      // Cross-tenant addressing is 404, never 403 (G-B).
      const other = await seedTenant(db);
      await expect(
        guard.canActivate(
          guardContext(listHandler, {
            authorization: `Bearer ${readKey}`,
            'x-tenant-id': other.tenantId,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('GET /v1/tax-rates/:id — malformed id → 400 INVALID_UUID', () => {
  it('interceptor rejects a malformed :id and passes a well-formed UUID through', () => {
    const interceptor = new UuidValidationInterceptor();
    let caught: unknown;
    try {
      interceptor.intercept(mockContext({ id: MALFORMED }), NEXT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidUuidException);
    expect((caught as HttpException).getStatus()).toBe(400);
    const res = (caught as HttpException).getResponse() as { error?: Record<string, string> };
    expect(res.error).toMatchObject({ code: 'INVALID_UUID', field: 'id' });
    expect(() => interceptor.intercept(mockContext({ id: randomUUID() }), NEXT)).not.toThrow();
  });
});
