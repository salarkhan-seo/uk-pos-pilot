/**
 * Route tests — Group B (Phase-2 catalogue + purchasing) — Build-04 Worker 4.
 *
 * Proves the minimal tenant-scoped services + controllers over the
 * Phase-2 tables: price books, promotions, voucher bulk generation,
 * warehouses, transfers, reorder suggestions, purchase orders.
 * (CRM lists are proven in webhooks-exit-crm.test.ts.)
 *
 * Happy path, cross-tenant isolation (404 / empty lists), wrong-scope
 * rejection (via the real AuthGuard) and state-transition 409s are
 * asserted per group. Voucher/gift-card assertions prove no full code
 * or hash ever leaves the API.
 */
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
  seedVariant,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { AuditService } from '../../src/modules/admin/audit.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { Phase2CatalogueController } from '../../src/modules/catalogue/phase2.controller';
import { Phase2CatalogueService } from '../../src/modules/catalogue/phase2.service';
import { PurchasingController } from '../../src/modules/inventory/purchasing.controller';
import { PurchasingService } from '../../src/modules/inventory/purchasing.service';
import {
  actorFor,
  guardContext,
  makeApiKey,
  makeGuard,
  reqFor,
  withDb,
} from './helpers';

async function seedSupplier(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const row = await db
    .insertInto('suppliers')
    .values({ tenant_id: tenant.tenantId, name: 'Acme Supplies', currency: 'GBP' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedSuggestion(
  db: Kysely<DB>,
  tenant: SeededTenant,
  variantId: string,
  supplierId: string | null,
): Promise<string> {
  const row = await db
    .insertInto('purchase_order_suggestions')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      variant_id: variantId,
      supplier_id: supplierId,
      suggested_quantity: 24n,
      expected_date: null,
      status: 'pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedSecondWarehouse(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const row = await db
    .insertInto('warehouses')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      name: 'Back Warehouse',
      type: 'warehouse',
      is_default: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('Phase2CatalogueController — price books', () => {
  it('creates and lists price books (tenant-scoped)', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new Phase2CatalogueController(new Phase2CatalogueService(db));
      const actor = actorFor(tenant, 'manager');
      const created = await controller.createPriceBook(reqFor(actor), {
        name: 'Summer Sale',
        priority: 10,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
      });
      expect(created.status).toBe('draft');
      expect(created.name).toBe('Summer Sale');
      const listed = await controller.listPriceBooks(reqFor(actor));
      expect(listed.map((b) => b.id)).toContain(created.id);
    });
  });

  it('rejects invalid price books with 400', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new Phase2CatalogueController(new Phase2CatalogueService(db));
      const actor = actorFor(tenant, 'manager');
      await expect(
        controller.createPriceBook(reqFor(actor), {
          name: '  ',
          priority: 1,
          effectiveFrom: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow('name is required');
      await expect(
        controller.createPriceBook(reqFor(actor), {
          name: 'Bad',
          priority: -1,
          effectiveFrom: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow('non-negative integer');
      await expect(
        controller.createPriceBook(reqFor(actor), {
          name: 'Bad',
          priority: 1,
          effectiveFrom: '2026-06-10T00:00:00.000Z',
          effectiveTo: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow('on or after');
    });
  });

  it('isolates price books by tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const controller = new Phase2CatalogueController(new Phase2CatalogueService(db));
      await controller.createPriceBook(reqFor(actorFor(tenantA, 'manager')), {
        name: 'A-only',
        priority: 1,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
      });
      expect(await controller.listPriceBooks(reqFor(actorFor(tenantB, 'manager')))).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('Phase2CatalogueController — promotions and vouchers', () => {
  it('creates and lists promotions', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new Phase2CatalogueController(new Phase2CatalogueService(db));
      const actor = actorFor(tenant, 'manager');
      const created = await controller.createPromotion(reqFor(actor), {
        name: '10% off tea',
        type: 'percentage',
        startAt: '2026-11-01T00:00:00.000Z',
        endAt: null,
      });
      expect(created.status).toBe('draft');
      expect(created.version).toBe(1);
      await expect(
        controller.createPromotion(reqFor(actor), {
          name: 'Bad',
          type: 'mystery',
          startAt: '2026-11-01T00:00:00.000Z',
        }),
      ).rejects.toThrow('Unknown promotion type');
      const listed = await controller.listPromotions(reqFor(actor));
      expect(listed.map((p) => p.id)).toContain(created.id);
    });
  });

  it('bulk-generates vouchers returning plaintext codes exactly once at creation (Build-05 show-once)', async () => {
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
        count: 25,
        maxUses: 1,
        validTo: null,
      });
      // Build-05: the creation response returns the plaintext codes
      // exactly once (issued_codes); the old "never a full code"
      // contract now applies to READS only, not to creation.
      expect(result.issued_codes).toHaveLength(25);
      const last4s = new Set<string>();
      const codes = new Set<string>();
      for (const voucher of result.issued_codes) {
        expect(voucher.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        expect(voucher.code_last4).toBe(voucher.code.slice(-4));
        expect(voucher.expires_at).toBeNull();
        expect('code_hash' in voucher).toBe(false);
        last4s.add(voucher.code_last4);
        codes.add(voucher.code);
      }
      expect(last4s.size).toBe(25);
      expect(codes.size).toBe(25);
      // The stored rows carry a SHA-256 hash + last-4 only.
      const stored = await db
        .selectFrom('voucher_codes')
        .select(['code_hash', 'code_last4'])
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(stored).toHaveLength(25);
      for (const row of stored) {
        expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      }
      // Listing never exposes a code or a hash either.
      const listed = await controller.listVouchers(reqFor(actor));
      expect(listed).toHaveLength(25);
      expect(JSON.stringify(listed)).not.toContain('code_hash');
      for (const code of codes) {
        expect(JSON.stringify(listed)).not.toContain(code);
      }
    });
  });

  it('rejects bulk generation outside 1..1000 and for an unknown promotion', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new Phase2CatalogueController(new Phase2CatalogueService(db));
      const actor = actorFor(tenant, 'manager');
      await expect(
        controller.generateVouchers(reqFor(actor), { promotionId: null, count: 0, maxUses: 1 }),
      ).rejects.toThrow('between 1 and 1000');
      await expect(
        controller.generateVouchers(reqFor(actor), { promotionId: null, count: 1001, maxUses: 1 }),
      ).rejects.toThrow('between 1 and 1000');
      await expect(
        controller.generateVouchers(reqFor(actor), {
          promotionId: '00000000-0000-0000-0000-000000000000',
          count: 1,
          maxUses: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('Phase2CatalogueController — AuthGuard scope checks', () => {
  it('lists need catalogue:read, writes need catalogue:write', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const listHandler = Phase2CatalogueController.prototype.listPriceBooks;
      const createHandler = Phase2CatalogueController.prototype.createPriceBook;
      await expect(guard.canActivate(guardContext(listHandler, {}))).rejects.toBeInstanceOf(
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
      await expect(
        guard.canActivate(guardContext(createHandler, { authorization: `Bearer ${readKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const sessions = new SessionService(db);
      const manager = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      expect(
        await guard.canActivate(
          guardContext(createHandler, { authorization: `Bearer ${manager.token}` }),
        ),
      ).toBe(true);
    });
  });
});

describe('PurchasingController — warehouses and transfers', () => {
  it('lists the seeded default warehouse and creates an in-transit transfer', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new PurchasingController(new PurchasingService(db, new AuditService(db)));
      const actor = actorFor(tenant, 'manager');
      const warehouses = await controller.listWarehouses(reqFor(actor));
      expect(warehouses.map((w) => w.id)).toContain(tenant.warehouseId);

      const other = await seedSecondWarehouse(db, tenant);
      const variant = await seedVariant(db, tenant);
      const transfer = await controller.createTransfer(reqFor(actor), {
        fromWarehouseId: tenant.warehouseId,
        toWarehouseId: other,
        lines: [{ variantId: variant.variantId, quantity: '12' }],
      });
      expect(transfer.status).toBe('in_transit');
      expect(transfer.lines).toEqual([
        { variant_id: variant.variantId, quantity: '12', received_quantity: '0' },
      ]);
      const listed = await controller.listTransfers(reqFor(actor));
      expect(listed.map((t) => t.id)).toContain(transfer.id);
    });
  });

  it('rejects same-warehouse, unknown-warehouse and unknown-variant transfers', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new PurchasingController(new PurchasingService(db, new AuditService(db)));
      const actor = actorFor(tenant, 'manager');
      const other = await seedSecondWarehouse(db, tenant);
      const variant = await seedVariant(db, tenant);
      await expect(
        controller.createTransfer(reqFor(actor), {
          fromWarehouseId: tenant.warehouseId,
          toWarehouseId: tenant.warehouseId,
          lines: [{ variantId: variant.variantId, quantity: '1' }],
        }),
      ).rejects.toThrow('must differ');
      await expect(
        controller.createTransfer(reqFor(actor), {
          fromWarehouseId: '00000000-0000-0000-0000-000000000000',
          toWarehouseId: other,
          lines: [{ variantId: variant.variantId, quantity: '1' }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.createTransfer(reqFor(actor), {
          fromWarehouseId: tenant.warehouseId,
          toWarehouseId: other,
          lines: [{ variantId: '00000000-0000-0000-0000-000000000000', quantity: '1' }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.createTransfer(reqFor(actor), {
          fromWarehouseId: tenant.warehouseId,
          toWarehouseId: other,
          lines: [{ variantId: variant.variantId, quantity: '0' }],
        }),
      ).rejects.toThrow('greater than zero');
    });
  });

  it('isolates warehouses and transfers by tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const controller = new PurchasingController(new PurchasingService(db, new AuditService(db)));
      expect(await controller.listWarehouses(reqFor(actorFor(tenantB, 'manager')))).toHaveLength(1);
      expect(
        (await controller.listWarehouses(reqFor(actorFor(tenantB, 'manager'))))[0]?.id,
      ).not.toBe(tenantA.warehouseId);
      expect(await controller.listTransfers(reqFor(actorFor(tenantB, 'manager')))).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('PurchasingController — reorder suggestions and purchase orders', () => {
  it('accepts a suggestion into a draft PO (sequential numbers) and sends it', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new PurchasingController(new PurchasingService(db, new AuditService(db)));
      const actor = actorFor(tenant, 'manager');
      const supplierId = await seedSupplier(db, tenant);
      const variant = await seedVariant(db, tenant, { costPence: 450n });
      const suggestionId = await seedSuggestion(db, tenant, variant.variantId, supplierId);

      const po = await controller.acceptReorderSuggestion(reqFor(actor), suggestionId);
      expect(po.status).toBe('draft');
      expect(po.po_number).toBe('1');
      expect(po.supplier_id).toBe(supplierId);
      expect(po.lines).toEqual([
        {
          variant_id: variant.variantId,
          quantity_ordered: '24',
          quantity_received: '0',
          cost_pence: '450',
        },
      ]);
      const suggestion = await db
        .selectFrom('purchase_order_suggestions')
        .select('status')
        .where('id', '=', suggestionId)
        .executeTakeFirstOrThrow();
      expect(suggestion.status).toBe('approved');

      // A second suggestion gets the next sequential PO number.
      const variant2 = await seedVariant(db, tenant);
      const suggestion2 = await seedSuggestion(db, tenant, variant2.variantId, supplierId);
      const po2 = await controller.acceptReorderSuggestion(reqFor(actor), suggestion2);
      expect(po2.po_number).toBe('2');

      const listed = await controller.listPurchaseOrders(reqFor(actor));
      expect(listed.map((p) => p.po_number)).toEqual(['2', '1']);

      const sent = await controller.sendPurchaseOrder(reqFor(actor), po.id);
      expect(sent.status).toBe('sent');
      expect(typeof sent.sent_at).toBe('string');
      await expect(controller.sendPurchaseOrder(reqFor(actor), po.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        controller.acceptReorderSuggestion(reqFor(actor), suggestionId),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('dismisses only with a reason, and refuses to accept a suggestion without a supplier', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new PurchasingController(new PurchasingService(db, new AuditService(db)));
      const actor = actorFor(tenant, 'manager');
      const variant = await seedVariant(db, tenant);
      const noSupplier = await seedSuggestion(db, tenant, variant.variantId, null);
      await expect(controller.acceptReorderSuggestion(reqFor(actor), noSupplier)).rejects.toThrow(
        'no supplier',
      );

      const supplierId = await seedSupplier(db, tenant);
      const suggestionId = await seedSuggestion(db, tenant, variant.variantId, supplierId);
      await expect(
        controller.dismissReorderSuggestion(reqFor(actor), suggestionId, { reason: '   ' }),
      ).rejects.toThrow('reason is required');
      const dismissed = await controller.dismissReorderSuggestion(reqFor(actor), suggestionId, {
        reason: 'Overstocked already',
      });
      expect(dismissed.status).toBe('dismissed');
      // The reason is kept in the audit trail (no column on the row).
      const auditEvents = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .where('event_type', '=', 'reorder_suggestion.dismissed')
        .execute();
      expect(auditEvents).toHaveLength(1);
      expect(
        (auditEvents[0]?.payload as { reason?: string } | null)?.reason,
      ).toBe('Overstocked already');
      await expect(
        controller.dismissReorderSuggestion(reqFor(actor), suggestionId, { reason: 'again' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('returns 404 for unknown suggestions and purchase orders (incl. cross-tenant)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const controller = new PurchasingController(new PurchasingService(db, new AuditService(db)));
      const supplierId = await seedSupplier(db, tenantA);
      const variant = await seedVariant(db, tenantA);
      const suggestionId = await seedSuggestion(db, tenantA, variant.variantId, supplierId);
      await expect(
        controller.acceptReorderSuggestion(reqFor(actorFor(tenantB, 'manager')), suggestionId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.sendPurchaseOrder(reqFor(actorFor(tenantB, 'manager')), '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('requires stock scopes at the guard', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const listHandler = PurchasingController.prototype.listWarehouses;
      const createHandler = PurchasingController.prototype.createTransfer;
      const readKey = await makeApiKey(db, tenant.tenantId, ['stock:read']);
      expect(
        await guard.canActivate(guardContext(listHandler, { authorization: `Bearer ${readKey}` })),
      ).toBe(true);
      await expect(
        guard.canActivate(guardContext(createHandler, { authorization: `Bearer ${readKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const writeKey = await makeApiKey(db, tenant.tenantId, ['stock:write']);
      expect(
        await guard.canActivate(
          guardContext(createHandler, { authorization: `Bearer ${writeKey}` }),
        ),
      ).toBe(true);
    });
  });
});
