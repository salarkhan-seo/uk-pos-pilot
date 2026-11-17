/**
 * Phase-2 catalogue controller (Build-04 Worker 4; Build-05 entries,
 * show-once vouchers, promotions bulk route).
 *
 * Thin HTTP over Phase2CatalogueService: price books, promotions and
 * voucher codes. Guarded by AuthGuard with the route-table scopes;
 * writes are TenantWriteGuarded. The Actor comes from request.actor
 * (set by the guard) — never from demo headers or the request body.
 * Dates cross the JSON boundary as ISO strings.
 *
 * Build-05: bulk voucher generation returns the plaintext codes
 * exactly once (`issued_codes: [{ id, code, code_last4, expires_at }]`);
 * list endpoints still return code_last4 only, never a full code or
 * a hash. Price-book entries live under /v1/price-books/:id/entries
 * (POST upsert, PUT update-only) and the promotion-scoped bulk route
 * is POST /v1/promotions/:id/vouchers/bulk — both in this file so
 * the integration worker wires one controller family, not two.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  Phase2CatalogueService,
  toVoucherView,
} from './phase2.service';
import { AuthGuard, RequireScope } from '../admin/auth.guard';
import { TenantWriteGuard } from '../admin/exit.service';
import { assertUuid } from '../../common/uuid';
import type { Actor } from '../../common/actor';

interface GuardedRequest {
  actor?: Actor;
}

function requireActor(req: GuardedRequest): Actor {
  if (req.actor === undefined) {
    throw new BadRequestException('Authenticated actor is required');
  }
  return req.actor;
}

function parseLimit(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return parsed;
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value === '') {
    throw new BadRequestException(`${field} must be an ISO date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be an ISO date string`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined || value === null) return value ?? null;
  return parseDate(value, field);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface CreatePriceBookBody {
  name: string;
  priority: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

interface CreatePromotionBody {
  name: string;
  type: string;
  startAt: string;
  endAt?: string | null;
}

interface GenerateVouchersBody {
  promotionId?: string | null;
  count: number;
  maxUses: number;
  validTo?: string | null;
}

@Controller('v1/catalogue')
@UseGuards(AuthGuard)
export class Phase2CatalogueController {
  constructor(private readonly phase2: Phase2CatalogueService) {}

  @RequireScope('catalogue:read')
  @Get('price-books')
  async listPriceBooks(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const books = await this.phase2.listPriceBooks(actor, parseLimit(limitRaw));
    return books.map((book) => ({
      ...book,
      effective_from: iso(book.effective_from),
      effective_to: book.effective_to === null ? null : iso(book.effective_to),
      created_at: iso(book.created_at),
      updated_at: iso(book.updated_at),
    }));
  }

  @RequireScope('catalogue:write')
  @UseGuards(TenantWriteGuard)
  @Post('price-books')
  async createPriceBook(@Req() req: GuardedRequest, @Body() body: CreatePriceBookBody) {
    const actor = requireActor(req);
    const book = await this.phase2.createPriceBook(actor, {
      name: body.name,
      priority: body.priority,
      effectiveFrom: parseDate(body.effectiveFrom, 'effectiveFrom'),
      effectiveTo: optionalDate(body.effectiveTo, 'effectiveTo'),
    });
    return {
      ...book,
      effective_from: iso(book.effective_from),
      effective_to: book.effective_to === null ? null : iso(book.effective_to),
      created_at: iso(book.created_at),
      updated_at: iso(book.updated_at),
    };
  }

  @RequireScope('catalogue:read')
  @Get('promotions')
  async listPromotions(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const promotions = await this.phase2.listPromotions(actor, parseLimit(limitRaw));
    return promotions.map((promotion) => ({
      ...promotion,
      start_at: iso(promotion.start_at),
      end_at: promotion.end_at === null ? null : iso(promotion.end_at),
      created_at: iso(promotion.created_at),
      updated_at: iso(promotion.updated_at),
    }));
  }

  @RequireScope('catalogue:write')
  @UseGuards(TenantWriteGuard)
  @Post('promotions')
  async createPromotion(@Req() req: GuardedRequest, @Body() body: CreatePromotionBody) {
    const actor = requireActor(req);
    const promotion = await this.phase2.createPromotion(actor, {
      name: body.name,
      // The service validates the type against PROMOTION_TYPES.
      type: body.type as Parameters<Phase2CatalogueService['createPromotion']>[1]['type'],
      startAt: parseDate(body.startAt, 'startAt'),
      endAt: optionalDate(body.endAt, 'endAt'),
    });
    return {
      ...promotion,
      start_at: iso(promotion.start_at),
      end_at: promotion.end_at === null ? null : iso(promotion.end_at),
      created_at: iso(promotion.created_at),
      updated_at: iso(promotion.updated_at),
    };
  }

  @RequireScope('catalogue:write')
  @UseGuards(TenantWriteGuard)
  @Post('vouchers/bulk')
  async generateVouchers(
    @Req() req: GuardedRequest,
    @Body() body: GenerateVouchersBody,
  ) {
    const actor = requireActor(req);
    // Build-05 show-once: the plaintext codes are returned exactly
    // once, in this response only. Nothing else returns them.
    const issued = await this.phase2.generateVouchersShowOnce(actor, {
      promotionId: body.promotionId ?? null,
      count: body.count,
      maxUses: body.maxUses,
      validTo: optionalDate(body.validTo, 'validTo'),
    });
    return {
      issued_codes: issued.map((voucher) => ({
        id: voucher.id,
        code: voucher.code,
        code_last4: voucher.code_last4,
        expires_at: voucher.expires_at === null ? null : iso(voucher.expires_at),
      })),
    };
  }

  @RequireScope('catalogue:read')
  @Get('vouchers')
  async listVouchers(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const vouchers = await this.phase2.listVouchers(actor, parseLimit(limitRaw));
    return vouchers.map((voucher) => ({
      ...voucher,
      valid_from: iso(voucher.valid_from),
      valid_to: voucher.valid_to === null ? null : iso(voucher.valid_to),
    }));
  }
}

// Re-exported so tests can assert the wire shape carries no full code.
export { toVoucherView };

function toPence(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new BadRequestException(`Field ${field} must be an integer pence amount (decimal string)`);
}

interface SetPriceBookEntryBody {
  variantId: string;
  pricePence: string;
}

interface UpdatePriceBookEntryBody {
  pricePence: string;
}

/**
 * Price-book entries (Build-05): POST /v1/price-books/:id/entries
 * (upsert) and PUT /v1/price-books/:id/entries/:variantId
 * (update-only, 404 when the entry was never set).
 */
@Controller('v1/price-books')
@UseGuards(AuthGuard)
export class PriceBookEntriesController {
  constructor(private readonly phase2: Phase2CatalogueService) {}

  @RequireScope('catalogue:write')
  @UseGuards(TenantWriteGuard)
  @Post(':id/entries')
  async setPriceBookEntry(
    @Req() req: GuardedRequest,
    @Param('id') priceBookId: string,
    @Body() body: SetPriceBookEntryBody,
  ) {
    const actor = requireActor(req);
    assertUuid(priceBookId, 'priceBookId');
    assertUuid(body.variantId, 'variantId');
    const entry = await this.phase2.setPriceBookEntry(
      actor,
      priceBookId,
      body.variantId,
      toPence(body.pricePence, 'pricePence'),
    );
    return {
      price_book_id: entry.price_book_id,
      variant_id: entry.variant_id,
      price_pence: entry.price_pence.toString(),
    };
  }

  @RequireScope('catalogue:write')
  @UseGuards(TenantWriteGuard)
  @Put(':id/entries/:variantId')
  async updatePriceBookEntry(
    @Req() req: GuardedRequest,
    @Param('id') priceBookId: string,
    @Param('variantId') variantId: string,
    @Body() body: UpdatePriceBookEntryBody,
  ) {
    const actor = requireActor(req);
    assertUuid(priceBookId, 'priceBookId');
    assertUuid(variantId, 'variantId');
    const entry = await this.phase2.updatePriceBookEntry(
      actor,
      priceBookId,
      variantId,
      toPence(body.pricePence, 'pricePence'),
    );
    return {
      price_book_id: entry.price_book_id,
      variant_id: entry.variant_id,
      price_pence: entry.price_pence.toString(),
    };
  }
}

interface GeneratePromotionVouchersBody {
  count: number;
  maxUses: number;
  validTo?: string | null;
}

/**
 * Promotion-scoped bulk vouchers (Build-05):
 * POST /v1/promotions/:id/vouchers/bulk — the same show-once
 * generation as /v1/catalogue/vouchers/bulk, with the promotion id
 * taken from the path. The promotion must belong to this tenant
 * (404 otherwise); the response carries issued_codes once only.
 */
@Controller('v1/promotions')
@UseGuards(AuthGuard)
export class PromotionVouchersController {
  constructor(private readonly phase2: Phase2CatalogueService) {}

  @RequireScope('catalogue:write')
  @UseGuards(TenantWriteGuard)
  @Post(':id/vouchers/bulk')
  async generatePromotionVouchers(
    @Req() req: GuardedRequest,
    @Param('id') promotionId: string,
    @Body() body: GeneratePromotionVouchersBody,
  ) {
    const actor = requireActor(req);
    assertUuid(promotionId, 'promotionId');
    const issued = await this.phase2.generateVouchersShowOnce(actor, {
      promotionId,
      count: body.count,
      maxUses: body.maxUses,
      validTo: optionalDate(body.validTo, 'validTo'),
    });
    return {
      promotion_id: promotionId,
      issued_codes: issued.map((voucher) => ({
        id: voucher.id,
        code: voucher.code,
        code_last4: voucher.code_last4,
        expires_at: voucher.expires_at === null ? null : iso(voucher.expires_at),
      })),
    };
  }
}
