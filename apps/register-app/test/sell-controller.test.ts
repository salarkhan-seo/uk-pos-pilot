/**
 * Sell controller tests (Build-04, Objective 1).
 *
 * The EAN-13 price-embedded barcode used here is hand-verified:
 * "2012345001008" — prefix 20, SKU 12345, embedded value 00100 (100p),
 * check digit 8 (odd positions x1 + even positions x3 = 32, (10-2)%10=8).
 */
import { describe, expect, it } from 'vitest';
import { hashPin } from '@uk-pos/shared-kernel';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import type { CatalogCacheEntry } from '../src/storage/storage-adapter';
import { SellController } from '../src/sell/sell-controller';
import type { SellLineView } from '../src/sell/line-pricing';

const NOW = new Date('2026-11-13T12:00:00.000Z');

function entry(overrides: Partial<CatalogCacheEntry> = {}): CatalogCacheEntry {
  return {
    variantId: 'v-1',
    sku: '12345',
    barcode: '5012345678900',
    name: 'Widget',
    pricePence: 1000n,
    priceBookPricePence: 900n,
    taxRateKind: 'standard',
    taxRatePercent: '20.00',
    stockOnHand: 7n,
    stockComputedAt: '2026-11-13T11:59:00.000Z',
    requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-13T11:00:00.000Z',
    ...overrides,
  };
}

function makeController(options: { online: boolean; roles?: Array<'cashier' | 'manager' | 'admin' | 'owner'> } = { online: false }) {
  const storage = new InMemoryStorageAdapter();
  const controller = new SellController(storage, {
    tenantId: 't1',
    locationId: 'l1',
    registerId: 'r1',
    roles: options.roles ?? ['cashier'],
    barcodeMode: 'price_embedded',
    isOnline: () => options.online,
    offlineSinceMs: () => NOW.getTime() - 60 * 60 * 1000,
    now: () => NOW,
  });
  return { storage, controller };
}

describe('SellController — catalogue lookup', () => {
  it('searches by SKU and name (case-insensitive)', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry(), entry({ variantId: 'v-2', sku: 'SKU-9', barcode: null, name: 'Gadget Pro' })]);
    expect((await controller.search('wid')).map((e) => e.sku)).toEqual(['12345']);
    expect((await controller.search('GADGET')).map((e) => e.sku)).toEqual(['SKU-9']);
    expect(await controller.search('')).toEqual([]);
  });

  it('scans a standard barcode and a price-embedded barcode via the shared parser', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    const standard = await controller.scanBarcode('5012345678900');
    expect(standard.entry.sku).toBe('12345');
    expect(standard.embeddedPricePence).toBeNull();

    const embedded = await controller.scanBarcode('2012345001008');
    expect(embedded.entry.sku).toBe('12345');
    expect(embedded.embeddedPricePence).toBe(100n);
  });

  it('rejects a barcode with a bad check digit (shared parser)', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    await expect(controller.scanBarcode('2012345001009')).rejects.toThrow('check digit mismatch');
  });

  it('resolves the quick-key grid', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    const keys = await controller.quickKeys([
      { sku: '12345', label: 'Widget' },
      { sku: 'MISSING', label: 'Missing' },
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.key.label).toBe('Widget');
  });
});

describe('SellController — lines and pricing', () => {
  it('exposes base, price-book, promotion, manual and final price per line', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    const line = controller.addLine(entry(), 2n);
    expect(line.basePricePence).toBe(1000n);
    expect(line.priceBookPricePence).toBe(900n);
    expect(line.unitPricePence).toBe(900n);
    expect(line.promotionDiscountPence).toBe(0n);
    expect(line.manualDiscountPence).toBe(0n);
    expect(line.finalPricePence).toBe(900n);
    expect(line.lineTotalPence).toBe(1800n);
    expect(controller.basketTotalPence).toBe(1800n);
  });

  it('uses the embedded price from a price-embedded barcode as the line price', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    const scanned = await controller.scanBarcode('2012345001008');
    const line = controller.addLine(scanned.entry, 1n, scanned.embeddedPricePence);
    expect(line.unitPricePence).toBe(100n);
    expect(line.lineTotalPence).toBe(100n);
  });

  it('applies a within-limit manual discount, and blocks an above-limit one without a manager PIN', async () => {
    const { storage, controller } = makeController({ online: false, roles: ['manager'] });
    await storage.upsertCatalog([entry()]);
    controller.addLine(entry(), 1n); // price-book 900p; manager limit 10% = 90p
    const discounted = controller.applyManualDiscount({ lineIndex: 0, manualDiscountPence: 90n });
    expect(discounted.manualDiscountPence).toBe(90n);
    expect(discounted.lineTotalPence).toBe(810n);

    expect(() =>
      controller.applyManualDiscount({ lineIndex: 0, manualDiscountPence: 200n }),
    ).toThrow('manager PIN approval required');

    // With a valid manager PIN the above-limit discount is allowed, and only a reference is kept.
    const pinHash = hashPin('1234');
    const approved = controller.applyManualDiscount({
      lineIndex: 0,
      manualDiscountPence: 200n,
      approverPin: '1234',
      approverPinHash: pinHash,
      approverRoles: ['manager'],
    });
    expect(approved.manualDiscountPence).toBe(200n);
    expect(approved.lineTotalPence).toBe(700n);
    // The PIN itself is never recorded: no field holds it, and the
    // approval reference is opaque (role + timestamp only).
    const approvalRef = (approved as SellLineView & { offlineApprovalRef?: string | null })
      .offlineApprovalRef;
    expect(approvalRef).toMatch(/^offline-pin:manager:\d+$/);
    expect(Object.values(approved).some((value) => value === '1234')).toBe(false);
  });
});

describe('SellController — parked baskets hold zero stock reservation', () => {
  it('parks a basket locally and resumes it with identical lines', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    controller.addLine(entry(), 2n);
    const parkedId = await controller.parkBasket();
    expect(controller.listLines()).toHaveLength(0);
    expect((await storage.listParkedBaskets())).toHaveLength(1);

    await controller.resumeParkedBasket(parkedId);
    expect(controller.listLines()).toHaveLength(1);
    expect(controller.basketTotalPence).toBe(1800n);
    expect((await storage.listParkedBaskets())).toHaveLength(0);
  });
});

describe('SellController — online-only customer attach', () => {
  it('blocks customer attachment while offline', async () => {
    const { controller } = makeController({ online: false });
    expect(() => controller.attachCustomer('cust-1')).toThrow('Customer lookup is unavailable offline');
  });

  it('attaches a customer while online', async () => {
    const { controller } = makeController({ online: true });
    controller.attachCustomer('cust-1');
    expect(controller.attachedCustomerId).toBe('cust-1');
  });
});

describe('SellController — offline cash checkout', () => {
  it('enqueues an offline cash sale and clears the basket', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry()]);
    controller.addLine(entry(), 1n);
    const { idempotencyKey, totalPence } = await controller.checkoutOfflineCash();
    expect(totalPence).toBe(900n);
    expect(idempotencyKey.length).toBeGreaterThan(0);
    const queued = await storage.listQueuedOrders();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.tenderTotalPence).toBe(900n);
    const payload = JSON.parse(queued[0]?.orderPayloadJson as string) as { lines: Array<{ snapshotLineTotalPence: string }> };
    expect(payload.lines[0]?.snapshotLineTotalPence).toBe('900');
    expect(controller.listLines()).toHaveLength(0);
  });

  it('blocks checkout when the £250 single-sale bound is breached', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry({ pricePence: 30000n, priceBookPricePence: null })]);
    controller.addLine(entry({ pricePence: 30000n, priceBookPricePence: null }), 1n);
    await expect(controller.checkoutOfflineCash()).rejects.toThrow('£250');
  });

  it('blocks checkout when the age gate is unsatisfied', async () => {
    const { storage, controller } = makeController();
    await storage.upsertCatalog([entry({ requiresChallenge25: true, minAge: 18 })]);
    controller.addLine(entry({ requiresChallenge25: true, minAge: 18 }), 1n);
    await expect(controller.checkoutOfflineCash()).rejects.toThrow('Age verification required');
    controller.ageGate.confirm(25);
    const result = await controller.checkoutOfflineCash();
    expect(result.totalPence).toBe(900n);
  });

  it('attaches approved Challenge 25 verifications to the queued order payload (Build-09 Obj 2)', async () => {
    const { storage, controller } = makeController();
    const restricted = entry({ requiresChallenge25: true, minAge: 18 });
    await storage.upsertCatalog([restricted]);
    controller.addLine(restricted, 1n);
    controller.ageGate.confirm(25);
    const verification = {
      variant_id: restricted.variantId,
      verified_age_threshold: 25,
      verified_by_user_id: 'user-cashier-1',
      verified_at: '2026-11-14T10:00:00.000Z',
    };
    const result = await controller.checkoutOfflineCash([verification]);
    expect(result.totalPence).toBe(900n);
    const queued = await storage.listQueuedOrders();
    expect(queued).toHaveLength(1);
    const payload = JSON.parse(queued[0]?.orderPayloadJson as string) as {
      age_verifications?: Array<Record<string, unknown>>;
    };
    expect(payload.age_verifications).toEqual([verification]);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('dob');
  });
});
