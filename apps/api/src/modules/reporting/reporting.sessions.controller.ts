/**
 * Register sessions controller (Build-06 Objective 4).
 *
 * Thin HTTP over ReportingService: open / end / close a register
 * session (the two-step End vs Close flow, D-07 zero-float warning,
 * D-08 variance threshold, W-13 pending/unknown card block, Z-report
 * issue on close). The service methods existed since Build-03 but no
 * controller exposed them, so the session lifecycle — and therefore
 * the D-11 exit block that depends on an open session — could not be
 * driven over HTTP at all. Guarded by AuthGuard with the route-table
 * scope ('accounting:read' throughout, including the writes, exactly
 * as the reporting v1 controller specifies); writes are
 * TenantWriteGuarded. Money crosses the JSON boundary as decimal
 * strings, matching the reporting v1 controller.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { assertUuid } from '../../common/uuid';
import {
  ReportingService,
  type SessionRow,
  type ZReportView,
} from './reporting.service';
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

function toPence(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new BadRequestException(`Field ${field} must be an integer pence amount (decimal string)`);
}

function penceOrNull(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function dateOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function sessionView(session: SessionRow) {
  return {
    id: session.id,
    tenant_id: session.tenant_id,
    register_id: session.register_id,
    status: session.status,
    float_pence: session.float_pence.toString(),
    expected_cash_pence: penceOrNull(session.expected_cash_pence),
    counted_cash_pence: penceOrNull(session.counted_cash_pence),
    variance_pence: penceOrNull(session.variance_pence),
    variance_reason: session.variance_reason,
    opened_at: session.opened_at.toISOString(),
    ended_at: dateOrNull(session.ended_at),
    closed_at: dateOrNull(session.closed_at),
  };
}

function formatDate(value: string | Date): string {
  // Kysely returns date columns as Date objects (PGlite and pg alike);
  // the pg driver may also hand back a string. Handle both.
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function zReportSummary(view: ZReportView) {
  const z = view.zReport;
  return {
    id: z.id,
    z_number: z.z_number.toString(),
    business_date: formatDate(z.business_date),
    register_id: z.register_id,
    session_id: z.session_id,
    status: z.status,
    gross_pence: z.gross_pence.toString(),
    net_pence: z.net_pence.toString(),
    vat_pence: z.vat_pence.toString(),
    discount_pence: z.discount_pence.toString(),
    refund_pence: z.refund_pence.toString(),
    cash_expected_pence: penceOrNull(z.cash_expected_pence),
    cash_counted_pence: penceOrNull(z.cash_counted_pence),
    cash_variance_pence: penceOrNull(z.cash_variance_pence),
    order_count: z.order_count,
    void_count: z.void_count,
  };
}

interface OpenSessionBody {
  registerId: string;
  openingFloatPence: string | number;
  approvalEventId?: string | null;
}

interface CloseSessionBody {
  countedCashPence: string | number;
  varianceReason?: string | null;
  approvalEventId?: string | null;
  carryForward?: {
    attemptIds: string[];
    approvalEventId: string;
    note: string;
  } | null;
}

@Controller('v1/reporting/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(private readonly reporting: ReportingService) {}

  @RequireScope('accounting:read')
  @UseGuards(TenantWriteGuard)
  @Post()
  async openSession(@Req() req: GuardedRequest, @Body() body: OpenSessionBody) {
    const actor = requireActor(req);
    const { session, warning } = await this.reporting.openSession(actor, {
      registerId: body.registerId,
      openingFloatPence: toPence(body.openingFloatPence, 'openingFloatPence'),
      approvalEventId: body.approvalEventId ?? undefined,
    });
    return { session: sessionView(session), warning };
  }

  @RequireScope('accounting:read')
  @UseGuards(TenantWriteGuard)
  @Post(':id/end')
  async endSession(@Req() req: GuardedRequest, @Param('id') sessionId: string) {
    const actor = requireActor(req);
    assertUuid(sessionId, 'sessionId');
    const session = await this.reporting.endSession(actor, sessionId);
    return { session: sessionView(session) };
  }

  @RequireScope('accounting:read')
  @UseGuards(TenantWriteGuard)
  @Post(':id/close')
  async closeSession(
    @Req() req: GuardedRequest,
    @Param('id') sessionId: string,
    @Body() body: CloseSessionBody,
  ) {
    const actor = requireActor(req);
    assertUuid(sessionId, 'sessionId');
    const { session, zReport } = await this.reporting.closeSession(actor, {
      sessionId,
      countedCashPence: toPence(body.countedCashPence, 'countedCashPence'),
      varianceReason: body.varianceReason ?? undefined,
      approvalEventId: body.approvalEventId ?? undefined,
      carryForward: body.carryForward ?? undefined,
    });
    return { session: sessionView(session), zReport: zReportSummary(zReport) };
  }
}
