import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CatalogueService, toAgeRestrictionView, toProductView, toTaxRateView } from './catalogue.service';
import { actorFromHeaders } from '../../common/http-actor';
import { AuthGuard, RequireScope } from '../admin/auth.guard';
import { TenantWriteGuard } from '../admin/exit.service';
import type { Actor } from '../../common/actor';
import type { BarcodeMode } from './barcode';
import type { PriceBasketLineInput } from './pricing.service';

interface GuardedRequest {
  actor?: Actor;
}

function requireActor(req: GuardedRequest): Actor {
  if (req.actor === undefined) {
    throw new BadRequestException('Authenticated actor is required');
  }
  return req.actor;
}

/**
 * Catalogue controller (Build-02, Objective 3).
 *
 * Money crosses the JSON boundary as DECIMAL STRINGS — JSON has no
 * bigint, so request bodies carry pence as strings ("1250") and
 * responses return pence as strings. The Actor comes from the demo
 * headers (x-tenant-id, x-user-id, x-location-id, x-roles); see
 * common/http-actor.ts — local/test auth only.
 */
function toPence(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`Field ${field} must be an integer pence amount (decimal string)`);
}

function optionalPence(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return toPence(value, field);
}

function pence(value: bigint): string {
  return value.toString();
}

interface CreateProductBody {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  /**
   * Optional nested age restriction (Build-12 Objective 2): a
   * first-class product-level rule is inserted atomically with the
   * product (migration 018). An invalid nested object 400s before
   * any insert.
   */
  ageRestriction?: { requiresChallenge25?: boolean; minAge?: number } | null;
}

interface CreateAgeRestrictionBody {
  productId?: string | null;
  variantId?: string | null;
  requiresChallenge25?: boolean;
  minAge?: number;
}

interface CreateVariantBody {
  productId: string;
  sku: string;
  barcode?: string | null;
  name: string;
  pricePence: string;
  costPence?: string;
  taxRateId?: string | null;
  isBundle?: boolean;
  /** Optional nested age restriction, created in the same transaction as the variant. */
  ageRestriction?: { requiresChallenge25?: boolean; minAge?: number } | null;
}

interface UpdateVariantBody {
  sku?: string;
  barcode?: string | null;
  pricePence?: string | number;
  costPence?: string | number;
  taxRateId?: string | null;
  status?: string;
}

/**
 * Optional pence field for the PATCH body: like toPence, but a
 * malformed value is a 400 (BadRequestException), not the plain Error
 * the create-variant helpers throw. Only used by updateVariant — the
 * create route keeps its established behaviour.
 */
function optionalPence400(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new BadRequestException(`Field ${field} must be an integer pence amount (decimal string)`);
}

interface PriceBasketLineBody {
  variantId: string;
  quantity: string;
  unitId?: string | null;
  manualDiscountPence?: string;
}

interface PriceBasketBody {
  lines: PriceBasketLineBody[];
  voucherCode?: string;
  basketDiscountPence?: string;
  approvalEventsId?: string | null;
}

interface ParseBarcodeBody {
  code: string;
  requestedMode?: BarcodeMode;
}

@Controller()
export class CatalogueController {
  constructor(private readonly catalogueService: CatalogueService) {}

  @Get('catalogue/status')
  status(): { module: string; status: string } {
    return this.catalogueService.status();
  }

  @UseGuards(TenantWriteGuard)
  @Post('v1/catalogue/variants')
  async createVariant(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: CreateVariantBody,
  ) {
    const actor = actorFromHeaders(headers);
    const variant = await this.catalogueService.createVariant(actor, {
      productId: body.productId,
      sku: body.sku,
      barcode: body.barcode ?? null,
      name: body.name,
      pricePence: toPence(body.pricePence, 'pricePence'),
      costPence: optionalPence(body.costPence, 'costPence'),
      taxRateId: body.taxRateId ?? null,
      isBundle: body.isBundle ?? false,
      // Build-09 Objective 1: optional nested age restriction, created
      // in the same transaction as the variant (validated first — a
      // bad nested object 400s with no variant row left behind).
      ageRestriction: body.ageRestriction ?? null,
    });
    return { ...variant, price_pence: pence(variant.price_pence), cost_pence: pence(variant.cost_pence) };
  }

  /**
   * Update a variant in place (Build-12 Objective 3, closing the
   * G-UI-06 "no variant-update route" gap). Guarded like the other
   * catalogue writes: AuthGuard answers 401 without a credential and
   * 403 without catalogue:write, cross-tenant is 404 (G-B), and the
   * `:id` param is named `id` so the global UuidValidationInterceptor
   * answers 400 INVALID_UUID for malformed ids before the handler
   * runs. Only the fields supplied are updated; `updated_at` is
   * always stamped so /v1/sync/handshake picks the change up.
   * `'barcode' in body` (and the same for taxRateId) preserves an
   * explicit null — clearing a barcode, or the 400 a null tax rate
   * earns — instead of treating null as "absent".
   */
  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('catalogue:write')
  @Patch('v1/catalogue/variants/:id')
  async updateVariant(
    @Req() req: GuardedRequest,
    @Param('id') id: string,
    @Body() body: UpdateVariantBody,
  ) {
    const actor = requireActor(req);
    const variant = await this.catalogueService.updateVariant(actor, id, {
      sku: body.sku,
      barcode: 'barcode' in body ? body.barcode : undefined,
      pricePence: optionalPence400(body.pricePence, 'pricePence'),
      costPence: optionalPence400(body.costPence, 'costPence'),
      taxRateId: 'taxRateId' in body ? body.taxRateId : undefined,
      // Cast: the service validates the value at runtime and 400s
      // anything other than 'active' / 'inactive'.
      status: body.status as 'active' | 'inactive' | undefined,
    });
    return { ...variant, price_pence: pence(variant.price_pence), cost_pence: pence(variant.cost_pence) };
  }

  @Get('v1/catalogue/variants')
  async listVariants(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query('productId') productId?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    const actor = actorFromHeaders(headers);
    const variants = await this.catalogueService.listVariants(actor, { productId, categoryId });
    return variants.map((v) => ({ ...v, price_pence: pence(v.price_pence), cost_pence: pence(v.cost_pence) }));
  }

  /**
   * Tax rates (Build-08 Objective 1). Guarded — unlike the Build-02
   * demo-header catalogue routes above: the AuthGuard answers 401
   * without a credential and 403 without catalogue:read, and
   * cross-tenant is 404 (G-B). The `:id` param is named `id` so the
   * global UuidValidationInterceptor answers 400 INVALID_UUID for
   * malformed ids before the handler runs.
   */
  @UseGuards(AuthGuard)
  @RequireScope('catalogue:read')
  @Get('v1/tax-rates')
  async listTaxRates(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    const rates = await this.catalogueService.listTaxRates(actor);
    return rates.map(toTaxRateView);
  }

  @UseGuards(AuthGuard)
  @RequireScope('catalogue:read')
  @Get('v1/tax-rates/:id')
  async getTaxRate(@Req() req: GuardedRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    const rate = await this.catalogueService.getTaxRate(actor, id);
    return toTaxRateView(rate);
  }

  /**
   * Parent products (Build-09 Objective 1). Mounted under
   * v1/catalogue/* like the variant routes — the commission's
   * shorthand "POST /v1/products" is NOT the real path; the variant
   * precedent (POST v1/catalogue/variants) governs. Guarded like the
   * tax-rates routes: AuthGuard answers 401 without a credential and
   * 403 without the scope, cross-tenant is 404 (G-B), and the `:id`
   * param is named `id` so the global UuidValidationInterceptor
   * answers 400 INVALID_UUID for malformed ids. Writes are
   * TenantWriteGuarded (phase2 pattern): a tenant inside its 30-day
   * exit window is read-only.
   */
  // GUARD ORDER: AuthGuard and TenantWriteGuard share ONE @UseGuards
  // call, AuthGuard first. Two separate @UseGuards decorators stack
  // bottom-up, which puts TenantWriteGuard first — and it answers an
  // unauthenticated write with 400 ("Tenant id is required") before
  // AuthGuard can answer 401. The phase2 controller avoids this with a
  // class-level @UseGuards(AuthGuard); this controller has no class
  // guard, so the order lives in the single call.
  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('catalogue:write')
  @Post('v1/catalogue/products')
  async createProduct(@Req() req: GuardedRequest, @Body() body: CreateProductBody) {
    const actor = requireActor(req);
    const product = await this.catalogueService.createProduct(actor, {
      name: body.name,
      categoryId: body.categoryId ?? null,
      description: body.description ?? null,
      ageRestriction: body.ageRestriction ?? null,
    });
    return toProductView(product);
  }

  @UseGuards(AuthGuard)
  @RequireScope('catalogue:read')
  @Get('v1/catalogue/products')
  async listProducts(@Req() req: GuardedRequest, @Query('categoryId') categoryId?: string) {
    const actor = requireActor(req);
    const products = await this.catalogueService.listProducts(actor, {
      categoryId: categoryId === undefined ? undefined : categoryId,
    });
    return products.map(toProductView);
  }

  @UseGuards(AuthGuard)
  @RequireScope('catalogue:read')
  @Get('v1/catalogue/products/:id')
  async getProduct(@Req() req: GuardedRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    const product = await this.catalogueService.getProduct(actor, id);
    return toProductView(product);
  }

  /**
   * Age restrictions (Build-09 Objective 1; stored product rules
   * Build-11 Objective 2). POST always returns an array: one row
   * for a variant target; for a product target, one row per current
   * variant (after propagation — explicit variant rows are never
   * overwritten) or the single product-level row when the product
   * has no variants yet. Exactly one of productId/variantId must be
   * present (400 otherwise); the target must exist and belong to the
   * tenant (404 otherwise).
   */
  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('catalogue:write')
  @Post('v1/catalogue/age-restrictions')
  async createAgeRestriction(@Req() req: GuardedRequest, @Body() body: CreateAgeRestrictionBody) {
    const actor = requireActor(req);
    return this.catalogueService.createAgeRestriction(actor, {
      productId: body.productId ?? null,
      variantId: body.variantId ?? null,
      requiresChallenge25: body.requiresChallenge25 ?? null,
      minAge: body.minAge ?? null,
    });
  }

  @UseGuards(AuthGuard)
  @RequireScope('catalogue:read')
  @Get('v1/catalogue/age-restrictions')
  async listAgeRestrictions(
    @Req() req: GuardedRequest,
    @Query('variantId') variantId?: string,
    @Query('productId') productId?: string,
  ) {
    const actor = requireActor(req);
    return this.catalogueService.listAgeRestrictions(actor, {
      variantId: variantId === undefined ? undefined : variantId,
      productId: productId === undefined ? undefined : productId,
    });
  }

  /**
   * Delete one age-restriction rule (Build-12 Objective 2). Guarded
   * like the other catalogue writes: AuthGuard answers 401 without
   * a credential and 403 without catalogue:write, cross-tenant is
   * 404 (G-B), and the `:id` param is named `id` so the global
   * UuidValidationInterceptor answers 400 INVALID_UUID for malformed
   * ids before the handler runs. Deleting a product-level rule also
   * removes the 'inherited' variant rows propagated from it, and
   * NEVER an 'explicit' variant override; deleting a variant-level
   * rule removes only that row. The delete is audit-logged
   * (age_restriction.deleted).
   */
  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('catalogue:write')
  @Delete('v1/catalogue/age-restrictions/:id')
  async deleteAgeRestriction(@Req() req: GuardedRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    return this.catalogueService.deleteAgeRestriction(actor, id);
  }

  @Post('v1/catalogue/price-basket')
  async priceBasket(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: PriceBasketBody,
  ) {
    const actor = actorFromHeaders(headers);
    const lines: PriceBasketLineInput[] = body.lines.map((line) => ({
      variantId: line.variantId,
      quantity: toPence(line.quantity, 'quantity'),
      unitId: line.unitId ?? null,
      manualDiscountPence: optionalPence(line.manualDiscountPence, 'manualDiscountPence'),
    }));
    const basket = await this.catalogueService.priceBasket(actor, lines, {
      voucherCode: body.voucherCode,
      basketDiscountPence: optionalPence(body.basketDiscountPence, 'basketDiscountPence'),
      approvalEventsId: body.approvalEventsId ?? null,
    });
    return {
      lines: basket.lines.map((line) => ({
        ...line,
        quantity: pence(line.quantity),
        basePricePence: pence(line.basePricePence),
        priceBookPricePence: line.priceBookPricePence === null ? null : pence(line.priceBookPricePence),
        promotionDiscountPence: pence(line.promotionDiscountPence),
        manualDiscountPence: pence(line.manualDiscountPence),
        finalPricePence: pence(line.finalPricePence),
        lineTotalPence: pence(line.lineTotalPence),
        taxAmountPence: pence(line.taxAmountPence),
        appliedPromotions: line.appliedPromotions.map((p) => ({
          ...p,
          discountPence: pence(p.discountPence),
        })),
      })),
      subtotalPence: pence(basket.subtotalPence),
      discountPence: pence(basket.discountPence),
      taxPence: pence(basket.taxPence),
      totalPence: pence(basket.totalPence),
      voucherPromotionId: basket.voucherPromotionId ?? null,
      voucherDiscountPence:
        basket.voucherDiscountPence === undefined ? null : pence(basket.voucherDiscountPence),
    };
  }

  @Post('v1/catalogue/barcode/parse')
  async parseBarcode(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: ParseBarcodeBody,
  ) {
    const actor = actorFromHeaders(headers);
    const parsed = await this.catalogueService.parseBarcode(actor, body.code, body.requestedMode);
    return {
      sku: parsed.sku,
      pricePence: parsed.pricePence === undefined ? null : pence(parsed.pricePence),
      weightGrams: parsed.weightGrams === undefined ? null : pence(parsed.weightGrams),
    };
  }
}
