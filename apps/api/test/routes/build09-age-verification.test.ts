/**
 * Build-09 Objective 2 — controller layer for the age-verification
 * endpoints (direct construction with the real service; no Nest app
 * boots under vitest).
 *
 * Mounted paths (the real ones — the commission's shorthand
 * "GET /v1/orders/:id/age-verifications" is NOT the path; the sales
 * controller mounts everything under v1/sales/orders/...):
 *   POST v1/sales/orders/:id/tenders            (age_verifications)
 *   POST v1/sales/orders/:id/complete           (age_verifications)
 *   GET  v1/sales/orders/:id/age-verifications  (:id named `id`)
 *
 * Auth (Build-10, Objective 1): the sales controller is AuthGuard +
 * RequireScope — `sales:write` on the tender/complete routes,
 * `sales:read` on the GET route. The controller reads the Actor from
 * request.actor (set by the guard), never from demo headers, so the
 * direct-construction tests below pass `{ actor }` as the request.
 * The guard layer itself is proven in the AuthGuard describe block
 * at the bottom (real scoped API keys + PIN sessions, same pattern
 * as the Build-09 products guard tests). The HTTP-level 401/403/422
 * proof lives in
 * apps/register-app/test/build10-sales-auth-live.test.ts.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { SalesController } from '../../src/modules/sales/sales.controller';
import {
  AgeVerificationRequiredException,
  SalesService,
} from '../../src/modules/sales/sales.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { InvalidUuidException } from '../../src/common/uuid';
import { UuidValidationInterceptor } from '../../src/common/uuid-validation.interceptor';
import { guardContext, makeApiKey, makeGuard } from './helpers';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant, role: 'manager' | 'owner' | 'cashier' = 'manager'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

/** Direct-construction request: the guard would have set req.actor. */
function reqFor(actor: Actor): { actor: Actor } {
  return { actor };
}

function makeController(db: Kysely<DB>): { controller: SalesController; catalogue: CatalogueService } {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  return { controller: new SalesController(sales), catalogue };
}

async function restrictedOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  catalogue: CatalogueService,
  controller: SalesController,
  sku = 'C25-001',
): Promise<{ orderId: string; variantId: string }> {
  const variant = await seedVariant(db, tenant, {
    sku,
    barcode: sku === 'C25-001' ? '5012345678903' : undefined,
    name: 'Challenge 25 Vape Liquid',
    pricePence: 800n,
  });
  await setStock(db, tenant, variant.variantId, { quantity: 5n });
  await catalogue.createAgeRestriction(actorFor(tenant, 'owner'), {
    variantId: variant.variantId,
  });
  const created = await controller.createOrder(reqFor(actorFor(tenant)), {
    locationId: tenant.locationId,
    lines: [{ variantId: variant.variantId, quantity: '1' }],
  });
  return { orderId: created.id, variantId: variant.variantId };
}

function wireVerification(variantId: string, userId: string) {
  return {
    variant_id: variantId,
    verified_age_threshold: 25,
    verified_by_user_id: userId,
    verified_at: new Date().toISOString(),
  };
}

describe('SalesController — completeOrder / addTender with age_verifications', () => {
  it('complete without verifications → 422 AGE_VERIFICATION_REQUIRED; with → 200 + GET lists the event', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { controller, catalogue } = makeController(db);
      const { orderId, variantId } = await restrictedOrder(db, tenant, catalogue, controller);
      await controller.addTender(reqFor(actorFor(tenant)), orderId, {
        tenderType: 'cash',
        amountPence: '800',
        age_verifications: [wireVerification(variantId, tenant.users.cashier.id)],
      });
      const completed = await controller.completeOrder(reqFor(actorFor(tenant)), orderId, {});
      expect(completed.order.status).toBe('completed');
      const listed = await controller.listAgeVerifications(reqFor(actorFor(tenant)), orderId);
      expect(listed.orderId).toBe(orderId);
      expect(listed.verifications).toHaveLength(1);
      expect(listed.verifications[0]?.verified_age_threshold).toBe(25);
      expect(JSON.stringify(listed).toLowerCase()).not.toContain('dob');
    } finally {
      await close();
    }
  });

  it('complete without verifications (rule added after tender) → 422; addTender without → 422', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { controller, catalogue } = makeController(db);
      // Tender while unrestricted, then attach the rule, then complete.
      const variant = await seedVariant(db, tenant, { sku: 'C25-001', pricePence: 800n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const created = await controller.createOrder(reqFor(actorFor(tenant)), {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: '1' }],
      });
      await controller.addTender(reqFor(actorFor(tenant)), created.id, {
        tenderType: 'cash',
        amountPence: '800',
      });
      await catalogue.createAgeRestriction(actorFor(tenant, 'owner'), {
        variantId: variant.variantId,
      });
      let caught: unknown = null;
      try {
        await controller.completeOrder(reqFor(actorFor(tenant)), created.id, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AgeVerificationRequiredException);
      expect((caught as HttpException).getStatus()).toBe(422);
      const body = (caught as HttpException).getResponse() as {
        error: { code: string; variantIds: string[] };
      };
      expect(body.error.code).toBe('AGE_VERIFICATION_REQUIRED');
      expect(body.error.variantIds).toContain(variant.variantId);

      // Tender path: a fresh restricted order without verifications.
      const { orderId, variantId } = await restrictedOrder(
        db,
        tenant,
        catalogue,
        controller,
        'C25-002',
      );
      let tenderCaught: unknown = null;
      try {
        await controller.addTender(reqFor(actorFor(tenant)), orderId, {
          tenderType: 'cash',
          amountPence: '800',
        });
      } catch (error) {
        tenderCaught = error;
      }
      expect(tenderCaught).toBeInstanceOf(AgeVerificationRequiredException);
      expect((tenderCaught as HttpException).getStatus()).toBe(422);
      expect(variantId).toBeDefined();
    } finally {
      await close();
    }
  });

  it('a dob field anywhere in the body → 400, never silently dropped', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { controller, catalogue } = makeController(db);
      const { orderId, variantId } = await restrictedOrder(db, tenant, catalogue, controller);
      const bad = {
        ...wireVerification(variantId, tenant.users.cashier.id),
        date_of_birth: '2000-01-01',
      };
      await expect(
        controller.addTender(reqFor(actorFor(tenant)), orderId, {
          tenderType: 'cash',
          amountPence: '800',
          age_verifications: [bad],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.completeOrder(reqFor(actorFor(tenant)), orderId, {
          dob: '2000-01-01',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await close();
    }
  });

  it('GET age-verifications: cross-tenant → 404, unknown order → 404', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { controller, catalogue } = makeController(db);
      const { orderId } = await restrictedOrder(db, tenant, catalogue, controller);
      await expect(
        controller.listAgeVerifications(reqFor(actorFor(other)), orderId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.listAgeVerifications(reqFor(actorFor(tenant)), randomUUID()),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('UuidValidationInterceptor — malformed :id on the GET route', () => {
  function mockContext(params: Record<string, unknown>): ExecutionContext {
    const request = {
      params,
      body: undefined,
      method: 'GET',
      path: '/v1/sales/orders/not-a-uuid/age-verifications',
    };
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

  it('malformed id → 400 INVALID_UUID naming the field; a well-formed UUID passes through', () => {
    const interceptor = new UuidValidationInterceptor();
    let caught: unknown;
    try {
      interceptor.intercept(mockContext({ id: 'not-a-uuid' }), NEXT);
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

describe('SalesController — AuthGuard scope checks (Build-10, Objective 1)', () => {
  it('unauthenticated → 401, wrong scope → 403, write/read/admin keys + manager/cashier PIN sessions pass per scope', async () => {
    const { db, close } = await createTestDb();
    try {
        const tenant = await seedTenant(db);
        const guard = makeGuard(db);
        const writes = [
          SalesController.prototype.createOrder,
          SalesController.prototype.addTender,
          SalesController.prototype.completeOrder,
          SalesController.prototype.voidOrder,
          SalesController.prototype.returnOrder,
          SalesController.prototype.retryRefund,
          SalesController.prototype.completeManualRefund,
          SalesController.prototype.recordCardAttemptOutcome,
        ];
        const reads = [
          SalesController.prototype.getReceipt,
          SalesController.prototype.listAgeVerifications,
        ];
        const all = [...writes, ...reads];
        for (const handler of all) {
          await expect(guard.canActivate(guardContext(handler, {}))).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
        }
        // A read-only key is 403 on every write and passes every read.
        const readKey = await makeApiKey(db, tenant.tenantId, ['sales:read']);
        for (const handler of writes) {
          await expect(
            guard.canActivate(guardContext(handler, { authorization: `Bearer ${readKey}` })),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }
        for (const handler of reads) {
          expect(
            await guard.canActivate(guardContext(handler, { authorization: `Bearer ${readKey}` })),
          ).toBe(true);
        }
        // A write-only key passes the writes (a scope grants exactly
        // itself — sales:write does NOT imply sales:read).
        const writeKey = await makeApiKey(db, tenant.tenantId, ['sales:write']);
        for (const handler of writes) {
          expect(
            await guard.canActivate(
              guardContext(handler, { authorization: `Bearer ${writeKey}` }),
            ),
          ).toBe(true);
        }
        for (const handler of reads) {
          await expect(
            guard.canActivate(guardContext(handler, { authorization: `Bearer ${writeKey}` })),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }
        // An admin-scope key implies every scope (scopes.ts).
        const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
        for (const handler of all) {
          expect(
            await guard.canActivate(
              guardContext(handler, { authorization: `Bearer ${adminKey}` }),
            ),
          ).toBe(true);
        }
        // PIN sessions: a manager carries sales:write + sales:read; a
        // cashier carries both too (scopesForRoles: cashiers hold the
        // till read scopes plus sales write).
        const sessions = new SessionService(db);
        const manager = await sessions.login({
          tenantId: tenant.tenantId,
          userId: tenant.users.manager.id,
          pin: '1234',
        });
        for (const handler of all) {
          expect(
            await guard.canActivate(
              guardContext(handler, { authorization: `Bearer ${manager.token}` }),
            ),
          ).toBe(true);
        }
        const cashier = await sessions.login({
          tenantId: tenant.tenantId,
          userId: tenant.users.cashier.id,
          pin: '1234',
        });
        for (const handler of all) {
          expect(
            await guard.canActivate(
              guardContext(handler, { authorization: `Bearer ${cashier.token}` }),
            ),
          ).toBe(true);
        }
    } finally {
      await close();
    }
  });

  it('cross-tenant credential → 404, never 403 (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const guard = makeGuard(db);
      const keyB = await makeApiKey(db, tenantB.tenantId, ['sales:read']);
      await expect(
        guard.canActivate(
          guardContext(SalesController.prototype.listAgeVerifications, {
            authorization: `Bearer ${keyB}`,
            'x-tenant-id': tenantA.tenantId,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});
