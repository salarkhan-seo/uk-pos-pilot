/**
 * Build-06 Objective 2 — global UUID validation.
 *
 * Two layers, both proving the same guarantee:
 *
 *  PART A — interceptor unit tests. The UuidValidationInterceptor is
 *  driven directly with mock ExecutionContexts shaped like each
 *  controller's real route (params + body), so every controller's
 *  parameter shapes are covered without a database: sales,
 *  inventory, purchasing, crm, api-keys, reporting, catalogue,
 *  admin, payments (no id params — pass-through only), integrations
 *  and sync.
 *
 *  PART B — wiring, error shape, and 404 pass-through. Three things
 *  a full-app HTTP boot would have proven, each proven here at the
 *  layer where it actually lives instead:
 *
 *  (a) Wiring — AppModule's providers metadata carries the
 *      APP_INTERCEPTOR → UuidValidationInterceptor binding, so any
 *      Nest application built from AppModule gets the check.
 *  (b) Error shape — InvalidUuidException (thrown by the interceptor
 *      and by assertUuid) serializes to exactly
 *      { error: { code: "INVALID_UUID", message, field } } with
 *      HTTP 400, matching the codebase's structured-error convention
 *      (RATE_LIMITED, PLAN_GATED).
 *  (c) 404 pass-through — well-formed UUIDs that match nothing still
 *      return 404 at the service layer, proven by calling the real
 *      controllers directly (the same pattern as the other route
 *      tests): sales receipt, inventory count lines, purchasing
 *      send, crm consents, api-keys revoke, reporting z-report.
 *
 *  WHY NO NestFactory HTTP TESTS: a real Nest app cannot boot under
 *  vitest in this repo. Vitest transforms TypeScript with esbuild,
 *  and esbuild does NOT emit decorator metadata — design:paramtypes
 *  is undefined for every controller (verified by probe, 2026-11-14),
 *  so Nest's injector cannot resolve type-injected services and
 *  NestFactory.create(AppModule) throws UndefinedDependencyException
 *  (InventoryController (?, DATABASE)) before any request is served.
 *  The production server (tsc-compiled, emitDecoratorMetadata: true)
 *  boots fine — see the manual boot verification in the Build-06
 *  Objective 2 report — but an HTTP test that boots the app inside
 *  vitest is impossible without changing the shared test transform
 *  (e.g. SWC with decorator metadata), which is outside this
 *  objective's scope. Objective 4's end-to-end HTTP tests must boot
 *  the COMPILED server as a child process for the same reason.
 *
 *  The guarantee under test: any malformed (non-UUID) identifier
 *  returns 400 Bad Request with body error.code "INVALID_UUID"
 *  (never an unhandled 500 database cast error), while a
 *  well-formed UUID that matches nothing still returns 404, and
 *  valid UUIDs pass through to their handler.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { UuidValidationInterceptor } from '../../src/common/uuid-validation.interceptor';
import { assertUuid, InvalidUuidException } from '../../src/common/uuid';
import { actorFor, reqFor, withDb } from './helpers';
import { ApiKeyService } from '../../src/modules/admin/api-key.service';
import { ApiKeysController } from '../../src/modules/admin/api-keys.controller';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { CrmController } from '../../src/modules/admin/crm.controller';
import { CrmService } from '../../src/modules/admin/crm.service';
import { ExitService } from '../../src/modules/admin/exit.service';
import { ExportService } from '../../src/modules/admin/export.service';
import { GdprService } from '../../src/modules/admin/gdpr.service';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { InventoryController } from '../../src/modules/inventory/inventory.controller';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { PurchasingController } from '../../src/modules/inventory/purchasing.controller';
import { PurchasingService } from '../../src/modules/inventory/purchasing.service';
import { ReportingService } from '../../src/modules/reporting/reporting.service';
import { ReportingV1Controller } from '../../src/modules/reporting/reporting.v1.controller';
import { SalesController } from '../../src/modules/sales/sales.controller';
import { SalesService } from '../../src/modules/sales/sales.service';

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED = 'not-a-uuid';

function mockContext(params: Record<string, unknown>, body?: unknown): ExecutionContext {
  const request = { params, body, method: 'GET', path: '/v1/test' };
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

/** Extract the structured error body from a thrown HttpException. */
function errorBody(e: unknown): { code?: string; message?: string; field?: string } {
  expect(e).toBeInstanceOf(HttpException);
  const res = (e as HttpException).getResponse() as { error?: Record<string, string> };
  expect(typeof res).toBe('object');
  return res.error ?? {};
}

describe('UuidValidationInterceptor — unit (mock contexts per controller)', () => {
  const interceptor = new UuidValidationInterceptor();

  it.each([
    ['sales orders/:id/receipt', { id: MALFORMED }],
    ['sales tenders', { id: MALFORMED }],
    ['sales refunds/:id', { id: MALFORMED }],
    ['sales payment-attempts/:id', { id: MALFORMED }],
    ['inventory counts/:id/lines', { id: MALFORMED }],
    ['inventory counts/:id/submit', { id: MALFORMED }],
    ['purchasing purchase-orders/:id/send', { id: MALFORMED }],
    ['purchasing reorder-suggestions/:id/accept', { id: MALFORMED }],
    ['purchasing reorder-suggestions/:id/dismiss', { id: MALFORMED }],
    ['crm customers/:id/consents', { id: MALFORMED }],
    ['crm customers/:id/export', { id: MALFORMED }],
    ['crm customers/:id/erase', { id: MALFORMED }],
    ['api-keys :id/rotate', { id: MALFORMED }],
    ['api-keys :id/revoke', { id: MALFORMED }],
    ['reporting z-reports/:id', { id: MALFORMED }],
    ['reporting vat-periods/:id/close', { id: MALFORMED }],
    ['reporting z-reports/:id/csv', { id: MALFORMED }],
    ['catalogue price-books/:id/entries', { id: MALFORMED }],
    ['catalogue price-books/:id/entries/:variantId (bad id)', { id: MALFORMED, variantId: randomUUID() }],
    ['catalogue price-books/:id/entries/:variantId (bad variantId)', { id: randomUUID(), variantId: MALFORMED }],
    ['catalogue promotions/:id/vouchers/bulk', { id: MALFORMED }],
    ['admin compliance statutory-archives/:tenantId', { tenantId: MALFORMED }],
    ['integrations deliveries/:id/replay', { id: MALFORMED }],
    ['integrations deliveries/:id/discard', { id: MALFORMED }],
    ['integrations subscriptions/:id/rotate-secret', { id: MALFORMED }],
    ['integrations endpoints/:id', { id: MALFORMED }],
  ])('%s — malformed param returns 400 INVALID_UUID', (_label, params) => {
    let caught: unknown;
    try {
      interceptor.intercept(mockContext(params), NEXT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidUuidException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect(errorBody(caught).code).toBe('INVALID_UUID');
  });

  it('malformed params name the offending field', () => {
    let caught: unknown;
    try {
      interceptor.intercept(
        mockContext({ id: randomUUID(), variantId: MALFORMED }),
        NEXT,
      );
    } catch (e) {
      caught = e;
    }
    expect(errorBody(caught)).toMatchObject({ code: 'INVALID_UUID', field: 'variantId' });
  });

  it.each([
    ['pin-login tenantId', { tenantId: MALFORMED, userId: randomUUID(), pin: '1234' }],
    ['pin-login userId', { tenantId: randomUUID(), userId: MALFORMED, pin: '1234' }],
    ['pin-login locationId', { tenantId: randomUUID(), userId: randomUUID(), locationId: MALFORMED, pin: '1234' }],
    ['price-book entry variantId', { variantId: MALFORMED, pricePence: '100' }],
    ['sync handshake registerId', { registerId: MALFORMED }],
    ['sync flush nested orders[].lines[].variantId', {
      registerId: randomUUID(),
      orders: [{
        idempotencyKey: 'offline-1',
        locationId: randomUUID(),
        registerId: randomUUID(),
        tenderTotalPence: '500',
        createdAt: new Date().toISOString(),
        lines: [{ variantId: MALFORMED, quantity: '1', snapshotUnitPricePence: '500', snapshotLineTotalPence: '500' }],
      }],
    }],
    ['sync flush nested orders[].locationId', {
      registerId: randomUUID(),
      orders: [{
        idempotencyKey: 'offline-1',
        locationId: MALFORMED,
        registerId: randomUUID(),
        tenderTotalPence: '500',
        createdAt: new Date().toISOString(),
        lines: [],
      }],
    }],
    ['sales create-order nested lines[].variantId', {
      locationId: randomUUID(),
      lines: [{ variantId: 'bad', quantity: '1' }],
    }],
    ['non-string id value', { variantId: 123 }],
  ])('body field %s — malformed UUID returns 400 INVALID_UUID', (_label, body) => {
    let caught: unknown;
    try {
      interceptor.intercept(mockContext({}, body), NEXT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidUuidException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect(errorBody(caught).code).toBe('INVALID_UUID');
  });

  it('absent, null and optional UUID fields are skipped', () => {
    const cases: unknown[] = [
      {},
      { tenantId: randomUUID(), userId: randomUUID(), locationId: null, pin: '1234' },
      { customerId: undefined, registerId: randomUUID() },
      { orders: [{ idempotencyKey: 'k', locationId: randomUUID(), registerId: randomUUID(), customerId: null, lines: [] }] },
    ];
    for (const body of cases) {
      let result: unknown;
      interceptor.intercept(mockContext({}, body), { handle: () => of('ok') }).subscribe((v) => {
        result = v;
      });
      expect(result).toBe('ok');
    }
  });

  it('non-UUID body fields are untouched', () => {
    let result: unknown;
    interceptor
      .intercept(
        mockContext(
          {},
          { voucherCode: 'NOT-A-UUID', barcode: '1234567890128', idempotencyKey: 'offline-1', amountPence: '500', reason: 'customer changed mind' },
        ),
        { handle: () => of('ok') },
      )
      .subscribe((v) => {
        result = v;
      });
    expect(result).toBe('ok');
  });

  it('valid UUID params and body pass through to the handler', () => {
    let result: unknown;
    interceptor
      .intercept(
        mockContext(
          { id: randomUUID(), variantId: randomUUID() },
          { tenantId: randomUUID(), userId: randomUUID(), locationId: randomUUID() },
        ),
        { handle: () => of('passed-through') },
      )
      .subscribe((v) => {
        result = v;
      });
    expect(result).toBe('passed-through');
  });

  it('requests with no params and no body pass through', () => {
    let result: unknown;
    interceptor
      .intercept(mockContext({}), { handle: () => of('ok') })
      .subscribe((v) => {
        result = v;
      });
    expect(result).toBe('ok');
  });
});

describe('UuidValidationInterceptor — wiring, error shape, and 404 pass-through', () => {
  it('AppModule registers UuidValidationInterceptor as a global APP_INTERCEPTOR', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as
      | Array<{ provide?: unknown; useClass?: unknown }>
      | undefined;
    expect(Array.isArray(providers)).toBe(true);
    const binding = (providers ?? []).find((p) => p.provide === APP_INTERCEPTOR);
    expect(binding).toBeDefined();
    expect(binding?.useClass).toBe(UuidValidationInterceptor);
  });

  it('InvalidUuidException serializes as { error: { code: "INVALID_UUID", message, field } } with HTTP 400', () => {
    const err = new InvalidUuidException('tenantId');
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({
      error: {
        code: 'INVALID_UUID',
        message: 'tenantId must be a valid UUID',
        field: 'tenantId',
      },
    });
  });

  it('assertUuid throws InvalidUuidException (new shape) and passes valid UUIDs', () => {
    expect(() => assertUuid('not-a-uuid', 'tenantId')).toThrow(InvalidUuidException);
    try {
      assertUuid('not-a-uuid', 'variantId');
      expect.unreachable('assertUuid must throw on a malformed id');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(400);
      expect((e as HttpException).getResponse()).toEqual({
        error: {
          code: 'INVALID_UUID',
          message: 'variantId must be a valid UUID',
          field: 'variantId',
        },
      });
    }
    expect(() => assertUuid(randomUUID(), 'tenantId')).not.toThrow();
  });

  describe('well-formed unknown UUIDs still return 404 (pass-through to the handler)', () => {
    it('sales receipt: unknown order → 404', async () => {
      await withDb(async ({ db, tenant }) => {
        const audit = new AuditService(db);
        const approvals = new ApprovalService(db, audit);
        const sales = new SalesService(
          db,
          new CatalogueService(db),
          new InventoryService(db),
          approvals,
          audit,
          new PaymentsService(db, audit, approvals),
        );
        const controller = new SalesController(sales);
        const actor = {
          tenantId: tenant.tenantId,
          userId: tenant.users.owner.id,
          locationId: tenant.locationId,
          roles: ['owner' as const],
        };
        await expect(controller.getReceipt({ actor }, UNKNOWN_UUID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });

    it('inventory count lines: unknown count → 404', async () => {
      await withDb(async ({ db, tenant }) => {
        const controller = new InventoryController(new InventoryService(db), db);
        await expect(
          controller.setCountedQuantity(reqFor(actorFor(tenant, 'owner')), UNKNOWN_UUID, {
            variantId: randomUUID(),
            countedQuantity: 1,
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('purchasing send: unknown purchase order → 404', async () => {
      await withDb(async ({ db, tenant }) => {
        const controller = new PurchasingController(new PurchasingService(db));
        await expect(
          controller.sendPurchaseOrder(reqFor(actorFor(tenant, 'manager')), UNKNOWN_UUID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('crm consents: unknown customer → 404', async () => {
      await withDb(async ({ db, tenant }) => {
        const audit = new AuditService(db);
        const gdpr = new GdprService(
          db,
          audit,
          new ExitService(db, audit),
          new ExportService(db, audit),
        );
        const controller = new CrmController(new CrmService(db), gdpr);
        await expect(
          controller.listConsents(reqFor(actorFor(tenant, 'manager')), UNKNOWN_UUID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('api-keys revoke: unknown key → 404', async () => {
      await withDb(async ({ db, tenant }) => {
        const controller = new ApiKeysController(new ApiKeyService(db));
        await expect(
          controller.revoke(reqFor(actorFor(tenant, 'owner')), UNKNOWN_UUID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('reporting z-report: unknown report → 404', async () => {
      await withDb(async ({ db, tenant }) => {
        const audit = new AuditService(db);
        const reporting = new ReportingService(db, new ApprovalService(db, audit), audit);
        const controller = new ReportingV1Controller(db, reporting);
        await expect(
          controller.getZReport(reqFor(actorFor(tenant, 'manager')), UNKNOWN_UUID),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });
});
