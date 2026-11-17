/**
 * Build-06 Objective 1 tests — persistent AES-256-GCM webhook secret
 * rotation.
 *
 * Build-05 stored only previous_secret_hash / previous_secret_expires_at
 * and kept the retiring RAW secret in the WebhookService process-memory
 * map, so dual-signing (X-Webhook-Signature-Previous) died on restart.
 * Build-06 persists the retiring secret encrypted
 * (previous_secret_ciphertext, migration 015, AES-256-GCM under
 * WEBHOOK_ENCRYPTION_KEY) so a fresh service instance recovers it from
 * the database.
 *
 * What this file proves:
 *  - a reinstantiated WebhookService (empty in-memory maps, simulating
 *    a restart) still emits BOTH signatures mid-grace-window, and
 *    stops emitting X-Webhook-Signature-Previous once the window
 *    expires;
 *  - the stored ciphertext is an envelope that decrypts to the old
 *    secret and never contains it in plaintext;
 *  - a tampered ciphertext degrades to new-only signing without
 *    breaking the delivery;
 *  - rotation without a configured master key fails loudly before
 *    any row changes (and the endpoint keeps working on its old
 *    secret);
 *  - rotation while the previous secret was never held in memory
 *    still works (Build-07: the old current_secret_ciphertext is
 *    COPIED into the previous slot, so the retiring secret stays
 *    recoverable — a NULL previous ciphertext now only happens for
 *    legacy pre-Build-07 rows).
 *
 * Services are constructed directly with the real service (no Nest
 * app, no HTTP), following the routes/* test pattern. Delivery uses
 * an injected fake — no real HTTP anywhere. The master key is passed
 * explicitly in options so tests are deterministic and do not depend
 * on the NODE_ENV=test fallback (one test pins the fallback itself).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { type DB, type SeededTenant } from '@uk-pos/db';
import {
  WebhookSecretCipher,
  WEBHOOK_SECRET_CIPHER_TEST_KEY,
} from '../../src/modules/integrations/webhook-secret-cipher';
import {
  WebhookService,
  type DeliverRequest,
  type WebhookServiceOptions,
} from '../../src/modules/integrations/webhook.service';
import { WebhooksController } from '../../src/modules/integrations/webhooks.controller';
import { actorFor, reqFor, withDb } from './helpers';
import type { Actor } from '../../src/common/actor';

/** Deterministic master key for these tests (explicit option, not the env fallback). */
const TEST_MASTER_KEY = 'build-06-test-master-key-for-webhook-rotation';

function makeService(
  db: Kysely<DB>,
  requests: DeliverRequest[],
  getNow: () => Date,
  extra: WebhookServiceOptions = {},
) {
  return new WebhookService(db, undefined, {
    deliver: async (request) => {
      requests.push(request);
      return 200;
    },
    clock: getNow,
    encryptionKey: TEST_MASTER_KEY,
    ...extra,
  });
}

async function registerAndRotate(
  db: Kysely<DB>,
  tenant: SeededTenant,
  getNow: () => Date,
): Promise<{
  service: WebhookService;
  controller: WebhooksController;
  endpointId: string;
  oldSecret: string;
  newSecret: string;
  requests: DeliverRequest[];
}> {
  const requests: DeliverRequest[] = [];
  const service = makeService(db, requests, getNow);
  const controller = new WebhooksController(service);
  const actor: Actor = actorFor(tenant, 'admin');
  const { endpoint, secret: oldSecret } = await service.registerEndpoint(
    tenant.tenantId,
    'https://example.com/hooks',
    ['order.completed'],
  );
  const rotated = await controller.rotateSecret(reqFor(actor), endpoint.id, {
    gracePeriodHours: 24,
  });
  return {
    service,
    controller,
    endpointId: endpoint.id,
    oldSecret,
    newSecret: rotated.secret,
    requests,
  };
}

async function publishCompleted(
  service: WebhookService,
  tenant: SeededTenant,
  orderId: string,
): Promise<void> {
  await service.publish('order.completed', {
    tenant_id: tenant.tenantId,
    order_id: orderId,
    total_pence: 1200,
  });
}

function verifyBothSignatures(
  request: DeliverRequest,
  newSecret: string,
  oldSecret: string,
): void {
  const timestamp = Number(request.headers['X-Webhook-Timestamp']);
  expect(request.headers['X-Webhook-Signature']).toBeDefined();
  expect(request.headers['X-Webhook-Signature-Previous']).toBeDefined();
  expect(
    WebhookService.verifySignature(
      newSecret,
      timestamp,
      request.body,
      request.headers['X-Webhook-Signature'] as string,
      timestamp,
    ),
  ).toBe(true);
  expect(
    WebhookService.verifySignature(
      oldSecret,
      timestamp,
      request.body,
      request.headers['X-Webhook-Signature-Previous'] as string,
      timestamp,
    ),
  ).toBe(true);
}

describe('Build-06 — persistent webhook secret rotation', () => {
  it('a reinstantiated service still dual-signs mid-grace-window and stops after expiry', async () => {
    await withDb(async ({ db, tenant }) => {
      let now = new Date('2026-11-14T10:00:00.000Z');
      const getNow = () => now;
      const { service, endpointId, oldSecret, newSecret, requests } =
        await registerAndRotate(db, tenant, getNow);

      // Sanity: the rotating instance dual-signs (in-memory path).
      await publishCompleted(service, tenant, '00000000-0000-0000-0000-000000000001');
      expect(requests).toHaveLength(1);
      verifyBothSignatures(requests[0] as DeliverRequest, newSecret, oldSecret);

      // The stored ciphertext is an envelope, never the plaintext secret.
      const stored = await db
        .selectFrom('webhook_endpoints')
        .select(['previous_secret_hash', 'previous_secret_expires_at', 'previous_secret_ciphertext'])
        .where('id', '=', endpointId)
        .executeTakeFirstOrThrow();
      expect(stored.previous_secret_ciphertext).not.toBeNull();
      expect(stored.previous_secret_ciphertext as string).toMatch(/^v1:k1:[A-Za-z0-9+/=]+$/);
      expect(stored.previous_secret_ciphertext as string).not.toContain(oldSecret);
      expect(stored.previous_secret_hash).toBe(
        createHash('sha256').update(oldSecret).digest('hex'),
      );
      // And it decrypts back to the old secret under the master key.
      expect(
        new WebhookSecretCipher({ secret: TEST_MASTER_KEY }).decrypt(
          stored.previous_secret_ciphertext as string,
        ),
      ).toBe(oldSecret);

      // SIMULATED RESTART: a fresh service instance with empty
      // in-memory maps. The current (new) secret must be
      // re-provisioned — it is stored as a hash only — but the
      // RETIRING secret must come back from the database ciphertext.
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow);
      await fresh.setEndpointSecret(endpointId, newSecret);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000002');
      expect(freshRequests).toHaveLength(1);
      verifyBothSignatures(freshRequests[0] as DeliverRequest, newSecret, oldSecret);

      // After the grace window expires, the same fresh instance signs
      // new-only — no X-Webhook-Signature-Previous.
      now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000003');
      expect(freshRequests).toHaveLength(2);
      const afterExpiry = freshRequests[1] as DeliverRequest;
      expect(afterExpiry.headers['X-Webhook-Signature']).toBeDefined();
      expect(afterExpiry.headers['X-Webhook-Signature-Previous']).toBeUndefined();
    });
  });

  it('a tampered ciphertext degrades to new-only signing without breaking delivery', async () => {
    await withDb(async ({ db, tenant }) => {
      let now = new Date('2026-11-14T10:00:00.000Z');
      const getNow = () => now;
      const { endpointId, oldSecret, newSecret } = await registerAndRotate(db, tenant, getNow);

      // Corrupt one character in the middle of the envelope payload.
      const row = await db
        .selectFrom('webhook_endpoints')
        .select('previous_secret_ciphertext')
        .where('id', '=', endpointId)
        .executeTakeFirstOrThrow();
      const envelope = row.previous_secret_ciphertext as string;
      const parts = envelope.split(':');
      const payload = parts[2] as string;
      const mid = Math.floor(payload.length / 2);
      const flipped = payload[mid] === 'A' ? 'B' : 'A';
      const tampered = `${parts[0]}:${parts[1]}:${payload.slice(0, mid)}${flipped}${payload.slice(mid + 1)}`;
      await db
        .updateTable('webhook_endpoints')
        .set({ previous_secret_ciphertext: tampered })
        .where('id', '=', endpointId)
        .execute();

      // Fresh instance (restart), current secret re-provisioned.
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow);
      await fresh.setEndpointSecret(endpointId, newSecret);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000004');
      expect(freshRequests).toHaveLength(1);
      const request = freshRequests[0] as DeliverRequest;
      // Delivery still went out (fake returns 200) with the new
      // signature only — the bad ciphertext never breaks delivery.
      expect(request.headers['X-Webhook-Signature']).toBeDefined();
      expect(request.headers['X-Webhook-Signature-Previous']).toBeUndefined();
      const timestamp = Number(request.headers['X-Webhook-Timestamp']);
      expect(
        WebhookService.verifySignature(
          newSecret,
          timestamp,
          request.body,
          request.headers['X-Webhook-Signature'] as string,
          timestamp,
        ),
      ).toBe(true);
      // The old secret is still not verifiable against anything sent.
      expect(
        WebhookService.verifySignature(
          oldSecret,
          timestamp,
          request.body,
          request.headers['X-Webhook-Signature'] as string,
          timestamp,
        ),
      ).toBe(false);
    });
  });

  it('registration and rotation without a configured master key fail loudly and change nothing', async () => {
    await withDb(async ({ db, tenant }) => {
      const requests: DeliverRequest[] = [];
      // Build-07: registration itself now fails closed without a
      // master key, so the endpoint is registered by a keyed service
      // first; the UNKEYED service then attempts the rotation.
      // env: {} simulates a deployment with no WEBHOOK_ENCRYPTION_KEY
      // and no test fallback (NODE_ENV is not 'test' in this env).
      let now = new Date('2026-11-14T10:00:00.000Z');
      const keyed = makeService(db, requests, () => now);
      const { endpoint, secret: oldSecret } = await keyed.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );
      const unkeyed = new WebhookService(db, undefined, {
        deliver: async (request) => {
          requests.push(request);
          return 200;
        },
        clock: () => now,
        env: {},
      });
      await expect(
        unkeyed.rotateEndpointSecret(tenant.tenantId, endpoint.id),
      ).rejects.toThrow('WEBHOOK_ENCRYPTION_KEY is not configured');

      // The row is unchanged: still the original hash, no grace window.
      const stored = await db
        .selectFrom('webhook_endpoints')
        .select(['secret_hash', 'previous_secret_hash', 'previous_secret_expires_at', 'previous_secret_ciphertext', 'current_secret_ciphertext', 'encryption_key_id'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(stored.secret_hash).toBe(createHash('sha256').update(oldSecret).digest('hex'));
      expect(stored.previous_secret_hash).toBeNull();
      expect(stored.previous_secret_expires_at).toBeNull();
      expect(stored.previous_secret_ciphertext).toBeNull();
      // The current secret was persisted encrypted at registration
      // (Build-07) and the failed rotation did not touch it.
      expect(stored.current_secret_ciphertext).not.toBeNull();
      expect(stored.current_secret_ciphertext as string).toMatch(/^v1:k1:[A-Za-z0-9+/=]+$/);
      expect(stored.encryption_key_id).toBe('k1');

      // The endpoint still works on its original secret: a fresh
      // KEYED service recovers the current secret from the stored
      // ciphertext (the failed rotation changed nothing).
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, () => now);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000005');
      expect(freshRequests).toHaveLength(1);
      const request = freshRequests[0] as DeliverRequest;
      expect(request.headers['X-Webhook-Signature']).toBeDefined();
      expect(request.headers['X-Webhook-Signature-Previous']).toBeUndefined();
      const timestamp = Number(request.headers['X-Webhook-Timestamp']);
      expect(
        WebhookService.verifySignature(
          oldSecret,
          timestamp,
          request.body,
          request.headers['X-Webhook-Signature'] as string,
          timestamp,
        ),
      ).toBe(true);
    });
  });

  it('rotation while the previous secret was never held still works — the old current ciphertext is copied into the previous slot', async () => {
    await withDb(async ({ db, tenant }) => {
      const requests: DeliverRequest[] = [];
      let now = new Date('2026-11-14T10:00:00.000Z');
      const getNow = () => now;
      const first = makeService(db, requests, getNow);
      const { endpoint, secret: oldSecret } = await first.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );

      // SIMULATED RESTART before any rotation: the fresh instance
      // never held the original secret. Build-07: the old secret was
      // persisted encrypted at registration (current_secret_
      // ciphertext), so rotation COPIES that envelope into the
      // previous slot instead of storing NULL — the retiring secret
      // is recoverable without ever being held in memory. (Only
      // legacy pre-Build-07 rows, whose current secret was never
      // persisted, still get a NULL previous ciphertext.)
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow);
      const rotated = await fresh.rotateEndpointSecret(tenant.tenantId, endpoint.id);
      expect(rotated.secret).not.toBe(oldSecret);
      expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);

      const stored = await db
        .selectFrom('webhook_endpoints')
        .select(['previous_secret_hash', 'previous_secret_expires_at', 'previous_secret_ciphertext', 'current_secret_ciphertext', 'encryption_key_id'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      // Grace columns are still recorded (pre-existing Build-05
      // behaviour), and the previous ciphertext is the copied old
      // current envelope — it decrypts to the old secret.
      expect(stored.previous_secret_hash).toBe(
        createHash('sha256').update(oldSecret).digest('hex'),
      );
      expect(stored.previous_secret_expires_at).not.toBeNull();
      expect(stored.previous_secret_ciphertext).not.toBeNull();
      expect(stored.previous_secret_ciphertext as string).toMatch(/^v1:k1:[A-Za-z0-9+/=]+$/);
      expect(
        new WebhookSecretCipher({ secret: TEST_MASTER_KEY }).decrypt(
          stored.previous_secret_ciphertext as string,
        ),
      ).toBe(oldSecret);
      // And the new current secret is persisted encrypted too.
      expect(stored.current_secret_ciphertext).not.toBeNull();
      expect(
        new WebhookSecretCipher({ secret: TEST_MASTER_KEY }).decrypt(
          stored.current_secret_ciphertext as string,
        ),
      ).toBe(rotated.secret);
      expect(stored.encryption_key_id).toBe('k1');

      // The rotated endpoint dual-signs after a restart even though
      // this process never held the old secret — the copied
      // ciphertext makes the retiring secret recoverable.
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000006');
      expect(freshRequests).toHaveLength(1);
      verifyBothSignatures(freshRequests[0] as DeliverRequest, rotated.secret, oldSecret);
    });
  });

  it('the NODE_ENV=test fallback key lets rotation work with no explicit key', async () => {
    await withDb(async ({ db, tenant }) => {
      // No encryptionKey option and no env override: under vitest
      // (NODE_ENV=test) the deterministic fallback applies.
      const service = new WebhookService(db, undefined, {
        deliver: async () => 200,
        clock: () => new Date('2026-11-14T10:00:00.000Z'),
      });
      const { endpoint, secret: oldSecret } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );
      const rotated = await service.rotateEndpointSecret(tenant.tenantId, endpoint.id);
      expect(rotated.secret).not.toBe(oldSecret);
      const stored = await db
        .selectFrom('webhook_endpoints')
        .select('previous_secret_ciphertext')
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(stored.previous_secret_ciphertext).not.toBeNull();
      // The fallback key itself decrypts it — proving which key was used.
      expect(
        new WebhookSecretCipher({ secret: WEBHOOK_SECRET_CIPHER_TEST_KEY }).decrypt(
          stored.previous_secret_ciphertext as string,
        ),
      ).toBe(oldSecret);
      // Build-07: the NEW current secret is persisted encrypted too.
      const storedCurrent = await db
        .selectFrom('webhook_endpoints')
        .select(['current_secret_ciphertext', 'encryption_key_id'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(storedCurrent.current_secret_ciphertext).not.toBeNull();
      expect(
        new WebhookSecretCipher({ secret: WEBHOOK_SECRET_CIPHER_TEST_KEY }).decrypt(
          storedCurrent.current_secret_ciphertext as string,
        ),
      ).toBe(rotated.secret);
      expect(storedCurrent.encryption_key_id).toBe('k1');
    });
  });

  it('the cipher rejects tampered envelopes and wrong keys', async () => {
    const cipher = new WebhookSecretCipher({ secret: TEST_MASTER_KEY });
    const envelope = cipher.encrypt('retiring-secret-value');
    expect(cipher.decrypt(envelope)).toBe('retiring-secret-value');
    // Fresh IV each time: two encryptions of the same value differ.
    expect(cipher.encrypt('retiring-secret-value')).not.toBe(envelope);
    // Flipped payload byte.
    const parts = envelope.split(':');
    const payload = parts[2] as string;
    const mid = Math.floor(payload.length / 2);
    const flipped = payload[mid] === 'A' ? 'B' : 'A';
    expect(() =>
      cipher.decrypt(`${parts[0]}:${parts[1]}:${payload.slice(0, mid)}${flipped}${payload.slice(mid + 1)}`),
    ).toThrow('failed authentication');
    // Wrong key.
    const other = new WebhookSecretCipher({ secret: 'a-different-master-key' });
    expect(() => other.decrypt(envelope)).toThrow('failed authentication');
    // Not an envelope at all.
    expect(() => cipher.decrypt('plaintext-not-an-envelope')).toThrow(
      'not a recognised encrypted envelope',
    );
    // Empty secret is refused at construction.
    expect(() => new WebhookSecretCipher({ secret: '' })).toThrow('non-empty master key');
  });
});
