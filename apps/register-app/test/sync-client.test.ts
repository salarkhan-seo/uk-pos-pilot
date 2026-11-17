/**
 * SyncClient tests (Build-04, Objective 1).
 *
 * The transport is a fake: handshake returns a canned catalogue delta,
 * flush returns canned per-order outcomes. The server side of the same
 * contract is proven by apps/api/test/sync/sync.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import { SyncClient, type SyncTransport } from '../src/sync/sync-client';
import type { FlushResponse, HandshakeResponse } from '../../api/src/modules/sync/sync.dto';

function handshakeResponse(): HandshakeResponse {
  return {
    serverTime: '2026-11-13T12:00:00.000Z',
    tenantId: 't1',
    tenantStatus: 'active',
    registerId: 'r1',
    registerName: 'TILL-01',
    registerStatus: 'active',
    locationId: 'l1',
    catalogue: {
      variants: [
        {
          variantId: 'v-1',
          sku: 'SKU-001',
          barcode: '5012345678900',
          name: 'Widget',
          pricePence: '1000',
          taxRateId: 'tax-std',
          taxRateKind: 'standard',
          taxRatePercent: '20.00',
          priceBookPricePence: '900',
          stockOnHand: '7',
          stockComputedAt: '2026-11-13T11:59:00.000Z',
          requiresChallenge25: true,
          minAge: 18,
          updatedAt: '2026-11-13T11:00:00.000Z',
        },
        {
          variantId: 'v-2',
          sku: 'SKU-002',
          barcode: null,
          name: 'Bread',
          pricePence: '200',
          taxRateId: 'tax-std',
          taxRateKind: 'standard',
          taxRatePercent: '20.00',
          priceBookPricePence: null,
          stockOnHand: null,
          stockComputedAt: null,
          requiresChallenge25: false,
          minAge: null,
          updatedAt: '2026-11-13T11:00:00.000Z',
        },
      ],
      taxRates: [{ id: 'tax-std', kind: 'standard', ratePercent: '20.00', isActive: true }],
      priceBookEntries: [],
      barcodeMode: 'price_embedded',
      fullSnapshot: true,
    },
  };
}

describe('SyncClient.handshake', () => {
  it('upserts the catalogue delta into the local cache and logs a checkpoint', async () => {
    const storage = new InMemoryStorageAdapter();
    const transport: SyncTransport = {
      handshake: async () => handshakeResponse(),
      flush: async () => ({ serverTime: '', outcomes: [] }),
    };
    const client = new SyncClient(storage, transport, 't1', 'l1', 'r1');

    const res = await client.handshake();
    expect(res.catalogue.variants).toHaveLength(2);

    const cached = await storage.findCatalogBySku('SKU-001');
    expect(cached?.pricePence).toBe(1000n);
    expect(cached?.priceBookPricePence).toBe(900n);
    // Cached stock is a display hint, stored with its computed_at.
    expect(cached?.stockOnHand).toBe(7n);
    expect(cached?.stockComputedAt).toBe('2026-11-13T11:59:00.000Z');
    // Build-08, Objective 2: the age flag + min age ride the delta
    // and land in the cache verbatim — restricted and plain alike.
    expect(cached?.requiresChallenge25).toBe(true);
    expect(cached?.minAge).toBe(18);
    const plain = await storage.findCatalogBySku('SKU-002');
    expect(plain?.requiresChallenge25).toBe(false);
    expect(plain?.minAge).toBeNull();

    const audit = await storage.listSyncAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.kind).toBe('handshake');
    expect(JSON.parse(audit[0]?.detailJson as string)).toMatchObject({ variantCount: 2 });
  });

  it('a later delta clears a restriction the server removed (the flag is authoritative, not sticky)', async () => {
    const storage = new InMemoryStorageAdapter();
    // Seed the cache as if an earlier sync had stored a restriction.
    await storage.upsertCatalog([
      {
        variantId: 'v-1', sku: 'SKU-001', barcode: '5012345678900', name: 'Widget',
        pricePence: 1000n, priceBookPricePence: null, taxRateKind: 'standard',
        taxRatePercent: '20.00', stockOnHand: 7n, stockComputedAt: null,
        requiresChallenge25: true, minAge: 18, updatedAt: '2026-11-13T11:00:00.000Z',
      },
    ]);
    const lifted = handshakeResponse();
    const variant = lifted.catalogue.variants[0];
    if (variant !== undefined) {
      variant.requiresChallenge25 = false;
      variant.minAge = null;
    }
    const transport: SyncTransport = {
      handshake: async () => lifted,
      flush: async () => ({ serverTime: '', outcomes: [] }),
    };
    const client = new SyncClient(storage, transport, 't1', 'l1', 'r1');

    await client.handshake();

    const cached = await storage.findCatalogBySku('SKU-001');
    expect(cached?.requiresChallenge25).toBe(false);
    expect(cached?.minAge).toBeNull();
  });
});

describe('SyncClient.buildOfflineOrder — age verifications (Build-09 Objective 2)', () => {
  it('carries age_verifications into the flush payload when provided, omits the key when not', () => {
    const verification = {
      variant_id: 'v-c25',
      verified_age_threshold: 25,
      verified_by_user_id: 'user-1',
      verified_at: '2026-11-14T10:00:00.000Z',
    };
    const withVerification = SyncClient.buildOfflineOrder({
      tenantId: 't1',
      locationId: 'l1',
      registerId: 'r1',
      lines: [
        {
          variantId: 'v-c25',
          quantity: 1n,
          snapshotUnitPricePence: 800n,
          snapshotLineTotalPence: 800n,
        },
      ],
      tenderTotalPence: 800n,
      createdAt: new Date('2026-11-14T10:00:00.000Z'),
      ageVerifications: [verification],
    });
    expect(withVerification.age_verifications).toEqual([verification]);
    expect(JSON.stringify(withVerification).toLowerCase()).not.toContain('dob');

    const plain = SyncClient.buildOfflineOrder({
      tenantId: 't1',
      locationId: 'l1',
      registerId: 'r1',
      lines: [
        {
          variantId: 'v-ok',
          quantity: 1n,
          snapshotUnitPricePence: 500n,
          snapshotLineTotalPence: 500n,
        },
      ],
      tenderTotalPence: 500n,
      createdAt: new Date('2026-11-14T10:00:00.000Z'),
    });
    expect(plain.age_verifications).toBeUndefined();
    expect('age_verifications' in plain).toBe(false);
  });
});

describe('SyncClient.flushQueue', () => {
  function enqueue(storage: InMemoryStorageAdapter, key: string, createdAt: string): Promise<void> {
    return storage
      .enqueueOrder({
        idempotencyKey: key,
        tenantId: 't1',
        locationId: 'l1',
        registerId: 'r1',
        orderPayloadJson: JSON.stringify({
          idempotencyKey: key,
          locationId: 'l1',
          registerId: 'r1',
          tenderTotalPence: '1000',
          createdAt,
          lines: [],
        }),
        tenderTotalPence: 1000n,
        createdAt,
      })
      .then(() => undefined);
  }

  it('flushes FIFO, marks synced/conflict per outcome, and logs price discrepancies', async () => {
    const storage = new InMemoryStorageAdapter();
    await enqueue(storage, 'q-1', '2026-11-13T10:00:00.000Z');
    await enqueue(storage, 'q-2', '2026-11-13T10:01:00.000Z');
    await enqueue(storage, 'q-3', '2026-11-13T10:02:00.000Z');

    const seenOrder: string[] = [];
    const transport: SyncTransport = {
      handshake: async () => handshakeResponse(),
      flush: async (req) => {
        seenOrder.push(...req.orders.map((o) => o.idempotencyKey));
        const outcomes: FlushResponse['outcomes'] = [
          {
            idempotencyKey: 'q-1',
            status: 'synced',
            orderId: 'o-1',
            receiptNumber: '1',
            orderTotalPence: '1000',
            warnings: ['Price changed while offline: snapshot price honored via 100p basket discount.'],
            conflict: null,
            error: null,
            error_code: null,
          },
          {
            idempotencyKey: 'q-2',
            status: 'conflict',
            orderId: 'o-2',
            receiptNumber: '2',
            orderTotalPence: '3000',
            warnings: ['Stock shortfall on offline cash sale'],
            conflict: [{ variantId: 'v-1', requested: '3', available: '1', shortfall: '2' }],
            error: null,
            error_code: null,
          },
          {
            idempotencyKey: 'q-3',
            status: 'failed',
            orderId: null,
            receiptNumber: null,
            orderTotalPence: null,
            warnings: [],
            conflict: null,
            error: 'Replay failed: Resource not found',
            error_code: 'NOT_FOUND',
          },
        ];
        return { serverTime: '2026-11-13T12:00:00.000Z', outcomes };
      },
    };
    const client = new SyncClient(storage, transport, 't1', 'l1', 'r1');

    const results = await client.flushQueue();
    // FIFO: the transport saw the keys in queue order.
    expect(seenOrder).toEqual(['q-1', 'q-2', 'q-3']);
    expect(results.map((r) => r.outcome.status)).toEqual(['synced', 'conflict', 'failed']);

    const queue = await storage.listAllQueue();
    expect(queue.map((row) => row.syncStatus)).toEqual(['synced', 'conflict', 'queued']);

    const audit = await storage.listSyncAudit();
    expect(audit.some((e) => e.kind === 'conflict')).toBe(true);
    expect(audit.filter((e) => e.kind === 'price_discrepancy')).toHaveLength(2);
    expect(audit.filter((e) => e.kind === 'flush')).toHaveLength(3);
  });

  it('leaves every row queued when the transport fails outright', async () => {
    const storage = new InMemoryStorageAdapter();
    await enqueue(storage, 'q-1', '2026-11-13T10:00:00.000Z');
    const transport: SyncTransport = {
      handshake: async () => handshakeResponse(),
      flush: async () => {
        throw new Error('network down');
      },
    };
    const client = new SyncClient(storage, transport, 't1', 'l1', 'r1');

    await expect(client.flushQueue()).rejects.toThrow('network down');
    expect((await storage.listQueuedOrders()).map((row) => row.syncStatus)).toEqual(['queued']);
  });

  it('does nothing when the queue is empty', async () => {
    const storage = new InMemoryStorageAdapter();
    let calls = 0;
    const transport: SyncTransport = {
      handshake: async () => handshakeResponse(),
      flush: async () => {
        calls += 1;
        return { serverTime: '', outcomes: [] };
      },
    };
    const client = new SyncClient(storage, transport, 't1', 'l1', 'r1');
    expect(await client.flushQueue()).toEqual([]);
    expect(calls).toBe(0);
  });
});
