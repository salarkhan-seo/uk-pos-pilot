/**
 * Build-10 Objective 3 — product-level age-restriction inheritance,
 * SUPERSEDED by Build-11 Objective 2's stored first-class product
 * rules (migration 018). This file now proves the STORED rule:
 *
 * RULE (stored, authoritative — age_restrictions carries product_id
 * AND variant_id, exactly one set; a product-level row has
 * product_id set and variant_id NULL): a product-target POST stores
 * the product-level rule ('explicit') and propagates
 * rule_source = 'inherited' rows to existing variants that do NOT
 * have an 'explicit' row. When POST /v1/catalogue/variants creates
 * a variant under a product with a stored product-level rule, the
 * new variant inherits it ('inherited') in the same transaction —
 * unless an explicit nested ageRestriction in the create body
 * overrides it.
 *
 * What Build-11 CHANGED vs Build-10's derived inference (a rule was
 * product-level when EVERY pre-existing variant carried an IDENTICAL
 * restriction): the derived inference is REMOVED. A variant-target
 * rule on one variant — even the sole variant — no longer makes the
 * next variant inherit anything; only a stored product-level row
 * governs. Mixed explicit variant rules never create a product rule.
 *
 * Edge cases proven here (service level; the controller delegates):
 *   - first variant of a product: nothing to inherit;
 *   - product-target rule is inherited by a later variant;
 *   - product with variants but no rules: nothing to inherit;
 *   - mixed explicit rules across variants: no product rule, no
 *     inheritance;
 *   - a variant-target rule on one variant (even the sole variant)
 *     does NOT create a product rule: no inheritance;
 *   - an explicit nested rule overrides inheritance, even when it
 *     removes the restriction;
 *   - a failed create leaves no variant and no inherited rule row
 *     behind;
 *   - inheritance is scoped per product and per tenant (G-B);
 *   - a product-target POST on a variant-less product stores the
 *     product rule (Build-09's 400 is gone);
 *   - a product rule change refreshes 'inherited' rows but NEVER
 *     overwrites an 'explicit' variant row.
 */
import { describe, expect, it } from 'vitest';
import { createTestDb, seedTenant, type SeededTenant } from '@uk-pos/db';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { CatalogueController } from '../../src/modules/catalogue/catalogue.controller';
import { actorFor } from './helpers';
import type { Actor } from '../../src/common/actor';

async function seedProduct(
  service: CatalogueService,
  actor: Actor,
  name = 'Restricted Product',
): Promise<string> {
  const product = await service.createProduct(actor, { name });
  return product.id;
}

async function seedVariant(
  service: CatalogueService,
  actor: Actor,
  tenant: SeededTenant,
  productId: string,
  sku: string,
  ageRestriction?: { requiresChallenge25?: boolean; minAge?: number } | null,
) {
  return service.createVariant(actor, {
    productId,
    sku,
    name: `Variant ${sku}`,
    pricePence: 800n,
    taxRateId: tenant.taxRates.standard,
    ageRestriction: ageRestriction ?? null,
  });
}

async function ruleForVariant(
  service: CatalogueService,
  actor: Actor,
  variantId: string,
): Promise<{ requires_challenge_25: boolean; min_age: number; rule_source: string } | null> {
  const rows = await service.listAgeRestrictions(actor, { variantId });
  const row = rows[0];
  if (row === undefined) return null;
  return {
    requires_challenge_25: row.requires_challenge_25,
    min_age: row.min_age,
    rule_source: row.rule_source,
  };
}

describe('CatalogueService — product-level age-rule inheritance (Build-10 Obj 3, stored rules Build-11 Obj 2)', () => {
  it('first variant of a product creates no age row (nothing to inherit)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      const variant = await seedVariant(service, actor, tenant, productId, 'V-001');
      expect(await ruleForVariant(service, actor, variant.id)).toBeNull();
    } finally {
      await close();
    }
  });

  it('product-target rule is inherited by a later variant (same transaction, defaults true / 18)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      await seedVariant(service, actor, tenant, productId, 'V-001');
      const applied = await service.createAgeRestriction(actor, { productId });
      expect(applied).toHaveLength(1);
      expect(applied[0]?.requires_challenge_25).toBe(true);
      expect(applied[0]?.min_age).toBe(18);
      expect(applied[0]?.rule_source).toBe('inherited');

      const second = await seedVariant(service, actor, tenant, productId, 'V-002');
      expect(await ruleForVariant(service, actor, second.id)).toEqual({
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'inherited',
      });
    } finally {
      await close();
    }
  });

  it('product with variants but no rules: a new variant inherits nothing', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      await seedVariant(service, actor, tenant, productId, 'V-001');
      await seedVariant(service, actor, tenant, productId, 'V-002');
      const third = await seedVariant(service, actor, tenant, productId, 'V-003');
      expect(await ruleForVariant(service, actor, third.id)).toBeNull();
    } finally {
      await close();
    }
  });

  it('mixed explicit rules across variants: no product rule, no inheritance', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      await seedVariant(service, actor, tenant, productId, 'V-001', { minAge: 18 });
      await seedVariant(service, actor, tenant, productId, 'V-002', { minAge: 21 });
      const third = await seedVariant(service, actor, tenant, productId, 'V-003');
      expect(await ruleForVariant(service, actor, third.id)).toBeNull();
      // No product-level row was created by the two variant rules.
      const all = await service.listAgeRestrictions(actor, { productId });
      expect(all.every((r) => r.variant_id !== null)).toBe(true);
    } finally {
      await close();
    }
  });

  it('a variant-target rule on one variant does NOT create a product rule: no inheritance', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      // Both variants plain first — no rule exists yet, so neither
      // inherits anything at creation.
      const first = await seedVariant(service, actor, tenant, productId, 'V-001');
      await seedVariant(service, actor, tenant, productId, 'V-002');
      // Now attach a rule to the FIRST variant only: V-001 has a row,
      // V-002 has none — the product has no stored product-level rule.
      await service.createAgeRestriction(actor, { variantId: first.id, minAge: 18 });
      const third = await seedVariant(service, actor, tenant, productId, 'V-003');
      expect(await ruleForVariant(service, actor, third.id)).toBeNull();
    } finally {
      await close();
    }
  });

  it('a variant-target rule on the sole existing variant does NOT make the next variant inherit (derived inference removed)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      const first = await seedVariant(service, actor, tenant, productId, 'V-001');
      await service.createAgeRestriction(actor, { variantId: first.id, minAge: 21 });
      // Build-10's derived inference treated the sole variant's rule
      // as the product rule; Build-11 removes that inference — only
      // a STORED product-level row governs, so the next variant
      // inherits nothing.
      const second = await seedVariant(service, actor, tenant, productId, 'V-002');
      expect(await ruleForVariant(service, actor, second.id)).toBeNull();
      const all = await service.listAgeRestrictions(actor, { productId });
      expect(all).toHaveLength(1);
      expect(all[0]?.variant_id).toBe(first.id);
      expect(all[0]?.rule_source).toBe('explicit');
    } finally {
      await close();
    }
  });

  it('an explicit nested rule OVERRIDES inheritance, even when it removes the restriction', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      await seedVariant(service, actor, tenant, productId, 'V-001');
      await service.createAgeRestriction(actor, { productId, minAge: 18 });
      const second = await seedVariant(service, actor, tenant, productId, 'V-002', {
        requiresChallenge25: false,
        minAge: 21,
      });
      expect(await ruleForVariant(service, actor, second.id)).toEqual({
        requires_challenge_25: false,
        min_age: 21,
        rule_source: 'explicit',
      });
    } finally {
      await close();
    }
  });

  it('a failed create leaves no variant and no inherited rule row behind', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      await seedVariant(service, actor, tenant, productId, 'V-001');
      await service.createAgeRestriction(actor, { productId, minAge: 18 });
      // Duplicate SKU: the insert fails inside the transaction.
      await expect(
        seedVariant(service, actor, tenant, productId, 'V-001'),
      ).rejects.toThrow('SKU already exists for this tenant');
      const variants = await service.listVariants(actor, { productId });
      expect(variants).toHaveLength(1);
      // Two rows: the stored product-level row (variant_id NULL) and
      // the inherited row on V-001 — the failed create added neither.
      const rules = await service.listAgeRestrictions(actor, { productId });
      expect(rules).toHaveLength(2);
      expect(rules.filter((r) => r.variant_id === null)).toHaveLength(1);
      expect(rules.filter((r) => r.variant_id !== null)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('inheritance is scoped per product and per tenant (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const restrictedProduct = await seedProduct(service, actor, 'Restricted');
      const plainProduct = await seedProduct(service, actor, 'Plain');
      await seedVariant(service, actor, tenant, restrictedProduct, 'R-001');
      await service.createAgeRestriction(actor, { productId: restrictedProduct, minAge: 18 });
      // A new variant under the OTHER product inherits nothing.
      const plainVariant = await seedVariant(service, actor, tenant, plainProduct, 'P-001');
      expect(await ruleForVariant(service, actor, plainVariant.id)).toBeNull();
      // Another tenant cannot see the rule at all.
      const otherActor = actorFor(other, 'owner');
      expect(await service.listAgeRestrictions(otherActor, {})).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('product-target POST on a variant-less product stores the product rule; a later variant inherits it', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      // Build-09's 400 for a variant-less product is gone (Build-11
      // Objective 2): the POST stores the product-level row.
      const stored = await service.createAgeRestriction(actor, { productId, minAge: 21 });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.variant_id).toBeNull();
      expect(stored[0]?.min_age).toBe(21);
      expect(stored[0]?.rule_source).toBe('explicit');
      const variant = await seedVariant(service, actor, tenant, productId, 'V-001');
      expect(await ruleForVariant(service, actor, variant.id)).toEqual({
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'inherited',
      });
    } finally {
      await close();
    }
  });

  it('a product rule change refreshes inherited rows but NEVER overwrites an explicit variant row', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const productId = await seedProduct(service, actor);
      const first = await seedVariant(service, actor, tenant, productId, 'V-001');
      const second = await seedVariant(service, actor, tenant, productId, 'V-002');
      // V-002 gets an EXPLICIT variant rule (18) before the product
      // rule exists.
      await service.createAgeRestriction(actor, { variantId: second.id, minAge: 18 });
      // First product rule (21): V-001 gains an inherited row;
      // V-002's explicit row is untouched.
      const firstApplied = await service.createAgeRestriction(actor, { productId, minAge: 21 });
      expect(firstApplied).toHaveLength(2);
      expect(await ruleForVariant(service, actor, first.id)).toEqual({
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'inherited',
      });
      expect(await ruleForVariant(service, actor, second.id)).toEqual({
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'explicit',
      });
      // Second product rule (25): the inherited row refreshes to 25;
      // the explicit row STILL stays at 18.
      await service.createAgeRestriction(actor, { productId, minAge: 25 });
      expect(await ruleForVariant(service, actor, first.id)).toEqual({
        requires_challenge_25: true,
        min_age: 25,
        rule_source: 'inherited',
      });
      expect(await ruleForVariant(service, actor, second.id)).toEqual({
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'explicit',
      });
      // The stored product-level row itself is 25.
      const all = await service.listAgeRestrictions(actor, { productId });
      expect(all).toHaveLength(3);
      const productRow = all.find((r) => r.variant_id === null);
      expect(productRow?.min_age).toBe(25);
      expect(productRow?.rule_source).toBe('explicit');
    } finally {
      await close();
    }
  });
});

describe('CatalogueController — inheritance through the wire handler', () => {
  it('POST /v1/catalogue/variants inherits the product rule when no nested rule is given', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const service = new CatalogueService(db);
      const controller = new CatalogueController(service);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, { name: 'Vape' });
      await service.createVariant(actor, {
        productId: product.id,
        sku: 'V-001',
        name: 'Vape 001',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
      });
      await service.createAgeRestriction(actor, { productId: product.id, minAge: 18 });
      const headers = {
        'x-tenant-id': tenant.tenantId,
        'x-location-id': tenant.locationId,
        'x-user-id': tenant.users.owner.id,
        'x-roles': 'owner',
      };
      const created = await controller.createVariant(headers, {
        productId: product.id,
        sku: 'V-002',
        name: 'Vape 002',
        pricePence: '800',
        taxRateId: tenant.taxRates.standard,
      });
      expect(await ruleForVariant(service, actor, created.id)).toEqual({
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'inherited',
      });
    } finally {
      await close();
    }
  });
});
