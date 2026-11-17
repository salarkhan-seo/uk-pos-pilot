/**
 * Reporting service tests (Build-03, Objective 3).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant. PGlite runs on a single connection, so no Promise.all
 * concurrency anywhere in this file.
 *
 * Worked-day figures (hand-computed, see the 'worked day' test):
 *  - std variant £12.00, 10% promotion -> line £10.80 (VAT £1.80, net £9.00)
 *  - reduced variant £10.50 -> VAT £0.50, net £10.00
 *  - zero variant £5.00 x 2 -> £10.00, VAT £0
 *  Order A (all three): subtotal £32.50, discount £1.20, total £31.30,
 *  VAT £2.30; tenders cash £15.00 + card £16.30 (approved).
 *  Order B (std x 1, £12.00): voided before tender.
 *  Order C (std x 1, £12.00): cash £12.00, VAT £2.00, net £10.00.
 *  Float £100.00; cash_in £20.00, cash_out £5.00, petty_in £3.00,
 *  petty_out £2.00; cash refund £4.00 (on Order A).
 *  Expected cash = 10000 + 2700 - 400 - 500 + 2000 - 200 + 300 = 13900p.
 *  Z-report: gross 4330, discount 120, VAT 430, net 3900, orders 2,
 *  voids 1 (£12.00), refunds 400 (count 1), card fee estimate 33p
 *  (round(1630 * 14 / 1000) + 10 = 23 + 10).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { businessDate } from '@uk-pos/shared-kernel';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { SalesService } from '../../src/modules/sales/sales.service';
import {
  PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE,
  ReportingService,
  VAT_PERIOD_CSV_COLUMNS,
  Z_REPORT_CSV_COLUMNS,
  cardFeeEstimatePence,
  settlementDateFor,
} from '../../src/modules/reporting/reporting.service';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant, role: 'owner' | 'admin' | 'manager' | 'cashier'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

interface Services {
  sales: SalesService;
  reporting: ReportingService;
  approvals: ApprovalService;
  audit: AuditService;
}

function makeServices(db: Kysely<DB>): Services {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit);
  const reporting = new ReportingService(db, approvals, audit);
  return { sales, reporting, approvals, audit };
}

/** Direct approval_events insert for actions with no ApprovalAction (zero float, carry-forward, corrections). */
async function insertManagerApproval(
  db: Kysely<DB>,
  tenant: SeededTenant,
  action: string,
  amountPence: bigint | null = null,
): Promise<string> {
  const row = await db
    .insertInto('approval_events')
    .values({
      tenant_id: tenant.tenantId,
      order_id: null,
      action,
      amount_pence: amountPence,
      reason: `test approval for ${action}`,
      requested_by_user_id: tenant.users.cashier.id,
      approved_by_user_id: tenant.users.manager.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedPercentagePromotion(
  db: Kysely<DB>,
  tenant: SeededTenant,
  variantId: string,
  percent: number,
): Promise<string> {
  const promo = await db
    .insertInto('promotions')
    .values({
      tenant_id: tenant.tenantId,
      name: `${percent}% off`,
      type: 'percentage',
      status: 'active',
      version: 1,
      stack_group: null,
      start_at: new Date(Date.now() - 3600_000),
      end_at: null,
      created_by_user_id: tenant.users.owner.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('promotion_conditions')
    .values({ promotion_id: promo.id, condition_type: 'percent', condition_value: { percent } })
    .execute();
  await db
    .insertInto('promotion_targets')
    .values({ promotion_id: promo.id, target_type: 'variant', target_id: variantId })
    .execute();
  return promo.id;
}

/** The worked day: orders A (split cash+card, promoted), B (voided), C (cash).
 * NOTE: the 10% promotion targets ONLY the stdPromo variant. Orders B and
 * C use a separate, unpromoted standard variant at the same £12.00 price,
 * so their totals stay £12.00 (a promotion on the shared variant would
 * discount them too — that is what the pricing pipeline does, and the
 * first version of this helper got it wrong). */
async function buildWorkedDay(db: Kysely<DB>, tenant: SeededTenant, services: Services) {
  const manager = actorFor(tenant, 'manager');
  const stdPromo = await seedVariant(db, tenant, { pricePence: 1200n, taxRateId: tenant.taxRates.standard });
  const stdPlain = await seedVariant(db, tenant, { pricePence: 1200n, taxRateId: tenant.taxRates.standard });
  const reduced = await seedVariant(db, tenant, { pricePence: 1050n, taxRateId: tenant.taxRates.reduced });
  const zero = await seedVariant(db, tenant, { pricePence: 500n, taxRateId: tenant.taxRates.zero });
  for (const v of [stdPromo, stdPlain, reduced, zero]) {
    await setStock(db, tenant, v.variantId, { quantity: 10n });
  }
  await seedPercentagePromotion(db, tenant, stdPromo.variantId, 10);

  const { order: orderA } = await services.sales.createOrder(manager, {
    locationId: tenant.locationId,
    registerId: tenant.registerId,
    lines: [
      { variantId: stdPromo.variantId, quantity: 1n },
      { variantId: reduced.variantId, quantity: 1n },
      { variantId: zero.variantId, quantity: 2n },
    ],
  });
  await services.sales.addTender(manager, { orderId: orderA.id, tenderType: 'cash', amountPence: 1500n });
  const cardTender = await services.sales.addTender(manager, { orderId: orderA.id, tenderType: 'card', amountPence: 1630n });
  await services.sales.recordCardAttemptOutcome(manager, {
    paymentAttemptId: cardTender.payment_attempt_id as string,
    outcome: 'approved',
    providerReference: 'pi_test_worked_day',
  });
  await services.sales.completeOrder(manager, orderA.id);

  const { order: orderB } = await services.sales.createOrder(manager, {
    locationId: tenant.locationId,
    registerId: tenant.registerId,
    lines: [{ variantId: stdPlain.variantId, quantity: 1n }],
  });
  await services.sales.voidOrder(manager, orderB.id, 'Customer changed mind');

  const { order: orderC } = await services.sales.createOrder(manager, {
    locationId: tenant.locationId,
    registerId: tenant.registerId,
    lines: [{ variantId: stdPlain.variantId, quantity: 1n }],
  });
  await services.sales.addTender(manager, { orderId: orderC.id, tenderType: 'cash', amountPence: 1200n });
  await services.sales.completeOrder(manager, orderC.id);

  // Cash refund of £4.00 on Order A (no payment attempt => cash refund).
  await db
    .insertInto('refunds')
    .values({
      tenant_id: tenant.tenantId,
      order_id: orderA.id,
      payment_attempt_id: null,
      idempotency_key: randomUUID(),
      amount_pence: 400n,
      reason: 'Cash refund',
      status: 'completed',
      provider_reference: null,
      created_by_user_id: manager.userId,
    })
    .execute();
  return { orderA, orderB, orderC };
}

async function openAndEndWorkedDay(
  db: Kysely<DB>,
  tenant: SeededTenant,
  services: Services,
  floatPence = 10000n,
) {
  const manager = actorFor(tenant, 'manager');
  const { session } = await services.reporting.openSession(manager, {
    registerId: tenant.registerId,
    openingFloatPence: floatPence,
  });
  await buildWorkedDay(db, tenant, services);
  await services.reporting.recordCashMovement(manager, {
    sessionId: session.id, type: 'cash_in', amountPence: 2000n, note: 'Float top-up',
  });
  await services.reporting.recordCashMovement(manager, {
    sessionId: session.id, type: 'cash_out', amountPence: 500n, note: 'Safe drop',
  });
  await services.reporting.recordCashMovement(manager, {
    sessionId: session.id, type: 'petty_cash_in', amountPence: 300n, note: 'Petty cash returned',
  });
  await services.reporting.recordCashMovement(manager, {
    sessionId: session.id, type: 'petty_cash_out', amountPence: 200n, note: 'Cleaning supplies',
  });
  const ended = await services.reporting.endSession(manager, session.id);
  return { session: ended };
}

describe('ReportingService — sessions', () => {
  it('opens a session with a float; a second open on the same register is rejected', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session, warning } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      expect(session.status).toBe('open');
      expect(session.float_pence).toBe(10000n);
      expect(warning).toBeNull();
      await expect(
        services.reporting.openSession(manager, {
          registerId: tenant.registerId,
          openingFloatPence: 5000n,
        }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('zero float without approval is rejected; with a manager approval it opens with a warning', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      await expect(
        services.reporting.openSession(manager, {
          registerId: tenant.registerId,
          openingFloatPence: 0n,
        }),
      ).rejects.toThrow(BadRequestException);
      const approvalId = await insertManagerApproval(db, tenant, 'session_open_zero_float');
      const { session, warning } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 0n,
        approvalEventId: approvalId,
      });
      expect(session.status).toBe('open');
      expect(session.float_pence).toBe(0n);
      expect(warning).toContain('no float');
      // The warning is recorded in the audit log.
      const events = await services.audit.listEvents(tenant.tenantId, { eventType: 'session.opened_zero_float' });
      expect(events.length).toBe(1);
      expect((events[0]?.payload as Record<string, unknown>)['approvalEventId']).toBe(approvalId);
    } finally {
      await close();
    }
  });

  it('a retired register (disabled / lost) cannot open a session', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      for (const status of ['disabled', 'lost'] as const) {
        const register = await db
          .insertInto('registers')
          .values({ tenant_id: tenant.tenantId, location_id: tenant.locationId, name: `TILL-${status}`, status })
          .returning('id')
          .executeTakeFirstOrThrow();
        await expect(
          services.reporting.openSession(manager, {
            registerId: register.id,
            openingFloatPence: 1000n,
          }),
        ).rejects.toThrow(BadRequestException);
      }
    } finally {
      await close();
    }
  });

  it('cash movements: each type records; note is required; amount must be positive', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      for (const type of ['cash_in', 'cash_out', 'petty_cash_in', 'petty_cash_out'] as const) {
        const movement = await services.reporting.recordCashMovement(manager, {
          sessionId: session.id, type, amountPence: 100n, note: `${type} note`,
        });
        expect(movement.type).toBe(type);
        expect(movement.amount_pence).toBe(100n);
      }
      await expect(
        services.reporting.recordCashMovement(manager, {
          sessionId: session.id, type: 'cash_in', amountPence: 100n, note: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        services.reporting.recordCashMovement(manager, {
          sessionId: session.id, type: 'cash_in', amountPence: 0n, note: 'zero',
        }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('petty cash out at exactly the £50 threshold needs no approval; 1p over does, and a manager approval satisfies it', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      expect(PETTY_CASH_OUT_APPROVAL_THRESHOLD_PENCE).toBe(5000n);
      const { session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      const atThreshold = await services.reporting.recordCashMovement(manager, {
        sessionId: session.id, type: 'petty_cash_out', amountPence: 5000n, note: 'Exactly £50',
      });
      expect(atThreshold.amount_pence).toBe(5000n);
      await expect(
        services.reporting.recordCashMovement(manager, {
          sessionId: session.id, type: 'petty_cash_out', amountPence: 5001n, note: '£50.01, no approval',
        }),
      ).rejects.toThrow(BadRequestException);
      const approval = await services.approvals.approve(manager, {
        action: 'cash_paid_out',
        amountPence: 5001n,
        requestedByUserId: tenant.users.cashier.id,
        approverPin: '1234',
      });
      const over = await services.reporting.recordCashMovement(manager, {
        sessionId: session.id, type: 'petty_cash_out', amountPence: 5001n, note: '£50.01, approved',
        approvalEventId: approval.id,
      });
      expect(over.amount_pence).toBe(5001n);
    } finally {
      await close();
    }
  });
});

describe('ReportingService — end vs close and the worked-day Z-report', () => {
  it('end computes the exact expected cash; close from open is rejected; close at expected cash issues a Z-report with exact aggregates', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      await buildWorkedDay(db, tenant, services);
      await services.reporting.recordCashMovement(manager, {
        sessionId: session.id, type: 'cash_in', amountPence: 2000n, note: 'Float top-up',
      });
      await services.reporting.recordCashMovement(manager, {
        sessionId: session.id, type: 'cash_out', amountPence: 500n, note: 'Safe drop',
      });
      await services.reporting.recordCashMovement(manager, {
        sessionId: session.id, type: 'petty_cash_in', amountPence: 300n, note: 'Petty cash returned',
      });
      await services.reporting.recordCashMovement(manager, {
        sessionId: session.id, type: 'petty_cash_out', amountPence: 200n, note: 'Cleaning supplies',
      });

      // Close before End is rejected (two-step close is enforced).
      await expect(
        services.reporting.closeSession(manager, { sessionId: session.id, countedCashPence: 13900n }),
      ).rejects.toThrow(BadRequestException);

      const ended = await services.reporting.endSession(manager, session.id);
      expect(ended.status).toBe('ended');
      // 10000 + 2700 - 400 - 500 + 2000 - 200 + 300 = 13900.
      expect(ended.expected_cash_pence).toBe(13900n);

      const { session: closed, zReport } = await services.reporting.closeSession(manager, {
        sessionId: session.id,
        countedCashPence: 13900n,
      });
      expect(closed.status).toBe('closed');
      expect(closed.counted_cash_pence).toBe(13900n);
      expect(closed.variance_pence).toBe(0n);
      expect(zReport.zReport.status).toBe('issued');
      expect(zReport.zReport.z_number).toBe(1n);
      expect(zReport.zReport.gross_pence).toBe(4330n);
      expect(zReport.zReport.discount_pence).toBe(120n);
      expect(zReport.zReport.vat_pence).toBe(430n);
      expect(zReport.zReport.net_pence).toBe(3900n);
      expect(zReport.zReport.refund_pence).toBe(400n);
      expect(zReport.refundCount).toBe(1);
      expect(zReport.zReport.order_count).toBe(2);
      expect(zReport.zReport.void_count).toBe(1);
      expect(zReport.voidTotalPence).toBe(1200n);
      expect(zReport.cardFeeEstimatePence).toBe(33n);
      expect(cardFeeEstimatePence(1630n)).toBe(33n);

      const vatByKind = new Map(zReport.vatLines.map((l) => [l.taxRateKind, l]));
      expect(vatByKind.get('standard')).toMatchObject({ grossPence: 2280n, vatPence: 380n, netPence: 1900n, lineCount: 2 });
      expect(vatByKind.get('reduced')).toMatchObject({ grossPence: 1050n, vatPence: 50n, netPence: 1000n, lineCount: 1 });
      expect(vatByKind.get('zero')).toMatchObject({ grossPence: 1000n, vatPence: 0n, netPence: 1000n, lineCount: 1 });

      const tenderByType = new Map(zReport.tenderLines.map((l) => [l.tenderType, l]));
      expect(tenderByType.get('cash')).toMatchObject({ amountPence: 2700n, transactionCount: 2 });
      expect(tenderByType.get('card')).toMatchObject({ amountPence: 1630n, transactionCount: 1 });

      expect(zReport.promotionBreakdown).toHaveLength(1);
      expect(zReport.promotionBreakdown[0]?.promotionName).toBe('10% off');
      expect(zReport.promotionBreakdown[0]?.discountPence).toBe(120n);
      expect(zReport.carriedCorrections).toHaveLength(0);
      expect(zReport.carriedCorrectionTotalPence).toBe(0n);
    } finally {
      await close();
    }
  });

  it('a variance needs a reason; a zero variance does not', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      await services.reporting.endSession(manager, session.id);
      // Expected cash is 10000 (no sales); counted 9990 => variance -10, no reason => rejected.
      await expect(
        services.reporting.closeSession(manager, { sessionId: session.id, countedCashPence: 9990n }),
      ).rejects.toThrow(BadRequestException);
      const { session: closed } = await services.reporting.closeSession(manager, {
        sessionId: session.id,
        countedCashPence: 9990n,
        varianceReason: '£10 note stuck in drawer',
      });
      expect(closed.variance_pence).toBe(-10n);
      expect(closed.variance_reason).toBe('£10 note stuck in drawer');
    } finally {
      await close();
    }
  });

  it('close is blocked on a pending/unknown card payment, and allowed with an exact manager carry-forward', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId,
        openingFloatPence: 10000n,
      });
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await services.sales.createOrder(manager, {
        locationId: tenant.locationId,
        registerId: tenant.registerId,
        lines: [{ variantId: variant.variantId, quantity: 1n }],
      });
      const cardTender = await services.sales.addTender(manager, {
        orderId: order.id, tenderType: 'card', amountPence: 1000n,
      });
      const attemptId = cardTender.payment_attempt_id as string;
      // Leave the attempt 'created' (pending) and mark it unknown.
      await services.sales.recordCardAttemptOutcome(manager, {
        paymentAttemptId: attemptId, outcome: 'unknown',
      });
      await services.reporting.endSession(manager, session.id);
      await expect(
        services.reporting.closeSession(manager, { sessionId: session.id, countedCashPence: 10000n }),
      ).rejects.toThrow(/blocked/);
      // A carry-forward naming the wrong attempt ids is rejected.
      const approvalId = await insertManagerApproval(db, tenant, 'payment_carry_forward');
      await expect(
        services.reporting.closeSession(manager, {
          sessionId: session.id,
          countedCashPence: 10000n,
          carryForward: { attemptIds: ['00000000-0000-0000-0000-000000000000'], approvalEventId: approvalId, note: 'wrong ids' },
        }),
      ).rejects.toThrow(BadRequestException);
      const { session: closed, zReport } = await services.reporting.closeSession(manager, {
        sessionId: session.id,
        countedCashPence: 10000n,
        carryForward: {
          attemptIds: [attemptId],
          approvalEventId: approvalId,
          note: 'Terminal offline; reconcile against provider evidence tomorrow',
        },
      });
      expect(closed.status).toBe('closed');
      expect(zReport.zReport.status).toBe('issued');
      const events = await services.audit.listEvents(tenant.tenantId, { eventType: 'session.closed' });
      const payload = events[0]?.payload as Record<string, unknown>;
      expect(payload['carriedForwardAttemptIds']).toEqual([attemptId]);
    } finally {
      await close();
    }
  });

  it('D-08 boundary: exactly max(£10, 2%) needs no approval; 1p over does; the 2% branch governs at £1000 expected', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      // Session 1: expected £100.00 -> threshold max(1000, 200) = 1000p.
      let { session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId, openingFloatPence: 10000n,
      });
      await services.reporting.endSession(manager, session.id);
      // Variance exactly +1000p: no approval needed.
      let closed = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 11000n, varianceReason: 'Boundary: exactly £10 over',
      });
      expect(closed.session.variance_pence).toBe(1000n);
      expect(closed.zReport.zReport.z_number).toBe(1n);

      // Session 2: variance +1001p: rejected without approval, accepted with one.
      ({ session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId, openingFloatPence: 10000n,
      }));
      await services.reporting.endSession(manager, session.id);
      await expect(
        services.reporting.closeSession(manager, {
          sessionId: session.id, countedCashPence: 11001n, varianceReason: '£10.01 over, no approval',
        }),
      ).rejects.toThrow(BadRequestException);
      const approval = await services.approvals.approve(manager, {
        action: 'till_close_variance',
        amountPence: 1001n,
        requestedByUserId: tenant.users.cashier.id,
        approverPin: '1234',
      });
      closed = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 11001n, varianceReason: '£10.01 over, approved',
        approvalEventId: approval.id,
      });
      expect(closed.session.variance_pence).toBe(1001n);
      expect(closed.zReport.zReport.z_number).toBe(2n);

      // Session 3: expected £1000.00 -> threshold max(1000, 2000) = 2000p (2% governs).
      ({ session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId, openingFloatPence: 100000n,
      }));
      await services.reporting.endSession(manager, session.id);
      closed = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 102000n, varianceReason: 'Boundary: exactly 2% over',
      });
      expect(closed.session.variance_pence).toBe(2000n);
      expect(closed.zReport.zReport.z_number).toBe(3n);

      // Session 4: variance 2001p at £1000 expected: needs approval.
      ({ session } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId, openingFloatPence: 100000n,
      }));
      await services.reporting.endSession(manager, session.id);
      await expect(
        services.reporting.closeSession(manager, {
          sessionId: session.id, countedCashPence: 102001n, varianceReason: '2% + 1p, no approval',
        }),
      ).rejects.toThrow(BadRequestException);
      const approval2 = await services.approvals.approve(manager, {
        action: 'till_close_variance',
        amountPence: 2001n,
        requestedByUserId: tenant.users.cashier.id,
        approverPin: '1234',
      });
      closed = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 102001n, varianceReason: '2% + 1p, approved',
        approvalEventId: approval2.id,
      });
      expect(closed.zReport.zReport.z_number).toBe(4n);
    } finally {
      await close();
    }
  });
});

describe('ReportingService — Z-report immutability and corrections', () => {
  it('an UPDATE to an issued Z-report is rejected by the database trigger', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const { zReport } = await (async () => {
        const { session } = await openAndEndWorkedDay(db, tenant, services);
        return services.reporting.closeSession(actorFor(tenant, 'manager'), {
          sessionId: session.id, countedCashPence: 13900n,
        });
      })();
      await expect(
        db.updateTable('z_reports').set({ gross_pence: 1n }).where('id', '=', zReport.zReport.id).execute(),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.deleteFrom('z_reports').where('id', '=', zReport.zReport.id).execute(),
      ).rejects.toThrow(/immutable/);
      // The row is unchanged.
      const row = await db.selectFrom('z_reports').select('gross_pence').where('id', '=', zReport.zReport.id).executeTakeFirstOrThrow();
      expect(row.gross_pence).toBe(4330n);
    } finally {
      await close();
    }
  });

  it('a manager-approved correction on Z1 is carried into Z2 and never rewrites Z1', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await openAndEndWorkedDay(db, tenant, services);
      const { zReport: z1 } = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 13900n,
      });
      const approvalId = await insertManagerApproval(db, tenant, 'z_report_correction');
      const correction = await services.reporting.recordCorrection(manager, {
        zReportId: z1.zReport.id,
        correctionType: 'cash_variance',
        amountPence: 100n,
        reason: '£1.00 found in drawer after close',
        approvalEventId: approvalId,
      });
      expect(correction.z_report_id).toBe(z1.zReport.id);

      // Second (empty) session on the same register -> Z2 carries the correction.
      const { session: session2 } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId, openingFloatPence: 5000n,
      });
      await services.reporting.endSession(manager, session2.id);
      const { zReport: z2 } = await services.reporting.closeSession(manager, {
        sessionId: session2.id, countedCashPence: 5000n,
      });
      expect(z2.zReport.z_number).toBe(2n);
      expect(z2.carriedCorrectionTotalPence).toBe(100n);
      expect(z2.carriedCorrections).toHaveLength(1);
      expect(z2.carriedCorrections[0]?.reason).toBe('£1.00 found in drawer after close');
      // Z1 itself is untouched.
      const z1Row = await db.selectFrom('z_reports').selectAll().where('id', '=', z1.zReport.id).executeTakeFirstOrThrow();
      expect(z1Row.gross_pence).toBe(4330n);
      expect(z1Row.cash_variance_pence).toBe(0n);
    } finally {
      await close();
    }
  });
});

describe('ReportingService — VAT periods', () => {
  /** Direct order + line inserts with fixed business dates (no sales flow). */
  async function insertCompletedOrder(
    db: Kysely<DB>,
    tenant: SeededTenant,
    opts: { orderNumber: bigint; businessDate: string; lines: Array<{ kind: 'standard' | 'reduced' | 'zero' | 'exempt'; percent: string; lineTotal: bigint; tax: bigint }> },
  ): Promise<string> {
    const total = opts.lines.reduce((s, l) => s + l.lineTotal, 0n);
    const tax = opts.lines.reduce((s, l) => s + l.tax, 0n);
    const order = await db
      .insertInto('orders')
      .values({
        tenant_id: tenant.tenantId,
        location_id: tenant.locationId,
        register_id: tenant.registerId,
        customer_id: null,
        order_number: opts.orderNumber,
        business_date: opts.businessDate,
        status: 'completed',
        subtotal_pence: total,
        discount_pence: 0n,
        tax_pence: tax,
        total_pence: total,
        created_by_user_id: tenant.users.manager.id,
        completed_at: new Date(`${opts.businessDate}T12:00:00Z`),
        created_at: new Date(`${opts.businessDate}T12:00:00Z`),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const variant = await seedVariant(db, tenant);
    for (const line of opts.lines) {
      await db
        .insertInto('order_lines')
        .values({
          tenant_id: tenant.tenantId,
          order_id: order.id,
          variant_id: variant.variantId,
          quantity: 1n,
          unit_price_pence: line.lineTotal,
          base_price_pence: line.lineTotal,
          price_book_id: null,
          price_book_price_pence: null,
          promotion_discount_pence: 0n,
          manual_discount_pence: 0n,
          final_price_pence: line.lineTotal,
          tax_rate_kind: line.kind,
          tax_rate_percent: line.percent,
          tax_amount_pence: line.tax,
          line_total_pence: line.lineTotal,
        })
        .execute();
    }
    return order.id;
  }

  it('closes a VAT period by rate; a refund in a later period restates without rewriting the closed period', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const orderNov5 = await insertCompletedOrder(db, tenant, {
        orderNumber: 1n,
        businessDate: '2026-11-05',
        lines: [{ kind: 'standard', percent: '20.00', lineTotal: 1200n, tax: 200n }],
      });
      await insertCompletedOrder(db, tenant, {
        orderNumber: 2n,
        businessDate: '2026-11-10',
        lines: [{ kind: 'reduced', percent: '5.00', lineTotal: 1050n, tax: 50n }],
      });
      // £6.00 cash refund of the 5 Nov order, created 10 Nov (period 2).
      await db
        .insertInto('refunds')
        .values({
          tenant_id: tenant.tenantId,
          order_id: orderNov5,
          payment_attempt_id: null,
          idempotency_key: randomUUID(),
          amount_pence: 600n,
          reason: 'Refund in later period',
          status: 'completed',
          provider_reference: null,
          created_by_user_id: manager.userId,
          created_at: new Date('2026-11-10T10:00:00Z'),
        })
        .execute();

      const period1 = await services.reporting.closeVatPeriod(manager, {
        periodStart: '2026-11-01', periodEnd: '2026-11-07',
      });
      expect(period1.lines).toHaveLength(1);
      expect(period1.lines[0]).toMatchObject({
        taxRateKind: 'standard', grossPence: 1200n, vatPence: 200n, netPence: 1000n, orderLineCount: 1,
      });
      expect(period1.restatements).toHaveLength(0);

      const period2 = await services.reporting.closeVatPeriod(manager, {
        periodStart: '2026-11-08', periodEnd: '2026-11-14',
      });
      expect(period2.lines).toHaveLength(1);
      expect(period2.lines[0]).toMatchObject({
        taxRateKind: 'reduced', grossPence: 1050n, vatPence: 50n, netPence: 1000n, orderLineCount: 1,
      });
      expect(period2.restatements).toHaveLength(1);
      expect(period2.restatements[0]?.originalBusinessDate).toBe('2026-11-05');
      expect(period2.restatements[0]?.refundBusinessDate).toBe('2026-11-10');
      expect(period2.restatements[0]?.amountPence).toBe(600n);
      // 600p of a 20% line: VAT round(600*20/120) = 100, net 500.
      expect(period2.restatements[0]?.perRate[0]).toMatchObject({
        taxRateKind: 'standard', grossPence: 600n, vatPence: 100n, netPence: 500n,
      });

      // The closed period-1 stored lines are untouched by the restatement.
      const period1Lines = await db
        .selectFrom('vat_period_lines')
        .selectAll()
        .where('vat_period_id', '=', period1.periodId)
        .execute();
      expect(period1Lines).toHaveLength(1);
      expect(period1Lines[0]?.gross_pence).toBe(1200n);
      expect(period1Lines[0]?.vat_pence).toBe(200n);
    } finally {
      await close();
    }
  });
});

describe('ReportingService — CSV exports', () => {
  it('Z-report CSV uses the exact Arch-02 §5.3 columns in order, carries exact figures, and is reproducible', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await openAndEndWorkedDay(db, tenant, services);
      const { zReport } = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 13900n,
      });
      const fixedAt = new Date('2026-11-13T12:00:00Z');
      const first = await services.reporting.exportZReportCsv(manager, zReport.zReport.id, { generatedAt: fixedAt });
      const second = await services.reporting.exportZReportCsv(manager, zReport.zReport.id, { generatedAt: fixedAt });
      expect(first.csv).toBe(second.csv);
      expect(first.sha256).toBe(second.sha256);
      expect(first.fileName).toBe(`z-report-1-${businessDate(new Date())}.csv`);

      const lines = first.csv.trimEnd().split('\n');
      const header = lines[0]?.split(',') as string[];
      expect(header).toEqual([...Z_REPORT_CSV_COLUMNS]);
      const rows = lines.slice(1).map((l) => {
        const values = l.split(',');
        return Object.fromEntries(header.map((h, i) => [h, values[i] as string]));
      });
      // Per-rate rows carry the summary columns.
      const stdRow = rows.find((r) => r['tax_rate_name'] === 'Standard');
      expect(stdRow).toMatchObject({
        z_number: '1',
        net_pence: '1900',
        vat_pence: '380',
        gross_pence: '2280',
        line_count: '2',
        discount_total_pence: '120',
        refund_total_pence: '400',
        refund_count: '1',
        card_fee_estimate_pence: '33',
        cash_expected_pence: '13900',
        cash_counted_pence: '13900',
        cash_variance_pence: '0',
        order_count: '2',
        void_count: '1',
        void_total_pence: '1200',
        currency: 'GBP',
      });
      expect(stdRow?.['business_date']).toBe(businessDate(new Date()));
      const reducedRow = rows.find((r) => r['tax_rate_name'] === 'Reduced');
      expect(reducedRow).toMatchObject({ net_pence: '1000', vat_pence: '50', gross_pence: '1050', line_count: '1' });
      const zeroRow = rows.find((r) => r['tax_rate_name'] === 'Zero-rated');
      expect(zeroRow).toMatchObject({ net_pence: '1000', vat_pence: '0', gross_pence: '1000', line_count: '1' });
      // Tender rows.
      const cardRow = rows.find((r) => r['tender_type'] === 'card');
      expect(cardRow).toMatchObject({ tender_total_pence: '1630', tender_count: '1' });
      const cashRow = rows.find((r) => r['tender_type'] === 'cash');
      expect(cashRow).toMatchObject({ tender_total_pence: '2700', tender_count: '2' });
      // Promotion row (Arch-10 §5.3 breakdown).
      const promoRow = rows.find((r) => r['promotion_name'] === '10% off');
      expect(promoRow).toMatchObject({ promotion_discount_pence: '120' });
      // No correction rows on a clean Z-report.
      expect(rows.filter((r) => (r['correction_reason'] as string) !== '' && r['tax_rate_name'] === '' && r['tender_type'] === '' && r['promotion_name'] === '')).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('Z-report CSV shows a carried correction as a visible separate row, never netted', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const { session } = await openAndEndWorkedDay(db, tenant, services);
      const { zReport: z1 } = await services.reporting.closeSession(manager, {
        sessionId: session.id, countedCashPence: 13900n,
      });
      const approvalId = await insertManagerApproval(db, tenant, 'z_report_correction');
      await services.reporting.recordCorrection(manager, {
        zReportId: z1.zReport.id,
        correctionType: 'cash_variance',
        amountPence: 100n,
        reason: '£1.00 found in drawer after close',
        approvalEventId: approvalId,
      });
      const { session: session2 } = await services.reporting.openSession(manager, {
        registerId: tenant.registerId, openingFloatPence: 5000n,
      });
      await services.reporting.endSession(manager, session2.id);
      const { zReport: z2 } = await services.reporting.closeSession(manager, {
        sessionId: session2.id, countedCashPence: 5000n,
      });
      const { csv } = await services.reporting.exportZReportCsv(manager, z2.zReport.id, {
        generatedAt: new Date('2026-11-13T12:00:00Z'),
      });
      const lines = csv.trimEnd().split('\n');
      const header = lines[0]?.split(',') as string[];
      const rows = lines.slice(1).map((l) => {
        const values = l.split(',');
        return Object.fromEntries(header.map((h, i) => [h, values[i] as string]));
      });
      const correctionRow = rows.find((r) => (r['correction_reason'] as string).includes('found in drawer'));
      expect(correctionRow).toBeDefined();
      expect(correctionRow?.['correction_total_pence']).toBe('100');
      expect(correctionRow?.['z_number']).toBe('2');
      // The carried total is NOT netted into Z2's (empty) sales figures.
      expect(z2.zReport.gross_pence).toBe(0n);
    } finally {
      await close();
    }
  });

  it('VAT-period CSV uses the exact contract columns, shows refund adjustments per rate, and is reproducible', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      // Reuse the VAT-period fixture via direct inserts.
      const variant = await seedVariant(db, tenant);
      const insertOrder = async (orderNumber: bigint, date: string, kind: 'standard' | 'reduced', percent: string, total: bigint, tax: bigint) => {
        const order = await db.insertInto('orders').values({
          tenant_id: tenant.tenantId, location_id: tenant.locationId, register_id: tenant.registerId,
          customer_id: null, order_number: orderNumber, business_date: date, status: 'completed',
          subtotal_pence: total, discount_pence: 0n, tax_pence: tax, total_pence: total,
          created_by_user_id: manager.userId, completed_at: new Date(`${date}T12:00:00Z`),
          created_at: new Date(`${date}T12:00:00Z`),
        }).returning('id').executeTakeFirstOrThrow();
        await db.insertInto('order_lines').values({
          tenant_id: tenant.tenantId, order_id: order.id, variant_id: variant.variantId, quantity: 1n,
          unit_price_pence: total, base_price_pence: total, price_book_id: null, price_book_price_pence: null,
          promotion_discount_pence: 0n, manual_discount_pence: 0n, final_price_pence: total,
          tax_rate_kind: kind, tax_rate_percent: percent, tax_amount_pence: tax, line_total_pence: total,
        }).execute();
        return order.id;
      };
      const orderNov5 = await insertOrder(1n, '2026-11-05', 'standard', '20.00', 1200n, 200n);
      await insertOrder(2n, '2026-11-10', 'reduced', '5.00', 1050n, 50n);
      await db.insertInto('refunds').values({
        tenant_id: tenant.tenantId, order_id: orderNov5, payment_attempt_id: null,
        idempotency_key: randomUUID(), amount_pence: 600n, reason: 'Later-period refund',
        status: 'completed', provider_reference: null, created_by_user_id: manager.userId,
        created_at: new Date('2026-11-10T10:00:00Z'),
      }).execute();

      const period2 = await services.reporting.closeVatPeriod(manager, {
        periodStart: '2026-11-08', periodEnd: '2026-11-14',
      });
      const fixedAt = new Date('2026-11-13T12:00:00Z');
      const first = await services.reporting.exportVatPeriodCsv(manager, period2.periodId, { generatedAt: fixedAt });
      const second = await services.reporting.exportVatPeriodCsv(manager, period2.periodId, { generatedAt: fixedAt });
      expect(first.csv).toBe(second.csv);
      const lines = first.csv.trimEnd().split('\n');
      expect(lines[0]?.split(',')).toEqual([...VAT_PERIOD_CSV_COLUMNS]);
      const header = lines[0]?.split(',') as string[];
      const rows = lines.slice(1).map((l) => {
        const values = l.split(',');
        return Object.fromEntries(header.map((h, i) => [h, values[i] as string]));
      });
      const reducedRow = rows.find((r) => r['tax_rate_name'] === 'Reduced');
      expect(reducedRow).toMatchObject({
        period_start: '2026-11-08', period_end: '2026-11-14',
        net_pence: '1000', vat_pence: '50', gross_pence: '1050',
        order_line_count: '1', refund_adjustment_pence: '0', currency: 'GBP',
      });
      // The restating refund appears as a standard-rate adjustment row.
      const stdRow = rows.find((r) => r['tax_rate_name'] === 'Standard');
      expect(stdRow).toMatchObject({
        net_pence: '0', vat_pence: '0', gross_pence: '0',
        order_line_count: '0', refund_adjustment_pence: '600',
      });
      // The export is recorded with its checksum.
      const exports = await db.selectFrom('vat_return_exports').selectAll().where('vat_period_id', '=', period2.periodId).execute();
      expect(exports.length).toBeGreaterThanOrEqual(1);
      expect(exports[0]?.sha256_checksum).toBe(first.sha256);
    } finally {
      await close();
    }
  });
});

describe('ReportingService — settlement reconciliation (G-A-17)', () => {
  it('reconciles by settlement date (T+3) with reserve and dispute as distinct lines; a fee difference posts a fee-adjustment entry; a gross mismatch raises a discrepancy alert', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const services = makeServices(db);
      const manager = actorFor(tenant, 'manager');
      const today = businessDate(new Date());
      const settlement = settlementDateFor(today);
      // One card sale of £20.00, approved. Fee estimate: round(2000*14/1000)+10 = 28+10 = 38.
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await services.sales.createOrder(manager, {
        locationId: tenant.locationId,
        registerId: tenant.registerId,
        lines: [{ variantId: variant.variantId, quantity: 2n }],
      });
      const cardTender = await services.sales.addTender(manager, {
        orderId: order.id, tenderType: 'card', amountPence: 2000n,
      });
      await services.sales.recordCardAttemptOutcome(manager, {
        paymentAttemptId: cardTender.payment_attempt_id as string,
        outcome: 'approved',
        providerReference: 'pi_settle_1',
      });
      await services.sales.completeOrder(manager, order.id);

      // Case A: payout matches exactly, with a reserve hold and a dispute debit.
      const reconciled = await services.reporting.reconcileSettlement(manager, today, [
        { providerReference: 'po_1', settlementDate: settlement, grossPence: 2000n, feePence: 38n, reserveHoldPence: 100n, disputeDebitPence: 50n },
      ]);
      expect(reconciled.settlementDate).toBe(settlement);
      expect(reconciled.cardGrossPence).toBe(2000n);
      expect(reconciled.feeEstimatePence).toBe(38n);
      expect(reconciled.reserveHoldTotalPence).toBe(100n);
      expect(reconciled.disputeDebitTotalPence).toBe(50n);
      expect(reconciled.expectedNetPayoutPence).toBe(2000n - 38n - 100n - 50n);
      expect(reconciled.feeAdjustment).toBeNull();
      expect(reconciled.status).toBe('reconciled');

      // Case B: settled fee differs from the estimate -> fee-adjustment entry, still reconciled.
      const feeDiff = await services.reporting.reconcileSettlement(manager, today, [
        { providerReference: 'po_2', settlementDate: settlement, grossPence: 2000n, feePence: 45n, reserveHoldPence: 0n, disputeDebitPence: 0n },
      ]);
      expect(feeDiff.status).toBe('reconciled');
      expect(feeDiff.feeAdjustment).toMatchObject({
        estimatedFeePence: 38n, settledFeePence: 45n, adjustmentPence: 7n,
      });
      const feeEvents = await services.audit.listEvents(tenant.tenantId, { eventType: 'settlement.fee_adjustment' });
      expect(feeEvents.length).toBe(1);
      expect((feeEvents[0]?.payload as Record<string, unknown>)['adjustmentPence']).toBe('7');

      // Case C: payout gross does not match card sales -> discrepancy alert, never a silent correction.
      const mismatch = await services.reporting.reconcileSettlement(manager, today, [
        { providerReference: 'po_3', settlementDate: settlement, grossPence: 1900n, feePence: 38n, reserveHoldPence: 0n, disputeDebitPence: 0n },
      ]);
      expect(mismatch.status).toBe('discrepancy');
      expect(mismatch.discrepancyReason).toContain('1900');
      const discrepancyEvents = await services.audit.listEvents(tenant.tenantId, { eventType: 'settlement.discrepancy' });
      expect(discrepancyEvents.length).toBe(1);
      expect((discrepancyEvents[0]?.payload as Record<string, unknown>)['settledGrossPence']).toBe('1900');

      // Case D: a payout for the wrong settlement date does not match (matching is by settlement date, not sale date).
      const wrongDate = await services.reporting.reconcileSettlement(manager, today, [
        { providerReference: 'po_4', settlementDate: today, grossPence: 2000n, feePence: 38n, reserveHoldPence: 0n, disputeDebitPence: 0n },
      ]);
      expect(wrongDate.status).toBe('discrepancy');
      expect(wrongDate.otherSettlementDatePayouts).toHaveLength(1);
      expect(wrongDate.payouts).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
