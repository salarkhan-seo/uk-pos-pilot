/**
 * Build-10 Objective 3 — structured sync flush error codes.
 *
 * A failed flush outcome now carries `error_code` alongside the
 * human-readable `error` message (see syncErrorCode in
 * sync.service.ts for the full mapping table). Proven here at the
 * service level: the Build-09 note being closed is that the outcome
 * string carried the exception class name ("AgeVerificationRequired
 * Exception") instead of the structured AGE_VERIFICATION_REQUIRED
 * code.
 *
 * Each test creates its own PGlite database (createTestDb) and seeds
 * one tenant — same pattern as apps/api/test/sync/sync.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
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
  SalesService,
  AgeVerificationRequiredException,
  IllegalOrderTransitionError,
  SplitTimeoutError,
  TenderNotApprovedError,
  TenderSumMismatchError,
  UnknownPaymentBlockedError,
  RefundBlockedError,
} from '../../src/modules/sales/sales.service';
import { InsufficientStockError } from '../../src/modules/inventory/inventory.service';
import { SyncService, syncErrorCode } from '../../src/modules/sync/sync.service';
import type { FlushOrder } from '../../src/modules/sync/sync.dto';
import type { Actor } from '../../src/common/actor';

function actorFor(tenant: SeededTenant, role: 'owner' | 'admin' | 'manager' | 'cashier' = 'manager'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

function makeSync(db: Kysely<DB>): { sync: SyncService; catalogue: CatalogueService } {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  const sync = new SyncService(db, sales, catalogue, audit);
  return { sync, catalogue };
}

function offlineOrder(
  tenant: SeededTenant,
  input: { key: string; variantId: string; quantity: bigint; unitPricePence: bigint },
): FlushOrder {
  const lineTotal = input.quantity * input.unitPricePence;
  return {
    idempotencyKey: input.key,
    locationId: tenant.locationId,
    registerId: tenant.registerId,
    customerId: null,
    tenderTotalPence: lineTotal.toString(),
    createdAt: new Date().toISOString(),
    lines: [
      {
        variantId: input.variantId,
        quantity: input.quantity.toString(),
        snapshotUnitPricePence: input.unitPricePence.toString(),
        snapshotLineTotalPence: lineTotal.toString(),
      },
    ],
  };
}

describe('syncErrorCode — exception-to-code mapping', () => {
  it('maps the age-verification exception to AGE_VERIFICATION_REQUIRED', () => {
    expect(syncErrorCode(new AgeVerificationRequiredException(['v-1']))).toBe(
      'AGE_VERIFICATION_REQUIRED',
    );
  });

  it('maps InsufficientStockError to INSUFFICIENT_STOCK', () => {
    expect(syncErrorCode(new InsufficientStockError('v-1', 0n, 2n))).toBe('INSUFFICIENT_STOCK');
  });

  it('maps the sales state-machine errors to their codes', () => {
    expect(syncErrorCode(new IllegalOrderTransitionError('bad transition'))).toBe(
      'ILLEGAL_ORDER_TRANSITION',
    );
    expect(syncErrorCode(new SplitTimeoutError('timed out'))).toBe('SPLIT_TIMEOUT');
    expect(syncErrorCode(new TenderSumMismatchError(1000n, 900n))).toBe('TENDER_SUM_MISMATCH');
    expect(syncErrorCode(new TenderNotApprovedError('not approved'))).toBe('TENDER_NOT_APPROVED');
    expect(syncErrorCode(new UnknownPaymentBlockedError())).toBe('UNKNOWN_PAYMENT');
  });

  it('maps Nest HttpExceptions by status when no structured code is present', () => {
    expect(syncErrorCode(new BadRequestException('bad input'))).toBe('BAD_REQUEST');
    expect(syncErrorCode(new NotFoundException('Resource not found'))).toBe('NOT_FOUND');
  });

  it('yields a carried .code (RefundBlockedError) and INTERNAL_ERROR for the unmapped', () => {
    expect(syncErrorCode(new RefundBlockedError('refund_exceeds_original', 'too much'))).toBe(
      'refund_exceeds_original',
    );
    expect(syncErrorCode(new Error('something unexpected'))).toBe('INTERNAL_ERROR');
    expect(syncErrorCode('a bare string failure')).toBe('INTERNAL_ERROR');
    expect(syncErrorCode(null)).toBe('INTERNAL_ERROR');
  });
});

describe('SyncService.flush — failed outcomes carry error_code', () => {
  it('unverified restricted line fails with AGE_VERIFICATION_REQUIRED (not the class name)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 800n });
      const { sync, catalogue } = makeSync(db);
      const actor = actorFor(tenant);
      await catalogue.createAgeRestriction(actor, { variantId: variant.variantId, minAge: 18 });

      const order = offlineOrder(tenant, {
        key: 'key-age-code',
        variantId: variant.variantId,
        quantity: 1n,
        unitPricePence: 800n,
      });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });

      expect(res.outcomes).toHaveLength(1);
      expect(res.outcomes[0]?.status).toBe('failed');
      expect(res.outcomes[0]?.error_code).toBe('AGE_VERIFICATION_REQUIRED');
      expect(res.outcomes[0]?.error).toContain('Age verification required');
      expect(res.outcomes[0]?.error).not.toContain('AgeVerificationRequiredException');
      // No order was completed and no stock moved.
      const orders = await db
        .selectFrom('orders')
        .select('status')
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(orders.map((o) => o.status)).not.toContain('completed');
    } finally {
      await close();
    }
  });

  it('unknown variant fails with NOT_FOUND', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);
      const order = offlineOrder(tenant, {
        key: 'key-unknown-variant',
        variantId: '00000000-0000-0000-0000-000000000000',
        quantity: 1n,
        unitPricePence: 1000n,
      });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });
      expect(res.outcomes[0]?.status).toBe('failed');
      expect(res.outcomes[0]?.error_code).toBe('NOT_FOUND');
      expect(res.outcomes[0]?.error).toContain('Resource not found');
    } finally {
      await close();
    }
  });

  it('location mismatch fails with LOCATION_MISMATCH', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);
      const order = offlineOrder(tenant, {
        key: 'key-loc-code',
        variantId: variant.variantId,
        quantity: 1n,
        unitPricePence: 1000n,
      });
      order.locationId = '00000000-0000-0000-0000-000000000000';
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });
      expect(res.outcomes[0]?.status).toBe('failed');
      expect(res.outcomes[0]?.error_code).toBe('LOCATION_MISMATCH');
    } finally {
      await close();
    }
  });

  it('empty lines fail with EMPTY_ORDER and a zero total with INVALID_TOTAL', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);
      const empty = offlineOrder(tenant, {
        key: 'key-empty',
        variantId: variant.variantId,
        quantity: 1n,
        unitPricePence: 1000n,
      });
      empty.lines = [];
      empty.tenderTotalPence = '1000';
      const zero = offlineOrder(tenant, {
        key: 'key-zero',
        variantId: variant.variantId,
        quantity: 0n,
        unitPricePence: 1000n,
      });
      const res = await sync.flush(actor, {
        registerId: tenant.registerId,
        orders: [empty, zero],
      });
      expect(res.outcomes[0]?.status).toBe('failed');
      expect(res.outcomes[0]?.error_code).toBe('EMPTY_ORDER');
      expect(res.outcomes[1]?.status).toBe('failed');
      expect(res.outcomes[1]?.error_code).toBe('INVALID_TOTAL');
    } finally {
      await close();
    }
  });

  it('snapshot line totals that do not sum to the tender total fail with SNAPSHOT_MISMATCH', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);
      const order = offlineOrder(tenant, {
        key: 'key-snapshot',
        variantId: variant.variantId,
        quantity: 1n,
        unitPricePence: 1000n,
      });
      order.tenderTotalPence = '1200';
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });
      expect(res.outcomes[0]?.status).toBe('failed');
      expect(res.outcomes[0]?.error_code).toBe('SNAPSHOT_MISMATCH');
      expect(res.outcomes[0]?.error).toContain('1000p but the tender total is 1200p');
    } finally {
      await close();
    }
  });

  it('a synced order carries error_code null', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant, { pricePence: 1000n });
      await setStock(db, tenant, variant.variantId, { quantity: 10n });
      const { sync } = makeSync(db);
      const actor = actorFor(tenant);
      const order = offlineOrder(tenant, {
        key: 'key-synced-code',
        variantId: variant.variantId,
        quantity: 1n,
        unitPricePence: 1000n,
      });
      const res = await sync.flush(actor, { registerId: tenant.registerId, orders: [order] });
      expect(res.outcomes[0]?.status).toBe('synced');
      expect(res.outcomes[0]?.error).toBeNull();
      expect(res.outcomes[0]?.error_code).toBeNull();
    } finally {
      await close();
    }
  });
});
