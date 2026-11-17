/**
 * E2E — Age Verification Challenge 25 gate and refusal logging
 * (Build-04, Objective 3; Arch-01 §2.5).
 *
 * What the SERVER proves (this file):
 *   - A variant can be flagged as age-restricted with Challenge 25
 *     (age_restrictions: min_age_years + challenge_25).
 *   - Verification and refusal events are recorded in
 *     age_verification_events with the VERIFIED AGE (e.g. 25), the
 *     method and the outcome — and NO date of birth is stored
 *     anywhere: the table has no DOB/birth column at all
 *     (information_schema proof below), and no DOB value appears in
 *     any event row.
 *   - A refusal is a first-class record (outcome 'refused'), not an
 *     absence of a record.
 *
 * What the server does NOT prove (register app, Worker 1): the
 * checkout gate itself — blocking checkout of a requires_challenge_25
 * item until the cashier confirms verification or logs a refusal.
 * There is NO age-verification service method in apps/api (Build-03),
 * so the server cannot block the sale; createOrder succeeding for a
 * restricted variant below documents that gap rather than hiding it.
 * The gate behaviour belongs to the register app's suite.
 *
 * Schema quirk recorded here, not fixed: verified_age_years is
 * NOT NULL with CHECK (> 0) even for refusals, so a refusal must
 * still carry a positive age — the age stated/assessed when the
 * sale was refused (17 in the test below, under 18, hence refused).
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  makeServices,
  managerActor,
  seedVariant,
  setStock,
  withDb,
} from './support/e2e-helpers';

describe('E2E — Age Verification Challenge 25', () => {
  it('gate data contract: restriction flag, verified event, refusal event, and no DOB stored anywhere', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);

      // An age-restricted variant (e.g. alcohol): 18+, Challenge 25.
      const restricted = await seedVariant(db, tenant, { name: 'Age-restricted item' });
      await setStock(db, tenant, restricted.variantId, { quantity: 5n });
      await db
        .insertInto('age_restrictions')
        .values({
          tenant_id: tenant.tenantId,
          variant_id: restricted.variantId,
          min_age_years: 18,
          challenge_25: true,
        })
        .execute();
      const restriction = await db
        .selectFrom('age_restrictions')
        .selectAll()
        .where('variant_id', '=', restricted.variantId)
        .executeTakeFirstOrThrow();
      expect(restriction.min_age_years).toBe(18);
      expect(restriction.challenge_25).toBe(true);

      // A normal variant carries no restriction at all.
      const unrestricted = await seedVariant(db, tenant, { name: 'Ordinary item' });
      const noRestriction = await db
        .selectFrom('age_restrictions')
        .select('id')
        .where('variant_id', '=', unrestricted.variantId)
        .execute();
      expect(noRestriction).toHaveLength(0);

      // Verified sale: cashier confirms Challenge 25, records the
      // VERIFIED AGE (25) — never a date of birth.
      const { order: verifiedOrder } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: restricted.variantId, quantity: 1n }],
      });
      await db
        .insertInto('age_verification_events')
        .values({
          tenant_id: tenant.tenantId,
          order_id: verifiedOrder.id,
          variant_id: restricted.variantId,
          verified_age_years: 25,
          method: 'manual_confirmation',
          outcome: 'verified',
          verified_by_user_id: tenant.users.cashier.id,
        })
        .execute();
      // With verification recorded, the sale completes normally.
      await sales.addTender(actor, {
        orderId: verifiedOrder.id,
        tenderType: 'cash',
        amountPence: verifiedOrder.total_pence,
      });
      const { order: completedVerified } = await sales.completeOrder(actor, verifiedOrder.id);
      expect(completedVerified.status).toBe('completed');

      // Refused sale: customer states 17 (under 18) — recorded as a
      // refusal with the stated age, and the item is removed from the
      // sale (the order is voided here; the register app removes the
      // line instead — same outcome, no sale of the restricted item).
      const { order: refusedOrder } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [{ variantId: restricted.variantId, quantity: 1n }],
      });
      await db
        .insertInto('age_verification_events')
        .values({
          tenant_id: tenant.tenantId,
          order_id: refusedOrder.id,
          variant_id: restricted.variantId,
          verified_age_years: 17,
          method: 'manual_confirmation',
          outcome: 'refused',
          verified_by_user_id: tenant.users.cashier.id,
        })
        .execute();
      await sales.voidOrder(actor, refusedOrder.id, 'age verification refused');

      // Both events are on record, with the right outcomes and ages.
      const events = await db
        .selectFrom('age_verification_events')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .orderBy('created_at', 'asc')
        .execute();
      expect(events).toHaveLength(2);
      expect(events[0]?.outcome).toBe('verified');
      expect(events[0]?.verified_age_years).toBe(25);
      expect(events[0]?.method).toBe('manual_confirmation');
      expect(events[0]?.order_id).toBe(verifiedOrder.id);
      expect(events[1]?.outcome).toBe('refused');
      expect(events[1]?.verified_age_years).toBe(17);
      expect(events[1]?.order_id).toBe(refusedOrder.id);

      // NO date of birth is stored: the table has no DOB/birth column
      // at all, and no event row carries a DOB key or value.
      const dobColumns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'age_verification_events'
          AND (column_name ILIKE '%dob%' OR column_name ILIKE '%birth%')
      `.execute(db);
      expect(dobColumns.rows).toHaveLength(0);
      for (const event of events) {
        const keys = Object.keys(event);
        expect(keys.some((key) => /dob|birth/i.test(key))).toBe(false);
      }

      // The refused order never sold the restricted item.
      const refused = await db
        .selectFrom('orders')
        .select('status')
        .where('id', '=', refusedOrder.id)
        .executeTakeFirstOrThrow();
      expect(refused.status).toBe('voided');

      // HONEST LIMIT (see file header): the server does not block
      // checkout of a restricted variant — createOrder above
      // succeeded for one. The blocking gate is the register app's
      // (Worker 1). What the server guarantees is the audit trail:
      // every restricted sale that DOES complete must have its
      // verification event, and every refusal is logged.
    });
  });
});
