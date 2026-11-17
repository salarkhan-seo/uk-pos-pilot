import { describe, expect, it } from 'vitest';
import { FakeAdminApiClient } from '../src/api/fake-client';
import { CatalogueStudio, sanitiseVoucherViews } from '../src/catalogue/studio';
import { MAX_ATTRIBUTES_PER_VARIANT, MAX_BUNDLE_COMPONENTS, validateAttributes, validateBundleComponents, validateVariantUnits } from '../src/catalogue/validation';

function variantForm(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'prod-1',
    sku: 'SKU-1',
    name: 'Tea',
    pricePence: '250',
    attributes: [],
    bundleComponents: [],
    ...overrides,
  };
}

describe('catalogue validation — server limits mirrored client-side', () => {
  it('rejects a 5th attribute (max 4)', () => {
    const attrs = Array.from({ length: 5 }, (_, i) => ({ name: `attr-${i}`, value: 'x' }));
    const errors = validateAttributes(attrs);
    expect(errors.join(' ')).toContain(`at most ${MAX_ATTRIBUTES_PER_VARIANT}`);
    expect(validateAttributes(attrs.slice(0, 4))).toEqual([]);
  });

  it('rejects duplicate attribute names', () => {
    expect(validateAttributes([{ name: 'Size', value: 'S' }, { name: 'size', value: 'M' }]).length).toBeGreaterThan(0);
  });

  it('rejects a 21st bundle component (max 20) and a bundle containing itself', () => {
    const components = Array.from({ length: 21 }, (_, i) => ({ variantId: `v-${i}`, quantity: 1 }));
    const errors = validateBundleComponents(components, 'bundle-1');
    expect(errors.join(' ')).toContain(`at most ${MAX_BUNDLE_COMPONENTS}`);
    expect(validateBundleComponents([{ variantId: 'bundle-1', quantity: 1 }], 'bundle-1').join(' ')).toContain('cannot contain itself');
    expect(validateBundleComponents(Array.from({ length: 20 }, (_, i) => ({ variantId: `v-${i}`, quantity: 1 })), 'bundle-1')).toEqual([]);
  });

  it('requires exactly one base unit with conversion factor 1 (case-breakdown)', () => {
    expect(validateVariantUnits([{ unitId: 'each', conversionFactor: 1, isBaseUnit: true }, { unitId: 'case', conversionFactor: 12, isBaseUnit: false }])).toEqual([]);
    expect(validateVariantUnits([{ unitId: 'each', conversionFactor: 1, isBaseUnit: true }, { unitId: 'case', conversionFactor: 1, isBaseUnit: true }]).length).toBeGreaterThan(0);
    expect(validateVariantUnits([{ unitId: 'case', conversionFactor: 12, isBaseUnit: false }]).join(' ')).toContain('Exactly one base unit');
    expect(validateVariantUnits([{ unitId: 'each', conversionFactor: 2, isBaseUnit: true }]).join(' ')).toContain('conversion factor 1');
  });
});

describe('catalogue studio', () => {
  it('client-side validation failure never calls the API', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const result = await studio.createVariant(
      variantForm({ attributes: Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, value: 'x' })) }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(fake.callsFor('catalogue.createVariant')).toHaveLength(0);
  });

  it('a valid variant is created through the API', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const result = await studio.createVariant(variantForm());
    expect(result.ok).toBe(true);
    expect(result.variant?.sku).toBe('SKU-1');
    expect(fake.callsFor('catalogue.createVariant')).toHaveLength(1);
  });

  it('basket preview goes through POST /v1/catalogue/price-basket and never prices locally', async () => {
    const fake = new FakeAdminApiClient({
      variants: [{ id: 'v-1', product_id: 'p', sku: 'SKU-1', barcode: null, name: 'Tea', price_pence: '250', cost_pence: '100', tax_rate_id: null, is_bundle: false, is_active: true }],
    });
    const studio = new CatalogueStudio(fake);
    const { basket, trace } = await studio.previewBasket({ lines: [{ variantId: 'v-1', quantity: '2' }] });
    expect(fake.callsFor('catalogue.priceBasket')).toHaveLength(1);
    expect(fake.callsFor('catalogue.priceBasket')[0]?.path).toBe('/v1/catalogue/price-basket');
    expect(basket.totalPence).toBe('500');
    expect(trace[0]).toContain('base 250p');
    expect(trace.at(-1)).toContain('total 500p');
  });

  it('voucher generation returns plaintext codes exactly once (show-once); later reads are masked', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const result = await studio.generateVouchers({ promotionId: 'promo-1', count: 3, maxUses: 1 });
    expect(result.promotionId).toBe('promo-1');
    expect(result.issuedCodes).toHaveLength(3);
    for (const issued of result.issuedCodes) {
      expect(typeof issued.code).toBe('string');
      expect(issued.code.length).toBeGreaterThan(4);
      expect(issued.code_last4).toBe(issued.code.slice(-4));
      expect(issued.code_last4).toMatch(/^[A-Za-z0-9]{4}$/);
    }
    // A later read must never expose a full code.
    const listed = await studio.listVouchers();
    expect(listed).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toMatch(/"code":/);
    for (const voucher of listed) {
      expect(Object.keys(voucher).sort()).toEqual(['code_last4', 'id', 'max_uses', 'promotion_id', 'status', 'uses_count', 'valid_from', 'valid_to']);
      expect(voucher.code_last4).toMatch(/^[A-Za-z0-9]{4}$/);
      expect(voucher.uses_count).toBe(0);
      expect(voucher.max_uses).toBe(1);
    }
  });

  it('sanitiseVoucherViews drops full-code fields and reports them, and rejects a view without code_last4', () => {
    const { vouchers, droppedKeys } = sanitiseVoucherViews([
      { id: 'v-1', code_last4: '4821', code: 'VOUCHER-FULL-CODE', code_hash: 'abc', promotion_id: null, status: 'active', max_uses: 1, uses_count: 0, valid_from: '2026-11-13', valid_to: null },
    ]);
    expect(vouchers[0]?.code_last4).toBe('4821');
    expect(droppedKeys.sort()).toEqual(['code', 'code_hash']);
    expect('code' in (vouchers[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(() =>
      sanitiseVoucherViews([{ id: 'v-2', promotion_id: null, status: 'active', max_uses: 1, uses_count: 0, valid_from: '2026-11-13', valid_to: null }]),
    ).toThrow('code_last4');
  });

  it('bulk voucher count is bounded client-side (1–1000)', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    await expect(studio.generateVouchers({ promotionId: null, count: 0, maxUses: 1 })).rejects.toThrow('between 1 and 1000');
    await expect(studio.generateVouchers({ promotionId: null, count: 1001, maxUses: 1 })).rejects.toThrow('between 1 and 1000');
    expect(fake.callsFor('catalogue.generateVouchers')).toHaveLength(0);
  });
});

describe('catalogue studio — nested age restriction + rule deletion (Build-12 Objective 2)', () => {
  it('creating a product with a nested age restriction stores a product-level rule; a later variant inherits it', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const created = await studio.createProduct({
      name: 'Vape Liquid',
      ageRestriction: { requiresChallenge25: true, minAge: 21 },
    });
    expect(created.ok).toBe(true);
    const productId = created.product?.id as string;
    const rules = await studio.listAgeRestrictions({ productId });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.variant_id).toBeNull();
    expect(rules[0]?.rule_source).toBe('explicit');
    expect(rules[0]?.min_age).toBe(21);
    const variant = await studio.createVariant(
      variantForm({ productId, sku: 'VAPE-1', pricePence: '800', taxRateId: 'tr-1' }),
    );
    expect(variant.ok).toBe(true);
    const after = await studio.listAgeRestrictions({ productId });
    expect(after).toHaveLength(2);
    const inherited = after.find((r) => r.variant_id === variant.variant?.id);
    expect(inherited?.rule_source).toBe('inherited');
    expect(inherited?.min_age).toBe(21);
  });

  it('a bad nested minAge fails client-side validation and never calls the API', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const result = await studio.createProduct({
      name: 'Vape Liquid',
      ageRestriction: { minAge: 0 },
    });
    expect(result.ok).toBe(false);
    expect(fake.callsFor('catalogue.createProduct')).toHaveLength(0);
  });

  it('deleting a product-level rule removes it + inherited rows but preserves an explicit override', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const created = await studio.createProduct({
      name: 'Vape Liquid',
      ageRestriction: { minAge: 21 },
    });
    const productId = created.product?.id as string;
    const variantA = await studio.createVariant(
      variantForm({ productId, sku: 'VAPE-A', pricePence: '800', taxRateId: 'tr-1' }),
    );
    const variantB = await studio.createVariant(
      variantForm({
        productId,
        sku: 'VAPE-B',
        pricePence: '800',
        taxRateId: 'tr-1',
        ageRestriction: { minAge: 18 },
      }),
    );
    expect(variantA.ok).toBe(true);
    expect(variantB.ok).toBe(true);
    const before = await studio.listAgeRestrictions({ productId });
    expect(before).toHaveLength(3);
    const productRule = before.find((r) => r.variant_id === null) as { id: string };
    const deleted = await studio.deleteAgeRestriction(productRule.id);
    expect(deleted.deletedRuleId).toBe(productRule.id);
    expect(deleted.deletedInheritedRuleIds).toHaveLength(1);
    const after = await studio.listAgeRestrictions({ productId });
    expect(after).toHaveLength(1);
    expect(after[0]?.variant_id).toBe(variantB.variant?.id);
    expect(after[0]?.min_age).toBe(18);
    expect(after[0]?.rule_source).toBe('explicit');
  });

  it('deleting a variant-level rule removes only that row; an unknown id throws', async () => {
    const fake = new FakeAdminApiClient();
    const studio = new CatalogueStudio(fake);
    const created = await studio.createProduct({ name: 'Vape Liquid' });
    const productId = created.product?.id as string;
    await studio.createVariant(variantForm({ productId, sku: 'VAPE-1', pricePence: '800' }));
    await studio.createVariant(variantForm({ productId, sku: 'VAPE-2', pricePence: '800' }));
    const rows = await studio.createAgeRestriction({ productId, minAge: 21 });
    expect(rows).toHaveLength(2);
    const deleted = await studio.deleteAgeRestriction(rows[0]?.id as string);
    expect(deleted.deletedInheritedRuleIds).toEqual([]);
    const remaining = await studio.listAgeRestrictions({ productId });
    expect(remaining).toHaveLength(2);
    await expect(studio.deleteAgeRestriction('no-such-rule')).rejects.toThrow('Resource not found');
  });
});

describe('catalogue studio — updateVariant (Build-12 Objective 3)', () => {
  function seededStudio() {
    const fake = new FakeAdminApiClient({
      variants: [
        { id: 'v-1', product_id: 'p', sku: 'SKU-1', barcode: '5012345678900', name: 'Tea', price_pence: '250', cost_pence: '100', tax_rate_id: 'tax-standard', is_bundle: false, is_active: true },
        { id: 'v-2', product_id: 'p', sku: 'SKU-2', barcode: null, name: 'Coffee', price_pence: '400', cost_pence: '150', tax_rate_id: 'tax-standard', is_bundle: false, is_active: true },
      ],
    });
    return { fake, studio: new CatalogueStudio(fake) };
  }

  it('updates only the supplied fields and leaves the rest unchanged', async () => {
    const { studio } = seededStudio();
    const result = await studio.updateVariant('v-1', { pricePence: '300', sku: 'SKU-1B' });
    expect(result.ok).toBe(true);
    expect(result.variant?.price_pence).toBe('300');
    expect(result.variant?.sku).toBe('SKU-1B');
    expect(result.variant?.barcode).toBe('5012345678900');
    expect(result.variant?.cost_pence).toBe('100');
    expect(result.variant?.tax_rate_id).toBe('tax-standard');
    expect(result.variant?.is_active).toBe(true);
  });

  it('status flips is_active; barcode null clears the barcode', async () => {
    const { studio } = seededStudio();
    const deactivated = await studio.updateVariant('v-1', { status: 'inactive' });
    expect(deactivated.variant?.is_active).toBe(false);
    const cleared = await studio.updateVariant('v-1', { barcode: null });
    expect(cleared.variant?.barcode).toBeNull();
  });

  it('an empty update and a non-integer price fail client-side without touching the variant', async () => {
    const { fake, studio } = seededStudio();
    const empty = await studio.updateVariant('v-1', {});
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(' ')).toContain('At least one field');
    const badPrice = await studio.updateVariant('v-1', { pricePence: '12.5' });
    expect(badPrice.ok).toBe(false);
    expect(badPrice.errors.join(' ')).toContain('Price must be an integer');
    const variants = await studio.listVariants();
    expect(variants.find((v) => v.id === 'v-1')?.price_pence).toBe('250');
    expect(fake.callsFor('catalogue.updateVariant')).toHaveLength(0);
  });

  it('a SKU clash with another variant and an unknown variant throw', async () => {
    const { studio } = seededStudio();
    await expect(studio.updateVariant('v-1', { sku: 'SKU-2' })).rejects.toThrow('already exists');
    await expect(studio.updateVariant('no-such-variant', { pricePence: '300' })).rejects.toThrow('Resource not found');
  });

  it('an unknown tax rate throws', async () => {
    const { studio } = seededStudio();
    await expect(studio.updateVariant('v-1', { taxRateId: 'no-such-rate' })).rejects.toThrow('Resource not found');
  });
});
