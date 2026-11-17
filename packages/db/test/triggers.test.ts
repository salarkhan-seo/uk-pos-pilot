/**
 * Database trigger integration tests (Build-02, Objective 1).
 *
 * Proves, against the live PGlite engine with all 8 migrations applied,
 * that the database itself enforces the rules the architecture depends on:
 *  - UPDATE and DELETE on append-only tables are rejected by trigger;
 *  - a completed order and an issued Z-report are immutable by trigger;
 *  - a 5th attribute on a product and a 21st bundle component are
 *    rejected by trigger;
 *  - self-approval on approval_events is rejected by CHECK.
 *
 * A rejection here is a database error (RAISE EXCEPTION / check
 * violation), not an application error — the application must never be
 * the only thing standing between a caller and a mutated ledger.
 */
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, seedVariant, setStock, type SeededTenant } from '../src/index';
import type { DB } from '../src/schema';

/** Assert a Kysely promise rejects with a database error matching `pattern`. */
async function expectDbReject(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the statement to be rejected by the database').toBeDefined();
  expect(String((caught as Error)?.message ?? caught)).toMatch(pattern);
}

async function seedCustomer(db: Kysely<DB>, tenant: SeededTenant): Promise<{ customerId: string; membershipId: string }> {
  const customer = await db
    .insertInto('customers')
    .values({ tenant_id: tenant.tenantId, first_name: 'Test', last_name: 'Customer' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const membership = await db
    .insertInto('loyalty_memberships')
    .values({ tenant_id: tenant.tenantId, customer_id: customer.id, membership_number: 'M-0001' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { customerId: customer.id, membershipId: membership.id };
}

describe('append-only triggers', () => {
  it('rejects UPDATE and DELETE on stock_movements', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant);
      const movement = await db
        .insertInto('stock_movements')
        .values({
          tenant_id: tenant.tenantId,
          variant_id: variant.variantId,
          warehouse_id: tenant.warehouseId,
          location_id: tenant.locationId,
          cause: 'goods_in',
          quantity_change: 5n,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectDbReject(
        db.updateTable('stock_movements').set({ quantity_change: 9n }).where('id', '=', movement.id).execute(),
        /append-only: UPDATE is not allowed/,
      );
      await expectDbReject(
        db.deleteFrom('stock_movements').where('id', '=', movement.id).execute(),
        /append-only: DELETE is not allowed/,
      );
      // The row is still there, unchanged.
      const row = await db
        .selectFrom('stock_movements')
        .select('quantity_change')
        .where('id', '=', movement.id)
        .executeTakeFirstOrThrow();
      expect(row.quantity_change).toBe(5n);
    } finally {
      await close();
    }
  });

  it('rejects UPDATE and DELETE on audit_events', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const event = await db
        .insertInto('audit_events')
        .values({
          tenant_id: tenant.tenantId,
          user_id: tenant.users.manager.id,
          event_type: 'test.event',
          payload: { a: 1 },
          prev_hash: 'GENESIS',
          event_hash: 'abc123',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectDbReject(
        db.updateTable('audit_events').set({ event_type: 'tampered' }).where('id', '=', event.id).execute(),
        /append-only: UPDATE is not allowed/,
      );
      await expectDbReject(
        db.deleteFrom('audit_events').where('id', '=', event.id).execute(),
        /append-only: DELETE is not allowed/,
      );
    } finally {
      await close();
    }
  });

  it('rejects UPDATE and DELETE on the loyalty, gift-card and store-credit ledgers', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { customerId, membershipId } = await seedCustomer(db, tenant);

      const loyalty = await db
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          membership_id: membershipId,
          kind: 'earn',
          points: 100n,
          idempotency_key: 'loyalty-1',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectDbReject(
        db.updateTable('loyalty_ledger').set({ points: 999n }).where('id', '=', loyalty.id).execute(),
        /append-only/,
      );
      await expectDbReject(
        db.deleteFrom('loyalty_ledger').where('id', '=', loyalty.id).execute(),
        /append-only/,
      );

      const card = await db
        .insertInto('gift_cards')
        .values({
          tenant_id: tenant.tenantId,
          code_hash: 'hash-1',
          code_last4: '1234',
          initial_amount_pence: 5000n,
          balance_pence: 5000n,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const giftRow = await db
        .insertInto('gift_card_ledger')
        .values({
          tenant_id: tenant.tenantId,
          gift_card_id: card.id,
          kind: 'issue',
          amount_pence: 5000n,
          idempotency_key: 'gift-1',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectDbReject(
        db.updateTable('gift_card_ledger').set({ amount_pence: 1n }).where('id', '=', giftRow.id).execute(),
        /append-only/,
      );
      await expectDbReject(
        db.deleteFrom('gift_card_ledger').where('id', '=', giftRow.id).execute(),
        /append-only/,
      );

      const credit = await db
        .insertInto('store_credit_ledger')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          kind: 'issue',
          amount_pence: 2000n,
          idempotency_key: 'credit-1',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectDbReject(
        db.updateTable('store_credit_ledger').set({ amount_pence: 1n }).where('id', '=', credit.id).execute(),
        /append-only/,
      );
      await expectDbReject(
        db.deleteFrom('store_credit_ledger').where('id', '=', credit.id).execute(),
        /append-only/,
      );
    } finally {
      await close();
    }
  });

  it('rejects UPDATE and DELETE on marketing_consents', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { customerId } = await seedCustomer(db, tenant);
      const consent = await db
        .insertInto('marketing_consents')
        .values({
          tenant_id: tenant.tenantId,
          customer_id: customerId,
          purpose: 'offers',
          channel: 'email',
          consented: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expectDbReject(
        db.updateTable('marketing_consents').set({ consented: false }).where('id', '=', consent.id).execute(),
        /append-only/,
      );
      await expectDbReject(
        db.deleteFrom('marketing_consents').where('id', '=', consent.id).execute(),
        /append-only/,
      );
    } finally {
      await close();
    }
  });

  it('rejects UPDATE and DELETE on an issued Z-report, but allows edits while draft', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const session = await db
        .insertInto('register_sessions')
        .values({ tenant_id: tenant.tenantId, register_id: tenant.registerId, opened_by_user_id: tenant.users.manager.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const draft = await db
        .insertInto('z_reports')
        .values({
          tenant_id: tenant.tenantId,
          register_id: tenant.registerId,
          session_id: session.id,
          z_number: 1n,
          business_date: '2026-11-13',
          status: 'draft',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // A draft Z-report may be edited (it is not issued yet).
      await db.updateTable('z_reports').set({ gross_pence: 1000n }).where('id', '=', draft.id).execute();
      await db.updateTable('z_reports').set({ status: 'issued' }).where('id', '=', draft.id).execute();
      await expectDbReject(
        db.updateTable('z_reports').set({ gross_pence: 2000n }).where('id', '=', draft.id).execute(),
        /Issued Z-report .* is immutable/,
      );
      await expectDbReject(
        db.deleteFrom('z_reports').where('id', '=', draft.id).execute(),
        /Issued Z-report .* is immutable/,
      );
    } finally {
      await close();
    }
  });

  it('rejects UPDATE and DELETE on a completed order, but allows edits while draft', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const order = await db
        .insertInto('orders')
        .values({
          tenant_id: tenant.tenantId,
          location_id: tenant.locationId,
          register_id: tenant.registerId,
          order_number: 1n,
          business_date: '2026-11-13',
          status: 'draft',
          total_pence: 1000n,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db.updateTable('orders').set({ total_pence: 1200n }).where('id', '=', order.id).execute();
      await db.updateTable('orders').set({ status: 'completed' }).where('id', '=', order.id).execute();
      await expectDbReject(
        db.updateTable('orders').set({ total_pence: 1300n }).where('id', '=', order.id).execute(),
        /Completed order .* is immutable/,
      );
      await expectDbReject(
        db.deleteFrom('orders').where('id', '=', order.id).execute(),
        /Completed order .* is immutable/,
      );
    } finally {
      await close();
    }
  });
});

describe('catalogue triggers', () => {
  it('rejects a 5th attribute on a variant, and allows 4', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const variant = await seedVariant(db, tenant);
      const attributeIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const attr = await db
          .insertInto('product_attributes')
          .values({ tenant_id: tenant.tenantId, product_id: variant.productId, name: `attr-${i}` })
          .returning('id')
          .executeTakeFirstOrThrow();
        const value = await db
          .insertInto('attribute_values')
          .values({ product_attribute_id: attr.id, value: `value-${i}` })
          .returning('id')
          .executeTakeFirstOrThrow();
        attributeIds.push(attr.id);
        if (i < 4) {
          await db
            .insertInto('variant_attribute_values')
            .values({ variant_id: variant.variantId, product_attribute_id: attr.id, attribute_value_id: value.id })
            .execute();
        } else {
          await expectDbReject(
            db
              .insertInto('variant_attribute_values')
              .values({ variant_id: variant.variantId, product_attribute_id: attr.id, attribute_value_id: value.id })
              .execute(),
            /at most 4 attributes/,
          );
        }
      }
      expect(attributeIds).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it('rejects a 21st bundle component, nesting, and self-reference', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const bundle = await seedVariant(db, tenant, { sku: 'BUNDLE-1', isBundle: true });
      const components: string[] = [];
      for (let i = 0; i < 21; i += 1) {
        const component = await seedVariant(db, tenant, { sku: `COMP-${i}` });
        components.push(component.variantId);
        if (i < 20) {
          await db
            .insertInto('bundle_components')
            .values({ bundle_variant_id: bundle.variantId, component_variant_id: component.variantId, quantity: 1 })
            .execute();
        } else {
          await expectDbReject(
            db
              .insertInto('bundle_components')
              .values({ bundle_variant_id: bundle.variantId, component_variant_id: component.variantId, quantity: 1 })
              .execute(),
            /at most 20 components/,
          );
        }
      }
      // A bundle cannot contain another bundle (no nesting).
      const innerBundle = await seedVariant(db, tenant, { sku: 'BUNDLE-INNER', isBundle: true });
      await expectDbReject(
        db
          .insertInto('bundle_components')
          .values({ bundle_variant_id: bundle.variantId, component_variant_id: innerBundle.variantId, quantity: 1 })
          .execute(),
        /cannot themselves be bundles/,
      );
      // A bundle cannot contain itself.
      await expectDbReject(
        db
          .insertInto('bundle_components')
          .values({ bundle_variant_id: bundle.variantId, component_variant_id: bundle.variantId, quantity: 1 })
          .execute(),
        /cannot contain itself/,
      );
      expect(components).toHaveLength(21);
    } finally {
      await close();
    }
  });
});

describe('approval_events check', () => {
  it('rejects self-approval and allows a different approver', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const manager = tenant.users.manager.id;
      const admin = tenant.users.admin.id;
      await expectDbReject(
        db
          .insertInto('approval_events')
          .values({
            tenant_id: tenant.tenantId,
            action: 'discount_above_limit',
            amount_pence: 500n,
            requested_by_user_id: manager,
            approved_by_user_id: manager,
          })
          .execute(),
        /violates check constraint/,
      );
      const row = await db
        .insertInto('approval_events')
        .values({
          tenant_id: tenant.tenantId,
          action: 'discount_above_limit',
          amount_pence: 500n,
          requested_by_user_id: manager,
          approved_by_user_id: admin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(row.id).toBeDefined();
      // Stock helper sanity: setStock writes a ledger row + read models.
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 3n });
      const balance = await db
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', variant.variantId)
        .executeTakeFirstOrThrow();
      expect(balance.quantity_on_hand).toBe(3n);
    } finally {
      await close();
    }
  });
});
