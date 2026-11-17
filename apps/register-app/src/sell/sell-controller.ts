/**
 * Sell Screen Controller (Build-04, Objective 1; Arch-04 §2).
 *
 * Framework-free view-model: barcode scan, fast SKU/name search,
 * quick-key grid, customer lookup/attachment (online only), parked /
 * saved baskets, and offline cash checkout into the local queue.
 *
 * - Barcode scan uses the SHARED parser from
 *   apps/api/src/modules/catalogue/barcode.ts (imported, never copied):
 *   standard EAN/UPC barcodes resolve by the printed barcode, and
 *   in-store variable-measure codes resolve by their embedded SKU
 *   (price/weight embedded per the tenant's single active mode).
 * - Parked baskets are draft orders holding ZERO stock reservation:
 *   parking writes only a local basket row — no stock call is made,
 *   online or offline. Stock is reserved only at the first tender
 *   (server-side, G-A-13).
 * - Offline lines carry promotionDiscount 0: automatic promotions are
 *   evaluated server-side at flush/createOrder time. The snapshot
 *   total is what the customer paid in cash; if the server's
 *   repricing (with promotions) differs, the flush records a
 *   non-blocking discrepancy warning (see sync-client.ts).
 * - Customer lookup/attachment is ONLINE ONLY: it throws
 *   OfflineBlockedError-style banner text while offline (the customer
 *   record lives server-side; the register must not invent one).
 */
import { parseBarcode, type BarcodeMode } from '../../../api/src/modules/catalogue/barcode';
import type { AgeVerificationWire } from '../../../api/src/modules/sales/sales.service';
import type { CatalogCacheEntry, StorageAdapter } from '../storage/storage-adapter';
import { offlineSaleBlockReason, OfflineBlockedError } from '../offline/offline-guards';
import { SyncClient } from '../sync/sync-client';
import { AgeVerificationGate } from './age-gate';
import { checkManualDiscount, priceSellLine, type SellLineView } from './line-pricing';
import type { RoleName } from '../../../api/src/common/roles';

export interface SellControllerOptions {
  tenantId: string;
  locationId: string;
  registerId: string;
  /** Cashier roles (for manual-discount limits). */
  roles: RoleName[];
  /** Barcode mode for the tenant (from the handshake delta). */
  barcodeMode: BarcodeMode | null;
  isOnline: () => boolean;
  /** When the register last had connectivity (epoch ms), for the 24h bound. */
  offlineSinceMs: () => number | null;
  now: () => Date;
}

export interface QuickKey {
  sku: string;
  label: string;
}

export class SellController {
  private lines: SellLineView[] = [];
  private customerId: string | null = null;
  readonly ageGate = new AgeVerificationGate();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly options: SellControllerOptions,
  ) {}

  // -- Catalogue lookup -------------------------------------------------

  /** Fast SKU/name search over the local cache (case-insensitive substring). */
  async search(query: string): Promise<CatalogCacheEntry[]> {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      return [];
    }
    const catalog = await this.storage.listCatalog();
    return catalog.filter(
      (entry) =>
        entry.sku.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle),
    );
  }

  /**
   * Scan a barcode. Standard codes resolve by barcode; in-store
   * variable-measure codes are parsed with the shared parser and
   * resolve by embedded SKU. A price-embedded code overrides the
   * line's unit price with the embedded price (weight-embedded codes
   * resolve the SKU; the weighed quantity is keyed by the cashier —
   * the scale integration is a later step, see README).
   */
  async scanBarcode(code: string): Promise<{ entry: CatalogCacheEntry; embeddedPricePence: bigint | null }> {
    const trimmed = code.trim();
    const byBarcode = await this.storage.findCatalogByBarcode(trimmed);
    if (byBarcode !== undefined) {
      return { entry: byBarcode, embeddedPricePence: null };
    }
    if (this.options.barcodeMode === null) {
      throw new Error(`Unknown barcode ${trimmed}: no barcode mode is configured for this tenant`);
    }
    const parsed = parseBarcode(trimmed, this.options.barcodeMode);
    const entry = await this.storage.findCatalogBySku(parsed.sku);
    if (entry === undefined) {
      throw new Error(`No catalog entry for barcode SKU ${parsed.sku}`);
    }
    return {
      entry,
      embeddedPricePence: parsed.pricePence !== undefined ? parsed.pricePence : null,
    };
  }

  /** Quick-key grid: resolve each configured key to its catalog entry. */
  async quickKeys(keys: QuickKey[]): Promise<Array<{ key: QuickKey; entry: CatalogCacheEntry }>> {
    const resolved: Array<{ key: QuickKey; entry: CatalogCacheEntry }> = [];
    for (const key of keys) {
      const entry = await this.storage.findCatalogBySku(key.sku);
      if (entry !== undefined) {
        resolved.push({ key, entry });
      }
    }
    return resolved;
  }

  // -- Basket -----------------------------------------------------------

  addLine(entry: CatalogCacheEntry, quantity: bigint, embeddedPricePence?: bigint | null): SellLineView {
    if (quantity <= 0n) {
      throw new Error('Line quantity must be greater than zero');
    }
    const line = priceSellLine({
      variantId: entry.variantId,
      sku: entry.sku,
      name: entry.name,
      quantity,
      // A price-embedded barcode sets the unit price for this line.
      basePricePence: embeddedPricePence ?? entry.pricePence,
      priceBookPricePence: embeddedPricePence !== undefined && embeddedPricePence !== null ? null : entry.priceBookPricePence,
      promotionDiscountPence: 0n,
      manualDiscountPence: 0n,
      taxRateKind: entry.taxRateKind,
      requiresChallenge25: entry.requiresChallenge25,
      minAge: entry.minAge,
    });
    this.lines.push(line);
    return { ...line };
  }

  listLines(): SellLineView[] {
    return this.lines.map((line) => ({ ...line }));
  }

  get basketTotalPence(): bigint {
    return this.lines.reduce((sum, line) => sum + line.lineTotalPence, 0n);
  }

  clearBasket(): void {
    this.lines = [];
    this.customerId = null;
    this.ageGate.reset();
  }

  /** Apply a role-bounded manual discount to one line (offline PIN approval when above the limit). */
  applyManualDiscount(input: {
    lineIndex: number;
    manualDiscountPence: bigint;
    approverPin?: string;
    approverPinHash?: string;
    approverRoles?: RoleName[];
  }): SellLineView {
    const line = this.lines[input.lineIndex];
    if (line === undefined) {
      throw new Error(`No basket line at index ${input.lineIndex}`);
    }
    const beforeManual = line.unitPricePence * line.quantity - line.promotionDiscountPence;
    const check = checkManualDiscount({
      roles: this.options.roles,
      lineTotalBeforeManualPence: beforeManual,
      manualDiscountPence: input.manualDiscountPence,
      approverPin: input.approverPin,
      approverPinHash: input.approverPinHash,
      approverRoles: input.approverRoles,
    });
    if (!check.allowed) {
      throw new Error(check.reason ?? 'Manual discount not allowed');
    }
    const updated = priceSellLine({ ...line, manualDiscountPence: input.manualDiscountPence });
    // Keep the offline approval reference on the line for the flush payload.
    (updated as SellLineView & { offlineApprovalRef?: string | null }).offlineApprovalRef =
      check.approvalRef;
    this.lines[input.lineIndex] = updated;
    return { ...updated };
  }

  // -- Customer (online only) ------------------------------------------

  attachCustomer(customerId: string): void {
    if (!this.options.isOnline()) {
      throw new OfflineBlockedError('customer_lookup');
    }
    this.customerId = customerId;
  }

  get attachedCustomerId(): string | null {
    return this.customerId;
  }

  // -- Parked baskets: draft orders, zero stock reservation ------------

  async parkBasket(): Promise<string> {
    if (this.lines.length === 0) {
      throw new Error('Cannot park an empty basket');
    }
    // No stock call is made here — parking is a local draft only.
    const parked = await this.storage.parkBasket({
      tenantId: this.options.tenantId,
      locationId: this.options.locationId,
      registerId: this.options.registerId,
      basketJson: JSON.stringify(this.lines, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      createdAt: this.options.now().toISOString(),
    });
    this.clearBasket();
    return parked.localId;
  }

  async resumeParkedBasket(localId: string): Promise<void> {
    const parked = (await this.storage.listParkedBaskets()).find((row) => row.localId === localId);
    if (parked === undefined) {
      throw new Error(`Unknown parked basket: ${localId}`);
    }
    const raw = JSON.parse(parked.basketJson) as Array<Record<string, unknown>>;
    this.lines = raw.map((line) => ({
      variantId: line.variantId as string,
      sku: line.sku as string,
      name: line.name as string,
      quantity: BigInt(line.quantity as string),
      basePricePence: BigInt(line.basePricePence as string),
      priceBookPricePence:
        line.priceBookPricePence === null ? null : BigInt(line.priceBookPricePence as string),
      promotionDiscountPence: BigInt(line.promotionDiscountPence as string),
      manualDiscountPence: BigInt(line.manualDiscountPence as string),
      taxRateKind: line.taxRateKind as string | null,
      requiresChallenge25: line.requiresChallenge25 as boolean,
      // Baskets parked before Build-08 carry no minAge — default null.
      minAge: (line.minAge as number | null | undefined) ?? null,
      unitPricePence: BigInt(line.unitPricePence as string),
      finalPricePence: BigInt(line.finalPricePence as string),
      lineTotalPence: BigInt(line.lineTotalPence as string),
    }));
    await this.storage.deleteParkedBasket(localId);
  }

  // -- Checkout ---------------------------------------------------------

  /**
   * Offline cash checkout: validates the age gate and the offline
   * bounds, then enqueues the sale for FIFO flush. Returns the queue
   * row's idempotency key. Online checkout goes through the API
   * directly and is not queued here.
   */
  async checkoutOfflineCash(
    ageVerifications?: AgeVerificationWire[],
  ): Promise<{ idempotencyKey: string; totalPence: bigint }> {
    if (this.options.isOnline()) {
      throw new Error('Register is online — use the online checkout path, not the offline queue');
    }
    if (this.lines.length === 0) {
      throw new Error('Cannot check out an empty basket');
    }
    if (!this.ageGate.isSatisfied(this.lines)) {
      const blocked = this.ageGate.requiredLines(this.lines);
      throw new Error(
        `Age verification required before checkout: ${blocked.map((line) => line.sku).join(', ')} — confirm Challenge 25 or log a refusal`,
      );
    }
    const total = this.basketTotalPence;
    const queued = await this.storage.listAllQueue();
    const queuedCount = queued.filter(
      (row) => row.syncStatus === 'queued' || row.syncStatus === 'syncing',
    ).length;
    const blockReason = offlineSaleBlockReason({
      queuedCount,
      offlineSinceMs: this.options.offlineSinceMs(),
      tenderTotalPence: total,
      nowMs: this.options.now().getTime(),
    });
    if (blockReason !== null) {
      throw new Error(blockReason);
    }
    const order = SyncClient.buildOfflineOrder({
      tenantId: this.options.tenantId,
      locationId: this.options.locationId,
      registerId: this.options.registerId,
      customerId: this.customerId,
      lines: this.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        snapshotUnitPricePence: line.finalPricePence,
        snapshotLineTotalPence: line.lineTotalPence,
        manualDiscountPence: line.manualDiscountPence,
        offlineApprovalRef:
          (line as SellLineView & { offlineApprovalRef?: string | null }).offlineApprovalRef ?? null,
      })),
      tenderTotalPence: total,
      createdAt: this.options.now(),
      // Build-09, Objective 2: the approved Challenge 25 verification
      // rides the queued order so the flush can prove it server-side.
      // The caller (UI shell) builds these from the age gate; an empty
      // or absent list means the flush will fail the order with 422
      // rather than silently completing an unverified restricted sale.
      ageVerifications,
    });
    const enqueued = await this.storage.enqueueOrder({
      idempotencyKey: order.idempotencyKey,
      tenantId: this.options.tenantId,
      locationId: this.options.locationId,
      registerId: this.options.registerId,
      orderPayloadJson: JSON.stringify(order),
      tenderTotalPence: total,
      createdAt: this.options.now().toISOString(),
    });
    const key = enqueued.idempotencyKey;
    this.clearBasket();
    return { idempotencyKey: key, totalPence: total };
  }
}
