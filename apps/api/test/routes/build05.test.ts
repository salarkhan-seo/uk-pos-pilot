/**
 * Build-05 route/service tests — Objectives 1–2 (API/DB scope).
 *
 *  - closeVatPeriod(:id) closes the existing open row IN PLACE and
 *    returns the SAME :id (the Build-04 delete-and-recreate bridge
 *    is gone); the creation path still works when no row exists.
 *  - setPriceBookEntry routes: POST /v1/price-books/:id/entries
 *    (upsert) and PUT /v1/price-books/:id/entries/:variantId
 *    (update-only).
 *  - auth.pinLogin malformed UUIDs return 400, never 500.
 *  - Bulk vouchers return plaintext codes exactly once at creation
 *    (issued_codes) and never again on reads.
 *  - Webhook secret rotation: dual signatures inside the grace
 *    window, new-only after expiry.
 *  - 6-year statutory VAT archive persistence: DB row + on-disk
 *    SHA-256 bundle surviving tenant hard deletion, immutability
 *    trigger blocking edits, compliance endpoint verification.
 *
 * Controllers are constructed directly with the real services (no
 * Nest app, no HTTP), following the routes/* test pattern. Delivery
 * uses an injected fake — no real HTTP anywhere.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { ApprovalService } from '../../src/modules/admin/approval.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { AuthController } from '../../src/modules/admin/auth.controller';
import { ComplianceController } from '../../src/modules/admin/compliance.controller';
import { ExitService } from '../../src/modules/admin/exit.service';
import { ExportService } from '../../src/modules/admin/export.service';
import { GdprService } from '../../src/modules/admin/gdpr.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { Phase2CatalogueController, PriceBookEntriesController, PromotionVouchersController } from '../../src/modules/catalogue/phase2.controller';
import { Phase2CatalogueService } from '../../src/modules/catalogue/phase2.service';
import { WebhookService, type DeliverRequest } from '../../src/modules/integrations/webhook.service';
import { WebhooksController } from '../../src/modules/integrations/webhooks.controller';
import { ReportingService } from '../../src/modules/reporting/reporting.service';
import { ReportingV1Controller } from '../../src/modules/reporting/reporting.v1.controller';
import { actorFor, reqFor, withDb } from './helpers';
import type { Actor } from '../../src/common/actor';

function makeReporting(db: Kysely<DB>) {
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const reporting = new ReportingService(db, approvals, audit);
  return { audit, approvals, reporting };
}

function makeGdpr(db: Kysely<DB>) {
  const audit = new AuditService(db);
  const exit = new ExitService(db, audit);
  const exportsSvc = new ExportService(db, audit);
  const gdpr = new GdprService(db, audit, exit, exportsSvc);
  return { audit, exit, exportsSvc, gdpr };
}

async function insertOpenVatPeriod(
  db: Kysely<DB>,
  tenant: SeededTenant,
  periodStart = '2026-11-01',
  periodEnd = '2026-11-30',
): Promise<string> {
  const row = await db
    .insertInto('vat_periods')
    .values({
      tenant_id: tenant.tenantId,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'open',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertCompletedOrder(
  db: Kysely<DB>,
  tenant: SeededTenant,
  businessDateValue: string,
): Promise<string> {
  const variant = await seedVariant(db, tenant);
  const order = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      register_id: tenant.registerId,
      customer_id: null,
      order_number: 1n,
      business_date: businessDateValue,
      status: 'completed',
      subtotal_pence: 1200n,
      discount_pence: 0n,
      tax_pence: 200n,
      total_pence: 1200n,
      created_by_user_id: tenant.users.manager.id,
      completed_at: new Date(`${businessDateValue}T12:00:00Z`),
      created_at: new Date(`${businessDateValue}T12:00:00Z`),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('order_lines')
    .values({
      tenant_id: tenant.tenantId,
      order_id: order.id,
      variant_id: variant.variantId,
      quantity: 1n,
      unit_price_pence: 1200n,
      base_price_pence: 1200n,
      price_book_id: null,
      price_book_price_pence: null,
      promotion_discount_pence: 0n,
      manual_discount_pence: 0n,
      final_price_pence: 1200n,
      tax_rate_kind: 'standard',
      tax_rate_percent: '20.00',
      tax_amount_pence: 200n,
      line_total_pence: 1200n,
    })
    .execute();
  return order.id;
}

describe('Build-05 — closeVatPeriod(:id) closes the existing row in place', () => {
  it('returns the SAME :id with lines populated, status closed, closed_at/closed_by stamped', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const manager = actorFor(tenant, 'manager');
      await insertCompletedOrder(db, tenant, '2026-11-05');
      const periodId = await insertOpenVatPeriod(db, tenant);

      const closed = await reporting.closeVatPeriodById(manager, periodId);
      expect(closed.periodId).toBe(periodId);
      expect(closed.lines).toHaveLength(1);
      expect(closed.lines[0]).toMatchObject({
        taxRateKind: 'standard',
        grossPence: 1200n,
        vatPence: 200n,
        netPence: 1000n,
        orderLineCount: 1,
      });

      const row = await db
        .selectFrom('vat_periods')
        .selectAll()
        .where('id', '=', periodId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('closed');
      expect(row.closed_at).not.toBeNull();
      expect(row.closed_by_user_id).toBe(manager.userId);
      const lines = await db
        .selectFrom('vat_period_lines')
        .selectAll()
        .where('vat_period_id', '=', periodId)
        .execute();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.gross_pence).toBe(1200n);

      // A second close is 409, and the row is untouched.
      await expect(reporting.closeVatPeriodById(manager, periodId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Unknown id is 404.
      await expect(
        reporting.closeVatPeriodById(manager, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('controller route returns the same :id (no delete-and-recreate bridge)', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const controller = new ReportingV1Controller(db, reporting);
      const manager = actorFor(tenant, 'manager');
      await insertCompletedOrder(db, tenant, '2026-11-05');
      const periodId = await insertOpenVatPeriod(db, tenant);

      const result = await controller.closeVatPeriod(reqFor(manager), periodId);
      expect(result.id).toBe(periodId);
      expect(result.status).toBe('closed');
      expect(result.closed_by_user_id).toBe(manager.userId);
      expect(result.closed_at).not.toBeNull();

      // The row still exists under the same id (it was never deleted).
      const row = await db
        .selectFrom('vat_periods')
        .select('id')
        .where('id', '=', periodId)
        .executeTakeFirst();
      expect(row?.id).toBe(periodId);

      // Second close via the route is 409; a malformed id is 400, never 500.
      await expect(controller.closeVatPeriod(reqFor(manager), periodId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(controller.closeVatPeriod(reqFor(manager), 'not-a-uuid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('creation path still works when no period row exists yet', async () => {
    await withDb(async ({ db, tenant }) => {
      const { reporting } = makeReporting(db);
      const manager = actorFor(tenant, 'manager');
      await insertCompletedOrder(db, tenant, '2026-11-05');
      const created = await reporting.closeVatPeriod(manager, {
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
      });
      expect(created.periodId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.lines).toHaveLength(1);
      const row = await db
        .selectFrom('vat_periods')
        .selectAll()
        .where('id', '=', created.periodId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('closed');
      expect(row.closed_at).not.toBeNull();
      expect(row.closed_by_user_id).toBe(manager.userId);
    });
  });
});

describe('Build-05 — setPriceBookEntry routes', () => {
  async function setup(db: Kysely<DB>, tenant: SeededTenant) {
    const service = new Phase2CatalogueService(db);
    const entries = new PriceBookEntriesController(service);
    const actor = actorFor(tenant, 'manager');
    const book = await service.createPriceBook(actor, {
      name: 'Autumn',
      priority: 1,
      effectiveFrom: new Date('2026-11-01T00:00:00Z'),
    });
    const variant = await seedVariant(db, tenant);
    return { service, entries, actor, book, variant };
  }

  it('POST creates (and replaces) an entry; PUT updates an existing one and 404s a missing one', async () => {
    await withDb(async ({ db, tenant }) => {
      const { entries, actor, book, variant } = await setup(db, tenant);

      const created = await entries.setPriceBookEntry(reqFor(actor), book.id, {
        variantId: variant.variantId,
        pricePence: '1500',
      });
      expect(created).toMatchObject({
        price_book_id: book.id,
        variant_id: variant.variantId,
        price_pence: '1500',
      });

      // POST again replaces the price (upsert on the composite key).
      const replaced = await entries.setPriceBookEntry(reqFor(actor), book.id, {
        variantId: variant.variantId,
        pricePence: '1750',
      });
      expect(replaced.price_pence).toBe('1750');
      const rows = await db
        .selectFrom('price_book_entries')
        .selectAll()
        .where('price_book_id', '=', book.id)
        .execute();
      expect(rows).toHaveLength(1);

      const updated = await entries.updatePriceBookEntry(reqFor(actor), book.id, variant.variantId, {
        pricePence: '1800',
      });
      expect(updated.price_pence).toBe('1800');

      // PUT on a variant with no entry is 404 (it never creates pricing by typo).
      const other = await seedVariant(db, tenant);
      await expect(
        entries.updatePriceBookEntry(reqFor(actor), book.id, other.variantId, {
          pricePence: '1800',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Unknown price book / variant / negative price.
      await expect(
        entries.setPriceBookEntry(reqFor(actor), '00000000-0000-0000-0000-000000000000', {
          variantId: variant.variantId,
          pricePence: '1500',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        entries.setPriceBookEntry(reqFor(actor), book.id, {
          variantId: '00000000-0000-0000-0000-000000000000',
          pricePence: '1500',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        entries.setPriceBookEntry(reqFor(actor), book.id, {
          variantId: variant.variantId,
          pricePence: '-5',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('cross-tenant price book is 404', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const { entries, book } = await setup(db, tenantA);
      const actorB = actorFor(tenantB, 'manager');
      const variantB = await seedVariant(db, tenantB);
      await expect(
        entries.setPriceBookEntry(reqFor(actorB), book.id, {
          variantId: variantB.variantId,
          pricePence: '1500',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('Build-05 — auth.pinLogin UUID validation', () => {
  it('malformed tenantId/userId/locationId return 400, never 500', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new AuthController(new SessionService(db));
      const good = {
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
        locationId: tenant.locationId,
      };
      for (const bad of [
        { ...good, tenantId: 'not-a-uuid' },
        { ...good, tenantId: '123' },
        { ...good, userId: 'not-a-uuid' },
        { ...good, userId: "'; DROP TABLE users; --" },
        { ...good, locationId: 'not-a-uuid' },
      ]) {
        await expect(controller.pinLogin(bad)).rejects.toBeInstanceOf(BadRequestException);
      }
      // A well-formed UUID that matches nothing is still 404, not 400 or 500.
      await expect(
        controller.pinLogin({
          ...good,
          userId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // And the happy path still works.
      const result = await controller.pinLogin(good);
      expect(typeof result.token).toBe('string');
    });
  });

  it('SessionService.login itself rejects malformed ids (defence in depth)', async () => {
    await withDb(async ({ db, tenant }) => {
      const sessions = new SessionService(db);
      await expect(
        sessions.login({
          tenantId: 'not-a-uuid',
          userId: tenant.users.manager.id,
          pin: '1234',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('Build-05 — show-once bulk vouchers', () => {
  it('bulk returns plaintext codes once; stored rows keep hash+last4 only; reads never expose codes', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new Phase2CatalogueService(db);
      const controller = new Phase2CatalogueController(service);
      const actor = actorFor(tenant, 'manager');
      const promotion = await controller.createPromotion(reqFor(actor), {
        name: 'Voucher promo',
        type: 'percentage',
        startAt: '2026-11-01T00:00:00.000Z',
      });

      const result = await controller.generateVouchers(reqFor(actor), {
        promotionId: promotion.id,
        count: 5,
        maxUses: 1,
        validTo: '2027-01-01T00:00:00.000Z',
      });
      expect(result.issued_codes).toHaveLength(5);
      const codes = new Set<string>();
      for (const issued of result.issued_codes) {
        expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        expect(issued.code_last4).toBe(issued.code.slice(-4));
        expect(issued.expires_at).toBe('2027-01-01T00:00:00.000Z');
        codes.add(issued.code);
      }
      expect(codes.size).toBe(5);

      // The stored rows carry the SHA-256 of the returned code + last-4 — the codes ARE the real ones.
      const stored = await db
        .selectFrom('voucher_codes')
        .select(['id', 'code_hash', 'code_last4'])
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(stored).toHaveLength(5);
      for (const issued of result.issued_codes) {
        const row = stored.find((r) => r.id === issued.id);
        expect(row).toBeDefined();
        expect(row?.code_hash).toBe(createHash('sha256').update(issued.code).digest('hex'));
        expect(row?.code_last4).toBe(issued.code_last4);
      }

      // Reads never expose a code or a hash.
      const listed = await controller.listVouchers(reqFor(actor));
      expect(listed).toHaveLength(5);
      expect(JSON.stringify(listed)).not.toContain('code_hash');
      for (const issued of result.issued_codes) {
        expect(JSON.stringify(listed)).not.toContain(issued.code);
      }
    });
  });

  it('POST /v1/promotions/:id/vouchers/bulk returns issued_codes once for that promotion', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new Phase2CatalogueService(db);
      const controller = new PromotionVouchersController(service);
      const actor = actorFor(tenant, 'manager');
      const promotion = await service.createPromotion(actor, {
        name: 'Promo bulk',
        type: 'fixed',
        startAt: new Date('2026-11-01T00:00:00Z'),
      });
      const result = await controller.generatePromotionVouchers(reqFor(actor), promotion.id, {
        count: 2,
        maxUses: 3,
      });
      expect(result.promotion_id).toBe(promotion.id);
      expect(result.issued_codes).toHaveLength(2);
      expect(result.issued_codes[0]?.code).toMatch(/^[A-Z2-9]{4}-/);
      // Unknown promotion is 404.
      await expect(
        controller.generatePromotionVouchers(reqFor(actor), '00000000-0000-0000-0000-000000000000', {
          count: 1,
          maxUses: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('Build-05 — webhook secret rotation', () => {
  it('dual-signs inside the grace window and signs new-only after expiry', async () => {
    await withDb(async ({ db, tenant }) => {
      const requests: DeliverRequest[] = [];
      let now = new Date('2026-11-13T12:00:00.000Z');
      const webhooks = new WebhookService(db, undefined, {
        deliver: async (request) => {
          requests.push(request);
          return 200;
        },
        clock: () => now,
      });
      const controller = new WebhooksController(webhooks);
      const actor: Actor = actorFor(tenant, 'admin');

      const { endpoint, secret: oldSecret } = await webhooks.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );

      const rotated = await controller.rotateSecret(reqFor(actor), endpoint.id, {
        gracePeriodHours: 24,
      });
      expect(rotated.endpoint_id).toBe(endpoint.id);
      expect(rotated.secret).not.toBe(oldSecret);
      expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(rotated.previous_secret_expires_at).toBe(
        new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      );

      // Inside the grace window: both signatures, each verifying with its own secret.
      await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 1200,
      });
      expect(requests).toHaveLength(1);
      const first = requests[0] as DeliverRequest;
      const timestamp = Number(first.headers['X-Webhook-Timestamp']);
      expect(first.headers['X-Webhook-Signature']).toBeDefined();
      expect(first.headers['X-Webhook-Signature-Previous']).toBeDefined();
      expect(
        WebhookService.verifySignature(
          rotated.secret,
          timestamp,
          first.body,
          first.headers['X-Webhook-Signature'] as string,
          timestamp,
        ),
      ).toBe(true);
      expect(
        WebhookService.verifySignature(
          oldSecret,
          timestamp,
          first.body,
          first.headers['X-Webhook-Signature-Previous'] as string,
          timestamp,
        ),
      ).toBe(true);

      // After the grace window: only the new signature.
      now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000002',
        total_pence: 500,
      });
      expect(requests).toHaveLength(2);
      const second = requests[1] as DeliverRequest;
      expect(second.headers['X-Webhook-Signature']).toBeDefined();
      expect(second.headers['X-Webhook-Signature-Previous']).toBeUndefined();

      // The stored row keeps hashes only — no raw secret is persisted.
      const stored = await db
        .selectFrom('webhook_endpoints')
        .select(['secret_hash', 'previous_secret_hash', 'previous_secret_expires_at'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(stored.secret_hash).toBe(createHash('sha256').update(rotated.secret).digest('hex'));
      expect(stored.previous_secret_hash).toBe(
        createHash('sha256').update(oldSecret).digest('hex'),
      );
      expect(stored.previous_secret_expires_at).not.toBeNull();
    });
  });

  it('rotating another tenant’s endpoint is 404; grace must be within bounds', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const webhooks = new WebhookService(db, undefined, {
        deliver: async () => 200,
        clock: () => new Date(),
      });
      const controller = new WebhooksController(webhooks);
      const { endpoint } = await webhooks.registerEndpoint(
        tenantA.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );
      await expect(
        controller.rotateSecret(reqFor(actorFor(tenantB, 'admin')), endpoint.id, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.rotateSecret(reqFor(actorFor(tenantA, 'admin')), endpoint.id, {
          gracePeriodHours: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.rotateSecret(reqFor(actorFor(tenantA, 'admin')), endpoint.id, {
          gracePeriodHours: 999,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await close();
    }
  });

  it('a malformed endpoint/delivery id is 400, never a 500 uuid-cast error', async () => {
    await withDb(async ({ db, tenant }) => {
      const webhooks = new WebhookService(db, undefined, {
        deliver: async () => 200,
        clock: () => new Date(),
      });
      const controller = new WebhooksController(webhooks);
      const actor = actorFor(tenant, 'admin');
      await expect(
        controller.rotateSecret(reqFor(actor), 'not-a-uuid', {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.replayDeadLetter(reqFor(actor), 'not-a-uuid'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.discardDeadLetter(reqFor(actor), 'not-a-uuid'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('Build-05 — statutory VAT archive persistence', () => {
  it('hard deletion persists a verified 6-year archive (DB + disk) that survives the tenant', async () => {
    const { db, close } = await createTestDb();
    const archiveDir = await mkdtemp(join(tmpdir(), 'uk-pos-statutory-'));
    try {
      const tenant = await seedTenant(db);
      const { gdpr } = makeGdpr(db);
      gdpr.setArchiveDir(archiveDir);
      const archivedAt = new Date('2026-11-13T12:00:00.000Z');
      gdpr.setClock(() => archivedAt);

      await insertCompletedOrder(db, tenant, '2026-11-05');
      await insertOpenVatPeriod(db, tenant);
      await db
        .updateTable('tenants')
        .set({ status: 'hard_delete_scheduled', export_window_ends_at: new Date('2026-11-01T00:00:00Z') })
        .where('id', '=', tenant.tenantId)
        .execute();

      const deleted = await gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);
      expect(deleted.verifiedRowCount).toBe(0);

      // Persisted archive: DB row survives the tenant deletion.
      expect(deleted.statutoryArchive.tenantId).toBe(tenant.tenantId);
      expect(deleted.statutoryArchive.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(deleted.statutoryArchive.retentionUntil.getTime()).toBe(
        new Date('2032-11-13T12:00:00.000Z').getTime(),
      );
      const rows = await db
        .selectFrom('statutory_vat_archives')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(deleted.statutoryArchive.archiveId);
      expect(rows[0]?.archive_sha256).toBe(deleted.statutoryArchive.archiveSha256);
      expect(rows[0]?.storage_bundle_path).toBe(deleted.statutoryArchive.storageBundlePath);
      expect(rows[0]?.row_counts_json['vat_periods']).toBe(1);
      expect(rows[0]?.row_counts_json['orders']).toBe(1);

      // The on-disk bundle exists and re-hashes to the stored checksum.
      const bundleText = await readFile(deleted.statutoryArchive.storageBundlePath, 'utf8');
      expect(createHash('sha256').update(bundleText, 'utf8').digest('hex')).toBe(
        deleted.statutoryArchive.archiveSha256,
      );
      const bundle = JSON.parse(bundleText) as Record<string, unknown>;
      expect(bundle['tenant_id']).toBe(tenant.tenantId);

      // The tenant rows are gone, the tombstone remains.
      const remaining = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM orders WHERE tenant_id = ${tenant.tenantId}
      `.execute(db);
      expect(Number(remaining.rows[0]?.count ?? '0')).toBe(0);

      // Compliance endpoint verifies the archive end to end.
      const compliance = new ComplianceController(gdpr);
      const actor = actorFor(tenant, 'admin');
      const listed = await compliance.listStatutoryArchives(reqFor(actor), tenant.tenantId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: deleted.statutoryArchive.archiveId,
        verified: true,
        payload_verified: true,
        file_verified: true,
      });
      // Cross-tenant is 404; malformed tenant id is 400.
      const otherTenant = await seedTenant(db, { name: 'Other Shop Ltd' });
      await expect(
        compliance.listStatutoryArchives(reqFor(actorFor(otherTenant, 'admin')), tenant.tenantId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        compliance.listStatutoryArchives(reqFor(actor), 'not-a-uuid'),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await close();
    }
  });

  it('immutability trigger blocks edits; tampering the bundle fails verification', async () => {
    const { db, close } = await createTestDb();
    const archiveDir = await mkdtemp(join(tmpdir(), 'uk-pos-statutory-'));
    try {
      const tenant = await seedTenant(db);
      const { gdpr } = makeGdpr(db);
      gdpr.setArchiveDir(archiveDir);
      await insertCompletedOrder(db, tenant, '2026-11-05');
      await db
        .updateTable('tenants')
        .set({ status: 'hard_delete_scheduled', export_window_ends_at: new Date('2026-11-01T00:00:00Z') })
        .where('id', '=', tenant.tenantId)
        .execute();
      const deleted = await gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);
      const archiveId = deleted.statutoryArchive.archiveId;

      // UPDATE is blocked while the retention window is open.
      await expect(
        sql`UPDATE statutory_vat_archives SET archive_sha256 = ${'0'.repeat(64)} WHERE id = ${archiveId}`.execute(db),
      ).rejects.toThrow(/immutable/);
      // DELETE is blocked while the retention window is open.
      await expect(
        sql`DELETE FROM statutory_vat_archives WHERE id = ${archiveId}`.execute(db),
      ).rejects.toThrow(/retention window/);

      // Tampering with the on-disk bundle fails verification (payload still verifies).
      await writeFile(deleted.statutoryArchive.storageBundlePath, '{"tampered":true}', 'utf8');
      const verification = await gdpr.verifyStatutoryArchive(tenant.tenantId, archiveId);
      expect(verification.verified).toBe(false);
      expect(verification.fileVerified).toBe(false);
      expect(verification.payloadVerified).toBe(true);
    } finally {
      await close();
    }
  });
});
