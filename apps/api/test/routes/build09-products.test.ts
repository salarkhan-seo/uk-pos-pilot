/**
 * Build-09 Objective 1 — products + age-restriction HTTP endpoints.
 *
 * Mounted paths (the real ones — the commission's shorthand
 * "POST /v1/products" is NOT the path; the variant precedent
 * POST v1/catalogue/variants governs):
 *   POST v1/catalogue/products          (catalogue:write)
 *   GET  v1/catalogue/products          (catalogue:read)
 *   GET  v1/catalogue/products/:id      (catalogue:read, :id named `id`)
 *   POST v1/catalogue/age-restrictions  (catalogue:write)
 *   GET  v1/catalogue/age-restrictions  (catalogue:read)
 *
 * Layers, each proven where it actually lives (no Nest app boots under
 * vitest — esbuild emits no decorator metadata):
 *
 *  (a) Service — products (create/list/get, name validation, nested
 *      ageRestriction creates a first-class product-level rule in the
 *      same transaction — Build-12 Objective 2 supersedes the
 *      Build-09 rejection; an invalid nested object still 400s with
 *      no row left behind);
 *      age restrictions (variant target, product target expanding to
 *      the product's current variants, upsert semantics, exactly-one
 *      validation, min_age positive-integer validation, 404s);
 *      nested restriction on variant creation (same-transaction
 *      atomicity: bad nested input 400s with no variant row).
 *  (b) Controller — direct construction with the real service; the
 *      view shapes are what the wire returns.
 *  (c) AuthGuard — driven directly with mock ExecutionContexts on the
 *      real decorated handlers: no credential → 401, wrong scope →
 *      403, catalogue:write/read key or manager PIN session → pass,
 *      cashier PIN session → 403 on writes, x-tenant-id for another
 *      tenant → 404.
 *  (d) UuidValidationInterceptor — malformed :id → 400 INVALID_UUID
 *      naming the field; a well-formed UUID passes through.
 *
 * The wire-level proof (real HTTP against the compiled server, incl.
 * the admin-shell product-create flow that consumes these routes)
 * lives in apps/admin-web/test/build09-products.test.ts.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { of } from 'rxjs';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import { CatalogueController } from '../../src/modules/catalogue/catalogue.controller';
import {
  CatalogueService,
  toAgeRestrictionView,
  toProductView,
  validateAgeRestrictionInput,
} from '../../src/modules/catalogue/catalogue.service';
import { SessionService } from '../../src/modules/admin/session.service';
import { UuidValidationInterceptor } from '../../src/common/uuid-validation.interceptor';
import { InvalidUuidException } from '../../src/common/uuid';
import { actorFor, guardContext, makeApiKey, makeGuard, reqFor, withDb } from './helpers';

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MALFORMED = 'not-a-uuid';

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

describe('validateAgeRestrictionInput — normalisation + validation', () => {
  it('returns null for an absent object', () => {
    expect(validateAgeRestrictionInput(undefined)).toBeNull();
    expect(validateAgeRestrictionInput(null)).toBeNull();
  });

  it('defaults to requiresChallenge25 true and minAge 18', () => {
    expect(validateAgeRestrictionInput({})).toEqual({ requiresChallenge25: true, minAge: 18 });
    expect(validateAgeRestrictionInput({ requiresChallenge25: false })).toEqual({
      requiresChallenge25: false,
      minAge: 18,
    });
    expect(validateAgeRestrictionInput({ minAge: 21 })).toEqual({
      requiresChallenge25: true,
      minAge: 21,
    });
  });

  it('rejects a non-object, a non-boolean flag, and a non-positive-integer minAge', () => {
    expect(() => validateAgeRestrictionInput('yes')).toThrow(BadRequestException);
    expect(() => validateAgeRestrictionInput({ requiresChallenge25: 'yes' })).toThrow(
      BadRequestException,
    );
    for (const bad of [0, -1, 1.5, '18']) {
      expect(() => validateAgeRestrictionInput({ minAge: bad as never })).toThrow(
        BadRequestException,
      );
    }
  });
});

describe('CatalogueService — products', () => {
  it('creates a product and returns the wire view (name trimmed)', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const created = await service.createProduct(actor, {
        name: '  Vape Liquid  ',
        description: '18+ only',
      });
      expect(toProductView(created)).toEqual({
        id: created.id,
        category_id: null,
        name: 'Vape Liquid',
        description: '18+ only',
        is_active: true,
      });
    });
  });

  it('rejects a blank name with 400 and an unknown category with 404', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      await expect(service.createProduct(actor, { name: '   ' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.createProduct(actor, { name: 'Tea', categoryId: UNKNOWN_UUID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('creates a product-level rule from a nested age_restriction; an invalid nested object still 400s with no row', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      // Invalid nested object 400s on validation, with no row left behind…
      await expect(
        service.createProduct(actor, { name: 'Vape', ageRestriction: { minAge: 0 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await service.listProducts(actor)).toHaveLength(0);
      // …but a VALID nested object now succeeds (Build-12 Objective 2):
      // the product and a first-class product-level rule
      // (variant_id NULL, rule_source 'explicit') are inserted in the
      // same transaction — the Build-09 rejection is removed.
      const created = await service.createProduct(actor, {
        name: 'Vape',
        ageRestriction: { minAge: 21 },
      });
      const rules = await service.listAgeRestrictions(actor, { productId: created.id });
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual({
        id: rules[0]?.id,
        variant_id: null,
        product_id: created.id,
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'explicit',
      });
      // Defaults: requiresChallenge25 true, minAge 18.
      const defaulted = await service.createProduct(actor, {
        name: 'Cigarettes',
        ageRestriction: {},
      });
      const defaultRules = await service.listAgeRestrictions(actor, { productId: defaulted.id });
      expect(defaultRules).toHaveLength(1);
      expect(defaultRules[0]?.requires_challenge_25).toBe(true);
      expect(defaultRules[0]?.min_age).toBe(18);
    });
  });

  it('lists the tenant products ordered by name, tenant-scoped', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const service = new CatalogueService(db);
      await service.createProduct(actorFor(tenantA, 'owner'), { name: 'Zebra Tea' });
      await service.createProduct(actorFor(tenantA, 'owner'), { name: 'Apple Juice' });
      await service.createProduct(actorFor(tenantB, 'owner'), { name: 'Other Tenant' });
      const listed = await service.listProducts(actorFor(tenantA, 'owner'));
      expect(listed.map((p) => p.name)).toEqual(['Apple Juice', 'Zebra Tea']);
    } finally {
      await close();
    }
  });

  it('getProduct is 404 for an unknown id and for another tenant product (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const service = new CatalogueService(db);
      const product = await service.createProduct(actorFor(tenantA, 'owner'), { name: 'Tea' });
      await expect(
        service.getProduct(actorFor(tenantA, 'owner'), UNKNOWN_UUID),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.getProduct(actorFor(tenantB, 'owner'), product.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(toProductView(await service.getProduct(actorFor(tenantA, 'owner'), product.id))).toEqual({
        id: product.id,
        category_id: null,
        name: 'Tea',
        description: null,
        is_active: true,
      });
    } finally {
      await close();
    }
  });
});

describe('CatalogueService — age restrictions', () => {
  it('creates a variant-target rule with defaults (true / 18) and the exact view', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const { productId, variantIds } = await seedProductWithVariants(db, tenant, ['V-1']);
      const [row] = await service.createAgeRestriction(actor, { variantId: variantIds[0] as string });
      expect(row).toEqual({
        id: row?.id,
        variant_id: variantIds[0],
        product_id: productId,
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'explicit',
      });
      const listed = await service.listAgeRestrictions(actor, { variantId: variantIds[0] as string });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(row);
    });
  });

  it('upserts: posting the same variant twice replaces the rule instead of 409ing', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const { variantIds } = await seedProductWithVariants(db, tenant, ['V-1']);
      const first = await service.createAgeRestriction(actor, {
        variantId: variantIds[0] as string,
        minAge: 18,
      });
      const second = await service.createAgeRestriction(actor, {
        variantId: variantIds[0] as string,
        requiresChallenge25: false,
        minAge: 21,
      });
      expect(second[0]?.id).toBe(first[0]?.id);
      expect(second[0]?.requires_challenge_25).toBe(false);
      expect(second[0]?.min_age).toBe(21);
      expect(await service.listAgeRestrictions(actor)).toHaveLength(1);
    });
  });

  it('product target stores the product rule and propagates inherited rows to current variants', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const { productId, variantIds } = await seedProductWithVariants(db, tenant, ['V-1', 'V-2']);
      const rows = await service.createAgeRestriction(actor, {
        productId,
        requiresChallenge25: true,
        minAge: 18,
      });
      expect(rows.map((r) => r.variant_id).sort()).toEqual([...variantIds].sort());
      expect(rows.every((r) => r.product_id === productId)).toBe(true);
      expect(rows.every((r) => r.min_age === 18)).toBe(true);
      expect(rows.every((r) => r.rule_source === 'inherited')).toBe(true);
      // Build-11 Objective 2 supersedes Build-10's derived
      // inheritance: the STORED product-level rule governs. The list
      // carries one extra row — the product-level row itself
      // (variant_id NULL, rule_source 'explicit') — so 3 rows total
      // (product + V-1 + V-2).
      const listed = await service.listAgeRestrictions(actor, { productId });
      expect(listed).toHaveLength(3);
      const productRow = listed.find((r) => r.variant_id === null);
      expect(productRow?.rule_source).toBe('explicit');
      expect(productRow?.min_age).toBe(18);
      // A variant added AFTER the product call inherits the stored
      // product-level rule.
      const later = await service.createVariant(actor, {
        productId,
        sku: 'V-3',
        name: 'Variant V-3',
        pricePence: 1000n,
        taxRateId: tenant.taxRates.standard,
      });
      const listedAfter = await service.listAgeRestrictions(actor, { productId });
      expect(listedAfter).toHaveLength(4);
      const laterRow = listedAfter.find((r) => r.variant_id === later.id);
      expect(laterRow?.requires_challenge_25).toBe(true);
      expect(laterRow?.min_age).toBe(18);
      expect(laterRow?.rule_source).toBe('inherited');
    });
  });

  it('product target with no variants now SUCCEEDS (stores the product rule); both/neither target 400s', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, { name: 'Empty Product' });
      // Build-11 Objective 2 supersedes Build-09's 400: a
      // variant-less product CAN carry a product-level rule now.
      const [productRow] = await service.createAgeRestriction(actor, {
        productId: product.id,
        minAge: 21,
      });
      expect(productRow?.variant_id).toBeNull();
      expect(productRow?.product_id).toBe(product.id);
      expect(productRow?.min_age).toBe(21);
      expect(productRow?.rule_source).toBe('explicit');
      // A variant created later inherits the stored rule.
      const later = await service.createVariant(actor, {
        productId: product.id,
        sku: 'LATER-1',
        name: 'Variant LATER-1',
        pricePence: 1000n,
        taxRateId: tenant.taxRates.standard,
      });
      const listed = await service.listAgeRestrictions(actor, { productId: product.id });
      expect(listed).toHaveLength(2);
      const laterRow = listed.find((r) => r.variant_id === later.id);
      expect(laterRow?.min_age).toBe(21);
      expect(laterRow?.rule_source).toBe('inherited');
      const { variantIds } = await seedProductWithVariants(db, tenant, ['V-1']);
      await expect(
        service.createAgeRestriction(actor, {
          productId: product.id,
          variantId: variantIds[0] as string,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createAgeRestriction(actor, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('rejects a non-positive-integer minAge and a non-boolean flag with 400', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const { variantIds } = await seedProductWithVariants(db, tenant, ['V-1']);
      for (const bad of [0, -5, 2.5, '18']) {
        await expect(
          service.createAgeRestriction(actor, {
            variantId: variantIds[0] as string,
            minAge: bad as never,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        service.createAgeRestriction(actor, {
          variantId: variantIds[0] as string,
          requiresChallenge25: 'yes' as never,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await service.listAgeRestrictions(actor)).toHaveLength(0);
    });
  });

  it('is 404 for an unknown or cross-tenant variant/product (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const service = new CatalogueService(db);
      const { productId, variantIds } = await seedProductWithVariants(db, tenantA, ['V-1']);
      await expect(
        service.createAgeRestriction(actorFor(tenantA, 'owner'), { variantId: UNKNOWN_UUID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.createAgeRestriction(actorFor(tenantB, 'owner'), {
          variantId: variantIds[0] as string,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.createAgeRestriction(actorFor(tenantB, 'owner'), { productId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.createAgeRestriction(actorFor(tenantA, 'owner'), { productId: UNKNOWN_UUID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });

  it('listAgeRestrictions filters by variantId and productId and is tenant-scoped', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const service = new CatalogueService(db);
      const first = await seedProductWithVariants(db, tenantA, ['V-1']);
      const second = await seedProductWithVariants(db, tenantA, ['V-2']);
      await seedProductWithVariants(db, tenantB, ['V-9']);
      await service.createAgeRestriction(actorFor(tenantA, 'owner'), {
        variantId: first.variantIds[0] as string,
      });
      await service.createAgeRestriction(actorFor(tenantA, 'owner'), {
        variantId: second.variantIds[0] as string,
        minAge: 21,
      });
      await service.createAgeRestriction(actorFor(tenantB, 'owner'), {
        productId: (await seedProductWithVariants(db, tenantB, ['V-8'])).productId,
      });
      expect(await service.listAgeRestrictions(actorFor(tenantA, 'owner'))).toHaveLength(2);
      const byVariant = await service.listAgeRestrictions(actorFor(tenantA, 'owner'), {
        variantId: second.variantIds[0] as string,
      });
      expect(byVariant).toHaveLength(1);
      expect(byVariant[0]?.min_age).toBe(21);
      const byProduct = await service.listAgeRestrictions(actorFor(tenantA, 'owner'), {
        productId: first.productId,
      });
      expect(byProduct).toHaveLength(1);
      expect(byProduct[0]?.variant_id).toBe(first.variantIds[0]);
    } finally {
      await close();
    }
  });
});

describe('CatalogueService — nested age restriction on variant creation', () => {
  it('creates the restriction row in the same request (defaults true / 18)', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, { name: 'Vape' });
      const variant = await service.createVariant(actor, {
        productId: product.id,
        sku: 'VAPE-1',
        name: 'Vape Liquid',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
        ageRestriction: {},
      });
      const rows = await service.listAgeRestrictions(actor, { variantId: variant.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        id: rows[0]?.id,
        variant_id: variant.id,
        product_id: product.id,
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'explicit',
      });
    });
  });

  it('a bad nested restriction 400s and leaves NO variant row behind (atomicity)', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, { name: 'Vape' });
      await expect(
        service.createVariant(actor, {
          productId: product.id,
          sku: 'VAPE-1',
          name: 'Vape Liquid',
          pricePence: 800n,
          taxRateId: tenant.taxRates.standard,
          ageRestriction: { minAge: 0 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await service.listVariants(actor, { productId: product.id })).toHaveLength(0);
      expect(await service.listAgeRestrictions(actor)).toHaveLength(0);
    });
  });

  it('a variant without a nested restriction creates no row', async () => {
    await withDb(async ({ db, tenant }) => {
      const service = new CatalogueService(db);
      const actor = actorFor(tenant, 'owner');
      const product = await service.createProduct(actor, { name: 'Bread' });
      await service.createVariant(actor, {
        productId: product.id,
        sku: 'BREAD-1',
        name: 'Loaf',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      expect(await service.listAgeRestrictions(actor)).toHaveLength(0);
    });
  });
});

describe('CatalogueController — products + age restrictions (direct construction)', () => {
  it('createProduct/listProducts/getProduct return the wire view', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new CatalogueController(new CatalogueService(db));
      const actor = actorFor(tenant, 'owner');
      const created = await controller.createProduct(reqFor(actor), {
        name: 'Coffee Beans',
        description: 'Case of 12',
      });
      expect(created).toEqual({
        id: created.id,
        category_id: null,
        name: 'Coffee Beans',
        description: 'Case of 12',
        is_active: true,
      });
      const listed = await controller.listProducts(reqFor(actor));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(created.id);
      expect(await controller.getProduct(reqFor(actor), created.id)).toEqual(created);
      await expect(controller.getProduct(reqFor(actor), UNKNOWN_UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('createAgeRestriction/listAgeRestrictions return the wire view (array, always)', async () => {
    await withDb(async ({ db, tenant }) => {
      const controller = new CatalogueController(new CatalogueService(db));
      const actor = actorFor(tenant, 'owner');
      const product = await controller.createProduct(reqFor(actor), { name: 'Vape' });
      const service = new CatalogueService(db);
      const variant = await service.createVariant(actor, {
        productId: product.id,
        sku: 'VAPE-1',
        name: 'Vape Liquid',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
      });
      const created = await controller.createAgeRestriction(reqFor(actor), {
        variantId: variant.id,
        minAge: 18,
      });
      expect(created).toHaveLength(1);
      expect(created[0]).toEqual({
        id: created[0]?.id,
        variant_id: variant.id,
        product_id: product.id,
        requires_challenge_25: true,
        min_age: 18,
        rule_source: 'explicit',
      });
      const listed = await controller.listAgeRestrictions(reqFor(actor), undefined, product.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.variant_id).toBe(variant.id);
    });
  });

  it('toAgeRestrictionView maps the joined row exactly (variant-level and product-level)', () => {
    expect(
      toAgeRestrictionView({
        id: 'r-1',
        variant_id: 'v-1',
        product_id: 'p-1',
        challenge_25: true,
        min_age_years: 18,
        rule_source: 'explicit',
      }),
    ).toEqual({
      id: 'r-1',
      variant_id: 'v-1',
      product_id: 'p-1',
      requires_challenge_25: true,
      min_age: 18,
      rule_source: 'explicit',
    });
    // A product-level row carries variant_id NULL.
    expect(
      toAgeRestrictionView({
        id: 'r-2',
        variant_id: null,
        product_id: 'p-1',
        challenge_25: true,
        min_age_years: 21,
        rule_source: 'explicit',
      }),
    ).toEqual({
      id: 'r-2',
      variant_id: null,
      product_id: 'p-1',
      requires_challenge_25: true,
      min_age: 21,
      rule_source: 'explicit',
    });
  });
});

describe('CatalogueController products + age restrictions — AuthGuard scope checks', () => {
  it('unauthenticated → 401, wrong scope → 403, write key / manager PIN → pass, cashier → 403 on writes', async () => {
    await withDb(async ({ db, tenant }) => {
      const guard = makeGuard(db);
      const createProduct = CatalogueController.prototype.createProduct;
      const listProducts = CatalogueController.prototype.listProducts;
      const getProduct = CatalogueController.prototype.getProduct;
      const createAge = CatalogueController.prototype.createAgeRestriction;
      const listAge = CatalogueController.prototype.listAgeRestrictions;
      for (const handler of [createProduct, listProducts, getProduct, createAge, listAge]) {
        await expect(guard.canActivate(guardContext(handler, {}))).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      const readKey = await makeApiKey(db, tenant.tenantId, ['catalogue:read']);
      await expect(
        guard.canActivate(guardContext(createProduct, { authorization: `Bearer ${readKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guard.canActivate(guardContext(createAge, { authorization: `Bearer ${readKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        await guard.canActivate(guardContext(listProducts, { authorization: `Bearer ${readKey}` })),
      ).toBe(true);
      expect(
        await guard.canActivate(guardContext(listAge, { authorization: `Bearer ${readKey}` })),
      ).toBe(true);
      const writeKey = await makeApiKey(db, tenant.tenantId, ['catalogue:write']);
      // A write-only key passes the write handlers (a scope grants
      // exactly itself — catalogue:write does NOT imply
      // catalogue:read, so the read handlers need a read key).
      for (const handler of [createProduct, createAge]) {
        expect(
          await guard.canActivate(guardContext(handler, { authorization: `Bearer ${writeKey}` })),
        ).toBe(true);
      }
      await expect(
        guard.canActivate(guardContext(listProducts, { authorization: `Bearer ${writeKey}` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // An admin-scope key implies every scope (scopes.ts).
      const adminKey = await makeApiKey(db, tenant.tenantId, ['admin']);
      expect(
        await guard.canActivate(guardContext(createProduct, { authorization: `Bearer ${adminKey}` })),
      ).toBe(true);
      // A manager PIN session carries catalogue:write; a cashier PIN
      // session carries catalogue:read only.
      const sessions = new SessionService(db);
      const manager = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.manager.id,
        pin: '1234',
      });
      expect(
        await guard.canActivate(
          guardContext(createProduct, { authorization: `Bearer ${manager.token}` }),
        ),
      ).toBe(true);
      const cashier = await sessions.login({
        tenantId: tenant.tenantId,
        userId: tenant.users.cashier.id,
        pin: '1234',
      });
      await expect(
        guard.canActivate(
          guardContext(createProduct, { authorization: `Bearer ${cashier.token}` }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        await guard.canActivate(
          guardContext(listProducts, { authorization: `Bearer ${cashier.token}` }),
        ),
      ).toBe(true);
    });
  });

  it('cross-tenant credential → 404, never 403 (G-B)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db);
      const guard = makeGuard(db);
      const keyB = await makeApiKey(db, tenantB.tenantId, ['catalogue:read']);
      await expect(
        guard.canActivate(
          guardContext(CatalogueController.prototype.listProducts, {
            authorization: `Bearer ${keyB}`,
            'x-tenant-id': tenantA.tenantId,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('UuidValidationInterceptor — malformed :id on the new routes', () => {
  function mockContext(params: Record<string, unknown>): ExecutionContext {
    const request = {
      params,
      body: undefined,
      method: 'GET',
      path: '/v1/catalogue/products/not-a-uuid',
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
      getHandler: () => undefined,
      getClass: () => Object,
      getType: () => 'http',
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToRpc: () => undefined,
      switchToWs: () => undefined,
    } as unknown as ExecutionContext;
  }

  const NEXT: CallHandler = { handle: () => of('ok') };

  it('malformed id → 400 INVALID_UUID naming the field; a well-formed UUID passes through', () => {
    const interceptor = new UuidValidationInterceptor();
    let caught: unknown;
    try {
      interceptor.intercept(mockContext({ id: MALFORMED }), NEXT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidUuidException);
    expect((caught as HttpException).getStatus()).toBe(400);
    const res = (caught as HttpException).getResponse() as { error?: Record<string, string> };
    expect(res.error).toMatchObject({ code: 'INVALID_UUID', field: 'id' });
    expect(() => interceptor.intercept(mockContext({ id: randomUUID() }), NEXT)).not.toThrow();
  });
});
