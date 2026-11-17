/**
 * SyncClient — register side of delta-sync (Build-04, Objective 1).
 *
 * Talks to the API through the injected SyncTransport (a thin typed
 * HTTP client in production; a fake in tests). The client owns the
 * local side only: it upserts the handshake catalogue delta into the
 * local cache, logs handshake checkpoints, and flushes the local cash
 * queue FIFO (created_at ASC) marking each row synced/conflict by the
 * server's per-order outcome.
 *
 * Price discrepancies are non-blocking: the server's outcome warnings
 * are written to sync_audit_log as 'price_discrepancy' entries, and
 * the sale stays synced — the customer already paid the snapshot
 * price in cash.
 *
 * The transport is typed against the API's sync DTOs (imported as
 * types only — erased at runtime, so there is no runtime dependency
 * from the register app on the API).
 */
import { randomUUID } from 'node:crypto';
import type {
  FlushOrder,
  FlushRequest,
  FlushResponse,
  HandshakeRequest,
  HandshakeResponse,
} from '../../../api/src/modules/sync/sync.dto';
import type { AgeVerificationWire } from '../../../api/src/modules/sales/sales.service';
import type { CatalogCacheEntry, QueuedOrder, StorageAdapter } from '../storage/storage-adapter';

export interface SyncTransport {
  handshake(request: HandshakeRequest): Promise<HandshakeResponse>;
  flush(request: FlushRequest): Promise<FlushResponse>;
}

export interface SyncClientOptions {
  now?: () => Date;
}

export class SyncClient {
  private readonly now: () => Date;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly transport: SyncTransport,
    private readonly tenantId: string,
    private readonly locationId: string,
    private readonly registerId: string,
    options: SyncClientOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Handshake: fetch the catalogue delta and replace/merge it into the
   * local cache. `since` is the last successful handshake time; omit
   * for a full snapshot. Returns the raw handshake response.
   */
  async handshake(since?: string | null): Promise<HandshakeResponse> {
    const response = await this.transport.handshake({
      registerId: this.registerId,
      since: since ?? null,
    });
    const entries: CatalogCacheEntry[] = response.catalogue.variants.map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      barcode: variant.barcode,
      name: variant.name,
      pricePence: BigInt(variant.pricePence),
      priceBookPricePence:
        variant.priceBookPricePence === null ? null : BigInt(variant.priceBookPricePence),
      taxRateKind: variant.taxRateKind,
      taxRatePercent: variant.taxRatePercent,
      // The server's stock hint is a display hint only — never
      // authoritative for online sales (see storage-adapter.ts).
      stockOnHand: variant.stockOnHand === null ? null : BigInt(variant.stockOnHand),
      stockComputedAt: variant.stockComputedAt,
      // Build-08, Objective 2: the age flag now rides the delta, so
      // the cached value is always the server's current value — a
      // variant whose restriction was lifted stops gating on the
      // next sync, and a newly restricted variant starts gating.
      // The server guarantees both fields are always present.
      requiresChallenge25: variant.requiresChallenge25,
      minAge: variant.minAge,
      updatedAt: variant.updatedAt,
    }));
    await this.storage.upsertCatalog(entries);
    await this.storage.logSyncAudit('handshake', {
      serverTime: response.serverTime,
      registerId: response.registerId,
      fullSnapshot: response.catalogue.fullSnapshot,
      variantCount: entries.length,
      barcodeMode: response.catalogue.barcodeMode,
    });
    return response;
  }

  /**
   * Flush the local cash queue FIFO. Returns the queued rows with
   * their server outcome attached. A transport failure leaves every
   * row 'queued' (nothing is marked synced on an ambiguous failure);
   * per-order server outcomes mark rows 'synced' or 'conflict'.
   */
  async flushQueue(): Promise<Array<{ order: QueuedOrder; outcome: FlushResponse['outcomes'][number] }>> {
    const queued = await this.storage.listQueuedOrders();
    if (queued.length === 0) {
      return [];
    }
    const orders: FlushOrder[] = queued.map((row) => {
      const payload = JSON.parse(row.orderPayloadJson) as FlushOrder;
      return {
        ...payload,
        idempotencyKey: row.idempotencyKey,
        locationId: row.locationId,
        registerId: row.registerId,
      };
    });
    const response = await this.transport.flush({ registerId: this.registerId, orders });
    const byKey = new Map(response.outcomes.map((outcome) => [outcome.idempotencyKey, outcome]));
    const results: Array<{ order: QueuedOrder; outcome: FlushResponse['outcomes'][number] }> = [];
    for (const row of queued) {
      const outcome = byKey.get(row.idempotencyKey);
      if (outcome === undefined) {
        // The server answered but said nothing about this order: leave
        // it queued so the next flush retries it — never mark synced
        // on silence.
        continue;
      }
      if (outcome.status === 'synced' || outcome.status === 'replayed') {
        await this.storage.updateQueueStatus(row.localId, 'synced');
      } else if (outcome.status === 'conflict') {
        await this.storage.updateQueueStatus(row.localId, 'conflict');
        await this.storage.logSyncAudit('conflict', {
          idempotencyKey: row.idempotencyKey,
          orderId: outcome.orderId,
          conflict: outcome.conflict,
          warnings: outcome.warnings,
        });
      } else {
        // 'failed': leave queued for the next flush attempt.
      }
      for (const warning of outcome.warnings) {
        await this.storage.logSyncAudit('price_discrepancy', {
          idempotencyKey: row.idempotencyKey,
          orderId: outcome.orderId,
          warning,
        });
      }
      await this.storage.logSyncAudit('flush', {
        idempotencyKey: row.idempotencyKey,
        orderId: outcome.orderId,
        status: outcome.status,
        receiptNumber: outcome.receiptNumber,
        flushedAt: this.now().toISOString(),
      });
      results.push({ order: row, outcome });
    }
    return results;
  }

  /** Build a FlushOrder payload for one offline cash sale (client side). */
  static buildOfflineOrder(input: {
    tenantId: string;
    locationId: string;
    registerId: string;
    customerId?: string | null;
    lines: Array<{
      variantId: string;
      quantity: bigint;
      snapshotUnitPricePence: bigint;
      snapshotLineTotalPence: bigint;
      manualDiscountPence?: bigint;
      offlineApprovalRef?: string | null;
    }>;
    tenderTotalPence: bigint;
    createdAt: Date;
    /**
     * Approved Challenge 25 verifications for this sale (Build-09,
     * Objective 2) — wire shape, carried verbatim into the flush
     * payload's `age_verifications` so the server can enforce and
     * persist them. Absent/empty when no restricted line was verified.
     */
    ageVerifications?: AgeVerificationWire[];
  }): FlushOrder {
    return {
      idempotencyKey: randomUUID(),
      locationId: input.locationId,
      registerId: input.registerId,
      customerId: input.customerId ?? null,
      tenderTotalPence: input.tenderTotalPence.toString(),
      createdAt: input.createdAt.toISOString(),
      lines: input.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity.toString(),
        snapshotUnitPricePence: line.snapshotUnitPricePence.toString(),
        snapshotLineTotalPence: line.snapshotLineTotalPence.toString(),
        manualDiscountPence:
          line.manualDiscountPence === undefined ? undefined : line.manualDiscountPence.toString(),
        offlineApprovalRef: line.offlineApprovalRef ?? null,
      })),
      ...(input.ageVerifications !== undefined
        ? { age_verifications: input.ageVerifications }
        : {}),
    };
  }
}
