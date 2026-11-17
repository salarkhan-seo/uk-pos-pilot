import { BadRequestException, Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { AdminService } from './admin.service';
import { ApprovalService } from './approval.service';
import { AuditService } from './audit.service';
import { actorFromHeaders } from '../../common/http-actor';
import { APPROVAL_ACTIONS } from '../../common/roles';
import type { ApprovalAction } from '../../common/roles';

/** Admin status (Build-01 surface, kept). */
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('status')
  status(): { module: string; status: string } {
    return this.adminService.status();
  }
}

interface ApprovalBody {
  action: string;
  amountPence?: string | number | null;
  reason?: string | null;
  requestedByUserId: string;
  orderId?: string | null;
  approverPin: string;
}

/**
 * Versioned admin API (Build-02, Objective 2). Demo header auth only —
 * the actor is built from x-tenant-id / x-user-id / x-location-id /
 * x-roles headers; production auth is Build-03 work. The actor is the
 * approver for POST /v1/approvals.
 */
@Controller('v1')
export class AdminV1Controller {
  constructor(
    private readonly approvalService: ApprovalService,
    private readonly auditService: AuditService,
  ) {}

  @Get('audit-events')
  async listAuditEvents(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query('limit') limitRaw?: string,
    @Query('eventType') eventType?: string,
  ) {
    const actor = actorFromHeaders(headers);
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new BadRequestException('limit must be a positive integer');
      }
      limit = parsed;
    }
    return this.auditService.listEvents(actor.tenantId, { limit, eventType });
  }

  @Post('approvals')
  async createApproval(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: ApprovalBody,
  ) {
    const actor = actorFromHeaders(headers);
    if (!(APPROVAL_ACTIONS as readonly string[]).includes(body.action)) {
      throw new BadRequestException(`Unknown approval action: ${body.action}`);
    }
    if (typeof body.requestedByUserId !== 'string' || body.requestedByUserId === '') {
      throw new BadRequestException('requestedByUserId is required');
    }
    if (typeof body.approverPin !== 'string' || body.approverPin === '') {
      throw new BadRequestException('approverPin is required');
    }
    let amountPence: bigint | null = null;
    if (body.amountPence !== undefined && body.amountPence !== null) {
      try {
        amountPence = BigInt(body.amountPence);
      } catch {
        throw new BadRequestException('amountPence must be an integer number of pence');
      }
      if (amountPence < 0n) {
        throw new BadRequestException('amountPence must be non-negative');
      }
    }
    const row = await this.approvalService.approve(actor, {
      action: body.action as ApprovalAction,
      amountPence,
      reason: body.reason ?? null,
      requestedByUserId: body.requestedByUserId,
      orderId: body.orderId ?? null,
      approverPin: body.approverPin,
    });
    // bigint does not JSON-serialise: expose the amount as a decimal string.
    return { ...row, amount_pence: row.amount_pence?.toString() ?? null };
  }
}
