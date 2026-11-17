/**
 * Multi-warehouse inventory console (Build-04 Objective 2).
 *
 * - Stock balances are read models: `stock_balances` carries
 *   `computed_at`; the console displays it and flags a balance as
 *   STALE when it is older than the display threshold (design decision
 *   D-AW-11: 15 minutes — a read-model timestamp is a display hint,
 *   never authoritative for a sale; the API's `GET /v1/inventory/stock`
 *   returns live ledger sums in this build).
 * - Transfers move through `draft → in_transit → received`; the console
 *   surfaces `in_transit` transfers with their unreceived quantities so
 *   stock in flight is never mistaken for stock on hand.
 * - Reorder suggestions: accept creates a DRAFT purchase order (never
 *   sends it), dismiss requires a reason. Both transitions are
 *   server-side; the console only shapes the request.
 * - Stock counts: one active count per location (D-10); the console
 *   starts a count, records counted quantities per line, and submits —
 *   variances become adjustment movements server-side.
 */
import type { AdminApiClient } from '../api/client';
import type {
  CreatePurchaseOrderInput,
  CreateSupplierInput,
  CreateWarehouseInput,
  LinkSupplierVariantInput,
  PurchaseOrderView,
  ReorderSuggestionView,
  StockLevelView,
  StockTransferView,
  SupplierVariantView,
  SupplierView,
  WarehouseView,
} from '../api/types';

/** A computed_at older than this is shown as STALE (display hint only). */
export const STOCK_BALANCE_STALE_MS = 15 * 60 * 1000;

export interface StockBalanceRow extends StockLevelView {
  stale: boolean;
  ageMs: number | null;
}

export function toStockBalanceRow(level: StockLevelView, now: Date = new Date()): StockBalanceRow {
  if (level.computedAt === undefined || level.computedAt === null) {
    return { ...level, stale: false, ageMs: null };
  }
  const ageMs = now.getTime() - new Date(level.computedAt).getTime();
  return { ...level, stale: ageMs > STOCK_BALANCE_STALE_MS, ageMs };
}

export interface InTransitRow {
  transfer: StockTransferView;
  unreceivedByVariant: Array<{ variantId: string; quantity: string; receivedQuantity: string; outstanding: string }>;
}

export function toInTransitRows(transfers: StockTransferView[]): InTransitRow[] {
  return transfers
    .filter((t) => t.status === 'in_transit')
    .map((transfer) => ({
      transfer,
      unreceivedByVariant: transfer.lines.map((line) => ({
        variantId: line.variant_id,
        quantity: line.quantity,
        receivedQuantity: line.received_quantity,
        outstanding: (BigInt(line.quantity) - BigInt(line.received_quantity)).toString(),
      })),
    }));
}

export class InventoryConsole {
  constructor(private readonly api: AdminApiClient) {}

  async stockBalances(filters: { variantId?: string; warehouseId?: string } = {}, now: Date = new Date()): Promise<StockBalanceRow[]> {
    // Balances carry the weighted-average cost + total value (Build-11
    // Objective 1). In LIVE mode this needs the route-table entries
    // Obj 4 adds ('inventory.getBalances'); until then the live shell
    // shows a section error, same as suppliers in Build-10 Obj 2.
    const levels = await this.api.getBalances(filters);
    return levels.map((level) => toStockBalanceRow(level, now));
  }

  async listWarehouses(): Promise<WarehouseView[]> {
    return this.api.listWarehouses();
  }

  /** Create a warehouse (Build-10 Objective 2). */
  async createWarehouse(input: CreateWarehouseInput): Promise<WarehouseView> {
    if (input.name.trim() === '') {
      throw new Error('Warehouse name is required.');
    }
    if (input.type !== undefined && input.type !== 'store' && input.type !== 'warehouse') {
      throw new Error("Warehouse type must be 'store' or 'warehouse'.");
    }
    return this.api.createWarehouse(input);
  }

  async getWarehouse(warehouseId: string): Promise<WarehouseView> {
    return this.api.getWarehouse(warehouseId);
  }

  /** Suppliers (Build-10 Objective 2). */
  async createSupplier(input: CreateSupplierInput): Promise<SupplierView> {
    if (input.name.trim() === '') {
      throw new Error('Supplier name is required.');
    }
    return this.api.createSupplier(input);
  }

  async listSuppliers(): Promise<SupplierView[]> {
    return this.api.listSuppliers();
  }

  async getSupplier(supplierId: string): Promise<SupplierView> {
    return this.api.getSupplier(supplierId);
  }

  async linkSupplierVariant(
    supplierId: string,
    input: LinkSupplierVariantInput,
  ): Promise<SupplierVariantView> {
    if (!/^\d+$/.test(input.costPence.trim())) {
      throw new Error('Cost must be a non-negative integer.');
    }
    return this.api.linkSupplierVariant(supplierId, input);
  }

  async inTransitTransfers(): Promise<InTransitRow[]> {
    const transfers = await this.api.listTransfers();
    return toInTransitRows(transfers);
  }

  async createTransfer(input: { fromWarehouseId: string; toWarehouseId: string; lines: Array<{ variantId: string; quantity: string }> }): Promise<StockTransferView> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new Error('Transfer source and destination warehouses must differ.');
    }
    if (input.lines.length === 0) {
      throw new Error('A transfer needs at least one line.');
    }
    return this.api.createTransfer(input);
  }

  async listReorderSuggestions(): Promise<ReorderSuggestionView[]> {
    return this.api.listReorderSuggestions();
  }

  /** Accept → draft purchase order (created, never sent). */
  async acceptSuggestion(suggestionId: string): Promise<PurchaseOrderView> {
    return this.api.acceptReorderSuggestion(suggestionId);
  }

  /** Dismiss requires a reason; the reason is recorded with the dismissal. */
  async dismissSuggestion(suggestionId: string, reason: string): Promise<ReorderSuggestionView> {
    if (reason.trim() === '') {
      throw new Error('A reason is required to dismiss a reorder suggestion.');
    }
    return this.api.dismissReorderSuggestion(suggestionId, reason.trim());
  }

  async listPurchaseOrders(): Promise<PurchaseOrderView[]> {
    return this.api.listPurchaseOrders();
  }

  /**
   * Create a standalone DRAFT purchase order (Build-12 Objective 3)
   * — the complement to accepting a reorder suggestion, which also
   * creates a draft PO. Client-side validation mirrors the server's:
   * supplier and warehouse required, at least one line, no duplicate
   * variant in the lines, quantities positive integers, unit costs
   * non-negative integers, and an expected date that parses when
   * supplied. The server remains authoritative (404 on an unknown
   * supplier/warehouse/variant).
   */
  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> {
    if (input.supplierId.trim() === '') {
      throw new Error('Supplier is required.');
    }
    if (input.warehouseId.trim() === '') {
      throw new Error('Warehouse is required.');
    }
    if (input.lines.length === 0) {
      throw new Error('A purchase order needs at least one line.');
    }
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (line.variantId.trim() === '') {
        throw new Error('Each line needs a variant.');
      }
      if (seen.has(line.variantId)) {
        throw new Error('Lines must not contain a duplicate variant.');
      }
      seen.add(line.variantId);
      if (!/^\d+$/.test(line.quantityOrdered.trim()) || BigInt(line.quantityOrdered) <= 0n) {
        throw new Error('Quantity ordered must be a positive integer.');
      }
      if (!/^\d+$/.test(line.unitCostPence.trim())) {
        throw new Error('Unit cost must be a non-negative integer.');
      }
    }
    if (
      input.expectedDeliveryDate !== undefined &&
      input.expectedDeliveryDate !== null &&
      Number.isNaN(Date.parse(input.expectedDeliveryDate))
    ) {
      throw new Error('Expected delivery date must be a valid date.');
    }
    return this.api.createPurchaseOrder(input);
  }

  async sendPurchaseOrder(poId: string): Promise<PurchaseOrderView> {
    return this.api.sendPurchaseOrder(poId);
  }

  async startCount(locationId: string, warehouseId?: string | null): Promise<{ id: string; status: string }> {
    return this.api.startCount({ locationId, warehouseId: warehouseId ?? null });
  }

  async setCountedQuantity(countId: string, variantId: string, countedQuantity: string, warehouseId?: string | null): Promise<{ countId: string; variantId: string; expectedQuantity: string; countedQuantity: string | null }> {
    if (!/^\d+$/.test(countedQuantity.trim())) {
      throw new Error('Counted quantity must be a non-negative integer.');
    }
    return this.api.setCountedQuantity(countId, { variantId, warehouseId: warehouseId ?? null, countedQuantity });
  }

  async submitCount(countId: string): Promise<{ adjustments: Array<{ variantId: string; variance: string }> }> {
    return this.api.submitCount(countId);
  }
}
