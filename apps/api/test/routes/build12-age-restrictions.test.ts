/**
 * Build-12 Objective 2 — product-creation nested age restriction &
 * age-restriction removal.
 *
 * Service layer (no Nest app boots under vitest):
 *   - Nested ageRestriction on product creation inserts a first-class
 *     product-level row (variant_id NULL, rule_source 'explicit') in
 *     the same transaction as the product; a variant created
 *     afterwards inherits it ('inherited'); an explicit nested rule
 *     on variant creation wins. An invalid nested object still 400s
 *     with no product row.
 *   - DELETE semantics: deleting a product-level rule removes the
 *     product row AND the 'inherited' variant rows propagated from
 *     it, and NEVER an 'explicit' variant override; deleting a
 *     variant-level rule removes only that row. Unknown id and
 *     cross-tenant are 404 (G-B). Every delete is audit-logged
 *     (age_restriction.deleted) in the same transaction.
 * Controller layer: the DELETE handler returns the service summary,
 * and AuthGuard answers 401 without a credential / 403 without
 * catalogue:write (same pattern as the Build-09 guard tests).
 *
 * The wire-level proof (real HTTP against the compiled server, incl.
 * the 401 / malformed-id 400 / cross-tenant 404 matrix) lives in
 * apps/api/test/e2e/build12-age-restrictions-live.test.ts.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import { CatalogueController } from '../../src/modules/catalogue/catalogue.controller';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { AuditService } from '../../src/modules/admin/audit.service';
import { actorFor, guardContext, makeApiKey, makeGuard, reqFor, withDb } from './helpers';

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

async function seedProductWithVariants(
  db: Kysely<DB>,
  tenant: SeededTenant,
  skus: string[],
): Promise<{ productId: string; variantIds: string[] }> {
  const service = new CatalogueService(db);
  const actor = actorFor(tenant, 'owner');
  const product = await service.createProduct(actor, { name: 'Test Product' });
  const variantIds: string[] = [];
  for (const sku of skus) {
    const variant = await service.createVariant(actor, {
      productId: product.id,
      sku,
      name: `Variant ${sku}`,
      pricePence: 1000n,
      taxRateId: tenant.taxRates.standard,
    });
    variantIds.push(variant.id);
  }
  return { productId: product.id, variantIds };
}

describe('CatalogueService — nested ageRestriction on product creation', () => {
  it('inserts the product-level rule atomically; a later variant inherits it', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const rules = await service.listAgeRestrictions(actor, { productId: product.id });
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual({
        id: rules[0]?.id,
        variant_id: null,
        product_id: product.id,
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'explicit',
      });
      // A variant created afterwards inherits the stored product rule.
      const variant = await service.createVariant(actor, {
        productId: product.id,
        sku: 'VAPE-001',
        name: 'Vape Liquid 10ml',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
      });
      const after = await service.listAgeRestrictions(actor, { productId: product.id });
      expect(after).toHaveLength(2);
      const inherited = after.find((r) => r.variant_id === variant.id);
      expect(inherited).toEqual({
        id: inherited?.id,
        variant_id: variant.id,
        product_id: product.id,
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'inherited',
      });
    });
  });

  it('an explicit nested rule on variant creation wins over the inherited product rule', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const variant = await service.createVariant(actor, {
        productId: product.id,
        sku: 'VAPE-001',
        name: 'Vape Liquid 10ml',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
        ageRestriction: { minAge: 18 },
      });
      const rules = await service.listAgeRestrictions(actor, { productId: product.id });
      expect(rules).toHaveLength(2);
      const explicit = rules.find((r) => r.variant_id === variant.id);
      expect(explicit?.min_age).toBe(18);
      expect(explicit?.rule_source).toBe('explicit');
    });
  });
});

describe('CatalogueService — deleteAgeRestriction', () => {
  it('deleting a product-level rule removes it + inherited rows but preserves an explicit override', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      // Product with a nested 21 rule; variant A inherits it, variant B
      // carries an explicit 18 override.
      const product = await service.createProduct(actor, {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const variantA = await service.createVariant(actor, {
        productId: product.id,
        sku: 'VAPE-A',
        name: 'Vape A',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
      });
      const variantB = await service.createVariant(actor, {
        productId: product.id,
        sku: 'VAPE-B',
        name: 'Vape B',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
        ageRestriction: { minAge: 18 },
      });
      const before = await service.listAgeRestrictions(actor, { productId: product.id });
      expect(before).toHaveLength(3);
      const productRow = before.find((r) => r.variant_id === null) as { id: string };
      const inheritedRow = before.find((r) => r.variant_id === variantA.id) as { id: string };

      const result = await service.deleteAgeRestriction(actor, productRow.id);
      expect(result.deleted_rule).toEqual({
        id: productRow.id,
        variant_id: null,
        product_id: product.id,
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'explicit',
      });
      expect(result.deleted_inherited_rule_ids).toEqual([inheritedRow.id]);

      // Only the explicit 18 override survives.
      const after = await service.listAgeRestrictions(actor, { productId: product.id });
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual({
        id: after[0]?.id,
        variant_id: variantB.id,
        product_id: product.id,
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'explicit',
      });
    });
  });

  it('deleting a product-level rule with no variants removes just that row', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const [row] = await service.listAgeRestrictions(actor, { productId: product.id });
      const result = await service.deleteAgeRestriction(actor, row?.id as string);
      expect(result.deleted_inherited_rule_ids).toEqual([]);
      expect(await service.listAgeRestrictions(actor, { productId: product.id })).toHaveLength(0);
    });
  });

  it('deleting a variant-level rule removes only that row', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const { productId, variantIds } = await seedProductWithVariants(db, tenant, ['V-1', 'V-2']);
      const [rowA] = await service.createAgeRestriction(actor, { variantId: variantIds[0] });
      await service.createAgeRestriction(actor, { variantId: variantIds[1] });
      const result = await service.deleteAgeRestriction(actor, rowA?.id as string);
      expect(result.deleted_rule.variant_id).toBe(variantIds[0]);
      expect(result.deleted_inherited_rule_ids).toEqual([]);
      const remaining = await service.listAgeRestrictions(actor, { productId });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.variant_id).toBe(variantIds[1]);
    });
  });

  it('unknown id and cross-tenant are 404 (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const service = new CatalogueService(db);
      const product = await service.createProduct(actorFor(tenantA, 'owner'), {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const [row] = await service.listAgeRestrictions(actorFor(tenantA, 'owner'), {
        productId: product.id,
      });
      await expect(
        service.deleteAgeRestriction(actorFor(tenantA, 'owner'), UNKNOWN_UUID),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.deleteAgeRestriction(actorFor(tenantB, 'owner'), row?.id as string),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The row survives both 404s.
      expect(
        await service.listAgeRestrictions(actorFor(tenantA, 'owner'), { productId: product.id }),
      ).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('records an age_restriction.deleted audit event in the same transaction', async () => {
    await withDb(async ({ db, tenant }) => {
      const audit = new AuditService(db);
      const service = new CatalogueService(db, undefined, audit);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const [row] = await service.listAgeRestrictions(actor, { productId: product.id });
      await service.deleteAgeRestriction(actor, row?.id as string);
      const events = await audit.listEvents(tenant.tenantId, {
        eventType: 'age_restriction.deleted',
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.entity_id).toBe(row?.id);
      expect(events[0]?.entity_type).toBe('age_restriction');
      const payload = events[0]?.payload as Record<string, unknown>;
      expect(payload['productId']).toBe(product.id);
      expect(payload['variantId']).toBeNull();
      expect(payload['ruleSource']).toBe('explicit');
      expect(await audit.verifyChain(tenant.tenantId)).toEqual({ ok: true });
    });
  });
});

describe('CatalogueController — deleteAgeRestriction', () => {
  it('returns the service summary through the handler', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const controller = new CatalogueController(service);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, {
        name: 'Vape Liquid',
        ageRestriction: { minAge: 21 },
      });
      const [row] = await service.listAgeRestrictions(actor, { productId: product.id });
      const result = await controller.deleteAgeRestriction(reqFor(actor), row?.id as string);
      expect(result.deleted_rule.id).toBe(row?.id);
      expect(result.deleted_inherited_rule_ids).toEqual([]);
      expect(await service.listAgeRestrictions(actor, { productId: product.id })).toHaveLength(0);
    });
  });

  it('AuthGuard: unauthenticated → 401, catalogue:read-only key → 403, catalogue:write key → pass', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const deleteAge = CatalogueController.prototype.deleteAgeRestriction;
      await expect(guard.canActivate(guardContext(deleteAge, {}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      const readKey = await makeApiKey(db, tenant.tenantId, ['catalogue:read']);
      await expect(
        guard.canActivate(guardContext(deleteAge, { authorization: `Bearer ${readKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const writeKey = await makeApiKey(db, tenant.tenantId, ['catalogue:write']);
      expect(
        await guard.canActivate(guardContext(deleteAge, { authorization: `Bearer ${writeKey}` })),
      ).toBe(true);
    });
  });
});
