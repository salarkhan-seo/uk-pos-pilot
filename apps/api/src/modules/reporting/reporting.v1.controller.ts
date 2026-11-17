/**
 * Reporting V1 controller (Build-04 Worker 4; Build-05 close fix).
 *
 * Thin HTTP over ReportingService: Z-report read + corrections, VAT
 * period close + CSV exports, settlement reconciliation. Guarded by
 * AuthGuard with the route-table scopes ('accounting:read' throughout
 * — including the writes, exactly as the route table specifies);
 * writes are TenantWriteGuarded. The Actor comes from request.actor.
 * Money crosses the JSON boundary as decimal strings; CSV endpoints
 * return the CSV text with a `text/csv` content type.
 *
 * closeVatPeriod (Build-05): POST /v1/reporting/vat-periods/:id/close
 * closes the EXISTING open period IN PLACE via
 * ReportingService.closeVatPeriodById and returns the SAME :id
 * (closed_at / closed_by_user_id stamped, lines populated). The
 * Build-04 bridge (delete the open row, create a new one, return a
 * new id) is removed. NOTE on the route path: the commission names
 * POST /v1/vat-periods/:id/close, but the route that exists in this
 * codebase — and in the route table — is
 * POST /v1/reporting/vat-periods/:id/close; that is the route fixed
 * here, and no /v1/vat-periods alias was added.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { assertUuid } from '../../common/uuid';
import {
  ReportingService,
  Z_REPORT_CSV_COLUMNS,
  VAT_PERIOD_CSV_COLUMNS,
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

function formatDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

interface RecordCorrectionBody {
  correctionType: string;
  amountPence: string;
  reason: string;
  approvalEventId: string;
}

interface ReconcileSettlementBody {
  businessDate: string;
  payouts: Array<{
    providerReference: string;
    settlementDate: string;
    grossPence: string;
    feePence: string;
    reserveHoldPence: string;
    disputeDebitPence: string;
  }>;
}

@Controller('v1/reporting')
@UseGuards(AuthGuard)
export class ReportingV1Controller {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly reporting: ReportingService,
  ) {}

  @RequireScope('accounting:read')
  @Get('z-reports/:id')
  async getZReport(@Req() req: GuardedRequest, @Param('id') zReportId: string) {
    const actor = requireActor(req);
    const view = await this.reporting.getZReport(actor, zReportId);
    const z = view.zReport;
    return {
      id: z.id,
      z_number: z.z_number.toString(),
      business_date: formatDate(z.business_date),
      register_id: z.register_id,
      gross_pence: z.gross_pence.toString(),
      net_pence: z.net_pence.toString(),
      vat_pence: z.vat_pence.toString(),
      cash_variance_pence: (z.cash_variance_pence ?? 0n).toString(),
    };
  }

  @RequireScope('accounting:read')
  @UseGuards(TenantWriteGuard)
  @Post('z-reports/:id/corrections')
  async recordCorrection(
    @Req() req: GuardedRequest,
    @Param('id') zReportId: string,
    @Body() body: RecordCorrectionBody,
  ) {
    const actor = requireActor(req);
    const correction = await this.reporting.recordCorrection(actor, {
      zReportId,
      // The service validates the correction type against its list.
      correctionType: body.correctionType as Parameters<ReportingService['recordCorrection']>[1]['correctionType'],
      amountPence: toPence(body.amountPence, 'amountPence'),
      reason: body.reason,
      approvalEventId: body.approvalEventId,
    });
    return { id: correction.id };
  }

  @RequireScope('accounting:read')
  @Get('vat-periods/:id')
  async getVatPeriod(@Req() req: GuardedRequest, @Param('id') periodId: string) {
    const actor = requireActor(req);
    // Build-06 Objective 4: the admin shell's finance view could never
    // read a VAT period in live mode (G-UI-02) — no read route existed,
    // only close + CSV. Same shape as closeVatPeriod's return.
    assertUuid(periodId, 'periodId');
    const period = await this.db
      .selectFrom('vat_periods')
      .selectAll()
      .where('id', '=', periodId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirst();
    if (period === undefined) {
      throw new NotFoundException(`VAT period ${periodId} not found`);
    }
    return {
      id: period.id,
      period_start: formatDate(period.period_start),
      period_end: formatDate(period.period_end),
      status: period.status,
      closed_at: period.closed_at === null ? null : period.closed_at.toISOString(),
      closed_by_user_id: period.closed_by_user_id,
    };
  }

  @RequireScope('accounting:read')
  @UseGuards(TenantWriteGuard)
  @Post('vat-periods/:id/close')
  async closeVatPeriod(@Req() req: GuardedRequest, @Param('id') periodId: string) {
    const actor = requireActor(req);
    // A malformed id is a client error (400), never a 500 uuid-cast
    // error from the database (Build-05 UUID guard).
    assertUuid(periodId, 'periodId');
    const closed = await this.reporting.closeVatPeriodById(actor, periodId);
    const period = await this.db
      .selectFrom('vat_periods')
      .selectAll()
      .where('id', '=', closed.periodId)
      .where('tenant_id', '=', actor.tenantId)
      .executeTakeFirstOrThrow();
    return {
      id: closed.periodId,
      period_start: formatDate(period.period_start),
      period_end: formatDate(period.period_end),
      status: 'closed',
      closed_at: period.closed_at === null ? null : period.closed_at.toISOString(),
      closed_by_user_id: period.closed_by_user_id,
    };
  }

  @RequireScope('accounting:read')
  @Header('Content-Type', 'text/csv')
  @Get('z-reports/:id/csv')
  async exportZReportCsv(@Req() req: GuardedRequest, @Param('id') zReportId: string): Promise<string> {
    const actor = requireActor(req);
    const result = await this.reporting.exportZReportCsv(actor, zReportId);
    return result.csv;
  }

  @RequireScope('accounting:read')
  @Header('Content-Type', 'text/csv')
  @Get('vat-periods/:id/csv')
  async exportVatPeriodCsv(@Req() req: GuardedRequest, @Param('id') vatPeriodId: string): Promise<string> {
    const actor = requireActor(req);
    const result = await this.reporting.exportVatPeriodCsv(actor, vatPeriodId);
    return result.csv;
  }

  @RequireScope('accounting:read')
  @UseGuards(TenantWriteGuard)
  @Post('settlements/reconcile')
  async reconcileSettlement(@Req() req: GuardedRequest, @Body() body: ReconcileSettlementBody) {
    const actor = requireActor(req);
    if (!Array.isArray(body.payouts)) {
      throw new BadRequestException('payouts must be an array');
    }
    const result = await this.reporting.reconcileSettlement(
      actor,
      body.businessDate,
      body.payouts.map((payout) => ({
        providerReference: payout.providerReference,
        settlementDate: payout.settlementDate,
        grossPence: toPence(payout.grossPence, 'grossPence'),
        feePence: toPence(payout.feePence, 'feePence'),
        reserveHoldPence: toPence(payout.reserveHoldPence, 'reserveHoldPence'),
        disputeDebitPence: toPence(payout.disputeDebitPence, 'disputeDebitPence'),
      })),
    );
    return {
      businessDate: result.businessDate,
      settlementDate: result.settlementDate,
      cardGrossPence: result.cardGrossPence.toString(),
      feeEstimatePence: result.feeEstimatePence.toString(),
      settledGrossPence: result.settledGrossPence.toString(),
      settledFeePence: result.settledFeePence.toString(),
      reserveHoldTotalPence: result.reserveHoldTotalPence.toString(),
      disputeDebitTotalPence: result.disputeDebitTotalPence.toString(),
      expectedNetPayoutPence: result.expectedNetPayoutPence.toString(),
      status: result.status,
      discrepancyReason: result.discrepancyReason,
    };
  }
}

// Re-exported so tests can assert the CSV endpoints return the exact
// Arch-02 §5.3 column contract.
export { Z_REPORT_CSV_COLUMNS, VAT_PERIOD_CSV_COLUMNS };
