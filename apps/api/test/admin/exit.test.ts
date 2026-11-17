/**
 * Exit tests (Build-03, Objective 4) — tenant exit state machine
 * (D-11), read-only enforcement, single-click full export, per-customer
 * GDPR export + erasure, hard deletion, backup/restore verification.
 *
 * Each test creates its own PGlite database (createTestDb) and seeds
 * one tenant. No real HTTP, no real clock waiting — time is advanced
 * through ExitService.setClock().
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, seedVariant, setStock } from '@uk-pos/db';
import type { DB, SeededTenant } from '@uk-pos/db';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuditService } from '../../src/modules/admin/audit.service';
import {
  ExitService,
  TenantWriteGuard,
  TerminationBlockedError,
} from '../../src/modules/admin/exit.service';
import { ExportService } from '../../src/modules/admin/export.service';
import { GdprService } from '../../src/modules/admin/gdpr.service';
import { WebhookService } from '../../src/modules/integrations/webhook.service';

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

function services(db: Kysely<DB>): {
  audit: AuditService;
  exit: ExitService;
  exports: ExportService;
  gdpr: GdprService;
} {
  const audit = new AuditService(db);
  const exit = new ExitService(db, audit);
  const exports = new ExportService(db, audit);
  const gdpr = new GdprService(db, audit, exit, exports);
  return { audit, exit, exports, gdpr };
}

async function insertOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  overrides: {
    status?: 'draft' | 'pending_payment' | 'completed' | 'voided' | 'partially_returned' | 'returned';
    orderNumber?: bigint;
    customerId?: string | null;
    totalPence?: bigint;
  } = {},
): Promise<string> {
  const row = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      register_id: tenant.registerId,
      customer_id: overrides.customerId ?? null,
      order_number: overrides.orderNumber ?? 1n,
      business_date: '2026-11-13',
      status: overrides.status ?? 'draft',
      subtotal_pence: 1000n,
      discount_pence: 0n,
      tax_pence: 200n,
      total_pence: overrides.totalPence ?? 1200n,
      created_by_user_id: tenant.users.cashier.id,
      completed_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertPaymentAttempt(
  db: Kysely<DB>,
  tenant: SeededTenant,
  orderId: string,
  status: 'created' | 'pending' | 'approved' | 'declined' | 'unknown' | 'refunded',
): Promise<string> {
  const row = await db
    .insertInto('payment_attempts')
    .values({
      tenant_id: tenant.tenantId,
      order_id: orderId,
      idempotency_key: `key-${status}-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'stripe',
      provider_reference: null,
      status,
      amount_pence: 1200n,
      currency: 'GBP',
      attempt_number: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertSession(
  db: Kysely<DB>,
  tenant: SeededTenant,
  status: 'open' | 'ended' | 'closed',
): Promise<string> {
  const row = await db
    .insertInto('register_sessions')
    .values({
      tenant_id: tenant.tenantId,
      register_id: tenant.registerId,
      opened_by_user_id: tenant.users.cashier.id,
      float_pence: 5000n,
      status,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertCustomer(
  db: Kysely<DB>,
  tenant: SeededTenant,
  overrides: { firstName?: string; email?: string | null; phone?: string | null } = {},
): Promise<string> {
  const row = await db
    .insertInto('customers')
    .values({
      tenant_id: tenant.tenantId,
      first_name: overrides.firstName ?? 'Test',
      last_name: 'Customer',
      email: overrides.email ?? 'test.customer@example.test',
      phone: overrides.phone ?? '07123456789',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Drive a tenant to hard_delete_scheduled (window ended) using the service clocks. */
async function driveToHardDeleteScheduled(
  db: Kysely<DB>,
  tenant: SeededTenant,
  exit: ExitService,
  gdpr: GdprService,
  startAt: Date,
): Promise<void> {
  let now = startAt;
  exit.setClock(() => now);
  gdpr.setClock(() => now);
  await exit.requestTermination(tenant.tenantId, tenant.users.owner.id);
  await exit.beginExportWindow(tenant.tenantId, tenant.users.owner.id);
  now = new Date(startAt.getTime() + 31 * 24 * 60 * 60 * 1000);
  exit.setClock(() => now);
  gdpr.setClock(() => now);
  await exit.scheduleHardDelete(tenant.tenantId, tenant.users.owner.id);
}

describe('ExitService — state machine (Arch-01 §4.2)', () => {
  it('walks active -> termination_requested -> export_window -> hard_delete_scheduled -> deleted', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit, gdpr } = services(db);
      const startAt = new Date('2026-11-13T12:00:00.000Z');
      let now = startAt;
      exit.setClock(() => now);
      gdpr.setClock(() => now);

      const requested = await exit.requestTermination(tenant.tenantId, tenant.users.owner.id);
      expect(requested.status).toBe('termination_requested');
      expect(requested.termination_requested_at?.getTime()).toBe(startAt.getTime());

      const { tenant: inWindow, windowEndsAt } = await exit.beginExportWindow(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(inWindow.status).toBe('export_window');
      expect(windowEndsAt.getTime()).toBe(startAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      const windowRow = await db
        .selectFrom('tenant_export_windows')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(windowRow.status).toBe('open');
      expect(windowRow.window_ends_at.getTime()).toBe(windowEndsAt.getTime());

      // The window has not ended yet: scheduling hard deletion is rejected.
      await expect(exit.scheduleHardDelete(tenant.tenantId)).rejects.toThrow(BadRequestException);

      now = new Date(startAt.getTime() + 31 * 24 * 60 * 60 * 1000);
      const scheduled = await exit.scheduleHardDelete(tenant.tenantId, tenant.users.owner.id);
      expect(scheduled.status).toBe('hard_delete_scheduled');
      expect(scheduled.hard_delete_scheduled_at?.getTime()).toBe(now.getTime());

      const deleted = await gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);
      expect(deleted.verifiedRowCount).toBe(0);
      const tombstone = await db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(tombstone.status).toBe('deleted');
      expect(tombstone.deleted_at?.getTime()).toBe(now.getTime());
      expect(tombstone.name).toBe('[deleted]');
      expect(tombstone.legal_name).toBeNull();
      expect(tombstone.vat_number).toBeNull();
    });
  });

  it('rejects invalid transitions', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit } = services(db);
      await expect(exit.beginExportWindow(tenant.tenantId)).rejects.toThrow(
        "from status 'termination_requested'",
      );
      await expect(exit.scheduleHardDelete(tenant.tenantId)).rejects.toThrow(
        "from status 'export_window'",
      );
      await exit.requestTermination(tenant.tenantId);
      await expect(exit.requestTermination(tenant.tenantId)).rejects.toThrow(
        "from status 'active'",
      );
    });
  });

  it('D-11: blocks termination on open sessions and pending/unknown payments, returning exact ids', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit } = services(db);
      const orderId = await insertOrder(db, tenant);
      const sessionId = await insertSession(db, tenant, 'open');
      const pendingId = await insertPaymentAttempt(db, tenant, orderId, 'pending');
      const unknownId = await insertPaymentAttempt(db, tenant, orderId, 'unknown');
      // Resolved attempts do not block.
      await insertPaymentAttempt(db, tenant, orderId, 'approved');
      await insertPaymentAttempt(db, tenant, orderId, 'declined');

      let caught: TerminationBlockedError | undefined;
      try {
        await exit.requestTermination(tenant.tenantId);
      } catch (error) {
        caught = error as TerminationBlockedError;
      }
      expect(caught).toBeInstanceOf(TerminationBlockedError);
      expect(caught?.openSessionIds).toEqual([sessionId]);
      expect(caught?.blockingPaymentAttemptIds).toEqual(
        expect.arrayContaining([pendingId, unknownId]),
      );
      expect(caught?.blockingPaymentAttemptIds).toHaveLength(2);

      // Resolve the blockers: close the session, resolve the attempts.
      await db
        .updateTable('register_sessions')
        .set({ status: 'closed', closed_at: new Date() })
        .where('id', '=', sessionId)
        .execute();
      await db
        .updateTable('payment_attempts')
        .set({ status: 'approved' })
        .where('id', 'in', [pendingId, unknownId])
        .execute();

      const requested = await exit.requestTermination(tenant.tenantId);
      expect(requested.status).toBe('termination_requested');
    });
  });
});

describe('ExitService — read-only mode and TenantWriteGuard', () => {
  it('assertTenantWritable passes while active and blocks in export_window and later', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit } = services(db);
      expect((await exit.assertTenantWritable(tenant.tenantId)).status).toBe('active');

      exit.setClock(() => new Date('2026-11-13T12:00:00.000Z'));
      await exit.requestTermination(tenant.tenantId);
      // termination_requested is still writable (termination has not taken effect).
      expect((await exit.assertTenantWritable(tenant.tenantId)).status).toBe('termination_requested');

      await exit.beginExportWindow(tenant.tenantId);
      await expect(exit.assertTenantWritable(tenant.tenantId)).rejects.toThrow(ForbiddenException);
    });
  });

  it('TenantWriteGuard allows active tenants, blocks read-only ones, and fails closed without a tenant', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit } = services(db);
      const guard = new TenantWriteGuard(exit);
      const contextFor = (tenantId: string | undefined) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: tenantId === undefined ? {} : { 'x-tenant-id': tenantId },
            }),
          }),
        }) as never;

      expect(await guard.canActivate(contextFor(tenant.tenantId))).toBe(true);
      await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow(BadRequestException);

      exit.setClock(() => new Date('2026-11-13T12:00:00.000Z'));
      await exit.requestTermination(tenant.tenantId);
      await exit.beginExportWindow(tenant.tenantId);
      await expect(guard.canActivate(contextFor(tenant.tenantId))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});

describe('ExportService — single-click full export (Arch-01 §4.3)', () => {
  it('exports every tenant table as CSV+JSON with a manifest whose checksums verify, secrets excluded', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exports: exportService } = services(db);
      // Seed merchant data across tables.
      const variant = await seedVariant(db, tenant, { pricePence: 1500n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const orderId = await insertOrder(db, tenant, { status: 'completed', totalPence: 1500n });
      await insertPaymentAttempt(db, tenant, orderId, 'approved');
      await db
        .insertInto('gift_cards')
        .values({
          tenant_id: tenant.tenantId,
          code_hash: 'abcdef0123456789',
          code_last4: '1234',
          initial_amount_pence: 2000n,
          balance_pence: 2000n,
          currency: 'GBP',
          status: 'active',
        })
        .execute();
      // A webhook endpoint (its secret_hash must never be exported).
      const webhooks = new WebhookService(db);
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);

      const result = await exportService.runFullExport(tenant.tenantId, tenant.users.owner.id);
      expect(result.totalRows).toBeGreaterThan(0);
      expect(result.fileCount).toBeGreaterThan(0);

      // Manifest: every file listed, row counts and SHA-256 checksums verify.
      const manifestContent = result.files['manifest.json'] as string;
      const manifest = JSON.parse(manifestContent) as {
        files: Array<{ file_name: string; table_name: string; row_count: number; sha256_checksum: string }>;
      };
      expect(manifest.files.length).toBe(result.fileCount);
      for (const entry of manifest.files) {
        const content = result.files[entry.file_name] as string;
        expect(content).toBeDefined();
        expect(createHash('sha256').update(content, 'utf8').digest('hex')).toBe(
          entry.sha256_checksum,
        );
      }
      // Spot-check contents.
      const ordersJson = JSON.parse(result.files['orders.json'] as string) as Array<Record<string, unknown>>;
      expect(ordersJson).toHaveLength(1);
      expect(ordersJson[0]?.total_pence).toBe('1500'); // bigint -> decimal string
      expect(ordersJson[0]?.status).toBe('completed');
      const ordersCsv = result.files['orders.csv'] as string;
      expect(ordersCsv.split('\n')[0]).toContain('order_number');

      // Secrets excluded: no password/pin hash, no webhook secret hash, no API key hash.
      const usersCsv = result.files['users.csv'] as string;
      expect(usersCsv.split('\n')[0]).not.toContain('password_hash');
      expect(usersCsv.split('\n')[0]).not.toContain('pin_hash');
      const endpointsCsv = result.files['webhook_endpoints.csv'] as string;
      expect(endpointsCsv.split('\n')[0]).not.toContain('secret_hash');
      expect(endpointsCsv).toContain('https://example.test/hook');

      // Gift/voucher codes: hash + last-4 only, as stored.
      const giftCardsJson = JSON.parse(result.files['gift_cards.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(giftCardsJson).toHaveLength(1);
      expect(giftCardsJson[0]?.code_hash).toBe('abcdef0123456789');
      expect(giftCardsJson[0]?.code_last4).toBe('1234');

      // The export job + manifest rows are recorded.
      const job = await db
        .selectFrom('export_jobs')
        .selectAll()
        .where('id', '=', result.jobId)
        .executeTakeFirstOrThrow();
      expect(job.status).toBe('completed');
      expect(Number(job.total_rows)).toBe(result.totalRows);
      const manifestRows = await db
        .selectFrom('export_manifests')
        .selectAll()
        .where('export_job_id', '=', result.jobId)
        .execute();
      expect(manifestRows.length).toBe(result.fileCount);

      // The export does not change the tenant status (no early window end).
      const tenantRow = await db
        .selectFrom('tenants')
        .select('status')
        .where('id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(tenantRow.status).toBe('active');
    });
  });
});

describe('GdprService — per-customer export and erasure (Arch-09 §5.4)', () => {
  it('exports one customer only, then erases PII while retaining anonymised orders/audit', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { gdpr, audit } = services(db);
      const customerId = await insertCustomer(db, tenant);
      const otherCustomerId = await insertCustomer(db, tenant, {
        firstName: 'Other',
        email: 'other@example.test',
      });
      const orderId = await insertOrder(db, tenant, { status: 'completed', customerId });
      await insertOrder(db, tenant, { status: 'completed', orderNumber: 2n, customerId: otherCustomerId });
      await db
        .insertInto('marketing_consents')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          purpose: 'marketing',
          channel: 'email',
          consented: true,
          recorded_by_user_id: tenant.users.manager.id,
        })
        .execute();
      await db
        .insertInto('customer_notes')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          note: 'Prefers email receipts',
          created_by_user_id: tenant.users.manager.id,
        })
        .execute();
      const membership = await db
        .insertInto('loyalty_memberships')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          membership_number: 'MEM-001',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          membership_id: membership.id,
          kind: 'earn',
          points: 120n,
          order_id: orderId,
          idempotency_key: 'earn-1',
        })
        .execute();
      await audit.record(db, {
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        eventType: 'customer.created',
        entityType: 'customer',
        entityId: customerId,
        payload: {},
      });

      // Per-customer export contains ONLY this customer.
      const exported = await gdpr.exportCustomer(tenant.tenantId, customerId, tenant.users.owner.id);
      const customersJson = JSON.parse(exported.files['customers.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(customersJson).toHaveLength(1);
      expect(customersJson[0]?.email).toBe('test.customer@example.test');
      const ordersJson = JSON.parse(exported.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(ordersJson).toHaveLength(1);
      expect(ordersJson[0]?.id).toBe(orderId);
      const ledgerJson = JSON.parse(exported.files['loyalty_ledger.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(ledgerJson).toHaveLength(1);
      expect(ledgerJson[0]?.points).toBe('120');

      // Erasure.
      const erased = await gdpr.eraseCustomer(tenant.tenantId, customerId);
      expect(erased.anonymisedOrderCount).toBe(1);
      expect(erased.anonymisedLedgerRowCount).toBe(1);

      // PII gone.
      expect(
        await db.selectFrom('customers').select('id').where('id', '=', customerId).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db
          .selectFrom('marketing_consents')
          .select('id')
          .where('customer_id', '=', customerId)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db
          .selectFrom('customer_notes')
          .select('id')
          .where('customer_id', '=', customerId)
          .executeTakeFirst(),
      ).toBeUndefined();

      // Orders retained, anonymised; the other customer's order untouched.
      const keptOrder = await db
        .selectFrom('orders')
        .select(['id', 'customer_id', 'total_pence'])
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow();
      expect(keptOrder.customer_id).toBeNull();
      expect(keptOrder.total_pence).toBe(1200n);
      const otherOrder = await db
        .selectFrom('orders')
        .select('customer_id')
        .where('order_number', '=', 2n)
        .executeTakeFirstOrThrow();
      expect(otherOrder.customer_id).toBe(otherCustomerId);

      // Ledger retained under the placeholder (financial record, no PII).
      const ledgerRow = await db
        .selectFrom('loyalty_ledger')
        .select(['customer_id', 'points'])
        .where('order_id', '=', orderId)
        .executeTakeFirstOrThrow();
      expect(ledgerRow.customer_id).toBe(erased.placeholderCustomerId);
      expect(ledgerRow.points).toBe(120n);
      const placeholder = await db
        .selectFrom('customers')
        .selectAll()
        .where('id', '=', erased.placeholderCustomerId)
        .executeTakeFirstOrThrow();
      expect(placeholder.first_name).toBe('[erased]');
      expect(placeholder.email).toBeNull();

      // Membership closed, not deleted; audit trail keeps the id, not the name.
      const membershipRow = await db
        .selectFrom('loyalty_memberships')
        .select('status')
        .where('id', '=', membership.id)
        .executeTakeFirstOrThrow();
      expect(membershipRow.status).toBe('closed');
      const auditRows = await audit.listEvents(tenant.tenantId, { eventType: 'customer.erased' });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.entity_id).toBe(customerId);
    });
  });
});

describe('GdprService — hard deletion (Arch-01 §6.3–§6.4)', () => {
  it('separates the VAT archive (PII stripped), deletes everything else, keeps the tombstone, logs the job', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit, gdpr } = services(db);
      // Merchant data across tables, including trigger-guarded rows.
      const variant = await seedVariant(db, tenant, { pricePence: 1500n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const customerId = await insertCustomer(db, tenant);
      const orderId = await insertOrder(db, tenant, {
        status: 'completed',
        customerId,
        totalPence: 1500n,
      });
      await db
        .insertInto('order_lines')
        .values({
          tenant_id: tenant.tenantId,
          order_id: orderId,
          variant_id: variant.variantId,
          quantity: 1n,
          unit_price_pence: 1500n,
          base_price_pence: 1500n,
          promotion_discount_pence: 0n,
          manual_discount_pence: 0n,
          final_price_pence: 1500n,
          tax_rate_kind: 'standard',
          tax_rate_percent: '20.00',
          tax_amount_pence: 250n,
          line_total_pence: 1500n,
        })
        .execute();
      await insertPaymentAttempt(db, tenant, orderId, 'approved');
      const vatPeriod = await db
        .insertInto('vat_periods')
        .values({
          tenant_id: tenant.tenantId,
          period_start: '2026-11-01',
          period_end: '2026-11-30',
          status: 'closed',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('vat_period_lines')
        .values({
          vat_period_id: vatPeriod.id,
          tax_rate_kind: 'standard',
          tax_rate_percent: '20.00',
          gross_pence: 1500n,
          vat_pence: 250n,
          net_pence: 1250n,
        })
        .execute();
      const sessionId = await insertSession(db, tenant, 'closed');
      void sessionId;

      await driveToHardDeleteScheduled(db, tenant, exit, gdpr, new Date('2026-11-13T12:00:00.000Z'));
      const result = await gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);

      // Archive separated: VAT + sales records present, PII stripped.
      const archiveOrders = JSON.parse(result.archive.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(archiveOrders).toHaveLength(1);
      expect(archiveOrders[0]?.id).toBe(orderId);
      expect(archiveOrders[0]?.customer_id).toBeNull();
      expect(archiveOrders[0]?.created_by_user_id).toBeNull();
      expect(archiveOrders[0]?.total_pence).toBe('1500');
      const archiveVat = JSON.parse(result.archive.files['vat_periods.json'] as string) as Array<
        Record<string, unknown>
      >;
      expect(archiveVat).toHaveLength(1);
      const archiveManifest = JSON.parse(result.archive.files['manifest.json'] as string) as {
        files: Array<{ file_name: string; sha256_checksum: string }>;
      };
      for (const entry of archiveManifest.files) {
        expect(
          createHash('sha256')
            .update(result.archive.files[entry.file_name] as string, 'utf8')
            .digest('hex'),
        ).toBe(entry.sha256_checksum);
      }

      // Zero rows remain for the tenant in every table except the tombstone.
      const remainingOrders = await db
        .selectFrom('orders')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(remainingOrders).toHaveLength(0);
      for (const table of ['customers', 'product_variants', 'stock_movements', 'audit_events', 'users', 'roles', 'z_reports', 'vat_periods'] as const) {
        const count = await db
          .selectFrom(table)
          .select('id')
          .where('tenant_id', '=', tenant.tenantId)
          .execute();
        expect(count, table).toHaveLength(0);
      }

      // Tombstone retained; deletion job logged as completed with zero verified rows.
      const tombstone = await db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(tombstone.status).toBe('deleted');
      expect(tombstone.deleted_at).not.toBeNull();
      const job = await db
        .selectFrom('deletion_jobs')
        .selectAll()
        .where('id', '=', result.jobId)
        .executeTakeFirstOrThrow();
      expect(job.status).toBe('completed');
      expect(job.verified_row_count).toBe(0);
      expect(job.tenant_id).toBe(tenant.tenantId);
    });
  });

  it('D-11 blocks hard deletion while unresolved work exists, and the job is marked failed', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exit, gdpr } = services(db);
      await driveToHardDeleteScheduled(db, tenant, exit, gdpr, new Date('2026-11-13T12:00:00.000Z'));
      // A session opened after scheduling (simulating a race): deletion must block, not proceed.
      const sessionId = await insertSession(db, tenant, 'open');

      let caught: TerminationBlockedError | undefined;
      try {
        await gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);
      } catch (error) {
        caught = error as TerminationBlockedError;
      }
      expect(caught).toBeInstanceOf(TerminationBlockedError);
      expect(caught?.openSessionIds).toEqual([sessionId]);

      const jobs = await db
        .selectFrom('deletion_jobs')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('failed');

      // Nothing was deleted: the tenant is untouched.
      const tenantRow = await db
        .selectFrom('tenants')
        .select('status')
        .where('id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(tenantRow.status).toBe('hard_delete_scheduled');
    });
  });

  it('hard deletion requires hard_delete_scheduled status', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { gdpr } = services(db);
      await expect(gdpr.hardDelete(tenant.tenantId)).rejects.toThrow(BadRequestException);
    });
  });
});

describe('ExportService — backup/restore verification (G-E)', () => {
  it('a matching snapshot restores cleanly; a tampered snapshot fails with named discrepancies', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { exports: exportService } = services(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1500n });
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const orderId = await insertOrder(db, tenant, { status: 'completed', totalPence: 1500n });
      await insertPaymentAttempt(db, tenant, orderId, 'approved');
      await db
        .insertInto('z_reports')
        .values({
          tenant_id: tenant.tenantId,
          register_id: tenant.registerId,
          session_id: await insertSession(db, tenant, 'closed'),
          z_number: 1n,
          business_date: '2026-11-13',
          status: 'issued',
          issued_at: new Date('2026-11-13T23:00:00.000Z'),
          gross_pence: 1500n,
          net_pence: 1250n,
          vat_pence: 250n,
          discount_pence: 0n,
          refund_pence: 0n,
          order_count: 1,
          void_count: 0,
        })
        .execute();

      // Matching snapshot: pass.
      const restoreDb1 = await createTestDb();
      try {
        const { snapshot, report } = await exportService.snapshotAndVerify(
          tenant.tenantId,
          restoreDb1.db,
        );
        expect(report.pass).toBe(true);
        expect(report.discrepancies).toHaveLength(0);
        expect(report.rowsRestored).toBeGreaterThan(0);
        expect(snapshot.files['orders.json']).toBeDefined();
      } finally {
        await restoreDb1.close();
      }

      // Tampered snapshot 1: an order total changed -> the manifest
      // checksum AND the live-vs-restored ledger sum both disagree.
      const snapshot = await exportService.runFullExport(tenant.tenantId);
      const tamperedOrders = JSON.parse(snapshot.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      tamperedOrders[0] = { ...tamperedOrders[0], total_pence: '9999' };
      const tampered1: typeof snapshot = {
        ...snapshot,
        files: { ...snapshot.files, 'orders.json': JSON.stringify(tamperedOrders) },
      };
      const restoreDb2 = await createTestDb();
      try {
        const report = await exportService.verifyBackupRestore(
          tampered1,
          restoreDb2.db,
          db,
          tenant.tenantId,
        );
        expect(report.pass).toBe(false);
        expect(report.discrepancies.some((d) => d.includes('orders.json: checksum mismatch'))).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('orders.total_pence sum mismatch'))).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('live=1500'))).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('restored=9999'))).toBe(true);
      } finally {
        await restoreDb2.close();
      }

      // Tampered snapshot 2: a row removed -> row-count discrepancy.
      const tamperedOrders2 = JSON.parse(snapshot.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      tamperedOrders2.pop();
      const tampered2: typeof snapshot = {
        ...snapshot,
        files: { ...snapshot.files, 'orders.json': JSON.stringify(tamperedOrders2) },
      };
      const restoreDb3 = await createTestDb();
      try {
        const report = await exportService.verifyBackupRestore(
          tampered2,
          restoreDb3.db,
          db,
          tenant.tenantId,
        );
        expect(report.pass).toBe(false);
        expect(
          report.discrepancies.some((d) => d.includes('orders: row count mismatch')),
        ).toBe(true);
        expect(report.discrepancies.some((d) => d.includes('live=1, restored=0'))).toBe(true);
      } finally {
        await restoreDb3.close();
      }
    });
  });
});
