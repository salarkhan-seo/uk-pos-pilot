import { describe, expect, it } from 'vitest';
import { FakeAdminApiClient } from '../src/api/fake-client';
import { buildConsentHistory, CrmConsole, giftCardLiabilityPence, loyaltyBalancePence, storeCreditLiabilityPence } from '../src/crm/console';
import type { MarketingConsentView } from '../src/api/types';

function consent(id: string, purpose: string, channel: string, consented: boolean, recordedAt: string): MarketingConsentView {
  return { id, customer_id: 'cust-1', purpose, channel, consented, recorded_at: recordedAt, recorded_by_user_id: 'user-1' };
}

describe('CRM console — consent history (append-only viewer)', () => {
  it('shows the full history newest-first and the latest row per purpose+channel', () => {
    const history = buildConsentHistory('cust-1', [
      consent('c1', 'marketing', 'email', true, '2026-01-01T00:00:00.000Z'),
      consent('c2', 'marketing', 'email', false, '2026-06-01T00:00:00.000Z'),
      consent('c3', 'marketing', 'sms', true, '2026-03-01T00:00:00.000Z'),
    ]);
    expect(history.history.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
    expect(history.latestByPurposeChannel.get('marketing::email')?.id).toBe('c2');
    expect(history.latestByPurposeChannel.get('marketing::email')?.consented).toBe(false);
    expect(history.latestByPurposeChannel.get('marketing::sms')?.id).toBe('c3');
  });

  it('the console exposes no edit or delete path for consents', () => {
    // Append-only by design: the only consent method is the history viewer.
    const console_ = new CrmConsole(new FakeAdminApiClient());
    expect(typeof (console_ as unknown as Record<string, unknown>)['updateConsent']).toBe('undefined');
    expect(typeof (console_ as unknown as Record<string, unknown>)['deleteConsent']).toBe('undefined');
    expect(typeof console_.consentHistory).toBe('function');
  });
});

describe('CRM console — loyalty and closed-loop liabilities', () => {
  it('loyalty balance is the sum of the append-only ledger', () => {
    expect(
      loyaltyBalancePence([
        { id: 'l1', customer_id: 'c', membership_id: 'm', kind: 'earn', points: '500', order_id: 'o1', reason: null, created_at: '2026-11-01' },
        { id: 'l2', customer_id: 'c', membership_id: 'm', kind: 'redeem', points: '-200', order_id: 'o2', reason: null, created_at: '2026-11-02' },
        { id: 'l3', customer_id: 'c', membership_id: 'm', kind: 'correction', points: '50', order_id: null, reason: 'goodwill', created_at: '2026-11-03' },
      ]),
    ).toBe('350');
  });

  it('gift-card liability counts only ACTIVE cards, at their remaining balance', () => {
    expect(
      giftCardLiabilityPence([
        { id: 'g1', code_last4: '1111', initial_amount_pence: '5000', balance_pence: '3000', status: 'active', expires_at: null },
        { id: 'g2', code_last4: '2222', initial_amount_pence: '2000', balance_pence: '0', status: 'redeemed', expires_at: null },
        { id: 'g3', code_last4: '3333', initial_amount_pence: '1000', balance_pence: '1000', status: 'expired', expires_at: null },
        { id: 'g4', code_last4: '4444', initial_amount_pence: '4000', balance_pence: '1500', status: 'active', expires_at: null },
      ]),
    ).toBe('4500');
  });

  it('store-credit liability is the signed sum of the customer ledger', () => {
    expect(
      storeCreditLiabilityPence([
        { kind: 'issue', amount_pence: '2500' },
        { kind: 'redeem', amount_pence: '-1000' },
        { kind: 'refund', amount_pence: '500' },
      ]),
    ).toBe('2000');
  });

  it('console aggregates liabilities end-to-end through the fake client', async () => {
    const fake = new FakeAdminApiClient({
      giftCards: [{ id: 'g1', code_last4: '1111', initial_amount_pence: '5000', balance_pence: '3000', status: 'active', expires_at: null }],
      storeCredit: { 'cust-1': [{ kind: 'issue', amount_pence: '2500', created_at: '2026-11-01' }] },
      loyaltyLedger: [{ id: 'l1', customer_id: 'cust-1', membership_id: 'm1', kind: 'earn', points: '500', order_id: null, reason: null, created_at: '2026-11-01' }],
    });
    const console_ = new CrmConsole(fake);
    const giftCards = await console_.giftCardLiabilities();
    expect(giftCards.outstandingPence).toBe('3000');
    expect(giftCards.cards[0]?.code_last4).toBe('1111');
    expect('code' in (giftCards.cards[0] as unknown as Record<string, unknown>)).toBe(false);
    const credit = await console_.storeCreditLiability('cust-1');
    expect(credit.outstandingPence).toBe('2500');
    const loyalty = await console_.loyaltyLedger('cust-1');
    expect(loyalty.balancePoints).toBe('500');
  });
});

describe('CRM console — GDPR export + Art. 17 erasure (two-step)', () => {
  it('erasure requires explicit acknowledgement; without it no API call is made', async () => {
    const fake = new FakeAdminApiClient({
      customers: [{ id: 'cust-1', first_name: 'Amina', last_name: 'Khan', email: 'a@example.com', phone: null }],
    });
    const console_ = new CrmConsole(fake);
    const confirmation = console_.requestErasure({ id: 'cust-1', first_name: 'Amina', last_name: 'Khan', email: 'a@example.com', phone: null });
    expect(confirmation.confirmed).toBe(false);
    expect(confirmation.acknowledgement).toContain('Art. 17');
    await expect(console_.confirmErasure(confirmation, false)).rejects.toThrow('explicit operator acknowledgement');
    expect(fake.callsFor('crm.eraseCustomer')).toHaveLength(0);
    const result = await console_.confirmErasure(confirmation, true);
    expect(result.customerId).toBe('cust-1');
    expect(fake.callsFor('crm.eraseCustomer')).toHaveLength(1);
  });

  it('per-customer export is read-only and goes through the GDPR export route', async () => {
    const fake = new FakeAdminApiClient({
      customers: [{ id: 'cust-1', first_name: 'Amina', last_name: null, email: null, phone: null }],
    });
    const console_ = new CrmConsole(fake);
    const result = await console_.exportCustomer('cust-1');
    expect(result.customerId).toBe('cust-1');
    expect(fake.callsFor('crm.exportCustomer')[0]?.path).toBe('/v1/crm/customers/cust-1/export');
  });
});

describe('CRM console — assignCustomerToGroup (Build-12 Objective 3)', () => {
  function seededConsole() {
    const fake = new FakeAdminApiClient({
      customers: [{ id: 'cust-1', first_name: 'Amina', last_name: 'Khan', email: null, phone: null }],
      customerGroups: [{ id: 'group-1', name: 'VIP Customers', description: null }],
    });
    return { fake, console_: new CrmConsole(fake) };
  }

  it('assigns a customer to a group, and a repeat call returns the same membership', async () => {
    const { fake, console_ } = seededConsole();
    const first = await console_.assignCustomerToGroup('cust-1', 'group-1');
    expect(first.customer_id).toBe('cust-1');
    expect(first.group_id).toBe('group-1');
    expect(first.created_at).toBeTruthy();
    const second = await console_.assignCustomerToGroup('cust-1', 'group-1');
    expect(second.created_at).toBe(first.created_at);
    expect(fake.customerGroupMemberships).toHaveLength(1);
  });

  it('an unknown customer or group throws 404', async () => {
    const { console_ } = seededConsole();
    await expect(console_.assignCustomerToGroup('no-such-customer', 'group-1')).rejects.toThrow('Resource not found');
    await expect(console_.assignCustomerToGroup('cust-1', 'no-such-group')).rejects.toThrow('Resource not found');
  });

  it('a blank customer or group id is rejected before any API call', async () => {
    const { fake, console_ } = seededConsole();
    await expect(console_.assignCustomerToGroup('', 'group-1')).rejects.toThrow('Customer is required');
    await expect(console_.assignCustomerToGroup('cust-1', '  ')).rejects.toThrow('Group is required');
    expect(fake.customerGroupMemberships).toHaveLength(0);
  });
});
