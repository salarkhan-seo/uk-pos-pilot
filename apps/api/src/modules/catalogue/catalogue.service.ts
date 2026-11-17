import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { actorHasRole } from '../../common/actor';
import { AuditService } from '../admin/audit.service';
import { parseBarcode as parseEmbeddedBarcode, type BarcodeMode } from './barcode';
import { PricingService, type PriceBasketLineInput, type PriceBasketOptions, type PricedBasket, type RedeemVoucherInput } from './pricing.service';

/**
 * CatalogueService — categories, products, variants, units, serials,
 * bundles and barcode rules (Build-02, Objective 3).
 *
 * Every method takes the Actor first and an optional transaction last;
 * every query filters tenant_id = actor.tenantId (G-B). A resource that
 * belongs to another tenant is NotFoundException — never 403. A
 * same-tenant caller with the wrong role is ForbiddenException.
 *
 * DESIGN DECISIONS (recorded here, not research facts):
 *  - Variant-unit conversion_factor must be a POSITIVE INTEGER for
 *    base-unit conversion (the schema allows any positive numeric, but
 *    fractional base-unit factors would make stock and pricing inexact —
 *    case-breakdown uses whole units). Non-integer or non-positive
 *    factors are rejected with BadRequestException.
 *  - priceBasket() is a thin delegation to PricingService (the Arch-10
 *    pipeline lives there); this service owns the catalogue writes and
 *    the barcode-rule lookup that gates parsing.
 */

export interface CreateCategoryInput {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
}

export interface CreateProductInput {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  /**
   * Nested age restriction (Build-12 Objective 2): a product-level
   * age_restrictions row (variant_id NULL, rule_source 'explicit')
   * is inserted atomically in the same transaction as the product
   * (migration 018 stores first-class product-level rules, so the
   * Build-09 rejection — "nothing to attach it to" — no longer
   * applies). A variant created under the product afterwards
   * inherits the rule ('inherited') unless it carries an explicit
   * nested ageRestriction of its own.
   */
  ageRestriction?: AgeRestrictionInput | null;
}

/** Result of deleting one age-restriction rule (Build-12 Objective 2). */
export interface DeleteAgeRestrictionResult {
  /** The row that was deleted (product-level or variant-level). */
  deleted_rule: AgeRestrictionView;
  /**
   * Variant-level rows removed WITH a product-level delete: the
   * 'inherited' rows propagated from that product rule. Always []
   * when the deleted row was variant-level. 'explicit' variant
   * overrides are NEVER in this list — they survive a product-rule
   * delete.
   */
  deleted_inherited_rule_ids: string[];
}

/**
 * Age-restriction fields as they arrive on the wire (camelCase, like
 * the sync DTO's requiresChallenge25 / minAge). Both optional:
 * requiresChallenge25 defaults to true (the column default) and
 * minAge defaults to 18 — the UK legal minimum for restricted
 * products, matching the demo seed's vape row. minAge, when present,
 * must be a positive integer.
 */
export interface AgeRestrictionInput {
  requiresChallenge25?: boolean | null;
  minAge?: number | null;
}

/** Normalised age-restriction fields after validation (never null). */
export interface NormalisedAgeRestriction {
  requiresChallenge25: boolean;
  minAge: number;
}

/**
 * Validate a nested/standalone age-restriction object. Returns null
 * when the input is absent (no restriction requested); otherwise the
 * normalised fields. Throws BadRequestException on a non-object, a
 * non-boolean requiresChallenge25, or a minAge that is not a positive
 * integer. Called BEFORE any insert, so a failed nested create leaves
 * no product/variant row behind.
 */
export function validateAgeRestrictionInput(input: unknown): NormalisedAgeRestriction | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('age_restriction must be an object');
  }
  const { requiresChallenge25, minAge } = input as AgeRestrictionInput;
  if (
    requiresChallenge25 !== undefined &&
    requiresChallenge25 !== null &&
    typeof requiresChallenge25 !== 'boolean'
  ) {
    throw new BadRequestException('requires_challenge_25 must be a boolean');
  }
  if (minAge !== undefined && minAge !== null && (!Number.isInteger(minAge) || (minAge as number) <= 0)) {
    throw new BadRequestException('min_age must be a positive integer');
  }
  return {
    requiresChallenge25: requiresChallenge25 ?? true,
    minAge: minAge ?? 18,
  };
}

export interface CreateVariantInput {
  productId: string;
  sku: string;
  barcode?: string | null;
  name: string;
  pricePence: bigint;
  costPence?: bigint;
  /** REQUIRED — a variant without a tax rate cannot be priced. */
  taxRateId?: string | null;
  isBundle?: boolean;
  /**
   * Optional nested age restriction (Build-09 Objective 1): created in
   * the same transaction as the variant, so a failed nested create
   * leaves no variant row behind.
   */
  ageRestriction?: AgeRestrictionInput | null;
}

export interface CreateAgeRestrictionInput {
  productId?: string | null;
  variantId?: string | null;
  requiresChallenge25?: boolean | null;
  minAge?: number | null;
}

/**
 * Fields PATCH /v1/catalogue/variants/:id may change (Build-12
 * Objective 3). Only the fields supplied are updated; absent fields
 * keep their current value. `status` is the API's word for the
 * product_variants table's `is_active` boolean — the table carries no
 * status column, and the admin UI already renders is_active as
 * 'active' / 'inactive'. `taxRateId: null` is rejected: a variant
 * without a tax rate cannot be priced (same rule as createVariant).
 */
export interface UpdateVariantInput {
  sku?: string;
  barcode?: string | null;
  pricePence?: bigint;
  costPence?: bigint;
  taxRateId?: string | null;
  status?: 'active' | 'inactive';
}

/** Wire view for a parent product (snake_case, like VariantView). */
export interface ProductView {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
}

export function toProductView(row: {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
}): ProductView {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
  };
}

/**
 * Wire view for an age-restriction row. Build-11 Objective 2: a row is
 * either product-level (variant_id NULL, product_id set) or
 * variant-level (variant_id set, product_id derived via the join to
 * product_variants); rule_source says whether a variant row was set
 * explicitly by the merchant or propagated from the product rule.
 */
export interface AgeRestrictionView {
  id: string;
  variant_id: string | null;
  product_id: string;
  requires_challenge_25: boolean;
  min_age: number;
  rule_source: 'explicit' | 'inherited';
}

export function toAgeRestrictionView(row: {
  id: string;
  variant_id: string | null;
  product_id: string;
  challenge_25: boolean;
  min_age_years: number;
  rule_source: 'explicit' | 'inherited';
}): AgeRestrictionView {
  return {
    id: row.id,
    variant_id: row.variant_id,
    product_id: row.product_id,
    requires_challenge_25: row.challenge_25,
    min_age: row.min_age_years,
    rule_source: row.rule_source,
  };
}

export interface CreateUnitOfMeasureInput {
  name: string;
  abbreviation: string;
  isBase?: boolean;
}

export interface CreateVariantUnitInput {
  variantId: string;
  unitId: string;
  /** Must be a positive integer (see the design decision above). */
  conversionFactor: number | string;
  isBase?: boolean;
}

export interface CreateSerialNumberInput {
  variantId: string;
  serialNumber: string;
}

export interface BundleComponentInput {
  componentVariantId: string;
  quantity: number;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('duplicate key value violates unique constraint');
}

function isTriggerViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('at most 4 attributes') ||
    message.includes('at most 20 components') ||
    message.includes('cannot contain itself') ||
    message.includes('cannot themselves be bundles')
  );
}

export interface TaxRateView {
  id: string;
  name: string;
  /** Rate in basis points (1/100 of a percent): 20% → 2000. Derived from rate_percent numeric(5,2), exact. */
  rate_bps: number;
  /** kind === 'exempt'. */
  is_exempt: boolean;
  /** kind === 'zero' || kind === 'exempt' — the rate charges no tax. */
  is_default_no_tax: boolean;
}

/**
 * rate_percent is numeric(5,2) — at most two decimal places — so
 * percent × 100 is exact integer arithmetic; no float is involved.
 * "20.00" → 2000, "5.50" → 550, "0" → 0.
 */
export function ratePercentToBps(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid tax rate percent: ${value}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = (match[3] ?? '').padEnd(2, '0').slice(0, 2);
  return sign * (whole * 100 + Number(fraction));
}

/** Map a tax_rates row to the wire view the endpoints return. */
export function toTaxRateView(row: {
  id: string;
  name: string;
  kind: string;
  rate_percent: string;
}): TaxRateView {
  return {
    id: row.id,
    name: row.name,
    rate_bps: ratePercentToBps(row.rate_percent),
    is_exempt: row.kind === 'exempt',
    is_default_no_tax: row.kind === 'zero' || row.kind === 'exempt',
  };
}

@Injectable()
export class CatalogueService {
  private readonly pricing: PricingService;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Optional() pricingService?: PricingService,
    // Build-12 Objective 2: AuditService is @Optional so direct
    // construction in tests (new CatalogueService(db)) still works;
    // Nest injects the real service in production (AdminModule is
    // imported and exports AuditService). When absent, delete calls
    // skip the audit row — same pattern as PurchasingService.
    @Optional() private readonly auditService?: AuditService,
  ) {
    // Nest injects the module's PricingService; direct construction in
    // tests (or by another module) falls back to a service on the same db.
    this.pricing = pricingService ?? new PricingService(db);
  }

  status(): { module: string; status: string } {
    return { module: 'catalogue', status: 'ok' };
  }

  // -- Categories -------------------------------------------------------

  async createCategory(actor: Actor, input: CreateCategoryInput, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = await q
        .selectFrom('categories')
        .select('id')
        .where('id', '=', input.parentId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (parent === undefined) {
        throw new NotFoundException('Resource not found');
      }
    }
    try {
      return await q
        .insertInto('categories')
        .values({
          tenant_id: actor.tenantId,
          parent_id: input.parentId ?? null,
          name: input.name,
          sort_order: input.sortOrder ?? 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A category with this name already exists here');
      }
      throw error;
    }
  }

  async listCategories(actor: Actor, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    return q
      .selectFrom('categories')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('sort_order', 'asc')
      .orderBy('name', 'asc')
      .execute();
  }

  // -- Products ---------------------------------------------------------

  async createProduct(actor: Actor, input: CreateProductInput, trx?: Kysely<DB>) {
    // Validate the nested age restriction BEFORE any write, so a bad
    // nested object 400s with no product row left behind (same rule
    // as createVariant). A VALID nested object is now inserted as a
    // first-class product-level rule in the same transaction
    // (Build-12 Objective 2 — migration 018 stores product-level
    // rules; the Build-09 rejection is removed).
    const ageRestriction = validateAgeRestrictionInput(input.ageRestriction ?? null);
    if (ageRestriction !== null && trx === undefined) {
      // No caller transaction: run product + restriction atomically.
      // (Never call .transaction() on a Transaction — Kysely 0.28
      // throws; see sales.service.ts.)
      return this.db.transaction().execute((t) => this.insertProduct(actor, input, ageRestriction, t));
    }
    return this.insertProduct(actor, input, ageRestriction, trx);
  }

  private async insertProduct(
    actor: Actor,
    input: CreateProductInput,
    ageRestriction: NormalisedAgeRestriction | null,
    trx?: Kysely<DB>,
  ) {
    const q = trx ?? this.db;
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new BadRequestException('Product name is required');
    }
    if (input.categoryId !== undefined && input.categoryId !== null) {
      const category = await q
        .selectFrom('categories')
        .select('id')
        .where('id', '=', input.categoryId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (category === undefined) {
        throw new NotFoundException('Resource not found');
      }
    }
    const product = await q
      .insertInto('products')
      .values({
        tenant_id: actor.tenantId,
        category_id: input.categoryId ?? null,
        name: input.name.trim(),
        description: input.description ?? null,
        is_active: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (ageRestriction !== null) {
      // First-class product-level row (variant_id NULL,
      // rule_source 'explicit') — same transaction as the product
      // insert, so a failure leaves neither row behind. The product
      // has no variants yet, so there is nothing to propagate to;
      // variants created later inherit it (see insertVariant).
      await this.upsertProductAgeRestrictionRow(q, actor.tenantId, product.id, ageRestriction);
    }
    return product;
  }

  /** The tenant's products, ordered by name. */
  async listProducts(actor: Actor, filter: { categoryId?: string } = {}, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    let query = q
      .selectFrom('products')
      .selectAll('products')
      .where('products.tenant_id', '=', actor.tenantId);
    if (filter.categoryId !== undefined) {
      query = query.where('products.category_id', '=', filter.categoryId);
    }
    return query.orderBy('products.name', 'asc').execute();
  }

  /** One product of this tenant. Another tenant's product is 404, never 403 (G-B). */
  async getProduct(actor: Actor, id: string, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    const product = await q
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (product === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return product;
  }

  // -- Variants ---------------------------------------------------------

  async createVariant(actor: Actor, input: CreateVariantInput, trx?: Kysely<DB>) {
    // Validate the nested age restriction BEFORE any write, so a bad
    // nested object 400s with no variant row left behind.
    const ageRestriction = validateAgeRestrictionInput(input.ageRestriction ?? null);
    if (ageRestriction !== null && trx === undefined) {
      // No caller transaction: run variant + restriction atomically.
      // (Never call .transaction() on a Transaction — Kysely 0.28
      // throws; see sales.service.ts.)
      return this.db.transaction().execute((t) => this.insertVariant(actor, input, ageRestriction, t));
    }
    return this.insertVariant(actor, input, ageRestriction, trx);
  }

  private async insertVariant(
    actor: Actor,
    input: CreateVariantInput,
    ageRestriction: NormalisedAgeRestriction | null,
    trx?: Kysely<DB>,
  ) {
    const q = trx ?? this.db;
    if (input.taxRateId === undefined || input.taxRateId === null) {
      throw new BadRequestException('tax_rate_id is required for a variant');
    }
    if (input.pricePence < 0n) {
      throw new BadRequestException('price_pence must not be negative');
    }
    const product = await q
      .selectFrom('products')
      .select('id')
      .where('id', '=', input.productId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (product === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const taxRate = await q
      .selectFrom('tax_rates')
      .select('id')
      .where('id', '=', input.taxRateId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (taxRate === undefined) {
      throw new NotFoundException('Resource not found');
    }
    // Barcode uniqueness is per tenant, checked explicitly — the schema
    // has no unique index on barcode (a barcode may be absent, and the
    // same code must never be attached to two variants of one tenant).
    if (input.barcode !== undefined && input.barcode !== null) {
      const clash = await q
        .selectFrom('product_variants')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('barcode', '=', input.barcode)
        .executeTakeFirst();
      if (clash !== undefined) {
        throw new ConflictException('Barcode already exists for this tenant');
      }
    }
    try {
      const variant = await q
        .insertInto('product_variants')
        .values({
          tenant_id: actor.tenantId,
          product_id: input.productId,
          sku: input.sku,
          barcode: input.barcode ?? null,
          name: input.name,
          price_pence: input.pricePence,
          cost_pence: input.costPence ?? 0n,
          tax_rate_id: input.taxRateId,
          is_bundle: input.isBundle ?? false,
          is_active: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (ageRestriction !== null) {
        await this.upsertAgeRestrictionRow(q, actor.tenantId, variant.id, ageRestriction, 'explicit');
      } else {
        // Build-11 Objective 2: no explicit nested rule — inherit
        // the STORED product-level rule when one exists (the
        // product-level row is the authoritative source of truth;
        // Build-10's derived-uniformity inference is removed). Runs
        // in the same transaction as the variant insert, so a failure
        // leaves neither row behind.
        const productRule = await q
          .selectFrom('age_restrictions')
          .select(['challenge_25', 'min_age_years'])
          .where('tenant_id', '=', actor.tenantId)
          .where('product_id', '=', input.productId)
          .where('variant_id', 'is', null)
          .executeTakeFirst();
        if (productRule !== undefined) {
          await this.upsertAgeRestrictionRow(
            q,
            actor.tenantId,
            variant.id,
            {
              requiresChallenge25: productRule.challenge_25,
              minAge: productRule.min_age_years,
            },
            'inherited',
          );
        }
      }
      return variant;
    } catch (error) {
      // SKU uniqueness is per tenant (UNIQUE (tenant_id, sku)) — the
      // database raises the violation; surface it as a conflict.
      if (isUniqueViolation(error)) {
        throw new ConflictException('SKU already exists for this tenant');
      }
      throw error;
    }
  }

  /** Changing a catalogue price needs admin or owner — a cashier or a manager may not reprice stock. */
  async updateVariantPrice(actor: Actor, variantId: string, pricePence: bigint, trx?: Kysely<DB>) {
    if (!actorHasRole(actor, 'admin') && !actorHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only an admin or owner may change a catalogue price');
    }
    if (pricePence < 0n) {
      throw new BadRequestException('price_pence must not be negative');
    }
    const q = trx ?? this.db;
    const updated = await q
      .updateTable('product_variants')
      // Build-04 Worker 4: stamp updated_at (server time) on every price
      // change. The register handshake delta filters on
      // product_variants.updated_at > since — without this stamp a price
      // change was invisible to the delta and a till could keep selling
      // at the stale price until a full snapshot.
      .set({ price_pence: pricePence, updated_at: new Date() })
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return updated;
  }

  /**
   * Update a variant in place (Build-12 Objective 3, closing the
   * G-UI-06 "no variant-update route" gap). Validation mirrors
   * createVariant: SKU uniqueness is per tenant (409 on conflict),
   * barcode uniqueness is per tenant checked explicitly (409), a
   * supplied taxRateId must reference an existing rate for the
   * tenant (404), and a price change needs admin or owner for a
   * PIN-session actor (same rule as updateVariantPrice — a cashier
   * or manager may not reprice stock; an API-key actor is authorised
   * by its scopes alone and carries no roles). `updated_at` is always stamped (server time), so the
   * register handshake delta (product_variants.updated_at > since)
   * picks the change up — the same stamp updateVariantPrice applies.
   */
  async updateVariant(actor: Actor, variantId: string, input: UpdateVariantInput, trx?: Kysely<DB>) {
    // Price-change rule (same as updateVariantPrice): a cashier or a
    // manager may not reprice stock — but it applies only where roles
    // are meaningful. An API-key actor carries NO roles (AuthGuard
    // builds it with roles: []) and is authorised by its scopes
    // alone (the guard already enforced catalogue:write); applying
    // the role check to it would forbid every API-key price change,
    // including the admin key the back office uses. A PIN-session
    // actor (and a direct/demo caller, which carries no authKind)
    // must be admin or owner to change a price.
    if (
      input.pricePence !== undefined &&
      actor.authKind !== 'api-key' &&
      !actorHasRole(actor, 'admin') &&
      !actorHasRole(actor, 'owner')
    ) {
      throw new ForbiddenException('Only an admin or owner may change a catalogue price');
    }
    if (input.pricePence !== undefined && input.pricePence < 0n) {
      throw new BadRequestException('price_pence must not be negative');
    }
    if (input.costPence !== undefined && input.costPence < 0n) {
      throw new BadRequestException('cost_pence must not be negative');
    }
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'inactive') {
      throw new BadRequestException("status must be 'active' or 'inactive'");
    }
    if (input.taxRateId === null) {
      throw new BadRequestException('tax_rate_id is required for a variant');
    }
    if (input.sku !== undefined && input.sku.trim() === '') {
      throw new BadRequestException('sku must not be empty');
    }
    const hasField =
      input.sku !== undefined ||
      input.barcode !== undefined ||
      input.pricePence !== undefined ||
      input.costPence !== undefined ||
      input.taxRateId !== undefined ||
      input.status !== undefined;
    if (!hasField) {
      throw new BadRequestException('No fields to update');
    }
    const q = trx ?? this.db;
    const existing = await q
      .selectFrom('product_variants')
      .select('id')
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (existing === undefined) {
      throw new NotFoundException('Resource not found');
    }
    if (input.taxRateId !== undefined) {
      const taxRate = await q
        .selectFrom('tax_rates')
        .select('id')
        .where('id', '=', input.taxRateId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (taxRate === undefined) {
        throw new NotFoundException('Resource not found');
      }
    }
    // Barcode uniqueness is per tenant, checked explicitly (same as
    // createVariant) — excluding this variant, so re-submitting its
    // own barcode is not a conflict.
    if (input.barcode !== undefined && input.barcode !== null) {
      const clash = await q
        .selectFrom('product_variants')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('barcode', '=', input.barcode)
        .where('id', '!=', variantId)
        .executeTakeFirst();
      if (clash !== undefined) {
        throw new ConflictException('Barcode already exists for this tenant');
      }
    }
    const set: {
      sku?: string;
      barcode?: string | null;
      price_pence?: bigint;
      cost_pence?: bigint;
      tax_rate_id?: string;
      is_active?: boolean;
      updated_at: Date;
    } = { updated_at: new Date() };
    if (input.sku !== undefined) set.sku = input.sku;
    if (input.barcode !== undefined) set.barcode = input.barcode;
    if (input.pricePence !== undefined) set.price_pence = input.pricePence;
    if (input.costPence !== undefined) set.cost_pence = input.costPence;
    if (input.taxRateId !== undefined) set.tax_rate_id = input.taxRateId;
    if (input.status !== undefined) set.is_active = input.status === 'active';
    try {
      const updated = await q
        .updateTable('product_variants')
        .set(set)
        .where('id', '=', variantId)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw new NotFoundException('Resource not found');
      }
      return updated;
    } catch (error) {
      // SKU uniqueness is per tenant (UNIQUE (tenant_id, sku)) — the
      // database raises the violation; surface it as a conflict.
      if (isUniqueViolation(error)) {
        throw new ConflictException('SKU already exists for this tenant');
      }
      throw error;
    }
  }

  async listVariants(
    actor: Actor,
    filter: { productId?: string; categoryId?: string } = {},
    trx?: Kysely<DB>,
  ) {
    const q = trx ?? this.db;
    let query = q
      .selectFrom('product_variants')
      .selectAll('product_variants')
      .where('product_variants.tenant_id', '=', actor.tenantId);
    if (filter.productId !== undefined) {
      query = query.where('product_variants.product_id', '=', filter.productId);
    }
    if (filter.categoryId !== undefined) {
      query = query
        .innerJoin('products', 'products.id', 'product_variants.product_id')
        .where('products.category_id', '=', filter.categoryId);
    }
    return query.orderBy('product_variants.sku', 'asc').execute();
  }

  async getVariantBySku(actor: Actor, sku: string, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    const variant = await q
      .selectFrom('product_variants')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('sku', '=', sku)
      .executeTakeFirst();
    if (variant === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return variant;
  }

  // -- Age restrictions (Build-09 Objective 1; stored product rules Build-11 Objective 2) --------
  //
  // DESIGN DECISIONS (recorded here, not research facts):
  //  - FIRST-CLASS PRODUCT RULES (Build-11 Objective 2, migration
  //    018): age_restrictions stores a product-level rule directly
  //    (product_id set, variant_id NULL) — even on a variant-less
  //    product. The stored product-level row is the authoritative
  //    source of truth. This SUPERSEDES Build-10 Objective 3's
  //    derived inference (a rule was product-level when EVERY
  //    pre-existing variant carried an IDENTICAL restriction): the
  //    derived inference is REMOVED — a variant-target rule on one
  //    variant no longer makes the next variant inherit anything.
  //  - PROPAGATION: posting a product-target rule upserts the
  //    product-level row ('explicit') and propagates
  //    rule_source = 'inherited' rows to existing variants that do
  //    NOT have an 'explicit' row. An existing 'explicit' row is
  //    NEVER overwritten by a product-level propagation; an existing
  //    'inherited' row IS refreshed from the product rule. A new
  //    variant created under a product with a stored product-level
  //    rule inherits it ('inherited') in the same transaction,
  //    unless an explicit nested ageRestriction is passed
  //    ('explicit' — the merchant's explicit choice wins, even when
  //    it removes the restriction).
  //  - REMOVAL (Build-12 Objective 2): DELETE
  //    /v1/catalogue/age-restrictions/:id removes a rule. Deleting a
  //    PRODUCT-level rule removes the product row AND the 'inherited'
  //    variant rows propagated from it; 'explicit' variant rows are
  //    NEVER removed by a product-rule delete (the merchant's explicit
  //    override survives). Deleting a VARIANT-level rule removes only
  //    that row. Every delete is audit-logged
  //    (age_restriction.deleted) in the same transaction.
  //  - Upsert semantics (set a rule, like setPriceBookEntry): posting
  //    the same target twice replaces its rule instead of 409ing.
  //  - min_age defaults to 18 and requires_challenge_25 to true when
  //    absent (see validateAgeRestrictionInput).
  //  - Constraint set (migration 018): exactly one of product_id /
  //    variant_id is set (CHECK); at most one product-level row per
  //    product and one row per variant (partial unique indexes).
  //    ON CONFLICT upserts carry the matching WHERE predicate or
  //    Postgres cannot infer the partial index.

  /**
   * Upsert one restriction row for a variant (partial unique index
   * uq_age_restrictions_variant). rule_source records whether the
   * merchant set the row explicitly or it was propagated from the
   * product rule.
   */
  private async upsertAgeRestrictionRow(
    q: Kysely<DB>,
    tenantId: string,
    variantId: string,
    restriction: NormalisedAgeRestriction,
    ruleSource: 'explicit' | 'inherited',
  ) {
    return q
      .insertInto('age_restrictions')
      .values({
        tenant_id: tenantId,
        product_id: null,
        variant_id: variantId,
        min_age_years: restriction.minAge,
        challenge_25: restriction.requiresChallenge25,
        rule_source: ruleSource,
      })
      .onConflict((oc) =>
        oc
          .column('variant_id')
          .where('variant_id', 'is not', null)
          .doUpdateSet({
            min_age_years: restriction.minAge,
            challenge_25: restriction.requiresChallenge25,
            rule_source: ruleSource,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Upsert the product-level rule row for a product (partial unique
   * index uq_age_restrictions_product_level). A product-level row is
   * always 'explicit' — it IS the merchant's explicit rule.
   */
  private async upsertProductAgeRestrictionRow(
    q: Kysely<DB>,
    tenantId: string,
    productId: string,
    restriction: NormalisedAgeRestriction,
  ) {
    return q
      .insertInto('age_restrictions')
      .values({
        tenant_id: tenantId,
        product_id: productId,
        variant_id: null,
        min_age_years: restriction.minAge,
        challenge_25: restriction.requiresChallenge25,
        rule_source: 'explicit',
      })
      .onConflict((oc) =>
        oc
          .column('product_id')
          .where('variant_id', 'is', null)
          .doUpdateSet({
            min_age_years: restriction.minAge,
            challenge_25: restriction.requiresChallenge25,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Set a Challenge 25 / minimum-age rule. Exactly one of productId /
   * variantId must be present (both/neither → 400); the referenced
   * product/variant must exist and belong to the tenant (404
   * otherwise). Always returns an array: one row for a variant target;
   * for a product target, one row per current variant (after
   * propagation) — or the single product-level row when the product
   * has no variants yet (Build-11 Objective 2: a variant-less product
   * no longer 400s).
   */
  async createAgeRestriction(actor: Actor, input: CreateAgeRestrictionInput, trx?: Kysely<DB>) {
    const hasProduct = input.productId !== undefined && input.productId !== null;
    const hasVariant = input.variantId !== undefined && input.variantId !== null;
    if (hasProduct === hasVariant) {
      throw new BadRequestException('Exactly one of product_id or variant_id must be provided');
    }
    const normalised = validateAgeRestrictionInput(input);
    if (normalised === null) {
      // Unreachable: input is always an object here; kept for the type.
      throw new BadRequestException('age_restriction is required');
    }
    const q = trx ?? this.db;
    if (hasVariant) {
      const variant = await q
        .selectFrom('product_variants')
        .select(['id', 'product_id'])
        .where('id', '=', input.variantId as string)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (variant === undefined) {
        throw new NotFoundException('Resource not found');
      }
      const row = await this.upsertAgeRestrictionRow(
        q,
        actor.tenantId,
        variant.id,
        normalised,
        'explicit',
      );
      return [toAgeRestrictionView({ ...row, product_id: variant.product_id })];
    }
    const product = await q
      .selectFrom('products')
      .select('id')
      .where('id', '=', input.productId as string)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (product === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const variants = await q
      .selectFrom('product_variants')
      .select(['id', 'product_id'])
      .where('product_id', '=', product.id)
      .where('tenant_id', '=', actor.tenantId)
      .execute();
    const run = async (db: Kysely<DB>): Promise<AgeRestrictionView[]> => {
      // Store the product-level rule first ('explicit' — it IS the
      // merchant's rule), then propagate to existing variants: an
      // 'explicit' variant row is NEVER overwritten; an 'inherited'
      // row IS refreshed from the product rule; a variant with no
      // row gains an 'inherited' row.
      const productRow = await this.upsertProductAgeRestrictionRow(
        db,
        actor.tenantId,
        product.id,
        normalised,
      );
      if (variants.length === 0) {
        return [toAgeRestrictionView({ ...productRow, product_id: product.id })];
      }
      const existing = await db
        .selectFrom('age_restrictions')
        .select(['variant_id', 'rule_source'])
        .where('tenant_id', '=', actor.tenantId)
        .where(
          'variant_id',
          'in',
          variants.map((v) => v.id),
        )
        .execute();
      const byVariant = new Map(
        existing.map((r) => [r.variant_id as string, r.rule_source]),
      );
      // Views are emitted in variant order. Variants whose explicit
      // row was left untouched are re-read (their row is unchanged,
      // but the response still carries one row per current variant,
      // as before).
      const views: AgeRestrictionView[] = [];
      for (const variant of variants) {
        if (byVariant.get(variant.id) === 'explicit') {
          const row = await db
            .selectFrom('age_restrictions')
            .selectAll()
            .where('tenant_id', '=', actor.tenantId)
            .where('variant_id', '=', variant.id)
            .executeTakeFirstOrThrow();
          views.push(toAgeRestrictionView({ ...row, product_id: variant.product_id }));
          continue;
        }
        const row = await this.upsertAgeRestrictionRow(
          db,
          actor.tenantId,
          variant.id,
          normalised,
          'inherited',
        );
        views.push(toAgeRestrictionView({ ...row, product_id: variant.product_id }));
      }
      return views;
    };
    if (trx !== undefined) return run(trx);
    return this.db.transaction().execute((t) => run(t));
  }

  /**
   * The tenant's age-restriction rows, optionally filtered by variant
   * or product. Build-11 Objective 2: product-level rows (variant_id
   * NULL) are included — a ?productId= filter matches the
   * product-level row's own product_id OR a variant row's product
   * (via the LEFT JOIN to product_variants).
   */
  async listAgeRestrictions(
    actor: Actor,
    filter: { variantId?: string; productId?: string } = {},
    trx?: Kysely<DB>,
  ): Promise<AgeRestrictionView[]> {
    const q = trx ?? this.db;
    let query = q
      .selectFrom('age_restrictions')
      .leftJoin('product_variants', 'product_variants.id', 'age_restrictions.variant_id')
      .select([
        'age_restrictions.id as id',
        'age_restrictions.variant_id as variant_id',
        'age_restrictions.product_id as restriction_product_id',
        'product_variants.product_id as variant_product_id',
        'age_restrictions.challenge_25 as challenge_25',
        'age_restrictions.min_age_years as min_age_years',
        'age_restrictions.rule_source as rule_source',
      ])
      .where('age_restrictions.tenant_id', '=', actor.tenantId);
    if (filter.variantId !== undefined) {
      query = query.where('age_restrictions.variant_id', '=', filter.variantId);
    }
    if (filter.productId !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb('age_restrictions.product_id', '=', filter.productId as string),
          eb('product_variants.product_id', '=', filter.productId as string),
        ]),
      );
    }
    const rows = await query
      .orderBy('age_restrictions.created_at', 'asc')
      .orderBy('age_restrictions.id', 'asc')
      .execute();
    return rows.map((row) =>
      toAgeRestrictionView({
        id: row.id,
        variant_id: row.variant_id,
        product_id: row.restriction_product_id ?? (row.variant_product_id as string),
        challenge_25: row.challenge_25,
        min_age_years: row.min_age_years,
        rule_source: row.rule_source,
      }),
    );
  }

  /**
   * Delete one age-restriction rule (Build-12 Objective 2).
   *
   * Unknown id, or a row belonging to another tenant, is 404 (G-B —
   * never 403). The delete runs in a single transaction, and the
   * audit row (age_restriction.deleted) commits or rolls back with
   * it when an AuditService is available.
   *
   *  - Variant-level row: only that row is removed.
   *  - Product-level row: the product row AND every 'inherited'
   *    variant row propagated from it are removed. 'explicit'
   *    variant rows are NEVER removed — the merchant's explicit
   *    override survives a product-rule delete, so the variant keeps
   *    enforcing its own rule afterwards.
   */
  async deleteAgeRestriction(
    actor: Actor,
    id: string,
    trx?: Kysely<DB>,
  ): Promise<DeleteAgeRestrictionResult> {
    const run = async (db: Kysely<DB>): Promise<DeleteAgeRestrictionResult> => {
      const row = await db
        .selectFrom('age_restrictions')
        .selectAll()
        .where('id', '=', id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (row === undefined) {
        throw new NotFoundException('Resource not found');
      }
      // The view carries the product id: stored on a product-level
      // row, derived via the variant on a variant-level row (the
      // column is NULL there — same shape as createAgeRestriction's
      // variant branch).
      let productIdForView: string;
      if (row.variant_id === null) {
        productIdForView = row.product_id as string;
      } else {
        const variant = await db
          .selectFrom('product_variants')
          .select('product_id')
          .where('id', '=', row.variant_id)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirstOrThrow();
        productIdForView = variant.product_id;
      }
      const deletedInheritedRuleIds: string[] = [];
      if (row.variant_id === null) {
        // Product-level rule: find the 'inherited' variant rows
        // propagated from it (variants of this product whose row
        // was NOT set explicitly by the merchant) and remove them
        // with the product row. Explicit overrides survive.
        const inherited = await db
          .selectFrom('age_restrictions')
          .innerJoin('product_variants', 'product_variants.id', 'age_restrictions.variant_id')
          .select('age_restrictions.id as id')
          .where('age_restrictions.tenant_id', '=', actor.tenantId)
          .where('product_variants.product_id', '=', row.product_id as string)
          .where('age_restrictions.rule_source', '=', 'inherited')
          .execute();
        deletedInheritedRuleIds.push(...inherited.map((r) => r.id));
        if (deletedInheritedRuleIds.length > 0) {
          await db
            .deleteFrom('age_restrictions')
            .where('id', 'in', deletedInheritedRuleIds)
            .where('tenant_id', '=', actor.tenantId)
            .execute();
        }
      }
      await db
        .deleteFrom('age_restrictions')
        .where('id', '=', row.id)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
      if (this.auditService !== undefined) {
        await this.auditService.record(db, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'age_restriction.deleted',
          entityType: 'age_restriction',
          entityId: row.id,
          payload: {
            productId: productIdForView,
            variantId: row.variant_id,
            ruleSource: row.rule_source,
            minAge: String(row.min_age_years),
            requiresChallenge25: String(row.challenge_25),
            deletedInheritedRuleIds,
          },
        });
      }
      return {
        deleted_rule: toAgeRestrictionView({
          id: row.id,
          variant_id: row.variant_id,
          product_id: productIdForView,
          challenge_25: row.challenge_25,
          min_age_years: row.min_age_years,
          rule_source: row.rule_source,
        }),
        deleted_inherited_rule_ids: deletedInheritedRuleIds,
      };
    };
    if (trx !== undefined) return run(trx);
    return this.db.transaction().execute((t) => run(t));
  }

  // -- Tax rates (Build-08 Objective 1) ---------------------------------

  /**
   * List the tenant's ACTIVE tax rates, ordered by name — the picker a
   * variant-creation form needs. Superseded/inactive rates (a rate
   * change is a new row; the old row stays for history) are excluded:
   * a new variant must never be created against a dead rate.
   */
  async listTaxRates(actor: Actor, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    return q
      .selectFrom('tax_rates')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('is_active', '=', true)
      .orderBy('name', 'asc')
      .execute();
  }

  /**
   * One tax rate of this tenant, in any active state (a variant that
   * already references a superseded rate must still be inspectable).
   * Another tenant's rate is 404, never 403 (G-B).
   */
  async getTaxRate(actor: Actor, id: string, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    const rate = await q
      .selectFrom('tax_rates')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (rate === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return rate;
  }

  // -- Units of measure ---------------------------------------------------

  async createUnitOfMeasure(actor: Actor, input: CreateUnitOfMeasureInput, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    try {
      return await q
        .insertInto('units_of_measure')
        .values({
          tenant_id: actor.tenantId,
          name: input.name,
          abbreviation: input.abbreviation,
          is_base: input.isBase ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A unit with this abbreviation already exists for this tenant');
      }
      throw error;
    }
  }

  async createVariantUnit(actor: Actor, input: CreateVariantUnitInput, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    const factor =
      typeof input.conversionFactor === 'string'
        ? Number(input.conversionFactor)
        : input.conversionFactor;
    if (!Number.isInteger(factor) || factor <= 0) {
      throw new BadRequestException('conversion_factor must be a positive integer');
    }
    const variant = await q
      .selectFrom('product_variants')
      .select('id')
      .where('id', '=', input.variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (variant === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const unit = await q
      .selectFrom('units_of_measure')
      .select('id')
      .where('id', '=', input.unitId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (unit === undefined) {
      throw new NotFoundException('Resource not found');
    }
    try {
      return await q
        .insertInto('variant_units')
        .values({
          variant_id: input.variantId,
          unit_id: input.unitId,
          conversion_factor: String(Math.trunc(factor)),
          is_base: input.isBase ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('This variant already has this unit');
      }
      throw error;
    }
  }

  // -- Serial numbers -----------------------------------------------------

  async createSerialNumber(actor: Actor, input: CreateSerialNumberInput, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    const variant = await q
      .selectFrom('product_variants')
      .select('id')
      .where('id', '=', input.variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (variant === undefined) {
      throw new NotFoundException('Resource not found');
    }
    try {
      return await q
        .insertInto('serial_numbers')
        .values({
          tenant_id: actor.tenantId,
          variant_id: input.variantId,
          serial_number: input.serialNumber,
          status: 'in_stock',
          order_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Serial number already exists for this tenant');
      }
      throw error;
    }
  }

  // -- Bundles ------------------------------------------------------------

  async createBundle(
    actor: Actor,
    variantId: string,
    components: BundleComponentInput[],
    trx?: Kysely<DB>,
  ) {
    const q = trx ?? this.db;
    const bundle = await q
      .selectFrom('product_variants')
      .select('id')
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (bundle === undefined) {
      throw new NotFoundException('Resource not found');
    }
    for (const component of components) {
      const componentVariant = await q
        .selectFrom('product_variants')
        .select('id')
        .where('id', '=', component.componentVariantId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (componentVariant === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (component.quantity <= 0 || !Number.isInteger(component.quantity)) {
        throw new BadRequestException('Bundle component quantity must be a positive integer');
      }
    }
    await q
      .updateTable('product_variants')
      .set({ is_bundle: true })
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .execute();
    try {
      for (const component of components) {
        await q
          .insertInto('bundle_components')
          .values({
            bundle_variant_id: variantId,
            component_variant_id: component.componentVariantId,
            quantity: component.quantity,
          })
          .execute();
      }
    } catch (error) {
      // The DB trigger enforces max 20 components, no nesting and no
      // self-reference — surface its message as a bad request.
      if (isTriggerViolation(error)) {
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    return q
      .selectFrom('product_variants')
      .selectAll()
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirstOrThrow();
  }

  // -- Barcode rules & parsing --------------------------------------------

  /** Admin/owner only. Upserts the tenant's single barcode_rules row. */
  async setBarcodeMode(actor: Actor, mode: BarcodeMode, trx?: Kysely<DB>) {
    if (!actorHasRole(actor, 'admin') && !actorHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only an admin or owner may set the barcode mode');
    }
    const q = trx ?? this.db;
    return q
      .insertInto('barcode_rules')
      .values({ tenant_id: actor.tenantId, mode, sku_length: 5, price_digits: 5 })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ mode }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Parse an embedded barcode with the tenant's active mode. A tenant
   * with no barcode_rules row has no active mode (404). A requested mode
   * that differs from the tenant's mode is rejected — a code is never
   * silently reinterpreted in the wrong mode.
   */
  async parseBarcode(actor: Actor, code: string, requestedMode?: BarcodeMode, trx?: Kysely<DB>) {
    const q = trx ?? this.db;
    const rule = await q
      .selectFrom('barcode_rules')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (rule === undefined) {
      throw new NotFoundException('No barcode rule configured for this tenant');
    }
    if (requestedMode !== undefined && requestedMode !== rule.mode) {
      throw new BadRequestException('Barcode parsed in the wrong mode');
    }
    return parseEmbeddedBarcode(code, rule.mode);
  }

  // -- Pricing (delegates to PricingService) -------------------------------

  async priceBasket(
    actor: Actor,
    lines: PriceBasketLineInput[],
    opts: PriceBasketOptions = {},
    trx?: Kysely<DB>,
  ): Promise<PricedBasket> {
    return this.pricing.priceBasket(actor, lines, opts, trx);
  }

  /** Delegates to PricingService — the sales module redeems through the catalogue service. */
  async redeemVoucher(
    actor: Actor,
    trx: Kysely<DB>,
    input: RedeemVoucherInput,
  ): Promise<{ promotionId: string; discountPence: bigint }> {
    return this.pricing.redeemVoucher(actor, trx, input);
  }
}
