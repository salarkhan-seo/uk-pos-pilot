/**
 * Catalogue, Price Books & Promotions Studio (Build-04 Objective 2).
 *
 * The studio is a thin view-controller layer over the typed API client:
 * it validates forms client-side (see validation.ts), then delegates
 * every decision to the server. In particular the basket preview is
 * computed ONLY through POST /v1/catalogue/price-basket — the Arch-10
 * pipeline order (base → price book → automatic promotions → voucher →
 * manual → D-14/D-13) lives in PricingService and is NEVER reimplemented
 * here (D-AW-04). The preview controller only shapes the request and
 * renders the server's priced lines.
 *
 * Voucher display (D-AW-06, Build-05 show-once): bulk generation
 * returns the plaintext codes exactly once (`GenerateVouchersResult`,
 * for one-time display only — the studio never stores or logs them);
 * every later read goes through `sanitiseVoucherViews`, which strips
 * anything that is not `code_last4` + usage metrics. The API stores
 * code_hash + code_last4 only, and the dashboard treats any `code` /
 * `code_hash` / `full_code` field in a READ payload as a leak to be
 * dropped and reported, never rendered.
 */
import type { AdminApiClient } from '../api/client';
import type {
  AgeRestrictionInput,
  AgeRestrictionView,
  CreateAgeRestrictionInput,
  CreateProductInput,
  CreateVariantInput,
  GenerateVouchersResult,
  PriceBasketInput,
  PriceBasketView,
  PriceBookView,
  ProductView,
  PromotionView,
  TaxRateView,
  UpdateVariantInput,
  VariantView,
  VoucherView,
} from '../api/types';
import { validateAttributes, validateBundleComponents, type BundleComponentInput, type VariantAttribute } from './validation';

export interface VariantForm {
  productId: string;
  sku: string;
  barcode?: string | null;
  name: string;
  pricePence: string;
  costPence?: string;
  taxRateId?: string | null;
  isBundle?: boolean;
  /** Optional nested age restriction, created with the variant. */
  ageRestriction?: AgeRestrictionInput | null;
  attributes: VariantAttribute[];
  bundleComponents: BundleComponentInput[];
}

export interface VariantFormResult {
  ok: boolean;
  errors: string[];
  variant?: VariantView;
}

/**
 * Variant-update form (Build-12 Objective 3) — mirrors
 * PATCH /v1/catalogue/variants/:id. Every field is optional; only
 * the fields supplied are updated. `status` maps to the variant's
 * `is_active` boolean; `barcode: null` clears the barcode.
 */
export interface VariantUpdateForm {
  sku?: string;
  barcode?: string | null;
  pricePence?: string;
  costPence?: string;
  taxRateId?: string | null;
  status?: 'active' | 'inactive';
}

export interface ProductForm {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  /** Optional nested age restriction, created with the product (Build-12 Objective 2). */
  ageRestriction?: AgeRestrictionInput | null;
}

export interface ProductFormResult {
  ok: boolean;
  errors: string[];
  product?: ProductView;
}

export interface BasketPreviewResult {
  basket: PriceBasketView;
  /** Human-readable pipeline trace, in Arch-10 order, from the server's priced lines. */
  trace: string[];
}

const FORBIDDEN_VOUCHER_KEYS = ['code', 'full_code', 'code_hash', 'plain_code', 'secret'] as const;

/** Drop any full-code material from a voucher payload; report what was dropped. */
export function sanitiseVoucherViews(raw: Array<Record<string, unknown>>): { vouchers: VoucherView[]; droppedKeys: string[] } {
  const droppedKeys = new Set<string>();
  const vouchers: VoucherView[] = raw.map((row) => {
    for (const key of FORBIDDEN_VOUCHER_KEYS) {
      if (key in row) {
        droppedKeys.add(key);
      }
    }
    const { id, code_last4, promotion_id, status, max_uses, uses_count, valid_from, valid_to } = row as unknown as VoucherView;
    if (typeof code_last4 !== 'string' || code_last4.length !== 4) {
      throw new Error('Voucher view must carry exactly code_last4 (4 characters); full codes are never displayed.');
    }
    return { id, code_last4, promotion_id, status, max_uses, uses_count, valid_from, valid_to };
  });
  return { vouchers, droppedKeys: [...droppedKeys] };
}

export class CatalogueStudio {
  constructor(private readonly api: AdminApiClient) {}

  async listVariants(productId?: string): Promise<VariantView[]> {
    return this.api.listVariants(productId === undefined ? {} : { productId });
  }

  /** Parent products (Build-09 Objective 1). */
  async listProducts(): Promise<ProductView[]> {
    return this.api.listProducts();
  }

  /** Validate client-side, then create via the API (server is authoritative). */
  async createProduct(form: ProductForm): Promise<ProductFormResult> {
    const errors: string[] = [];
    if (form.name.trim() === '') {
      errors.push('Product name is required.');
    }
    if (
      form.ageRestriction !== undefined &&
      form.ageRestriction !== null &&
      form.ageRestriction.minAge !== undefined &&
      form.ageRestriction.minAge !== null &&
      (!Number.isInteger(form.ageRestriction.minAge) || form.ageRestriction.minAge <= 0)
    ) {
      errors.push('Minimum age must be a positive integer.');
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const input: CreateProductInput = {
      name: form.name,
      categoryId: form.categoryId ?? null,
      description: form.description ?? null,
      // Build-12 Objective 2: optional nested age restriction, created
      // atomically with the product as a first-class product-level rule.
      ageRestriction: form.ageRestriction ?? null,
    };
    const product = await this.api.createProduct(input);
    return { ok: true, errors: [], product };
  }

  /** Age-restriction rules (Build-09 Objective 1). */
  async createAgeRestriction(input: CreateAgeRestrictionInput): Promise<AgeRestrictionView[]> {
    return this.api.createAgeRestriction(input);
  }

  async listAgeRestrictions(filters?: {
    variantId?: string;
    productId?: string;
  }): Promise<AgeRestrictionView[]> {
    return this.api.listAgeRestrictions(filters ?? {});
  }

  /**
   * Delete one age-restriction rule (Build-12 Objective 2). A
   * product-level delete also removes the 'inherited' variant rows
   * propagated from it, never an 'explicit' override; a variant-level
   * delete removes only that row (server-enforced).
   */
  async deleteAgeRestriction(id: string): Promise<{ deletedRuleId: string; deletedInheritedRuleIds: string[] }> {
    const result = await this.api.deleteAgeRestriction(id);
    return {
      deletedRuleId: result.deleted_rule.id,
      deletedInheritedRuleIds: result.deleted_inherited_rule_ids,
    };
  }

  /** Active tax rates for the variant-creation picker (Build-08 Objective 1). */
  async listTaxRates(): Promise<TaxRateView[]> {
    return this.api.listTaxRates();
  }

  /** Validate client-side, then create via the API (server is authoritative). */
  async createVariant(form: VariantForm): Promise<VariantFormResult> {
    const errors = [
      ...validateAttributes(form.attributes),
      ...(form.isBundle === true ? validateBundleComponents(form.bundleComponents, form.sku) : []),
    ];
    if (form.sku.trim() === '') {
      errors.push('SKU is required.');
    }
    if (form.name.trim() === '') {
      errors.push('Variant name is required.');
    }
    if (!/^\d+$/.test(form.pricePence.trim())) {
      errors.push('Price must be an integer number of pence (decimal string).');
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const input: CreateVariantInput = {
      productId: form.productId,
      sku: form.sku,
      barcode: form.barcode ?? null,
      name: form.name,
      pricePence: form.pricePence,
      costPence: form.costPence,
      taxRateId: form.taxRateId ?? null,
      isBundle: form.isBundle ?? false,
      // Build-09 Objective 1: optional nested age restriction, created
      // in the same transaction as the variant.
      ageRestriction: form.ageRestriction ?? null,
    };
    const variant = await this.api.createVariant(input);
    return { ok: true, errors: [], variant };
  }

  /**
   * Update a variant in place (Build-12 Objective 3). Client-side
   * validation mirrors the server's: at least one field, a supplied
   * SKU non-empty, supplied pence integer strings, status
   * active/inactive. The server remains authoritative (409 on a
   * SKU/barcode clash, 404 on an unknown tax rate or variant).
   */
  async updateVariant(id: string, form: VariantUpdateForm): Promise<VariantFormResult> {
    const errors: string[] = [];
    const hasAnyField =
      form.sku !== undefined ||
      form.barcode !== undefined ||
      form.pricePence !== undefined ||
      form.costPence !== undefined ||
      form.taxRateId !== undefined ||
      form.status !== undefined;
    if (!hasAnyField) {
      errors.push('At least one field to update is required.');
    }
    if (form.sku !== undefined && form.sku.trim() === '') {
      errors.push('SKU is required.');
    }
    if (form.pricePence !== undefined && !/^\d+$/.test(form.pricePence.trim())) {
      errors.push('Price must be an integer number of pence (decimal string).');
    }
    if (form.costPence !== undefined && !/^\d+$/.test(form.costPence.trim())) {
      errors.push('Cost must be an integer number of pence (decimal string).');
    }
    if (form.status !== undefined && form.status !== 'active' && form.status !== 'inactive') {
      errors.push("Status must be 'active' or 'inactive'.");
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const input: UpdateVariantInput = {};
    if (form.sku !== undefined) input.sku = form.sku;
    if (form.barcode !== undefined) input.barcode = form.barcode;
    if (form.pricePence !== undefined) input.pricePence = form.pricePence;
    if (form.costPence !== undefined) input.costPence = form.costPence;
    if (form.taxRateId !== undefined) input.taxRateId = form.taxRateId;
    if (form.status !== undefined) input.status = form.status;
    const variant = await this.api.updateVariant(id, input);
    return { ok: true, errors: [], variant };
  }

  /**
   * Basket preview — delegates entirely to the server pricing pipeline.
   * The dashboard sends lines (+ optional voucher / basket discount /
   * approval id) and renders what the server returns; it never computes
   * a price, a promotion or a tax amount itself.
   */
  async previewBasket(input: PriceBasketInput): Promise<BasketPreviewResult> {
    const basket = await this.api.priceBasket(input);
    const trace = basket.lines.map(
      (line) =>
        `variant ${line.variantId} × ${line.quantity}: base ${line.basePricePence}p` +
        (line.priceBookPricePence !== null ? ` → price book ${line.priceBookPricePence}p` : '') +
        ` → promotions −${line.promotionDiscountPence}p → manual −${line.manualDiscountPence}p → final ${line.finalPricePence}p (line total ${line.lineTotalPence}p, tax ${line.taxAmountPence}p)`,
    );
    trace.push(`subtotal ${basket.subtotalPence}p − discounts ${basket.discountPence}p + tax ${basket.taxPence}p = total ${basket.totalPence}p`);
    return { basket, trace };
  }

  async listPriceBooks(): Promise<PriceBookView[]> {
    return this.api.listPriceBooks();
  }

  async createPriceBook(input: { name: string; priority: number; effectiveFrom: string; effectiveTo?: string | null }): Promise<PriceBookView> {
    if (input.name.trim() === '') {
      throw new Error('Price book name is required.');
    }
    if (!Number.isInteger(input.priority) || input.priority < 0) {
      throw new Error('Price book priority must be a non-negative integer (highest priority wins).');
    }
    return this.api.createPriceBook(input);
  }

  async listPromotions(): Promise<PromotionView[]> {
    return this.api.listPromotions();
  }

  async createPromotion(input: { name: string; type: PromotionView['type']; startAt: string; endAt?: string | null }): Promise<PromotionView> {
    if (input.name.trim() === '') {
      throw new Error('Promotion name is required.');
    }
    return this.api.createPromotion(input);
  }

  /**
   * Bulk voucher generation (Build-05 show-once): returns the plaintext
   * codes exactly once, for one-time display. The caller must display
   * them and never store or log them; every later read returns masked
   * VoucherView rows (code_last4 only) via listVouchers.
   */
  async generateVouchers(input: { promotionId: string | null; count: number; maxUses: number; validTo?: string | null }): Promise<GenerateVouchersResult> {
    if (!Number.isInteger(input.count) || input.count <= 0 || input.count > 1000) {
      throw new Error('Voucher count must be an integer between 1 and 1000.');
    }
    return this.api.generateVouchers(input);
  }

  async listVouchers(): Promise<VoucherView[]> {
    const vouchers = await this.api.listVouchers();
    const { vouchers: clean } = sanitiseVoucherViews(vouchers as unknown as Array<Record<string, unknown>>);
    return clean;
  }
}
