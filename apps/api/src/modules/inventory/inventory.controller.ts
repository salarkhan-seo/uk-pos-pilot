import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import type { Actor } from '../../common/actor';
import { AuthGuard, RequireScope } from '../admin/auth.guard';
import { TenantWriteGuard } from '../admin/exit.service';
import { InventoryService } from './inventory.service';

/**
 * Inventory routes (Build-02, Objective 4).
 *
 * Quantities arrive in JSON as numbers or numeric strings and are
 * converted to bigint here; JSON cannot carry bigint. Write routes
 * run inside one database transaction so a count or a goods-in
 * receipt is atomic.
 *
 * Auth (Build-12 Objective 1): EVERY route in this controller is
 * AuthGuard + RequireScope guarded — the Actor comes from
 * request.actor (set by the guard), never from demo headers. Reads
 * need 'stock:read'; movements, counts and transfers need
 * 'stock:write' plus TenantWriteGuard (writes are blocked inside
 * the 30-day read-only exit window, like the sales writes). The
 * Build-11 demo-header exception is gone: the balances / valuation
 * reads (Build-11 Objective 1) were already guarded this way, and
 * the counts / goods-in / stock routes now follow the same pattern
 * as the sales controller (Build-10 Objective 1) and the
 * purchasing/suppliers controllers in this module.
 */
interface GuardedRequest {
  actor?: Actor;
}

function requireActor(req: GuardedRequest): Actor {
  if (req.actor === undefined) {
    throw new BadRequestException('Authenticated actor is required');
  }
  return req.actor;
}
@Controller()
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    @Inject(DATABASE) private readonly db: Kysely<DB>,
  ) {}

  @Get('inventory/status')
  status(): { module: string; status: string } {
    return this.inventoryService.status();
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('stock:write')
  @Post('v1/inventory/counts')
  async startCount(
    @Req() req: GuardedRequest,
    @Body() body: { locationId?: string; warehouseId?: string | null },
  ): Promise<Record<string, unknown>> {
    const actor = requireActor(req);
    const locationId = requireString(body.locationId, 'locationId');
    const count = await this.db.transaction().execute(async (trx) =>
      this.inventoryService.startCount(
        actor,
        { locationId, warehouseId: body.warehouseId ?? null },
        trx,
      ),
    );
    return {
      id: count.id,
      tenantId: count.tenant_id,
      locationId: count.location_id,
      warehouseId: count.warehouse_id,
      status: count.status,
      startedByUserId: count.started_by_user_id,
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('stock:write')
  @Post('v1/inventory/counts/:id/lines')
  async setCountedQuantity(
    @Req() req: GuardedRequest,
    @Param('id') countId: string,
    @Body()
    body: {
      variantId?: string;
      warehouseId?: string | null;
      countedQuantity?: number | string;
    },
  ): Promise<Record<string, unknown>> {
    const actor = requireActor(req);
    const line = await this.db.transaction().execute(async (trx) =>
      this.inventoryService.setCountedQuantity(
        actor,
        {
          countId,
          variantId: requireString(body.variantId, 'variantId'),
          warehouseId: body.warehouseId ?? null,
          countedQuantity: toBigInt(body.countedQuantity, 'countedQuantity'),
        },
        trx,
      ),
    );
    return {
      countId: line.count_id,
      variantId: line.variant_id,
      warehouseId: line.warehouse_id,
      expectedQuantity: line.expected_quantity.toString(),
      countedQuantity: line.counted_quantity === null ? null : line.counted_quantity.toString(),
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('stock:write')
  @Post('v1/inventory/counts/:id/submit')
  async submitCount(
    @Req() req: GuardedRequest,
    @Param('id') countId: string,
  ): Promise<{ adjustments: { variantId: string; variance: string }[] }> {
    const actor = requireActor(req);
    const result = await this.db
      .transaction()
      .execute(async (trx) => this.inventoryService.submitCount(actor, countId, trx));
    return {
      adjustments: result.adjustments.map((a) => ({
        variantId: a.variantId,
        variance: a.variance.toString(),
      })),
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('stock:write')
  @Post('v1/inventory/goods-in')
  async receiveGoodsIn(
    @Req() req: GuardedRequest,
    @Body()
    body: {
      poId?: string | null;
      supplierId?: string;
      locationId?: string;
      warehouseId?: string;
      lines?: Array<{
        variantId?: string;
        quantityReceived?: number | string;
        quantityDamaged?: number | string;
        quantityShort?: number | string;
        costPence?: number | string;
      }>;
    },
  ): Promise<{ receiptId: string }> {
    const actor = requireActor(req);
    const lines = body.lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new BadRequestException('Goods-in receipt has no lines');
    }
    return this.db.transaction().execute(async (trx) =>
      this.inventoryService.receiveGoodsIn(
        actor,
        {
          poId: body.poId ?? null,
          supplierId: requireString(body.supplierId, 'supplierId'),
          locationId: requireString(body.locationId, 'locationId'),
          warehouseId: requireString(body.warehouseId, 'warehouseId'),
          lines: lines.map((line) => ({
            variantId: requireString(line.variantId, 'variantId'),
            quantityReceived: toBigInt(line.quantityReceived, 'quantityReceived'),
            quantityDamaged:
              line.quantityDamaged === undefined
                ? 0n
                : toBigInt(line.quantityDamaged, 'quantityDamaged'),
            quantityShort:
              line.quantityShort === undefined ? 0n : toBigInt(line.quantityShort, 'quantityShort'),
            costPence: toBigInt(line.costPence, 'costPence'),
          })),
        },
        trx,
      ),
    );
  }

  @UseGuards(AuthGuard)
  @RequireScope('stock:read')
  @Get('v1/inventory/stock')
  async stock(
    @Req() req: GuardedRequest,
    @Query('variantId') variantId?: string,
    @Query('warehouseId') warehouseId?: string,
  ): Promise<{ stock: { variantId: string; warehouseId: string; quantityOnHand: string }[] }> {
    const actor: Actor = requireActor(req);
    const levels = await this.inventoryService.getStockLevels(actor, {
      variantId: variantId === undefined || variantId === '' ? undefined : variantId,
      warehouseId: warehouseId === undefined || warehouseId === '' ? undefined : warehouseId,
    });
    return {
      stock: levels.map((level) => ({
        variantId: level.variantId,
        warehouseId: level.warehouseId,
        quantityOnHand: level.quantityOnHand.toString(),
      })),
    };
  }

  /**
   * Balances with valuation (Build-11 Objective 1). One row per
   * variant-warehouse: live quantity (stock_balances) plus the
   * weighted-average cost from stock_valuation and the total value
   * (quantity * average). The average is null when the
   * variant-warehouse has no stock_valuation row — the average is
   * unknown, never guessed. Wire shape is snake_case with bigint as
   * decimal strings, like the purchasing controller's views. Unknown
   * variant/warehouse filters return an empty list, never 404 (same
   * as GET /v1/inventory/stock); query params are not UUID-validated
   * by the global interceptor (same as the stock endpoint).
   */
  @RequireScope('stock:read')
  @UseGuards(AuthGuard)
  @Get('v1/inventory/balances')
  async balances(
    @Req() req: GuardedRequest,
    @Query('variantId') variantId?: string,
    @Query('warehouseId') warehouseId?: string,
  ): Promise<{
    balances: Array<{
      variant_id: string;
      warehouse_id: string;
      quantity_on_hand: string;
      weighted_avg_cost_pence: string | null;
      total_value_pence: string | null;
      computed_at: string;
    }>;
  }> {
    const actor = requireActor(req);
    const rows = await this.inventoryService.getBalances(actor, {
      variantId: variantId === undefined || variantId === '' ? undefined : variantId,
      warehouseId: warehouseId === undefined || warehouseId === '' ? undefined : warehouseId,
    });
    return {
      balances: rows.map((row) => ({
        variant_id: row.variantId,
        warehouse_id: row.warehouseId,
        quantity_on_hand: row.quantityOnHand.toString(),
        weighted_avg_cost_pence:
          row.weightedAvgCostPence === null ? null : row.weightedAvgCostPence.toString(),
        total_value_pence:
          row.totalValuePence === null ? null : row.totalValuePence.toString(),
        computed_at: row.computedAt.toISOString(),
      })),
    };
  }

  /**
   * Valuation summary (Build-11 Objective 1). Per-variant totals
   * aggregated across warehouses plus tenant totals — the "what is
   * my stock worth" view. It differs from /balances, which is the
   * per variant-warehouse detail: /valuation rolls the warehouses
   * up per variant (total quantity, value-weighted average, total
   * value) and adds a tenant-level totals row. Numbers reconcile
   * with /balances exactly (same scoped rows underneath).
   */
  @RequireScope('stock:read')
  @UseGuards(AuthGuard)
  @Get('v1/inventory/valuation')
  async valuation(
    @Req() req: GuardedRequest,
    @Query('variantId') variantId?: string,
    @Query('warehouseId') warehouseId?: string,
  ): Promise<{
    valuation: Array<{
      variant_id: string;
      total_quantity_on_hand: string;
      weighted_avg_cost_pence: string | null;
      total_value_pence: string | null;
    }>;
    totals: { total_quantity_on_hand: string; total_value_pence: string | null };
  }> {
    const actor = requireActor(req);
    const result = await this.inventoryService.getValuation(actor, {
      variantId: variantId === undefined || variantId === '' ? undefined : variantId,
      warehouseId: warehouseId === undefined || warehouseId === '' ? undefined : warehouseId,
    });
    return {
      valuation: result.valuation.map((row) => ({
        variant_id: row.variantId,
        total_quantity_on_hand: row.totalQuantityOnHand.toString(),
        weighted_avg_cost_pence:
          row.weightedAvgCostPence === null ? null : row.weightedAvgCostPence.toString(),
        total_value_pence:
          row.totalValuePence === null ? null : row.totalValuePence.toString(),
      })),
      totals: {
        total_quantity_on_hand: result.totals.totalQuantityOnHand.toString(),
        total_value_pence:
          result.totals.totalValuePence === null
            ? null
            : result.totals.totalValuePence.toString(),
      },
    };
  }
}

function requireString(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === '') {
    throw new BadRequestException(`Missing required field: ${field}`);
  }
  return value;
}

/** JSON numbers/strings -> bigint; rejects non-integers and negatives. */
function toBigInt(value: number | string | undefined, field: string): bigint {
  if (value === undefined) {
    throw new BadRequestException(`Missing required field: ${field}`);
  }
  try {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        throw new Error('not an integer');
      }
      return BigInt(value);
    }
    if (!/^-?\d+$/.test(value.trim())) {
      throw new Error('not an integer');
    }
    return BigInt(value.trim());
  } catch {
    throw new BadRequestException(`Field ${field} must be an integer, got ${String(value)}`);
  }
}
