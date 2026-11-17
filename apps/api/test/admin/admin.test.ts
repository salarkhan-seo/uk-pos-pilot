/**
 * Admin tests (Build-02, Objective 2) — ApprovalService + AuditService.
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant (seedTenant: one user per role, PIN '1234'), and closes the DB
 * in a finally. Tests run sequentially — PGlite runs on a single
 * connection, so no Promise.all concurrency.
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createTestDb, seedTenant } from '@uk-pos/db';
import type { DB, SeededTenant } from '@uk-pos/db';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { discountLimitForRoles } from '../../src/common/roles';
import type { Actor } from '../../src/common/actor';

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

function actorFor(tenant: SeededTenant, role: Role, locationId?: string): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: locationId ?? tenant.locationId,
    roles: [role],
  };
}

async function insertOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  overrides: { locationId?: string; orderNumber?: bigint } = {},
): Promise<string> {
  const row = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: overrides.locationId ?? tenant.locationId,
      register_id: tenant.registerId,
      customer_id: null,
      order_number: overrides.orderNumber ?? 1n,
      business_date: '2026-11-13',
      status: 'draft',
      subtotal_pence: 1000n,
      discount_pence: 0n,
      tax_pence: 200n,
      total_pence: 1200n,
      created_by_user_id: tenant.users.cashier.id,
      completed_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function services(db: Kysely<DB>): { audit: AuditService; approvals: ApprovalService } {
  const audit = new AuditService(db);
  return { audit, approvals: new ApprovalService(db, audit) };
}

describe('ApprovalService — tenant isolation', () => {
  it('rejects another tenant’s order as not found, approves a same-tenant order', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { approvals } = services(db);
      const ownOrderId = await insertOrder(db, tenant);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const otherOrderId = await insertOrder(db, other);
      const manager = actorFor(tenant, 'manager');

      await expect(
        approvals.approve(manager, {
          action: 'discount_above_limit',
          amountPence: 500n,
          requestedByUserId: tenant.users.cashier.id,
          orderId: otherOrderId,
          approverPin: '1234',
        }),
      ).rejects.toThrow(NotFoundException);

      const row = await approvals.approve(manager, {
        action: 'discount_above_limit',
        amountPence: 500n,
        requestedByUserId: tenant.users.cashier.id,
        orderId: ownOrderId,
        approverPin: '1234',
      });
      expect(row.action).toBe('discount_above_limit');
      expect(row.amount_pence).toBe(500n);
      expect(row.approved_by_user_id).toBe(manager.userId);
      expect(row.requested_by_user_id).toBe(tenant.users.cashier.id);
    });
  });
});

describe('ApprovalService — RBAC and location scope', () => {
  it('forbids a cashier approver, allows a manager at their own location', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { approvals } = services(db);
      const orderId = await insertOrder(db, tenant);

      await expect(
        approvals.approve(actorFor(tenant, 'cashier'), {
          action: 'discount_above_limit',
          amountPence: 500n,
          requestedByUserId: tenant.users.cashier.id,
          orderId,
          approverPin: '1234',
        }),
      ).rejects.toThrow(ForbiddenException);

      const row = await approvals.approve(actorFor(tenant, 'manager'), {
        action: 'discount_above_limit',
        amountPence: 500n,
        requestedByUserId: tenant.users.cashier.id,
        orderId,
        approverPin: '1234',
      });
      expect(row.approved_by_user_id).toBe(tenant.users.manager.id);
    });
  });

  it('reports a same-tenant order at another location as not found', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { approvals } = services(db);
      const branch = await db
        .insertInto('locations')
        .values({
          tenant_id: tenant.tenantId,
          name: 'Branch Shop',
          town: 'Leeds',
          postcode: 'LS1 1AA',
          country: 'GB',
          timezone: 'Europe/London',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const branchOrderId = await insertOrder(db, tenant, {
        locationId: branch.id,
        orderNumber: 2n,
      });

      // The manager works at the main shop, not the branch.
      await expect(
        approvals.approve(actorFor(tenant, 'manager'), {
          action: 'void_post_tender',
          requestedByUserId: tenant.users.cashier.id,
          orderId: branchOrderId,
          approverPin: '1234',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('ApprovalService — self-approval and PIN', () => {
  it('blocks self-approval in the service and at the DB CHECK backstop', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { approvals } = services(db);
      const manager = actorFor(tenant, 'manager');

      await expect(
        approvals.approve(manager, {
          action: 'price_override',
          requestedByUserId: manager.userId,
          approverPin: '1234',
        }),
      ).rejects.toThrow(BadRequestException);

      // Backstop: the CHECK (requested_by_user_id <> approved_by_user_id)
      // rejects the same pair even when written directly.
      await expect(
        db
          .insertInto('approval_events')
          .values({
            tenant_id: tenant.tenantId,
            order_id: null,
            action: 'price_override',
            amount_pence: 100n,
            reason: null,
            requested_by_user_id: manager.userId,
            approved_by_user_id: manager.userId,
          })
          .execute(),
      ).rejects.toThrow();
    });
  });

  it('rejects a wrong PIN, accepts the seeded PIN, and rejects a user with no PIN set', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { approvals } = services(db);
      const manager = actorFor(tenant, 'manager');
      const base = {
        action: 'cash_paid_out' as const,
        amountPence: 2000n,
        requestedByUserId: tenant.users.cashier.id,
        approverPin: '9999',
      };

      await expect(approvals.approve(manager, base)).rejects.toThrow(ForbiddenException);

      const row = await approvals.approve(manager, { ...base, approverPin: '1234' });
      expect(row.action).toBe('cash_paid_out');

      const noPin = await db
        .insertInto('users')
        .values({
          tenant_id: tenant.tenantId,
          email: 'nopin@acmeretailltd.test',
          display_name: 'No Pin User',
          pin_hash: null,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const noPinActor: Actor = {
        tenantId: tenant.tenantId,
        userId: noPin.id,
        locationId: tenant.locationId,
        roles: ['manager'],
      };
      await expect(
        approvals.approve(noPinActor, { ...base, approverPin: '1234' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('ApprovalService — hasApproval', () => {
  it('finds an approval by id/action/amount and rejects mismatches', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { approvals } = services(db);
      const manager = actorFor(tenant, 'manager');
      const row = await approvals.approve(manager, {
        action: 'discount_above_limit',
        amountPence: 500n,
        requestedByUserId: tenant.users.cashier.id,
        approverPin: '1234',
      });

      expect(
        await approvals.hasApproval(db, {
          tenantId: tenant.tenantId,
          approvalEventsId: row.id,
          action: 'discount_above_limit',
        }),
      ).toBe(true);
      expect(
        await approvals.hasApproval(db, {
          tenantId: tenant.tenantId,
          approvalEventsId: row.id,
          action: 'discount_above_limit',
          minAmountPence: 500n,
        }),
      ).toBe(true);
      expect(
        await approvals.hasApproval(db, {
          tenantId: tenant.tenantId,
          approvalEventsId: row.id,
          action: 'discount_above_limit',
          minAmountPence: 501n,
        }),
      ).toBe(false);
      expect(
        await approvals.hasApproval(db, {
          tenantId: tenant.tenantId,
          approvalEventsId: row.id,
          action: 'price_override',
        }),
      ).toBe(false);
      expect(
        await approvals.hasApproval(db, {
          tenantId: '00000000-0000-0000-0000-000000000000',
          approvalEventsId: row.id,
          action: 'discount_above_limit',
        }),
      ).toBe(false);
    });
  });
});

describe('discount limits', () => {
  it('returns the percentage limit per role (owner unlimited)', () => {
    expect(discountLimitForRoles(['cashier'])).toBe(0);
    expect(discountLimitForRoles(['manager'])).toBe(10);
    expect(discountLimitForRoles(['admin'])).toBe(25);
    expect(discountLimitForRoles(['owner'])).toBeNull();
    expect(discountLimitForRoles(['cashier', 'manager'])).toBe(10);
  });
});

describe('D-08 till-close variance', () => {
  it('threshold is the higher of £10 or 2% (round half up)', () => {
    // 2% of £100 (10000p) is £2 — below the £10 floor.
    expect(ApprovalService.varianceThresholdPence(10000n)).toBe(1000n);
    // 2% of £1000 (100000p) is £20 — above the floor.
    expect(ApprovalService.varianceThresholdPence(100000n)).toBe(2000n);
    // 2% of 100025p is 2000.5p — rounds half up to 2001p.
    expect(ApprovalService.varianceThresholdPence(100025n)).toBe(2001n);
    expect(ApprovalService.varianceThresholdPence(0n)).toBe(1000n);
  });

  it('needs approval only when the variance exceeds the threshold', () => {
    expect(ApprovalService.varianceNeedsApproval(10000n, 10000n)).toBe(false);
    expect(ApprovalService.varianceNeedsApproval(10000n, 11000n)).toBe(false);
    expect(ApprovalService.varianceNeedsApproval(10000n, 11001n)).toBe(true);
    expect(ApprovalService.varianceNeedsApproval(10000n, 9000n)).toBe(false);
    expect(ApprovalService.varianceNeedsApproval(10000n, 8999n)).toBe(true);
    expect(ApprovalService.varianceNeedsApproval(100000n, 102000n)).toBe(false);
    expect(ApprovalService.varianceNeedsApproval(100000n, 102001n)).toBe(true);
    expect(ApprovalService.varianceNeedsApproval(100000n, 98000n)).toBe(false);
    expect(ApprovalService.varianceNeedsApproval(100000n, 97999n)).toBe(true);
  });
});

describe('AuditService — hash chain', () => {
  it('chains events, detects a tampered hash, and scopes listing by tenant', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { audit } = services(db);
      const userId = tenant.users.manager.id;

      await audit.record(db, {
        tenantId: tenant.tenantId,
        userId,
        eventType: 'order.created',
        entityType: 'order',
        entityId: null,
        payload: { n: 1 },
      });
      await audit.record(db, {
        tenantId: tenant.tenantId,
        userId,
        eventType: 'order.created',
        entityType: 'order',
        entityId: null,
        payload: { n: 2 },
      });
      await audit.record(db, {
        tenantId: tenant.tenantId,
        userId,
        eventType: 'till.closed',
        entityType: 'register_session',
        entityId: null,
        payload: { n: 3 },
      });

      expect(await audit.verifyChain(tenant.tenantId)).toEqual({ ok: true });

      // Tamper: INSERT a row with a deliberately wrong event_hash (the
      // trigger only blocks UPDATE/DELETE, so this insert succeeds).
      const latest = await db
        .selectFrom('audit_events')
        .select('event_hash')
        .where('tenant_id', '=', tenant.tenantId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('audit_events')
        .values({
          tenant_id: tenant.tenantId,
          user_id: null,
          event_type: 'order.created',
          entity_type: null,
          entity_id: null,
          payload: { n: 4 },
          prev_hash: latest.event_hash,
          event_hash: 'tampered-hash-that-matches-nothing',
        })
        .execute();

      const broken = await audit.verifyChain(tenant.tenantId);
      expect(broken.ok).toBe(false);
      expect(broken.brokenIndex).toBe(3);

      // Tenant scoping: a second tenant's events never appear for tenant A.
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      await audit.record(db, {
        tenantId: other.tenantId,
        userId: other.users.manager.id,
        eventType: 'order.created',
        entityType: 'order',
        entityId: null,
        payload: { n: 1 },
      });

      const listed = await audit.listEvents(tenant.tenantId);
      expect(listed).toHaveLength(4);
      expect(listed.every((row) => row.tenant_id === tenant.tenantId)).toBe(true);
      // Newest first. The tampered row was inserted directly (not via
      // record), so its stored payload is exactly what was inserted.
      expect(listed[0]?.event_type).toBe('order.created');
      expect(listed[0]?.payload).toEqual({ n: 4 });

      const filtered = await audit.listEvents(tenant.tenantId, { eventType: 'till.closed' });
      expect(filtered).toHaveLength(1);

      const otherListed = await audit.listEvents(other.tenantId);
      expect(otherListed).toHaveLength(1);
      expect(otherListed[0]?.tenant_id).toBe(other.tenantId);
      expect(await audit.verifyChain(other.tenantId)).toEqual({ ok: true });
    });
  });

  it('record() inside a caller transaction commits with it, and rolls back with it', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { audit } = services(db);
      const userId = tenant.users.manager.id;
      const input = {
        tenantId: tenant.tenantId,
        userId,
        eventType: 'order.created',
        entityType: 'order',
        entityId: null,
        payload: { n: 1 },
      };

      // Regression: Kysely 0.28 Transaction.transaction() throws
      // unconditionally, so record(trx, ...) used to throw for every
      // caller that already owned a transaction (sales worked around it
      // with a private duplicate of this logic — now deleted).
      await db.transaction().execute(async (trx) => {
        await audit.record(trx, input);
      });
      expect(await audit.verifyChain(tenant.tenantId)).toEqual({ ok: true });
      expect(await audit.listEvents(tenant.tenantId)).toHaveLength(1);

      // Rollback: the audit row must disappear with the caller's work.
      await expect(
        db.transaction().execute(async (trx) => {
          await audit.record(trx, { ...input, payload: { n: 2 } });
          throw new Error('caller rolls back');
        }),
      ).rejects.toThrow('caller rolls back');
      expect(await audit.listEvents(tenant.tenantId)).toHaveLength(1);
      expect(await audit.verifyChain(tenant.tenantId)).toEqual({ ok: true });
    });
  });
});
