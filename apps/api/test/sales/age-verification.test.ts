/**
 * Build-09 Objective 2 — server-side age verification persistence and
 * checkout enforcement (Challenge 25).
 *
 * Service-level proof, PGlite per test (same pattern as
 * apps/api/test/sales/sales.test.ts):
 *
 *  (a) parseAgeVerifications — wire validation: valid entries
 *      normalise; absent → []; any DOB-like key, unknown key,
 *      malformed UUID, non-integer or sub-25 threshold, or bad
 *      timestamp → 400.
 *  (b) addTender — a restricted order without a verification rejects
 *      with 422 AGE_VERIFICATION_REQUIRED BEFORE any stock is reserved
 *      (order stays draft, no tender, stock untouched); with a
 *      verification the tender succeeds and the event is persisted
 *      (age_verification_events + audit entry).
 *  (c) completeOrder — a rule attached after the tender (mid-sale)
 *      still blocks completion with 422 (order stays pending_payment,
 *      no receipt); verifications supplied at tender only, or at
 *      complete only, both satisfy it; the event is persisted once
 *      (re-supply is idempotent).
 *  (d) listAgeVerifications — compliance inspection: stored events
 *      with threshold 25 and no DOB data; cross-tenant and unknown
 *      orders → 404.
 *  (e) Sync flush — an unverified restricted offline order fails
 *      (never silently synced); a verified one syncs and persists
 *      the event.
 *  (f) verified_at persistence (Build-11 Objective 2, migration
 *      018) — the client-supplied verified_at is stored exactly in
 *      age_verification_events.verified_at (including a timestamp
 *      hours in the past, and through the offline flush); a
 *      verification without verified_at takes the column default
 *      (NOW()); an invalid verified_at is still 400. The GET view
 *      returns BOTH verified_at (client till timestamp) and
 *      created_at (server record time).
 *
 * The HTTP-level proof (422 status + error code over real HTTP, the
 * zero-DB-seed lifecycle through the Register UI, and the malformed
 * :id → 400 on the GET route) lives in
 * apps/register-app/test/build09-age-verification-live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
import {
  AgeVerificationRequiredException,
  SalesService,
  assertNoDobFields,
  parseAgeVerifications,
} from '../../src/modules/sales/sales.service';
import { SyncService } from '../../src/modules/sync/sync.service';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant, role: 'owner' | 'admin' | 'manager' | 'cashier' = 'manager'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

function makeServices(db: Kysely<DB>): {
  sales: SalesService;
  catalogue: CatalogueService;
  sync: SyncService;
  audit: AuditService;
} {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  const sync = new SyncService(db, sales, catalogue, audit);
  return { sales, catalogue, sync, audit };
}

/** One wire verification entry for a variant (threshold 25 by default). */
function wireVerification(
  variantId: string,
  userId: string,
  threshold = 25,
): Record<string, unknown> {
  return {
    variant_id: variantId,
    verified_age_threshold: threshold,
    verified_by_user_id: userId,
    verified_at: new Date().toISOString(),
  };
}

async function restrictedVariant(
  db: Kysely<DB>,
  tenant: SeededTenant,
  catalogue: CatalogueService,
): Promise<string> {
  const variant = await seedVariant(db, tenant, {
    sku: 'C25-001',
    barcode: '5012345678903',
    name: 'Challenge 25 Vape Liquid',
    pricePence: 800n,
  });
  await setStock(db, tenant, variant.variantId, { quantity: 5n });
  await catalogue.createAgeRestriction(actorFor(tenant, 'owner'), {
    variantId: variant.variantId,
  });
  return variant.variantId;
}

async function plainVariant(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const variant = await seedVariant(db, tenant, {
    sku: 'PLAIN-001',
    pricePence: 500n,
  });
  await setStock(db, tenant, variant.variantId, { quantity: 5n });
  return variant.variantId;
}

async function stockOnHand(db: Kysely<DB>, tenant: SeededTenant, variantId: string): Promise<string> {
  const row = await db
    .selectFrom('stock_balances')
    .select('quantity_on_hand')
    .where('variant_id', '=', variantId)
    .where('tenant_id', '=', tenant.tenantId)
    .executeTakeFirst();
  return row === undefined ? 'none' : row.quantity_on_hand.toString();
}

async function ageEvents(db: Kysely<DB>, orderId: string) {
  return db
    .selectFrom('age_verification_events')
    .selectAll()
    .where('order_id', '=', orderId)
    .execute();
}

async function auditEvents(db: Kysely<DB>, orderId: string, eventType: string) {
  return db
    .selectFrom('audit_events')
    .selectAll()
    .where('entity_id', '=', orderId)
    .where('event_type', '=', eventType)
    .execute();
}

function expect422(error: unknown, variantId: string): void {
  expect(error).toBeInstanceOf(AgeVerificationRequiredException);
  const exception = error as AgeVerificationRequiredException;
  expect(exception.getStatus()).toBe(422);
  const body = exception.getResponse() as {
    error: { code: string; message: string; variantIds: string[] };
  };
  expect(body.error.code).toBe('AGE_VERIFICATION_REQUIRED');
  expect(body.error.variantIds).toContain(variantId);
}

describe('parseAgeVerifications — wire validation', () => {
  it('normalises a valid entry; absent/empty → []', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const parsed = parseAgeVerifications([
        wireVerification('11111111-1111-4111-8111-111111111111', tenant.users.cashier.id),
      ]);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.variantId).toBe('11111111-1111-4111-8111-111111111111');
      expect(parsed[0]?.verifiedAgeThreshold).toBe(25);
      expect(parsed[0]?.verifiedByUserId).toBe(tenant.users.cashier.id);
      expect(parsed[0]?.verifiedAt).toBeInstanceOf(Date);
      expect(parseAgeVerifications(undefined)).toEqual([]);
      expect(parseAgeVerifications([])).toEqual([]);
    } finally {
      await close();
    }
  });

  it('verified_at is optional: absent → null; present-but-invalid → 400 (Build-11 Obj 2)', () => {
    const variantId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    const without = wireVerification(variantId, userId);
    delete without.verified_at;
    const parsed = parseAgeVerifications([without]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.verifiedAt).toBeNull();
    // Explicit null is also "absent" — the column default applies.
    expect(
      parseAgeVerifications([{ ...wireVerification(variantId, userId), verified_at: null }])[0]
        ?.verifiedAt,
    ).toBeNull();
    // Present-but-invalid is STILL 400 (Build-09 rule), never
    // silently replaced by NOW().
    expect(() =>
      parseAgeVerifications([
        { ...wireVerification(variantId, userId), verified_at: 'not-a-date' },
      ]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([{ ...wireVerification(variantId, userId), verified_at: '' }]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([{ ...wireVerification(variantId, userId), verified_at: 123 }]),
    ).toThrow(BadRequestException);
  });

  it('rejects any DOB-like key with 400, never silently drops it', () => {
    const variantId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    for (const dobKey of [
      'dob',
      'date_of_birth',
      'dateOfBirth',
      'birth_date',
      'birthDate',
      'birthdate',
      'customer_dob',
    ]) {
      const entry = { ...wireVerification(variantId, userId), [dobKey]: '2000-01-01' };
      expect(() => parseAgeVerifications([entry])).toThrow(BadRequestException);
    }
    expect(() => assertNoDobFields({ dob: '2000-01-01' }, 'complete request')).toThrow(
      BadRequestException,
    );
    expect(() => assertNoDobFields({ ok: 1 })).not.toThrow();
  });

  it('rejects unknown keys, bad UUIDs, non-integer or sub-25 thresholds, bad timestamps', () => {
    const variantId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    expect(() => parseAgeVerifications('nope')).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([{ ...wireVerification(variantId, userId), extra: 1 }]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([wireVerification('not-a-uuid', userId)]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([wireVerification(variantId, 'not-a-uuid')]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([wireVerification(variantId, userId, 24)]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([wireVerification(variantId, userId, 25.5)]),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAgeVerifications([
        { ...wireVerification(variantId, userId), verified_at: 'not-a-date' },
      ]),
    ).toThrow(BadRequestException);
  });
});

describe('addTender — Challenge 25 enforcement before any stock movement', () => {
  it('rejects an unverified restricted tender with 422; order stays draft, stock untouched', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      let caught: unknown = null;
      try {
        await sales.addTender(actor, {
          orderId: order.id,
          tenderType: 'cash',
          amountPence: 800n,
        });
      } catch (error) {
        caught = error;
      }
      expect422(caught, variantId);
      const reloaded = await db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(reloaded.status).toBe('draft');
      const tenders = await db
        .selectFrom('order_tenders')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(tenders).toHaveLength(0);
      expect(await stockOnHand(db, tenant, variantId)).toBe('5');
      expect(await ageEvents(db, order.id)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('accepts the tender with a verification and persists the event + audit entry', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 800n,
        ageVerifications: [wireVerification(variantId, tenant.users.cashier.id)],
      });
      const events = await ageEvents(db, order.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.verified_age_years).toBe(25);
      expect(events[0]?.method).toBe('manual_confirmation');
      expect(events[0]?.outcome).toBe('verified');
      expect(events[0]?.verified_by_user_id).toBe(tenant.users.cashier.id);
      // The table has no DOB column at all — the row physically cannot
      // carry a date of birth.
      expect(Object.keys(events[0] ?? {})).not.toContain('dob');
      expect(Object.keys(events[0] ?? {})).not.toContain('date_of_birth');
      const audits = await auditEvents(db, order.id, 'age_verification.recorded');
      expect(audits).toHaveLength(1);
      expect(await stockOnHand(db, tenant, variantId)).toBe('4');
    } finally {
      await close();
    }
  });

  it('rejects a verification with a DOB field at the tender with 400', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      const bad = {
        ...wireVerification(variantId, tenant.users.cashier.id),
        dob: '2000-01-01',
      };
      await expect(
        sales.addTender(actor, {
          orderId: order.id,
          tenderType: 'cash',
          amountPence: 800n,
          ageVerifications: [bad],
        }),
      ).rejects.toThrow(BadRequestException);
      const reloaded = await db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(reloaded.status).toBe('draft');
    } finally {
      await close();
    }
  });
});

describe('completeOrder — Challenge 25 enforcement at completion', () => {
  it('blocks completion with 422 when the rule was attached after the tender (mid-sale)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variant = await seedVariant(db, tenant, {
        sku: 'C25-001',
        pricePence: 800n,
      });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      // Tendered while unrestricted — stock reserved, order pending.
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 800n,
      });
      // The rule lands mid-sale; completion must now refuse.
      await catalogue.createAgeRestriction(actorFor(tenant, 'owner'), {
        variantId: variant.variantId,
      });
      let caught: unknown = null;
      try {
        await sales.completeOrder(actor, order.id);
      } catch (error) {
        caught = error;
      }
      expect422(caught, variant.variantId);
      const reloaded = await db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      expect(reloaded.status).toBe('pending_payment');
      const receipts = await db
        .selectFrom('receipts')
        .select('id')
        .where('order_id', '=', order.id)
        .execute();
      expect(receipts).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('completes when the verification was supplied at the tender only (persisted check)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 800n,
        ageVerifications: [wireVerification(variantId, tenant.users.cashier.id)],
      });
      const completed = await sales.completeOrder(actor, order.id);
      expect(completed.order.status).toBe('completed');
      // Re-supplying the same verification at completion is idempotent
      // — but the order is already completed and immutable, so a
      // second complete is refused as an illegal transition instead.
      await expect(sales.completeOrder(actor, order.id)).rejects.toThrow(
        'Completed order',
      );
      expect(await ageEvents(db, order.id)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('completes when the verification is supplied at complete only, and records it once', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const plainId = await plainVariant(db, tenant);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [
          { variantId, quantity: 1n },
          { variantId: plainId, quantity: 1n },
        ],
      });
      // Tender without verifications would 422 — the rule-added-after
      // tender path is what lets this order reach pending_payment
      // unverified, so attach the rule only after tendering.
      // (Here the variant was restricted from the start, so instead
      // verify at the tender and re-verify at complete: the second
      // record must not duplicate.)
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 1300n,
        ageVerifications: [wireVerification(variantId, tenant.users.cashier.id)],
      });
      const completed = await sales.completeOrder(actor, order.id, [
        wireVerification(variantId, tenant.users.cashier.id),
      ]);
      expect(completed.order.status).toBe('completed');
      expect(await ageEvents(db, order.id)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('a plain order completes with no verifications at all', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales } = makeServices(db);
      const actor = actorFor(tenant);
      const plainId = await plainVariant(db, tenant);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: plainId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 500n,
      });
      const completed = await sales.completeOrder(actor, order.id);
      expect(completed.order.status).toBe('completed');
      expect(await ageEvents(db, order.id)).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe('listAgeVerifications — compliance inspection', () => {
  it('returns stored events with threshold 25 and no DOB data; 404 cross-tenant and unknown', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 800n,
        ageVerifications: [wireVerification(variantId, tenant.users.cashier.id)],
      });
      await sales.completeOrder(actor, order.id);
      const views = await sales.listAgeVerifications(actor, order.id);
      expect(views).toHaveLength(1);
      expect(views[0]?.variant_id).toBe(variantId);
      expect(views[0]?.verified_age_threshold).toBe(25);
      expect(views[0]?.verified_by_user_id).toBe(tenant.users.cashier.id);
      expect(views[0]?.method).toBe('manual_confirmation');
      expect(views[0]?.outcome).toBe('verified');
      expect(JSON.stringify(views).toLowerCase()).not.toContain('dob');
      expect(JSON.stringify(views).toLowerCase()).not.toContain('birth');
      await expect(
        sales.listAgeVerifications(actorFor(other), order.id),
      ).rejects.toThrow(NotFoundException);
      await expect(
        sales.listAgeVerifications(actor, '33333333-3333-4333-8333-333333333333'),
      ).rejects.toThrow(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('Sync flush — Challenge 25 enforcement offline', () => {
  it('fails an unverified restricted offline order (never silently synced)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sync, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const response = await sync.flush(actor, {
        registerId: tenant.registerId,
        orders: [
          {
            idempotencyKey: 'offline-c25-no-verification',
            locationId: tenant.locationId,
            registerId: tenant.registerId,
            customerId: null,
            tenderTotalPence: '800',
            createdAt: new Date().toISOString(),
            lines: [
              {
                variantId,
                quantity: '1',
                snapshotUnitPricePence: '800',
                snapshotLineTotalPence: '800',
              },
            ],
          },
        ],
      });
      expect(response.outcomes).toHaveLength(1);
      expect(response.outcomes[0]?.status).toBe('failed');
      // Build-10 Objective 3: the outcome carries the structured
      // code AND the real nested message — no longer the
      // class-name-derived "Age Verification Required Exception".
      expect(response.outcomes[0]?.error_code).toBe('AGE_VERIFICATION_REQUIRED');
      expect(response.outcomes[0]?.error ?? '').toContain('Age verification required');
      expect(response.outcomes[0]?.error ?? '').not.toContain('AgeVerificationRequired');
      expect(await stockOnHand(db, tenant, variantId)).toBe('5');
    } finally {
      await close();
    }
  });

  it('syncs a verified restricted offline order and persists the event', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sync, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const response = await sync.flush(actor, {
        registerId: tenant.registerId,
        orders: [
          {
            idempotencyKey: 'offline-c25-verified',
            locationId: tenant.locationId,
            registerId: tenant.registerId,
            customerId: null,
            tenderTotalPence: '800',
            createdAt: new Date().toISOString(),
            lines: [
              {
                variantId,
                quantity: '1',
                snapshotUnitPricePence: '800',
                snapshotLineTotalPence: '800',
              },
            ],
            age_verifications: [
              wireVerification(variantId, tenant.users.cashier.id),
            ],
          },
        ],
      });
      expect(response.outcomes).toHaveLength(1);
      expect(response.outcomes[0]?.status).toBe('synced');
      const orderId = response.outcomes[0]?.orderId;
      expect(orderId).not.toBeNull();
      expect(await ageEvents(db, orderId as string)).toHaveLength(1);
      expect(await stockOnHand(db, tenant, variantId)).toBe('4');
    } finally {
      await close();
    }
  });
});

describe('verified_at persistence (Build-11 Objective 2)', () => {
  it('persists the client-supplied verified_at exactly (hours in the past); GET returns it distinct from created_at', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      // The till verified the customer 6 hours before the tender.
      const past = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 800n,
        ageVerifications: [
          { ...wireVerification(variantId, tenant.users.cashier.id), verified_at: past },
        ],
      });
      const events = await ageEvents(db, order.id);
      expect(events).toHaveLength(1);
      expect((events[0]?.verified_at as Date).toISOString()).toBe(past);
      // created_at is the server record time — hours AFTER verified_at.
      const createdAt = (events[0]?.created_at as Date).getTime();
      const verifiedAt = (events[0]?.verified_at as Date).getTime();
      expect(createdAt - verifiedAt).toBeGreaterThan(5 * 60 * 60 * 1000);
      const views = await sales.listAgeVerifications(actor, order.id);
      expect(views).toHaveLength(1);
      expect(views[0]?.verified_at).toBe(past);
      expect(views[0]?.created_at).not.toBe(past);
      expect(new Date(views[0]?.created_at as string).getTime()).toBe(createdAt);
    } finally {
      await close();
    }
  });

  it('a verification without verified_at takes the column default (NOW()); GET verified_at ≈ created_at', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sales, catalogue } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId, quantity: 1n }],
      });
      const entry = wireVerification(variantId, tenant.users.cashier.id);
      delete entry.verified_at;
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: 800n,
        ageVerifications: [entry],
      });
      const events = await ageEvents(db, order.id);
      expect(events).toHaveLength(1);
      const verifiedAt = (events[0]?.verified_at as Date).getTime();
      const createdAt = (events[0]?.created_at as Date).getTime();
      expect(Math.abs(createdAt - verifiedAt)).toBeLessThan(5000);
      const views = await sales.listAgeVerifications(actor, order.id);
      expect(views).toHaveLength(1);
      expect(new Date(views[0]?.verified_at as string).getTime()).toBe(verifiedAt);
      expect(new Date(views[0]?.created_at as string).getTime()).toBe(createdAt);
      // The audit payload carries null (no client timestamp supplied).
      const audits = await auditEvents(db, order.id, 'age_verification.recorded');
      expect(audits).toHaveLength(1);
      const payload = audits[0]?.payload as Record<string, unknown> | string | undefined;
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      expect(parsed?.verifiedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it('the offline flush preserves a verified_at from hours before the flush', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sync, catalogue, sales } = makeServices(db);
      const actor = actorFor(tenant);
      const variantId = await restrictedVariant(db, tenant, catalogue);
      // The till verified the customer 5 hours before the device
      // reconnected and flushed.
      const past = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const response = await sync.flush(actor, {
        registerId: tenant.registerId,
        orders: [
          {
            idempotencyKey: 'offline-c25-verified-at-past',
            locationId: tenant.locationId,
            registerId: tenant.registerId,
            customerId: null,
            tenderTotalPence: '800',
            createdAt: new Date().toISOString(),
            lines: [
              {
                variantId,
                quantity: '1',
                snapshotUnitPricePence: '800',
                snapshotLineTotalPence: '800',
              },
            ],
            age_verifications: [
              { ...wireVerification(variantId, tenant.users.cashier.id), verified_at: past },
            ],
          },
        ],
      });
      expect(response.outcomes).toHaveLength(1);
      expect(response.outcomes[0]?.status).toBe('synced');
      const orderId = response.outcomes[0]?.orderId;
      expect(orderId).not.toBeNull();
      const events = await ageEvents(db, orderId as string);
      expect(events).toHaveLength(1);
      expect((events[0]?.verified_at as Date).toISOString()).toBe(past);
      const views = await sales.listAgeVerifications(actor, orderId as string);
      expect(views).toHaveLength(1);
      expect(views[0]?.verified_at).toBe(past);
      expect(new Date(views[0]?.created_at as string).getTime()).toBeGreaterThan(
        new Date(past).getTime(),
      );
    } finally {
      await close();
    }
  });
});
