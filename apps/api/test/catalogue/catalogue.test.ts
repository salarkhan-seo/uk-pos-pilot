/**
 * Catalogue, barcode and pricing-pipeline tests (Build-02, Objective 3).
 *
 * Each test creates its own PGlite database (createTestDb) and seeds one
 * tenant. PGlite runs on a single connection — no Promise.all concurrency
 * in these tests.
 *
 * The worked-basket expectations below were computed BY HAND (see the
 * comment on that test), not copied from the implementation.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
import type { Actor } from '../../src/common/actor';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { PricingService } from '../../src/modules/catalogue/pricing.service';

function actorFor(tenant: SeededTenant, role: 'owner' | 'admin' | 'manager' | 'cashier'): Actor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
  };
}

function services(db: Kysely<DB>): { catalogue: CatalogueService; pricing: PricingService } {
  const pricing = new PricingService(db);
  return { pricing, catalogue: new CatalogueService(db, pricing) };
}

// -- Barcode check-digit helpers (EAN-13 / UPC-A, same rules as the parser). --
function ean13CheckDigit(firstTwelve: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = Number(firstTwelve[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function upcCheckDigit(firstEleven: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const d = Number(firstEleven[i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

function buildEan13(prefix: string, sku: string, value: string): string {
  const body = `${prefix}${sku}${value}`;
  return `${body}${ean13CheckDigit(body)}`;
}

function buildUpc(sku: string, value: string): string {
  const body = `2${sku}${value}`;
  return `${body}${upcCheckDigit(body)}`;
}

// -- Seed helpers -----------------------------------------------------------

async function seedPromotion(
  db: Kysely<DB>,
  tenant: SeededTenant,
  opts: {
    type: 'percentage' | 'fixed' | 'bogo' | 'multibuy';
    name?: string;
    stackGroup?: string | null;
    conditions: Array<{ type: string; value: Record<string, unknown> }>;
    targets?: Array<{ type: 'category' | 'product' | 'variant' | 'customer_group'; id: string }>;
  },
): Promise<string> {
  const promo = await db
    .insertInto('promotions')
    .values({
      tenant_id: tenant.tenantId,
      name: opts.name ?? `Promo ${opts.type}`,
      type: opts.type,
      status: 'active',
      version: 1,
      stack_group: opts.stackGroup ?? null,
      start_at: new Date(Date.now() - 3600_000),
      end_at: null,
      created_by_user_id: tenant.users.owner.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const condition of opts.conditions) {
    await db
      .insertInto('promotion_conditions')
      .values({ promotion_id: promo.id, condition_type: condition.type, condition_value: condition.value })
      .execute();
  }
  for (const target of opts.targets ?? []) {
    await db
      .insertInto('promotion_targets')
      .values({ promotion_id: promo.id, target_type: target.type, target_id: target.id })
      .execute();
  }
  return promo.id;
}

async function seedPriceBook(
  db: Kysely<DB>,
  tenant: SeededTenant,
  name: string,
  priority: number,
  entries: Array<{ variantId: string; price: bigint }>,
): Promise<string> {
  const book = await db
    .insertInto('price_books')
    .values({
      tenant_id: tenant.tenantId,
      name,
      priority,
      effective_from: new Date(Date.now() - 3600_000),
      effective_to: null,
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const entry of entries) {
    await db
      .insertInto('price_book_entries')
      .values({ price_book_id: book.id, variant_id: entry.variantId, price_pence: entry.price })
      .execute();
  }
  return book.id;
}

async function seedVoucher(
  db: Kysely<DB>,
  tenant: SeededTenant,
  code: string,
  promotionId: string,
  maxUses = 1,
) {
  const codeHash = createHash('sha256').update(code).digest('hex');
  return db
    .insertInto('voucher_codes')
    .values({
      tenant_id: tenant.tenantId,
      code_hash: codeHash,
      code_last4: code.slice(-4),
      promotion_id: promotionId,
      status: 'active',
      max_uses: maxUses,
      uses_count: 0,
      valid_from: new Date(Date.now() - 3600_000),
      valid_to: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function seedOrder(db: Kysely<DB>, tenant: SeededTenant): Promise<string> {
  const order = await db
    .insertInto('orders')
    .values({
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      register_id: null,
      customer_id: null,
      order_number: 1n,
      business_date: '2026-11-13',
      status: 'draft',
      subtotal_pence: 0n,
      discount_pence: 0n,
      tax_pence: 0n,
      total_pence: 0n,
      created_by_user_id: null,
      completed_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return order.id;
}

async function seedVariantDirect(
  db: Kysely<DB>,
  tenant: SeededTenant,
  opts: { sku: string; price: bigint; taxRateId: string; name?: string },
): Promise<{ productId: string; variantId: string }> {
  const product = await db
    .insertInto('products')
    .values({ tenant_id: tenant.tenantId, name: opts.name ?? opts.sku, is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  const variant = await db
    .insertInto('product_variants')
    .values({
      tenant_id: tenant.tenantId,
      product_id: product.id,
      sku: opts.sku,
      barcode: null,
      name: opts.name ?? opts.sku,
      price_pence: opts.price,
      cost_pence: 0n,
      tax_rate_id: opts.taxRateId,
      is_bundle: false,
      is_active: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { productId: product.id, variantId: variant.id };
}

describe('catalogue CRUD', () => {
  it('creates a variant, and rejects a duplicate SKU in the same tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      const product = await catalogue.createProduct(actor, { name: 'Tea' });
      const variant = await catalogue.createVariant(actor, {
        productId: product.id,
        sku: 'TEA-001',
        name: 'Tea 100g',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      expect(variant.sku).toBe('TEA-001');
      expect(variant.price_pence).toBe(500n);
      await expect(
        catalogue.createVariant(actor, {
          productId: product.id,
          sku: 'TEA-001',
          name: 'Tea duplicate',
          pricePence: 600n,
          taxRateId: tenant.taxRates.standard,
        }),
      ).rejects.toThrow(ConflictException);
    } finally {
      await close();
    }
  });

  it('allows the same SKU in a second tenant', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db, { name: 'Tenant A' });
      const tenantB = await seedTenant(db, { name: 'Tenant B' });
      const { catalogue } = services(db);
      const productA = await catalogue.createProduct(actorFor(tenantA, 'admin'), { name: 'Tea' });
      const productB = await catalogue.createProduct(actorFor(tenantB, 'admin'), { name: 'Tea' });
      await catalogue.createVariant(actorFor(tenantA, 'admin'), {
        productId: productA.id,
        sku: 'SHARED-001',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenantA.taxRates.standard,
      });
      const variantB = await catalogue.createVariant(actorFor(tenantB, 'admin'), {
        productId: productB.id,
        sku: 'SHARED-001',
        name: 'Tea',
        pricePence: 700n,
        taxRateId: tenantB.taxRates.standard,
      });
      expect(variantB.sku).toBe('SHARED-001');
      expect(variantB.price_pence).toBe(700n);
    } finally {
      await close();
    }
  });

  it('rejects a variant without a tax rate, and a duplicate barcode', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      const product = await catalogue.createProduct(actor, { name: 'Tea' });
      await expect(
        catalogue.createVariant(actor, {
          productId: product.id,
          sku: 'TEA-NOTAX',
          name: 'Tea',
          pricePence: 500n,
        }),
      ).rejects.toThrow(BadRequestException);
      await catalogue.createVariant(actor, {
        productId: product.id,
        sku: 'TEA-BC1',
        barcode: '5012345678901',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await expect(
        catalogue.createVariant(actor, {
          productId: product.id,
          sku: 'TEA-BC2',
          barcode: '5012345678901',
          name: 'Tea 2',
          pricePence: 500n,
          taxRateId: tenant.taxRates.standard,
        }),
      ).rejects.toThrow(ConflictException);
    } finally {
      await close();
    }
  });

  it('forbids a cashier from changing a price; an admin succeeds', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const product = await catalogue.createProduct(actorFor(tenant, 'admin'), { name: 'Tea' });
      const variant = await catalogue.createVariant(actorFor(tenant, 'admin'), {
        productId: product.id,
        sku: 'TEA-001',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await expect(
        catalogue.updateVariantPrice(actorFor(tenant, 'cashier'), variant.id, 600n),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        catalogue.updateVariantPrice(actorFor(tenant, 'manager'), variant.id, 600n),
      ).rejects.toThrow(ForbiddenException);
      const updated = await catalogue.updateVariantPrice(actorFor(tenant, 'admin'), variant.id, 600n);
      expect(updated.price_pence).toBe(600n);
    } finally {
      await close();
    }
  });

  it('updates only the supplied fields and stamps updated_at (Build-12 Objective 3)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      const product = await catalogue.createProduct(actor, { name: 'Tea' });
      const variant = await catalogue.createVariant(actor, {
        productId: product.id,
        sku: 'TEA-001',
        barcode: '5012345678901',
        name: 'Tea',
        pricePence: 500n,
        costPence: 200n,
        taxRateId: tenant.taxRates.standard,
      });
      const before = variant.updated_at;
      // PGlite timestamps resolve to the millisecond; sleep so the
      // stamp is observably later than the create stamp.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await catalogue.updateVariant(actor, variant.id, {
        pricePence: 650n,
        sku: 'TEA-001B',
      });
      expect(updated.price_pence).toBe(650n);
      expect(updated.sku).toBe('TEA-001B');
      // Unsupplied fields keep their values.
      expect(updated.barcode).toBe('5012345678901');
      expect(updated.cost_pence).toBe(200n);
      expect(updated.tax_rate_id).toBe(tenant.taxRates.standard);
      expect(updated.is_active).toBe(true);
      expect(updated.updated_at.getTime()).toBeGreaterThan(before.getTime());
    } finally {
      await close();
    }
  });

  it('updateVariant: status maps to is_active; barcode clears to null; tax rate must exist', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      const product = await catalogue.createProduct(actor, { name: 'Tea' });
      const variant = await catalogue.createVariant(actor, {
        productId: product.id,
        sku: 'TEA-001',
        barcode: '5012345678901',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      const inactive = await catalogue.updateVariant(actor, variant.id, { status: 'inactive' });
      expect(inactive.is_active).toBe(false);
      const cleared = await catalogue.updateVariant(actor, variant.id, {
        barcode: null,
        status: 'active',
      });
      expect(cleared.barcode).toBeNull();
      expect(cleared.is_active).toBe(true);
      await expect(
        catalogue.updateVariant(actor, variant.id, { status: 'archived' as 'active' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        catalogue.updateVariant(actor, variant.id, { taxRateId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        catalogue.updateVariant(actor, variant.id, { taxRateId: null }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('updateVariant: duplicate SKU/barcode 409; unknown variant 404; cross-tenant 404; empty body 400', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db, { name: 'Tenant A' });
      const tenantB = await seedTenant(db, { name: 'Tenant B' });
      const { catalogue } = services(db);
      const productA = await catalogue.createProduct(actorFor(tenantA, 'admin'), { name: 'Tea' });
      const first = await catalogue.createVariant(actorFor(tenantA, 'admin'), {
        productId: productA.id,
        sku: 'TEA-001',
        barcode: '5012345678901',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenantA.taxRates.standard,
      });
      const second = await catalogue.createVariant(actorFor(tenantA, 'admin'), {
        productId: productA.id,
        sku: 'TEA-002',
        barcode: '5012345678902',
        name: 'Tea 2',
        pricePence: 600n,
        taxRateId: tenantA.taxRates.standard,
      });
      const actorA = actorFor(tenantA, 'admin');
      await expect(catalogue.updateVariant(actorA, second.id, { sku: 'TEA-001' })).rejects.toThrow(
        ConflictException,
      );
      await expect(
        catalogue.updateVariant(actorA, second.id, { barcode: '5012345678901' }),
      ).rejects.toThrow(ConflictException);
      // Re-submitting its OWN barcode is not a conflict.
      const same = await catalogue.updateVariant(actorA, second.id, { barcode: '5012345678902' });
      expect(same.barcode).toBe('5012345678902');
      await expect(
        catalogue.updateVariant(actorA, '00000000-0000-0000-0000-000000000000', { sku: 'X' }),
      ).rejects.toThrow(NotFoundException);
      await expect(catalogue.updateVariant(actorFor(tenantB, 'admin'), first.id, { sku: 'X' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(catalogue.updateVariant(actorA, first.id, {})).rejects.toThrow(BadRequestException);
      await expect(catalogue.updateVariant(actorA, first.id, { pricePence: -1n })).rejects.toThrow(
        BadRequestException,
      );
      await expect(catalogue.updateVariant(actorA, first.id, { costPence: -5n })).rejects.toThrow(
        BadRequestException,
      );
    } finally {
      await close();
    }
  });

  it('updateVariant: a price change needs admin or owner, like updateVariantPrice', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const product = await catalogue.createProduct(actorFor(tenant, 'admin'), { name: 'Tea' });
      const variant = await catalogue.createVariant(actorFor(tenant, 'admin'), {
        productId: product.id,
        sku: 'TEA-001',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await expect(
        catalogue.updateVariant(actorFor(tenant, 'cashier'), variant.id, { pricePence: 600n }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        catalogue.updateVariant(actorFor(tenant, 'manager'), variant.id, { pricePence: 600n }),
      ).rejects.toThrow(ForbiddenException);
      // Non-price fields are not repricing: a manager may correct a SKU.
      const renamed = await catalogue.updateVariant(actorFor(tenant, 'manager'), variant.id, {
        sku: 'TEA-001B',
      });
      expect(renamed.sku).toBe('TEA-001B');
      const repriced = await catalogue.updateVariant(actorFor(tenant, 'admin'), variant.id, {
        pricePence: 600n,
      });
      expect(repriced.price_pence).toBe(600n);
    } finally {
      await close();
    }
  });

  it('updateVariant: an API-key actor (no roles, authorised by scope) may change a price', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const product = await catalogue.createProduct(actorFor(tenant, 'admin'), { name: 'Tea' });
      const variant = await catalogue.createVariant(actorFor(tenant, 'admin'), {
        productId: product.id,
        sku: 'TEA-001',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      // AuthGuard builds an API-key actor with roles: [] — the role
      // check must not forbid it, or no back-office key could ever
      // reprice (the guard already enforced catalogue:write).
      const apiKeyActor: Actor = {
        tenantId: tenant.tenantId,
        userId: 'api-key:test-key-id',
        locationId: tenant.locationId,
        roles: [],
        authKind: 'api-key',
        scopes: ['catalogue:write'],
      };
      const repriced = await catalogue.updateVariant(apiKeyActor, variant.id, { pricePence: 700n });
      expect(repriced.price_pence).toBe(700n);
    } finally {
      await close();
    }
  });

  it('creates a bundle and marks the variant as a bundle', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      const bundleProduct = await catalogue.createProduct(actor, { name: 'Gift set' });
      const bundle = await catalogue.createVariant(actor, {
        productId: bundleProduct.id,
        sku: 'GIFT-001',
        name: 'Gift set',
        pricePence: 2000n,
        taxRateId: tenant.taxRates.standard,
      });
      const compProduct = await catalogue.createProduct(actor, { name: 'Mug' });
      const comp = await catalogue.createVariant(actor, {
        productId: compProduct.id,
        sku: 'MUG-001',
        name: 'Mug',
        pricePence: 800n,
        taxRateId: tenant.taxRates.standard,
      });
      const result = await catalogue.createBundle(actor, bundle.id, [
        { componentVariantId: comp.id, quantity: 2 },
      ]);
      expect(result.is_bundle).toBe(true);
      const components = await db
        .selectFrom('bundle_components')
        .selectAll()
        .where('bundle_variant_id', '=', bundle.id)
        .execute();
      expect(components).toHaveLength(1);
      expect(components[0]?.quantity).toBe(2);
    } finally {
      await close();
    }
  });

  it('rejects a non-integer variant-unit conversion factor', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      const product = await catalogue.createProduct(actor, { name: 'Tea' });
      const variant = await catalogue.createVariant(actor, {
        productId: product.id,
        sku: 'TEA-001',
        name: 'Tea',
        pricePence: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      const unit = await catalogue.createUnitOfMeasure(actor, { name: 'Case', abbreviation: 'CS' });
      await expect(
        catalogue.createVariantUnit(actor, { variantId: variant.id, unitId: unit.id, conversionFactor: 1.5 }),
      ).rejects.toThrow(BadRequestException);
      const created = await catalogue.createVariantUnit(actor, {
        variantId: variant.id,
        unitId: unit.id,
        conversionFactor: 12,
      });
      expect(created.conversion_factor).toBe('12.0000'); // numeric(12,4) scale
    } finally {
      await close();
    }
  });
});

describe('embedded barcodes', () => {
  it('parses EAN-13 price and weight barcodes in the matching mode (UPC-A too)', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      await catalogue.setBarcodeMode(actor, 'price_embedded');
      const priceCode = buildEan13('20', '12345', '00100');
      const parsedPrice = await catalogue.parseBarcode(actor, priceCode);
      expect(parsedPrice.sku).toBe('12345');
      expect(parsedPrice.pricePence).toBe(100n);
      expect(parsedPrice.weightGrams).toBeUndefined();
      const upcCode = buildUpc('12345', '00250');
      const parsedUpc = await catalogue.parseBarcode(actor, upcCode);
      expect(parsedUpc.sku).toBe('12345');
      expect(parsedUpc.pricePence).toBe(250n);
      // Switch the tenant to weight mode and parse a weight barcode.
      await catalogue.setBarcodeMode(actor, 'weight_embedded');
      const weightCode = buildEan13('21', '12345', '00250');
      const parsedWeight = await catalogue.parseBarcode(actor, weightCode);
      expect(parsedWeight.sku).toBe('12345');
      expect(parsedWeight.weightGrams).toBe(250n);
      expect(parsedWeight.pricePence).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('rejects a requested mode different from the tenant mode, a bad check digit, and an unknown prefix', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      const actor = actorFor(tenant, 'admin');
      await catalogue.setBarcodeMode(actor, 'price_embedded');
      const priceCode = buildEan13('20', '12345', '00100');
      await expect(catalogue.parseBarcode(actor, priceCode, 'weight_embedded')).rejects.toThrow(
        BadRequestException,
      );
      const badCheck = `${priceCode.slice(0, 12)}${(Number(priceCode[12]) + 1) % 10}`;
      await expect(catalogue.parseBarcode(actor, badCheck)).rejects.toThrow(BadRequestException);
      const badPrefix = buildEan13('50', '12345', '00100');
      await expect(catalogue.parseBarcode(actor, badPrefix)).rejects.toThrow(BadRequestException);
      const badUpc = `${buildUpc('12345', '00100').slice(0, 11)}${(Number(buildUpc('12345', '00100')[11]) + 1) % 10}`;
      await expect(catalogue.parseBarcode(actor, badUpc)).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });

  it('reports not-found when the tenant has no barcode rule', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue } = services(db);
      await expect(
        catalogue.parseBarcode(actorFor(tenant, 'admin'), buildEan13('20', '12345', '00100')),
      ).rejects.toThrow(NotFoundException);
    } finally {
      await close();
    }
  });
});

describe('pricing pipeline (worked basket)', () => {
  it('prices a mixed basket to the penny through all six steps', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue, pricing } = services(db);
      const manager = actorFor(tenant, 'manager');

      // Variant A: standard-rated 20%, base £10.00, price book £8.00, qty 3, BOGO buy 2 get 1.
      const variantA = await seedVariantDirect(db, tenant, {
        sku: 'A-001',
        price: 1000n,
        taxRateId: tenant.taxRates.standard,
      });
      // Variant B: zero-rated, base £5.00, qty 4, 10% percentage promotion.
      const variantB = await seedVariantDirect(db, tenant, {
        sku: 'B-001',
        price: 500n,
        taxRateId: tenant.taxRates.zero,
      });
      const priceBookId = await seedPriceBook(db, tenant, 'Sale', 10, [
        { variantId: variantA.variantId, price: 800n },
      ]);
      const bogoId = await seedPromotion(db, tenant, {
        type: 'bogo',
        name: 'Buy 2 get 1',
        conditions: [{ type: 'bogo', value: { buyQty: 2, getQty: 1 } }],
        targets: [{ type: 'variant', id: variantA.variantId }],
      });
      const percentId = await seedPromotion(db, tenant, {
        type: 'percentage',
        name: '10% off',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
        targets: [{ type: 'variant', id: variantB.variantId }],
      });
      const voucherPromoId = await seedPromotion(db, tenant, {
        type: 'percentage',
        name: 'Voucher 10%',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      await seedVoucher(db, tenant, 'SAVE10XX', voucherPromoId, 1);

      const basket = await pricing.priceBasket(
        manager,
        [
          { variantId: variantA.variantId, quantity: 3n, manualDiscountPence: 100n },
          { variantId: variantB.variantId, quantity: 4n },
        ],
        { voucherCode: 'SAVE10XX', basketDiscountPence: 200n },
      );

      // Hand-computed expectations:
      // A: 3 × 800 (price book) = 2400; BOGO 1 free × 800 = 800 off → 1600.
      // B: 4 × 500 = 2000; 10% = 200 off → 1800.
      // Voucher 10% of (1600 + 1800) = 340, pro-rata: A 160, B 180 → A 1440, B 1620.
      // Manual 100 on A (manager limit 10% of 1440 = 144, within limit) → A 1340, B 1620.
      // Basket 200 pro-rata on (1340, 1620): A 91, B 109 → A 1249, B 1511.
      // Tax: A 20% of 1249 = round(1249×20/120) = 208; B zero-rated = 0.
      // Subtotal (after price book) 4400; discount 1000 + 340 + 100 + 200 = 1640; total 2760.
      const lineA = basket.lines[0];
      const lineB = basket.lines[1];
      expect(lineA).toBeDefined();
      expect(lineB).toBeDefined();
      expect(lineA?.basePricePence).toBe(1000n);
      expect(lineA?.priceBookId).toBe(priceBookId);
      expect(lineA?.priceBookPricePence).toBe(800n);
      expect(lineA?.promotionDiscountPence).toBe(800n);
      expect(lineA?.appliedPromotions).toEqual([
        { promotionId: bogoId, promotionVersion: 1, discountPence: 800n },
      ]);
      expect(lineA?.manualDiscountPence).toBe(100n);
      expect(lineA?.finalPricePence).toBe(447n); // 1340 / 3 rounded half-up
      expect(lineA?.lineTotalPence).toBe(1249n);
      expect(lineA?.taxRateKind).toBe('standard');
      expect(lineA?.taxRatePercent).toBe('20.00');
      expect(lineA?.taxAmountPence).toBe(208n);

      expect(lineB?.basePricePence).toBe(500n);
      expect(lineB?.priceBookId).toBeNull();
      expect(lineB?.priceBookPricePence).toBeNull();
      expect(lineB?.promotionDiscountPence).toBe(200n);
      expect(lineB?.appliedPromotions).toEqual([
        { promotionId: percentId, promotionVersion: 1, discountPence: 200n },
      ]);
      expect(lineB?.manualDiscountPence).toBe(0n);
      expect(lineB?.finalPricePence).toBe(405n); // 1620 / 4
      expect(lineB?.lineTotalPence).toBe(1511n);
      expect(lineB?.taxRateKind).toBe('zero');
      expect(lineB?.taxAmountPence).toBe(0n);

      expect(basket.subtotalPence).toBe(4400n);
      expect(basket.discountPence).toBe(1640n);
      expect(basket.taxPence).toBe(208n);
      expect(basket.totalPence).toBe(2760n);
      expect(basket.subtotalPence - basket.discountPence).toBe(basket.totalPence);
      expect(basket.voucherPromotionId).toBe(voucherPromoId);
      expect(basket.voucherDiscountPence).toBe(340n);

      // priceBasket validates only: the voucher was NOT consumed.
      const voucherRow = await db
        .selectFrom('voucher_codes')
        .select('uses_count')
        .where('promotion_id', '=', voucherPromoId)
        .executeTakeFirstOrThrow();
      expect(voucherRow.uses_count).toBe(0);
      // CatalogueService.priceBasket delegates to the same pipeline.
      const viaCatalogue = await catalogue.priceBasket(manager, [
        { variantId: variantB.variantId, quantity: 1n },
      ]);
      expect(viaCatalogue.totalPence).toBe(450n); // 500 − 10% = 450
    } finally {
      await close();
    }
  });

  it('BOGO blocks a percentage promotion on the same line unless they share a stack group', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { pricing } = services(db);
      const variant = await seedVariantDirect(db, tenant, {
        sku: 'C-001',
        price: 800n,
        taxRateId: tenant.taxRates.standard,
      });
      await seedPromotion(db, tenant, {
        type: 'bogo',
        name: 'Buy 2 get 1',
        conditions: [{ type: 'bogo', value: { buyQty: 2, getQty: 1 } }],
      });
      const percentId = await seedPromotion(db, tenant, {
        type: 'percentage',
        name: '10% off',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      const basket = await pricing.priceBasket(actorFor(tenant, 'manager'), [
        { variantId: variant.variantId, quantity: 3n },
      ]);
      // BOGO 800 beats/blocks the 10% (240): only the BOGO applies.
      expect(basket.lines[0]?.promotionDiscountPence).toBe(800n);
      expect(basket.lines[0]?.appliedPromotions).toHaveLength(1);
      expect(basket.lines[0]?.lineTotalPence).toBe(1600n);
      expect(percentId).toBeDefined();
    } finally {
      await close();
    }
  });

  it('same stack group sums, different groups take the largest only', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { pricing } = services(db);
      const variant = await seedVariantDirect(db, tenant, {
        sku: 'D-001',
        price: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await seedPromotion(db, tenant, {
        type: 'percentage',
        name: '10% A',
        stackGroup: 'SALE',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      await seedPromotion(db, tenant, {
        type: 'percentage',
        name: '10% B',
        stackGroup: 'SALE',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      const sameGroup = await pricing.priceBasket(actorFor(tenant, 'manager'), [
        { variantId: variant.variantId, quantity: 4n },
      ]);
      // 2000 line total; two 10% promos in one stack group sum to 400.
      expect(sameGroup.lines[0]?.promotionDiscountPence).toBe(400n);
      expect(sameGroup.lines[0]?.appliedPromotions).toHaveLength(2);
      expect(sameGroup.lines[0]?.lineTotalPence).toBe(1600n);
    } finally {
      await close();
    }
    const { db: db2, close: close2 } = await createTestDb();
    try {
      const tenant = await seedTenant(db2);
      const { pricing } = services(db2);
      const variant = await seedVariantDirect(db2, tenant, {
        sku: 'D-002',
        price: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await seedPromotion(db2, tenant, {
        type: 'percentage',
        name: '10% A',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      await seedPromotion(db2, tenant, {
        type: 'percentage',
        name: '10% B',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      const differentGroups = await pricing.priceBasket(actorFor(tenant, 'manager'), [
        { variantId: variant.variantId, quantity: 4n },
      ]);
      // No shared stack group: largest single promotion only (200).
      expect(differentGroups.lines[0]?.promotionDiscountPence).toBe(200n);
      expect(differentGroups.lines[0]?.appliedPromotions).toHaveLength(1);
      expect(differentGroups.lines[0]?.lineTotalPence).toBe(1800n);
    } finally {
      await close2();
    }
  });

  it('applies a multibuy and converts a case unit to base units', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { catalogue, pricing } = services(db);
      const actor = actorFor(tenant, 'admin');
      const variant = await seedVariantDirect(db, tenant, {
        sku: 'E-001',
        price: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await seedPromotion(db, tenant, {
        type: 'multibuy',
        name: '3 for 1200',
        conditions: [{ type: 'multibuy', value: { requiredQty: 3, bundlePricePence: 1200 } }],
      });
      const multi = await pricing.priceBasket(actorFor(tenant, 'manager'), [
        { variantId: variant.variantId, quantity: 3n },
      ]);
      // 3 × 500 = 1500 − 1200 bundle = 300 off.
      expect(multi.lines[0]?.promotionDiscountPence).toBe(300n);
      expect(multi.lines[0]?.lineTotalPence).toBe(1200n);

      // Unit conversion: 1 case of 12 at 100p per base unit = 1200.
      const product = await catalogue.createProduct(actor, { name: 'Tea' });
      const caseVariant = await catalogue.createVariant(actor, {
        productId: product.id,
        sku: 'E-CASE',
        name: 'Tea case',
        pricePence: 100n,
        taxRateId: tenant.taxRates.standard,
      });
      const unit = await catalogue.createUnitOfMeasure(actor, { name: 'Case', abbreviation: 'CS' });
      await catalogue.createVariantUnit(actor, {
        variantId: caseVariant.id,
        unitId: unit.id,
        conversionFactor: 12,
      });
      const cased = await pricing.priceBasket(actorFor(tenant, 'manager'), [
        { variantId: caseVariant.id, quantity: 1n, unitId: unit.id },
      ]);
      expect(cased.lines[0]?.lineTotalPence).toBe(1200n);
      expect(cased.lines[0]?.unitId).toBe(unit.id);
    } finally {
      await close();
    }
  });
});

describe('vouchers', () => {
  it('redeems once; a second order is exhausted, a replay of the same order is not a second redemption', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { pricing } = services(db);
      const actor = actorFor(tenant, 'manager');
      const promoId = await seedPromotion(db, tenant, {
        type: 'percentage',
        name: 'Voucher 10%',
        conditions: [{ type: 'percent', value: { percent: 10 } }],
      });
      await seedVoucher(db, tenant, 'SAVE10XX', promoId, 1);
      const order1 = await seedOrder(db, tenant);

      const first = await db.transaction().execute(async (trx) =>
        pricing.redeemVoucher(actor, trx, {
          orderId: order1,
          voucherCode: 'SAVE10XX',
          userId: tenant.users.manager.id,
        }),
      );
      expect(first.promotionId).toBe(promoId);
      const afterFirst = await db
        .selectFrom('voucher_codes')
        .select('uses_count')
        .where('promotion_id', '=', promoId)
        .executeTakeFirstOrThrow();
      expect(afterFirst.uses_count).toBe(1);

      // A second, different order: the single-use code is exhausted.
      await expect(
        db.transaction().execute(async (trx) =>
          pricing.redeemVoucher(actor, trx, {
            orderId: '00000000-0000-0000-0000-000000000002',
            voucherCode: 'SAVE10XX',
            userId: tenant.users.manager.id,
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      // The caller (sales) records the redemption; a replay for the SAME
      // order returns the recorded discount without incrementing.
      await db
        .insertInto('applied_promotions')
        .values({
          tenant_id: tenant.tenantId,
          order_id: order1,
          order_line_id: null,
          promotion_id: promoId,
          promotion_version: 1,
          discount_pence: 340n,
          applied_by_user_id: tenant.users.manager.id,
          voided: false,
          voided_by_user_id: null,
        })
        .execute();
      const replay = await db.transaction().execute(async (trx) =>
        pricing.redeemVoucher(actor, trx, {
          orderId: order1,
          voucherCode: 'SAVE10XX',
          userId: tenant.users.manager.id,
        }),
      );
      expect(replay.promotionId).toBe(promoId);
      expect(replay.discountPence).toBe(340n);
      const afterReplay = await db
        .selectFrom('voucher_codes')
        .select('uses_count')
        .where('promotion_id', '=', promoId)
        .executeTakeFirstOrThrow();
      expect(afterReplay.uses_count).toBe(1);
    } finally {
      await close();
    }
  });

  it('rejects an unknown voucher code in priceBasket', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { pricing } = services(db);
      const variant = await seedVariantDirect(db, tenant, {
        sku: 'F-001',
        price: 500n,
        taxRateId: tenant.taxRates.standard,
      });
      await expect(
        pricing.priceBasket(actorFor(tenant, 'manager'), [{ variantId: variant.variantId, quantity: 1n }], {
          voucherCode: 'NOPE1234',
        }),
      ).rejects.toThrow(BadRequestException);
    } finally {
      await close();
    }
  });
});

describe('manual discounts and approvals', () => {
  it('rejects a manual discount above the manager limit without approval, accepts it with one', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { pricing } = services(db);
      const manager = actorFor(tenant, 'manager');
      const variant = await seedVariantDirect(db, tenant, {
        sku: 'G-001',
        price: 1000n,
        taxRateId: tenant.taxRates.standard,
      });
      // 500 off a 1000 line is 50% — far above the manager's 10% limit.
      await expect(
        pricing.priceBasket(manager, [{ variantId: variant.variantId, quantity: 1n, manualDiscountPence: 500n }]),
      ).rejects.toThrow(ForbiddenException);

      const approval = await db
        .insertInto('approval_events')
        .values({
          tenant_id: tenant.tenantId,
          order_id: null,
          action: 'discount_above_limit',
          amount_pence: 500n,
          reason: 'Goodwill gesture',
          requested_by_user_id: tenant.users.manager.id,
          approved_by_user_id: tenant.users.admin.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const approved = await pricing.priceBasket(
        manager,
        [{ variantId: variant.variantId, quantity: 1n, manualDiscountPence: 500n }],
        { approvalEventsId: approval.id },
      );
      expect(approved.lines[0]?.lineTotalPence).toBe(500n);
      expect(approved.totalPence).toBe(500n);
    } finally {
      await close();
    }
  });

  it('rejects an approval from the actor themselves', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenant = await seedTenant(db);
      const { pricing } = services(db);
      const manager = actorFor(tenant, 'manager');
      const variant = await seedVariantDirect(db, tenant, {
        sku: 'G-002',
        price: 1000n,
        taxRateId: tenant.taxRates.standard,
      });
      // Self-approval is also rejected by the DB CHECK, so seed it as an
      // admin-approved row and then call as the admin (approver == actor).
      const approval = await db
        .insertInto('approval_events')
        .values({
          tenant_id: tenant.tenantId,
          order_id: null,
          action: 'discount_above_limit',
          amount_pence: 500n,
          reason: 'Test',
          requested_by_user_id: tenant.users.manager.id,
          approved_by_user_id: tenant.users.admin.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const admin = actorFor(tenant, 'admin');
      // Admin limit is 25% of 1000 = 250; 500 exceeds it, and the approval
      // was granted BY the admin themselves.
      await expect(
        pricing.priceBasket(
          admin,
          [{ variantId: variant.variantId, quantity: 1n, manualDiscountPence: 500n }],
          { approvalEventsId: approval.id },
        ),
      ).rejects.toThrow(ForbiddenException);
    } finally {
      await close();
    }
  });
});
