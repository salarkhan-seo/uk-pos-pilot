/**
 * Register Tablet UI tests (Build-05, Objective 4).
 *
 * All assertions are on the ACTUAL rendered HTML the renderer
 * produces (string/DOM assertions on renderRegisterPage output),
 * driven by the real view-models where the state comes from a
 * controller — not on view-model state alone.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryStorageAdapter } from '../src/storage/memory-storage';
import { SellController } from '../src/sell/sell-controller';
import { SplitTenderController } from '../src/sell/split-tender';
import type { CatalogCacheEntry } from '../src/storage/storage-adapter';
import { UNKNOWN_PAYMENT_MESSAGE } from '../src/constants';
import { OFFLINE_BANNERS } from '../src/offline/offline-guards';
import { emptyRegisterUiState, snapshotRegisterUiState } from '../src/ui/state';
import {
  renderRegisterPage,
  renderW12Modal,
  renderChallenge25Modal,
  renderHardwarePanel,
} from '../src/ui/renderer';
import { createRegisterUiServer } from '../src/ui/server';
import { priceSellLine } from '../src/sell/line-pricing';

const NOW = new Date('2026-11-13T12:00:00.000Z');

function entry(overrides: Partial<CatalogCacheEntry> = {}): CatalogCacheEntry {
  return {
    variantId: 'v-1',
    sku: 'WIDGET-1',
    barcode: '5012345678900',
    name: 'Demo Widget',
    pricePence: 1200n,
    priceBookPricePence: 1000n,
    taxRateKind: 'standard',
    taxRatePercent: '20.00',
    stockOnHand: 25n,
    stockComputedAt: '2026-11-13T11:59:00.000Z',
    requiresChallenge25: false,
    minAge: null,
    updatedAt: '2026-11-13T11:00:00.000Z',
    ...overrides,
  };
}

function mixedLines() {
  return [
    priceSellLine({
      variantId: 'v-1', sku: 'WIDGET-1', name: 'Demo Widget', quantity: 1n,
      basePricePence: 1200n, priceBookPricePence: 1000n, promotionDiscountPence: 100n,
      manualDiscountPence: 50n, taxRateKind: 'standard', requiresChallenge25: false, minAge: null,
    }),
    priceSellLine({
      variantId: 'v-2', sku: 'GADGET-1', name: 'Demo Gadget', quantity: 1n,
      basePricePence: 1050n, priceBookPricePence: null, promotionDiscountPence: 0n,
      manualDiscountPence: 0n, taxRateKind: 'reduced', requiresChallenge25: false, minAge: null,
    }),
  ];
}

function extractPre(html: string, id: string): string {
  const match = html.match(new RegExp(`<pre id="${id}"[^>]*>([\\s\\S]*?)</pre>`));
  expect(match, `expected <pre id="${id}"> in rendered HTML`).not.toBeNull();
  return match![1] ?? '';
}

describe('Register UI — W-12 blocking modal', () => {
  it('renders the verbatim W-12 message with the 3 resolution actions', async () => {
    const split = new SplitTenderController(2250n);
    split.addTender({ kind: 'card', amountPence: 1000n });
    const message = split.markCardAttemptUnknown('pa-123');
    expect(message).toBe(UNKNOWN_PAYMENT_MESSAGE);
    expect(UNKNOWN_PAYMENT_MESSAGE).toBe(
      'Payment outcome unknown — do not hand over goods on card until checked',
    );

    const storage = new InMemoryStorageAdapter();
    const sell = new SellController(storage, {
      tenantId: 't1', locationId: 'l1', registerId: 'r1', roles: ['cashier'],
      barcodeMode: 'price_embedded', isOnline: () => true, offlineSinceMs: () => null, now: () => NOW,
    });
    const state = await snapshotRegisterUiState({ sell, storage, splitTender: split, online: true });
    const html = renderRegisterPage(state);

    expect(html).toContain('id="w12-modal"');
    expect(html).toContain(UNKNOWN_PAYMENT_MESSAGE);
    expect(renderW12Modal(state)).toContain(UNKNOWN_PAYMENT_MESSAGE);
    expect(html).toContain('Poll Provider Status');
    expect(html).toContain('Reconcile Terminal');
    expect(html).toContain('Manager Approval to Void/Retry or Record Standalone Reference');
    expect(html).toContain('Do not hand over goods on card until checked');
  });

  it('does not render the W-12 modal when no unknown payment locks the register', () => {
    const state = emptyRegisterUiState();
    expect(renderW12Modal(state)).toBe('');
    expect(renderRegisterPage(state)).not.toContain('id="w12-modal"');
  });
});

describe('Register UI — offline banner and disabled online-only actions', () => {
  it('shows the offline banner and disables card/loyalty buttons when offline', () => {
    const state = emptyRegisterUiState({
      online: false,
      offlineSinceMs: NOW.getTime() - 60 * 60 * 1000,
      queuedCount: 2,
      lines: mixedLines(),
    });
    const html = renderRegisterPage(state);

    expect(html).toContain('id="connectivity-banner"');
    expect(html).toContain('Offline — cash only');
    expect(html).toContain(OFFLINE_BANNERS.card_payment);
    expect(html).toContain(OFFLINE_BANNERS.loyalty_redeem);
    expect(html).toContain(OFFLINE_BANNERS.voucher_validation);
    expect(html).toContain(OFFLINE_BANNERS.gift_card_redeem);

    // Card and loyalty buttons render disabled while offline.
    const cardButton = html.match(/<button[^>]*data-feature="card_payment"[^>]*>/);
    expect(cardButton, 'card button').not.toBeNull();
    expect(cardButton![0]).toContain('disabled');
    const loyaltyButton = html.match(/<button[^>]*data-feature="loyalty_redeem"[^>]*>/);
    expect(loyaltyButton, 'loyalty button').not.toBeNull();
    expect(loyaltyButton![0]).toContain('disabled');
  });

  it('enables card/loyalty buttons and shows the online banner when online', () => {
    const state = emptyRegisterUiState({ online: true, lines: mixedLines() });
    const html = renderRegisterPage(state);
    expect(html).toContain('id="connectivity-banner"');
    expect(html).toContain('Online — all payment methods available.');
    const cardButton = html.match(/<button[^>]*data-feature="card_payment"[^>]*>/);
    expect(cardButton![0]).not.toContain('disabled');
    expect(html).not.toContain('Offline — cash only');
  });
});

describe('Register UI — Challenge 25 modal', () => {
  it('renders Approve/Refuse and no date-of-birth field', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.upsertCatalog([
      entry({ variantId: 'v-3', sku: 'VAPE-1', name: 'Demo Vape Liquid', requiresChallenge25: true, minAge: 18 }),
    ]);
    const sell = new SellController(storage, {
      tenantId: 't1', locationId: 'l1', registerId: 'r1', roles: ['cashier'],
      barcodeMode: 'price_embedded', isOnline: () => true, offlineSinceMs: () => null, now: () => NOW,
    });
    sell.addLine(entry({ variantId: 'v-3', sku: 'VAPE-1', name: 'Demo Vape Liquid', requiresChallenge25: true, minAge: 18 }), 1n);
    const state = await snapshotRegisterUiState({ sell, storage, online: true });
    expect(state.ageGate.required).toBe(true);

    const html = renderRegisterPage(state);
    expect(html).toContain('id="challenge-25-modal"');
    expect(html).toContain('Challenge 25');
    expect(html).toContain('Approve');
    expect(html).toContain('Refuse');
    expect(renderChallenge25Modal(state)).toContain('data-testid="age-approve"');
    expect(renderChallenge25Modal(state)).toContain('data-testid="age-refuse"');
    // No date-of-birth field anywhere in the rendered page.
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('name="dob"');
    expect(html).not.toContain('date-of-birth');
    expect(html.toLowerCase()).not.toContain('date of birth');
  });

  it('shows the verified state after approval, via the real age gate', async () => {
    const storage = new InMemoryStorageAdapter();
    const sell = new SellController(storage, {
      tenantId: 't1', locationId: 'l1', registerId: 'r1', roles: ['cashier'],
      barcodeMode: 'price_embedded', isOnline: () => true, offlineSinceMs: () => null, now: () => NOW,
    });
    sell.addLine(entry({ requiresChallenge25: true, minAge: 18 }), 1n);
    sell.ageGate.confirm(25);
    const state = await snapshotRegisterUiState({ sell, storage, online: true });
    const html = renderRegisterPage(state);
    expect(html).toContain('Challenge 25 verified (threshold 25)');
    expect(html).not.toContain('data-testid="age-approve"');
  });
});

describe('Register UI — sell screen price breakdown', () => {
  it('shows base -> price-book -> promo -> manual -> final per line, from the real sell controller', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.upsertCatalog([entry()]);
    const sell = new SellController(storage, {
      tenantId: 't1', locationId: 'l1', registerId: 'r1', roles: ['cashier'],
      barcodeMode: 'price_embedded', isOnline: () => true, offlineSinceMs: () => null, now: () => NOW,
    });
    sell.addLine(entry(), 1n);
    sell.applyManualDiscount({ lineIndex: 0, manualDiscountPence: 0n });
    const state = await snapshotRegisterUiState({
      sell, storage, online: true,
      quickKeys: [{ sku: 'WIDGET-1', label: 'Demo Widget', pricePence: 1200n }],
    });
    const html = renderRegisterPage(state);
    expect(html).toContain('Demo Widget');
    expect(html).toContain('data-price="base"');
    expect(html).toContain('data-price="price-book"');
    expect(html).toContain('data-price="promo"');
    expect(html).toContain('data-price="manual"');
    expect(html).toContain('data-price="final"');
    expect(html).toContain('£12.00'); // base
    expect(html).toContain('£10.00'); // price-book / final unit
    expect(html).toContain('id="barcode"');
    expect(html).toContain('data-quick-key="WIDGET-1"');
    expect(html).toContain('Parked baskets (0)');
  });
});

describe('Register UI — receipt vs customer display', () => {
  it('receipt shows the per-rate VAT table and the VAT notice; the customer display shows a single tax total only', () => {
    const state = emptyRegisterUiState({ lines: mixedLines() });
    const html = renderHardwarePanel(state);

    const receipt = extractPre(html, 'receipt-preview');
    expect(receipt).toContain('VAT breakdown:');
    expect(receipt).toContain('Rate      Net      VAT      Gross');
    expect(receipt).toContain('standard 20.00%');
    expect(receipt).toContain('reduced 5.00%');
    expect(receipt).toContain('This is not a VAT invoice');
    expect(receipt).toContain('TOTAL');

    const display = extractPre(html, 'customer-display-preview');
    expect(display).toContain('Tax  £');
    expect(display).toContain('TOTAL');
    expect(display).not.toContain('VAT breakdown');
    expect(display).not.toContain('standard');
    expect(display).not.toContain('reduced');
    expect(display).not.toContain('20.00%');
    expect(display).not.toContain('This is not a VAT invoice');
    // Exactly one tax line on the customer display.
    expect(display.split('\n').filter((line) => line.startsWith('Tax  '))).toHaveLength(1);
  });

  it('split tender modal shows the 5-minute countdown', () => {
    const split = new SplitTenderController(2250n);
    split.addTender({ kind: 'cash', amountPence: 1000n });
    const state = emptyRegisterUiState({
      lines: mixedLines(),
      splitTender: {
        totalPence: 2250n, tenderedPence: 1000n, remainingPence: 1250n,
        tenders: [{ kind: 'cash', amountPence: 1000n }],
        firstTenderAtMs: NOW.getTime(), nowMs: NOW.getTime() + 60 * 1000,
        locked: false, blockingMessage: null, timedOut: false, complete: false,
      },
    });
    expect(split.tenderedTotal).toBe(1000n);
    const html = renderRegisterPage(state);
    expect(html).toContain('id="split-tender-modal"');
    expect(html).toContain('id="split-tender-countdown"');
    expect(html).toContain('4:00');
    expect(html).toContain('Remaining');
  });

  it('till session view and manager PIN pad render', () => {
    const state = emptyRegisterUiState({
      till: { state: 'open', sessionId: 'sess-1', expectedCashPence: null, zReport: null, zeroFloatWarning: null },
    });
    const html = renderRegisterPage(state);
    expect(html).toContain('id="till-session"');
    expect(html).toContain('Till Session — open');
    expect(html).toContain('id="manager-pin-modal"');
    expect(html).toContain('Manager PIN Approval');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-pin-key="1"');
  });
});

describe('Register UI — HTTP server', () => {
  it('boots, serves the sell screen at / and reports health at /health', async () => {
    const shell = createRegisterUiServer(0);
    await new Promise<void>((resolve) => shell.server.listen(0, resolve));
    try {
      const address = shell.server.address();
      if (typeof address !== 'object' || address === null) throw new Error('server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="sell-screen"');
      expect(html).toContain('id="receipt-preview"');
      expect(html).toContain('id="customer-display-preview"');
      expect(html).toContain('Demo data');

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok', ui: 'register' });
    } finally {
      await new Promise<void>((resolve) => shell.server.close(() => resolve()));
    }
  });
});
