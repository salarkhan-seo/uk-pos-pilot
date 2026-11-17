/**
 * Sync controller (Build-04, Objective 1).
 *
 * Guarded by the existing AuthGuard (Build-03): a scoped API key or a
 * PIN-issued session token, with the required scope checked per route.
 * The Actor comes from request.actor (set by the guard) — never from
 * demo headers, and never from the request body. Cross-tenant
 * addressing is 404, never 403 (G-B), enforced by the guard and by
 * the service's register lookup.
 *
 * Money crosses the JSON boundary as decimal strings (JSON has no
 * bigint), exactly like the sales controller.
 */
import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { SyncService } from './sync.service';
import { assertNoDobFields, parseAgeVerifications } from '../sales/sales.service';
import type {
  FlushOrder,
  FlushRequest,
  FlushResponse,
  HandshakeRequest,
  HandshakeResponse,
} from './sync.dto';
import { AuthGuard, RequireScope } from '../admin/auth.guard';
import { TenantWriteGuard } from '../admin/exit.service';
import type { Actor } from '../../common/actor';

interface GuardedRequest {
  actor?: Actor;
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

function pence(value: bigint): string {
  return value.toString();
}

function requireActor(req: GuardedRequest): Actor {
  if (req.actor === undefined) {
    throw new BadRequestException('Authenticated actor is required');
  }
  return req.actor;
}

interface HandshakeBody {
  registerId: string;
  since?: string | null;
}

interface FlushOrderBody {
  idempotencyKey: string;
  locationId: string;
  registerId: string;
  customerId?: string | null;
  tenderTotalPence: string;
  createdAt: string;
  lines: Array<{
    variantId: string;
    quantity: string;
    snapshotUnitPricePence: string;
    snapshotLineTotalPence: string;
    manualDiscountPence?: string;
    offlineApprovalRef?: string | null;
  }>;
  /**
   * Raw wire `age_verifications` (Build-09, Objective 2) — validated
   * up front like the money strings, so a malformed entry (or any
   * DOB-like field) fails the whole flush with 400 instead of a
   * per-order 'failed' outcome.
   */
  age_verifications?: unknown;
}

interface FlushBody {
  registerId: string;
  orders: FlushOrderBody[];
}

@Controller('v1/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('status')
  status(): { module: string; status: string } {
    return this.syncService.status();
  }

  @RequireScope('sales:read')
  @Post('handshake')
  async handshake(@Req() req: GuardedRequest, @Body() body: HandshakeBody): Promise<HandshakeResponse> {
    const actor = requireActor(req);
    if (typeof body.registerId !== 'string' || body.registerId === '') {
      throw new BadRequestException('registerId is required');
    }
    const request: HandshakeRequest = { registerId: body.registerId, since: body.since ?? null };
    return this.syncService.handshake(actor, request);
  }

  @RequireScope('sales:write')
  @UseGuards(TenantWriteGuard)
  @Post('flush')
  async flush(@Req() req: GuardedRequest, @Body() body: FlushBody): Promise<FlushResponse> {
    const actor = requireActor(req);
    if (typeof body.registerId !== 'string' || body.registerId === '') {
      throw new BadRequestException('registerId is required');
    }
    if (!Array.isArray(body.orders)) {
      throw new BadRequestException('orders must be an array');
    }
    // Validate money strings up front so a malformed order fails fast
    // with a 400 instead of a per-order 'failed' outcome.
    const orders: FlushOrder[] = body.orders.map((order) => {
      if (typeof order.idempotencyKey !== 'string' || order.idempotencyKey === '') {
        throw new BadRequestException('Each order requires an idempotencyKey');
      }
      if (!Array.isArray(order.lines) || order.lines.length === 0) {
        throw new BadRequestException('Each order requires at least one line');
      }
      // Build-09, Objective 2: a DOB-like field anywhere on the order
      // is rejected (400), and malformed age verifications fail fast
      // like malformed money strings. The parsed entries are NOT
      // carried in the DTO — flushOne re-parses the raw wire value
      // (defense in depth; the DTO keeps the wire shape).
      assertNoDobFields(order, 'flush order');
      void parseAgeVerifications(order.age_verifications);
      void toPence(order.tenderTotalPence, 'tenderTotalPence');
      for (const line of order.lines) {
        void toPence(line.quantity, 'quantity');
        void toPence(line.snapshotUnitPricePence, 'snapshotUnitPricePence');
        void toPence(line.snapshotLineTotalPence, 'snapshotLineTotalPence');
        if (line.manualDiscountPence !== undefined) {
          void toPence(line.manualDiscountPence, 'manualDiscountPence');
        }
      }
      return {
        idempotencyKey: order.idempotencyKey,
        locationId: order.locationId,
        registerId: order.registerId,
        customerId: order.customerId ?? null,
        tenderTotalPence: order.tenderTotalPence,
        createdAt: order.createdAt,
        lines: order.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          snapshotUnitPricePence: line.snapshotUnitPricePence,
          snapshotLineTotalPence: line.snapshotLineTotalPence,
          manualDiscountPence: line.manualDiscountPence,
          offlineApprovalRef: line.offlineApprovalRef ?? null,
        })),
        age_verifications:
          order.age_verifications === undefined
            ? undefined
            : (order.age_verifications as FlushOrder['age_verifications']),
      };
    });
    const request: FlushRequest = { registerId: body.registerId, orders };
    const response = await this.syncService.flush(actor, request);
    // Normalise money in the response to decimal strings (the service
    // already returns strings; this is a belt-and-braces pass).
    return {
      serverTime: response.serverTime,
      outcomes: response.outcomes.map((outcome) => ({
        ...outcome,
        orderTotalPence: outcome.orderTotalPence === null ? null : pence(BigInt(outcome.orderTotalPence)),
      })),
    };
  }
}
