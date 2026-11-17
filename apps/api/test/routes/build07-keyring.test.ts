/**
 * Build-07 Objective 1 tests — current webhook secret encryption at
 * rest & master-key rotation (keyring).
 *
 * Build-06 encrypted only the RETIRING secret; the CURRENT signing
 * secret was still memory-only, so a process restart lost it until
 * the operator re-provisioned it. Build-07 persists the current
 * secret encrypted too (current_secret_ciphertext, migration 016)
 * and adds a multi-key keyring (WEBHOOK_ENCRYPTION_KEYS JSON map +
 * WEBHOOK_ACTIVE_KEY_ID, backward compatible with the single
 * WEBHOOK_ENCRYPTION_KEY) plus POST /v1/webhooks/re-encrypt-secrets.
 *
 * What this file proves:
 *  - creating an endpoint, restarting (re-instantiating the service
 *    with empty in-memory state and NO re-provisioning), firing an
 *    event: the HMAC signature validates — the current secret is
 *    recovered from the stored ciphertext;
 *  - master-key rotation: re-encrypting k1 -> k2 moves both stored
 *    ciphertexts, old-key envelopes disappear, and a fresh service
 *    holding ONLY the new key still dual-signs;
 *  - decryption by envelope key id: a service whose ring still
 *    holds the old key keeps verifying without re-encrypting;
 *  - a tampered current ciphertext degrades to "secret unavailable"
 *    (pending, retryable, re-provision error) without breaking the
 *    delivery path;
 *  - registration and rotation without a configured master key fail
 *    closed before any mutation (outside tests);
 *  - the deterministic test fallback key applies ONLY when
 *    NODE_ENV === 'test' — it never protects real secrets;
 *  - re-encryption is atomic: a tampered candidate, an unknown
 *    retiring key id, or a fromKeyId equal to the active key all
 *    fail before any row changes;
 *  - the re-encrypt endpoint works through the controller and is
 *    platform-wide (all tenants), with the documented response
 *    shape.
 *
 * Services are constructed directly with the real service (no Nest
 * app, no HTTP), following the routes/* test pattern. Delivery uses
 * an injected fake — no real HTTP anywhere. Master keys are passed
 * explicitly in options so tests are deterministic.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createTestDb, seedTenant, type DB, type SeededTenant } from '@uk-pos/db';
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

/** Deterministic master keys for these tests (explicit options, not the env fallback). */
const KEY_K1 = 'build-07-test-master-key-k1';
const KEY_K2 = 'build-07-test-master-key-k2';
const KEY_K3 = 'build-07-test-master-key-k3';

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
    encryptionKeys: { k1: KEY_K1 },
    activeKeyId: 'k1',
    ...extra,
  });
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

function verifySignature(
  request: DeliverRequest,
  secret: string,
  header = 'X-Webhook-Signature',
): void {
  const timestamp = Number(request.headers['X-Webhook-Timestamp']);
  expect(request.headers[header]).toBeDefined();
  expect(
    WebhookService.verifySignature(
      secret,
      timestamp,
      request.body,
      request.headers[header] as string,
      timestamp,
    ),
  ).toBe(true);
}

function verifyBothSignatures(request: DeliverRequest, newSecret: string, oldSecret: string): void {
  verifySignature(request, newSecret, 'X-Webhook-Signature');
  verifySignature(request, oldSecret, 'X-Webhook-Signature-Previous');
}

describe('Build-07 — current secret encryption & master-key keyring', () => {
  it('a fresh service signs from the stored current-secret ciphertext with no re-provisioning', async () => {
    await withDb(async ({ db, tenant }) => {
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const { endpoint, secret } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );

      // The stored row holds the current secret encrypted — never plaintext.
      const stored = await db
        .selectFrom('webhook_endpoints')
        .select(['secret_hash', 'current_secret_ciphertext', 'encryption_key_id'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(stored.secret_hash).toBe(createHash('sha256').update(secret).digest('hex'));
      expect(stored.current_secret_ciphertext).not.toBeNull();
      expect(stored.current_secret_ciphertext as string).toMatch(/^v1:k1:[A-Za-z0-9+/=]+$/);
      expect(stored.current_secret_ciphertext as string).not.toContain(secret);
      expect(stored.encryption_key_id).toBe('k1');
      expect(
        new WebhookSecretCipher({ secret: KEY_K1 }).decrypt(stored.current_secret_ciphertext as string),
      ).toBe(secret);

      // SIMULATED RESTART: a fresh service with empty in-memory maps
      // and NO setEndpointSecret call at all.
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000001');
      expect(freshRequests).toHaveLength(1);
      verifySignature(freshRequests[0] as DeliverRequest, secret);
    });
  });

  it('master-key rotation re-encrypts both ciphertexts and a keyring holding only the new key still dual-signs', async () => {
    await withDb(async ({ db, tenant }) => {
      let now = new Date('2026-11-14T10:00:00.000Z');
      const getNow = () => now;
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const { endpoint, secret: oldSecret } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );
      const rotated = await service.rotateEndpointSecret(tenant.tenantId, endpoint.id);
      const newSecret = rotated.secret;

      // Sanity: the rotating instance dual-signs before any key rotation.
      await publishCompleted(service, tenant, '00000000-0000-0000-0000-000000000002');
      expect(requests).toHaveLength(1);
      verifyBothSignatures(requests[0] as DeliverRequest, newSecret, oldSecret);

      // Master-key rotation: the ring now holds k1 (retiring) and k2,
      // with k2 active. Re-encrypt k1 -> k2.
      const rotatingRequests: DeliverRequest[] = [];
      const rotating = makeService(db, rotatingRequests, getNow, {
        encryptionKeys: { k1: KEY_K1, k2: KEY_K2 },
        activeKeyId: 'k2',
      });
      const result = await rotating.reEncryptSecrets('k1');
      expect(result).toEqual({
        fromKeyId: 'k1',
        toKeyId: 'k2',
        endpointsExamined: 1,
        endpointsReEncrypted: 1,
        ciphertextsReEncrypted: 2,
        endpointsAlreadyCurrent: 0,
        unreadableCiphertexts: [],
      });

      // No k1 envelope survives in either slot; both decrypt under k2.
      const stored = await db
        .selectFrom('webhook_endpoints')
        .select(['current_secret_ciphertext', 'previous_secret_ciphertext', 'encryption_key_id'])
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      for (const value of [stored.current_secret_ciphertext, stored.previous_secret_ciphertext]) {
        expect(value).not.toBeNull();
        expect(value as string).toMatch(/^v1:k2:[A-Za-z0-9+/=]+$/);
        expect(value as string).not.toContain(':k1:');
      }
      expect(stored.encryption_key_id).toBe('k2');
      const k2Cipher = new WebhookSecretCipher({ keys: { k2: KEY_K2 }, activeKeyId: 'k2' });
      expect(k2Cipher.decrypt(stored.current_secret_ciphertext as string)).toBe(newSecret);
      expect(k2Cipher.decrypt(stored.previous_secret_ciphertext as string)).toBe(oldSecret);

      // A second re-encrypt of the same key is a no-op.
      const again = await rotating.reEncryptSecrets('k1');
      expect(again.endpointsReEncrypted).toBe(0);
      expect(again.ciphertextsReEncrypted).toBe(0);
      expect(again.endpointsAlreadyCurrent).toBe(1);

      // SIMULATED RESTART with a service holding ONLY the new key:
      // it still dual-signs — the old key is gone from the ring and
      // from the database.
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow, {
        encryptionKeys: { k2: KEY_K2 },
        activeKeyId: 'k2',
      });
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000003');
      expect(freshRequests).toHaveLength(1);
      verifyBothSignatures(freshRequests[0] as DeliverRequest, newSecret, oldSecret);
    });
  });

  it('a service whose ring still holds the retiring key decrypts old envelopes without re-encrypting', async () => {
    await withDb(async ({ db, tenant }) => {
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const { secret } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );

      // Fresh service with the ring {k1, k2}, k2 active, no
      // re-encryption done: the k1 envelope still decrypts.
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow, {
        encryptionKeys: { k1: KEY_K1, k2: KEY_K2 },
        activeKeyId: 'k2',
      });
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000004');
      expect(freshRequests).toHaveLength(1);
      verifySignature(freshRequests[0] as DeliverRequest, secret);
    });
  });

  it('a tampered current ciphertext degrades to "secret unavailable" without breaking delivery', async () => {
    await withDb(async ({ db, tenant }) => {
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const { endpoint } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );

      // Corrupt one character in the middle of the current envelope.
      const row = await db
        .selectFrom('webhook_endpoints')
        .select('current_secret_ciphertext')
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      const envelope = row.current_secret_ciphertext as string;
      const parts = envelope.split(':');
      const payload = parts[2] as string;
      const mid = Math.floor(payload.length / 2);
      const flipped = payload[mid] === 'A' ? 'B' : 'A';
      await db
        .updateTable('webhook_endpoints')
        .set({
          current_secret_ciphertext: `${parts[0]}:${parts[1]}:${payload.slice(0, mid)}${flipped}${payload.slice(mid + 1)}`,
        })
        .where('id', '=', endpoint.id)
        .execute();

      // Fresh instance (restart): no delivery is attempted, the
      // delivery sits pending with the re-provision error, and
      // publish() itself does not throw.
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow);
      const published = await fresh.publish('order.completed', {
        tenant_id: tenant.tenantId,
        order_id: '00000000-0000-0000-0000-000000000005',
        total_pence: 1200,
      });
      expect(freshRequests).toHaveLength(0);
      expect(published.deliveryIds).toHaveLength(1);
      const delivery = await fresh.getDelivery(published.deliveryIds[0] as string);
      expect(delivery?.status).toBe('pending');
      expect(delivery?.last_error).toContain('re-provision with setEndpointSecret');
    });
  });

  it('registration without a configured master key fails closed before any row is inserted', async () => {
    await withDb(async ({ db, tenant }) => {
      // env with NODE_ENV=production and no keys: no cipher, no
      // test fallback — the production shape.
      const unkeyed = new WebhookService(db, undefined, {
        deliver: async () => 200,
        clock: () => new Date('2026-11-14T10:00:00.000Z'),
        env: { NODE_ENV: 'production' },
      });
      await expect(
        unkeyed.registerEndpoint(tenant.tenantId, 'https://example.com/hooks', ['order.completed']),
      ).rejects.toThrow('WEBHOOK_ENCRYPTION_KEY is not configured');
      const rows = await db
        .selectFrom('webhook_endpoints')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .execute();
      expect(rows).toHaveLength(0);
    });
  });

  it('the test fallback key applies only when NODE_ENV is test', async () => {
    // Production env, no key: no cipher at all.
    expect(
      WebhookService.resolveSecretCipher({ env: { NODE_ENV: 'production' } }),
    ).toBeUndefined();
    // Empty env (no NODE_ENV): no cipher either.
    expect(WebhookService.resolveSecretCipher({ env: {} })).toBeUndefined();
    // Test env: the deterministic fallback applies.
    const testCipher = WebhookService.resolveSecretCipher({ env: { NODE_ENV: 'test' } });
    expect(testCipher).toBeDefined();
    expect(testCipher?.currentKeyId).toBe('k1');
    expect(
      testCipher?.decrypt(
        new WebhookSecretCipher({ secret: WEBHOOK_SECRET_CIPHER_TEST_KEY }).encrypt('probe'),
      ),
    ).toBe('probe');
  });

  it('keyring resolution order: explicit keyring beats env, env JSON beats single key', async () => {
    // Explicit keyring wins over the env single key.
    const explicit = WebhookService.resolveSecretCipher({
      encryptionKeys: { k9: 'explicit-key-material' },
      activeKeyId: 'k9',
      env: { WEBHOOK_ENCRYPTION_KEY: 'env-single-key' },
    });
    expect(explicit?.currentKeyId).toBe('k9');
    expect(explicit?.keyIds).toEqual(['k9']);

    // Env JSON keyring with an explicit active id.
    const fromEnv = WebhookService.resolveSecretCipher({
      env: {
        WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_K1, k2: KEY_K2 }),
        WEBHOOK_ACTIVE_KEY_ID: 'k2',
      },
    });
    expect(fromEnv?.currentKeyId).toBe('k2');
    expect(fromEnv?.keyIds.sort()).toEqual(['k1', 'k2']);
    expect(fromEnv?.encrypt('x')).toMatch(/^v1:k2:/);

    // Single-key JSON map: the one key is active by default.
    const singleMap = WebhookService.resolveSecretCipher({
      env: { WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({ k7: KEY_K3 }) },
    });
    expect(singleMap?.currentKeyId).toBe('k7');

    // Malformed JSON fails loudly at construction.
    expect(() =>
      WebhookService.resolveSecretCipher({
        env: { WEBHOOK_ENCRYPTION_KEYS: '{not json' },
      }),
    ).toThrow('not valid JSON');
    // Active id not in the map fails loudly.
    expect(() =>
      WebhookService.resolveSecretCipher({
        env: {
          WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_K1 }),
          WEBHOOK_ACTIVE_KEY_ID: 'k2',
        },
      }),
    ).toThrow('not in WEBHOOK_ENCRYPTION_KEYS');
    // Several keys and no active id fails loudly.
    expect(() =>
      WebhookService.resolveSecretCipher({
        env: { WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({ k1: KEY_K1, k2: KEY_K2 }) },
      }),
    ).toThrow('no WEBHOOK_ACTIVE_KEY_ID');
    // Empty values are rejected.
    expect(() =>
      WebhookService.resolveSecretCipher({
        env: { WEBHOOK_ENCRYPTION_KEYS: JSON.stringify({ k1: '' }) },
      }),
    ).toThrow('non-empty string');
  });

  it('re-encryption fails closed: unknown retiring key, active key as source, and tampered candidates change nothing', async () => {
    await withDb(async ({ db, tenant }) => {
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const { endpoint: endpointA } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );
      const { endpoint: endpointB } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks-b',
        ['order.completed'],
      );
      const rotating = makeService(db, [], getNow, {
        encryptionKeys: { k1: KEY_K1, k2: KEY_K2 },
        activeKeyId: 'k2',
      });

      // Unknown retiring key id (not in the ring).
      await expect(rotating.reEncryptSecrets('k9')).rejects.toThrow('not in this service');
      // Retiring the ACTIVE key itself.
      await expect(rotating.reEncryptSecrets('k2')).rejects.toThrow('already the active master key');
      // Malformed key id.
      await expect(rotating.reEncryptSecrets('not a key!')).rejects.toThrow('not a valid key id');

      // Tamper endpoint B's current ciphertext, then attempt the
      // rotation: it must throw BEFORE any row changes, so endpoint
      // A's ciphertexts stay under k1.
      const rowB = await db
        .selectFrom('webhook_endpoints')
        .select('current_secret_ciphertext')
        .where('id', '=', endpointB.id)
        .executeTakeFirstOrThrow();
      const envelopeB = rowB.current_secret_ciphertext as string;
      const partsB = envelopeB.split(':');
      const payloadB = partsB[2] as string;
      const midB = Math.floor(payloadB.length / 2);
      const flippedB = payloadB[midB] === 'A' ? 'B' : 'A';
      await db
        .updateTable('webhook_endpoints')
        .set({
          current_secret_ciphertext: `${partsB[0]}:${partsB[1]}:${payloadB.slice(0, midB)}${flippedB}${payloadB.slice(midB + 1)}`,
        })
        .where('id', '=', endpointB.id)
        .execute();
      await expect(rotating.reEncryptSecrets('k1')).rejects.toThrow('failed authentication');
      const rowA = await db
        .selectFrom('webhook_endpoints')
        .select(['current_secret_ciphertext', 'encryption_key_id'])
        .where('id', '=', endpointA.id)
        .executeTakeFirstOrThrow();
      expect(rowA.current_secret_ciphertext as string).toMatch(/^v1:k1:/);
      expect(rowA.encryption_key_id).toBe('k1');
    });
  });

  it('re-encrypt through the controller is platform-wide and returns the documented shape', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const controller = new WebhooksController(service);
      const actor: Actor = actorFor(tenantA, 'admin');

      await service.registerEndpoint(tenantA.tenantId, 'https://example.com/hooks-a', [
        'order.completed',
      ]);
      await service.registerEndpoint(tenantB.tenantId, 'https://example.com/hooks-b', [
        'order.completed',
      ]);

      const rotating = makeService(db, [], getNow, {
        encryptionKeys: { k1: KEY_K1, k2: KEY_K2 },
        activeKeyId: 'k2',
      });
      const rotatingController = new WebhooksController(rotating);
      // Build-11 Objective 3: the platform-operator check is a guard
      // now (PlatformOperatorGuard) — these controller calls simulate
      // a passed guard by carrying the verified operatorId on the
      // request, the same way the guard sets it in production.
      const response = await rotatingController.reEncryptSecrets(
        { ...reqFor(actor), operatorId: 'test' },
        {
          fromKeyId: 'k1',
        },
      );
      expect(response).toEqual({
        from_key_id: 'k1',
        to_key_id: 'k2',
        endpoints_examined: 2,
        endpoints_re_encrypted: 2,
        ciphertexts_re_encrypted: 2,
        endpoints_already_current: 0,
        unreadable_ciphertexts: [],
      });

      // BOTH tenants' endpoints moved — the actor's tenant is not a
      // filter on this platform operation.
      const rows = await db
        .selectFrom('webhook_endpoints')
        .select(['tenant_id', 'current_secret_ciphertext', 'encryption_key_id'])
        .orderBy('tenant_id', 'asc')
        .execute();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.current_secret_ciphertext as string).toMatch(/^v1:k2:/);
        expect(row.encryption_key_id).toBe('k2');
      }

      // Validation: an empty fromKeyId is 400 (the operatorId is
      // present, so the guard passes and the body check is reached).
      await expect(
        rotatingController.reEncryptSecrets(
          { ...reqFor(actor), operatorId: 'test' },
          { fromKeyId: '' },
        ),
      ).rejects.toThrow('fromKeyId is required');
    } finally {
      await close();
    }
  });

  it('setEndpointSecret persists the current secret so the next restart recovers it too', async () => {
    await withDb(async ({ db, tenant }) => {
      const getNow = () => new Date('2026-11-14T10:00:00.000Z');
      const requests: DeliverRequest[] = [];
      const service = makeService(db, requests, getNow);
      const { endpoint, secret } = await service.registerEndpoint(
        tenant.tenantId,
        'https://example.com/hooks',
        ['order.completed'],
      );

      // Simulate a legacy pre-Build-07 row: wipe the stored current
      // ciphertext. A fresh service now cannot sign.
      await db
        .updateTable('webhook_endpoints')
        .set({ current_secret_ciphertext: null })
        .where('id', '=', endpoint.id)
        .execute();
      const freshRequests: DeliverRequest[] = [];
      const fresh = makeService(db, freshRequests, getNow);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000006');
      expect(freshRequests).toHaveLength(0);

      // Re-provision through the service: the secret is restored in
      // memory AND persisted encrypted, so the NEXT restart recovers
      // it without another re-provision.
      await fresh.setEndpointSecret(endpoint.id, secret);
      await publishCompleted(fresh, tenant, '00000000-0000-0000-0000-000000000007');
      expect(freshRequests).toHaveLength(1);
      verifySignature(freshRequests[0] as DeliverRequest, secret);

      const stored = await db
        .selectFrom('webhook_endpoints')
        .select('current_secret_ciphertext')
        .where('id', '=', endpoint.id)
        .executeTakeFirstOrThrow();
      expect(stored.current_secret_ciphertext).not.toBeNull();
      expect(
        new WebhookSecretCipher({ secret: KEY_K1 }).decrypt(stored.current_secret_ciphertext as string),
      ).toBe(secret);

      const secondRequests: DeliverRequest[] = [];
      const second = makeService(db, secondRequests, getNow);
      await publishCompleted(second, tenant, '00000000-0000-0000-0000-000000000008');
      expect(secondRequests).toHaveLength(1);
      verifySignature(secondRequests[0] as DeliverRequest, secret);
    });
  });

  it('the keyring cipher encrypts under the active key and decrypts under any ring key', async () => {
    const cipher = new WebhookSecretCipher({
      keys: { k1: KEY_K1, k2: KEY_K2 },
      activeKeyId: 'k2',
    });
    expect(cipher.currentKeyId).toBe('k2');
    expect(cipher.keyIds.sort()).toEqual(['k1', 'k2']);
    expect(cipher.hasKey('k1')).toBe(true);
    expect(cipher.hasKey('k9')).toBe(false);

    // New envelopes are stamped with the active key id.
    const envelope = cipher.encrypt('some-secret');
    expect(envelope).toMatch(/^v1:k2:[A-Za-z0-9+/=]+$/);
    expect(cipher.decrypt(envelope)).toBe('some-secret');

    // An envelope stamped k1 decrypts through the ring.
    const oldCipher = new WebhookSecretCipher({ secret: KEY_K1 });
    const oldEnvelope = oldCipher.encrypt('retiring-secret-value');
    expect(oldEnvelope).toMatch(/^v1:k1:/);
    expect(cipher.decrypt(oldEnvelope)).toBe('retiring-secret-value');

    // An envelope stamped with a key id outside the ring fails closed.
    const otherCipher = new WebhookSecretCipher({
      keys: { k3: KEY_K3 },
      activeKeyId: 'k3',
    });
    const otherEnvelope = otherCipher.encrypt('other-secret');
    expect(() => cipher.decrypt(otherEnvelope)).toThrow('not in this cipher');

    // Constructor validation.
    expect(
      () => new WebhookSecretCipher({ keys: {}, activeKeyId: 'k1' }),
    ).toThrow('at least one key');
    expect(
      () => new WebhookSecretCipher({ keys: { k1: KEY_K1 }, activeKeyId: 'k2' }),
    ).toThrow('not in the keyring');
    expect(
      () => new WebhookSecretCipher({ keys: { k1: KEY_K1 }, activeKeyId: 'bad id!' }),
    ).toThrow('Invalid webhook cipher key id');
    expect(
      () => new WebhookSecretCipher({ keys: { k1: '' }, activeKeyId: 'k1' }),
    ).toThrow('non-empty master key');
  });
});
