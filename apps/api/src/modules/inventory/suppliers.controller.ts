/**
 * Suppliers controller (Build-10 Objective 2).
 *
 * Mounted at v1/purchasing — the commission's exact paths. This is a
 * second controller in the InventoryModule, not a new module: the
 * PurchasingService and the AuthGuard/TenantWriteGuard providers
 * already live here (AdminModule import), and splitting the purchasing
 * domain across two modules would duplicate that wiring for no gain.
 *
 * Guard pattern follows the catalogue controller exactly: no
 * class-level guard on this controller, so writes carry AuthGuard and
 * TenantWriteGuard in ONE @UseGuards(AuthGuard, TenantWriteGuard)
 * call, AuthGuard first. Two separate @UseGuards decorators stack
 * bottom-up, which puts TenantWriteGuard first — and it answers an
 * unauthenticated write with 400 ("Tenant id is required") before
 * AuthGuard can answer 401 (Build-09 Obj 1). Reads carry
 * @UseGuards(AuthGuard) + @RequireScope. The `:id` param is named
 * `id` so the global UuidValidationInterceptor answers 400
 * INVALID_UUID for malformed ids; cross-tenant/unknown is 404 (G-B).
 * Money crosses the JSON boundary as decimal strings.
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

interface CreateSupplierBody {
  name: string;
  currency?: string;
  leadTimeDays?: number | null;
  minOrderValuePence?: number | string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface LinkSupplierVariantBody {
  variantId: string;
  supplierSku?: string | null;
  costPence: number | string;
  currency?: string;
  isPreferred?: boolean;
}

@Controller('v1/purchasing')
export class SuppliersController {
  constructor(private readonly purchasing: PurchasingService) {}

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('stock:write')
  @Post('suppliers')
  async createSupplier(@Req() req: GuardedRequest, @Body() body: CreateSupplierBody) {
    const actor = requireActor(req);
    const supplier = await this.purchasing.createSupplier(actor, {
      name: body.name,
      currency: body.currency,
      leadTimeDays: body.leadTimeDays ?? null,
      minOrderValuePence:
        body.minOrderValuePence === undefined || body.minOrderValuePence === null
          ? null
          : toPence(body.minOrderValuePence, 'minOrderValuePence'),
      contactName: body.contactName ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
    });
    return {
      ...supplier,
      minimum_order_value_pence:
        supplier.minimum_order_value_pence === null
          ? null
          : supplier.minimum_order_value_pence.toString(),
      created_at: iso(supplier.created_at),
      updated_at: iso(supplier.updated_at),
    };
  }

  @UseGuards(AuthGuard)
  @RequireScope('stock:read')
  @Get('suppliers')
  async listSuppliers(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const suppliers = await this.purchasing.listSuppliers(actor, parseLimit(limitRaw));
    return suppliers.map((supplier) => ({
      ...supplier,
      minimum_order_value_pence:
        supplier.minimum_order_value_pence === null
          ? null
          : supplier.minimum_order_value_pence.toString(),
      created_at: iso(supplier.created_at),
      updated_at: iso(supplier.updated_at),
    }));
  }

  @UseGuards(AuthGuard)
  @RequireScope('stock:read')
  @Get('suppliers/:id')
  async getSupplier(@Req() req: GuardedRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    const supplier = await this.purchasing.getSupplier(actor, id);
    return {
      ...supplier,
      minimum_order_value_pence:
        supplier.minimum_order_value_pence === null
          ? null
          : supplier.minimum_order_value_pence.toString(),
      created_at: iso(supplier.created_at),
      updated_at: iso(supplier.updated_at),
    };
  }

  /**
   * Link a variant to a supplier (upsert: re-linking the same pair
   * replaces the row). `is_preferred` is stored on the link
   * (migration 017); without a currency the supplier's own currency
   * is used.
   */
  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('stock:write')
  @Post('suppliers/:id/variants')
  async linkSupplierVariant(
    @Req() req: GuardedRequest,
    @Param('id') supplierId: string,
    @Body() body: LinkSupplierVariantBody,
  ) {
    const actor = requireActor(req);
    const link = await this.purchasing.linkSupplierVariant(actor, supplierId, {
      variantId: body.variantId,
      supplierSku: body.supplierSku ?? null,
      costPence: toPence(body.costPence, 'costPence'),
      currency: body.currency,
      isPreferred: body.isPreferred,
    });
    return {
      ...link,
      cost_pence: link.cost_pence.toString(),
      created_at: iso(link.created_at),
    };
  }
}
