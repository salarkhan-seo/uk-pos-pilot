/**
 * Integrations tests (Build-03, Objective 4) — outbound webhooks,
 * HMAC signing, retry schedule, DLQ replay/discard, Events API.
 *
 * Each test creates its own PGlite database (createTestDb) and seeds
 * one tenant. Delivery uses an injected fake `deliver` function
 * returning scripted status codes — NO real HTTP anywhere in these
 * tests. Time is controlled through an injected clock.
 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant } from '@uk-pos/db';
import type { DB, SeededTenant } from '@uk-pos/db';
import { AuditService } from '../../src/modules/admin/audit.service';
import {
  RETRY_DELAYS_MS,
  WEBHOOK_EVENT_TYPES,
} from '../../src/modules/integrations/webhook-catalog';
import { WebhookService, type DeliverRequest } from '../../src/modules/integrations/webhook.service';

async function withSeededDb<T>(
  fn: (ctx: { db: Kysely<DB>; tenant: SeededTenant }) => Promise<T>,
): Promise<T> {
  const { db, close } = await createTestDb();
  try {
    const tenant = await seedTenant(db);
    return await fn({ db, tenant });
  } finally {
    await close();
  }
}

/** Scripted fake delivery: returns the next scripted outcome (status code, or throws). */
function scriptedDeliver(script: Array<number | Error>) {
  const requests: DeliverRequest[] = [];
  let index = 0;
  const deliver = async (request: DeliverRequest): Promise<number> => {
    requests.push(request);
    const outcome = script[Math.min(index, script.length - 1)] as number | Error;
    index += 1;
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  return { deliver, requests };
}

function services(
  db: Kysely<DB>,
  options: { deliver: (request: DeliverRequest) => Promise<number>; clock: () => Date },
): { audit: AuditService; webhooks: WebhookService } {
  const audit = new AuditService(db);
  const webhooks = new WebhookService(db, audit, {
    deliver: options.deliver,
    clock: options.clock,
  });
  return { audit, webhooks };
}

describe('WebhookService — HMAC signing (Arch-02 §3.3)', () => {
  it('signs and verifies; tampered body fails; stale timestamp rejected; constant-time compare', async () => {
    const secret = 'test-secret';
    const timestamp = 1_792_000_000;
    const body = JSON.stringify({ event_id: 'abc', total_pence: 1200 });

    const signature = WebhookService.signPayload(secret, timestamp, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signature).toBe(
      `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`,
    );

    // Correct signature passes (now == timestamp).
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp)).toBe(true);

    // Tampered body fails.
    expect(
      WebhookService.verifySignature(
        secret,
        timestamp,
        JSON.stringify({ event_id: 'abc', total_pence: 9999 }),
        signature,
        timestamp,
      ),
    ).toBe(false);

    // Wrong secret fails.
    expect(WebhookService.verifySignature('other-secret', timestamp, body, signature, timestamp)).toBe(false);

    // Timestamp older than 5 minutes is rejected (replay protection).
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp + 301)).toBe(false);
    // Exactly 5 minutes old is still accepted.
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp + 300)).toBe(true);
    // A future timestamp beyond the window is also rejected.
    expect(WebhookService.verifySignature(secret, timestamp, body, signature, timestamp - 301)).toBe(false);

    // A signature of the wrong length fails without throwing (constant-time path).
    expect(WebhookService.verifySignature(secret, timestamp, body, 'sha256=short', timestamp)).toBe(false);
    expect(WebhookService.verifySignature(secret, timestamp, body, '', timestamp)).toBe(false);
  });

  it('delivers a signed request whose signature verifies against the endpoint secret', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver, requests } = scriptedDeliver([200]);
      let now = new Date('2026-11-13T12:00:00.000Z');
      const { webhooks } = services(db, { deliver, clock: () => now });
      const { endpoint, secret } = await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', [
        'order.completed',
      ]);

      await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 1200,
      });

      expect(requests).toHaveLength(1);
      const request = requests[0] as DeliverRequest;
      expect(request.url).toBe('https://example.test/hook');
      expect(request.headers['X-Webhook-Event-Id']).toMatch(/^[0-9a-f-]{36}$/);
      const timestamp = Number(request.headers['X-Webhook-Timestamp']);
      expect(timestamp).toBe(Math.floor(now.getTime() / 1000));
      expect(
        WebhookService.verifySignature(
          secret,
          timestamp,
          request.body,
          request.headers['X-Webhook-Signature'] as string,
          timestamp,
        ),
      ).toBe(true);
      const parsedBody = JSON.parse(request.body) as Record<string, unknown>;
      expect(parsedBody.event_type).toBe('order.completed');
      expect(parsedBody.sequence).toBe('1');
      expect((parsedBody.payload as Record<string, unknown>).order_id).toBe(
        '00000000-0000-0000-0000-000000000001',
      );
      void endpoint;
    });
  });
});

describe('WebhookService — catalog, endpoints, publish validation', () => {
  it('exposes the 34-event catalog (Arch-02 §3.2 + Arch-06/09/10 additions)', () => {
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(34);
    for (const eventType of [
      'order.completed',
      'payment.unknown',
      'z_report.issued',
      'tenant.deleted',
      'stock.low',
      'stock.transferred',
      'customer.group_changed',
      'loyalty.points_earned',
      'loyalty.points_redeemed',
      'gift_card.issued',
      'gift_card.redeemed',
      'promotion.created',
      'promotion.updated',
      'voucher.redeemed',
      'loyalty_campaign.started',
      'loyalty_campaign.ended',
    ]) {
      expect(WEBHOOK_EVENT_TYPES).toContain(eventType);
    }
  });

  it('rejects plain-HTTP endpoints, unknown event types, and stores only the secret hash', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver } = scriptedDeliver([200]);
      const { webhooks } = services(db, { deliver, clock: () => new Date() });

      await expect(
        webhooks.registerEndpoint(tenant.tenantId, 'http://example.test/hook', ['order.completed']),
      ).rejects.toThrow('HTTPS');
      await expect(
        webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', [
          'order.completed',
          'not.a.real.event' as never,
        ]),
      ).rejects.toThrow('Unknown webhook event type');

      const { endpoint, secret } = await webhooks.registerEndpoint(
        tenant.tenantId,
        'https://example.test/hook',
        ['order.completed'],
      );
      expect(secret).toHaveLength(64);
      expect(endpoint.secret_hash).not.toBe(secret);
      expect(endpoint.secret_hash).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'));
      expect(endpoint.status).toBe('active');
    });
  });

  it('publishes only to subscribed active endpoints, with per-tenant sequences', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver } = scriptedDeliver([200]);
      const { webhooks } = services(db, { deliver, clock: () => new Date() });
      const other = await seedTenant(db, { name: 'Other Shop Ltd' });

      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/orders', ['order.completed']);
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/payments', ['payment.approved']);
      const disabled = await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/disabled', [
        'order.completed',
      ]);
      await webhooks.disableEndpoint(disabled.endpoint.id);

      const first = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 1200,
      });
      expect(first.sequence).toBe(1n);
      expect(first.deliveryIds).toHaveLength(1); // payments endpoint not subscribed; disabled endpoint skipped

      const second = await webhooks.publish('payment.approved', {
        tenant_id: tenant.tenantId,
        payment_attempt_id: '00000000-0000-0000-0000-000000000002',
        amount_pence: 1200,
      });
      expect(second.sequence).toBe(2n);
      expect(second.deliveryIds).toHaveLength(1);

      // The other tenant's sequence starts at 1 independently.
      const otherPublished = await webhooks.publish('order.completed', {
        tenant_id: other.tenantId,
        order_id: '00000000-0000-0000-0000-000000000003',
        total_pence: 500,
      });
      expect(otherPublished.sequence).toBe(1n);
      expect(otherPublished.deliveryIds).toHaveLength(0); // no endpoints for the other tenant
    });
  });

  it('rejects payloads carrying PII, codes or card data, unknown types, and a missing tenant_id', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver } = scriptedDeliver([200]);
      const { webhooks } = services(db, { deliver, clock: () => new Date() });
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);

      await expect(
        webhooks.publish('order.completed', {
          tenant_id: tenant.tenantId,
          order_id: 'x',
          email: 'customer@example.test',
        }),
      ).rejects.toThrow('forbidden field "email"');
      await expect(
        webhooks.publish('gift_card.issued', {
          tenant_id: tenant.tenantId,
          gift_card_id: 'x',
          code: 'FULL-CODE-1234',
        }),
      ).rejects.toThrow('forbidden field "code"');
      await expect(
        webhooks.publish('order.completed', {
          tenant_id: tenant.tenantId,
          nested: { card_number: '4111111111111111' },
        }),
      ).rejects.toThrow('forbidden field "card_number"');
      await expect(
        webhooks.publish('not.a.real.event', { tenant_id: tenant.tenantId }),
      ).rejects.toThrow('Unknown webhook event type');
      await expect(
        webhooks.publish('order.completed', { order_id: 'x' }),
      ).rejects.toThrow('tenant_id');
    });
  });
});

describe('WebhookService — retry schedule and dead-letter queue (Arch-02 §3.4)', () => {
  it('walks the exact retry delays on 5xx, then moves to dead_letter after attempt 11', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver } = scriptedDeliver([500]);
      let now = new Date('2026-11-13T12:00:00.000Z');
      const { webhooks, audit } = services(db, { deliver, clock: () => now });
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);

      const published = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 1200,
      });
      const deliveryId = published.deliveryIds[0] as string;

      // Attempt 1 (initial delivery) at T0.
      let delivery = await webhooks.getDelivery(deliveryId);
      expect(delivery?.status).toBe('pending');
      expect(delivery?.attempt_count).toBe(1);
      expect(delivery?.last_status_code).toBe(500);
      expect(delivery?.next_attempt_at?.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[0]);

      // Attempts 2..11, each at its scheduled time, each advancing by the exact delay.
      let expectedTime = now.getTime();
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        expectedTime += RETRY_DELAYS_MS[attempt - 2] as number;
        now = new Date(expectedTime);
        const attempted = await webhooks.processDueDeliveries(now);
        expect(attempted).toContain(deliveryId);
        delivery = await webhooks.getDelivery(deliveryId);
        expect(delivery?.attempt_count).toBe(attempt);
        if (attempt < 11) {
          expect(delivery?.status).toBe('pending');
          expect(delivery?.next_attempt_at?.getTime()).toBe(
            expectedTime + (RETRY_DELAYS_MS[attempt - 1] as number),
          );
        } else {
          expect(delivery?.status).toBe('dead_letter');
          expect(delivery?.dlq_entered_at?.getTime()).toBe(expectedTime);
          expect(delivery?.next_attempt_at).toBeNull();
        }
      }

      // The DLQ entry is audited.
      const dlqEvents = await audit.listEvents(tenant.tenantId, { eventType: 'webhook.dlq_entered' });
      expect(dlqEvents).toHaveLength(1);

      // A dead-letter delivery is not retried by the due sweep.
      now = new Date(expectedTime + 30 * 24 * 60 * 60 * 1000);
      expect(await webhooks.processDueDeliveries(now)).not.toContain(deliveryId);
    });
  });

  it('retries on timeout/connection failure, never on 3xx/4xx', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      // One service, one endpoint; the script is mutated between
      // publishes so the secret stays in the same instance's memory.
      const script: Array<number | Error> = [400];
      const { deliver } = scriptedDeliver(script);
      const { webhooks } = services(db, {
        deliver,
        clock: () => new Date('2026-11-13T12:00:00.000Z'),
      });
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);

      // 400: terminal, no retry.
      const published400 = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 100,
      });
      const delivery400 = await webhooks.getDelivery(published400.deliveryIds[0] as string);
      expect(delivery400?.status).toBe('failed');
      expect(delivery400?.attempt_count).toBe(1);
      expect(delivery400?.next_attempt_at).toBeNull();
      expect(delivery400?.last_status_code).toBe(400);

      // 302: terminal, no retry.
      script[0] = 302;
      const published302 = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000002',
        total_pence: 100,
      });
      const delivery302 = await webhooks.getDelivery(published302.deliveryIds[0] as string);
      expect(delivery302?.status).toBe('failed');
      expect(delivery302?.attempt_count).toBe(1);
      expect(delivery302?.next_attempt_at).toBeNull();

      // Connection failure (throw): retryable, next attempt in 1 minute.
      script[0] = new Error('ECONNREFUSED');
      const publishedThrow = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000003',
        total_pence: 100,
      });
      const deliveryThrow = await webhooks.getDelivery(publishedThrow.deliveryIds[0] as string);
      expect(deliveryThrow?.status).toBe('pending');
      expect(deliveryThrow?.attempt_count).toBe(1);
      expect(deliveryThrow?.last_status_code).toBeNull();
      expect(deliveryThrow?.next_attempt_at?.getTime()).toBe(
        new Date('2026-11-13T12:00:00.000Z').getTime() + 60_000,
      );
    });
  });

  it('a 2xx marks the delivery delivered', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver } = scriptedDeliver([204]);
      const { webhooks } = services(db, { deliver, clock: () => new Date() });
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);
      const published = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 100,
      });
      const delivery = await webhooks.getDelivery(published.deliveryIds[0] as string);
      expect(delivery?.status).toBe('delivered');
      expect(delivery?.attempt_count).toBe(1);
      expect(delivery?.last_status_code).toBe(204);
      expect(delivery?.next_attempt_at).toBeNull();
    });
  });

  it('replays a dead-letter delivery (clears dead_letter on success) and discards explicitly', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      let now = new Date('2026-11-13T12:00:00.000Z');
      const script: Array<number | Error> = [500];
      const { deliver, requests } = scriptedDeliver(script);
      const { webhooks, audit } = services(db, { deliver, clock: () => now });
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', ['order.completed']);

      // Drive one delivery to the DLQ (attempt 1 + 10 retries).
      const published = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000001',
        total_pence: 100,
      });
      const deliveryId = published.deliveryIds[0] as string;
      let expectedTime = now.getTime();
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        expectedTime += RETRY_DELAYS_MS[attempt - 2] as number;
        now = new Date(expectedTime);
        await webhooks.processDueDeliveries(now);
      }
      expect((await webhooks.getDelivery(deliveryId))?.status).toBe('dead_letter');

      // Replay with the endpoint healthy again: success clears dead_letter.
      script.push(200);
      const replayed = await webhooks.replayDeadLetter(deliveryId, now);
      expect(replayed.status).toBe('delivered');
      expect(replayed.attempt_count).toBe(1); // replay restarts the attempt count
      expect(replayed.dlq_entered_at).toBeNull();
      expect(requests).toHaveLength(12);
      expect(
        (await audit.listEvents(tenant.tenantId, { eventType: 'webhook.replayed' })).length,
      ).toBe(1);

      // A second delivery to the DLQ, then an explicit discard.
      // (Flip the script back to 500 BEFORE publishing, or the first
      // attempt would succeed and there would be nothing to replay.)
      script[script.length - 1] = 500;
      const published2 = await webhooks.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000002',
        total_pence: 200,
      });
      const deliveryId2 = published2.deliveryIds[0] as string;
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        expectedTime += RETRY_DELAYS_MS[attempt - 2] as number;
        now = new Date(expectedTime);
        await webhooks.processDueDeliveries(now);
      }
      expect((await webhooks.getDelivery(deliveryId2))?.status).toBe('dead_letter');
      const discarded = await webhooks.discardDeadLetter(deliveryId2);
      expect(discarded.status).toBe('failed');
      expect(discarded.last_error).toContain('discarded by operator');
      expect(
        (await audit.listEvents(tenant.tenantId, { eventType: 'webhook.discarded' })).length,
      ).toBe(1);

      // Replay/discard of a non-DLQ delivery is rejected.
      await expect(webhooks.replayDeadLetter(deliveryId, now)).rejects.toThrow(
        'Only a dead-letter delivery can be replayed',
      );
      await expect(webhooks.discardDeadLetter(deliveryId, now)).rejects.toThrow(
        'Only a dead-letter delivery can be discarded',
      );
    });
  });
});

describe('WebhookService — Events API (Arch-02 §3.5)', () => {
  it('cursor-paginates newest-first and filters by type, created_after and delivery_status', async () => {
    await withSeededDb(async ({ db, tenant }) => {
      const { deliver } = scriptedDeliver([200]);
      let now = new Date('2026-11-13T12:00:00.000Z');
      const { webhooks } = services(db, { deliver, clock: () => now });
      await webhooks.registerEndpoint(tenant.tenantId, 'https://example.test/hook', [
        'order.completed',
        'payment.approved',
      ]);

      for (let i = 1; i <= 5; i += 1) {
        await webhooks.publish(i % 2 === 0 ? 'payment.approved' : 'order.completed', {
          tenant_id: tenant.tenantId,
          order_id: `00000000-0000-0000-0000-00000000000${i}`,
          total_pence: i * 100,
          ...(i % 2 === 0
            ? { payment_attempt_id: `00000000-0000-0000-0000-00000000000${i}` }
            : {}),
        });
      }

      // Page 1 (limit 2): two events and a cursor. (Page order is
      // newest-first by created_at; created_at is the DB clock, so
      // the test asserts counts and coverage, not which event is
      // first — all five share one wall-clock instant.)
      const page1 = await webhooks.listEvents(tenant.tenantId, { limit: 2 });
      expect(page1.events).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.events[0]?.deliveries).toHaveLength(1);
      expect(page1.events[0]?.deliveries[0]?.status).toBe('delivered');

      // Page 2, then page 3 — no duplicates, all 5 covered.
      const page2 = await webhooks.listEvents(tenant.tenantId, { limit: 2, cursor: page1.nextCursor });
      expect(page2.events).toHaveLength(2);
      const page3 = await webhooks.listEvents(tenant.tenantId, { limit: 2, cursor: page2.nextCursor });
      expect(page3.events).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
      const allIds = [...page1.events, ...page2.events, ...page3.events].map((event) => event.id);
      expect(new Set(allIds).size).toBe(5);

      // Filter by event type.
      const ordersOnly = await webhooks.listEvents(tenant.tenantId, {
        eventType: 'order.completed',
      });
      expect(ordersOnly.events).toHaveLength(3);
      expect(ordersOnly.events.every((event) => event.event_type === 'order.completed')).toBe(true);

      // Filter by created_after: everything is after 2026-01-01,
      // nothing is after 2999.
      const all = await webhooks.listEvents(tenant.tenantId, {
        createdAfter: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(all.events).toHaveLength(5);
      const none = await webhooks.listEvents(tenant.tenantId, {
        createdAfter: new Date('2999-01-01T00:00:00.000Z'),
      });
      expect(none.events).toHaveLength(0);

      // Filter by delivery_status.
      const delivered = await webhooks.listEvents(tenant.tenantId, { deliveryStatus: 'delivered' });
      expect(delivered.events).toHaveLength(5);
      const dead = await webhooks.listEvents(tenant.tenantId, { deliveryStatus: 'dead_letter' });
      expect(dead.events).toHaveLength(0);

      // An invalid cursor is a 400, not a 500.
      await expect(webhooks.listEvents(tenant.tenantId, { cursor: 'not-a-cursor' })).rejects.toThrow(
        'Invalid events cursor',
      );
    });
  });
});
