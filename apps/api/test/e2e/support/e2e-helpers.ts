/**
 * Shared setup for the Build-04 Objective 3 end-to-end suite
 * (apps/api/test/e2e/).
 *
 * Same pattern as the G-A-01–G-A-18 gate suite
 * (apps/api/test/gates/gates.test.ts): every test gets a fresh
 * in-memory PGlite database (createTestDb) with one seeded tenant,
 * and drives the production services directly — NOT the HTTP routes.
 * The HTTP route contract (POST /v1/sales/orders etc., see
 * sales.controller.ts / reporting.controller.ts) is a thin mapping
 * over these same service methods; no HTTP harness is wired here
 * because @nestjs/testing is not a dependency of this package, and
 * adding it is outside this worker's owned paths. Driving the
 * services directly is the established pattern for every API test in
 * this repo.
 */
import type { Kysely } from 'kysely';
import {
  createTestDb,
  seedTenant,
  seedVariant,
  setStock,
  type DB,
  type SeededTenant,
} from '@uk-pos/db';
import { CatalogueService } from  '../../../src/modules/catalogue/catalogue.service';
import { InventoryService } from  '../../../src/modules/inventory/inventory.service';
import { ApprovalService } from  '../../../src/modules/admin/approval.service';
import { AuditService } from  '../../../src/modules/admin/audit.service';
import { PaymentsService } from  '../../../src/modules/payments/payments.service';
import { SalesService } from  '../../../src/modules/sales/sales.service';
import { ReportingService } from  '../../../src/modules/reporting/reporting.service';
import { ExitService } from  '../../../src/modules/admin/exit.service';
import { ExportService } from  '../../../src/modules/admin/export.service';
import { GdprService } from  '../../../src/modules/admin/gdpr.service';
import { WebhookService } from  '../../../src/modules/integrations/webhook.service';
import type { Actor } from  '../../../src/common/actor';

export function managerActor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.manager.id,
    locationId: tenant.locationId,
    roles: ['manager'],
  };
}

export function cashierActor(tenant: SeededTenant): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users.cashier.id,
    locationId: tenant.locationId,
    roles: ['cashier'],
  };
}

export interface E2EServices {
  catalogue: CatalogueService;
  inventory: InventoryService;
  approvals: ApprovalService;
  audit: AuditService;
  payments: PaymentsService;
  sales: SalesService;
  reporting: ReportingService;
  exit: ExitService;
  exports: ExportService;
  gdpr: GdprService;
  webhooks: WebhookService;
}

export function makeServices(db: Kysely<DB>): E2EServices {
  const catalogue = new CatalogueService(db);
  const inventory = new InventoryService(db);
  const audit = new AuditService(db);
  const approvals = new ApprovalService(db, audit);
  const payments = new PaymentsService(db, audit, approvals);
  const sales = new SalesService(db, catalogue, inventory, approvals, audit, payments);
  const reporting = new ReportingService(db, approvals, audit);
  const exit = new ExitService(db, audit);
  const exportsSvc = new ExportService(db, audit);
  const gdpr = new GdprService(db, audit, exit, exportsSvc);
  const webhooks = new WebhookService(db, audit, { deliver: async () => 200 });
  return {
    catalogue,
    inventory,
    approvals,
    audit,
    payments,
    sales,
    reporting,
    exit,
    exports: exportsSvc,
    gdpr,
    webhooks,
  };
}

export async function withDb<T>(
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

/** A completed cash order (no card attempt involved). */
export async function completeCashOrder(
  tenant: SeededTenant,
  sales: SalesService,
  variantId: string,
  options: { registerId?: string; quantity?: bigint } = {},
) {
  const actor = managerActor(tenant);
  const { order } = await sales.createOrder(actor, {
    locationId: tenant.locationId,
    registerId: options.registerId,
    lines: [{ variantId, quantity: options.quantity ?? 1n }],
  });
  await sales.addTender(actor, {
    orderId: order.id,
    tenderType: 'cash',
    amountPence: order.total_pence,
  });
  return sales.completeOrder(actor, order.id);
}

export async function balanceOf(db: Kysely<DB>, variantId: string, warehouseId: string): Promise<bigint> {
  const row = await db
    .selectFrom('stock_balances')
    .select('quantity_on_hand')
    .where('variant_id', '=', variantId)
    .where('warehouse_id', '=', warehouseId)
    .executeTakeFirstOrThrow();
  return row.quantity_on_hand;
}

export async function orderStatus(db: Kysely<DB>, orderId: string): Promise<string> {
  const row = await db
    .selectFrom('orders')
    .select('status')
    .where('id', '=', orderId)
    .executeTakeFirstOrThrow();
  return row.status;
}

export async function auditEvents(
  db: Kysely<DB>,
  tenantId: string,
  eventType: string,
): Promise<Array<{ payload: Record<string, unknown> }>> {
  const rows = await db
    .selectFrom('audit_events')
    .select('payload')
    .where('tenant_id', '=', tenantId)
    .where('event_type', '=', eventType)
    .execute();
  return rows as Array<{ payload: Record<string, unknown> }>;
}

/** Run a promise that must reject; return the thrown value for assertions. */
export async function captureReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

export { seedVariant, setStock };
export type { SeededTenant };
