/**
 * SyncService — server side of the register delta-sync (Build-04,
 * Objective 1; Arch-04 §4.2, Arch-02 §6).
 *
 *   POST /v1/sync/handshake — server time, tenant/register state, and
 *     the catalogue delta the register needs (variants changed since the
 *     register's last sync, tax rates, active price-book entries, the
 *     tenant's barcode mode, cached stock levels as a display hint).
 *   POST /v1/sync/flush — replays queued offline cash orders in the
 *     order the client sends them (the client sends FIFO, created_at
 *     ASC). Each order is replayed through the existing
 *     SalesService/InventoryService paths with the order's original
 *     idempotency key, so a retried flush replays instead of double-
 *     selling.
 *
 * PRICE RULE (commission: "price changes while offline honor the
 * client's snapshotted sale price"): the server reprices the basket at
 * current prices (the repricing is authoritative for VAT — tax is
 * snapshotted per line at sale, D-13). When the server total EXCEEDS
 * the snapshot total, the difference is bridged with a D-14 basket
 * discount so the created order totals EXACTLY the snapshot amount the
 * customer paid in cash, and a non-blocking discrepancy warning is
 * recorded. When the server total is LOWER than the snapshot, the
 * order totals the server price and the cash overpayment is recorded
 * as a warning (the excess stays in the till and must be reconciled
 * at close — the register cannot refund cash it has already taken
 * without a manager decision, and inventing a negative discount to
 * raise the price would falsify the VAT record).
 *
 * STOCK RULE (commission: "stock shortfalls on offline cash sales
 * still accept the completed physical cash exchange"): when the normal
 * decrement throws InsufficientStockError, the flush does NOT void the
 * sale. Instead it writes, per short line, a 'sale' movement for the
 * quantity actually on hand plus a stock_movements row with
 * cause = 'offline_sync_conflict' for the shortfall, completes the
 * order, and records a hash-chained audit alert
 * ('sync.offline_stock_conflict') carrying the shortfall. DESIGN
 * DECISION (not a research fact): stock_balances has a CHECK
 * (quantity_on_hand >= 0), so the read-model balance floors at 0
 * while the append-only ledger carries the true negative shortfall —
 * the ledger and the read model diverge by exactly the shortfall
 * amount until the next goods-in, and the divergence is visible in
 * the audit alert rather than hidden. The alternative (refusing the
 * completed cash sale) would strand real money taken from a real
 * customer.
 *
 * IDEMPOTENCY: the orders table has no idempotency column, so a
 * flushed order is recorded in the append-only audit log
 * (event_type 'sync.order_flushed', payload.idempotencyKey). A flush
 * carrying a key already in that log returns the stored outcome with
 * status 'replayed' and creates no second order.
 *
 * Tenant isolation (G-B): the register must belong to the actor's
 * tenant and location; anything else is NotFoundException, never 403.
 * Offline orders are CASH ONLY — the register enforces that client-
 * side (D-06 deferred) and this service accepts only cash tenders in
 * a flush; a payload tender is never trusted from the wire.
 */
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { userIdAsUuid } from '../../common/uuid';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import {
  SalesService,
  AgeVerificationRequiredException,
  IllegalOrderTransitionError,
  SplitTimeoutError,
  TenderNotApprovedError,
  TenderSumMismatchError,
  UnknownPaymentBlockedError,
  type ReceiptView,
} from '../sales/sales.service';
import { CatalogueService } from '../catalogue/catalogue.service';
import { InsufficientStockError } from '../inventory/inventory.service';
import { AuditService } from '../admin/audit.service';
import type {
  CatalogueDelta,
  CatalogueDeltaVariant,
  FlushOrder,
  FlushOrderOutcome,
  FlushRequest,
  FlushResponse,
  HandshakeRequest,
  HandshakeResponse,
} from './sync.dto';

interface FlushedOutcomeRow {
  orderId: string | null;
  receiptNumber: string | null;
  orderTotalPence: string | null;
  status: string;
  warnings: string[];
  conflict: FlushOrderOutcome['conflict'];
}

/**
 * Human-readable message for a failed flush outcome (Build-10
 * Objective 3). Nest's HttpException sets `.message` from the
 * TOP-level response body — for a structured domain exception like
 * AgeVerificationRequiredException (`{ error: { code, message } }`)
 * there is no top-level message, so `.message` degrades to the
 * split class name ("Age Verification Required Exception"). That is
 * what the Build-09 note recorded. Prefer the nested structured
 * message instead, then a standard Nest `{ message }` body, then a
 * string response, then the error's own message.
 */
export function syncErrorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const nested = (response as { error?: unknown }).error;
      if (
        typeof nested === 'object' &&
        nested !== null &&
        typeof (nested as { message?: unknown }).message === 'string'
      ) {
        return (nested as { message: string }).message;
      }
      if (typeof (response as { message?: unknown }).message === 'string') {
        return (response as { message: string }).message;
      }
    }
    if (typeof response === 'string') return response;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Structured domain error code for a failed flush outcome (Build-10
 * Objective 3). The flush must never surface only an exception class
 * name (the Build-09 note: the 'failed' outcome string carried
 * "AgeVerificationRequiredException", not the AGE_VERIFICATION_REQUIRED
 * code the register can branch on).
 *
 * Mapping table — first match wins:
 *   - A Nest HttpException carrying a structured `{ error: { code } }`
 *     body (AgeVerificationRequiredException → AGE_VERIFICATION_REQUIRED)
 *     yields that code verbatim.
 *   - Any other HttpException maps by status: 400 BAD_REQUEST,
 *     401 UNAUTHORIZED, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT,
 *     422 UNPROCESSABLE_ENTITY, anything else INTERNAL_ERROR.
 *   - InsufficientStockError → INSUFFICIENT_STOCK (reachable when
 *     the stock-conflict path itself fails, or completeOrder throws
 *     it after the conflict path ran).
 *   - IllegalOrderTransitionError → ILLEGAL_ORDER_TRANSITION,
 *     SplitTimeoutError → SPLIT_TIMEOUT, TenderSumMismatchError →
 *     TENDER_SUM_MISMATCH, TenderNotApprovedError →
 *     TENDER_NOT_APPROVED, UnknownPaymentBlockedError →
 *     UNKNOWN_PAYMENT.
 *   - Any other error carrying a string `.code` (e.g.
 *     RefundBlockedError) yields that code.
 *   - Everything else → INTERNAL_ERROR (never the class name, never
 *     an empty string).
 *
 * The early validation failures in flushOne (not exceptions) have
 * their own codes: LOCATION_MISMATCH, EMPTY_ORDER, INVALID_TOTAL,
 * SNAPSHOT_MISMATCH.
 */
export function syncErrorCode(error: unknown): string {
  // Named first: the most important flush failure, explicit rather
  // than relying on the generic HttpException body below.
  if (error instanceof AgeVerificationRequiredException) return 'AGE_VERIFICATION_REQUIRED';
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const nested = (response as { error?: unknown }).error;
      if (
        typeof nested === 'object' &&
        nested !== null &&
        typeof (nested as { code?: unknown }).code === 'string' &&
        ((nested as { code: string }).code.length > 0)
      ) {
        return (nested as { code: string }).code;
      }
    }
    switch (error.getStatus()) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      default:
        return 'INTERNAL_ERROR';
    }
  }
  if (error instanceof InsufficientStockError) return 'INSUFFICIENT_STOCK';
  if (error instanceof IllegalOrderTransitionError) return 'ILLEGAL_ORDER_TRANSITION';
  if (error instanceof SplitTimeoutError) return 'SPLIT_TIMEOUT';
  if (error instanceof TenderSumMismatchError) return 'TENDER_SUM_MISMATCH';
  if (error instanceof TenderNotApprovedError) return 'TENDER_NOT_APPROVED';
  if (error instanceof UnknownPaymentBlockedError) return 'UNKNOWN_PAYMENT';
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return 'INTERNAL_ERROR';
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly sales: SalesService,
    private readonly catalogue: CatalogueService,
    private readonly audit: AuditService,
  ) {}

  status(): { module: string; status: string } {
    return {
      module: 'sync',
      status: 'Build-04 Objective 1 — register delta-sync handshake and offline cash flush',
    };
  }

  // ------------------------------------------------------------------
  // Handshake
  // ------------------------------------------------------------------

  async handshake(actor: Actor, input: HandshakeRequest): Promise<HandshakeResponse> {
    const register = await this.requireRegister(actor, input.registerId);
    const tenant = await this.db
      .selectFrom('tenants')
      .select(['id', 'status'])
      .where('id', '=', actor.tenantId)
      .executeTakeFirst();
    if (tenant === undefined) {
      throw new NotFoundException('Resource not found');
    }

    const since = input.since !== undefined && input.since !== null ? new Date(input.since) : null;
    const fullSnapshot = since === null;

    let variantQuery = this.db
      .selectFrom('product_variants')
      .leftJoin('tax_rates', 'tax_rates.id', 'product_variants.tax_rate_id')
      // Age restrictions are one row per variant at most (UNIQUE on
      // variant_id, migration 002), so this join never duplicates a
      // variant row. A variant with no row comes through with both
      // age columns NULL — mapped to false / null below, never omitted.
      .leftJoin('age_restrictions', (join) =>
        join
          .onRef('age_restrictions.variant_id', '=', 'product_variants.id')
          .onRef('age_restrictions.tenant_id', '=', 'product_variants.tenant_id'),
      )
      .select([
        'product_variants.id as variantId',
        'product_variants.sku as sku',
        'product_variants.barcode as barcode',
        'product_variants.name as name',
        'product_variants.price_pence as pricePence',
        'product_variants.tax_rate_id as taxRateId',
        'tax_rates.kind as taxRateKind',
        'tax_rates.rate_percent as taxRatePercent',
        'age_restrictions.challenge_25 as challenge25',
        'age_restrictions.min_age_years as minAgeYears',
        'product_variants.updated_at as updatedAt',
      ])
      .where('product_variants.tenant_id', '=', actor.tenantId)
      .where('product_variants.is_active', '=', true);
    if (since !== null) {
      variantQuery = variantQuery.where('product_variants.updated_at', '>', since);
    }
    const variants = await variantQuery.orderBy('product_variants.updated_at', 'asc').execute();

    const warehouseId = await this.defaultWarehouseId(actor);
    const priceBookByVariant = await this.activePriceBookPrices(actor);
    const stockByVariant = new Map<string, { onHand: bigint; computedAt: Date }>();
    if (warehouseId !== null) {
      const balances = await this.db
        .selectFrom('stock_balances')
        .select(['variant_id', 'quantity_on_hand', 'computed_at'])
        .where('tenant_id', '=', actor.tenantId)
        .where('warehouse_id', '=', warehouseId)
        .execute();
      for (const balance of balances) {
        stockByVariant.set(balance.variant_id, {
          onHand: balance.quantity_on_hand,
          computedAt: balance.computed_at,
        });
      }
    }

    const deltaVariants: CatalogueDeltaVariant[] = variants.map((variant) => {
      const stock = stockByVariant.get(variant.variantId);
      return {
        variantId: variant.variantId,
        sku: variant.sku,
        barcode: variant.barcode,
        name: variant.name,
        pricePence: variant.pricePence.toString(),
        taxRateId: variant.taxRateId,
        taxRateKind: variant.taxRateKind,
        taxRatePercent: variant.taxRatePercent === null ? null : String(variant.taxRatePercent),
        priceBookPricePence: priceBookByVariant.get(variant.variantId)?.toString() ?? null,
        stockOnHand: stock === undefined ? null : stock.onHand.toString(),
        stockComputedAt: stock === undefined ? null : stock.computedAt.toISOString(),
        // No age_restrictions row → false / null, always present.
        requiresChallenge25: variant.challenge25 === true,
        minAge: variant.minAgeYears ?? null,
        updatedAt: variant.updatedAt.toISOString(),
      };
    });

    const taxRates = await this.db
      .selectFrom('tax_rates')
      .select(['id', 'kind', 'rate_percent', 'is_active'])
      .where('tenant_id', '=', actor.tenantId)
      .execute();

    const now = new Date();
    const priceBookEntries = await this.db
      .selectFrom('price_books')
      .innerJoin('price_book_entries', 'price_book_entries.price_book_id', 'price_books.id')
      .select([
        'price_books.id as priceBookId',
        'price_book_entries.variant_id as variantId',
        'price_book_entries.price_pence as pricePence',
        'price_books.effective_from as effectiveFrom',
        'price_books.effective_to as effectiveTo',
      ])
      .where('price_books.tenant_id', '=', actor.tenantId)
      .where('price_books.status', '=', 'active')
      .where('price_books.effective_from', '<=', now)
      .where((eb) =>
        eb.or([eb('price_books.effective_to', 'is', null), eb('price_books.effective_to', '>=', now)]),
      )
      .execute();

    // One mode per tenant (UNIQUE on tenant_id) — the latest row wins.
    const barcodeRule = await this.db
      .selectFrom('barcode_rules')
      .select('mode')
      .where('tenant_id', '=', actor.tenantId)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst();

    const catalogue: CatalogueDelta = {
      variants: deltaVariants,
      taxRates: taxRates.map((rate) => ({
        id: rate.id,
        kind: rate.kind,
        ratePercent: String(rate.rate_percent),
        isActive: rate.is_active,
      })),
      priceBookEntries: priceBookEntries.map((entry) => ({
        priceBookId: entry.priceBookId,
        variantId: entry.variantId,
        pricePence: entry.pricePence.toString(),
        effectiveFrom: entry.effectiveFrom.toISOString(),
        effectiveTo: entry.effectiveTo === null ? null : entry.effectiveTo.toISOString(),
      })),
      barcodeMode: barcodeRule === undefined ? null : barcodeRule.mode,
      fullSnapshot,
    };

    await this.audit.record(this.db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'sync.handshake',
      entityType: 'register',
      entityId: register.id,
      payload: {
        registerId: register.id,
        fullSnapshot: String(fullSnapshot),
        variantCount: String(deltaVariants.length),
        since: input.since ?? null,
      },
    });

    return {
      serverTime: new Date().toISOString(),
      tenantId: actor.tenantId,
      tenantStatus: tenant.status,
      registerId: register.id,
      registerName: register.name,
      registerStatus: register.status,
      locationId: actor.locationId,
      catalogue,
    };
  }

  // ------------------------------------------------------------------
  // Flush
  // ------------------------------------------------------------------

  async flush(actor: Actor, input: FlushRequest): Promise<FlushResponse> {
    await this.requireRegister(actor, input.registerId);
    const outcomes: FlushOrderOutcome[] = [];
    // FIFO: the client sends created_at ASC; process strictly in that order.
    for (const order of input.orders) {
      outcomes.push(await this.flushOne(actor, input.registerId, order));
    }
    return { serverTime: new Date().toISOString(), outcomes };
  }

  private async flushOne(
    actor: Actor,
    registerId: string,
    order: FlushOrder,
  ): Promise<FlushOrderOutcome> {
    const failed = (error: string, errorCode: string): FlushOrderOutcome => ({
      idempotencyKey: order.idempotencyKey,
      status: 'failed',
      orderId: null,
      receiptNumber: null,
      orderTotalPence: null,
      warnings: [],
      conflict: null,
      error,
      error_code: errorCode,
    });

    try {
      if (order.locationId !== actor.locationId) {
        return failed('Order location does not match the register location', 'LOCATION_MISMATCH');
      }
      if (order.lines.length === 0) {
        return failed('Offline order must contain at least one line', 'EMPTY_ORDER');
      }
      const snapshotTotal = BigInt(order.tenderTotalPence);
      if (snapshotTotal <= 0n) {
        return failed('Offline order total must be greater than zero', 'INVALID_TOTAL');
      }
      const lineSnapshotSum = order.lines.reduce(
        (sum, line) => sum + BigInt(line.snapshotLineTotalPence),
        0n,
      );
      if (lineSnapshotSum !== snapshotTotal) {
        return failed(
          `Snapshot line totals sum to ${lineSnapshotSum.toString()}p but the tender total is ${snapshotTotal.toString()}p`,
          'SNAPSHOT_MISMATCH',
        );
      }

      // Idempotency: a replay returns the stored outcome, no second order.
      const replay = await this.findFlushedOutcome(actor, order.idempotencyKey);
      if (replay !== null) {
        return {
          idempotencyKey: order.idempotencyKey,
          status: 'replayed',
          orderId: replay.orderId,
          receiptNumber: replay.receiptNumber,
          orderTotalPence: replay.orderTotalPence,
          warnings: replay.warnings,
          conflict: replay.conflict,
          error: null,
          error_code: null,
        };
      }

      // Server repricing (authoritative for VAT). The basket discount
      // bridges a server total above the snapshot down to the snapshot.
      const priced = await this.catalogue.priceBasket(
        actor,
        order.lines.map((line) => ({ variantId: line.variantId, quantity: BigInt(line.quantity) })),
      );
      const serverTotal = priced.totalPence;
      const warnings: string[] = [];
      let basketDiscountPence: bigint | undefined;
      let cashOverpaymentPence = 0n;
      if (serverTotal > snapshotTotal) {
        basketDiscountPence = serverTotal - snapshotTotal;
        warnings.push(
          `Price changed while offline: server total ${serverTotal.toString()}p, ` +
            `offline snapshot ${snapshotTotal.toString()}p — snapshot price honored via ` +
            `${basketDiscountPence.toString()}p basket discount.`,
        );
      } else if (serverTotal < snapshotTotal) {
        cashOverpaymentPence = snapshotTotal - serverTotal;
        warnings.push(
          `Price changed while offline: customer paid ${snapshotTotal.toString()}p in cash, ` +
            `server total is ${serverTotal.toString()}p — overpayment of ` +
            `${cashOverpaymentPence.toString()}p retained in the till; reconcile at close.`,
        );
      }

      const { order: created } = await this.sales.createOrder(actor, {
        locationId: order.locationId,
        registerId,
        customerId: order.customerId ?? null,
        lines: order.lines.map((line) => ({
          variantId: line.variantId,
          quantity: BigInt(line.quantity),
        })),
        basketDiscountPence,
      });

      let conflict: FlushOrderOutcome['conflict'] = null;
      let completed: { receipt: ReceiptView };
      // Build-09, Objective 2: offline age verifications ride the
      // flush. The tender enforces Challenge 25 before any stock is
      // reserved, and completion re-checks; an unverified restricted
      // line fails the order (caught below as a 'failed' outcome —
      // the goods were already handed over offline, so the failure is
      // recorded for the merchant to resolve, never silently synced).
      // The raw wire value is passed through: the sales service parses
      // and validates it at its own boundary (the controller already
      // rejected malformed entries with 400 up front).
      const ageVerifications = order.age_verifications;
      try {
        await this.sales.addTender(actor, {
          orderId: created.id,
          tenderType: 'cash',
          amountPence: created.total_pence,
          ageVerifications,
        });
        completed = await this.sales.completeOrder(actor, created.id, ageVerifications);
      } catch (error) {
        if (!(error instanceof InsufficientStockError)) {
          throw error;
        }
        // Stock shortfall on a completed physical cash sale: accept the
        // sale, record the shortfall, complete the order.
        conflict = await this.applyOfflineStockConflict(actor, created.id, order.locationId, error);
        warnings.push(
          `Stock shortfall on offline cash sale: ${conflict
            .map((c) => `${c.shortfall} unit(s) of variant ${c.variantId} short (had ${c.available})`)
            .join('; ')} — sale accepted, offline_sync_conflict recorded; check the dashboard.`,
        );
        completed = await this.sales.completeOrder(actor, created.id);
      }

      const outcome: FlushOrderOutcome = {
        idempotencyKey: order.idempotencyKey,
        status: conflict === null ? 'synced' : 'conflict',
        orderId: created.id,
        receiptNumber: completed.receipt.receiptNumber.toString(),
        orderTotalPence: created.total_pence.toString(),
        warnings,
        conflict,
        error: null,
        error_code: null,
      };
      await this.recordFlushedOutcome(actor, order, outcome, cashOverpaymentPence);
      return outcome;
    } catch (error) {
      return failed(`Replay failed: ${syncErrorMessage(error)}`, syncErrorCode(error));
    }
  }

  // ------------------------------------------------------------------
  // Conflict path: accept the completed cash sale despite short stock.
  // ------------------------------------------------------------------

  private async applyOfflineStockConflict(
    actor: Actor,
    orderId: string,
    locationId: string,
    error: InsufficientStockError,
  ): Promise<NonNullable<FlushOrderOutcome['conflict']>> {
    const warehouseId = await this.defaultWarehouseId(actor);
    if (warehouseId === null) {
      throw new Error('No warehouse exists for this location; cannot record the stock conflict');
    }
    const conflict = await this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .where('tenant_id', '=', actor.tenantId)
        .executeTakeFirstOrThrow();
      if (order.status !== 'draft') {
        throw new Error(`Offline conflict path expects a draft order (order is ${order.status})`);
      }
      const lines = await trx
        .selectFrom('order_lines')
        .selectAll()
        .where('order_id', '=', orderId)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
      const details: NonNullable<FlushOrderOutcome['conflict']> = [];
      for (const line of lines) {
        // Quantities in a flush payload are base units (see sync.dto.ts).
        const baseQty = line.quantity_in_base_units ?? line.quantity;
        await trx
          .insertInto('stock_balances')
          .values({
            variant_id: line.variant_id,
            warehouse_id: warehouseId,
            tenant_id: actor.tenantId,
            location_id: locationId,
            quantity_on_hand: 0n,
          })
          .onConflict((oc) => oc.columns(['variant_id', 'warehouse_id']).doNothing())
          .execute();
        const locked = await trx
          .selectFrom('stock_balances')
          .select('quantity_on_hand')
          .where('variant_id', '=', line.variant_id)
          .where('warehouse_id', '=', warehouseId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const available = locked.quantity_on_hand < baseQty ? locked.quantity_on_hand : baseQty;
        const shortfall = baseQty - available;
        if (available > 0n) {
          await trx
            .insertInto('stock_movements')
            .values({
              tenant_id: actor.tenantId,
              variant_id: line.variant_id,
              warehouse_id: warehouseId,
              location_id: locationId,
              cause: 'sale',
              quantity_change: -available,
              quantity_in_base_units: -available,
              unit_id: null,
              cost_pence_at_movement: null,
              order_id: orderId,
              reference_id: null,
              reference_type: null,
              created_by_user_id: userIdAsUuid(actor.userId),
            })
            .execute();
          await trx
            .updateTable('stock_balances')
            .set({
              quantity_on_hand: sql`quantity_on_hand - ${available}`,
              computed_at: sql`now()`,
            })
            .where('variant_id', '=', line.variant_id)
            .where('warehouse_id', '=', warehouseId)
            .execute();
        }
        if (shortfall > 0n) {
          // The balance CHECK (>= 0) forbids pushing the read model
          // negative, so the shortfall lives in the ledger only (see
          // the module header) — and in the audit alert below.
          await trx
            .insertInto('stock_movements')
            .values({
              tenant_id: actor.tenantId,
              variant_id: line.variant_id,
              warehouse_id: warehouseId,
              location_id: locationId,
              cause: 'offline_sync_conflict',
              quantity_change: -shortfall,
              quantity_in_base_units: -shortfall,
              unit_id: null,
              cost_pence_at_movement: null,
              order_id: orderId,
              reference_id: null,
              reference_type: null,
              created_by_user_id: userIdAsUuid(actor.userId),
            })
            .execute();
          details.push({
            variantId: line.variant_id,
            requested: baseQty.toString(),
            available: available.toString(),
            shortfall: shortfall.toString(),
          });
        }
        await trx
          .updateTable('order_lines')
          .set({ warehouse_id: warehouseId, quantity_in_base_units: baseQty })
          .where('id', '=', line.id)
          .where('tenant_id', '=', actor.tenantId)
          .execute();
      }
      // The order now holds its (partially conflicted) stock: move it to
      // pending_payment with the cash tender, so completeOrder can run.
      await trx
        .updateTable('orders')
        .set({ status: 'pending_payment' })
        .where('id', '=', orderId)
        .where('tenant_id', '=', actor.tenantId)
        .execute();
      await trx
        .insertInto('order_tenders')
        .values({
          tenant_id: actor.tenantId,
          order_id: orderId,
          tender_type: 'cash',
          amount_pence: order.total_pence,
          payment_attempt_id: null,
        })
        .execute();
      await this.audit.record(trx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'sync.offline_stock_conflict',
        entityType: 'order',
        entityId: orderId,
        payload: {
          shortfalls: details.map((d) => ({
            variantId: d.variantId,
            requested: d.requested,
            available: d.available,
            shortfall: d.shortfall,
          })),
          alert: 'Offline cash sale completed with insufficient stock — dashboard/audit alert; do not void.',
        },
      });
      return details;
    });
    // InsufficientStockError names the first short variant; the loop
    // above records every short line, so a conflict with no shortfall
    // detail would mean the error came from elsewhere — treat that as
    // a hard failure rather than a silent accept.
    if (conflict.length === 0) {
      throw new Error(
        `Stock conflict path found no shortfall for variant ${error.variantId} (available ${error.available.toString()}, requested ${error.requested.toString()})`,
      );
    }
    return conflict;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async requireRegister(actor: Actor, registerId: string) {
    const register = await this.db
      .selectFrom('registers')
      .selectAll()
      .where('id', '=', registerId)
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId)
      .executeTakeFirst();
    if (register === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return register;
  }

  private async defaultWarehouseId(actor: Actor): Promise<string | null> {
    const warehouse = await this.db
      .selectFrom('warehouses')
      .select('id')
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId)
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    return warehouse === undefined ? null : warehouse.id;
  }

  private async activePriceBookPrices(actor: Actor): Promise<Map<string, bigint>> {
    const now = new Date();
    const entries = await this.db
      .selectFrom('price_books')
      .innerJoin('price_book_entries', 'price_book_entries.price_book_id', 'price_books.id')
      .select(['price_book_entries.variant_id as variantId', 'price_book_entries.price_pence as pricePence'])
      .where('price_books.tenant_id', '=', actor.tenantId)
      .where('price_books.status', '=', 'active')
      .where('price_books.effective_from', '<=', now)
      .where((eb) =>
        eb.or([eb('price_books.effective_to', 'is', null), eb('price_books.effective_to', '>=', now)]),
      )
      .orderBy('price_books.priority', 'desc')
      .orderBy('price_books.effective_from', 'desc')
      .execute();
    const prices = new Map<string, bigint>();
    for (const entry of entries) {
      if (!prices.has(entry.variantId)) {
        prices.set(entry.variantId, entry.pricePence);
      }
    }
    return prices;
  }

  private async findFlushedOutcome(
    actor: Actor,
    idempotencyKey: string,
  ): Promise<FlushedOutcomeRow | null> {
    const row = await this.db
      .selectFrom('audit_events')
      .select('payload')
      .where('tenant_id', '=', actor.tenantId)
      .where('event_type', '=', 'sync.order_flushed')
      .where(sql`payload ->> 'idempotencyKey'`, '=', idempotencyKey)
      .orderBy('created_at', 'asc')
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    const payload = row.payload as unknown as Record<string, unknown>;
    return {
      orderId: typeof payload.orderId === 'string' ? payload.orderId : null,
      receiptNumber: typeof payload.receiptNumber === 'string' ? payload.receiptNumber : null,
      orderTotalPence: typeof payload.orderTotalPence === 'string' ? payload.orderTotalPence : null,
      status: typeof payload.status === 'string' ? payload.status : 'synced',
      warnings: Array.isArray(payload.warnings)
        ? (payload.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
        : [],
      conflict: Array.isArray(payload.conflict)
        ? (payload.conflict as FlushOrderOutcome['conflict'])
        : null,
    };
  }

  private async recordFlushedOutcome(
    actor: Actor,
    order: FlushOrder,
    outcome: FlushOrderOutcome,
    cashOverpaymentPence: bigint,
  ): Promise<void> {
    await this.audit.record(this.db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      eventType: 'sync.order_flushed',
      entityType: 'order',
      entityId: outcome.orderId,
      payload: {
        idempotencyKey: order.idempotencyKey,
        registerId: order.registerId,
        offlineCreatedAt: order.createdAt,
        orderId: outcome.orderId,
        receiptNumber: outcome.receiptNumber,
        orderTotalPence: outcome.orderTotalPence,
        snapshotTotalPence: order.tenderTotalPence,
        cashOverpaymentPence: cashOverpaymentPence.toString(),
        status: outcome.status,
        warnings: outcome.warnings,
        conflict: outcome.conflict,
      },
    });
  }
}
