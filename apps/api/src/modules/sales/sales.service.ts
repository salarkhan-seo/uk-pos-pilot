import { createHash, randomUUID } from 'node:crypto';
import { assertUuid, userIdAsUuid } from '../../common/uuid';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  DB,
  OrderLinesTable,
  OrdersTable,
  OrderTendersTable,
  PaymentAttemptsTable,
  ReceiptsTable,
  RefundsTable,
} from '@uk-pos/db';
import {
  businessDate,
  divRoundHalfUp,
  taxBreakdownForLine,
  type TaxRateKind,
} from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { actorCanApprove } from '../../common/actor';
import { CatalogueService } from '../catalogue/catalogue.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalService } from '../admin/approval.service';
import { AuditService } from '../admin/audit.service';
import { PaymentsService } from '../payments/payments.service';
import type {
  DBWithRefundRetry,
  RefundsTableWithRetry,
} from './refund-retry-schema';

/**
 * SalesService — orders, split tenders and the checkout state machine
 * (Build-02, Objective 5; Arch-01 §2.5, Arch-02 §6, Arch-10 §2).
 *
 * ORDER STATE MACHINE (enforced here on every transition; the DB trigger
 * on orders is the backstop for completed-order immutability):
 *
 *   draft ──(first tender)──> pending_payment ──(completeOrder)──> completed
 *     │                           │
 *     └──────(void)──> voided <───┘
 *   pending_payment ──(split timeout, > 5 min)──> draft
 *
 *  - A draft order cannot complete directly; it must go through
 *    pending_payment (a tender must exist first).
 *  - A completed order is IMMUTABLE: no transition out of it exists, and
 *    this service refuses any mutating call on a completed order with
 *    IllegalOrderTransitionError BEFORE touching the DB.
 *  - A voided order cannot complete, and a completed order cannot void.
 *  - Returns (partially_returned / returned) are implemented in
 *    Build-03 (returnOrder below): the states exist in the schema CHECK
 *    and migration 013 allows the completed → partially_returned /
 *    returned transitions. Returns are Build-03 scope, delivered here.
 *
 * DESIGN DECISIONS recorded here (not research facts):
 *  - Split timeout is 5 minutes from the FIRST tender's created_at.
 *    The 5 minutes is Square's documented split-tender rule, adopted as
 *    a design rule for this pilot. On timeout the sale is unwound, never
 *    completed: stock is reversed, the tenders are deleted (they never
 *    settled — no money moved; the payment attempts remain as 'created'
 *    history), the order returns to draft, and SplitTimeoutError is
 *    thrown. The caller may retry the sale from draft.
 *  - Loyalty redemption is 1 point = 1p. The earn rate is Phase 2
 *    (Arch-09: points-per-pound is the recommended default, not yet
 *    decided by the owner), so only the redemption conversion is fixed
 *    here.
 *  - Ledger sign convention for gift_card_ledger and store_credit_ledger:
 *    the migrations state no sign convention (issue rows in the DB tests
 *    are positive). This service writes issue as POSITIVE and redeem as
 *    NEGATIVE, so balance = SUM(amount_pence) — the same signed-ledger
 *    rule migration 007 states for loyalty_ledger ("balance = sum of
 *    movements", "the ledger stores signed points"). A redeem row is
 *    therefore a negative amount in all three ledgers.
 *  - order_lines.unit_price_pence is the per-unit price after the price
 *    book (step 2: price-book price when one applies, else the base
 *    price), before promotions / manual discount / voucher / basket
 *    allocation. final_price_pence is the per-unit price after steps
 *    3–5 (before the basket allocation); line_total_pence is after ALL
 *    discounts including the basket allocation.
 *  - Stock reservation happens at the FIRST tender (draft →
 *    pending_payment), not at createOrder (G-A-13: the availability
 *    check runs inside the lock BEFORE any payment attempt is created).
 *    The warehouse is the location's default warehouse unless the line
 *    carries one: order_lines carry warehouse_id/unit_id/
 *    quantity_in_base_units (Build-03 migration 009). createOrder stores
 *    the sold unit_id; addTender passes unitId + orderLineId to
 *    decrementStockForOrder, which converts via
 *    variant_units.conversion_factor and stamps the line in base units.
 *    Plain (base-unit) variants — the pilot's normal case — are exact.
 *  - A gift card whose balance reaches exactly 0p on redemption is
 *    marked 'redeemed'; any other redemption leaves it 'active'.
 *  - recordCardAttemptOutcome is the Build-02 stand-in for the terminal
 *    callback: the till operator keys in the result of a standalone
 *    terminal (provider 'standalone'). NO provider is called anywhere in
 *    this module. The real Stripe adapter is Build-03+ work.
 *  - voidOrder performs NO approval check in Build-02. Arch-04 §2.8
 *    requires a 'void_post_tender' manager approval for post-tender
 *    voids; that approval gate is Build-03 scope and is recorded here
 *    so it is not silently forgotten. The ApprovalService is injected
 *    (constructor contract) but not called by any Build-02 method.
 *    BUILD-03: the gate is now ENFORCED in voidOrder — a void after any
 *    tender/payment attempt has started requires a valid manager
 *    approval_events row (action 'void_post_tender'); a void before any
 *    tender needs none.
 *  - Returns (Build-03 Objective 2, Arch-02 §6.4, Arch-10 §3.4,
 *    Arch-09 §3.2): returnOrder moves a completed order to
 *    partially_returned / returned (migration 013 amends the
 *    completed-order trigger to allow exactly those transitions).
 *    Restock writes a 'return' movement (+qty, balance up); damaged
 *    goods write a 'return' movement (+qty, goods back in the building)
 *    followed by a 'damage' write-off (-qty, disposed) — net on-hand
 *    change 0, and the pair mirrors the goods-in damage pattern
 *    (inventory.service goods-in). A zero-quantity movement is
 *    impossible: stock_movements has CHECK (quantity_change <> 0).
 *    The refund is the final price paid per line (line_total_pence,
 *    which already carries the D-14 pro-rata basket allocation), computed
 *    cumulatively so split returns never drift: refundable(x) uses the
 *    total returned quantity x, and each call refunds the difference
 *    from the previous cumulative figure. BOGO/multibuy lines re-price
 *    the remaining units at full price (Arch-10 §3.4: returning the
 *    paid unit voids the free unit's discount). Loyalty earn is reversed
 *    as a 'correction' ledger row capped at the current balance; a
 *    shortfall needs a manager refund_above_threshold approval and is
 *    recorded as a separate zero-point correction row with the reason.
 *    (No 'void' kind exists in the loyalty_ledger CHECK — 'correction'
 *    is this codebase's reversal kind.)
 *  - Refunds (D-09 Option C): linked refunds only, each with its own
 *    idempotency key. Retry queue: up to 5 provider attempts with
 *    exponential backoff (1m, 5m, 30m, 4h), then manual_escalation.
 *    insufficient_balance is never retried — it goes straight to
 *    manual_escalation with the top-up instruction. Async refund.failed
 *    (G-A-18) is handled in PaymentsService. Refund retry state lives
 *    in migration 012's columns (retry_count, next_retry_at,
 *    failure_reason) — see refund-retry-schema.ts.
 *  - G-A-16: payment_attempts carries no is_offline column in the
 *    Build-01 schema; the unforwarded-offline evidence is an
 *    offline_payment_records row for the order with status
 *    'pending_forward' and forwarded_at NULL, combined with a null
 *    provider_reference on the attempt. That is the check implemented
 *    here (and it is what the G-A-16 test seeds).
 *  - The earn rate for loyalty points is still an owner decision
 *    (Arch-09: points-per-pound recommended, not decided), so this
 *    service never CREATES earn rows — it only reverses earn rows that
 *    exist (seeded in tests; written by the loyalty earn job when it
 *    lands).
 *  - Audit: every order event is written with AuditService.record(trx,
 *    ...) on the order's own transaction, so the audit row commits or
 *    rolls back with the order. (Fixed 13 Nov 2026 during Build-02
 *    integration: record() used to wrap its work in
 *    dbOrTrx.transaction().execute(...), which Kysely 0.28 throws on
 *    when passed a Transaction; it now detects a Transaction with
 *    `instanceof Transaction` and writes directly on it. The sales
 *    module previously carried a private duplicate of the audit logic
 *    as a workaround — deleted with the fix.)
 *  - The voucher applied_promotions row is written AFTER redeemVoucher
 *    is called, not before: redeemVoucher treats an existing
 *    (orderId, promotionId) applied_promotions row as a replay and
 *    returns WITHOUT incrementing uses_count, so writing the row first
 *    would silently skip the increment. Line-level promotion rows are
 *    written first; the voucher row is written last, with the discount
 *    from the priced basket (a percentage voucher's amount depends on
 *    the basket, and redeemVoucher returns 0n for one).
 *  - Stock reversal (split timeout / void of a pending_payment order)
 *    writes compensating 'adjustment' movements that are the exact
 *    reverse of the 'sale' movements, restores the read-model balances,
 *    and returns any serials marked sold on the order to 'in_stock'.
 *    stock_valuation is deliberately untouched: the sale decrement does
 *    not touch it either, so the reversal mirrors the decrement exactly.
 */

export const VAT_INVOICE_NOTICE = 'This is not a VAT invoice';

/** Split-tender timeout: 5 minutes from the first tender (see above). */
export const SPLIT_TIMEOUT_MS = 5 * 60 * 1000;

/** Loyalty redemption: 1 point = 1p (see above). */
export const LOYALTY_POINTS_PER_PENCE = 1n;

/** W-12 cashier message, shown verbatim when a card outcome is unknown. */
export const UNKNOWN_PAYMENT_MESSAGE =
  'Payment outcome unknown — do not hand over goods on card until checked';

export class IllegalOrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalOrderTransitionError';
  }
}

export class SplitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitTimeoutError';
  }
}

export class TenderSumMismatchError extends Error {
  readonly expected: bigint;
  readonly actual: bigint;

  constructor(expected: bigint, actual: bigint) {
    super(
      `Tenders sum to ${actual.toString()}p but the order total is ${expected.toString()}p`,
    );
    this.name = 'TenderSumMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class UnknownPaymentBlockedError extends Error {
  constructor() {
    super(UNKNOWN_PAYMENT_MESSAGE);
    this.name = 'UnknownPaymentBlockedError';
  }
}

export class TenderNotApprovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenderNotApprovedError';
  }
}

/**
 * A refund that the rules refuse to create (G-A-15 / G-A-16). `code` is
 * machine-readable: 'refund_exceeds_original' | 'attempt_already_refunded'
 * | 'offline_unforwarded' | 'no_card_attempt'.
 */
export class RefundBlockedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RefundBlockedError';
    this.code = code;
  }
}

// ------------------------------------------------------------------
// Age verification — Challenge 25 (Build-09, Objective 2).
//
// The server is the compliance authority: a restricted line may not
// complete without a recorded verification meeting the 25 threshold.
// The register's AgeVerificationGate confirms the same threshold
// client-side; this module re-checks server-side and persists the
// event in age_verification_events (migration 004) — the VERIFIED
// AGE only. A customer date of birth is NEVER accepted or stored:
// any DOB-like field in a request is rejected with 400, not dropped.
// ------------------------------------------------------------------

/** Challenge 25 always verifies the 25 threshold (register gate rule). */
export const CHALLENGE_25_THRESHOLD = 25;

/** Wire shape of one age verification (snake_case, as commissioned).
 * verified_at is OPTIONAL: when the client supplies no verified_at
 * the column default (NOW()) applies at persist time; when it
 * supplies one it must be a valid ISO timestamp (unparseable → 400).
 */
export interface AgeVerificationWire {
  variant_id: string;
  verified_age_threshold: number;
  verified_by_user_id: string;
  verified_at?: string;
}

/**
 * Normalised age verification (validated, internal form).
 * verifiedAt is null when the client supplied none — the insert then
 * omits the column and the DB default (NOW()) applies.
 */
export interface AgeVerificationInput {
  variantId: string;
  verifiedAgeThreshold: number;
  verifiedByUserId: string;
  verifiedAt: Date | null;
}

/** Compliance-inspection view of a stored verification event. */
export interface AgeVerificationView {
  id: string;
  variant_id: string;
  verified_age_threshold: number;
  verified_by_user_id: string | null;
  /**
   * Client till timestamp (age_verification_events.verified_at,
   * Build-11 Objective 2) — the moment the till verified the
   * customer, preserved even when an offline sale is flushed hours
   * later. Distinct from created_at (server record time) whenever
   * the client supplied one.
   */
  verified_at: string;
  /** Server record time (age_verification_events.created_at). */
  created_at: string;
  method: 'manual_confirmation' | 'dob_entry';
  outcome: 'verified' | 'refused';
}

/**
 * 422 — an order with age-restricted lines cannot complete without a
 * verification meeting the threshold for every restricted variant.
 * Body follows the codebase's error convention (cf.
 * InvalidUuidException): `{ error: { code, message, variantIds } }`.
 */
export class AgeVerificationRequiredException extends UnprocessableEntityException {
  readonly variantIds: string[];

  constructor(variantIds: string[]) {
    super({
      error: {
        code: 'AGE_VERIFICATION_REQUIRED',
        message:
          `Age verification required for variant(s): ${variantIds.join(', ')} ` +
          `— confirm Challenge 25 (threshold ${CHALLENGE_25_THRESHOLD}) before completing the sale`,
        variantIds,
      },
    });
    this.name = 'AgeVerificationRequiredException';
    this.variantIds = variantIds;
  }
}

/** Keys that name a customer date of birth in any spelling. */
const DOB_LIKE_KEYS = new Set([
  'dob',
  'date_of_birth',
  'dateOfBirth',
  'birth_date',
  'birthDate',
  'birthdate',
  'dateofbirth',
  'customer_dob',
  'customerDob',
]);

/**
 * Reject any DOB-like field on a request object (400, never silent).
 * A date of birth must never reach the verification path at all.
 */
export function assertNoDobFields(value: unknown, where = 'request'): void {
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DOB_LIKE_KEYS.has(key)) {
      throw new BadRequestException(
        `Field '${key}' is not accepted in ${where}: a customer date of birth is never collected or stored — only the verified age threshold`,
      );
    }
  }
}

const AGE_VERIFICATION_KEYS = new Set([
  'variant_id',
  'verified_age_threshold',
  'verified_by_user_id',
  'verified_at',
]);

/**
 * Parse + validate the wire `age_verifications` array into normalised
 * inputs. Absent/empty → []. Any DOB-like or unknown key, malformed
 * UUID, non-integer threshold, threshold below 25, or unparseable
 * timestamp → 400. The threshold rule mirrors the register gate
 * (AgeVerificationGate.confirm requires >= 25): a lower threshold is
 * not a valid Challenge 25 verification. verified_at is OPTIONAL
 * (Build-11 Objective 2): a verification without one takes the
 * column default (NOW()) at persist time; a present-but-unparseable
 * verified_at is still 400 (Build-09 rule), never silently replaced
 * by NOW().
 */
export function parseAgeVerifications(raw: unknown): AgeVerificationInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequestException('age_verifications must be an array');
  }
  return raw.map((entry, index) => {
    const where = `age_verifications[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestException(`${where} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    assertNoDobFields(record, where);
    for (const key of Object.keys(record)) {
      if (!AGE_VERIFICATION_KEYS.has(key)) {
        throw new BadRequestException(`${where} has unknown field '${key}'`);
      }
    }
    const variantId = assertUuid(record.variant_id, 'variant_id');
    const threshold = record.verified_age_threshold;
    if (typeof threshold !== 'number' || !Number.isInteger(threshold)) {
      throw new BadRequestException(`${where}.verified_age_threshold must be an integer`);
    }
    if (threshold < CHALLENGE_25_THRESHOLD) {
      throw new BadRequestException(
        `Challenge 25 verification requires a threshold of at least ${CHALLENGE_25_THRESHOLD}`,
      );
    }
    const verifiedByUserId = assertUuid(record.verified_by_user_id, 'verified_by_user_id');
    const verifiedAtRaw = record.verified_at;
    let verifiedAt: Date | null = null;
    if (verifiedAtRaw !== undefined && verifiedAtRaw !== null) {
      if (typeof verifiedAtRaw !== 'string' || verifiedAtRaw.trim() === '') {
        throw new BadRequestException(`${where}.verified_at must be an ISO timestamp string`);
      }
      const parsed = new Date(verifiedAtRaw);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(`${where}.verified_at must be a valid ISO timestamp`);
      }
      verifiedAt = parsed;
    }
    return { variantId, verifiedAgeThreshold: threshold, verifiedByUserId, verifiedAt };
  });
}

export interface CreateOrderLineInput {
  variantId: string;
  quantity: bigint;
  unitId?: string | null;
  manualDiscountPence?: bigint;
}

export interface CreateOrderInput {
  locationId: string;
  registerId?: string | null;
  customerId?: string | null;
  lines: CreateOrderLineInput[];
  voucherCode?: string;
  basketDiscountPence?: bigint;
  approvalEventsId?: string | null;
}

export type TenderType = 'cash' | 'card' | 'store_credit' | 'gift_card' | 'loyalty_points';

export interface AddTenderInput {
  orderId: string;
  tenderType: TenderType;
  amountPence: bigint;
  giftCardCode?: string;
  customerId?: string;
  /**
   * Raw wire `age_verifications` (snake_case entries) — validated by
   * parseAgeVerifications at the service boundary. Supplied
   * verifications are recorded against the order when the tender is
   * accepted; a restricted line without one rejects the tender with
   * 422 BEFORE any stock is reserved (see addTender).
   */
  ageVerifications?: unknown;
}

export interface RecordCardAttemptOutcomeInput {
  paymentAttemptId: string;
  outcome: 'approved' | 'declined' | 'unknown';
  providerReference?: string;
}

export interface ResolveUnknownPaymentInput {
  paymentAttemptId: string;
  method: 'provider_query' | 'terminal_reconciliation';
  terminalEvidence?: string;
}

export interface ReturnOrderLineInput {
  orderLineId: string;
  quantity: bigint;
  /** 'restock' returns the goods to sellable stock; 'damaged' writes them off. */
  disposition: 'restock' | 'damaged';
}

export interface ReturnOrderInput {
  orderId: string;
  lines: ReturnOrderLineInput[];
  /** 'card' refunds to the original card attempt; 'cash' refunds cash.
   * Default: card when the order has an approved card attempt, else cash. */
  refundMethod?: 'card' | 'cash';
  /** Required when the loyalty earn reversal has a shortfall (the points
   * were already redeemed): a manager refund_above_threshold approval. */
  approvalEventsId?: string | null;
  /** Idempotency key for the return itself; a replay returns the original refund. */
  idempotencyKey?: string;
}

export interface ReturnOrderResult {
  order: OrderRow;
  /** Null when the return refunds nothing (e.g. only a BOGO free unit). */
  refund: RefundRowWithRetry | null;
  refundAmountPence: bigint;
  reversedLoyaltyPoints: bigint;
  loyaltyShortfallPoints: bigint;
  replayed?: boolean;
}

export interface CreateRefundInput {
  orderId: string;
  paymentAttemptId?: string | null;
  amountPence: bigint;
  reason?: string | null;
  idempotencyKey?: string;
}

export interface CompleteManualRefundInput {
  refundId: string;
  outcome: 'completed' | 'failed';
  providerReference?: string | null;
  reason?: string | null;
}

/** A refunds row including the migration 012 retry columns. */
export type RefundRowWithRetry = Selectable<RefundsTableWithRetry>;
export type RefundRow = Selectable<RefundsTable>;

/** D-09 Option C retry schedule (Arch-02 §6.4 step 4, adapted from the
 * §3.4 backoff): after failed attempt n (n = 1..4) the next attempt is
 * due in DELAYS[n-1]. Attempt 5 failing escalates instead of queuing. */
export const MAX_REFUND_ATTEMPTS = 5;
export const REFUND_RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  4 * 60 * 60 * 1000,
] as const;

export interface ReceiptVatLineView {
  taxRateKind: TaxRateKind;
  taxRatePercent: string;
  grossPence: bigint;
  vatPence: bigint;
  netPence: bigint;
}

export interface ReceiptView {
  receiptNumber: bigint;
  orderId: string;
  issuedAt: Date;
  lines: ReceiptVatLineView[];
  totalPence: bigint;
  /** A till receipt is NOT a VAT invoice (package §11 / Arch-01 §3.2). */
  vatInvoiceNotice: string;
}

export type OrderRow = Selectable<OrdersTable>;
export type OrderLineRow = Selectable<OrderLinesTable>;
export type TenderRow = Selectable<OrderTendersTable>;
export type PaymentAttemptRow = Selectable<PaymentAttemptsTable>;
export type ReceiptRow = Selectable<ReceiptsTable>;

@Injectable()
export class SalesService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly catalogue: CatalogueService,
    private readonly inventory: InventoryService,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  status(): { module: string; status: string } {
    return { module: 'sales', status: 'Build-02 Objective 5 — orders, split tenders, checkout state machine' };
  }

  // ------------------------------------------------------------------
  // Numbering (D-15: sequential, gap-free; voided numbers are retained
  // and never reused). The advisory lock serialises allocators for one
  // tenant+location+kind INSIDE the transaction; the number is then
  // MAX(existing numbers) + 1. NEVER bare MAX() + 1 without the lock:
  // two concurrent checkouts could read the same MAX and collide on the
  // UNIQUE (tenant_id, location_id, order_number) constraint.
  // ------------------------------------------------------------------

  async nextOrderNumber(trx: Kysely<DB>, tenantId: string, locationId: string): Promise<bigint> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}|${locationId}|order_number`}))`.execute(
      trx,
    );
    const result = await sql<{ max_number: string | bigint | null }>`
      SELECT MAX(order_number) AS max_number FROM orders
      WHERE tenant_id = ${tenantId} AND location_id = ${locationId}
    `.execute(trx);
    const maxRow = result.rows[0];
    const max = maxRow?.max_number == null ? 0n : BigInt(maxRow.max_number);
    return max + 1n;
  }

  async nextReceiptNumber(trx: Kysely<DB>, tenantId: string, locationId: string): Promise<bigint> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}|${locationId}|receipt_number`}))`.execute(
      trx,
    );
    const result = await sql<{ max_number: string | bigint | null }>`
      SELECT MAX(receipt_number) AS max_number FROM receipts
      WHERE tenant_id = ${tenantId} AND location_id = ${locationId}
    `.execute(trx);
    const maxRow = result.rows[0];
    const max = maxRow?.max_number == null ? 0n : BigInt(maxRow.max_number);
    return max + 1n;
  }

  // ------------------------------------------------------------------
  // createOrder — draft order, priced basket, no stock, no payments yet.
  // ------------------------------------------------------------------

  async createOrder(
    actor: Actor,
    input: CreateOrderInput,
  ): Promise<{ order: OrderRow; lines: OrderLineRow[] }> {
    if (input.locationId !== actor.locationId) {
      throw new NotFoundException('Resource not found');
    }
    if (input.lines.length === 0) {
      throw new BadRequestException('Order must contain at least one line');
    }
    return this.db.transaction().execute(async (trx) => {
      if (input.registerId !== undefined && input.registerId !== null) {
        const register = await trx
          .selectFrom('registers')
          .select('id')
          .where('id', '=', input.registerId)
          .where('tenant_id', '=', actor.tenantId)
          .where('location_id', '=', input.locationId)
          .executeTakeFirst();
        if (register === undefined) {
          throw new NotFoundException('Resource not found');
        }
      }
      if (input.customerId !== undefined && input.customerId !== null) {
        const customer = await trx
          .selectFrom('customers')
          .select('id')
          .where('id', '=', input.customerId)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        if (customer === undefined) {
          throw new NotFoundException('Resource not found');
        }
      }

      const priced = await this.catalogue.priceBasket(
        actor,
        input.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitId: line.unitId ?? null,
          manualDiscountPence: line.manualDiscountPence,
        })),
        {
          voucherCode: input.voucherCode,
          basketDiscountPence: input.basketDiscountPence,
          approvalEventsId: input.approvalEventsId ?? null,
        },
        trx,
      );

      const orderNumber = await this.nextOrderNumber(trx, actor.tenantId, input.locationId);
      const order = await trx
        .insertInto('orders')
        .values({
          tenant_id: actor.tenantId,
          location_id: input.locationId,
          register_id: input.registerId ?? null,
          customer_id: input.customerId ?? null,
          order_number: orderNumber,
          business_date: businessDate(new Date()),
          status: 'draft',
          subtotal_pence: priced.subtotalPence,
          discount_pence: priced.discountPence,
          tax_pence: priced.taxPence,
          total_pence: priced.totalPence,
          created_by_user_id: userIdAsUuid(actor.userId),
          completed_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const createdLines: OrderLineRow[] = [];
      for (const pricedLine of priced.lines) {
        const line = await trx
          .insertInto('order_lines')
          .values({
            tenant_id: actor.tenantId,
            order_id: order.id,
            variant_id: pricedLine.variantId,
            quantity: pricedLine.quantity,
            // Per-unit price after the price book (step 2), before
            // promotions / manual discount / voucher / basket allocation.
            unit_price_pence:
              pricedLine.priceBookPricePence ?? pricedLine.basePricePence,
            base_price_pence: pricedLine.basePricePence,
            price_book_id: pricedLine.priceBookId,
            price_book_price_pence: pricedLine.priceBookPricePence,
            promotion_discount_pence: pricedLine.promotionDiscountPence,
            manual_discount_pence: pricedLine.manualDiscountPence,
            final_price_pence: pricedLine.finalPricePence,
            tax_rate_kind: pricedLine.taxRateKind,
            tax_rate_percent: pricedLine.taxRatePercent,
            tax_amount_pence: pricedLine.taxAmountPence,
            line_total_pence: pricedLine.lineTotalPence,
            // Build-03 migration 009: the unit the line was sold in
            // (variant_units row id, null = base unit). warehouse_id and
            // quantity_in_base_units are stamped at reservation time by
            // decrementStockForOrder (addTender), which converts via
            // variant_units.conversion_factor.
            unit_id: pricedLine.unitId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        createdLines.push(line);

        for (const applied of pricedLine.appliedPromotions) {
          await trx
            .insertInto('applied_promotions')
            .values({
              tenant_id: actor.tenantId,
              order_id: order.id,
              order_line_id: line.id,
              promotion_id: applied.promotionId,
              promotion_version: applied.promotionVersion,
              discount_pence: applied.discountPence,
              applied_by_user_id: userIdAsUuid(actor.userId),
              voided: false,
              voided_by_user_id: null,
            })
            .execute();
        }
      }

      // Voucher: redeem FIRST (it increments uses_count), then record
      // the applied_promotions row — see the design-decision comment at
      // the top of this file. redeemVoucher returns 0n for a percentage
      // voucher, so the row carries the priced basket's discount.
      if (
        priced.voucherPromotionId !== undefined &&
        priced.voucherPromotionId !== null &&
        input.voucherCode !== undefined &&
        input.voucherCode !== ''
      ) {
        await this.catalogue.redeemVoucher(actor, trx, {
          orderId: order.id,
          voucherCode: input.voucherCode,
          userId: actor.userId,
        });
        const promotion = await trx
          .selectFrom('promotions')
          .select('version')
          .where('id', '=', priced.voucherPromotionId)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        await trx
          .insertInto('applied_promotions')
          .values({
            tenant_id: actor.tenantId,
            order_id: order.id,
            order_line_id: null,
            promotion_id: priced.voucherPromotionId,
            promotion_version: promotion?.version ?? 1,
            discount_pence: priced.voucherDiscountPence ?? 0n,
            applied_by_user_id: userIdAsUuid(actor.userId),
            voided: false,
            voided_by_user_id: null,
          })
          .execute();
      }

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'order.created',
        entityType: 'order',
        entityId: order.id,
        payload: {
          orderNumber: orderNumber.toString(),
          locationId: input.locationId,
          totalPence: priced.totalPence.toString(),
          lineCount: String(createdLines.length),
        },
      });

      return { order, lines: createdLines };
    });
  }

  // ------------------------------------------------------------------
  // addTender — first tender reserves stock (G-A-13) and moves the
  // order draft -> pending_payment; later tenders just add to the split.
  // ------------------------------------------------------------------

  async addTender(actor: Actor, input: AddTenderInput): Promise<TenderRow> {
    if (input.amountPence <= 0n) {
      throw new BadRequestException('Tender amount must be greater than zero');
    }
    return this.db.transaction().execute(async (trx) => {
      const order = await this.loadOrder(trx, actor, input.orderId);
      this.requireOrderNotCompleted(order, 'add a tender to');
      if (order.status !== 'draft' && order.status !== 'pending_payment') {
        throw new IllegalOrderTransitionError(
          `Cannot add a tender to an order in status ${order.status}`,
        );
      }

      // Build-09, Objective 2 — Challenge 25 enforcement BEFORE any
      // stock is reserved: supplied verifications are recorded, then
      // every restricted line must be covered (supplied or already
      // recorded). A 422 here rolls the whole transaction back, so the
      // order stays draft with no stock moved and no tender recorded.
      const ageVerifications = parseAgeVerifications(input.ageVerifications);
      await this.recordAgeVerifications(trx, actor, order.id, ageVerifications);
      await this.assertAgeVerified(trx, actor, order.id, ageVerifications);

      if (order.status === 'draft') {
        // Reserve stock FIRST, inside the lock, BEFORE any payment
        // attempt is created (G-A-13).
        const warehouseId = await this.defaultWarehouseId(trx, actor, order.location_id);
        const lines = await trx
          .selectFrom('order_lines')
          .select(['id', 'variant_id', 'quantity', 'unit_id'])
          .where('order_id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .execute();
        await this.inventory.decrementStockForOrder(actor, trx, {
          locationId: order.location_id,
          orderId: order.id,
          userId: actor.userId,
          lines: lines.map((line) => ({
            variantId: line.variant_id,
            warehouseId,
            quantity: line.quantity,
            // Build-03 migration 009: pass the sold unit + the exact
            // order line so the decrement converts to base units and
            // stamps warehouse_id/unit_id/quantity_in_base_units.
            unitId: line.unit_id,
            orderLineId: line.id,
          })),
        });
        await trx
          .updateTable('orders')
          .set({ status: 'pending_payment' })
          .where('id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .execute();
      }

      let paymentAttemptId: string | null = null;
      switch (input.tenderType) {
        case 'cash':
          break;
        case 'card': {
          // No provider is called: a 'standalone' attempt in 'created'
          // state, moved to 'approved' by recordCardAttemptOutcome when
          // the operator keys in the terminal result.
          const existing = await trx
            .selectFrom('payment_attempts')
            .select('id')
            .where('order_id', '=', order.id)
            .where('tenant_id', '=', actor.tenantId)
            .execute();
          const attempt = await trx
            .insertInto('payment_attempts')
            .values({
              tenant_id: actor.tenantId,
              order_id: order.id,
              idempotency_key: randomUUID(),
              provider: 'standalone',
              provider_reference: null,
              status: 'created',
              amount_pence: input.amountPence,
              currency: 'GBP',
              attempt_number: existing.length + 1,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          paymentAttemptId = attempt.id;
          break;
        }
        case 'gift_card':
          await this.redeemGiftCard(trx, actor, order, input);
          break;
        case 'store_credit':
          await this.redeemStoreCredit(trx, actor, order, input);
          break;
        case 'loyalty_points':
          await this.redeemLoyaltyPoints(trx, actor, order, input);
          break;
        default: {
          const exhaustive: never = input.tenderType;
          throw new BadRequestException(`Unknown tender type: ${String(exhaustive)}`);
        }
      }

      const tender = await trx
        .insertInto('order_tenders')
        .values({
          tenant_id: actor.tenantId,
          order_id: order.id,
          tender_type: input.tenderType,
          amount_pence: input.amountPence,
          payment_attempt_id: paymentAttemptId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'order.tender_added',
        entityType: 'order',
        entityId: order.id,
        payload: {
          tenderId: tender.id,
          tenderType: input.tenderType,
          amountPence: input.amountPence.toString(),
        },
      });

      return tender;
    });
  }

  // ------------------------------------------------------------------
  // recordCardAttemptOutcome — Build-02 stand-in for the terminal
  // callback. The real Stripe adapter is Build-03+; nothing here calls
  // any provider.
  //
  // NOTE (deviation from the commission's §5 wording, required by its
  // own test flow): the outcome may change from 'created', 'pending'
  // AND 'unknown'. 'unknown' is the "not yet known" state — the W-12
  // test flow records 'unknown', then later records 'approved' once the
  // operator has checked with the provider, and the order completes. If
  // 'unknown' were terminal, that order could never complete and the
  // till would be stuck. Only 'approved', 'declined' and 'refunded'
  // are terminal.
  // ------------------------------------------------------------------

  async recordCardAttemptOutcome(
    actor: Actor,
    input: RecordCardAttemptOutcomeInput,
  ): Promise<PaymentAttemptRow> {
    return this.db.transaction().execute(async (trx) => {
      const attempt = await trx
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', input.paymentAttemptId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (attempt === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (attempt.status !== 'created' && attempt.status !== 'pending' && attempt.status !== 'unknown') {
        throw new IllegalOrderTransitionError(
          `Payment attempt is ${attempt.status} and its outcome can no longer change`,
        );
      }
      const updated = await trx
        .updateTable('payment_attempts')
        .set({
          status: input.outcome,
          provider_reference: input.providerReference ?? attempt.provider_reference,
        })
        .where('id', '=', attempt.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'payment_attempt.outcome',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        payload: {
          orderId: attempt.order_id,
          outcome: input.outcome,
          providerReference: input.providerReference ?? null,
        },
      });

      return updated;
    });
  }

  // ------------------------------------------------------------------
  // completeOrder — pending_payment -> completed, with split timeout,
  // exact tender sum, W-12 unknown-payment block, and receipt issue.
  // ------------------------------------------------------------------

  async completeOrder(
    actor: Actor,
    orderId: string,
    ageVerificationsRaw?: unknown,
  ): Promise<{ order: OrderRow; receipt: ReceiptView }> {
    // NOTE: the split-timeout path writes the unwind (stock back,
    // tenders deleted, order back to draft) and THEN throws
    // SplitTimeoutError. The throw must happen AFTER the transaction
    // commits — throwing inside the transaction would roll the unwind
    // back and leave the order pending_payment. The transaction
    // therefore returns a timeout sentinel, and the throw happens here,
    // outside it. The other error paths (sum mismatch, unknown / not
    // approved card) write nothing before throwing, so rolling back is
    // exactly right for them.
    const outcome = await this.db.transaction().execute(async (trx) => {
      const order = await this.loadOrder(trx, actor, orderId);
      this.requireOrderNotCompleted(order, 'complete');
      if (order.status !== 'pending_payment') {
        throw new IllegalOrderTransitionError(
          `Only a pending_payment order can complete (order is ${order.status}); a draft order must take a tender first`,
        );
      }

      // Build-09, Objective 2 — Challenge 25 enforcement at completion
      // (defense in depth behind the tender check: it also covers a
      // rule attached after the tender was taken). Supplied
      // verifications are recorded, then every restricted line must be
      // covered. A 422 rolls the transaction back: the order stays
      // pending_payment, no receipt is issued, no completion is
      // recorded.
      const ageVerifications = parseAgeVerifications(ageVerificationsRaw);
      await this.recordAgeVerifications(trx, actor, order.id, ageVerifications);
      await this.assertAgeVerified(trx, actor, order.id, ageVerifications);

      const tenders = await trx
        .selectFrom('order_tenders')
        .selectAll()
        .where('order_id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .orderBy('created_at', 'asc')
        .execute();

      // Split timeout: the first tender is older than 5 minutes. Unwind
      // the sale (stock back, tenders deleted, order back to draft) and
      // report the timeout — the caller may retry the sale from draft.
      const firstTender = tenders[0];
      if (
        firstTender !== undefined &&
        Date.now() - firstTender.created_at.getTime() > SPLIT_TIMEOUT_MS
      ) {
        await this.reverseStockForOrder(trx, actor, order);
        await trx
          .deleteFrom('order_tenders')
          .where('order_id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .execute();
        await trx
          .updateTable('orders')
          .set({ status: 'draft' })
          .where('id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .execute();
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'order.split_timeout',
          entityType: 'order',
          entityId: order.id,
          payload: {
            firstTenderAt: firstTender.created_at.toISOString(),
            tenderCount: String(tenders.length),
          },
        });
        return { timedOut: true as const };
      }

      const tenderSum = tenders.reduce((sum, tender) => sum + tender.amount_pence, 0n);
      if (tenderSum !== order.total_pence) {
        throw new TenderSumMismatchError(order.total_pence, tenderSum);
      }

      // Every card tender must have an APPROVED attempt. An 'unknown'
      // attempt blocks completion (W-12): the order stays
      // pending_payment and the attempt stays unknown — goods must not
      // be handed over on an unchecked card payment.
      for (const tender of tenders) {
        if (tender.tender_type !== 'card') {
          continue;
        }
        if (tender.payment_attempt_id === null) {
          throw new TenderNotApprovedError('Card tender has no payment attempt');
        }
        const attempt = await trx
          .selectFrom('payment_attempts')
          .select(['id', 'status'])
          .where('id', '=', tender.payment_attempt_id)
          .where('tenant_id', '=', actor.tenantId)
          .executeTakeFirst();
        if (attempt === undefined) {
          throw new TenderNotApprovedError('Card tender has no payment attempt');
        }
        if (attempt.status === 'unknown') {
          throw new UnknownPaymentBlockedError();
        }
        if (attempt.status !== 'approved') {
          throw new TenderNotApprovedError(
            `Card tender cannot complete: its payment attempt is ${attempt.status}`,
          );
        }
      }

      const completed = await trx
        .updateTable('orders')
        .set({ status: 'completed', completed_at: new Date() })
        .where('id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      const receiptNumber = await this.nextReceiptNumber(trx, actor.tenantId, order.location_id);
      const receipt = await trx
        .insertInto('receipts')
        .values({
          tenant_id: actor.tenantId,
          location_id: order.location_id,
          order_id: order.id,
          receipt_number: receiptNumber,
          // The literal equals the DB default; schema.ts types the
          // column as required (not Generated), so it is passed
          // explicitly rather than omitted.
          vat_invoice_notice: VAT_INVOICE_NOTICE,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Receipt VAT lines: per-rate Net/VAT/Gross, rebuilt from the
      // order lines' discounted totals with the shared kernel (D-13:
      // round half-up per line, then sum). All lines of one kind must
      // share one rate percent — a mixed percent is a data error and
      // aborts the completion rather than printing a wrong receipt.
      const lines = await trx
        .selectFrom('order_lines')
        .selectAll()
        .where('order_id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
      const byKind = new Map<
        TaxRateKind,
        { percent: string; gross: bigint; vat: bigint; net: bigint }
      >();
      for (const line of lines) {
        const breakdown = taxBreakdownForLine(line.line_total_pence, line.tax_rate_kind);
        const existing = byKind.get(line.tax_rate_kind);
        if (existing !== undefined) {
          if (existing.percent !== line.tax_rate_percent) {
            throw new Error(
              `Order ${order.id} has mixed tax percents for rate ${line.tax_rate_kind}`,
            );
          }
          existing.gross += breakdown.grossPence;
          existing.vat += breakdown.vatPence;
          existing.net += breakdown.netPence;
        } else {
          byKind.set(line.tax_rate_kind, {
            percent: line.tax_rate_percent,
            gross: breakdown.grossPence,
            vat: breakdown.vatPence,
            net: breakdown.netPence,
          });
        }
      }
      for (const [kind, totals] of byKind) {
        await trx
          .insertInto('receipt_vat_lines')
          .values({
            receipt_id: receipt.id,
            tax_rate_kind: kind,
            tax_rate_percent: totals.percent,
            gross_pence: totals.gross,
            vat_pence: totals.vat,
            net_pence: totals.net,
          })
          .execute();
      }

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'order.completed',
        entityType: 'order',
        entityId: order.id,
        payload: {
          receiptNumber: receiptNumber.toString(),
          totalPence: order.total_pence.toString(),
          tenderCount: String(tenders.length),
        },
      });

      const receiptView = await this.buildReceiptView(trx, completed, receipt);
      return { timedOut: false as const, order: completed, receipt: receiptView };
    });

    if (outcome.timedOut) {
      throw new SplitTimeoutError(
        'Split tender timed out after 5 minutes: the sale was unwound and the order is back to draft',
      );
    }
    return { order: outcome.order, receipt: outcome.receipt };
  }

  // ------------------------------------------------------------------
  // getReceipt — the receipt is explicitly NOT a VAT invoice.
  // ------------------------------------------------------------------

  async getReceipt(actor: Actor, orderId: string): Promise<ReceiptView> {
    const receipt = await this.db
      .selectFrom('receipts')
      .selectAll()
      .where('order_id', '=', orderId)
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId)
      .executeTakeFirst();
    if (receipt === undefined) {
      throw new NotFoundException('Resource not found');
    }
    const order = await this.loadOrder(this.db, actor, orderId);
    return this.buildReceiptView(this.db, order, receipt);
  }

  // ------------------------------------------------------------------
  // voidOrder — draft or pending_payment -> voided only. A pending
  // order's stock is reversed, approved card attempts get a 'pending'
  // refund row queued (D-09: queue for retry, then manual escalation),
  // and the tenders are deleted (they never settled). The voided
  // order_number is NEVER reused (numbering is MAX+1 under the advisory
  // lock, and the voided row remains).
  //
  // void_post_tender gate (Build-03, Arch-04 §2.8): any void AFTER a
  // tender/payment attempt has started requires a valid manager
  // approval_events row (action 'void_post_tender'). A void before any
  // tender needs no approval. The approval is validated inside the same
  // transaction as the void, so it cannot be consumed twice by two
  // concurrent voids — the row still exists afterwards (approvals are
  // append-only records, not single-use tokens), which matches how
  // hasApproval is used elsewhere in this codebase.
  // ------------------------------------------------------------------

  async voidOrder(
    actor: Actor,
    orderId: string,
    reason?: string,
    approvalEventsId?: string | null,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const order = await this.loadOrder(trx, actor, orderId);
      this.requireOrderNotCompleted(order, 'void');
      if (order.status !== 'draft' && order.status !== 'pending_payment') {
        throw new IllegalOrderTransitionError(
          `Only a draft or pending_payment order can be voided (order is ${order.status})`,
        );
      }

      const tenderStarted = await this.hasTenderStarted(trx, actor, order);
      if (tenderStarted) {
        // A malformed id is simply not a valid approval (comparing a
        // non-UUID string against a uuid column raises a DB error
        // instead of "no such approval" — see isUuid in payments).
        const approvalOk =
          approvalEventsId !== undefined &&
          approvalEventsId !== null &&
          approvalEventsId !== '' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            approvalEventsId,
          ) &&
          (await this.approvals.hasApproval(trx, {
            tenantId: actor.tenantId,
            approvalEventsId,
            action: 'void_post_tender',
          }));
        if (!approvalOk) {
          throw new BadRequestException(
            'Voiding an order after a tender requires a valid manager void_post_tender approval',
          );
        }
      }

      if (order.status === 'pending_payment') {
        await this.reverseStockForOrder(trx, actor, order);
        const approvedAttempts = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('order_id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .where('status', '=', 'approved')
          .execute();
        for (const attempt of approvedAttempts) {
          await trx
            .insertInto('refunds')
            .values({
              tenant_id: actor.tenantId,
              order_id: order.id,
              payment_attempt_id: attempt.id,
              idempotency_key: randomUUID(),
              amount_pence: attempt.amount_pence,
              reason: reason ?? 'Order voided',
              status: 'pending',
              provider_reference: null,
              created_by_user_id: userIdAsUuid(actor.userId),
            })
            .execute();
        }
        await trx
          .deleteFrom('order_tenders')
          .where('order_id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .execute();
      }

      await trx
        .updateTable('orders')
        .set({ status: 'voided' })
        .where('id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .execute();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'order.voided',
        entityType: 'order',
        entityId: order.id,
        payload: {
          reason: reason ?? null,
          wasPendingPayment: String(order.status === 'pending_payment'),
        },
      });
    });
  }

  // ------------------------------------------------------------------
  // resolveUnknownPayment — W-12 path (a)/(b) via the payments module,
  // then complete the order when the provider says approved. Stock was
  // already moved exactly once at the first tender; completion here
  // moves nothing again — the assertion that matters is that the order
  // completes ONLY after provider evidence arrives, and that a declined
  // outcome leaves the order open for another tender. The negative is
  // enforced by completeOrder itself (UnknownPaymentBlockedError on an
  // unknown attempt) and by PaymentsService (no path approves without
  // evidence); there is deliberately no "mark as paid" shortcut here.
  // ------------------------------------------------------------------

  async resolveUnknownPayment(
    actor: Actor,
    input: ResolveUnknownPaymentInput,
  ): Promise<{
    attempt: PaymentAttemptRow;
    outcome: 'approved' | 'declined' | 'unknown' | 'pending';
    completed: { order: OrderRow; receipt: ReceiptView } | null;
  }> {
    const result =
      input.method === 'terminal_reconciliation'
        ? await this.payments.reconcileTerminal(actor, {
            paymentAttemptId: input.paymentAttemptId,
            terminalEvidence: input.terminalEvidence ?? '',
          })
        : await this.payments.resolveUnknownByProviderQuery(actor, {
            paymentAttemptId: input.paymentAttemptId,
          });
    if (result.resolved && result.outcome === 'approved') {
      const completed = await this.completeOrder(actor, result.orderId);
      return { attempt: result.attempt, outcome: 'approved', completed };
    }
    return { attempt: result.attempt, outcome: result.outcome, completed: null };
  }

  // ------------------------------------------------------------------
  // createRefund — a LINKED refund only (Arch-02 §6.4 step 1): one
  // refunds row with its own idempotency key, tied to the original
  // payment attempt and order. Unlinked refunds are not offered.
  //
  // Blocks (G-A-15 / G-A-16), all as RefundBlockedError with a code:
  //  - refund > original amount (attempt amount, or order total for cash);
  //  - refund of an already-refunded attempt (attempt status 'refunded');
  //  - refund against an unforwarded offline PaymentIntent
  //    (provider_reference IS NULL + a pending_forward offline record).
  // A replay with the same idempotency key returns the original refund.
  // ------------------------------------------------------------------

  async createRefund(actor: Actor, input: CreateRefundInput): Promise<RefundRowWithRetry> {
    return this.db.transaction().execute(async (trx) =>
      this.createRefundInTrx(trx, actor, input),
    );
  }

  private async createRefundInTrx(
    trx: Kysely<DB>,
    actor: Actor,
    input: CreateRefundInput,
  ): Promise<RefundRowWithRetry> {
    if (input.amountPence <= 0n) {
      throw new BadRequestException('Refund amount must be greater than zero');
    }
    const order = await this.loadOrder(trx, actor, input.orderId);
    if (order.status !== 'completed' && order.status !== 'partially_returned') {
      throw new IllegalOrderTransitionError(
        `Refunds can only be created for a completed or partially_returned order (order is ${order.status})`,
      );
    }

    const refundsDb = this.refundsDb(trx);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const replay = await refundsDb
      .selectFrom('refunds')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (replay !== undefined) {
      return replay;
    }

    let attempt: PaymentAttemptRow | undefined;
    if (input.paymentAttemptId !== undefined && input.paymentAttemptId !== null) {
      attempt = await trx
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', input.paymentAttemptId)
        .where('tenant_id', '=', actor.tenantId)
        .where('order_id', '=', order.id)
        .executeTakeFirst();
      if (attempt === undefined) {
        throw new NotFoundException('Resource not found');
      }
      // G-A-15: already-refunded attempt, and refund above the original.
      if (attempt.status === 'refunded') {
        throw new RefundBlockedError(
          'attempt_already_refunded',
          `Payment attempt ${attempt.id} has already been refunded`,
        );
      }
      const alreadyRefunded = await this.refundedTotalForAttempt(trx, actor, attempt.id);
      if (alreadyRefunded + input.amountPence > attempt.amount_pence) {
        throw new RefundBlockedError(
          'refund_exceeds_original',
          `Refund of ${input.amountPence}p would exceed the original attempt amount of ${attempt.amount_pence}p (${alreadyRefunded}p already refunded)`,
        );
      }
      // G-A-16: no refund until an offline PaymentIntent is forwarded.
      if (attempt.provider_reference === null && (await this.hasUnforwardedOfflineRecord(trx, actor, order.id))) {
        throw new RefundBlockedError(
          'offline_unforwarded',
          'Cannot refund an unforwarded offline payment: the PaymentIntent must be forwarded to the provider first',
        );
      }
    } else {
      // Cash refund (no attempt): capped at the order total less refunds
      // already made against the order.
      const alreadyRefunded = await this.refundedTotalForOrder(trx, actor, order.id);
      if (alreadyRefunded + input.amountPence > order.total_pence) {
        throw new RefundBlockedError(
          'refund_exceeds_original',
          `Refund of ${input.amountPence}p would exceed the order total of ${order.total_pence}p (${alreadyRefunded}p already refunded)`,
        );
      }
    }

    const refund = await refundsDb
      .insertInto('refunds')
      .values({
        tenant_id: actor.tenantId,
        order_id: order.id,
        payment_attempt_id: attempt?.id ?? null,
        idempotency_key: idempotencyKey,
        amount_pence: input.amountPence,
        reason: input.reason ?? null,
        status: 'pending',
        provider_reference: null,
        created_by_user_id: userIdAsUuid(actor.userId),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.audit.record(trx, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'refund.created',
      entityType: 'refund',
      entityId: refund.id,
      payload: {
        orderId: order.id,
        paymentAttemptId: attempt?.id ?? null,
        amountPence: input.amountPence.toString(),
        reason: input.reason ?? null,
      },
    });

    const processed = await this.processRefundInTrx(trx, actor, refund, attempt);
    return processed;
  }

  /**
   * Send a newly created refund to the provider (or settle it as cash).
   * The provider outcome drives the D-09 state machine; see
   * applyAdapterRefundOutcome for the mapping.
   */
  private async processRefundInTrx(
    trx: Kysely<DB>,
    actor: Actor,
    refund: RefundRowWithRetry,
    attempt: PaymentAttemptRow | undefined,
  ): Promise<RefundRowWithRetry> {
    // Cash refund: no provider is involved; the cash is handed back at
    // the till and the refund completes immediately.
    if (attempt === undefined) {
      return this.updateRefund(trx, actor, refund, {
        status: 'completed',
        provider_reference: null,
      });
    }
    // Standalone-terminal refunds are manual by definition: the manager
    // performs the refund on the physical terminal. Never call a
    // provider for one, and never retry it — straight to escalation.
    if (attempt.provider === 'standalone') {
      const escalated = await this.updateRefund(trx, actor, refund, {
        status: 'manual_escalation',
        failure_reason: 'standalone_manual_refund',
      });
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'refund.escalated',
        entityType: 'refund',
        entityId: refund.id,
        payload: {
          orderId: refund.order_id,
          paymentAttemptId: attempt.id,
          amountPence: refund.amount_pence.toString(),
          failureReason: 'standalone_manual_refund',
          nextAction:
            'Manager performs the refund on the standalone terminal and records the provider reference.',
        },
      });
      return escalated;
    }

    const result = await this.payments.getAdapter().refund({
      idempotencyKey: refund.idempotency_key,
      paymentAttemptId: attempt.id,
      amountPence: refund.amount_pence,
    });
    return this.applyAdapterRefundOutcome(trx, actor, refund, attempt, result.outcome, result);
  }

  // ------------------------------------------------------------------
  // processRefundRetry — re-attempt a queued ('pending') refund through
  // the provider with the SAME idempotency key. Up to 5 provider
  // attempts in total (MAX_REFUND_ATTEMPTS); the 5th failure moves the
  // refund to manual_escalation. insufficient_balance is never retried
  // (it goes straight to escalation at creation) — a retry call on an
  // escalated/failed refund is refused.
  // ------------------------------------------------------------------

  async processRefundRetry(actor: Actor, refundId: string): Promise<RefundRowWithRetry> {
    return this.db.transaction().execute(async (trx) => {
      const refundsDb = this.refundsDb(trx);
      const refund = await refundsDb
        .selectFrom('refunds')
        .selectAll()
        .where('id', '=', refundId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (refund === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (refund.status !== 'pending') {
        throw new BadRequestException(
          `Only a pending refund can be retried (refund is ${refund.status})`,
        );
      }
      const order = await this.loadOrder(trx, actor, refund.order_id);
      if (refund.payment_attempt_id === null) {
        throw new BadRequestException('A cash refund has no provider attempt to retry');
      }
      const attempt = await trx
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', refund.payment_attempt_id)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (attempt === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (attempt.provider_reference === null && (await this.hasUnforwardedOfflineRecord(trx, actor, order.id))) {
        throw new RefundBlockedError(
          'offline_unforwarded',
          'Cannot refund an unforwarded offline payment: the PaymentIntent must be forwarded to the provider first',
        );
      }
      if (attempt.provider === 'standalone') {
        throw new BadRequestException(
          'A standalone-terminal refund is manual: complete it with the physical terminal reference',
        );
      }

      const result = await this.payments.getAdapter().refund({
        idempotencyKey: refund.idempotency_key,
        paymentAttemptId: attempt.id,
        amountPence: refund.amount_pence,
      });
      const updated = await this.applyAdapterRefundOutcome(
        trx,
        actor,
        refund,
        attempt,
        result.outcome,
        result,
      );
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'refund.retry',
        entityType: 'refund',
        entityId: refund.id,
        payload: {
          orderId: refund.order_id,
          retryCount: String(updated.retry_count),
          status: updated.status,
        },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------
  // completeManualRefund — D-09 step 5: a manager performs the refund
  // via the provider's Dashboard (or contacts the provider) and records
  // the outcome here with the provider's reference. Only a manager,
  // admin or owner may do it, and only for a refund in manual_escalation
  // or failed state.
  // ------------------------------------------------------------------

  async completeManualRefund(
    actor: Actor,
    input: CompleteManualRefundInput,
  ): Promise<RefundRowWithRetry> {
    if (!actorCanApprove(actor)) {
      throw new ForbiddenException('Only a manager, admin or owner can complete a manual refund');
    }
    return this.db.transaction().execute(async (trx) => {
      const refundsDb = this.refundsDb(trx);
      const refund = await refundsDb
        .selectFrom('refunds')
        .selectAll()
        .where('id', '=', input.refundId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirst();
      if (refund === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (refund.status !== 'manual_escalation' && refund.status !== 'failed') {
        throw new BadRequestException(
          `Only a manual_escalation or failed refund can be completed manually (refund is ${refund.status})`,
        );
      }
      if (input.outcome === 'completed') {
        if (
          input.providerReference === undefined ||
          input.providerReference === null ||
          input.providerReference.trim() === ''
        ) {
          throw new BadRequestException(
            'A manually completed refund requires the provider refund reference',
          );
        }
      }
      const updated = await this.updateRefund(trx, actor, refund, {
        status: input.outcome,
        provider_reference: input.providerReference ?? refund.provider_reference,
        ...(input.outcome === 'failed'
          ? { failure_reason: input.reason ?? refund.failure_reason ?? 'refund_failed' }
          : {}),
      });
      if (input.outcome === 'completed' && refund.payment_attempt_id !== null) {
        await this.markAttemptRefundedIfFullyRefunded(trx, actor, refund.payment_attempt_id);
      }
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType:
          input.outcome === 'completed' ? 'refund.manual_completed' : 'refund.manual_failed',
        entityType: 'refund',
        entityId: refund.id,
        payload: {
          orderId: refund.order_id,
          paymentAttemptId: refund.payment_attempt_id,
          amountPence: refund.amount_pence.toString(),
          providerReference: input.providerReference ?? null,
          reason: input.reason ?? null,
        },
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------
  // returnOrder — partial and full order returns (Arch-02 §6.4).
  //
  // For each returned line the refund is the final price PAID for it
  // (line_total_pence, after all discounts — Arch-10 §3.4), computed
  // cumulatively from the total returned quantity so split returns never
  // drift a penny. BOGO/multibuy lines re-price the remaining units at
  // full price: returning the paid unit voids the free unit's discount.
  // Restock writes a 'return' movement (+qty, balance up); damaged
  // writes a 'return' movement (+qty, goods back) plus a 'damage'
  // write-off (-qty, disposed) — net on-hand change 0. Loyalty earn is
  // reversed per Arch-09 §3.2 (capped at the current balance; a
  // shortfall needs a manager approval). The order becomes
  // partially_returned, or returned when every line is fully returned.
  // ------------------------------------------------------------------

  async returnOrder(actor: Actor, input: ReturnOrderInput): Promise<ReturnOrderResult> {
    if (input.lines.length === 0) {
      throw new BadRequestException('A return must contain at least one line');
    }
    return this.db.transaction().execute(async (trx) => {
      const order = await this.loadOrder(trx, actor, input.orderId);
      if (order.status !== 'completed' && order.status !== 'partially_returned') {
        throw new IllegalOrderTransitionError(
          `Only a completed or partially_returned order can be returned (order is ${order.status})`,
        );
      }

      // Idempotency replay: the same return key returns the original refund.
      if (input.idempotencyKey !== undefined && input.idempotencyKey !== '') {
        const replay = await this.refundsDb(trx)
          .selectFrom('refunds')
          .selectAll()
          .where('tenant_id', '=', actor.tenantId)
          .where('order_id', '=', order.id)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          return {
            order,
            refund: replay,
            refundAmountPence: replay.amount_pence,
            reversedLoyaltyPoints: 0n,
            loyaltyShortfallPoints: 0n,
            replayed: true,
          };
        }
      }

      const orderLines = await trx
        .selectFrom('order_lines')
        .selectAll()
        .where('order_id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
      const lineById = new Map(orderLines.map((line) => [line.id, line]));

      // Qty-kind promotions (BOGO / multibuy) on this order, per line.
      const qtyKindLineIds = await this.qtyKindPromotionLineIds(trx, actor, order.id);

      const warehouseId = await this.defaultWarehouseId(trx, actor, order.location_id);
      let refundTotal = 0n;
      const returnedLines: Array<{
        orderLineId: string;
        variantId: string;
        quantity: bigint;
        disposition: 'restock' | 'damaged';
        refundPence: bigint;
      }> = [];

      for (const requested of input.lines) {
        const line = lineById.get(requested.orderLineId);
        if (line === undefined) {
          throw new NotFoundException('Resource not found');
        }
        if (requested.quantity <= 0n) {
          throw new BadRequestException('Return quantity must be greater than zero');
        }
        const returnedBefore = await this.returnedQuantityForVariant(
          trx,
          actor,
          order.id,
          line.variant_id,
        );
        // Per-variant accounting, capped at this line (see the helper's
        // note on same-variant multi-line orders).
        const returnedBeforeForLine =
          returnedBefore > line.quantity ? line.quantity : returnedBefore;
        const returnedAfterForLine = returnedBeforeForLine + requested.quantity;
        if (returnedAfterForLine > line.quantity) {
          throw new BadRequestException(
            `Cannot return ${requested.quantity} of a line with ${line.quantity - returnedBeforeForLine} remaining (original quantity ${line.quantity})`,
          );
        }

        const refundPence = this.refundableForReturnedQuantity(
          line.line_total_pence,
          line.unit_price_pence,
          line.quantity,
          returnedBeforeForLine,
          returnedAfterForLine,
          qtyKindLineIds.has(line.id),
        );
        refundTotal += refundPence;

        // Stock: restock puts the goods back on the shelf; damaged goods
        // come back and are written off in the same transaction (net
        // on-hand change 0 — see the file-top comment).
        const saleMovement = await trx
          .selectFrom('stock_movements')
          .select('cost_pence_at_movement')
          .where('tenant_id', '=', actor.tenantId)
          .where('order_id', '=', order.id)
          .where('variant_id', '=', line.variant_id)
          .where('cause', '=', 'sale')
          .executeTakeFirst();
        await trx
          .insertInto('stock_movements')
          .values({
            tenant_id: actor.tenantId,
            variant_id: line.variant_id,
            warehouse_id: warehouseId,
            location_id: order.location_id,
            cause: 'return',
            quantity_change: requested.quantity,
            quantity_in_base_units: requested.quantity,
            unit_id: null,
            cost_pence_at_movement: saleMovement?.cost_pence_at_movement ?? null,
            order_id: order.id,
            reference_id: order.id,
            reference_type: 'return',
            created_by_user_id: userIdAsUuid(actor.userId),
          })
          .execute();
        if (requested.disposition === 'restock') {
          await trx
            .updateTable('stock_balances')
            .set({
              quantity_on_hand: sql`quantity_on_hand + ${requested.quantity}`,
              computed_at: sql`now()`,
            })
            .where('variant_id', '=', line.variant_id)
            .where('warehouse_id', '=', warehouseId)
            .execute();
        } else {
          await trx
            .insertInto('stock_movements')
            .values({
              tenant_id: actor.tenantId,
              variant_id: line.variant_id,
              warehouse_id: warehouseId,
              location_id: order.location_id,
              cause: 'damage',
              quantity_change: -requested.quantity,
              quantity_in_base_units: -requested.quantity,
              unit_id: null,
              cost_pence_at_movement: saleMovement?.cost_pence_at_movement ?? null,
              order_id: order.id,
              reference_id: order.id,
              reference_type: 'return_damage_write_off',
              created_by_user_id: userIdAsUuid(actor.userId),
            })
            .execute();
        }

        // A fully returned line voids its promotion applications, so the
        // promotion's usage counts can be corrected (Arch-10 §3.4).
        if (returnedAfterForLine === line.quantity) {
          await trx
            .updateTable('applied_promotions')
            .set({ voided: true, voided_by_user_id: userIdAsUuid(actor.userId) })
            .where('tenant_id', '=', actor.tenantId)
            .where('order_id', '=', order.id)
            .where('order_line_id', '=', line.id)
            .execute();
        }

        returnedLines.push({
          orderLineId: line.id,
          variantId: line.variant_id,
          quantity: requested.quantity,
          disposition: requested.disposition,
          refundPence,
        });
      }

      // Loyalty earn reversal (Arch-09 §3.2) — before the refund, so a
      // shortfall without approval aborts the whole return.
      const loyalty = await this.reverseLoyaltyEarn(
        trx,
        actor,
        order,
        input.approvalEventsId ?? null,
      );

      // The refund: card when the order has an approved card attempt and
      // the caller asked for (or defaulted to) card; cash otherwise.
      let refund: RefundRowWithRetry | null = null;
      if (refundTotal > 0n) {
        const cardAttempt = await trx
          .selectFrom('payment_attempts')
          .selectAll()
          .where('order_id', '=', order.id)
          .where('tenant_id', '=', actor.tenantId)
          .where('status', '=', 'approved')
          .orderBy('created_at', 'asc')
          .executeTakeFirst();
        const method =
          input.refundMethod ?? (cardAttempt !== undefined ? 'card' : 'cash');
        if (method === 'card') {
          if (cardAttempt === undefined) {
            throw new RefundBlockedError(
              'no_card_attempt',
              'A card refund requires an approved card attempt on this order',
            );
          }
          refund = await this.createRefundInTrx(trx, actor, {
            orderId: order.id,
            paymentAttemptId: cardAttempt.id,
            amountPence: refundTotal,
            reason: 'Order return',
            idempotencyKey: input.idempotencyKey ?? randomUUID(),
          });
        } else {
          refund = await this.createRefundInTrx(trx, actor, {
            orderId: order.id,
            paymentAttemptId: null,
            amountPence: refundTotal,
            reason: 'Order return',
            idempotencyKey: input.idempotencyKey ?? randomUUID(),
          });
        }
      }

      // New order status: returned only when every line is fully returned.
      let allReturned = true;
      for (const line of orderLines) {
        const returned = await this.returnedQuantityForVariant(
          trx,
          actor,
          order.id,
          line.variant_id,
        );
        if (returned < line.quantity) {
          allReturned = false;
          break;
        }
      }
      const newStatus = allReturned ? 'returned' : 'partially_returned';
      const updatedOrder = await trx
        .updateTable('orders')
        .set({ status: newStatus })
        .where('id', '=', order.id)
        .where('tenant_id', '=', actor.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'order.returned',
        entityType: 'order',
        entityId: order.id,
        payload: {
          newStatus,
          refundId: refund?.id ?? null,
          refundAmountPence: refundTotal.toString(),
          reversedLoyaltyPoints: loyalty.reversed.toString(),
          loyaltyShortfallPoints: loyalty.shortfall.toString(),
          lines: returnedLines.map((line) => ({
            orderLineId: line.orderLineId,
            quantity: line.quantity.toString(),
            disposition: line.disposition,
            refundPence: line.refundPence.toString(),
          })),
        },
      });

      return {
        order: updatedOrder,
        refund,
        refundAmountPence: refundTotal,
        reversedLoyaltyPoints: loyalty.reversed,
        loyaltyShortfallPoints: loyalty.shortfall,
      };
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** Tenant- AND location-scoped order load; anything else is 404 (G-B). */
  private async loadOrder(q: Kysely<DB>, actor: Actor, orderId: string): Promise<OrderRow> {
    const order = await q
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId)
      .executeTakeFirst();
    if (order === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return order;
  }

  /**
   * Completed orders are immutable: refuse ANY mutating call on one with
   * IllegalOrderTransitionError before touching the DB. The DB trigger
   * trg_orders_completed_immutable is the backstop.
   */
  private requireOrderNotCompleted(order: OrderRow, action: string): void {
    if (order.status === 'completed') {
      throw new IllegalOrderTransitionError(
        `Completed order ${order.id} is immutable and cannot be used to ${action}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Age verification helpers (Build-09, Objective 2).
  // ------------------------------------------------------------------

  /**
   * Restricted variants on an order: every order line whose variant has
   * an age_restrictions row. A row restricts the variant when
   * challenge_25 is true OR a minimum age is set (min_age_years is
   * NOT NULL, so any row restricts — the condition is kept explicit).
   */
  private async restrictedVariantsForOrder(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
  ): Promise<Map<string, { requiresChallenge25: boolean; minAge: number | null }>> {
    const rows = await trx
      .selectFrom('order_lines')
      .leftJoin('age_restrictions', (join) =>
        join
          .onRef('age_restrictions.variant_id', '=', 'order_lines.variant_id')
          .onRef('age_restrictions.tenant_id', '=', 'order_lines.tenant_id'),
      )
      .select([
        'order_lines.variant_id as variantId',
        'age_restrictions.challenge_25 as challenge25',
        'age_restrictions.min_age_years as minAgeYears',
      ])
      .where('order_lines.order_id', '=', orderId)
      .where('order_lines.tenant_id', '=', actor.tenantId)
      .execute();
    const restricted = new Map<string, { requiresChallenge25: boolean; minAge: number | null }>();
    for (const row of rows) {
      if (row.minAgeYears === null && row.challenge25 !== true) continue;
      restricted.set(row.variantId, {
        requiresChallenge25: row.challenge25 === true,
        minAge: row.minAgeYears,
      });
    }
    return restricted;
  }

  /** Highest verified threshold already recorded per variant on an order. */
  private async persistedVerificationThresholds(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
  ): Promise<Map<string, number>> {
    const rows = await trx
      .selectFrom('age_verification_events')
      .select(['variant_id', 'verified_age_years'])
      .where('order_id', '=', orderId)
      .where('tenant_id', '=', actor.tenantId)
      .where('outcome', '=', 'verified')
      .execute();
    const thresholds = new Map<string, number>();
    for (const row of rows) {
      const existing = thresholds.get(row.variant_id) ?? 0;
      if (row.verified_age_years > existing) thresholds.set(row.variant_id, row.verified_age_years);
    }
    return thresholds;
  }

  /**
   * Record supplied verifications as age_verification_events
   * (method 'manual_confirmation', outcome 'verified') plus one audit
   * entry per variant. A variant that already has a verified event on
   * this order is not recorded twice — a re-supplied verification is
   * idempotent. The client's verified_at is persisted into
   * age_verification_events.verified_at when supplied (Build-11
   * Objective 2 — an offline verification flushed hours later keeps
   * its original till timestamp); when the client supplies none, the
   * column is omitted and the DB default (NOW()) applies. The audit
   * payload carries the same timestamp (null when none was supplied).
   */
  private async recordAgeVerifications(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
    verifications: AgeVerificationInput[],
  ): Promise<void> {
    if (verifications.length === 0) return;
    const persisted = await this.persistedVerificationThresholds(trx, actor, orderId);
    for (const verification of verifications) {
      if (persisted.has(verification.variantId)) continue;
      await trx
        .insertInto('age_verification_events')
        .values({
          tenant_id: actor.tenantId,
          order_id: orderId,
          variant_id: verification.variantId,
          verified_age_years: verification.verifiedAgeThreshold,
          method: 'manual_confirmation',
          outcome: 'verified',
          verified_by_user_id: verification.verifiedByUserId,
          ...(verification.verifiedAt !== null ? { verified_at: verification.verifiedAt } : {}),
        })
        .execute();
      persisted.set(verification.variantId, verification.verifiedAgeThreshold);
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'age_verification.recorded',
        entityType: 'order',
        entityId: orderId,
        payload: {
          variantId: verification.variantId,
          verifiedAgeThreshold: String(verification.verifiedAgeThreshold),
          verifiedByUserId: verification.verifiedByUserId,
          verifiedAt: verification.verifiedAt?.toISOString() ?? null,
        },
      });
    }
  }

  /**
   * Enforce Challenge 25 for an order: every restricted line needs a
   * verification meeting the threshold — supplied with this call or
   * already recorded on the order. Throws 422 naming the uncovered
   * variants. Callers invoke this BEFORE any stock movement or payment
   * completion, so a rejection leaves the order exactly as it was.
   */
  private async assertAgeVerified(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
    supplied: AgeVerificationInput[],
  ): Promise<void> {
    const restricted = await this.restrictedVariantsForOrder(trx, actor, orderId);
    if (restricted.size === 0) return;
    const persisted = await this.persistedVerificationThresholds(trx, actor, orderId);
    const missing: string[] = [];
    for (const variantId of restricted.keys()) {
      const suppliedHit = supplied.some(
        (v) => v.variantId === variantId && v.verifiedAgeThreshold >= CHALLENGE_25_THRESHOLD,
      );
      const persistedHit = (persisted.get(variantId) ?? 0) >= CHALLENGE_25_THRESHOLD;
      if (!suppliedHit && !persistedHit) missing.push(variantId);
    }
    if (missing.length > 0) {
      throw new AgeVerificationRequiredException(missing);
    }
  }

  /** Compliance inspection: the stored verification events for an order. */
  async listAgeVerifications(actor: Actor, orderId: string): Promise<AgeVerificationView[]> {
    const order = await this.loadOrder(this.db, actor, orderId);
    const rows = await this.db
      .selectFrom('age_verification_events')
      .selectAll()
      .where('order_id', '=', order.id)
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      variant_id: row.variant_id,
      verified_age_threshold: row.verified_age_years,
      verified_by_user_id: row.verified_by_user_id,
      verified_at: row.verified_at.toISOString(),
      created_at: row.created_at.toISOString(),
      method: row.method,
      outcome: row.outcome,
    }));
  }

  /** True once the order has any tender or payment attempt (void gate). */
  private async hasTenderStarted(
    trx: Kysely<DB>,
    actor: Actor,
    order: OrderRow,
  ): Promise<boolean> {
    const tender = await trx
      .selectFrom('order_tenders')
      .select('id')
      .where('order_id', '=', order.id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (tender !== undefined) {
      return true;
    }
    const attempt = await trx
      .selectFrom('payment_attempts')
      .select('id')
      .where('order_id', '=', order.id)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    return attempt !== undefined;
  }

  /** The refunds table with the migration 012 retry columns (see
   * refund-retry-schema.ts — the coordinator merges these into schema.ts). */
  private refundsDb(trx: Kysely<DB>): Kysely<DBWithRefundRetry> {
    return trx as unknown as Kysely<DBWithRefundRetry>;
  }

  /** Sum of non-failed refunds already made against one attempt (G-A-15). */
  private async refundedTotalForAttempt(
    trx: Kysely<DB>,
    actor: Actor,
    paymentAttemptId: string,
  ): Promise<bigint> {
    const result = await sql<{ total: string | bigint | null }>`
      SELECT COALESCE(SUM(amount_pence), 0) AS total FROM refunds
      WHERE tenant_id = ${actor.tenantId} AND payment_attempt_id = ${paymentAttemptId}
        AND status IN ('pending', 'completed', 'manual_escalation')
    `.execute(trx);
    const total = result.rows[0]?.total;
    return total == null ? 0n : BigInt(total);
  }

  /** Sum of non-failed refunds already made against one order. */
  private async refundedTotalForOrder(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
  ): Promise<bigint> {
    const result = await sql<{ total: string | bigint | null }>`
      SELECT COALESCE(SUM(amount_pence), 0) AS total FROM refunds
      WHERE tenant_id = ${actor.tenantId} AND order_id = ${orderId}
        AND status IN ('pending', 'completed', 'manual_escalation')
    `.execute(trx);
    const total = result.rows[0]?.total;
    return total == null ? 0n : BigInt(total);
  }

  /**
   * G-A-16: an unforwarded offline PaymentIntent exists for this order —
   * an offline_payment_records row with status 'pending_forward' and
   * forwarded_at NULL. (payment_attempts carries no is_offline column;
   * see the file-top comment.)
   */
  private async hasUnforwardedOfflineRecord(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom('offline_payment_records')
      .select('id')
      .where('tenant_id', '=', actor.tenantId)
      .where('order_id', '=', orderId)
      .where('status', '=', 'pending_forward')
      .where('forwarded_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Update a refund row (retry columns included) and return it. */
  private async updateRefund(
    trx: Kysely<DB>,
    actor: Actor,
    refund: RefundRowWithRetry,
    patch: Partial<{
      status: 'pending' | 'completed' | 'failed' | 'manual_escalation';
      provider_reference: string | null;
      retry_count: number;
      next_retry_at: Date | null;
      failure_reason: string | null;
    }>,
  ): Promise<RefundRowWithRetry> {
    return this.refundsDb(trx)
      .updateTable('refunds')
      .set(patch)
      .where('id', '=', refund.id)
      .where('tenant_id', '=', actor.tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Map a provider refund outcome onto the D-09 state machine
   * (Arch-02 §6.4 steps 3–6):
   *  - completed → refund completed; the attempt becomes 'refunded'
   *    when the refund now covers its full amount;
   *  - pending → stays queued for the provider;
   *  - failed_provider_unavailable → queued with exponential backoff;
   *    the 5th failed attempt escalates instead;
   *  - failed_insufficient_balance → straight to manual_escalation
   *    with the top-up instruction; NEVER retried;
   *  - failed (generic) → failed with the reason, for manager review.
   */
  private async applyAdapterRefundOutcome(
    trx: Kysely<DB>,
    actor: Actor,
    refund: RefundRowWithRetry,
    attempt: PaymentAttemptRow,
    outcome: 'completed' | 'pending' | 'failed_insufficient_balance' | 'failed_provider_unavailable' | 'failed',
    result: { providerReference: string | null; failureReason?: string | null },
  ): Promise<RefundRowWithRetry> {
    switch (outcome) {
      case 'completed': {
        const updated = await this.updateRefund(trx, actor, refund, {
          status: 'completed',
          provider_reference: result.providerReference,
          failure_reason: null,
        });
        await this.markAttemptRefundedIfFullyRefunded(trx, actor, attempt.id);
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'refund.completed',
          entityType: 'refund',
          entityId: refund.id,
          payload: {
            orderId: refund.order_id,
            paymentAttemptId: attempt.id,
            amountPence: refund.amount_pence.toString(),
            providerReference: result.providerReference ?? null,
          },
        });
        return updated;
      }
      case 'pending': {
        return this.updateRefund(trx, actor, refund, { status: 'pending' });
      }
      case 'failed_provider_unavailable': {
        const nextCount = refund.retry_count + 1;
        if (nextCount >= MAX_REFUND_ATTEMPTS) {
          const escalated = await this.updateRefund(trx, actor, refund, {
            status: 'manual_escalation',
            retry_count: nextCount,
            next_retry_at: null,
            failure_reason: 'provider_unavailable',
          });
          await this.audit.record(trx, {
            tenantId: actor.tenantId,
            userId: actor.userId,
            eventType: 'refund.escalated',
            entityType: 'refund',
            entityId: refund.id,
            payload: {
              orderId: refund.order_id,
              paymentAttemptId: attempt.id,
              amountPence: refund.amount_pence.toString(),
              failureReason: 'provider_unavailable',
              retryCount: String(nextCount),
              nextAction:
                'Retry queue exhausted (5 attempts). Manager completes the refund via the provider Dashboard and records the provider reference.',
            },
          });
          return escalated;
        }
        return this.updateRefund(trx, actor, refund, {
          status: 'pending',
          retry_count: nextCount,
          next_retry_at: new Date(
            Date.now() + (REFUND_RETRY_DELAYS_MS[nextCount - 1] as number),
          ),
          failure_reason: 'provider_unavailable',
        });
      }
      case 'failed_insufficient_balance': {
        // Arch-02 §6.4 step 6: the merchant's provider balance is zero
        // (or account debits are disabled). Never blindly retried.
        const escalated = await this.updateRefund(trx, actor, refund, {
          status: 'manual_escalation',
          failure_reason: 'insufficient_balance',
          next_retry_at: null,
        });
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'refund.escalated',
          entityType: 'refund',
          entityId: refund.id,
          payload: {
            orderId: refund.order_id,
            paymentAttemptId: attempt.id,
            amountPence: refund.amount_pence.toString(),
            failureReason: 'insufficient_balance',
            nextAction:
              'Top up the provider balance or enable account debits, then complete the refund via the provider Dashboard and record the provider reference.',
          },
        });
        return escalated;
      }
      case 'failed': {
        const failed = await this.updateRefund(trx, actor, refund, {
          status: 'failed',
          failure_reason: result.failureReason ?? 'refund_failed',
        });
        await this.audit.record(trx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          eventType: 'refund.failed',
          entityType: 'refund',
          entityId: refund.id,
          payload: {
            orderId: refund.order_id,
            paymentAttemptId: attempt.id,
            amountPence: refund.amount_pence.toString(),
            failureReason: result.failureReason ?? 'refund_failed',
            routedTo: 'manual_escalation',
          },
        });
        return failed;
      }
    }
  }

  /** Mark an attempt 'refunded' once refunds cover its full amount. */
  private async markAttemptRefundedIfFullyRefunded(
    trx: Kysely<DB>,
    actor: Actor,
    paymentAttemptId: string,
  ): Promise<void> {
    const attempt = await trx
      .selectFrom('payment_attempts')
      .selectAll()
      .where('id', '=', paymentAttemptId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (attempt === undefined || attempt.status === 'refunded') {
      return;
    }
    const refunded = await this.refundedTotalForAttempt(trx, actor, paymentAttemptId);
    if (refunded >= attempt.amount_pence) {
      await trx
        .updateTable('payment_attempts')
        .set({ status: 'refunded' })
        .where('id', '=', paymentAttemptId)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
    }
  }

  /** Order-line ids carrying a BOGO or multibuy promotion (qty-kind). */
  private async qtyKindPromotionLineIds(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
  ): Promise<Set<string>> {
    const rows = await trx
      .selectFrom('applied_promotions')
      .innerJoin('promotions', 'promotions.id', 'applied_promotions.promotion_id')
      .select('applied_promotions.order_line_id')
      .where('applied_promotions.tenant_id', '=', actor.tenantId)
      .where('applied_promotions.order_id', '=', orderId)
      .where('promotions.type', 'in', ['bogo', 'multibuy'])
      .execute();
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.order_line_id !== null) {
        ids.add(row.order_line_id);
      }
    }
    return ids;
  }

  /**
   * Quantity of a variant already returned on this order (restock and
   * damaged alike — both write a 'return' movement; the damage write-off
   * is a separate 'damage' movement). LIMITATION (documented): tracking
   * is per variant, not per order line — an order with the same variant
   * on two lines allocates returns FIFO to the earliest line. The
   * pilot's normal case (one line per variant) is exact.
   */
  private async returnedQuantityForVariant(
    trx: Kysely<DB>,
    actor: Actor,
    orderId: string,
    variantId: string,
  ): Promise<bigint> {
    const result = await sql<{ total: string | bigint | null }>`
      SELECT COALESCE(SUM(quantity_change), 0) AS total FROM stock_movements
      WHERE tenant_id = ${actor.tenantId} AND order_id = ${orderId}
        AND variant_id = ${variantId} AND cause = 'return'
    `.execute(trx);
    const total = result.rows[0]?.total;
    return total == null ? 0n : BigInt(total);
  }

  /**
   * Cumulative refundable amount for a line once `returnedQty` units
   * have been returned (Arch-10 §3.4). The per-call refund is
   * refundable(after) − refundable(before), so split returns never drift.
   *  - Ordinary lines: pro-rata by quantity on the final price paid
   *    (line_total_pence already carries the D-14 basket allocation),
   *    round half up (D-13).
   *  - BOGO / multibuy lines: the remaining units are re-priced at full
   *    price — returning the paid unit voids the free unit's discount,
   *    so refundable = line total − (remaining units × unit price),
   *    floored at zero. Returning one unit of a buy-1-get-1-free pair
   *    therefore refunds nothing; returning both refunds the full price.
   */
  private refundableForReturnedQuantity(
    lineTotalPence: bigint,
    unitPricePence: bigint,
    lineQuantity: bigint,
    returnedBefore: bigint,
    returnedAfter: bigint,
    isQtyKindPromotion: boolean,
  ): bigint {
    const refundable = (returnedQty: bigint): bigint => {
      if (isQtyKindPromotion) {
        const remaining = lineQuantity - returnedQty;
        const value = lineTotalPence - remaining * unitPricePence;
        return value > 0n ? value : 0n;
      }
      return divRoundHalfUp(lineTotalPence * returnedQty, lineQuantity);
    };
    return refundable(returnedAfter) - refundable(returnedBefore);
  }

  /**
   * Loyalty earn reversal (Arch-09 §3.2 step 5). Earn rows for the order
   * are reversed with a 'correction' ledger row (negative points,
   * reverses_ledger_id pointing at the original earn), CAPPED at the
   * current balance — the balance can never go negative. A shortfall
   * (points already redeemed) needs a manager refund_above_threshold
   * approval and is recorded as a separate zero-point correction row
   * with the reason, for the manager to resolve.
   */
  private async reverseLoyaltyEarn(
    trx: Kysely<DB>,
    actor: Actor,
    order: OrderRow,
    approvalEventsId: string | null,
  ): Promise<{ reversed: bigint; shortfall: bigint }> {
    if (order.customer_id === null) {
      return { reversed: 0n, shortfall: 0n };
    }
    const membership = await trx
      .selectFrom('loyalty_memberships')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('customer_id', '=', order.customer_id)
      .executeTakeFirst();
    if (membership === undefined) {
      return { reversed: 0n, shortfall: 0n };
    }
    const earns = await trx
      .selectFrom('loyalty_ledger')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('customer_id', '=', order.customer_id)
      .where('order_id', '=', order.id)
      .where('kind', '=', 'earn')
      .execute();
    if (earns.length === 0) {
      return { reversed: 0n, shortfall: 0n };
    }
    const earned = earns.reduce((sum, row) => sum + row.points, 0n);
    if (earned <= 0n) {
      return { reversed: 0n, shortfall: 0n };
    }
    const balance = await this.ledgerPointsSum(trx, actor, order.customer_id);
    const reversed = earned < balance ? earned : balance;
    const shortfall = earned - reversed;
    if (shortfall > 0n) {
      const approvalOk =
        approvalEventsId !== null &&
        approvalEventsId !== '' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          approvalEventsId,
        ) &&
        (await this.approvals.hasApproval(trx, {
          tenantId: actor.tenantId,
          approvalEventsId,
          action: 'refund_above_threshold',
        }));
      if (!approvalOk) {
        throw new BadRequestException(
          `Loyalty earn reversal has a shortfall of ${shortfall} points already redeemed; a manager refund_above_threshold approval is required`,
        );
      }
    }
    const firstEarn = earns[0] as (typeof earns)[number];
    if (reversed > 0n) {
      await trx
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: actor.tenantId,
          customer_id: order.customer_id,
          membership_id: membership.id,
          kind: 'correction',
          points: -reversed,
          order_id: order.id,
          reason: `Loyalty earn reversal for return of order ${order.id}`,
          idempotency_key: randomUUID(),
          reverses_ledger_id: firstEarn.id,
        })
        .execute();
    }
    if (shortfall > 0n) {
      await trx
        .insertInto('loyalty_ledger')
        .values({
          tenant_id: actor.tenantId,
          customer_id: order.customer_id,
          membership_id: membership.id,
          kind: 'correction',
          points: 0n,
          order_id: order.id,
          reason: `Loyalty earn shortfall: ${shortfall} points already redeemed — manager to resolve`,
          idempotency_key: randomUUID(),
          reverses_ledger_id: firstEarn.id,
        })
        .execute();
    }
    return { reversed, shortfall };
  }

  /** The location's default warehouse (fallback: any warehouse there). */
  private async defaultWarehouseId(
    q: Kysely<DB>,
    actor: Actor,
    locationId: string,
  ): Promise<string> {
    const warehouse = await q
      .selectFrom('warehouses')
      .select('id')
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', locationId)
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    if (warehouse === undefined) {
      throw new BadRequestException('No warehouse configured for this location');
    }
    return warehouse.id;
  }

  /**
   * Reverse the stock reserved/sold for an order: one compensating
   * 'adjustment' movement per 'sale' movement (exact reverse), the
   * read-model balances restored, and any serials marked sold on the
   * order returned to 'in_stock'. stock_valuation is untouched — the
   * sale decrement does not touch it either, so the reversal mirrors
   * the decrement exactly.
   */
  private async reverseStockForOrder(
    trx: Kysely<DB>,
    actor: Actor,
    order: OrderRow,
  ): Promise<void> {
    const sales = await trx
      .selectFrom('stock_movements')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('order_id', '=', order.id)
      .where('cause', '=', 'sale')
      .execute();
    for (const movement of sales) {
      const quantity = -movement.quantity_change;
      if (quantity <= 0n) {
        continue;
      }
      const warehouseId = movement.warehouse_id;
      if (warehouseId === null) {
        continue;
      }
      await trx
        .insertInto('stock_movements')
        .values({
          tenant_id: actor.tenantId,
          variant_id: movement.variant_id,
          warehouse_id: warehouseId,
          location_id: movement.location_id,
          cause: 'adjustment',
          quantity_change: quantity,
          quantity_in_base_units:
            movement.quantity_in_base_units === null
              ? quantity
              : -movement.quantity_in_base_units,
          unit_id: movement.unit_id,
          cost_pence_at_movement: movement.cost_pence_at_movement,
          order_id: order.id,
          reference_id: order.id,
          reference_type: 'sale_reversal',
          created_by_user_id: userIdAsUuid(actor.userId),
        })
        .execute();
      await trx
        .updateTable('stock_balances')
        .set({
          quantity_on_hand: sql`quantity_on_hand + ${quantity}`,
          computed_at: sql`now()`,
        })
        .where('variant_id', '=', movement.variant_id)
        .where('warehouse_id', '=', warehouseId)
        .execute();
    }
    await trx
      .updateTable('serial_numbers')
      .set({ status: 'in_stock', order_id: null })
      .where('tenant_id', '=', actor.tenantId)
      .where('order_id', '=', order.id)
      .where('status', '=', 'sold')
      .execute();
  }

  /** Gift-card tender: lock the card, check status/balance, redeem. */
  private async redeemGiftCard(
    trx: Kysely<DB>,
    actor: Actor,
    order: OrderRow,
    input: AddTenderInput,
  ): Promise<void> {
    if (input.giftCardCode === undefined || input.giftCardCode === '') {
      throw new BadRequestException('giftCardCode is required for a gift_card tender');
    }
    const codeHash = createHash('sha256').update(input.giftCardCode).digest('hex');
    const card = await trx
      .selectFrom('gift_cards')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('code_hash', '=', codeHash)
      .forUpdate()
      .executeTakeFirst();
    if (card === undefined) {
      throw new NotFoundException('Resource not found');
    }
    if (card.status !== 'active') {
      throw new BadRequestException(`Gift card is ${card.status}`);
    }
    if (card.balance_pence < input.amountPence) {
      throw new BadRequestException('Gift card balance is insufficient');
    }
    const newBalance = card.balance_pence - input.amountPence;
    // Redeem is a NEGATIVE ledger amount (signed-ledger convention, see
    // the top of this file): balance = SUM(amount_pence).
    await trx
      .insertInto('gift_card_ledger')
      .values({
        tenant_id: actor.tenantId,
        gift_card_id: card.id,
        kind: 'redeem',
        amount_pence: -input.amountPence,
        order_id: order.id,
        idempotency_key: randomUUID(),
      })
      .execute();
    await trx
      .updateTable('gift_cards')
      .set({
        balance_pence: newBalance,
        ...(newBalance === 0n ? { status: 'redeemed' as const } : {}),
      })
      .where('id', '=', card.id)
      .execute();
  }

  /** Store-credit tender: balance = SUM(store_credit_ledger.amount_pence). */
  private async redeemStoreCredit(
    trx: Kysely<DB>,
    actor: Actor,
    order: OrderRow,
    input: AddTenderInput,
  ): Promise<void> {
    const customerId = input.customerId ?? order.customer_id ?? null;
    if (customerId === null) {
      throw new BadRequestException('customerId is required for a store_credit tender');
    }
    await this.requireCustomer(trx, actor, customerId);
    const balance = await this.ledgerSum(trx, actor, customerId);
    if (balance < input.amountPence) {
      throw new BadRequestException('Store credit balance is insufficient');
    }
    await trx
      .insertInto('store_credit_ledger')
      .values({
        tenant_id: actor.tenantId,
        customer_id: customerId,
        kind: 'redeem',
        amount_pence: -input.amountPence,
        order_id: order.id,
        idempotency_key: randomUUID(),
      })
      .execute();
  }

  /**
   * Loyalty-points tender: balance = SUM(loyalty_ledger.points);
   * 1 point = 1p (design decision — the earn rate is Phase 2).
   */
  private async redeemLoyaltyPoints(
    trx: Kysely<DB>,
    actor: Actor,
    order: OrderRow,
    input: AddTenderInput,
  ): Promise<void> {
    const customerId = input.customerId ?? order.customer_id ?? null;
    if (customerId === null) {
      throw new BadRequestException('customerId is required for a loyalty_points tender');
    }
    await this.requireCustomer(trx, actor, customerId);
    const membership = await trx
      .selectFrom('loyalty_memberships')
      .selectAll()
      .where('tenant_id', '=', actor.tenantId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (membership === undefined) {
      throw new BadRequestException('Customer has no loyalty membership');
    }
    if (membership.status !== 'active') {
      throw new BadRequestException(`Loyalty membership is ${membership.status}`);
    }
    const balance = await this.ledgerPointsSum(trx, actor, customerId);
    if (balance < input.amountPence * LOYALTY_POINTS_PER_PENCE) {
      throw new BadRequestException('Loyalty points balance is insufficient');
    }
    await trx
      .insertInto('loyalty_ledger')
      .values({
        tenant_id: actor.tenantId,
        customer_id: customerId,
        membership_id: membership.id,
        kind: 'redeem',
        points: -input.amountPence * LOYALTY_POINTS_PER_PENCE,
        order_id: order.id,
        reason: null,
        idempotency_key: randomUUID(),
        reverses_ledger_id: null,
      })
      .execute();
  }

  private async requireCustomer(
    trx: Kysely<DB>,
    actor: Actor,
    customerId: string,
  ): Promise<void> {
    const customer = await trx
      .selectFrom('customers')
      .select('id')
      .where('id', '=', customerId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (customer === undefined) {
      throw new NotFoundException('Resource not found');
    }
  }

  /** SUM(amount_pence) for the per-customer signed store-credit ledger. */
  private async ledgerSum(
    trx: Kysely<DB>,
    actor: Actor,
    customerId: string,
  ): Promise<bigint> {
    const result = await sql<{ total: string | bigint | null }>`
      SELECT COALESCE(SUM(amount_pence), 0) AS total FROM store_credit_ledger
      WHERE tenant_id = ${actor.tenantId} AND customer_id = ${customerId}
    `.execute(trx);
    const total = result.rows[0]?.total;
    return total == null ? 0n : BigInt(total);
  }

  /** SUM(points) for the loyalty ledger. */
  private async ledgerPointsSum(
    trx: Kysely<DB>,
    actor: Actor,
    customerId: string,
  ): Promise<bigint> {
    const result = await sql<{ total: string | bigint | null }>`
      SELECT COALESCE(SUM(points), 0) AS total FROM loyalty_ledger
      WHERE tenant_id = ${actor.tenantId} AND customer_id = ${customerId}
    `.execute(trx);
    const total = result.rows[0]?.total;
    return total == null ? 0n : BigInt(total);
  }

  private async buildReceiptView(
    q: Kysely<DB>,
    order: OrderRow,
    receipt: ReceiptRow,
  ): Promise<ReceiptView> {
    const vatLines = await q
      .selectFrom('receipt_vat_lines')
      .selectAll()
      .where('receipt_id', '=', receipt.id)
      .orderBy('tax_rate_kind', 'asc')
      .execute();
    return {
      receiptNumber: receipt.receipt_number,
      orderId: receipt.order_id,
      issuedAt: receipt.issued_at,
      lines: vatLines.map((line) => ({
        taxRateKind: line.tax_rate_kind,
        taxRatePercent: line.tax_rate_percent,
        grossPence: line.gross_pence,
        vatPence: line.vat_pence,
        netPence: line.net_pence,
      })),
      totalPence: order.total_pence,
      vatInvoiceNotice: receipt.vat_invoice_notice,
    };
  }
}
