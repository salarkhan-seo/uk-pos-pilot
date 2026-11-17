/**
 * CrmService — customer directory, append-only consent history, loyalty
 * ledger, gift cards and store credit (Build-04 Worker 4; Arch-09 §§2–5).
 *
 * Read-only lists over the Phase-2 CRM tables that had schema
 * (migration 007) but no service or controller in Build-02/03. Every
 * method takes the Actor first; every query filters tenant_id =
 * actor.tenantId (G-B — a resource that belongs to another tenant is
 * NotFoundException, never 403). Per-customer lists first verify the
 * customer belongs to the actor's tenant, so a customer id from another
 * tenant is 404 even when the list itself would otherwise be empty.
 *
 * DESIGN DECISIONS set here (not research facts):
 *  - List pagination: `limit` defaults to 50, clamped to 1..100.
 *  - Gift-card rows are returned WITHOUT code_hash: only code_last4
 *    (Arch-01 — the full code is never stored, and the hash must never
 *    leave the API either, since it is the credential-equivalent).
 *  - marketing_consents is append-only history: this service exposes a
 *    list ONLY. There is deliberately no create/edit/delete here —
 *    consent writes belong to the enrolment flow, not to this worker.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import type {
  CustomersTable,
  DB,
  GiftCardsTable,
  LoyaltyLedgerTable,
  MarketingConsentsTable,
  StoreCreditLedgerTable,
} from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';

/** Default page size for CRM list endpoints. */
export const CRM_DEFAULT_LIMIT = 50;
/** Hard cap for any CRM list endpoint. */
export const CRM_MAX_LIMIT = 100;

export type CustomerRow = Selectable<CustomersTable>;
export type MarketingConsentRow = Selectable<MarketingConsentsTable>;
export type LoyaltyLedgerRow = Selectable<LoyaltyLedgerTable>;
export type StoreCreditLedgerRow = Selectable<StoreCreditLedgerTable>;

/** One customer-group membership row (Build-12 Objective 3). */
export interface CustomerGroupMembershipView {
  customer_id: string;
  group_id: string;
  created_at: Date;
}

/** Gift card as returned over HTTP: code_last4 only — never code_hash. */
export interface GiftCardView {
  id: string;
  code_last4: string;
  initial_amount_pence: bigint;
  balance_pence: bigint;
  currency: string;
  status: GiftCardsTable['status'];
  issued_at: Date;
  expires_at: Date | null;
}

function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return CRM_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), CRM_MAX_LIMIT);
}

@Injectable()
export class CrmService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async listCustomers(actor: Actor, limit?: number): Promise<CustomerRow[]> {
    return this.db
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(clampLimit(limit))
      .execute();
  }

  /** Verify a customer belongs to this tenant (404 otherwise). */
  private async requireCustomer(actor: Actor, customerId: string): Promise<void> {
    const customer = await this.db
      .selectFrom('customers')
      .select('id')
      .where('id', '=', customerId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (customer === undefined) {
      throw new NotFoundException('Resource not found');
    }
  }

  async listConsents(actor: Actor, customerId: string, limit?: number): Promise<MarketingConsentRow[]> {
    await this.requireCustomer(actor, customerId);
    return this.db
      .selectFrom('marketing_consents')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('customer_id', '=', customerId)
      .orderBy('recorded_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
  }

  async listLoyaltyLedger(actor: Actor, customerId: string, limit?: number): Promise<LoyaltyLedgerRow[]> {
    await this.requireCustomer(actor, customerId);
    return this.db
      .selectFrom('loyalty_ledger')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
  }

  async listGiftCards(actor: Actor, limit?: number): Promise<GiftCardView[]> {
    const rows = await this.db
      .selectFrom('gift_cards')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      code_last4: row.code_last4,
      initial_amount_pence: row.initial_amount_pence,
      balance_pence: row.balance_pence,
      currency: row.currency,
      status: row.status,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
    }));
  }

  async listStoreCredit(actor: Actor, customerId: string, limit?: number): Promise<StoreCreditLedgerRow[]> {
    await this.requireCustomer(actor, customerId);
    return this.db
      .selectFrom('store_credit_ledger')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
  }

  /**
   * Assign a customer to a manual customer group (Build-12 Objective
   * 3, closing the G-UI-06 "no customer-group assignment route" gap).
   * IDEMPOTENT: the memberships table's primary key is
   * (customer_id, group_id), so a repeat call inserts nothing and
   * returns the existing membership (created: false) with its
   * original created_at. The customer and the group must both exist
   * and belong to the tenant (404 otherwise — G-B). The membership
   * row itself carries no tenant_id; tenant scoping comes from
   * verifying both sides first.
   */
  async assignCustomerToGroup(
    actor: Actor,
    customerId: string,
    groupId: string,
  ): Promise<{ membership: CustomerGroupMembershipView; created: boolean }> {
    await this.requireCustomer(actor, customerId);
    const group = await this.db
      .selectFrom('customer_groups')
      .select('id')
      .where('id', '=', groupId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (group === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const inserted = await this.db
      .insertInto('customer_group_memberships')
      .values({ customer_id: customerId, group_id: groupId })
      .onConflict((oc) => oc.columns(['customer_id', 'group_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { membership: inserted, created: true };
    }
    const existing = await this.db
      .selectFrom('customer_group_memberships')
      .selectAll()
      .where('customer_id', '=', customerId)
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    return { membership: existing, created: false };
  }
}
