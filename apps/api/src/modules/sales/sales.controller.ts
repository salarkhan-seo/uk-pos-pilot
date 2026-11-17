import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  assertNoDobFields,
  SalesService,
  type AgeVerificationView,
  type ReceiptView,
  type TenderType,
} from './sales.service';
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

/**
 * Sales controller (Build-02, Objective 5).
 *
 * Money crosses the JSON boundary as DECIMAL STRINGS — JSON has no
 * bigint, so request bodies carry pence/quantities as strings ("1250")
 * and responses return them as strings. The Actor comes from
 * request.actor (set by AuthGuard) — never from demo headers, and
 * never from the request body.
 *
 * Auth (Build-10, Objective 1 — owner decision APPROVED): every route
 * is AuthGuard + RequireScope, matching the catalogue, reporting and
 * compliance controllers. Reads need `sales:read`; writes need
 * `sales:write`. A scoped API key (`Bearer ukp_...`, scope
 * `sales:read`/`sales:write` or `admin`) or a 2-hour HMAC PIN session
 * (roles map to scopes — cashiers hold sales:read + sales:write)
 * satisfies the guard. Unauthenticated → 401; wrong scope → 403.
 * Write routes additionally run TenantWriteGuard in the SAME
 * @UseGuards call, AuthGuard first — two separate @UseGuards
 * decorators stack bottom-up and would let TenantWriteGuard run
 * first, answering 400 instead of 401 (Build-09 Obj 1 lesson).
 */
function toPence(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`Field ${field} must be an integer pence amount (decimal string)`);
}

function optionalPence(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return toPence(value, field);
}

function pence(value: bigint): string {
  return value.toString();
}

function receiptJson(receipt: ReceiptView): Record<string, unknown> {
  return {
    receiptNumber: pence(receipt.receiptNumber),
    orderId: receipt.orderId,
    issuedAt: receipt.issuedAt.toISOString(),
    lines: receipt.lines.map((line) => ({
      taxRateKind: line.taxRateKind,
      taxRatePercent: line.taxRatePercent,
      grossPence: pence(line.grossPence),
      vatPence: pence(line.vatPence),
      netPence: pence(line.netPence),
    })),
    totalPence: pence(receipt.totalPence),
    vatInvoiceNotice: receipt.vatInvoiceNotice,
  };
}

interface CreateOrderLineBody {
  variantId: string;
  quantity: string;
  unitId?: string | null;
  manualDiscountPence?: string;
}

interface CreateOrderBody {
  locationId: string;
  registerId?: string | null;
  customerId?: string | null;
  lines: CreateOrderLineBody[];
  voucherCode?: string;
  basketDiscountPence?: string;
  approvalEventsId?: string | null;
}

interface AddTenderBody {
  tenderType: TenderType;
  amountPence: string;
  giftCardCode?: string;
  customerId?: string;
  /**
   * Raw wire `age_verifications` (Build-09, Objective 2): Array of
   * `{ variant_id, verified_age_threshold, verified_by_user_id,
   * verified_at }`. Validated by the service; any DOB-like field is
   * rejected with 400, never dropped. verified_at is optional
   * (Build-11 Objective 2): when absent the server records the
   * verification at the time it is persisted.
   */
  age_verifications?: unknown;
}

interface CompleteOrderBody {
  /**
   * Raw wire `age_verifications` (Build-09, Objective 2) — same shape
   * as on the tender. A restricted line without a verification meeting
   * the 25 threshold rejects completion with 422
   * AGE_VERIFICATION_REQUIRED.
   */
  age_verifications?: unknown;
}

interface RecordOutcomeBody {
  outcome: 'approved' | 'declined' | 'unknown';
  providerReference?: string;
}

interface VoidOrderBody {
  reason?: string;
  /** Required when the order has had a tender (void_post_tender gate). */
  approvalEventsId?: string | null;
}

interface ReturnOrderLineBody {
  orderLineId: string;
  quantity: string;
  disposition: 'restock' | 'damaged';
}

interface ReturnOrderBody {
  lines: ReturnOrderLineBody[];
  refundMethod?: 'card' | 'cash';
  approvalEventsId?: string | null;
  idempotencyKey?: string;
}

interface ManualRefundBody {
  outcome: 'completed' | 'failed';
  providerReference?: string | null;
  reason?: string | null;
}

@Controller()
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Get('sales/status')
  status(): { module: string; status: string } {
    return this.salesService.status();
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/orders')
  async createOrder(
    @Req() req: GuardedRequest,
    @Body() body: CreateOrderBody,
  ) {
    const actor = requireActor(req);
    const { order, lines } = await this.salesService.createOrder(actor, {
      locationId: body.locationId,
      registerId: body.registerId ?? null,
      customerId: body.customerId ?? null,
      lines: body.lines.map((line) => ({
        variantId: line.variantId,
        quantity: toPence(line.quantity, 'quantity'),
        unitId: line.unitId ?? null,
        manualDiscountPence: optionalPence(line.manualDiscountPence, 'manualDiscountPence'),
      })),
      voucherCode: body.voucherCode,
      basketDiscountPence: optionalPence(body.basketDiscountPence, 'basketDiscountPence'),
      approvalEventsId: body.approvalEventsId ?? null,
    });
    return {
      ...order,
      order_number: pence(order.order_number),
      subtotal_pence: pence(order.subtotal_pence),
      discount_pence: pence(order.discount_pence),
      tax_pence: pence(order.tax_pence),
      total_pence: pence(order.total_pence),
      lines: lines.map((line) => ({
        ...line,
        quantity: pence(line.quantity),
        unit_price_pence: pence(line.unit_price_pence),
        base_price_pence: pence(line.base_price_pence),
        price_book_price_pence:
          line.price_book_price_pence === null ? null : pence(line.price_book_price_pence),
        promotion_discount_pence: pence(line.promotion_discount_pence),
        manual_discount_pence: pence(line.manual_discount_pence),
        final_price_pence: pence(line.final_price_pence),
        tax_amount_pence: pence(line.tax_amount_pence),
        line_total_pence: pence(line.line_total_pence),
      })),
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/orders/:id/tenders')
  async addTender(
    @Req() req: GuardedRequest,
    @Param('id') orderId: string,
    @Body() body: AddTenderBody,
  ) {
    const actor = requireActor(req);
    assertNoDobFields(body, 'tender request');
    const tender = await this.salesService.addTender(actor, {
      orderId,
      tenderType: body.tenderType,
      amountPence: toPence(body.amountPence, 'amountPence'),
      giftCardCode: body.giftCardCode,
      customerId: body.customerId,
      ageVerifications: body.age_verifications,
    });
    return { ...tender, amount_pence: pence(tender.amount_pence) };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/orders/:id/complete')
  async completeOrder(
    @Req() req: GuardedRequest,
    @Param('id') orderId: string,
    @Body() body: CompleteOrderBody = {},
  ) {
    const actor = requireActor(req);
    assertNoDobFields(body, 'complete request');
    const { order, receipt } = await this.salesService.completeOrder(
      actor,
      orderId,
      body.age_verifications,
    );
    return {
      order: {
        ...order,
        order_number: pence(order.order_number),
        subtotal_pence: pence(order.subtotal_pence),
        discount_pence: pence(order.discount_pence),
        tax_pence: pence(order.tax_pence),
        total_pence: pence(order.total_pence),
      },
      receipt: receiptJson(receipt),
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/orders/:id/void')
  async voidOrder(
    @Req() req: GuardedRequest,
    @Param('id') orderId: string,
    @Body() body: VoidOrderBody,
  ) {
    const actor = requireActor(req);
    await this.salesService.voidOrder(actor, orderId, body.reason, body.approvalEventsId ?? null);
    return { orderId, status: 'voided' };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/orders/:id/returns')
  async returnOrder(
    @Req() req: GuardedRequest,
    @Param('id') orderId: string,
    @Body() body: ReturnOrderBody,
  ) {
    const actor = requireActor(req);
    const result = await this.salesService.returnOrder(actor, {
      orderId,
      lines: body.lines.map((line) => ({
        orderLineId: line.orderLineId,
        quantity: toPence(line.quantity, 'quantity'),
        disposition: line.disposition,
      })),
      refundMethod: body.refundMethod,
      approvalEventsId: body.approvalEventsId ?? null,
      idempotencyKey: body.idempotencyKey,
    });
    return {
      orderId: result.order.id,
      status: result.order.status,
      refundAmountPence: pence(result.refundAmountPence),
      refundId: result.refund?.id ?? null,
      refundStatus: result.refund?.status ?? null,
      reversedLoyaltyPoints: pence(result.reversedLoyaltyPoints),
      loyaltyShortfallPoints: pence(result.loyaltyShortfallPoints),
      replayed: result.replayed ?? false,
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/refunds/:id/retry')
  async retryRefund(
    @Req() req: GuardedRequest,
    @Param('id') refundId: string,
  ) {
    const actor = requireActor(req);
    const refund = await this.salesService.processRefundRetry(actor, refundId);
    return {
      refundId: refund.id,
      status: refund.status,
      retryCount: refund.retry_count,
      nextRetryAt: refund.next_retry_at?.toISOString() ?? null,
      failureReason: refund.failure_reason,
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/refunds/:id/manual-complete')
  async completeManualRefund(
    @Req() req: GuardedRequest,
    @Param('id') refundId: string,
    @Body() body: ManualRefundBody,
  ) {
    const actor = requireActor(req);
    const refund = await this.salesService.completeManualRefund(actor, {
      refundId,
      outcome: body.outcome,
      providerReference: body.providerReference ?? null,
      reason: body.reason ?? null,
    });
    return {
      refundId: refund.id,
      status: refund.status,
      providerReference: refund.provider_reference,
    };
  }

  @UseGuards(AuthGuard, TenantWriteGuard)
  @RequireScope('sales:write')
  @Post('v1/sales/payment-attempts/:id/outcome')
  async recordCardAttemptOutcome(
    @Req() req: GuardedRequest,
    @Param('id') paymentAttemptId: string,
    @Body() body: RecordOutcomeBody,
  ) {
    const actor = requireActor(req);
    const attempt = await this.salesService.recordCardAttemptOutcome(actor, {
      paymentAttemptId,
      outcome: body.outcome,
      providerReference: body.providerReference,
    });
    return { ...attempt, amount_pence: pence(attempt.amount_pence) };
  }

  @UseGuards(AuthGuard)
  @RequireScope('sales:read')
  @Get('v1/sales/orders/:id/receipt')
  async getReceipt(
    @Req() req: GuardedRequest,
    @Param('id') orderId: string,
  ) {
    const actor = requireActor(req);
    const receipt = await this.salesService.getReceipt(actor, orderId);
    return receiptJson(receipt);
  }

  /**
   * Compliance inspection (Build-09, Objective 2): the stored age
   * verification events for an order. Mounted under v1/sales/orders
   * like the receipt — the commission's "GET /v1/orders/..." is
   * shorthand, not the mounted path (cf. Obj 1's product routes).
   * Tenant-scoped (404 cross-tenant); malformed :id → 400
   * INVALID_UUID via the global interceptor (param named `id`).
   * AuthGuard + RequireScope('sales:read') since Build-10 (the
   * Build-09 `sales:read`-not-enforced gap is closed).
   */
  @UseGuards(AuthGuard)
  @RequireScope('sales:read')
  @Get('v1/sales/orders/:id/age-verifications')
  async listAgeVerifications(
    @Req() req: GuardedRequest,
    @Param('id') orderId: string,
  ): Promise<{ orderId: string; verifications: AgeVerificationView[] }> {
    const actor = requireActor(req);
    const verifications = await this.salesService.listAgeVerifications(actor, orderId);
    return { orderId, verifications };
  }
}
