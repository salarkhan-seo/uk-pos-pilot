/**
 * Route tests — Group A (auth + reporting) — Build-04 Worker 4.
 *
 * Proves the thin controllers over SessionService and ReportingService:
 * POST /v1/auth/pin-login, GET /v1/reporting/z-reports/:id,
 * POST /v1/reporting/z-reports/:id/corrections,
 * POST /v1/reporting/vat-periods/:id/close,
 * GET /v1/reporting/z-reports/:id/csv,
 * GET /v1/reporting/vat-periods/:id/csv,
 * POST /v1/reporting/settlements/reconcile.
 *
 * Happy path, cross-tenant 404 and wrong-scope rejection (via the real
 * AuthGuard) are asserted per group. CSV assertions check the exact
 * Arch-02 §5.3 column headers.
 */
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  createTestDb,
  seedTenant,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { AuthController } from '../../src/modules/admin/auth.controller';
import { SessionService } from '../../src/modules/admin/session.service';
import {
  ReportingService,
  VAT_PERIOD_CSV_COLUMNS,
  Z_REPORT_CSV_COLUMNS,
} from '../../src/modules/reporting/reporting.service';
import { ReportingV1Controller } from '../../src/modules/reporting/reporting.v1.controller';
import {
  actorFor,
  guardContext,
  makeApiKey,
  makeGuard,
  reqFor,
  withDb,
} from './helpers';

function makeReporting(db: Kysely<DB>) {
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const reporting = new ReportingService(db, approvals, audit);
  return { audit, approvals, reporting };
}

/** Direct approval_events insert for actions with no ApprovalAction (corrections). */
async function insertManagerApproval(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const row = await db
    .insertInto('approval_events')
    .values({
      tenant_id: tenant.tenantId,
      order_id: null,
      action: 'z_report_correction',
      amount_pence: null,
      reason: 'test approval for z_report_correction',
      requested_by_user_id: tenant.users.cashier.id,
      approved_by_user_id: tenant.users.manager.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A closed session + an issued Z-report (with one VAT line) for the tenant. */
async function seedIssuedZReport(db: Kysely<DB>, tenant: SeededTenant) {
  const session = await db
    .insertInto('register_sessions')
    .values({
      tenant_id: tenant.tenantId,
      register_id: tenant.registerId,
      opened_by_user_id: tenant.users.manager.id,
      opened_at: new Date('2026-11-13T08:00:00Z'),
      float_pence: 5000n,
      status: 'closed',
      ended_at: new Date('2026-11-13T18:00:00Z'),
      closed_at: new Date('2026-11-13T18:05:00Z'),
      closed_by_user_id: tenant.users.manager.id,
      expected_cash_pence: 5000n,
      counted_cash_pence: 5000n,
      variance_pence: 0n,
      variance_reason: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const zReport = await db
    .insertInto('z_reports')
    .values({
      tenant_id: tenant.tenantId,
      register_id: tenant.registerId,
      session_id: session.id,
      z_number: 1n,
      business_date: '2026-11-13',
      status: 'issued',
      issued_at: new Date('2026-11-13T18:05:00Z'),
      gross_pence: 12000n,
      net_pence: 10000n,
      vat_pence: 2000n,
      discount_pence: 0n,
      refund_pence: 0n,
      cash_expected_pence: 5000n,
      cash_counted_pence: 5000n,
      cash_variance_pence: 0n,
      order_count: 1,
      void_count: 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('z_report_vat_lines')
    .values({
      z_report_id: zReport.id,
      tax_rate_kind: 'standard',
      tax_rate_percent: '20.00',
      gross_pence: 12000n,
      vat_pence: 2000n,
      net_pence: 10000n,
    })
    .execute();
  return { sessionId: session.id, zReportId: zReport.id };
}

describe('AuthController — POST /v1/auth/pin-login', () => {
  it('issues a session token for a correct PIN (and the token verifies)', async () => {
    await withDb(async ({ db, tenant }) => {
      const sessions = new SessionService(db);
      const controller = new AuthController(sessions);
      const result = await controller.pinLogin({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
        locationId: tenant.locationId,
      });
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(10);
      expect(result.actor.tenantId).toBe(tenant.tenantId);
      expect(result.actor.roles).toContain('manager');
      const verified = await sessions.verifyToken(result.token);
      expect(verified?.userId).toBe(tenant.users.manager.id);
    });
  });

  it('rejects a wrong PIN with 403 and an unknown user with 404', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new AuthController(new SessionService(db));
      await expect(
        controller.pinLogin({
          tenantId: tenant.tenantId,
          userId: tenant.users.manager.id,
          pin: '9999',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.pinLogin({
          tenantId: tenant.tenantId,
          userId: '00000000-0000-0000-0000-000000000000',
          pin: '1234',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('does not let a user of another tenant log in under this tenant (404)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const controller = new AuthController(new SessionService(db));
      await expect(
        controller.pinLogin({
          tenantId: tenantA.tenantId,
          userId: tenantB.users.manager.id,
          pin: '1234',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('ReportingV1Controller — Z-reports', () => {
  it('returns the Z-report summary (money as decimal strings)', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const { zReportId } = await seedIssuedZReport(db, tenant);
      const controller = new ReportingV1Controller(db, reporting);
      const summary = await controller.getZReport(reqFor(actorFor(tenant, 'manager')), zReportId);
      expect(summary).toMatchObject({
        id: zReportId,
        z_number: '1',
        business_date: '2026-11-13',
        register_id: tenant.registerId,
        gross_pence: '12000',
        net_pence: '10000',
        vat_pence: '2000',
        cash_variance_pence: '0',
      });
    });
  });

  it('returns 404 for a Z-report of another tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { reporting } = makeReporting(db);
      const { zReportId } = await seedIssuedZReport(db, tenantA);
      const controller = new ReportingV1Controller(db, reporting);
      await expect(
        controller.getZReport(reqFor(actorFor(tenantB, 'manager')), zReportId),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('records a manager-approved correction against the issued Z-report', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const { zReportId } = await seedIssuedZReport(db, tenant);
      const approvalId = await insertManagerApproval(db, tenant);
      const controller = new ReportingV1Controller(db, reporting);
      const correction = await controller.recordCorrection(
        reqFor(actorFor(tenant, 'manager')),
        zReportId,
        { correctionType: 'cash_variance', amountPence: '250', reason: 'Till count was off', approvalEventId: approvalId },
      );
      expect(typeof correction.id).toBe('string');
      const stored = await db
        .selectFrom('z_report_corrections')
        .selectAll()
        .where('id', '=', correction.id)
        .executeTakeFirstOrThrow();
      expect(stored.amount_pence).toBe(250n);
      expect(stored.reason).toBe('Till count was off');
    });
  });

  it('exports the Z-report CSV with the exact Arch-02 §5.3 header', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const { zReportId } = await seedIssuedZReport(db, tenant);
      const controller = new ReportingV1Controller(db, reporting);
      const csv = await controller.exportZReportCsv(reqFor(actorFor(tenant, 'manager')), zReportId);
      const [header] = csv.split('\n');
      expect(header).toBe(Z_REPORT_CSV_COLUMNS.join(','));
      expect(csv).toContain('12000');
      expect(csv).toContain('GBP');
    });
  });
});

describe('ReportingV1Controller — VAT periods', () => {
  it('closes an open period by id and returns the SAME :id (Build-05 in-place close)', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const open = await db
        .insertInto('vat_periods')
        .values({
          tenant_id: tenant.tenantId,
          period_start: '2026-11-01',
          period_end: '2026-11-07',
          status: 'open',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const controller = new ReportingV1Controller(db, reporting);
      const closed = await controller.closeVatPeriod(reqFor(actorFor(tenant, 'manager')), open.id);
      // Build-05 fix: the existing row is closed IN PLACE — the
      // returned id IS the :id that was passed in (the Build-04
      // delete-and-recreate bridge, which returned a new id, is gone).
      expect(closed.id).toBe(open.id);
      expect(closed).toMatchObject({
        period_start: '2026-11-01',
        period_end: '2026-11-07',
        status: 'closed',
      });
      expect(closed.closed_by_user_id).toBe(tenant.users.manager.id);
      expect(closed.closed_at).not.toBeNull();
      // The same row still exists under the same id, now closed.
      const stored = await db
        .selectFrom('vat_periods')
        .selectAll()
        .where('id', '=', open.id)
        .executeTakeFirstOrThrow();
      expect(stored.status).toBe('closed');
      expect(stored.closed_at).not.toBeNull();
      expect(stored.closed_by_user_id).toBe(tenant.users.manager.id);
      // Closing the same (now closed) period is 409.
      await expect(
        controller.closeVatPeriod(reqFor(actorFor(tenant, 'manager')), closed.id),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('returns 404 when another tenant tries to close the period', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { reporting } = makeReporting(db);
      const open = await db
        .insertInto('vat_periods')
        .values({
          tenant_id: tenantA.tenantId,
          period_start: '2026-11-01',
          period_end: '2026-11-07',
          status: 'open',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const controller = new ReportingV1Controller(db, reporting);
      await expect(
        controller.closeVatPeriod(reqFor(actorFor(tenantB, 'manager')), open.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('reads an open period by id (Build-06 Objective 4: resolves G-UI-02)', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const open = await db
        .insertInto('vat_periods')
        .values({
          tenant_id: tenant.tenantId,
          period_start: '2026-11-01',
          period_end: '2026-11-07',
          status: 'open',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const controller = new ReportingV1Controller(db, reporting);
      const read = await controller.getVatPeriod(reqFor(actorFor(tenant, 'manager')), open.id);
      expect(read).toMatchObject({
        id: open.id,
        period_start: '2026-11-01',
        period_end: '2026-11-07',
        status: 'open',
      });
      expect(read.closed_at).toBeNull();
    });
  });

  it('returns 404 when another tenant tries to read the period', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { reporting } = makeReporting(db);
      const open = await db
        .insertInto('vat_periods')
        .values({
          tenant_id: tenantA.tenantId,
          period_start: '2026-11-01',
          period_end: '2026-11-07',
          status: 'open',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const controller = new ReportingV1Controller(db, reporting);
      await expect(
        controller.getVatPeriod(reqFor(actorFor(tenantB, 'manager')), open.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('exports a closed VAT period CSV with the exact Arch-02 §5.3 header', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const closed = await reporting.closeVatPeriod(actorFor(tenant, 'manager'), {
        periodStart: '2026-11-01',
        periodEnd: '2026-11-07',
      });
      const controller = new ReportingV1Controller(db, reporting);
      const csv = await controller.exportVatPeriodCsv(reqFor(actorFor(tenant, 'manager')), closed.periodId);
      const [header] = csv.split('\n');
      expect(header).toBe(VAT_PERIOD_CSV_COLUMNS.join(','));
    });
  });
});

describe('ReportingV1Controller — settlement reconciliation', () => {
  it('reconciles a quiet day (no card sales, no payouts) and returns string pence', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const controller = new ReportingV1Controller(db, reporting);
      const result = await controller.reconcileSettlement(reqFor(actorFor(tenant, 'manager')), {
        businessDate: '2026-11-10',
        payouts: [],
      });
      expect(result).toMatchObject({
        businessDate: '2026-11-10',
        settlementDate: '2026-11-13',
        cardGrossPence: '0',
        status: 'reconciled',
        discrepancyReason: null,
      });
    });
  });

  it('rejects a malformed business date with 400', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const controller = new ReportingV1Controller(db, reporting);
      await expect(
        controller.reconcileSettlement(reqFor(actorFor(tenant, 'manager')), {
          businessDate: '10 Nov 2026',
          payouts: [],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('ReportingV1Controller — AuthGuard scope checks', () => {
  it('rejects unauthenticated, wrong-scope and cross-tenant calls; admits admin + manager', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const handler = ReportingV1Controller.prototype.getZReport;

      await expect(
        guard.canActivate(guardContext(handler, {})),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      const readOnlyKey = await makeApiKey(db, tenant.tenantId, ['catalogue:read']);
      await expect(
        guard.canActivate(
          guardContext(handler, { authorization: `Bearer ${readOnlyKey}` }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      expect(
        await guard.canActivate(
          guardContext(handler, { authorization: `Bearer ${adminKey}` }),
        ),
      ).toBe(true);

      // A cashier session has no accounting:read; a manager session does.
      const sessions = new SessionService(db);
      const cashier = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
      });
      await expect(
        guard.canActivate(
          guardContext(handler, { authorization: `Bearer ${cashier.token}` }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const manager = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      expect(
        await guard.canActivate(
          guardContext(handler, { authorization: `Bearer ${manager.token}` }),
        ),
      ).toBe(true);

      // Cross-tenant addressing is 404, never 403 (G-B).
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      await expect(
        guard.canActivate(
          guardContext(handler, {
            authorization: `Bearer ${adminKey}`,
            'x-tenant-id': other.tenantId,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
