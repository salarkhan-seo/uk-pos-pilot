/**
 * E2E — full admin back-office workflow (Build-04, Objective 3).
 *
 * One continuous flow through the production services, in order:
 *   reorder suggestion -> purchase order -> goods-in weighted-average
 *   revaluation -> register sale -> session close -> immutable
 *   Z-report -> Xero/QBO CSV export -> 30-day tenant exit &
 *   SHA-256 manifest verification -> hard delete with the 6-year
 *   statutory VAT archive separated.
 *
 * Two steps have NO service in Build-03 and are driven as the rows
 * the admin console (Worker 2, apps/admin-web) would create — the
 * test says so where it happens, and every downstream step that DOES
 * have a service runs through that service:
 *   - the reorder SUGGESTION computation and the PURCHASE ORDER
 *     creation are direct inserts (no suggestion/PO service exists);
 *     the goods-in service then consumes the PO for real, advancing
 *     it to 'received'.
 *   - the suggestion quantity rule is a DESIGN DECISION (not a
 *     research fact): suggested_quantity = max_quantity -
 *     quantity_on_hand when on-hand is below min_quantity.
 *     (3 on hand, min 5, max 20 -> suggest 17.)
 *
 * Revaluation check (Arch-06 §5): 3 units @ 500p + 17 received @
 * 400p -> (3*500 + 17*400) / 20 = 415p weighted average.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  BadRequestException,
  ForbiddenException,
  type ExecutionContext,
} from '@nestjs/common';
import type { DB } from '@uk-pos/db';
import {
  balanceOf,
  captureReject,
  completeCashOrder,
  makeServices,
  managerActor,
  seedVariant,
  setStock,
  withDb,
} from './support/e2e-helpers';
import {
  Z_REPORT_CSV_COLUMNS,
  type ZReportView,
} from '../../src/modules/reporting/reporting.service';
import { ExitService, TenantWriteGuard } from '../../src/modules/admin/exit.service';

const ZERO_ROW_TABLES = [
  'orders',
  'order_lines',
  'order_tenders',
  'payment_attempts',
  'refunds',
  'stock_movements',
  'audit_events',
  'z_reports',
  'register_sessions',
  'customers',
] as const;

async function countTenantRows(db: Kysely<DB>, table: string, tenantId: string): Promise<number> {
  const counted = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM ${sql.table(table)}
    WHERE ${sql.id('tenant_id')} = ${tenantId}
  `.execute(db);
  return Number(counted.rows[0]?.count ?? '0');
}

/** Recompute the SHA-256 of every exported file and compare it with the manifest. */
function verifyManifest(
  files: Record<string, string>,
  manifest: Array<{ file_name: string; row_count: number; sha256_checksum: string }>,
): void {
  expect(manifest.length).toBeGreaterThan(0);
  for (const entry of manifest) {
    const content = files[entry.file_name];
    expect(content).toBeDefined();
    expect(createHash('sha256').update(content as string).digest('hex')).toBe(
      entry.sha256_checksum,
    );
  }
  const manifestJson = JSON.parse(files['manifest.json'] as string) as {
    files: Array<{ file_name: string; sha256_checksum: string }>;
  };
  expect(manifestJson.files.map((f) => f.file_name).sort()).toEqual(
    manifest.map((m) => m.file_name).sort(),
  );
}

describe('E2E — admin back-office workflow end to end', () => {
  it('reorder -> PO -> goods-in revaluation -> sale -> session close -> Z-report -> CSV -> 30-day exit -> manifest verification -> hard delete', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const services = makeServices(db);
      const startAt = new Date('2026-11-13T12:00:00.000Z');
      let now = startAt;
      services.exit.setClock(() => now);
      services.gdpr.setClock(() => now);

      // --- Catalogue + supplier -------------------------------------
      const variant = await seedVariant(db, tenant, { costPence: 500n, pricePence: 1000n });
      const supplier = await db
        .insertInto('suppliers')
        .values({
          tenant_id: tenant.tenantId,
          name: 'Acme Wholesale Ltd',
          contact_name: null,
          email: null,
          phone: null,
          lead_time_days: 2,
          minimum_order_value_pence: null,
          currency: 'GBP',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // --- Reorder suggestion (no service in Build-03: the rows the
      // --- admin console would create) ------------------------------
      await setStock(db, tenant, variant.variantId, { quantity: 3n, costPence: 500n });
      await db
        .insertInto('reorder_points')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          variant_id: variant.variantId,
          min_quantity: 5n,
          max_quantity: 20n,
          supplier_id: supplier.id,
        })
        .execute();
      const onHand = await balanceOf(db, variant.variantId, tenant.warehouseId);
      expect(onHand).toBe(3n);
      // DESIGN DECISION: suggested_quantity = max_quantity -
      // quantity_on_hand when on-hand < min_quantity (3 < 5 -> 17).
      // A suggestion is NOT an order (Arch-06 §4.2): it never sends a PO.
      const suggestedQuantity = 20n - onHand;
      expect(suggestedQuantity).toBe(17n);
      const suggestion = await db
        .insertInto('purchase_order_suggestions')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          variant_id: variant.variantId,
          supplier_id: supplier.id,
          suggested_quantity: suggestedQuantity,
          expected_date: null,
          status: 'pending',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // --- Accept the suggestion into a draft PO (no PO service in
      // --- Build-03: the rows the admin console would create) --------
      const po = await db
        .insertInto('purchase_orders')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          supplier_id: supplier.id,
          po_number: 1n,
          status: 'draft',
          currency: 'GBP',
          exchange_rate: null,
          sent_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('purchase_order_lines')
        .values({
          po_id: po.id,
          variant_id: variant.variantId,
          quantity_ordered: suggestedQuantity,
          quantity_received: 0n,
          cost_pence: 400n,
          currency: 'GBP',
        })
        .execute();
      await db
        .updateTable('purchase_order_suggestions')
        .set({ status: 'approved' })
        .where('id', '=', suggestion.id)
        .execute();

      // --- Goods-in through the real service: weighted-average
      // --- revaluation 3 @ 500p + 17 @ 400p -> 415p, balance 20 ------
      const { receiptId } = await services.inventory.receiveGoodsIn(actor, {
        poId: po.id,
        supplierId: supplier.id,
        locationId: tenant.locationId,
        warehouseId: tenant.warehouseId,
        lines: [{ variantId: variant.variantId, quantityReceived: 17n, costPence: 400n }],
      });
      expect(receiptId).toBeDefined();
      const poAfter = await db
        .selectFrom('purchase_orders')
        .selectAll()
        .where('id', '=', po.id)
        .executeTakeFirstOrThrow();
      expect(poAfter.status).toBe('received');
      const poLineAfter = await db
        .selectFrom('purchase_order_lines')
        .selectAll()
        .where('po_id', '=', po.id)
        .executeTakeFirstOrThrow();
      expect(poLineAfter.quantity_received).toBe(17n);
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(20n);
      const valuation = await db
        .selectFrom('stock_valuation')
        .selectAll()
        .where('variant_id', '=', variant.variantId)
        .where('warehouse_id', '=', tenant.warehouseId)
        .executeTakeFirstOrThrow();
      expect(valuation.weighted_average_cost_pence).toBe(415n);
      expect(valuation.quantity_on_hand).toBe(20n);

      // --- Register sale inside a session ---------------------------
      const { session } = await services.reporting.openSession(actor, {
        registerId: tenant.registerId,
        openingFloatPence: 5000n,
      });
      const { order: cashOrder } = await completeCashOrder(tenant, services.sales, variant.variantId, {
        registerId: tenant.registerId,
        quantity: 2n,
      });
      expect(cashOrder.status).toBe('completed');
      expect(await balanceOf(db, variant.variantId, tenant.warehouseId)).toBe(18n);
      const ended = await services.reporting.endSession(actor, session.id);
      expect(ended.expected_cash_pence).toBe(7000n); // £50 float + £20 cash sale

      // --- Session close issues the immutable Z-report ---------------
      const { zReport }: { zReport: ZReportView } = await services.reporting.closeSession(actor, {
        sessionId: session.id,
        countedCashPence: 7000n,
      });
      expect(zReport.zReport.status).toBe('issued');
      expect(zReport.zReport.z_number).toBe(1n);
      expect(zReport.zReport.order_count).toBe(1);
      expect(zReport.zReport.gross_pence).toBe(2000n);
      const zRow = await services.reporting.getZReport(actor, zReport.zReport.id);
      expect(zRow.zReport.id).toBe(zReport.zReport.id);
      await expect(
        db
          .updateTable('z_reports')
          .set({ gross_pence: 1n })
          .where('id', '=', zReport.zReport.id)
          .execute(),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.deleteFrom('z_reports').where('id', '=', zReport.zReport.id).execute(),
      ).rejects.toThrow(/immutable/);

      // --- Xero/QBO CSV export (Arch-02 §5.3) -----------------------
      const csvExport = await services.reporting.exportZReportCsv(actor, zReport.zReport.id, {
        generatedAt: startAt,
      });
      expect(csvExport.fileName).toContain('1');
      const header = csvExport.csv.split('\n')[0] as string;
      expect(header).toBe(Z_REPORT_CSV_COLUMNS.join(','));
      expect(createHash('sha256').update(csvExport.csv).digest('hex')).toBe(csvExport.sha256);
      expect(csvExport.csv).toContain('GBP');
      // Re-running the export reproduces the same content (minus the
      // generated-at timestamp): same header, same rows.
      const csvAgain = await services.reporting.exportZReportCsv(actor, zReport.zReport.id, {
        generatedAt: startAt,
      });
      expect(csvAgain.csv).toBe(csvExport.csv);
      expect(csvAgain.sha256).toBe(csvExport.sha256);

      // --- 30-day tenant exit ----------------------------------------
      // Termination is unblocked: the session is closed and no card
      // payment is pending/unknown.
      expect(ExitService.hasBlockers(await services.exit.findBlockers(tenant.tenantId))).toBe(false);
      const requested = await services.exit.requestTermination(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(requested.status).toBe('termination_requested');
      const { tenant: inWindow, windowEndsAt } = await services.exit.beginExportWindow(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(inWindow.status).toBe('export_window');
      expect(windowEndsAt.getTime()).toBe(startAt.getTime() + 30 * 24 * 60 * 60 * 1000);

      // The export window is read-only, at the service layer and at
      // the HTTP guard layer.
      const writeBlocked = await captureReject(
        services.exit.assertTenantWritable(tenant.tenantId),
      );
      expect(writeBlocked).toBeInstanceOf(ForbiddenException);
      const guard = new TenantWriteGuard(services.exit);
      const guardContext = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-tenant-id': tenant.tenantId } }),
        }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(guardContext)).rejects.toThrow(ForbiddenException);
      await expect(
        services.exit.scheduleHardDelete(tenant.tenantId, tenant.users.owner.id),
      ).rejects.toThrow(BadRequestException);

      // --- Single-click full export + SHA-256 manifest verification --
      const fullExport = await services.exports.runFullExport(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(fullExport.totalRows).toBeGreaterThan(0);
      verifyManifest(fullExport.files, fullExport.manifest);
      const ordersJson = JSON.parse(fullExport.files['orders.json'] as string) as Array<
        Record<string, unknown>
      >;
      const ordersEntry = fullExport.manifest.find((m) => m.file_name === 'orders.json');
      expect(ordersEntry).toBeDefined();
      expect(ordersJson.length).toBe(ordersEntry?.row_count);
      expect(ordersJson.some((o) => o.id === cashOrder.id)).toBe(true);
      const movementsJson = JSON.parse(
        fullExport.files['stock_movements.json'] as string,
      ) as Array<Record<string, unknown>>;
      const movementsEntry = fullExport.manifest.find(
        (m) => m.file_name === 'stock_movements.json',
      );
      expect(movementsJson.length).toBe(movementsEntry?.row_count);
      expect(movementsJson.length).toBeGreaterThanOrEqual(2); // goods-in + sale

      // --- Window ends, hard delete, statutory archive --------------
      now = new Date(startAt.getTime() + 31 * 24 * 60 * 60 * 1000);
      const scheduled = await services.exit.scheduleHardDelete(
        tenant.tenantId,
        tenant.users.owner.id,
      );
      expect(scheduled.status).toBe('hard_delete_scheduled');
      const deleted = await services.gdpr.hardDelete(tenant.tenantId, tenant.users.owner.id);
      expect(deleted.verifiedRowCount).toBe(0);
      expect(deleted.deletedAt.getTime()).toBe(now.getTime());

      // Tombstone retained: id + deleted_at only.
      const tombstone = await db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', tenant.tenantId)
        .executeTakeFirstOrThrow();
      expect(tombstone.status).toBe('deleted');
      expect(tombstone.name).toBe('[deleted]');
      expect(tombstone.vat_number).toBeNull();

      // Zero rows remain for the tenant in every table.
      for (const table of ZERO_ROW_TABLES) {
        expect(await countTenantRows(db, table, tenant.tenantId)).toBe(0);
      }

      // The deletion job is logged.
      const jobs = await db
        .selectFrom('deletion_jobs')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe('completed');
      expect(jobs[0]?.verified_row_count).toBe(0);

      // The 6-year statutory VAT archive was separated first, with
      // its own manifest whose checksums verify.
      verifyManifest(deleted.archive.files, deleted.archive.manifest);
      const archiveOrders = JSON.parse(
        deleted.archive.files['orders.json'] as string,
      ) as Array<Record<string, unknown>>;
      expect(archiveOrders.some((o) => o.id === cashOrder.id)).toBe(true);
    });
  });
});
