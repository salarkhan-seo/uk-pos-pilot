/**
 * CRM controller (Build-04 Worker 4).
 *
 * Thin HTTP over CrmService (lists) and GdprService (per-customer
 * export + Art. 17 erasure). Guarded by AuthGuard with the route-table
 * scopes. The Actor comes from request.actor (set by the guard) —
 * never from demo headers or the request body.
 *
 * TenantWriteGuard: applied to the erasure write only. The export is a
 * POST that creates an export job, but it is NOT write-guarded: a GDPR
 * export must stay possible inside the 30-day export window (the same
 * reasoning as the full export — the window exists so data can leave).
 * There is deliberately no consent create/edit/delete route here:
 * marketing_consents is append-only history.
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
import { CrmService } from './crm.service';
import { GdprService } from './gdpr.service';
import { AuthGuard, RequireScope } from './auth.guard';
import { TenantWriteGuard } from './exit.service';
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface AssignCustomerToGroupBody {
  groupId: string;
}

@Controller('v1/crm')
@UseGuards(AuthGuard)
export class CrmController {
  constructor(
    private readonly crm: CrmService,
    private readonly gdpr: GdprService,
  ) {}

  @RequireScope('sales:read')
  @Get('customers')
  async listCustomers(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const customers = await this.crm.listCustomers(actor, parseLimit(limitRaw));
    return customers.map((customer) => ({
      ...customer,
      created_at: iso(customer.created_at),
      updated_at: iso(customer.updated_at),
    }));
  }

  @RequireScope('sales:read')
  @Get('customers/:id/consents')
  async listConsents(
    @Req() req: GuardedRequest,
    @Param('id') customerId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const actor = requireActor(req);
    const consents = await this.crm.listConsents(actor, customerId, parseLimit(limitRaw));
    return consents.map((consent) => ({
      ...consent,
      recorded_at: iso(consent.recorded_at),
      created_at: iso(consent.created_at),
    }));
  }

  @RequireScope('sales:read')
  @Get('customers/:id/loyalty-ledger')
  async listLoyaltyLedger(
    @Req() req: GuardedRequest,
    @Param('id') customerId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const actor = requireActor(req);
    const entries = await this.crm.listLoyaltyLedger(actor, customerId, parseLimit(limitRaw));
    return entries.map((entry) => ({
      ...entry,
      points: entry.points.toString(),
      created_at: iso(entry.created_at),
    }));
  }

  @RequireScope('sales:read')
  @Get('gift-cards')
  async listGiftCards(@Req() req: GuardedRequest, @Query('limit') limitRaw?: string) {
    const actor = requireActor(req);
    const cards = await this.crm.listGiftCards(actor, parseLimit(limitRaw));
    return cards.map((card) => ({
      ...card,
      initial_amount_pence: card.initial_amount_pence.toString(),
      balance_pence: card.balance_pence.toString(),
      issued_at: iso(card.issued_at),
      expires_at: card.expires_at === null ? null : iso(card.expires_at),
    }));
  }

  @RequireScope('sales:read')
  @Get('customers/:id/store-credit')
  async listStoreCredit(
    @Req() req: GuardedRequest,
    @Param('id') customerId: string,
    @Query('limit') limitRaw?: string,
  ) {
    const actor = requireActor(req);
    const entries = await this.crm.listStoreCredit(actor, customerId, parseLimit(limitRaw));
    return entries.map((entry) => ({
      kind: entry.kind,
      amount_pence: entry.amount_pence.toString(),
      created_at: iso(entry.created_at),
    }));
  }

  /**
   * Assign a customer to a manual customer group (Build-12 Objective
   * 3, closing the G-UI-06 "no customer-group assignment route" gap).
   * Scope follows the neighbouring CRM writes (export/erase): `admin`
   * — no `crm:write` scope exists anywhere in this codebase, and none
   * is invented here. The write is TenantWriteGuarded like the
   * erasure (unlike the export, which must stay possible inside the
   * 30-day window). IDEMPOTENT: a repeat call returns the existing
   * membership (same created_at), never a duplicate row. The `:id`
   * param is named `id` so the global UuidValidationInterceptor
   * answers 400 INVALID_UUID for malformed ids; the body's groupId
   * is validated the same way. Customer and group must both exist
   * and belong to the tenant (404 otherwise — G-B).
   */
  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('customers/:id/groups')
  async assignCustomerToGroup(
    @Req() req: GuardedRequest,
    @Param('id') customerId: string,
    @Body() body: AssignCustomerToGroupBody,
  ) {
    const actor = requireActor(req);
    if (typeof body.groupId !== 'string' || body.groupId.trim() === '') {
      throw new BadRequestException('groupId is required');
    }
    const { membership } = await this.crm.assignCustomerToGroup(actor, customerId, body.groupId);
    return { ...membership, created_at: iso(membership.created_at) };
  }

  @RequireScope('admin')
  @Post('customers/:id/export')
  async exportCustomer(@Req() req: GuardedRequest, @Param('id') customerId: string) {
    const actor = requireActor(req);
    return this.gdpr.exportCustomer(actor.tenantId, customerId, actor.userId);
  }

  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('customers/:id/erase')
  async eraseCustomer(@Req() req: GuardedRequest, @Param('id') customerId: string) {
    const actor = requireActor(req);
    return this.gdpr.eraseCustomer(actor.tenantId, customerId);
  }
}
