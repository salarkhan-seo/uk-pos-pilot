import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { userIdAsUuid } from '../../common/uuid';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { divRoundHalfUp } from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';

/**
 * Inventory ledger service (Build-02, Objective 4 — Arch-01 §2.3–2.4,
 * Arch-06 §§2–5).
 *
 * Core invariant: stock on hand = SUM(stock_movements) for a variant in a
 * warehouse. stock_balances and stock_valuation are READ MODELS, never the
 * truth. There is NO method here that sets a quantity directly — every
 * stock change is a stock_movements row (C-INV-04), and the read models
 * are updated only as a consequence of a movement, in the same
 * transaction.
 *
 * Tenant isolation (G-B): every query filters tenant_id = actor.tenantId.
 * A resource belonging to another tenant, or at another location, is
 * reported as NotFoundException('Resource not found') — never 403.
 *
 * DESIGN DECISIONS recorded here (not research facts):
 *  - Base-unit conversion: a variant_units.conversion_factor must be a
 *    POSITIVE INTEGER (e.g. a case of 12). A fractional factor (e.g. 12.5)
 *    is rejected with BadRequestException: base-unit stock is integer
 *    bigint, so a fractional conversion cannot be expressed exactly.
 *  - Serial-tracked variants: a variant is serial-tracked when it has at
 *    least one serial_numbers row in status 'in_stock'. Selling such a
 *    variant without serialIds is a BadRequestException — the service
 *    never guesses which serials were sold.
 *  - Goods-in revaluation: the weighted average is revalued on the FULL
 *    received quantity at the received cost; a damage write-off then
 *    removes quantity at the NEW average, so the average is unchanged by
 *    the write-off. A count never revalues; a transfer (not in this
 *    build) would move stock at the source warehouse's average.
 *  - Over-receipt against a PO (received > ordered) is a
 *    BadRequestException. Manager approval for over-receipt is a later
 *    step, not this build.
 *  - A count line for a variant with no stock at count start may be
 *    created by setCountedQuantity with expected_quantity 0 (found
 *    stock); a warehouse must be identifiable for the line, otherwise
 *    setCountedQuantity throws BadRequestException.
 *  - Build-03 (migration 009, Arch-06 §2): the checkout decrement
 *    stamps the order line with warehouse_id / unit_id /
 *    quantity_in_base_units (quantity x conversion_factor). The
 *    warehouse defaults to the location's default warehouse and the
 *    unit to the variant's base unit (variant_units.is_base; NULL when
 *    the variant has no variant_units rows) when omitted — a DB default
 *    cannot look up either value, so the defaulting lives here, in the
 *    application. The stock movement already carried the base-unit
 *    quantity; the Build-02 honest limit was that the ORDER LINE did
 *    not, so a case sale reserved the stored quantity as if it were
 *    base units. That limit is closed by this method for every caller
 *    that passes the line's unitId; callers that do not pass a unit
 *    (the Build-02 sales flow passes quantity only) are treated as
 *    base-unit sales. Multiple order lines for the same variant in one
 *    order share the stamp when no orderLineId is given (the line
 *    cannot be told apart by variant alone); pass orderLineId to stamp
 *    exactly one line.
 */

export class InsufficientStockError extends Error {
  readonly variantId: string;
  readonly available: bigint;
  readonly requested: bigint;

  constructor(variantId: string, available: bigint, requested: bigint) {
    super(
      `Insufficient stock for variant ${variantId}: available ${available.toString()}, requested ${requested.toString()}`,
    );
    this.name = 'InsufficientStockError';
    this.variantId = variantId;
    this.available = available;
    this.requested = requested;
  }
}

export interface StockLineInput {
  variantId: string;
  /** Omitted = the location's default warehouse (Build-03, migration 009). */
  warehouseId?: string | null;
  quantity: bigint;
  unitId?: string | null;
  serialIds?: string[];
  /** When given, the order_lines row this stock line belongs to. */
  orderLineId?: string | null;
}

export interface DecrementStockInput {
  locationId: string;
  orderId: string;
  userId: string;
  lines: StockLineInput[];
}

export interface StartCountInput {
  locationId: string;
  warehouseId?: string | null;
}

export interface SetCountedQuantityInput {
  countId: string;
  variantId: string;
  warehouseId?: string | null;
  countedQuantity: bigint;
}

export interface GoodsInLineInput {
  variantId: string;
  quantityReceived: bigint;
  quantityDamaged?: bigint;
  quantityShort?: bigint;
  costPence: bigint;
}

export interface ReceiveGoodsInInput {
  poId?: string | null;
  supplierId: string;
  locationId: string;
  warehouseId: string;
  lines: GoodsInLineInput[];
}

export interface CountAdjustment {
  variantId: string;
  variance: bigint;
}

export interface StockLevel {
  variantId: string;
  warehouseId: string;
  quantityOnHand: bigint;
}

/**
 * One variant-warehouse balance with its valuation (Build-11
 * Objective 1).
 *
 * Quantities are LIVE (stock_balances); the weighted average comes
 * ONLY from stock_valuation — there is no second valuation source.
 * stock_valuation.quantity_on_hand is a goods-in-time snapshot (only
 * goods-in writes stock_valuation; sales, counts and transfers move
 * stock_balances alone), so it is never used as a quantity here.
 *
 * weightedAvgCostPence is null when the variant-warehouse has no
 * stock_valuation row (stock that arrived by count or transfer
 * without a goods-in has no received cost on record — the average is
 * unknown, never guessed from the variant's cost_pence); totalValuePence
 * is null in the same case, otherwise quantityOnHand * average.
 * computedAt is the balance row's computed_at (when the balance last
 * changed); for a valuation-only row (see getBalances) it is the
 * valuation row's computed_at.
 */
export interface BalanceRow {
  variantId: string;
  warehouseId: string;
  quantityOnHand: bigint;
  weightedAvgCostPence: bigint | null;
  totalValuePence: bigint | null;
  computedAt: Date;
}

/** One variant's valuation, aggregated across its warehouses. */
export interface ValuationRow {
  variantId: string;
  /** Sum of quantities across all of the variant's warehouses. */
  totalQuantityOnHand: bigint;
  /**
   * totalValuePence / quantity-with-a-known-average, round half up;
   * null when no warehouse has a known average (or when the known-
   * average quantity is zero — an average over no valued stock is
   * undefined, not zero).
   */
  weightedAvgCostPence: bigint | null;
  /**
   * Sum of quantity * average over warehouses with a known average;
   * null when no warehouse has a known average.
   */
  totalValuePence: bigint | null;
}

type CountRow = {
  id: string;
  tenant_id: string;
  location_id: string;
  warehouse_id: string | null;
  status: 'draft' | 'submitted' | 'cancelled';
  started_by_user_id: string | null;
  submitted_by_user_id: string | null;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type CountLineRow = {
  count_id: string;
  variant_id: string;
  warehouse_id: string | null;
  expected_quantity: bigint;
  counted_quantity: bigint | null;
  created_at: Date;
};

/** A conversion factor must be a positive integer (see design decisions). */
function parseConversionFactor(raw: string): bigint {
  const trimmed = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    throw new BadRequestException(`Invalid conversion factor: ${raw}`);
  }
  const intPart = match[1] as string;
  const fracPart = match[2] ?? '';
  if (/[^0]/.test(fracPart)) {
    throw new BadRequestException(
      `Conversion factor ${raw} is fractional: base-unit conversion requires a positive integer factor`,
    );
  }
  const factor = BigInt(intPart);
  if (factor <= 0n) {
    throw new BadRequestException(`Conversion factor must be a positive integer, got ${raw}`);
  }
  return factor;
}

@Injectable()
export class InventoryService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  status(): { module: string; status: string } {
    return { module: 'inventory', status: 'Build-02 Objective 4 — ledger, counts, goods-in' };
  }

  // ------------------------------------------------------------------
  // Shared guards / helpers
  // ------------------------------------------------------------------

  /** The Actor works at ONE location; anything else is "not found". */
  private requireActorLocation(actor: Actor, locationId: string): void {
    if (locationId !== actor.locationId) {
      throw new NotFoundException('Resource not found');
    }
  }

  private async requireWarehouse(
    q: Kysely<DB>,
    actor: Actor,
    warehouseId: string,
    locationId: string,
  ): Promise<void> {
    const warehouse = await q
      .selectFrom('warehouses')
      .select('id')
      .where('id', '=', warehouseId)
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', locationId)
      .executeTakeFirst();
    if (warehouse === undefined) {
      throw new NotFoundException('Resource not found');
    }
  }

  private async requireVariant(
    q: Kysely<DB>,
    actor: Actor,
    variantId: string,
  ): Promise<{ id: string; cost_pence: bigint }> {
    const variant = await q
      .selectFrom('product_variants')
      .select(['id', 'cost_pence'])
      .where('id', '=', variantId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (variant === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return variant;
  }

  private async requireSupplier(q: Kysely<DB>, actor: Actor, supplierId: string): Promise<void> {
    const supplier = await q
      .selectFrom('suppliers')
      .select('id')
      .where('id', '=', supplierId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (supplier === undefined) {
      throw new NotFoundException('Resource not found');
    }
  }

  /** Ensure a stock_balances row exists (quantity 0) so it can be locked. */
  private async ensureBalanceRow(
    q: Kysely<DB>,
    actor: Actor,
    variantId: string,
    warehouseId: string,
    locationId: string,
  ): Promise<void> {
    await q
      .insertInto('stock_balances')
      .values({
        variant_id: variantId,
        warehouse_id: warehouseId,
        tenant_id: actor.tenantId,
        location_id: locationId,
        quantity_on_hand: 0n,
      })
      .onConflict((oc) => oc.columns(['variant_id', 'warehouse_id']).doNothing())
      .execute();
  }

  /** Apply a signed delta to the read-model balance, in the same transaction. */
  private async applyBalanceDelta(
    q: Kysely<DB>,
    variantId: string,
    warehouseId: string,
    delta: bigint,
  ): Promise<void> {
    await q
      .updateTable('stock_balances')
      .set({
        quantity_on_hand: sql`quantity_on_hand + ${delta}`,
        computed_at: sql`now()`,
      })
      .where('variant_id', '=', variantId)
      .where('warehouse_id', '=', warehouseId)
      .execute();
  }

  /** Current weighted-average cost, falling back to the variant's cost_pence. */
  private async currentAverageCost(
    q: Kysely<DB>,
    variantId: string,
    warehouseId: string,
    fallbackCostPence: bigint,
  ): Promise<bigint> {
    const valuation = await q
      .selectFrom('stock_valuation')
      .select('weighted_average_cost_pence')
      .where('variant_id', '=', variantId)
      .where('warehouse_id', '=', warehouseId)
      .executeTakeFirst();
    return valuation === undefined ? fallbackCostPence : valuation.weighted_average_cost_pence;
  }

  // ------------------------------------------------------------------
  // Sale decrement (G-A-13) — called by the sales module inside the
  // checkout transaction, BEFORE any payment attempt is created.
  // ------------------------------------------------------------------

  /**
   * Decrement stock for an order, inside the caller's transaction
   * (required — the sales module owns the checkout transaction).
   *
   * ORDERING (G-A-13): for each line, the stock_balances row is locked
   * with SELECT ... FOR UPDATE and on-hand is verified INSIDE the lock,
   * BEFORE any payment attempt is created — the sales module calls this
   * before creating attempts, so an insufficient-stock failure rolls the
   * transaction back with no movement written and no payment taken.
   *
   * Lines are processed in deterministic (variant_id, warehouse_id)
   * order so concurrent checkouts lock rows in the same order and cannot
   * deadlock each other. Duplicate lines for the same variant/warehouse
   * are safe: each line re-reads the balance inside its own lock, so the
   * second line sees the first line's decrement.
   */
  async decrementStockForOrder(
    actor: Actor,
    trx: Kysely<DB>,
    input: DecrementStockInput,
  ): Promise<void> {
    this.requireActorLocation(actor, input.locationId);
    if (input.lines.length === 0) {
      throw new BadRequestException('Order has no stock lines');
    }

    const sorted = [...input.lines].sort((a, b) => {
      if (a.variantId !== b.variantId) return a.variantId < b.variantId ? -1 : 1;
      const aWh = a.warehouseId ?? '';
      const bWh = b.warehouseId ?? '';
      if (aWh !== bWh) return aWh < bWh ? -1 : 1;
      return 0;
    });

    for (const line of sorted) {
      if (line.quantity <= 0n) {
        throw new BadRequestException('Line quantity must be greater than zero');
      }
      const variant = await this.requireVariant(trx, actor, line.variantId);
      // Build-03: the warehouse defaults to the location's default
      // warehouse when the caller omits it (migration 009).
      const warehouseId = line.warehouseId ?? (await this.defaultWarehouseId(trx, actor, input.locationId));
      await this.requireWarehouse(trx, actor, warehouseId, input.locationId);

      // Resolve the unit: the caller's unit (a units_of_measure id) when
      // given, else the variant's base unit (variant_units.is_base),
      // else NULL (the variant is only ever sold in base units). The
      // base-unit quantity is quantity x conversion_factor. Note the
      // two unit columns differ: stock_movements.unit_id is the
      // units_of_measure id, while order_lines.unit_id (migration 009)
      // is the variant_units ROW id — both are stamped here.
      let unitUomId: string | null = line.unitId ?? null;
      let variantUnitRowId: string | null = null;
      let baseQty = line.quantity;
      if (unitUomId !== null) {
        const variantUnit = await trx
          .selectFrom('variant_units')
          .select(['id', 'conversion_factor'])
          .where('variant_id', '=', line.variantId)
          .where('unit_id', '=', unitUomId)
          .executeTakeFirst();
        if (variantUnit === undefined) {
          throw new BadRequestException(
            `Unknown unit ${unitUomId} for variant ${line.variantId}`,
          );
        }
        variantUnitRowId = variantUnit.id;
        baseQty = line.quantity * parseConversionFactor(variantUnit.conversion_factor);
      } else {
        const baseUnit = await trx
          .selectFrom('variant_units')
          .select(['id', 'unit_id'])
          .where('variant_id', '=', line.variantId)
          .where('is_base', '=', true)
          .executeTakeFirst();
        if (baseUnit !== undefined) {
          unitUomId = baseUnit.unit_id;
          variantUnitRowId = baseUnit.id;
        }
      }

      // Serial-tracked variant sold without serials: never guess.
      const serialIds = line.serialIds ?? [];
      if (serialIds.length === 0) {
        const tracked = await trx
          .selectFrom('serial_numbers')
          .select('id')
          .where('variant_id', '=', line.variantId)
          .where('tenant_id', '=', actor.tenantId)
          .where('status', '=', 'in_stock')
          .executeTakeFirst();
        if (tracked !== undefined) {
          throw new BadRequestException(
            `Variant ${line.variantId} is serial-tracked: serial numbers must be supplied`,
          );
        }
      }

      // Ensure the balance row exists, then lock it and check availability
      // INSIDE the lock (G-A-13).
      await this.ensureBalanceRow(trx, actor, line.variantId, warehouseId, input.locationId);
      const locked = await trx
        .selectFrom('stock_balances')
        .select('quantity_on_hand')
        .where('variant_id', '=', line.variantId)
        .where('warehouse_id', '=', warehouseId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (locked.quantity_on_hand < baseQty) {
        throw new InsufficientStockError(line.variantId, locked.quantity_on_hand, baseQty);
      }

      // Serial numbers: lock each row, require in_stock, mark sold.
      for (const serialId of serialIds) {
        const serial = await trx
          .selectFrom('serial_numbers')
          .select(['id', 'status'])
          .where('id', '=', serialId)
          .where('variant_id', '=', line.variantId)
          .where('tenant_id', '=', actor.tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (serial === undefined) {
          throw new NotFoundException('Resource not found');
        }
        if (serial.status !== 'in_stock') {
          throw new BadRequestException(
            `Serial number ${serialId} is not in stock (status: ${serial.status})`,
          );
        }
        await trx
          .updateTable('serial_numbers')
          .set({ status: 'sold', order_id: input.orderId })
          .where('id', '=', serialId)
          .execute();
      }

      const cost = await this.currentAverageCost(
        trx,
        line.variantId,
        warehouseId,
        variant.cost_pence,
      );
      await trx
        .insertInto('stock_movements')
        .values({
          tenant_id: actor.tenantId,
          variant_id: line.variantId,
          warehouse_id: warehouseId,
          location_id: input.locationId,
          cause: 'sale',
          quantity_change: -baseQty,
          quantity_in_base_units: -baseQty,
          unit_id: unitUomId,
          cost_pence_at_movement: cost,
          order_id: input.orderId,
          reference_id: null,
          reference_type: null,
          created_by_user_id: userIdAsUuid(input.userId),
        })
        .execute();
      await this.applyBalanceDelta(trx, line.variantId, warehouseId, -baseQty);

      // Build-03 (migration 009): stamp the order line with the
      // warehouse, unit and base-unit quantity the sale actually
      // reserved, in the same transaction as the stock movement — the
      // line and the ledger can never disagree. Only unstamped lines
      // are touched, so a retry of the decrement cannot overwrite a
      // stamp written by an earlier call.
      let stampQuery = trx
        .updateTable('order_lines')
        .set({
          warehouse_id: warehouseId,
          unit_id: variantUnitRowId,
          quantity_in_base_units: baseQty,
        })
        .where('order_id', '=', input.orderId)
        .where('tenant_id', '=', actor.tenantId)
        .where('quantity_in_base_units', 'is', null);
      stampQuery =
        line.orderLineId !== undefined && line.orderLineId !== null
          ? stampQuery.where('id', '=', line.orderLineId)
          : stampQuery.where('variant_id', '=', line.variantId);
      await stampQuery.execute();
    }
  }

  /** The location's default warehouse (fallback: earliest warehouse there). */
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

  // ------------------------------------------------------------------
  // Stock counts (D-10: one draft count per location)
  // ------------------------------------------------------------------

  async startCount(
    actor: Actor,
    input: StartCountInput,
    trx?: Kysely<DB>,
  ): Promise<CountRow> {
    const q = trx ?? this.db;
    this.requireActorLocation(actor, input.locationId);
    const warehouseId = input.warehouseId ?? null;
    if (warehouseId !== null) {
      await this.requireWarehouse(q, actor, warehouseId, input.locationId);
    }

    const existing = await q
      .selectFrom('stock_counts')
      .select('id')
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', input.locationId)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new ConflictException('A draft stock count already exists at this location');
    }

    let count: CountRow;
    try {
      count = await q
        .insertInto('stock_counts')
        .values({
          tenant_id: actor.tenantId,
          location_id: input.locationId,
          warehouse_id: warehouseId,
          status: 'draft',
          started_by_user_id: userIdAsUuid(actor.userId),
          submitted_by_user_id: null,
          submitted_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      // The DB partial unique index is the backstop against a race between
      // the check above and the insert (D-10).
      if (error instanceof Error && /uq_stock_counts_one_active_per_location/.test(error.message)) {
        throw new ConflictException('A draft stock count already exists at this location');
      }
      throw error;
    }

    // Pre-fill one line per variant/warehouse holding stock, with the
    // expected quantity = current on-hand. Stock does not change until
    // the count is submitted.
    let balancesQuery = q
      .selectFrom('stock_balances')
      .select(['variant_id', 'warehouse_id', 'quantity_on_hand'])
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', input.locationId);
    if (warehouseId !== null) {
      balancesQuery = balancesQuery.where('warehouse_id', '=', warehouseId);
    }
    const balances = await balancesQuery.execute();
    for (const balance of balances) {
      await q
        .insertInto('stock_count_lines')
        .values({
          count_id: count.id,
          variant_id: balance.variant_id,
          warehouse_id: balance.warehouse_id,
          expected_quantity: balance.quantity_on_hand,
          counted_quantity: null,
        })
        .execute();
    }
    return count;
  }

  async setCountedQuantity(
    actor: Actor,
    input: SetCountedQuantityInput,
    trx?: Kysely<DB>,
  ): Promise<CountLineRow> {
    const q = trx ?? this.db;
    if (input.countedQuantity < 0n) {
      throw new BadRequestException('Counted quantity must not be negative');
    }
    const count = await this.requireDraftCount(q, actor, input.countId);

    // The warehouse for the line: explicit input wins, else the count's
    // warehouse, else the variant's single line in this count.
    let warehouseId = input.warehouseId ?? count.warehouse_id ?? null;
    if (warehouseId === null) {
      const lines = await q
        .selectFrom('stock_count_lines')
        .select('warehouse_id')
        .where('count_id', '=', input.countId)
        .where('variant_id', '=', input.variantId)
        .execute();
      if (lines.length === 1) {
        const onlyLine = lines[0];
        if (onlyLine !== undefined) {
          warehouseId = onlyLine.warehouse_id;
        }
      } else if (lines.length > 1) {
        throw new BadRequestException(
          `Variant ${input.variantId} is counted in multiple warehouses: specify warehouseId`,
        );
      }
    }

    const existing = await this.findCountLine(q, input.countId, input.variantId, warehouseId);
    if (existing !== undefined) {
      let updateQuery = q
        .updateTable('stock_count_lines')
        .set({ counted_quantity: input.countedQuantity })
        .where('count_id', '=', input.countId)
        .where('variant_id', '=', input.variantId);
      updateQuery =
        warehouseId === null
          ? updateQuery.where('warehouse_id', 'is', null)
          : updateQuery.where('warehouse_id', '=', warehouseId);
      const updated = await updateQuery.returningAll().executeTakeFirstOrThrow();
      return updated as CountLineRow;
    }

    // Variant had no stock at count start (no pre-filled line): found
    // stock is recorded with expected_quantity 0. A warehouse must be
    // identifiable — a line with no warehouse cannot be adjusted later.
    if (warehouseId === null) {
      throw new BadRequestException(
        `Variant ${input.variantId} has no count line and no warehouse was given: specify warehouseId`,
      );
    }
    await this.requireVariant(q, actor, input.variantId);
    const inserted = await q
      .insertInto('stock_count_lines')
      .values({
        count_id: input.countId,
        variant_id: input.variantId,
        warehouse_id: warehouseId,
        expected_quantity: 0n,
        counted_quantity: input.countedQuantity,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return inserted as CountLineRow;
  }

  async submitCount(
    actor: Actor,
    countId: string,
    trx?: Kysely<DB>,
  ): Promise<{ adjustments: CountAdjustment[] }> {
    const q = trx ?? this.db;
    const count = await this.requireDraftCount(q, actor, countId);

    const lines = await q
      .selectFrom('stock_count_lines')
      .selectAll()
      .where('count_id', '=', countId)
      .orderBy('variant_id')
      .execute();

    const adjustments: CountAdjustment[] = [];
    for (const line of lines) {
      if (line.counted_quantity === null || line.counted_quantity === line.expected_quantity) {
        continue; // Not counted, or no variance: no movement is written.
      }
      if (line.warehouse_id === null) {
        throw new BadRequestException(
          `Count line for variant ${line.variant_id} has no warehouse and cannot be adjusted`,
        );
      }
      const variance = line.counted_quantity - line.expected_quantity;
      const variant = await this.requireVariant(q, actor, line.variant_id);
      const cost = await this.currentAverageCost(
        q,
        line.variant_id,
        line.warehouse_id,
        variant.cost_pence,
      );
      await this.ensureBalanceRow(
        q,
        actor,
        line.variant_id,
        line.warehouse_id,
        count.location_id,
      );
      await q
        .insertInto('stock_movements')
        .values({
          tenant_id: actor.tenantId,
          variant_id: line.variant_id,
          warehouse_id: line.warehouse_id,
          location_id: count.location_id,
          cause: 'count',
          quantity_change: variance,
          quantity_in_base_units: variance,
          unit_id: null,
          cost_pence_at_movement: cost,
          order_id: null,
          reference_id: countId,
          reference_type: 'stock_count',
          created_by_user_id: userIdAsUuid(actor.userId),
        })
        .execute();
      await this.applyBalanceDelta(q, line.variant_id, line.warehouse_id, variance);
      adjustments.push({ variantId: line.variant_id, variance });
    }

    await q
      .updateTable('stock_counts')
      .set({
        status: 'submitted',
        submitted_by_user_id: userIdAsUuid(actor.userId),
        submitted_at: sql`now()`,
      })
      .where('id', '=', countId)
      .execute();
    return { adjustments };
  }

  private async requireDraftCount(
    q: Kysely<DB>,
    actor: Actor,
    countId: string,
  ): Promise<CountRow> {
    const count = (await q
      .selectFrom('stock_counts')
      .selectAll()
      .where('id', '=', countId)
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId)
      .executeTakeFirst()) as CountRow | undefined;
    if (count === undefined) {
      throw new NotFoundException('Resource not found');
    }
    if (count.status !== 'draft') {
      throw new BadRequestException(`Stock count is ${count.status}, not draft`);
    }
    return count;
  }

  private async findCountLine(
    q: Kysely<DB>,
    countId: string,
    variantId: string,
    warehouseId: string | null,
  ): Promise<CountLineRow | undefined> {
    const query = q
      .selectFrom('stock_count_lines')
      .selectAll()
      .where('count_id', '=', countId)
      .where('variant_id', '=', variantId);
    const row =
      warehouseId === null
        ? await query.where('warehouse_id', 'is', null).executeTakeFirst()
        : await query.where('warehouse_id', '=', warehouseId).executeTakeFirst();
    return row as CountLineRow | undefined;
  }

  // ------------------------------------------------------------------
  // Goods-in receipts (Arch-06 §5.2–5.3)
  // ------------------------------------------------------------------

  async receiveGoodsIn(
    actor: Actor,
    input: ReceiveGoodsInInput,
    trx?: Kysely<DB>,
  ): Promise<{ receiptId: string }> {
    const q = trx ?? this.db;
    this.requireActorLocation(actor, input.locationId);
    await this.requireWarehouse(q, actor, input.warehouseId, input.locationId);
    await this.requireSupplier(q, actor, input.supplierId);
    if (input.lines.length === 0) {
      throw new BadRequestException('Goods-in receipt has no lines');
    }

    // Validate the PO first (when one is given): tenant/location scoped,
    // in a receivable status, and every line must be on it.
    let poLines: Map<string, { quantity_ordered: bigint; quantity_received: bigint }> | null =
      null;
    if (input.poId !== undefined && input.poId !== null) {
      const po = await q
        .selectFrom('purchase_orders')
        .select(['id', 'status'])
        .where('id', '=', input.poId)
        .where('tenant_id', '=', actor.tenantId)
        .where('location_id', '=', input.locationId)
        .executeTakeFirst();
      if (po === undefined) {
        throw new NotFoundException('Resource not found');
      }
      if (po.status !== 'draft' && po.status !== 'sent' && po.status !== 'partially_received') {
        throw new BadRequestException(`Purchase order is ${po.status} and cannot be received`);
      }
      const rows = await q
        .selectFrom('purchase_order_lines')
        .select(['variant_id', 'quantity_ordered', 'quantity_received'])
        .where('po_id', '=', input.poId)
        .execute();
      poLines = new Map(
        rows.map((row) => [
          row.variant_id,
          { quantity_ordered: row.quantity_ordered, quantity_received: row.quantity_received },
        ]),
      );
    }

    // Validate every line before writing anything.
    const validated: Array<{
      variantId: string;
      quantityReceived: bigint;
      quantityDamaged: bigint;
      quantityShort: bigint;
      costPence: bigint;
      quantityOrdered: bigint;
    }> = [];
    for (const line of input.lines) {
      if (line.quantityReceived < 0n) {
        throw new BadRequestException('Quantity received must not be negative');
      }
      const damaged = line.quantityDamaged ?? 0n;
      const short = line.quantityShort ?? 0n;
      if (damaged < 0n || short < 0n) {
        throw new BadRequestException('Damaged and short quantities must not be negative');
      }
      if (damaged > line.quantityReceived) {
        throw new BadRequestException('Damaged quantity cannot exceed quantity received');
      }
      if (line.costPence < 0n) {
        throw new BadRequestException('Cost must not be negative');
      }
      await this.requireVariant(q, actor, line.variantId);
      let quantityOrdered = 0n;
      if (poLines !== null) {
        const poLine = poLines.get(line.variantId);
        if (poLine === undefined) {
          throw new BadRequestException(
            `Variant ${line.variantId} is not on purchase order ${input.poId as string}`,
          );
        }
        quantityOrdered = poLine.quantity_ordered;
        // Over-receipt is rejected; manager approval for over-receipt is
        // a later step, not this build.
        if (poLine.quantity_received + line.quantityReceived > poLine.quantity_ordered) {
          throw new BadRequestException(
            `Over-receipt for variant ${line.variantId}: ordered ${poLine.quantity_ordered.toString()}, ` +
              `already received ${poLine.quantity_received.toString()}, ` +
              `receiving ${line.quantityReceived.toString()}`,
          );
        }
      }
      validated.push({
        variantId: line.variantId,
        quantityReceived: line.quantityReceived,
        quantityDamaged: damaged,
        quantityShort: short,
        costPence: line.costPence,
        quantityOrdered,
      });
    }

    const receipt = await q
      .insertInto('goods_in_receipts')
      .values({
        tenant_id: actor.tenantId,
        po_id: input.poId ?? null,
        location_id: input.locationId,
        warehouse_id: input.warehouseId,
        received_by_user_id: userIdAsUuid(actor.userId),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    for (const line of validated) {
      await q
        .insertInto('goods_in_lines')
        .values({
          receipt_id: receipt.id,
          variant_id: line.variantId,
          quantity_ordered: line.quantityOrdered,
          quantity_received: line.quantityReceived,
          quantity_damaged: line.quantityDamaged,
          quantity_short: line.quantityShort,
          cost_pence: line.costPence,
        })
        .execute();

      // Weighted-average revaluation on the FULL received quantity at the
      // received cost; the damage write-off below then removes quantity
      // at the NEW average, so the average is unchanged by the write-off.
      // A count never revalues; a transfer would move stock at the
      // source warehouse's average.
      const valuation = await q
        .selectFrom('stock_valuation')
        .select(['weighted_average_cost_pence', 'quantity_on_hand'])
        .where('variant_id', '=', line.variantId)
        .where('warehouse_id', '=', input.warehouseId)
        .forUpdate()
        .executeTakeFirst();
      const oldQty = valuation === undefined ? 0n : valuation.quantity_on_hand;
      const oldAvg = valuation === undefined ? 0n : valuation.weighted_average_cost_pence;
      const newAvg =
        line.quantityReceived > 0n
          ? divRoundHalfUp(
              oldQty * oldAvg + line.quantityReceived * line.costPence,
              oldQty + line.quantityReceived,
            )
          : oldAvg;
      const newQty = oldQty + line.quantityReceived - line.quantityDamaged;

      if (line.quantityReceived > 0n) {
        await q
          .insertInto('stock_movements')
          .values({
            tenant_id: actor.tenantId,
            variant_id: line.variantId,
            warehouse_id: input.warehouseId,
            location_id: input.locationId,
            cause: 'goods_in',
            quantity_change: line.quantityReceived,
            quantity_in_base_units: line.quantityReceived,
            unit_id: null,
            cost_pence_at_movement: line.costPence,
            order_id: null,
            reference_id: receipt.id,
            reference_type: 'goods_in_receipt',
            created_by_user_id: userIdAsUuid(actor.userId),
          })
          .execute();
      }
      if (line.quantityDamaged > 0n) {
        await q
          .insertInto('stock_movements')
          .values({
            tenant_id: actor.tenantId,
            variant_id: line.variantId,
            warehouse_id: input.warehouseId,
            location_id: input.locationId,
            cause: 'damage',
            quantity_change: -line.quantityDamaged,
            quantity_in_base_units: -line.quantityDamaged,
            unit_id: null,
            cost_pence_at_movement: newAvg,
            order_id: null,
            reference_id: receipt.id,
            reference_type: 'goods_in_receipt',
            created_by_user_id: userIdAsUuid(actor.userId),
          })
          .execute();
      }

      const net = line.quantityReceived - line.quantityDamaged;
      if (net !== 0n) {
        await this.ensureBalanceRow(
          q,
          actor,
          line.variantId,
          input.warehouseId,
          input.locationId,
        );
        await this.applyBalanceDelta(q, line.variantId, input.warehouseId, net);
      }

      if (valuation !== undefined || line.quantityReceived > 0n) {
        await q
          .insertInto('stock_valuation')
          .values({
            variant_id: line.variantId,
            warehouse_id: input.warehouseId,
            tenant_id: actor.tenantId,
            weighted_average_cost_pence: newAvg,
            quantity_on_hand: newQty,
          })
          .onConflict((oc) =>
            oc.columns(['variant_id', 'warehouse_id']).doUpdateSet({
              weighted_average_cost_pence: newAvg,
              quantity_on_hand: newQty,
              computed_at: sql`now()`,
            }),
          )
          .execute();
      }
    }

    // Advance the PO: add received quantities, then move to received when
    // every line is fully received, else partially_received.
    if (input.poId !== undefined && input.poId !== null && poLines !== null) {
      for (const line of validated) {
        const poLine = poLines.get(line.variantId) as {
          quantity_ordered: bigint;
          quantity_received: bigint;
        };
        await q
          .updateTable('purchase_order_lines')
          .set({ quantity_received: poLine.quantity_received + line.quantityReceived })
          .where('po_id', '=', input.poId)
          .where('variant_id', '=', line.variantId)
          .execute();
      }
      const remaining = await q
        .selectFrom('purchase_order_lines')
        .select(['quantity_ordered', 'quantity_received'])
        .where('po_id', '=', input.poId)
        .execute();
      const fullyReceived = remaining.every(
        (row) => row.quantity_received >= row.quantity_ordered,
      );
      await q
        .updateTable('purchase_orders')
        .set({ status: fullyReceived ? 'received' : 'partially_received' })
        .where('id', '=', input.poId)
        .execute();
    }

    return { receiptId: receipt.id };
  }

  // ------------------------------------------------------------------
  // Read-only stock levels (a READ is allowed; it never writes).
  // ------------------------------------------------------------------

  async getStockLevels(
    actor: Actor,
    filter: { variantId?: string; warehouseId?: string } = {},
  ): Promise<StockLevel[]> {
    let query = this.db
      .selectFrom('stock_balances')
      .select(['variant_id', 'warehouse_id', 'quantity_on_hand'])
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId)
      .orderBy('variant_id')
      .orderBy('warehouse_id');
    if (filter.variantId !== undefined) {
      query = query.where('variant_id', '=', filter.variantId);
    }
    if (filter.warehouseId !== undefined) {
      query = query.where('warehouse_id', '=', filter.warehouseId);
    }
    const rows = await query.execute();
    return rows.map((row) => ({
      variantId: row.variant_id,
      warehouseId: row.warehouse_id,
      quantityOnHand: row.quantity_on_hand,
    }));
  }

  // ------------------------------------------------------------------
  // Balances + valuation (Build-11 Objective 1) — read models only.
  // ------------------------------------------------------------------

  /**
   * Per variant-warehouse balances with weighted-average cost and
   * total value. Tenant + location scoped like getStockLevels
   * (actor.locationId), same optional filters; an unknown variant or
   * warehouse filters to an empty list, never 404 (same as getStock).
   *
   * One row per (variant, warehouse) present in stock_balances, PLUS
   * a row for a stock_valuation entry with no balance row (the only
   * way that happens is a net-zero goods-in: received == damaged, so
   * no balance row is created but the valuation row is — its quantity
   * is the valuation snapshot's quantity_on_hand, which is 0 there).
   * The valuation side is scoped to the actor's location through the
   * warehouse's location (stock_valuation carries no location_id).
   */
  async getBalances(
    actor: Actor,
    filter: { variantId?: string; warehouseId?: string } = {},
  ): Promise<BalanceRow[]> {
    let balancesQuery = this.db
      .selectFrom('stock_balances')
      .select(['variant_id', 'warehouse_id', 'quantity_on_hand', 'computed_at'])
      .where('tenant_id', '=', actor.tenantId)
      .where('location_id', '=', actor.locationId);
    if (filter.variantId !== undefined) {
      balancesQuery = balancesQuery.where('variant_id', '=', filter.variantId);
    }
    if (filter.warehouseId !== undefined) {
      balancesQuery = balancesQuery.where('warehouse_id', '=', filter.warehouseId);
    }
    const balanceRows = await balancesQuery.execute();

    let valuationsQuery = this.db
      .selectFrom('stock_valuation')
      .innerJoin('warehouses', 'warehouses.id', 'stock_valuation.warehouse_id')
      .select([
        'stock_valuation.variant_id',
        'stock_valuation.warehouse_id',
        'stock_valuation.weighted_average_cost_pence',
        'stock_valuation.quantity_on_hand',
        'stock_valuation.computed_at',
      ])
      .where('stock_valuation.tenant_id', '=', actor.tenantId)
      .where('warehouses.tenant_id', '=', actor.tenantId)
      .where('warehouses.location_id', '=', actor.locationId);
    if (filter.variantId !== undefined) {
      valuationsQuery = valuationsQuery.where('stock_valuation.variant_id', '=', filter.variantId);
    }
    if (filter.warehouseId !== undefined) {
      valuationsQuery = valuationsQuery.where(
        'stock_valuation.warehouse_id',
        '=',
        filter.warehouseId,
      );
    }
    const valuationRows = await valuationsQuery.execute();

    const byKey = new Map<string, BalanceRow>();
    for (const row of balanceRows) {
      byKey.set(`${row.variant_id}|${row.warehouse_id}`, {
        variantId: row.variant_id,
        warehouseId: row.warehouse_id,
        quantityOnHand: row.quantity_on_hand,
        weightedAvgCostPence: null,
        totalValuePence: null,
        computedAt: row.computed_at,
      });
    }
    for (const row of valuationRows) {
      const key = `${row.variant_id}|${row.warehouse_id}`;
      const existing = byKey.get(key);
      const avg = row.weighted_average_cost_pence;
      if (existing !== undefined) {
        existing.weightedAvgCostPence = avg;
        existing.totalValuePence = existing.quantityOnHand * avg;
      } else {
        // Valuation-only row (net-zero goods-in): the live quantity
        // is the valuation snapshot's quantity (0 in that flow).
        byKey.set(key, {
          variantId: row.variant_id,
          warehouseId: row.warehouse_id,
          quantityOnHand: row.quantity_on_hand,
          weightedAvgCostPence: avg,
          totalValuePence: row.quantity_on_hand * avg,
          computedAt: row.computed_at,
        });
      }
    }
    return [...byKey.values()].sort(
      (a, b) =>
        a.variantId.localeCompare(b.variantId) || a.warehouseId.localeCompare(b.warehouseId),
    );
  }

  /**
   * Per-variant valuation, aggregated across warehouses, plus tenant
   * totals. Built from the same scoped rows as getBalances, so the
   * numbers reconcile with /balances exactly: totalValuePence is the
   * sum of the per-warehouse values, and the per-variant average is
   * totalValue / quantity-with-a-known-average (round half up).
   * Warehouses with an unknown average contribute their quantity to
   * totalQuantityOnHand but nothing to the value or the average.
   */
  async getValuation(
    actor: Actor,
    filter: { variantId?: string; warehouseId?: string } = {},
  ): Promise<{
    valuation: ValuationRow[];
    totals: { totalQuantityOnHand: bigint; totalValuePence: bigint | null };
  }> {
    const balances = await this.getBalances(actor, filter);
    const byVariant = new Map<
      string,
      { totalQty: bigint; knownQty: bigint; totalValue: bigint; hasKnownAvg: boolean }
    >();
    for (const row of balances) {
      const acc = byVariant.get(row.variantId) ?? {
        totalQty: 0n,
        knownQty: 0n,
        totalValue: 0n,
        hasKnownAvg: false,
      };
      acc.totalQty += row.quantityOnHand;
      if (row.weightedAvgCostPence !== null && row.totalValuePence !== null) {
        acc.hasKnownAvg = true;
        acc.knownQty += row.quantityOnHand;
        acc.totalValue += row.totalValuePence;
      }
      byVariant.set(row.variantId, acc);
    }
    const valuation: ValuationRow[] = [...byVariant.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([variantId, acc]) => ({
        variantId,
        totalQuantityOnHand: acc.totalQty,
        weightedAvgCostPence:
          acc.hasKnownAvg && acc.knownQty > 0n
            ? divRoundHalfUp(acc.totalValue, acc.knownQty)
            : null,
        totalValuePence: acc.hasKnownAvg ? acc.totalValue : null,
      }));
    let totalsQty = 0n;
    let totalsValue: bigint | null = null;
    for (const row of valuation) {
      totalsQty += row.totalQuantityOnHand;
      if (row.totalValuePence !== null) {
        totalsValue = (totalsValue ?? 0n) + row.totalValuePence;
      }
    }
    return { valuation, totals: { totalQuantityOnHand: totalsQty, totalValuePence: totalsValue } };
  }
}
