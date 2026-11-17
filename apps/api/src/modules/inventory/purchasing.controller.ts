/**
 * Purchasing controller (Build-04 Worker 4).
 *
 * Thin HTTP over PurchasingService: warehouses, stock transfers,
 * reorder suggestions and purchase orders. Guarded by AuthGuard with
 * the route-table scopes; writes are TenantWriteGuarded. The Actor
 * comes from request.actor (set by the guard) — never from demo
 * headers or the request body. Money and quantities cross the JSON
 * boundary as decimal strings.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PurchasingService } from './purchasing.service';
import type {
  PurchaseOrderLineView,
  PurchaseOrderView,
} from './purchasing.service';
import { AuthGuard, RequireScope } from '../admin/auth.guard';
import { TenantWriteGuard } from '../admin/exit.service';
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

function toPence(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new BadRequestException(`Field ${field} must be an integer quantity (decimal string)`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface CreateWarehouseBody {
  locationId: string;
  name: string;
  type?: 'store' | 'warehouse';
  isDefault?: boolean;
}

interface CreateTransferBody {
  fromWarehouseId: string;
  toWarehouseId: string;
  lines: Array<{ variantId: string; quantity: string }>;
}

interface CreatePurchaseOrderBody {
  supplierId: string;
  warehouseId: string;
  expectedDeliveryDate?: string | null;
  lines: Array<{ variantId: string; quantityOrdered: string; unitCostPence: string }>;
}

interface DismissSuggestionBody {
  reason: string;
}

/**
 * Purchase-order wire shape (snake_case, po_number as a decimal
 * string). Build-12 Objective 3 adds the two migration-019 columns:
 * warehouse_id and expected_delivery_date are null on POs created by
 * accepting a reorder suggestion, which never named either.
 */
function purchaseOrderWire(view: PurchaseOrderView): Record<string, unknown> {
  const { purchaseOrder, lines } = view;
  return {
    ...purchaseOrder,
    po_number: purchaseOrder.po_number.toString(),
    warehouse_id: purchaseOrder.warehouse_id,
    expected_delivery_date:
      purchaseOrder.expected_delivery_date === null
        ? null
        : iso(purchaseOrder.expected_delivery_date),
    sent_at: purchaseOrder.sent_at === null ? null : iso(purchaseOrder.sent_at),
    created_at: iso(purchaseOrder.created_at),
    updated_at: iso(purchaseOrder.updated_at),
    lines: lines.map((line: PurchaseOrderLineView) => ({
      variant_id: line.variant_id,
      quantity_ordered: line.quantity_ordered.toString(),
      quantity_received: line.quantity_received.toString(),
      cost_pence: line.cost_pence.toString(),
    })),
  };
}

@Controller('v1/inventory')
@UseGuards(AuthGuard)
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @RequireScope('stock:read')
  @Get('warehouses')
  async listWarehouses(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const warehouses = await this.purchasing.listWarehouses(actor, parseLimit(limitRaw));
    return warehouses.map((warehouse) => ({
      ...warehouse,
      created_at: iso(warehouse.created_at),
      updated_at: iso(warehouse.updated_at),
    }));
  }

  /**
   * Create a warehouse (Build-10 Objective 2). Guard order follows
   * this controller's established pattern — class-level
   * @UseGuards(AuthGuard), method-level @UseGuards(TenantWriteGuard):
   * class guards run before method guards, so AuthGuard answers 401
   * before TenantWriteGuard can answer 400 (the two-decorator
   * bottom-up trap the catalogue controller documents does not apply
   * here). A second default warehouse for the same location is 409.
   */
  @RequireScope('stock:write')
  @UseGuards(TenantWriteGuard)
  @Post('warehouses')
  async createWarehouse(@Req() req: GuardedRequest, @Body() body: CreateWarehouseBody) {
    const actor = requireActor(req);
    const warehouse = await this.purchasing.createWarehouse(actor, {
      locationId: body.locationId,
      name: body.name,
      type: body.type,
      isDefault: body.isDefault,
    });
    return {
      ...warehouse,
      created_at: iso(warehouse.created_at),
      updated_at: iso(warehouse.updated_at),
    };
  }

  @RequireScope('stock:read')
  @Get('warehouses/:id')
  async getWarehouse(@Req() req: GuardedRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    const warehouse = await this.purchasing.getWarehouse(actor, id);
    return {
      ...warehouse,
      created_at: iso(warehouse.created_at),
      updated_at: iso(warehouse.updated_at),
    };
  }

  @RequireScope('stock:read')
  @Get('transfers')
  async listTransfers(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const transfers = await this.purchasing.listTransfers(actor, parseLimit(limitRaw));
    return transfers.map(({ transfer, lines }) => ({
      ...transfer,
      received_at: transfer.received_at === null ? null : iso(transfer.received_at),
      created_at: iso(transfer.created_at),
      updated_at: iso(transfer.updated_at),
      lines: lines.map((line) => ({
        variant_id: line.variant_id,
        quantity: line.quantity.toString(),
        received_quantity: line.received_quantity.toString(),
      })),
    }));
  }

  @RequireScope('stock:write')
  @UseGuards(TenantWriteGuard)
  @Post('transfers')
  async createTransfer(@Req() req: GuardedRequest, @Body() body: CreateTransferBody) {
    const actor = requireActor(req);
    if (!Array.isArray(body.lines)) {
      throw new BadRequestException('lines must be an array');
    }
    const { transfer, lines } = await this.purchasing.createTransfer(actor, {
      fromWarehouseId: body.fromWarehouseId,
      toWarehouseId: body.toWarehouseId,
      lines: body.lines.map((line) => ({
        variantId: line.variantId,
        quantity: toPence(line.quantity, 'quantity'),
      })),
    });
    return {
      ...transfer,
      received_at: transfer.received_at === null ? null : iso(transfer.received_at),
      created_at: iso(transfer.created_at),
      updated_at: iso(transfer.updated_at),
      lines: lines.map((line) => ({
        variant_id: line.variant_id,
        quantity: line.quantity.toString(),
        received_quantity: line.received_quantity.toString(),
      })),
    };
  }

  @RequireScope('stock:read')
  @Get('reorder-suggestions')
  async listReorderSuggestions(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const suggestions = await this.purchasing.listReorderSuggestions(actor, parseLimit(limitRaw));
    return suggestions.map((suggestion) => ({
      ...suggestion,
      suggested_quantity: suggestion.suggested_quantity.toString(),
      created_at: iso(suggestion.created_at),
    }));
  }

  @RequireScope('stock:write')
  @UseGuards(TenantWriteGuard)
  @Post('reorder-suggestions/:id/accept')
  async acceptReorderSuggestion(@Req() req: GuardedRequest, @Param('id') suggestionId: string) {
    const actor = requireActor(req);
    const view = await this.purchasing.acceptReorderSuggestion(actor, suggestionId);
    return purchaseOrderWire(view);
  }

  @RequireScope('stock:write')
  @UseGuards(TenantWriteGuard)
  @Post('reorder-suggestions/:id/dismiss')
  async dismissReorderSuggestion(
    @Req() req: GuardedRequest,
    @Param('id') suggestionId: string,
    @Body() body: DismissSuggestionBody,
  ) {
    const actor = requireActor(req);
    const suggestion = await this.purchasing.dismissReorderSuggestion(actor, suggestionId, body.reason);
    return {
      ...suggestion,
      suggested_quantity: suggestion.suggested_quantity.toString(),
      created_at: iso(suggestion.created_at),
    };
  }

  @RequireScope('stock:read')
  @Get('purchase-orders')
  async listPurchaseOrders(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const orders = await this.purchasing.listPurchaseOrders(actor, parseLimit(limitRaw));
    return orders.map((view) => purchaseOrderWire(view));
  }

  /**
   * Create a standalone DRAFT purchase order (Build-12 Objective 3,
   * closing the G-UI-06 "no standalone create-PO route" gap). The
   * mounted path is `v1/inventory/purchase-orders` — the same prefix
   * the list and send routes already use; the commission's shorthand
   * "POST /v1/purchasing/purchase-orders" is NOT a mounted path (the
   * Build-09 "POST /v1/products" shorthand was likewise
   * v1/catalogue/products). The supplier, warehouse and every variant
   * must exist and belong to the tenant (404 otherwise); the
   * warehouse's location becomes the PO's location_id.
   */
  @RequireScope('stock:write')
  @UseGuards(TenantWriteGuard)
  @Post('purchase-orders')
  async createPurchaseOrder(@Req() req: GuardedRequest, @Body() body: CreatePurchaseOrderBody) {
    const actor = requireActor(req);
    if (!Array.isArray(body.lines)) {
      throw new BadRequestException('lines must be an array');
    }
    let expectedDeliveryDate: Date | null = null;
    if (body.expectedDeliveryDate !== undefined && body.expectedDeliveryDate !== null) {
      const parsed = new Date(body.expectedDeliveryDate);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('expectedDeliveryDate must be a valid ISO date');
      }
      expectedDeliveryDate = parsed;
    }
    const view = await this.purchasing.createPurchaseOrder(actor, {
      supplierId: body.supplierId,
      warehouseId: body.warehouseId,
      expectedDeliveryDate,
      lines: body.lines.map((line) => ({
        variantId: line.variantId,
        quantityOrdered: toPence(line.quantityOrdered, 'quantityOrdered'),
        unitCostPence: toPence(line.unitCostPence, 'unitCostPence'),
      })),
    });
    return purchaseOrderWire(view);
  }

  @RequireScope('stock:write')
  @UseGuards(TenantWriteGuard)
  @Post('purchase-orders/:id/send')
  async sendPurchaseOrder(@Req() req: GuardedRequest, @Param('id') poId: string) {
    const actor = requireActor(req);
    const view = await this.purchasing.sendPurchaseOrder(actor, poId);
    return purchaseOrderWire(view);
  }
}
