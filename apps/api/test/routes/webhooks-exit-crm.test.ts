/**
 * Route tests — Group A (webhooks, exit, CRM export/erase) — Build-04 Worker 4.
 *
 * Proves the thin controllers over WebhookService, ExitService,
 * ExportService and GdprService: webhook endpoints + DLQ replay/discard,
 * exit status/termination/export-window/full-export/hard-delete, and
 * per-customer GDPR export/erasure. Happy path, cross-tenant 404,
 * wrong-scope rejection (via the real AuthGuard) and the D-11 409 with
 * the exact blocking ids are asserted per group.
 */
import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
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
import { AuditService } from '../../src/modules/admin/audit.service';
import { CrmController } from '../../src/modules/admin/crm.controller';
import { CrmService } from '../../src/modules/admin/crm.service';
import { ExitController } from '../../src/modules/admin/exit.controller';
import {
  ExitService,
  TenantWriteGuard,
  TerminationBlockedError,
} from '../../src/modules/admin/exit.service';
import { ExportService } from '../../src/modules/admin/export.service';
import { GdprService } from '../../src/modules/admin/gdpr.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { RETRY_DELAYS_MS } from '../../src/modules/integrations/webhook-catalog';
import { WebhookService } from '../../src/modules/integrations/webhook.service';
import { WebhooksController } from '../../src/modules/integrations/webhooks.controller';
import {
  actorFor,
  guardContext,
  makeApiKey,
  makeGuard,
  reqFor,
  withDb,
} from './helpers';

function makeExit(db: Kysely<DB>) {
  const audit = new AuditService(db);
  const exit = new ExitService(db, audit);
  const exportsSvc = new ExportService(db, audit);
  const gdpr = new GdprService(db, audit, exit, exportsSvc);
  return { audit, exit, exportsSvc, gdpr };
}

async function seedOpenSession(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const row = await db
    .insertInto('register_sessions')
    .values({
      tenant_id: tenant.tenantId,
      register_id: tenant.registerId,
      opened_by_user_id: tenant.users.manager.id,
      opened_at: new Date('2026-11-13T08:00:00Z'),
      float_pence: 5000n,
      status: 'open',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedCustomer(db: Kysely<DB>, tenant: SeededTenant) {
  const customer = await db
    .insertInto('customers')
    .values({
      tenant_id: tenant.tenantId,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return customer.id;
}

describe('WebhooksController — endpoints', () => {
  it('registers an endpoint (secret shown once) and lists it without any secret hash', async () => {
    await withDb(async ({ db, tenant }) => {
      const webhooks = new WebhookService(db, new AuditService(db), { deliver: async () => 200 });
      const controller = new WebhooksController(webhooks);
      const actor = actorFor(tenant, 'admin');
      const registered = await controller.registerEndpoint(reqFor(actor), {
        url: 'https://example.test/hook',
        eventTypes: ['order.completed'],
      });
      expect(registered.endpoint.url).toBe('https://example.test/hook');
      expect(typeof registered.secret).toBe('string');
      expect(registered.secret).toMatch(/^[0-9a-f]{64}$/);
      expect('secret_hash' in registered.endpoint).toBe(false);

      const listed = await controller.listEndpoints(reqFor(actor));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.url).toBe('https://example.test/hook');
      expect('secret_hash' in (listed[0] as Record<string, unknown>)).toBe(false);
      expect(JSON.stringify(listed)).not.toContain(registered.secret);

      await expect(
        controller.registerEndpoint(reqFor(actor), { url: 'http://example.test/hook', eventTypes: ['order.completed'] }),
      ).rejects.toThrow('HTTPS');
    });
  });

  it('returns an empty list (not 404) when the tenant has no endpoints', async () => {
    await withDb(async ({ db, tenant }) => {
      const webhooks = new WebhookService(db, new AuditService(db), { deliver: async () => 200 });
      const controller = new WebhooksController(webhooks);
      expect(await controller.listEndpoints(reqFor(actorFor(tenant, 'admin')))).toEqual([]);
    });
  });
});

describe('WebhooksController — dead-letter queue', () => {
  /** Drive one delivery to dead_letter, then return its id. */
  async function seedDeadLetter(
    db: Kysely<DB>,
    tenant: SeededTenant,
    webhooks: WebhookService,
    nowRef: { now: Date },
  ): Promise<string> {
    await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);
    const published = await webhooks.publish('order.completed', {
      tenant_id: tenant.tenantId,
      order_id: '00000000-0000-0000-0000-000000000001',
      total_pence: 1200,
    });
    const deliveryId = published.deliveryIds[0] as string;
    let expectedTime = nowRef.now.getTime();
    for (let attempt = 2; attempt <= 11; attempt += 1) {
      expectedTime += RETRY_DELAYS_MS[attempt - 2] as number;
      nowRef.now = new Date(expectedTime);
      await webhooks.processDueDeliveries(nowRef.now);
    }
    expect((await webhooks.getDelivery(deliveryId))?.status).toBe('dead_letter');
    return deliveryId;
  }

  it('replays a dead-letter delivery to delivered and discards another explicitly', async () => {
    await withDb(async ({ db, tenant }) => {
      let statusCode = 500;
      const nowRef = { now: new Date('2026-11-13T12:00:00.000Z') };
      const webhooks = new WebhookService(db, new AuditService(db), {
        deliver: async () => statusCode,
        clock: () => nowRef.now,
      });
      const controller = new WebhooksController(webhooks);
      const actor = actorFor(tenant, 'admin');

      const replayId = await seedDeadLetter(db, tenant, webhooks, nowRef);
      const discardId = await seedDeadLetter(db, tenant, webhooks, nowRef);

      // Replay with the endpoint healthy again: success clears dead_letter.
      statusCode = 200;
      const replayed = await controller.replayDeadLetter(reqFor(actor), replayId);
      expect(replayed).toEqual({ id: replayId, status: 'delivered' });

      // A replayed delivery can no longer be replayed or discarded.
      await expect(controller.replayDeadLetter(reqFor(actor), replayId)).rejects.toThrow(
        'Only a dead-letter delivery can be replayed',
      );

      const discarded = await controller.discardDeadLetter(reqFor(actor), discardId);
      expect(discarded.id).toBe(discardId);
      // The service marks an explicit discard as 'failed' with an
      // operator-discard note (never auto-deleted, never black-holed).
      expect(discarded.status).toBe('failed');
      expect((await webhooks.getDelivery(discardId))?.last_error).toContain('discarded by operator');
    });
  });

  it('returns 404 when replaying a delivery of another tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const nowRef = { now: new Date('2026-11-13T12:00:00.000Z') };
      const webhooks = new WebhookService(db, new AuditService(db), {
        deliver: async () => 500,
        clock: () => nowRef.now,
      });
      const controller = new WebhooksController(webhooks);
      await webhooks.registerEndpoint(tenantA.tenantId, 'https://example.test/hook', ['order.completed']);
      const published = await webhooks.publish('order.completed', {
        tenant_id: tenantA.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 1200,
      });
      const deliveryId = published.deliveryIds[0] as string;
      let expectedTime = nowRef.now.getTime();
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        expectedTime += RETRY_DELAYS_MS[attempt - 2] as number;
        nowRef.now = new Date(expectedTime);
        await webhooks.processDueDeliveries(nowRef.now);
      }
      await expect(
        controller.replayDeadLetter(reqFor(actorFor(tenantB, 'admin')), deliveryId),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('rejects non-admin credentials at the guard (admin scope required)', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const handler = WebhooksController.prototype.listEndpoints;
      await expect(guard.canActivate(guardContext(handler, {}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      const salesKey = await makeApiKey(db, tenant.tenantId, ['sales:read']);
      await expect(
        guard.canActivate(guardContext(handler, { authorization: `Bearer ${salesKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const sessions = new SessionService(db);
      const owner = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.owner.id,
        pin: '1234',
      });
      expect(
        await guard.canActivate(guardContext(handler, { authorization: `Bearer ${owner.token}` })),
      ).toBe(true);
    });
  });
});

describe('ExitController — termination state machine', () => {
  it('reports status, requests termination, opens the export window, runs the full export', async () => {
    await withDb(async ({ db, tenant }) => {
      const { exit, exportsSvc } = makeExit(db);
      exit.setClock(() => new Date('2026-11-13T12:00:00Z'));
      const controller = new ExitController(exit, exportsSvc);
      const actor = actorFor(tenant, 'owner');

      const status = await controller.getStatus(reqFor(actor));
      expect(status).toMatchObject({
        tenantId: tenant.tenantId,
        status: 'active',
        exportWindowEndsAt: null,
        openSessionIds: [],
        blockingPaymentAttemptIds: [],
      });

      const requested = await controller.requestTermination(reqFor(actor));
      expect(requested.status).toBe('termination_requested');

      const inWindow = await controller.beginExportWindow(reqFor(actor));
      expect(inWindow.status).toBe('export_window');
      expect(inWindow.exportWindowEndsAt).toBe('2026-12-13T12:00:00.000Z');

      // The full export runs INSIDE the export window (it is not
      // TenantWriteGuarded — the window exists so data can leave).
      const result = await controller.runFullExport(reqFor(actor));
      expect(typeof result.jobId).toBe('string');
      expect(result.files['manifest.json']).toBeDefined();
      expect(result.manifest.length).toBeGreaterThan(0);
      for (const entry of result.manifest) {
        expect(entry.sha256_checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  it('blocks termination with 409 carrying the exact open-session ids (D-11)', async () => {
    await withDb(async ({ db, tenant }) => {
      const { exit, exportsSvc } = makeExit(db);
      const sessionId = await seedOpenSession(db, tenant);
      const controller = new ExitController(exit, exportsSvc);
      let caught: TerminationBlockedError | undefined;
      try {
        await controller.requestTermination(reqFor(actorFor(tenant, 'owner')));
      } catch (error) {
        caught = error as TerminationBlockedError;
      }
      expect(caught).toBeInstanceOf(TerminationBlockedError);
      expect(caught).toBeInstanceOf(ConflictException);
      const response = caught?.getResponse() as {
        openSessionIds: string[];
        blockingPaymentAttemptIds: string[];
      };
      expect(response.openSessionIds).toEqual([sessionId]);
      expect(response.blockingPaymentAttemptIds).toEqual([]);
    });
  });

  it('schedules hard deletion only after the 30-day window has ended', async () => {
    await withDb(async ({ db, tenant }) => {
      const { exit, exportsSvc } = makeExit(db);
      const controller = new ExitController(exit, exportsSvc);
      const actor = actorFor(tenant, 'owner');
      let now = new Date('2026-11-13T12:00:00Z');
      exit.setClock(() => now);
      await controller.requestTermination(reqFor(actor));
      await controller.beginExportWindow(reqFor(actor));

      // Window still open: scheduling is rejected.
      await expect(controller.scheduleHardDelete(reqFor(actor))).rejects.toThrow(
        'has not ended yet',
      );

      // 31 days later: scheduling succeeds.
      now = new Date('2026-12-14T12:00:00Z');
      const scheduled = await controller.scheduleHardDelete(reqFor(actor));
      expect(scheduled.status).toBe('hard_delete_scheduled');
    });
  });

  it('TenantWriteGuard blocks writes once the tenant is in the export window', async () => {
    await withDb(async ({ db, tenant }) => {
      const { exit, exportsSvc } = makeExit(db);
      exit.setClock(() => new Date('2026-11-13T12:00:00Z'));
      const controller = new ExitController(exit, exportsSvc);
      const actor = actorFor(tenant, 'owner');
      await controller.requestTermination(reqFor(actor));
      await controller.beginExportWindow(reqFor(actor));

      const guard = new TenantWriteGuard(exit);
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-tenant-id': tenant.tenantId } }),
        }),
      } as unknown as Parameters<TenantWriteGuard['canActivate']>[0];
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('CrmController — lists, GDPR export and erasure', () => {
  it('lists customers, consents, loyalty, gift cards and store credit (tenant-scoped)', async () => {
    await withDb(async ({ db, tenant }) => {
      const crm = new CrmService(db);
      const { gdpr } = makeExit(db);
      const controller = new CrmController(crm, gdpr);
      const actor = actorFor(tenant, 'manager');
      const customerId = await seedCustomer(db, tenant);

      await db.insertInto('marketing_consents').values({
        tenant_id: tenant.tenantId,
        customer_id: customerId,
        purpose: 'marketing',
        channel: 'email',
        consented: true,
        recorded_by_user_id: tenant.users.manager.id,
      }).execute();
      const membership = await db.insertInto('loyalty_memberships').values({
        tenant_id: tenant.tenantId,
        customer_id: customerId,
        membership_number: 'LM-0001',
        status: 'active',
      }).returning('id').executeTakeFirstOrThrow();
      await db.insertInto('loyalty_ledger').values({
        tenant_id: tenant.tenantId,
        customer_id: customerId,
        membership_id: membership.id,
        kind: 'earn',
        points: 250n,
        order_id: null,
        reason: 'signup bonus',
        idempotency_key: randomUUID(),
        reverses_ledger_id: null,
      }).execute();
      await db.insertInto('gift_cards').values({
        tenant_id: tenant.tenantId,
        code_hash: createHash('sha256').update('ABCD-EFGH-JKLM-NPQR').digest('hex'),
        code_last4: 'NPQR',
        initial_amount_pence: 5000n,
        balance_pence: 3000n,
        currency: 'GBP',
        status: 'active',
        expires_at: null,
      }).execute();
      await db.insertInto('store_credit_ledger').values({
        tenant_id: tenant.tenantId,
        customer_id: customerId,
        kind: 'issue',
        amount_pence: 1000n,
        order_id: null,
        idempotency_key: randomUUID(),
      }).execute();

      const customers = await controller.listCustomers(reqFor(actor));
      expect(customers.map((c) => c.id)).toContain(customerId);

      const consents = await controller.listConsents(reqFor(actor), customerId);
      expect(consents).toHaveLength(1);
      expect(consents[0]?.purpose).toBe('marketing');

      const ledger = await controller.listLoyaltyLedger(reqFor(actor), customerId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.points).toBe('250');

      const cards = await controller.listGiftCards(reqFor(actor));
      expect(cards).toHaveLength(1);
      expect(cards[0]?.code_last4).toBe('NPQR');
      expect(cards[0]?.balance_pence).toBe('3000');
      // No hash — and no full code — ever leaves the API.
      expect('code_hash' in (cards[0] as Record<string, unknown>)).toBe(false);
      expect(JSON.stringify(cards)).not.toContain('ABCD-EFGH-JKLM-NPQR');

      const credit = await controller.listStoreCredit(reqFor(actor), customerId);
      expect(credit).toEqual([
        expect.objectContaining({ kind: 'issue', amount_pence: '1000' }),
      ]);
    });
  });

  it('returns 404 for a per-customer list under another tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const crm = new CrmService(db);
      const { gdpr } = makeExit(db);
      const controller = new CrmController(crm, gdpr);
      const customerId = await seedCustomer(db, tenantA);
      await expect(
        controller.listConsents(reqFor(actorFor(tenantB, 'manager')), customerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.listLoyaltyLedger(reqFor(actorFor(tenantB, 'manager')), customerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.listStoreCredit(reqFor(actorFor(tenantB, 'manager')), customerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      // List endpoints are tenant-scoped: the other tenant sees nothing.
      expect(await controller.listCustomers(reqFor(actorFor(tenantB, 'manager')))).toEqual([]);
      expect(await controller.listGiftCards(reqFor(actorFor(tenantB, 'manager')))).toEqual([]);
    } finally {
      await close();
    }
  });

  it('exports a customer (files + manifest) and erases them (PII deleted, consents gone)', async () => {
    await withDb(async ({ db, tenant }) => {
      const crm = new CrmService(db);
      const { gdpr } = makeExit(db);
      const controller = new CrmController(crm, gdpr);
      const actor = actorFor(tenant, 'admin');
      const customerId = await seedCustomer(db, tenant);
      await db.insertInto('marketing_consents').values({
        tenant_id: tenant.tenantId,
        customer_id: customerId,
        purpose: 'marketing',
        channel: 'email',
        consented: true,
        recorded_by_user_id: tenant.users.manager.id,
      }).execute();

      const exported = await controller.exportCustomer(reqFor(actor), customerId);
      expect(exported.customerId).toBe(customerId);
      expect(exported.files['customers.csv']).toContain('Ada');
      expect(exported.files['manifest.json']).toBeDefined();
      expect(exported.totalRows).toBeGreaterThanOrEqual(1);

      const erased = await controller.eraseCustomer(reqFor(actor), customerId);
      expect(erased.customerId).toBe(customerId);
      expect(typeof erased.placeholderCustomerId).toBe('string');
      expect(
        await db.selectFrom('customers').select('id').where('id', '=', customerId).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db.selectFrom('marketing_consents').select('id').where('customer_id', '=', customerId).execute(),
      ).toHaveLength(0);
      await expect(controller.exportCustomer(reqFor(actor), customerId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('requires admin scope for erasure at the guard', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const handler = CrmController.prototype.eraseCustomer;
      const salesKey = await makeApiKey(db, tenant.tenantId, ['sales:read']);
      await expect(
        guard.canActivate(guardContext(handler, { authorization: `Bearer ${salesKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      expect(
        await guard.canActivate(guardContext(handler, { authorization: `Bearer ${adminKey}` })),
      ).toBe(true);
    });
  });
});

describe('CrmController — assignCustomerToGroup (Build-12 Objective 3)', () => {
  async function seedGroup(db: Kysely<DB>, tenant: SeededTenant, name = 'VIP Customers'): Promise<string> {
    const group = await db
      .insertInto('customer_groups')
      .values({ tenant_id: tenant.tenantId, name, description: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    return group.id;
  }

  it('assigns a customer to a group; a repeat call returns the same membership, no duplicate row', async () => {
    await withDb(async ({ db, tenant }) => {
      const crm = new CrmService(db);
      const { gdpr } = makeExit(db);
      const controller = new CrmController(crm, gdpr);
      const actor = actorFor(tenant, 'admin');
      const customerId = await seedCustomer(db, tenant);
      const groupId = await seedGroup(db, tenant);
      const first = await controller.assignCustomerToGroup(reqFor(actor), customerId, {
        groupId,
      });
      expect(first.customer_id).toBe(customerId);
      expect(first.group_id).toBe(groupId);
      expect(typeof first.created_at).toBe('string');
      const second = await controller.assignCustomerToGroup(reqFor(actor), customerId, {
        groupId,
      });
      // Idempotent: the same membership, same created_at, still one row.
      expect(second.created_at).toBe(first.created_at);
      const rows = await db
        .selectFrom('customer_group_memberships')
        .selectAll()
        .where('customer_id', '=', customerId)
        .where('group_id', '=', groupId)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  it('returns 404 for an unknown customer, an unknown group, or a cross-tenant pair', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const crm = new CrmService(db);
      const { gdpr } = makeExit(db);
      const controller = new CrmController(crm, gdpr);
      const customerA = await seedCustomer(db, tenantA);
      const groupA = await seedGroup(db, tenantA);
      const customerB = await seedCustomer(db, tenantB);
      const groupB = await seedGroup(db, tenantB);
      const actorA = actorFor(tenantA, 'admin');
      await expect(
        controller.assignCustomerToGroup(reqFor(actorA), '00000000-0000-0000-0000-000000000000', {
          groupId: groupA,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.assignCustomerToGroup(reqFor(actorA), customerA, {
          groupId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Cross-tenant in both directions: another tenant's customer,
      // and another tenant's group, are both 404 (G-B).
      await expect(
        controller.assignCustomerToGroup(reqFor(actorA), customerB, { groupId: groupA }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.assignCustomerToGroup(reqFor(actorA), customerA, { groupId: groupB }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('requires admin scope for group assignment at the guard', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const handler = CrmController.prototype.assignCustomerToGroup;
      const salesKey = await makeApiKey(db, tenant.tenantId, ['sales:read']);
      await expect(
        guard.canActivate(guardContext(handler, { authorization: `Bearer ${salesKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      expect(
        await guard.canActivate(guardContext(handler, { authorization: `Bearer ${adminKey}` })),
      ).toBe(true);
    });
  });
});
