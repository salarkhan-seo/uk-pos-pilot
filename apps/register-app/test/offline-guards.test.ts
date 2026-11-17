/**
 * Offline queue bounds & online-only guard tests (Build-04, Objective 1;
 * Arch-04 §4.2).
 */
import { describe, expect, it } from 'vitest';
import {
  OFFLINE_BANNERS,
  ONLINE_ONLY_FEATURES,
  OfflineBlockedError,
  offlineBannerFor,
  offlineSaleBlockReason,
} from '../src/offline/offline-guards';

const NOW = new Date('2026-11-13T12:00:00.000Z').getTime();

describe('offlineSaleBlockReason', () => {
  it('allows a sale inside all three bounds', () => {
    expect(
      offlineSaleBlockReason({
        queuedCount: 49,
        offlineSinceMs: NOW - 60 * 60 * 1000,
        tenderTotalPence: 25000n,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it('blocks at exactly 50 queued orders, naming the bound', () => {
    const reason = offlineSaleBlockReason({
      queuedCount: 50,
      offlineSinceMs: NOW - 60 * 60 * 1000,
      tenderTotalPence: 1000n,
      nowMs: NOW,
    });
    expect(reason).toContain('50 offline orders');
    expect(reason).toContain('syncs');
  });

  it('blocks after 24 hours offline, naming the bound', () => {
    const reason = offlineSaleBlockReason({
      queuedCount: 0,
      offlineSinceMs: NOW - 24 * 60 * 60 * 1000 - 1000,
      tenderTotalPence: 1000n,
      nowMs: NOW,
    });
    expect(reason).toContain('24 hours');
  });

  it('allows a sale at exactly 24 hours offline (the bound is "over 24 hours")', () => {
    expect(
      offlineSaleBlockReason({
        queuedCount: 0,
        offlineSinceMs: NOW - 24 * 60 * 60 * 1000,
        tenderTotalPence: 1000n,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it('blocks a single sale over £250, naming the limit and the amount', () => {
    const reason = offlineSaleBlockReason({
      queuedCount: 0,
      offlineSinceMs: NOW - 1000,
      tenderTotalPence: 25001n,
      nowMs: NOW,
    });
    expect(reason).toContain('£250');
    expect(reason).toContain('£250.01');
  });

  it('allows a single sale of exactly £250', () => {
    expect(
      offlineSaleBlockReason({
        queuedCount: 0,
        offlineSinceMs: NOW - 1000,
        tenderTotalPence: 25000n,
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

describe('online-only feature blocks', () => {
  it('has an explicit banner for every online-only feature', () => {
    const expected: string[] = [
      'card_payment',
      'gift_card_issue',
      'gift_card_redeem',
      'store_credit_issue',
      'store_credit_redeem',
      'loyalty_enrol',
      'loyalty_earn',
      'loyalty_redeem',
      'voucher_validation',
      'stock_count',
      'stock_transfer',
      'customer_lookup',
    ];
    expect([...ONLINE_ONLY_FEATURES].sort()).toEqual([...expected].sort());
    for (const feature of ONLINE_ONLY_FEATURES) {
      const banner = offlineBannerFor(feature);
      expect(banner.length).toBeGreaterThan(20);
      expect(banner.toLowerCase()).toContain('offline');
    }
  });

  it('blocks card payments with the D-06 reason', () => {
    expect(offlineBannerFor('card_payment')).toContain('D-06');
    expect(new OfflineBlockedError('card_payment').banner).toContain('Cash only');
  });

  it('blocks voucher validation, loyalty, gift card, store credit, counts and transfers each with its own banner', () => {
    expect(offlineBannerFor('voucher_validation')).toContain('Voucher codes cannot be validated offline');
    expect(offlineBannerFor('loyalty_redeem')).toContain('points balances are checked live');
    expect(offlineBannerFor('gift_card_redeem')).toContain('gift card balances are checked live');
    expect(offlineBannerFor('store_credit_redeem')).toContain('customer balances are checked live');
    expect(offlineBannerFor('stock_count')).toContain('live ledger');
    expect(offlineBannerFor('stock_transfer')).toContain('live warehouse stock');
    expect(offlineBannerFor('customer_lookup')).toContain('customer records live on the server');
  });

  it('exposes the banner map for the UI layer', () => {
    expect(Object.keys(OFFLINE_BANNERS)).toHaveLength(ONLINE_ONLY_FEATURES.length);
  });
});
