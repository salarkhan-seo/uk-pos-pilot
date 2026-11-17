/**
 * CRM, Loyalty & Closed-Loop Liabilities Console (Build-04 Objective 2).
 *
 * - Customer directory + groups (dynamic/manual membership is a
 *   server-side concern; the console lists and filters).
 * - `marketing_consents` is APPEND-ONLY: the console is a history
 *   viewer only. There is no edit/delete path in this dashboard, by
 *   design — a consent change is a NEW row (the table's trigger
 *   rejects UPDATE/DELETE). The viewer shows the latest consent per
 *   (purpose, channel) alongside the full history.
 * - Loyalty ledger is append-only; the balance is the SUM of the
 *   ledger's points (earn +, redeem −, correction ±, expiry −). The
 *   console aggregates; it never stores a balance.
 * - Liabilities: gift-card outstanding = SUM(balance_pence) over
 *   active cards; store-credit outstanding = SUM(amount_pence) over
 *   the customer ledger (issue +, redeem/refund −). Only `code_last4`
 *   is ever displayed for gift cards (D-AW-06).
 * - GDPR: per-customer export (read-only) and Art. 17 erasure. Erasure
 *   is a TWO-STEP control in this console (D-AW-10): `requestErasure`
 *   returns the confirmation the operator must acknowledge, and only
 *   `confirmErasure` calls the API. Erasure deletes PII; orders and
 *   audit rows are anonymised and retained for VAT (GdprService).
 */
import type { AdminApiClient } from '../api/client';
import type {
  CustomerExportView,
  CustomerGroupMembershipView,
  CustomerView,
  ErasureResultView,
  GiftCardView,
  LoyaltyLedgerEntryView,
  MarketingConsentView,
} from '../api/types';

export interface ConsentHistory {
  customerId: string;
  /** Full append-only history, newest first. */
  history: MarketingConsentView[];
  /** Latest row per purpose+channel. */
  latestByPurposeChannel: Map<string, MarketingConsentView>;
}

export function buildConsentHistory(customerId: string, consents: MarketingConsentView[]): ConsentHistory {
  const history = [...consents].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  const latestByPurposeChannel = new Map<string, MarketingConsentView>();
  for (const row of history) {
    const key = `${row.purpose}::${row.channel}`;
    if (!latestByPurposeChannel.has(key)) {
      latestByPurposeChannel.set(key, row);
    }
  }
  return { customerId, history, latestByPurposeChannel };
}

export function loyaltyBalancePence(entries: LoyaltyLedgerEntryView[]): string {
  // Points are 1 pt = 1p at tender time (Build-02 design decision);
  // the ledger balance itself is a point sum.
  let total = 0n;
  for (const entry of entries) {
    total += BigInt(entry.points);
  }
  return total.toString();
}

export function giftCardLiabilityPence(cards: GiftCardView[]): string {
  let total = 0n;
  for (const card of cards) {
    if (card.status === 'active') {
      total += BigInt(card.balance_pence);
    }
  }
  return total.toString();
}

export function storeCreditLiabilityPence(entries: Array<{ kind: string; amount_pence: string }>): string {
  let total = 0n;
  for (const entry of entries) {
    total += BigInt(entry.amount_pence);
  }
  return total.toString();
}

export interface ErasureConfirmation {
  customerId: string;
  customerName: string;
  /** What erasure does, in plain language, for the operator to acknowledge. */
  acknowledgement: string;
  confirmed: false;
}

export class CrmConsole {
  constructor(private readonly api: AdminApiClient) {}

  async listCustomers(): Promise<CustomerView[]> {
    return this.api.listCustomers();
  }

  /**
   * Assign a customer to a manual customer group (Build-12
   * Objective 3). Idempotent: a repeat call returns the existing
   * membership with its original created_at. The server is
   * authoritative (404 on an unknown customer or group).
   */
  async assignCustomerToGroup(customerId: string, groupId: string): Promise<CustomerGroupMembershipView> {
    if (customerId.trim() === '') {
      throw new Error('Customer is required.');
    }
    if (groupId.trim() === '') {
      throw new Error('Group is required.');
    }
    return this.api.assignCustomerToGroup(customerId, groupId);
  }

  async consentHistory(customerId: string): Promise<ConsentHistory> {
    const consents = await this.api.listConsents(customerId);
    return buildConsentHistory(customerId, consents);
  }

  async loyaltyLedger(customerId: string): Promise<{ entries: LoyaltyLedgerEntryView[]; balancePoints: string }> {
    const entries = await this.api.listLoyaltyLedger(customerId);
    return { entries, balancePoints: loyaltyBalancePence(entries) };
  }

  async giftCardLiabilities(): Promise<{ cards: GiftCardView[]; outstandingPence: string }> {
    const cards = await this.api.listGiftCards();
    return { cards, outstandingPence: giftCardLiabilityPence(cards) };
  }

  async storeCreditLiability(customerId: string): Promise<{ entries: Array<{ kind: string; amount_pence: string; created_at: string }>; outstandingPence: string }> {
    const entries = await this.api.listStoreCredit(customerId);
    return { entries, outstandingPence: storeCreditLiabilityPence(entries) };
  }

  async exportCustomer(customerId: string): Promise<CustomerExportView> {
    return this.api.exportCustomer(customerId);
  }

  /** Step 1 of 2: returns the acknowledgement the operator must confirm. No API call is made. */
  requestErasure(customer: CustomerView): ErasureConfirmation {
    return {
      customerId: customer.id,
      customerName: `${customer.first_name} ${customer.last_name ?? ''}`.trim(),
      acknowledgement:
        'Art. 17 erasure deletes this customer’s personal data. Orders and audit rows are anonymised (not deleted) and retained for VAT. Loyalty points, gift-card and store-credit balances for this customer are removed. This cannot be undone.',
      confirmed: false,
    };
  }

  /** Step 2 of 2: only call after the operator has acknowledged the erasure confirmation. */
  async confirmErasure(confirmation: ErasureConfirmation, acknowledged: boolean): Promise<ErasureResultView> {
    if (!acknowledged) {
      throw new Error('Erasure requires explicit operator acknowledgement.');
    }
    return this.api.eraseCustomer(confirmation.customerId);
  }
}
