import { BadRequestException, Controller, Get, Headers, Query } from '@nestjs/common';
import { WebhookService, type ListedEvent } from './webhook.service';

/** HTTP shape of one listed event: bigint sequence serialised as a decimal string. */
export type ListedEventJson = Omit<ListedEvent, 'sequence'> & { sequence: string };
export interface ListEventsJsonResult {
  events: ListedEventJson[];
  nextCursor: string | null;
}
import { actorFromHeaders } from '../../common/http-actor';

/**
 * Events API (Arch-02 §3.5) — GET /v1/events.
 *
 * The polling/reconciliation path: an integration that missed events
 * re-fetches them here, cursor-paginated, filtered by event_type,
 * created_after and delivery_status (delivered / pending / failed /
 * dead_letter). Each event returns the full payload, its delivery
 * attempts and its DLQ status. Tenant-scoped by the Actor headers
 * (demo header auth — see common/http-actor.ts).
 */
@Controller('v1/events')
export class EventsController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get()
  async list(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query('event_type') eventType?: string,
    @Query('created_after') createdAfter?: string,
    @Query('delivery_status') deliveryStatus?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ListEventsJsonResult> {
    const actor = actorFromHeaders(headers);
    const parsedLimit = limit === undefined ? undefined : Number.parseInt(limit, 10);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }
    const parsedCreatedAfter = createdAfter === undefined ? undefined : new Date(createdAfter);
    if (parsedCreatedAfter !== undefined && Number.isNaN(parsedCreatedAfter.getTime())) {
      throw new BadRequestException('created_after must be an ISO date');
    }
    if (
      deliveryStatus !== undefined &&
      !['pending', 'delivered', 'failed', 'dead_letter'].includes(deliveryStatus)
    ) {
      throw new BadRequestException('delivery_status must be pending, delivered, failed or dead_letter');
    }
    const result = await this.webhookService.listEvents(actor.tenantId, {
      eventType,
      createdAfter: parsedCreatedAfter,
      deliveryStatus: deliveryStatus as 'pending' | 'delivered' | 'failed' | 'dead_letter' | undefined,
      limit: parsedLimit,
      cursor: cursor ?? null,
    });
    // Build-06 Objective 4: the per-tenant sequence is a bigint in the
    // service return type, and JSON.stringify throws on bigint — the
    // raw service result 500s over HTTP. Serialise it as a decimal
    // string at this HTTP boundary (the service contract is unchanged).
    return {
      events: result.events.map((event) => ({ ...event, sequence: event.sequence.toString() })),
      nextCursor: result.nextCursor,
    };
  }
}
