/**
 * PurchasingService — warehouses, stock transfers, reorder suggestions
 * and purchase orders (Build-04 Worker 4; Arch-06 §§2–5).
 *
 * These are the Phase-2 inventory tables that had schema (migrations
 * 003/007) but no service or controller in Build-02/03. Every method
 * takes the Actor first; every query filters tenant_id = actor.tenantId
 * (G-B — a resource that belongs to another tenant is NotFoundException,
 * never 403). No method moves stock: transfers and purchase orders are
 * records only — stock moves only via stock_movements (goods-in /
 * transfer receipt), which is out of this worker's scope.
 *
 * DESIGN DECISIONS set here (not research facts):
 *  - List pagination: `limit` defaults to 50, clamped to 1..100.
 *  - Transfers are created with status 'in_transit' (not 'draft'):
 *    there is no dispatch route in this worker's scope, so a draft
 *    could never leave draft; the dashboard creates a transfer that
 *    has already left the source warehouse. Lines start with
 *    received_quantity 0.
 *  - Purchase-order numbers are sequential per tenant+location
 *    (D-15), allocated as MAX+1 under a pg_advisory_xact_lock — the
 *    same pattern SalesService uses for order numbers. Currency is
 *    'GBP'. A PO line's cost defaults to the variant's cost_pence.
 *  - Accepting a reorder suggestion requires a supplier on the
 *    suggestion (400 otherwise — a PO cannot be addressed to nobody)
 *    and creates a DRAFT purchase order; the suggestion becomes
 *    'approved'. Accepting or dismissing a non-pending suggestion is
 *    409. Dismissing requires a non-empty reason; the reason is NOT
 *    persisted on the suggestion row — purchase_order_suggestions has
 *    no reason column in the schema — but it IS written to the audit
 *    trail (audit_events payload) when an AuditService is available.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { userIdAsUuid } from '../../common/uuid';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  DB,
  PurchaseOrdersTable,
  PurchaseOrderSuggestionsTable,
  StockTransfersTable,
  SupplierVariantsTable,
  SuppliersTable,
  WarehousesTable,
} from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { AuditService } from '../admin/audit.service';

/** Default page size for purchasing list endpoints. */
export const PURCHASING_DEFAULT_LIMIT = 50;
/** Hard cap for any purchasing list endpoint. */
export const PURCHASING_MAX_LIMIT = 100;

export type WarehouseRow = Selectable<WarehousesTable>;
export type SupplierRow = Selectable<SuppliersTable>;
export type SupplierVariantRow = Selectable<SupplierVariantsTable>;
export type StockTransferRow = Selectable<StockTransfersTable>;
export type ReorderSuggestionRow = Selectable<PurchaseOrderSuggestionsTable>;
export type PurchaseOrderRow = Selectable<PurchaseOrdersTable>;

export interface CreateWarehouseInput {
  locationId: string;
  name: string;
  /** 'store' | 'warehouse'; defaults to 'store'. */
  type?: 'store' | 'warehouse';
  /** Defaults to false — the caller names the default explicitly. */
  isDefault?: boolean;
}

export interface CreateSupplierInput {
  name: string;
  /** ISO 4217 code, uppercased; defaults to 'GBP'. */
  currency?: string;
  leadTimeDays?: number | null;
  minOrderValuePence?: bigint | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface LinkSupplierVariantInput {
  variantId: string;
  supplierSku?: string | null;
  costPence: bigint;
  /** Defaults to the supplier's currency when omitted. */
  currency?: string;
  /** Defaults to false. */
  isPreferred?: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('duplicate key value violates unique constraint');
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`Field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normaliseCurrency(value: unknown, field: string): string {
  if (value === undefined || value === null) return 'GBP';
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new BadRequestException(`Field ${field} must be a 3-letter currency code`);
  }
  return value.trim().toUpperCase();
}

export interface StockTransferLineView {
  variant_id: string;
  quantity: bigint;
  received_quantity: bigint;
}

export interface StockTransferView {
  transfer: StockTransferRow;
  lines: StockTransferLineView[];
}

export interface CreateTransferInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  lines: Array<{ variantId: string; quantity: bigint }>;
}

export interface CreatePurchaseOrderLineInput {
  variantId: string;
  /** Must be a positive integer (the table CHECKs quantity_ordered > 0). */
  quantityOrdered: bigint;
  /** Must be a non-negative integer (the table CHECKs cost_pence >= 0). */
  unitCostPence: bigint;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  /**
   * Warehouse the delivery is due at. The warehouse must belong to
   * the tenant (404 otherwise); its location becomes the PO's
   * location_id, and the warehouse is recorded on the PO (migration
   * 019) — purchase_orders had no warehouse column before Build-12.
   */
  warehouseId: string;
  /** Optional expected delivery date (migration 019, nullable). */
  expectedDeliveryDate?: Date | null;
  /** At least one line; the same variant may not appear twice (the
   * lines' primary key is (po_id, variant_id)). */
  lines: CreatePurchaseOrderLineInput[];
}

export interface PurchaseOrderLineView {
  variant_id: string;
  quantity_ordered: bigint;
  quantity_received: bigint;
  cost_pence: bigint;
}

export interface PurchaseOrderView {
  purchaseOrder: PurchaseOrderRow;
  lines: PurchaseOrderLineView[];
}

function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return PURCHASING_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), PURCHASING_MAX_LIMIT);
}

@Injectable()
export class PurchasingService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    // Optional, following the WebhookService precedent: the dismissal
    // reason is audit-logged when the service is available, and the
    // dismissal itself never depends on it.
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async listWarehouses(actor: Actor, limit?: number): Promise<WarehouseRow[]> {
    return this.db
      .selectFrom('warehouses')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(clampLimit(limit))
      .execute();
  }

  /**
   * Create a warehouse (Build-10 Objective 2).
   *
   * The location must exist and belong to the tenant (404 otherwise —
   * G-B). `is_default` is caller-specified, default false: the first
   * warehouse for a location does NOT auto-become the default — the
   * caller names it explicitly, the same way seedTenant does. One
   * default per location is enforced by the database itself
   * (migration 003 partial unique index
   * uq_warehouses_one_default_per_location on location_id WHERE
   * is_default); a second default for the same location surfaces as
   * 409, never 500.
   */
  async createWarehouse(actor: Actor, input: CreateWarehouseInput): Promise<WarehouseRow> {
    const locationId = requireNonEmpty(input.locationId, 'locationId');
    const name = requireNonEmpty(input.name, 'name');
    if (input.type !== undefined && input.type !== 'store' && input.type !== 'warehouse') {
      throw new BadRequestException("Field type must be 'store' or 'warehouse'");
    }
    const isDefault = input.isDefault ?? false;
    return this.db.transaction().execute(async (trx) => {
      const location = await trx
        .selectFrom('locations')
        .select('id')
        .where('id', '=', locationId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (location === undefined) {
        throw new NotFoundException('Resource not found');
      }
      try {
        return await trx
          .insertInto('warehouses')
          .values({
            tenant_id: actor.tenantId,
            location_id: locationId,
            name,
            type: input.type ?? 'store',
            is_default: isDefault,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('A default warehouse already exists for this location');
        }
        throw error;
      }
    });
  }

  async getWarehouse(actor: Actor, warehouseId: string): Promise<WarehouseRow> {
    const warehouse = await this.db
      .selectFrom('warehouses')
      .selectAll()
      .where('id', '=', warehouseId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (warehouse === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return warehouse;
  }

  /**
   * Create a supplier (Build-10 Objective 2). Name is required;
   * currency defaults to GBP; lead_time_days and
   * minimum_order_value_pence are optional and must be non-negative
   * when given (the table CHECKs enforce the same).
   */
  async createSupplier(actor: Actor, input: CreateSupplierInput): Promise<SupplierRow> {
    const name = requireNonEmpty(input.name, 'name');
    const currency = normaliseCurrency(input.currency, 'currency');
    if (
      input.leadTimeDays !== undefined &&
      input.leadTimeDays !== null &&
      (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0)
    ) {
      throw new BadRequestException('Field leadTimeDays must be a non-negative integer');
    }
    if (
      input.minOrderValuePence !== undefined &&
      input.minOrderValuePence !== null &&
      input.minOrderValuePence < 0n
    ) {
      throw new BadRequestException('Field minOrderValuePence must not be negative');
    }
    return this.db
      .insertInto('suppliers')
      .values({
        tenant_id: actor.tenantId,
        name,
        contact_name: input.contactName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        lead_time_days: input.leadTimeDays ?? null,
        minimum_order_value_pence: input.minOrderValuePence ?? null,
        currency,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listSuppliers(actor: Actor, limit?: number): Promise<SupplierRow[]> {
    return this.db
      .selectFrom('suppliers')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(clampLimit(limit))
      .execute();
  }

  async getSupplier(actor: Actor, supplierId: string): Promise<SupplierRow> {
    const supplier = await this.db
      .selectFrom('suppliers')
      .selectAll()
      .where('id', '=', supplierId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (supplier === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return supplier;
  }

  /**
   * Link a variant to a supplier (Build-10 Objective 2). The supplier
   * and the variant must both exist and belong to the tenant (404
   * otherwise). Upsert semantics, like createAgeRestriction /
   * setPriceBookEntry: re-linking the same (supplier, variant) pair
   * replaces the row instead of 409ing. `is_preferred` is stored on
   * the link (migration 017); cost must be a non-negative integer.
   */
  async linkSupplierVariant(
    actor: Actor,
    supplierId: string,
    input: LinkSupplierVariantInput,
  ): Promise<SupplierVariantRow> {
    const variantId = requireNonEmpty(input.variantId, 'variantId');
    if (input.costPence < 0n) {
      throw new BadRequestException('Field costPence must not be negative');
    }
    const currency = normaliseCurrency(input.currency, 'currency');
    return this.db.transaction().execute(async (trx) => {
      const supplier = await trx
        .selectFrom('suppliers')
        .select(['id', 'currency'])
        .where('id', '=', supplierId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (supplier === undefined) {
        throw new NotFoundException('Resource not found');
      }
      const variant = await trx
        .selectFrom('product_variants')
        .select('id')
        .where('id', '=', variantId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (variant === undefined) {
        throw new NotFoundException('Resource not found');
      }
      return trx
        .insertInto('supplier_variants')
        .values({
          supplier_id: supplierId,
          variant_id: variantId,
          supplier_sku: input.supplierSku ?? null,
          cost_pence: input.costPence,
          // No currency given → the supplier's own currency, not a
          // bare 'GBP' guess: a EUR supplier's links stay EUR.
          currency: input.currency === undefined ? supplier.currency : currency,
          is_preferred: input.isPreferred ?? false,
        })
        .onConflict((oc) =>
          oc.columns(['supplier_id', 'variant_id']).doUpdateSet({
            supplier_sku: input.supplierSku ?? null,
            cost_pence: input.costPence,
            currency: input.currency === undefined ? supplier.currency : currency,
            is_preferred: input.isPreferred ?? false,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async listTransfers(actor: Actor, limit?: number): Promise<StockTransferView[]> {
    const transfers = await this.db
      .selectFrom('stock_transfers')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
    const views: StockTransferView[] = [];
    for (const transfer of transfers) {
      views.push({ transfer, lines: await this.transferLines(transfer.id) });
    }
    return views;
  }

  private async transferLines(
    transferId: string,
    q: Kysely<DB> = this.db,
  ): Promise<StockTransferLineView[]> {
    const rows = await q
      .selectFrom('stock_transfer_lines')
      .select(['variant_id', 'quantity', 'received_quantity'])
      .where('transfer_id', '=', transferId)
      .orderBy('variant_id', 'asc')
      .execute();
    return rows.map((row) => ({
      variant_id: row.variant_id,
      quantity: row.quantity,
      received_quantity: row.received_quantity,
    }));
  }

  async createTransfer(actor: Actor, input: CreateTransferInput): Promise<StockTransferView> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new BadRequestException('Transfer source and destination warehouses must differ');
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new BadRequestException('A transfer requires at least one line');
    }
    for (const line of input.lines) {
      if (line.quantity <= 0n) {
        throw new BadRequestException('Transfer line quantities must be greater than zero');
      }
    }
    return this.db.transaction().execute(async (trx) => {
      for (const warehouseId of [input.fromWarehouseId, input.toWarehouseId]) {
        const warehouse = await trx
          .selectFrom('warehouses')
          .select('id')
          .where('id', '=', warehouseId)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        if (warehouse === undefined) {
          throw new NotFoundException('Resource not found');
        }
      }
      for (const line of input.lines) {
        const variant = await trx
          .selectFrom('product_variants')
          .select('id')
          .where('id', '=', line.variantId)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        if (variant === undefined) {
          throw new NotFoundException('Resource not found');
        }
      }
      const transfer = await trx
        .insertInto('stock_transfers')
        .values({
          tenant_id: actor.tenantId,
          from_warehouse_id: input.fromWarehouseId,
          to_warehouse_id: input.toWarehouseId,
          status: 'in_transit',
          requested_by_user_id: userIdAsUuid(actor.userId),
          received_by_user_id: null,
          received_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const line of input.lines) {
        await trx
          .insertInto('stock_transfer_lines')
          .values({
            transfer_id: transfer.id,
            variant_id: line.variantId,
            quantity: line.quantity,
            received_quantity: 0n,
          })
          .execute();
      }
      return { transfer, lines: await this.transferLines(transfer.id, trx) };
    });
  }

  async listReorderSuggestions(actor: Actor, limit?: number): Promise<ReorderSuggestionRow[]> {
    return this.db
      .selectFrom('purchase_order_suggestions')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(clampLimit(limit))
      .execute();
  }

  async acceptReorderSuggestion(actor: Actor, suggestionId: string): Promise<PurchaseOrderView> {
    return this.db.transaction().execute(async (trx) => {
      const suggestion = await trx
        .selectFrom('purchase_order_suggestions')
        .selectAll()
        .where('id', '=', suggestionId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (suggestion === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (suggestion.status !== 'pending') {
        throw new ConflictException(`Reorder suggestion is ${suggestion.status}, not pending`);
      }
      if (suggestion.supplier_id === null) {
        throw new BadRequestException('Reorder suggestion has no supplier: a purchase order cannot be addressed to nobody');
      }
      const variant = await trx
        .selectFrom('product_variants')
        .select(['id', 'cost_pence'])
        .where('id', '=', suggestion.variant_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (variant === undefined) {
        throw new NotFoundException('Resource not found');
      }
      // D-15: sequential PO numbers, MAX+1 under an advisory lock.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${actor.tenantId}|${suggestion.location_id}|po_number`}))`.execute(trx);
      const maxResult = await sql<{ max_number: string | bigint | null }>`
        SELECT MAX(po_number) AS max_number FROM purchase_orders
        WHERE tenant_id = ${actor.tenantId} AND location_id = ${suggestion.location_id}
      `.execute(trx);
      const maxRow = maxResult.rows[0];
      const poNumber = (maxRow?.max_number == null ? 0n : BigInt(maxRow.max_number)) + 1n;

      const purchaseOrder = await trx
        .insertInto('purchase_orders')
        .values({
          tenant_id: actor.tenantId,
          location_id: suggestion.location_id,
          supplier_id: suggestion.supplier_id,
          po_number: poNumber,
          status: 'draft',
          currency: 'GBP',
          exchange_rate: null,
          sent_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('purchase_order_lines')
        .values({
          po_id: purchaseOrder.id,
          variant_id: suggestion.variant_id,
          quantity_ordered: suggestion.suggested_quantity,
          quantity_received: 0n,
          cost_pence: variant.cost_pence,
          currency: 'GBP',
        })
        .execute();
      await trx
        .updateTable('purchase_order_suggestions')
        .set({ status: 'approved' })
        .where('id', '=', suggestion.id)
        .execute();
      const lines: PurchaseOrderLineView[] = [
        {
          variant_id: suggestion.variant_id,
          quantity_ordered: suggestion.suggested_quantity,
          quantity_received: 0n,
          cost_pence: variant.cost_pence,
        },
      ];
      return { purchaseOrder, lines };
    });
  }

  /**
   * Create a standalone DRAFT purchase order (Build-12 Objective 3,
   * closing the G-UI-06 "no standalone create-PO route" gap). This is
   * the complement to acceptReorderSuggestion: same PO shape, same
   * D-15 sequential numbering (MAX+1 under an advisory lock, per
   * tenant+location), same 'draft' status and GBP currency — only the
   * source differs (an operator's explicit order instead of a
   * suggestion). The supplier, the warehouse and every variant must
   * exist and belong to the tenant (404 otherwise — G-B). The
   * warehouse's location becomes the PO's location_id.
   */
  async createPurchaseOrder(actor: Actor, input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> {
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new BadRequestException('A purchase order requires at least one line');
    }
    for (const line of input.lines) {
      if (line.quantityOrdered <= 0n) {
        throw new BadRequestException('Purchase order line quantities must be greater than zero');
      }
      if (line.unitCostPence < 0n) {
        throw new BadRequestException('Purchase order line costs must not be negative');
      }
    }
    const variantIds = input.lines.map((line) => line.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException('A purchase order cannot list the same variant twice');
    }
    return this.db.transaction().execute(async (trx) => {
      const supplier = await trx
        .selectFrom('suppliers')
        .select('id')
        .where('id', '=', input.supplierId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (supplier === undefined) {
        throw new NotFoundException('Resource not found');
      }
      const warehouse = await trx
        .selectFrom('warehouses')
        .select(['id', 'location_id'])
        .where('id', '=', input.warehouseId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (warehouse === undefined) {
        throw new NotFoundException('Resource not found');
      }
      for (const line of input.lines) {
        const variant = await trx
          .selectFrom('product_variants')
          .select('id')
          .where('id', '=', line.variantId)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        if (variant === undefined) {
          throw new NotFoundException('Resource not found');
        }
      }
      // D-15: sequential PO numbers, MAX+1 under an advisory lock —
      // the same pattern acceptReorderSuggestion uses.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${actor.tenantId}|${warehouse.location_id}|po_number`}))`.execute(trx);
      const maxResult = await sql<{ max_number: string | bigint | null }>`
        SELECT MAX(po_number) AS max_number FROM purchase_orders
        WHERE tenant_id = ${actor.tenantId} AND location_id = ${warehouse.location_id}
      `.execute(trx);
      const maxRow = maxResult.rows[0];
      const poNumber = (maxRow?.max_number == null ? 0n : BigInt(maxRow.max_number)) + 1n;

      const purchaseOrder = await trx
        .insertInto('purchase_orders')
        .values({
          tenant_id: actor.tenantId,
          location_id: warehouse.location_id,
          supplier_id: input.supplierId,
          po_number: poNumber,
          status: 'draft',
          currency: 'GBP',
          exchange_rate: null,
          sent_at: null,
          warehouse_id: input.warehouseId,
          expected_delivery_date: input.expectedDeliveryDate ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const line of input.lines) {
        await trx
          .insertInto('purchase_order_lines')
          .values({
            po_id: purchaseOrder.id,
            variant_id: line.variantId,
            quantity_ordered: line.quantityOrdered,
            quantity_received: 0n,
            cost_pence: line.unitCostPence,
            currency: 'GBP',
          })
          .execute();
      }
      return { purchaseOrder, lines: await this.purchaseOrderLines(purchaseOrder.id, trx) };
    });
  }

  async dismissReorderSuggestion(
    actor: Actor,
    suggestionId: string,
    reason: string,
  ): Promise<ReorderSuggestionRow> {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new BadRequestException('A dismiss reason is required');
    }
    const dismissed = await this.db.transaction().execute(async (trx) => {
      const suggestion = await trx
        .selectFrom('purchase_order_suggestions')
        .selectAll()
        .where('id', '=', suggestionId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (suggestion === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (suggestion.status !== 'pending') {
        throw new ConflictException(`Reorder suggestion is ${suggestion.status}, not pending`);
      }
      return trx
        .updateTable('purchase_order_suggestions')
        .set({ status: 'dismissed' })
        .where('id', '=', suggestion.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    // The reason has no column on purchase_order_suggestions; keep it
    // in the audit trail (the durable record of why it was dismissed).
    if (this.auditService !== undefined) {
      await this.auditService.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'reorder_suggestion.dismissed',
        entityType: 'purchase_order_suggestion',
        entityId: dismissed.id,
        payload: { reason: reason.trim() },
      });
    }
    return dismissed;
  }

  async listPurchaseOrders(actor: Actor, limit?: number): Promise<PurchaseOrderView[]> {
    const orders = await this.db
      .selectFrom('purchase_orders')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
    const views: PurchaseOrderView[] = [];
    for (const order of orders) {
      views.push({ purchaseOrder: order, lines: await this.purchaseOrderLines(order.id) });
    }
    return views;
  }

  private async purchaseOrderLines(
    poId: string,
    q: Kysely<DB> = this.db,
  ): Promise<PurchaseOrderLineView[]> {
    const rows = await q
      .selectFrom('purchase_order_lines')
      .select(['variant_id', 'quantity_ordered', 'quantity_received', 'cost_pence'])
      .where('po_id', '=', poId)
      .orderBy('variant_id', 'asc')
      .execute();
    return rows.map((row) => ({
      variant_id: row.variant_id,
      quantity_ordered: row.quantity_ordered,
      quantity_received: row.quantity_received,
      cost_pence: row.cost_pence,
    }));
  }

  async sendPurchaseOrder(actor: Actor, poId: string): Promise<PurchaseOrderView> {
    const sent = await this.db
      .updateTable('purchase_orders')
      .set({ status: 'sent', sent_at: new Date() })
      .where('id', '=', poId)
      .where('tenant_id', '=', actor.tenantId)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    if (sent === undefined) {
      const existing = await this.db
        .selectFrom('purchase_orders')
        .select('status')
        .where('id', '=', poId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new NotFoundException('Resource not found');
      }
      throw new ConflictException(`Purchase order is ${existing.status}, not draft`);
    }
    return { purchaseOrder: sent, lines: await this.purchaseOrderLines(sent.id) };
  }
}
