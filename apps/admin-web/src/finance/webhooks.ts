/**
 * Webhook Subscriptions & 30-day Dead-Letter Queue console.
 *
 * Live today: GET /v1/events (cursor-paginated; filter by
 * `delivery_status=dead_letter` for the DLQ view). The DLQ listing is
 * therefore real data; replay/discard, endpoint registration and
 * secret rotation are live routes too (Build-04/05) — the fake
 * implements them as well, so the console's replay/discard flows are
 * testable without a live server.
 *
 * DLQ rules (Build-03): after 11 attempts (10-retry schedule 1m→24h)
 * a delivery moves to the DLQ, where it is retained 30 days, is
 * replayable, is explicitly discardable, and is never auto-deleted.
 * Payloads carry references and amounts only — never PAN, full
 * gift/voucher codes, or customer PII.
 */
import type { AdminApiClient } from '../api/client';
import type { ListedEventView, WebhookDeliveryView, WebhookEndpointView } from '../api/types';

export const DLQ_RETENTION_DAYS = 30;
export const MAX_DELIVERY_ATTEMPTS = 11;

export interface DeadLetterRow {
  event: ListedEventView;
  delivery: WebhookDeliveryView;
  /** Days remaining in the 30-day DLQ retention window. */
  daysRemaining: number | null;
}

export function dlqDaysRemaining(delivery: WebhookDeliveryView, now: Date = new Date()): number | null {
  const createdAt = new Date(delivery.created_at).getTime();
  if (Number.isNaN(createdAt)) return null;
  const elapsedDays = (now.getTime() - createdAt) / (24 * 3600 * 1000);
  return Math.max(0, DLQ_RETENTION_DAYS - Math.floor(elapsedDays));
}

export function toDeadLetterRows(events: ListedEventView[], now: Date = new Date()): DeadLetterRow[] {
  const rows: DeadLetterRow[] = [];
  for (const event of events) {
    for (const delivery of event.deliveries) {
      if (delivery.status === 'dead_letter') {
        rows.push({ event, delivery, daysRemaining: dlqDaysRemaining(delivery, now) });
      }
    }
  }
  return rows;
}

export class WebhookConsole {
  constructor(private readonly api: AdminApiClient) {}

  async listEndpoints(): Promise<WebhookEndpointView[]> {
    return this.api.listWebhookEndpoints();
  }

  async registerEndpoint(input: { url: string; eventTypes: string[] }): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
    if (!/^https:\/\//.test(input.url)) {
      throw new Error('Webhook endpoint URL must be https.');
    }
    if (input.eventTypes.length === 0) {
      throw new Error('At least one event type must be subscribed.');
    }
    return this.api.registerWebhookEndpoint(input);
  }

  /** DLQ view, from the live Events API. */
  async deadLetterQueue(now: Date = new Date()): Promise<DeadLetterRow[]> {
    const result = await this.api.listEvents({ deliveryStatus: 'dead_letter', limit: 200 });
    return toDeadLetterRows(result.events, now);
  }

  async replayDeadLetter(deliveryId: string): Promise<{ id: string; status: string }> {
    return this.api.replayDeadLetter(deliveryId);
  }

  async discardDeadLetter(deliveryId: string): Promise<{ id: string; status: string }> {
    return this.api.discardDeadLetter(deliveryId);
  }
}
