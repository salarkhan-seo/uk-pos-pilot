/**
 * Phase2CatalogueService — price books, promotions and voucher codes
 * (Build-04 Worker 4; Arch-10 §§2–4, Arch-01 §3.4).
 *
 * These are the Phase-2 catalogue tables that had schema (migration 008)
 * and a pricing pipeline (PricingService) but no service or controller
 * in Build-02/03. Every method takes the Actor first; every query
 * filters tenant_id = actor.tenantId (G-B — a resource that belongs to
 * another tenant is NotFoundException, never 403).
 *
 * DESIGN DECISIONS set here (not research facts):
 *  - List pagination: `limit` defaults to 50, clamped to 1..100.
 *    No offset/cursor yet — the dashboard lists are small; add a cursor
 *    when a list grows past a page.
 *  - Voucher bulk generation: `count` must be 1..1000 per call (the same
 *    cap the admin-web fake client enforces). Codes are 16 characters
 *    from an unambiguous alphabet (no 0/O, 1/I/L), rendered as four
 *    groups of four joined with dashes (e.g. ABCD-EFGH-JKLM-NPQR).
 *    Only the SHA-256 hash + last-4 are stored (Arch-01: the full code
 *    is never stored). Build-05 show-once: the bulk-generate response
 *    returns the plaintext codes exactly once at creation
 *    (`issued_codes: [{ id, code, code_last4, expires_at }]`) via
 *    generateVouchersShowOnce; every later read returns code_last4
 *    only (VoucherView). The Build-04 "full codes are never returned"
 *    contract is superseded by the commission for the creation
 *    response only — reads still never expose a code or a hash.
 *  - New price books and promotions are created as 'draft' with
 *    version 1; there is no activate route in this worker's scope.
 *  - A voucher bulk-generate with a promotionId must reference an
 *    existing promotion of this tenant (404 otherwise); a null
 *    promotionId creates unlinked codes.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { userIdAsUuid } from '../../common/uuid';
import type { Kysely, Selectable } from 'kysely';
import type {
  DB,
  PriceBookEntriesTable,
  PriceBooksTable,
  PromotionsTable,
  VoucherCodesTable,
} from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';

/** Default page size for Phase-2 list endpoints. */
export const PHASE2_DEFAULT_LIMIT = 50;
/** Hard cap for any Phase-2 list endpoint. */
export const PHASE2_MAX_LIMIT = 100;
/** Bulk voucher generation cap per call (matches the admin-web fake). */
export const VOUCHER_BULK_MAX_COUNT = 1000;

export type PriceBookRow = Selectable<PriceBooksTable>;
export type PromotionRow = Selectable<PromotionsTable>;
export type VoucherRow = Selectable<VoucherCodesTable>;

/** Voucher as returned over HTTP: code_last4 only, never the full code or its hash. */
export interface VoucherView {
  id: string;
  code_last4: string;
  promotion_id: string | null;
  status: 'active' | 'redeemed' | 'void' | 'expired';
  max_uses: number;
  uses_count: number;
  valid_from: Date;
  valid_to: Date | null;
}

/**
 * A voucher issued at creation time (Build-05 show-once): the
 * plaintext code is returned EXACTLY ONCE, in this object only.
 * Only code_hash + code_last4 are stored; there is no way to recover
 * the code afterwards — every later read returns VoucherView.
 */
export interface IssuedVoucher {
  id: string;
  /** Plaintext code, shown once at creation. Never stored, never returned again. */
  code: string;
  code_last4: string;
  expires_at: Date | null;
}

export type PriceBookEntryRow = Selectable<PriceBookEntriesTable>;

export interface CreatePriceBookInput {
  name: string;
  priority: number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
}

export interface CreatePromotionInput {
  name: string;
  type: PromotionsTable['type'];
  startAt: Date;
  endAt?: Date | null;
}

export interface GenerateVouchersInput {
  promotionId: string | null;
  count: number;
  maxUses: number;
  validTo?: Date | null;
}

export const PROMOTION_TYPES: ReadonlyArray<PromotionsTable['type']> = [
  'percentage',
  'fixed',
  'bogo',
  'multibuy',
  'bundle',
  'loyalty_bonus',
  'staff',
];

/** Unambiguous alphabet for voucher codes (no 0/O, 1/I/L). */
const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return PHASE2_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), PHASE2_MAX_LIMIT);
}

function generateVoucherCode(): string {
  const bytes = randomBytes(16);
  let raw = '';
  for (const byte of bytes) {
    raw += VOUCHER_ALPHABET[(byte as number) % VOUCHER_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function toVoucherView(row: VoucherRow): VoucherView {
  return {
    id: row.id,
    code_last4: row.code_last4,
    promotion_id: row.promotion_id,
    status: row.status,
    max_uses: row.max_uses,
    uses_count: row.uses_count,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
  };
}

@Injectable()
export class Phase2CatalogueService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async listPriceBooks(actor: Actor, limit?: number): Promise<PriceBookRow[]> {
    return this.db
      .selectFrom('price_books')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('priority', 'asc')
      .orderBy('created_at', 'asc')
      .limit(clampLimit(limit))
      .execute();
  }

  async createPriceBook(actor: Actor, input: CreatePriceBookInput): Promise<PriceBookRow> {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new BadRequestException('Price book name is required');
    }
    if (!Number.isInteger(input.priority) || input.priority < 0) {
      throw new BadRequestException('priority must be a non-negative integer');
    }
    if (!(input.effectiveFrom instanceof Date) || Number.isNaN(input.effectiveFrom.getTime())) {
      throw new BadRequestException('effectiveFrom must be a valid date');
    }
    if (
      input.effectiveTo !== undefined &&
      input.effectiveTo !== null &&
      (!(input.effectiveTo instanceof Date) || Number.isNaN(input.effectiveTo.getTime()))
    ) {
      throw new BadRequestException('effectiveTo must be a valid date or null');
    }
    if (input.effectiveTo !== undefined && input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom) {
      throw new BadRequestException('effectiveTo must be on or after effectiveFrom');
    }
    return this.db
      .insertInto('price_books')
      .values({
        tenant_id: actor.tenantId,
        name: input.name.trim(),
        priority: input.priority,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        status: 'draft',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Set (create or replace) a price-book entry (Build-05): POST
   * /v1/price-books/:id/entries. The price book and the variant must
   * both belong to this tenant (404 otherwise); price_pence must be
   * non-negative. Upsert on (price_book_id, variant_id) — the entry
   * is the price book's price for that variant, so re-setting it
   * replaces the old price rather than duplicating the row.
   */
  async setPriceBookEntry(
    actor: Actor,
    priceBookId: string,
    variantId: string,
    pricePence: bigint,
  ): Promise<PriceBookEntryRow> {
    if (pricePence < 0n) {
      throw new BadRequestException('price_pence must not be negative');
    }
    const book = await this.db
      .selectFrom('price_books')
      .select('id')
      .where('id', '=', priceBookId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (book === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const variant = await this.db
      .selectFrom('product_variants')
      .select('id')
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (variant === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return this.db
      .insertInto('price_book_entries')
      .values({
        price_book_id: book.id,
        variant_id: variant.id,
        price_pence: pricePence,
      })
      .onConflict((oc) =>
        oc.columns(['price_book_id', 'variant_id']).doUpdateSet({
          price_pence: pricePence,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Update an existing price-book entry (Build-05): PUT
   * /v1/price-books/:id/entries/:variantId. Unlike POST, this does
   * NOT create a missing entry — updating a price that was never set
   * is a 404, so a typo'd variant id cannot silently create pricing.
   */
  async updatePriceBookEntry(
    actor: Actor,
    priceBookId: string,
    variantId: string,
    pricePence: bigint,
  ): Promise<PriceBookEntryRow> {
    if (pricePence < 0n) {
      throw new BadRequestException('price_pence must not be negative');
    }
    const book = await this.db
      .selectFrom('price_books')
      .select('id')
      .where('id', '=', priceBookId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (book === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const updated = await this.db
      .updateTable('price_book_entries')
      .set({ price_pence: pricePence, updated_at: new Date() })
      .where('price_book_id', '=', book.id)
      .where('variant_id', '=', variantId)
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return updated;
  }

  async listPromotions(actor: Actor, limit?: number): Promise<PromotionRow[]> {
    return this.db
      .selectFrom('promotions')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
  }

  async createPromotion(actor: Actor, input: CreatePromotionInput): Promise<PromotionRow> {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new BadRequestException('Promotion name is required');
    }
    if (!PROMOTION_TYPES.includes(input.type)) {
      throw new BadRequestException(`Unknown promotion type: ${String(input.type)}`);
    }
    if (!(input.startAt instanceof Date) || Number.isNaN(input.startAt.getTime())) {
      throw new BadRequestException('startAt must be a valid date');
    }
    if (
      input.endAt !== undefined &&
      input.endAt !== null &&
      (!(input.endAt instanceof Date) || Number.isNaN(input.endAt.getTime()))
    ) {
      throw new BadRequestException('endAt must be a valid date or null');
    }
    if (input.endAt !== undefined && input.endAt !== null && input.endAt < input.startAt) {
      throw new BadRequestException('endAt must be on or after startAt');
    }
    return this.db
      .insertInto('promotions')
      .values({
        tenant_id: actor.tenantId,
        name: input.name.trim(),
        type: input.type,
        status: 'draft',
        version: 1,
        stack_group: null,
        start_at: input.startAt,
        end_at: input.endAt ?? null,
        created_by_user_id: userIdAsUuid(actor.userId),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Bulk-generate vouchers, returning the plaintext codes EXACTLY
   * ONCE (Build-05 show-once). Each returned IssuedVoucher carries
   * the full code; only code_hash + code_last4 are stored in
   * PostgreSQL, so the codes are unrecoverable after this call
   * returns — the caller must distribute them now. All later reads
   * (listVouchers, and the older generateVouchers wrapper below)
   * return VoucherView (code_last4 only).
   */
  async generateVouchersShowOnce(
    actor: Actor,
    input: GenerateVouchersInput,
  ): Promise<IssuedVoucher[]> {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > VOUCHER_BULK_MAX_COUNT) {
      throw new BadRequestException(`count must be an integer between 1 and ${VOUCHER_BULK_MAX_COUNT}`);
    }
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1) {
      throw new BadRequestException('maxUses must be a positive integer');
    }
    if (
      input.validTo !== undefined &&
      input.validTo !== null &&
      (!(input.validTo instanceof Date) || Number.isNaN(input.validTo.getTime()))
    ) {
      throw new BadRequestException('validTo must be a valid date or null');
    }
    if (input.promotionId !== null) {
      const promotion = await this.db
        .selectFrom('promotions')
        .select('id')
        .where('id', '=', input.promotionId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (promotion === undefined) {
        throw new NotFoundException('Resource not found');
      }
    }
    const now = new Date();
    const issued: IssuedVoucher[] = [];
    for (let i = 0; i < input.count; i += 1) {
      // A hash collision (same 16-char code twice) is a 62^16 space
      // event; retry once per code rather than failing the batch.
      let code = generateVoucherCode();
      let codeHash = createHash('sha256').update(code).digest('hex');
      let clash = await this.db
        .selectFrom('voucher_codes')
        .select('id')
        .where('tenant_id', '=', actor.tenantId)
        .where('code_hash', '=', codeHash)
        .executeTakeFirst();
      if (clash !== undefined) {
        code = generateVoucherCode();
        codeHash = createHash('sha256').update(code).digest('hex');
      }
      const row = await this.db
        .insertInto('voucher_codes')
        .values({
          tenant_id: actor.tenantId,
          code_hash: codeHash,
          code_last4: code.slice(-4),
          promotion_id: input.promotionId,
          status: 'active',
          max_uses: input.maxUses,
          uses_count: 0,
          valid_from: now,
          valid_to: input.validTo ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      issued.push({
        id: row.id,
        code,
        code_last4: row.code_last4,
        expires_at: row.valid_to,
      });
    }
    return issued;
  }

  /**
   * Masked bulk generation (pre-Build-05 shape): the same rows as
   * generateVouchersShowOnce, with the plaintext codes stripped.
   * Kept for internal callers that only need the voucher records.
   * HTTP bulk routes return the show-once shape instead.
   */
  async generateVouchers(actor: Actor, input: GenerateVouchersInput): Promise<VoucherView[]> {
    const issued = await this.generateVouchersShowOnce(actor, input);
    const rows = await this.db
      .selectFrom('voucher_codes')
      .selectAll()
      .where('id', 'in', issued.map((v) => v.id))
      .execute();
    return rows.map(toVoucherView);
  }

  async listVouchers(actor: Actor, limit?: number): Promise<VoucherView[]> {
    const rows = await this.db
      .selectFrom('voucher_codes')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(clampLimit(limit))
      .execute();
    return rows.map(toVoucherView);
  }
}
