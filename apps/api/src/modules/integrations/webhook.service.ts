/**
 * WebhookService — outbound webhooks, delivery with retries, the
 * dead-letter queue, and the Events API (Build-03 Objective 4;
 * Arch-02 §3).
 *
 * Rules implemented here (each cites its spec):
 *  - Catalog: Arch-02 §3.2 (22 entries) + Arch-06 §3.4, Arch-09 §2,
 *    Arch-10 §5.3 additions (12) — see webhook-catalog.ts. Payloads
 *    carry references and amounts only; publish() throws on any
 *    forbidden key (PAN, full codes, customer PII).
 *  - Signing (Arch-02 §3.3): HMAC-SHA256 over
 *    `timestamp + "." + raw_body`, header
 *    `X-Webhook-Signature: sha256=<hex>`, `X-Webhook-Timestamp`
 *    (Unix seconds, 5-minute replay window) and `X-Webhook-Event-Id`.
 *    Verification uses a constant-time comparison.
 *  - Delivery (Arch-02 §3.4): 5-second acknowledgement window
 *    (default deliver() aborts fetch after 5s). Retry only on 5xx /
 *    timeout / connection failure, NEVER on 3xx/4xx (terminal
 *    `failed`). Delays 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 16h, 24h —
 *    10 retries; after attempt 11 fails the delivery moves to
 *    `dead_letter` (30-day DLQ, replayable, explicitly discardable,
 *    never auto-deleted) and `webhook.dlq_entered` is audited.
 *  - Secrets (Arch-02 §3.3): one secret per endpoint, generated
 *    server-side, shown once at registration, stored as a SHA-256
 *    hash only. The raw secret is held in memory for signing (see
 *    the note on registerEndpoint); after a process restart the
 *    caller re-provisions it with setEndpointSecret. Secret rotation
 *    (Build-05): rotateEndpointSecret issues a new secret, keeps the
 *    old secret's hash in previous_secret_hash with a 24h grace
 *    window (configurable, mirroring API-key rotation), and while
 *    the window is open deliveries carry BOTH X-Webhook-Signature
 *    (new secret) and X-Webhook-Signature-Previous (retiring secret).
 *    Persistent rotation (Build-06): the retiring RAW secret is
 *    also stored encrypted (previous_secret_ciphertext, AES-256-GCM
 *    under WEBHOOK_ENCRYPTION_KEY, migration 015), so a fresh
 *    service instance decrypts it from the database and dual-signing
 *    survives a restart. The in-memory previous-secret map is only
 *    a fast path now. Without a configured master key, rotation
 *    fails loudly when a previous secret is held (it cannot be
 *    persisted safely), and delivery sends the new signature only.
 *    Current-secret encryption at rest (Build-07): the CURRENT
 *    secret is also stored encrypted (current_secret_ciphertext,
 *    migration 016), so a fresh instance recovers the signing
 *    secret from the database immediately — no re-provisioning, no
 *    rotation first. The master key itself is a KEYRING
 *    (WEBHOOK_ENCRYPTION_KEYS JSON map + WEBHOOK_ACTIVE_KEY_ID,
 *    backward compatible with the single WEBHOOK_ENCRYPTION_KEY);
 *    POST /v1/webhooks/re-encrypt-secrets re-encrypts stored
 *    ciphertexts from a retiring master key id to the active one.
 *    Registration and rotation fail loudly without a configured
 *    master key outside tests — a secret is never memory-only.
 *  - Events API (Arch-02 §3.5): listEvents() is the cursor-paginated
 *    polling/reconciliation path (filters: tenant, event_type,
 *    created_after, delivery_status).
 *
 * Delivery uses an injectable `deliver` function (url + headers +
 * body -> status code). The default implementation uses fetch with a
 * 5-second timeout and is NEVER called in tests — tests inject a fake
 * returning scripted status codes. No real HTTP in tests.
 *
 * This service implements the EventPublisher interface defined by the
 * Objective 2 (payments) worker at
 * `apps/api/src/modules/payments/event-publisher.interface.ts`:
 * `publish(eventType, payload)` returning `Promise<void> | void`.
 * That file exists (it landed while Objective 4 was being built) and
 * is the canonical interface. This implementation returns a
 * Promise<PublishedEvent> — a superset of void (the event id,
 * sequence and delivery ids the caller needs for the Events API) —
 * and validates at runtime that the payload carries `tenant_id` and
 * that the event type is in the catalog. If the coordinator prefers
 * the exact `void` return, the return value can be dropped at the
 * call site; the signature itself already satisfies the interface.
 *
 * This service is usable standalone: it does not depend on any other
 * Objective 2 file.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, WebhookDeliveriesTable, WebhookEndpointsTable, WebhookEventsTable, WebhookTables } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { AuditService } from '../admin/audit.service';
import {
  DELIVERY_TIMEOUT_MS,
  FORBIDDEN_PAYLOAD_KEYS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
  SIGNATURE_REPLAY_WINDOW_SECONDS,
  isWebhookEventType,
  type WebhookEventType,
} from './webhook-catalog';
import {
  WEBHOOK_SECRET_CIPHER_TEST_KEY,
  WebhookSecretCipher,
} from './webhook-secret-cipher';
import type { EventPublisher } from '../payments/event-publisher.interface';

/** What publish() resolves with (a superset of the interface's void — see the header note). */
export interface PublishedEvent {
  eventId: string;
  eventType: WebhookEventType;
  tenantId: string;
  /** Per-tenant monotonic sequence (Arch-02 §3.1 — receivers order by it). */
  sequence: bigint;
  /** Delivery ids created for the tenant's subscribed active endpoints. */
  deliveryIds: string[];
}

export type WebhookDb = Kysely<DB & WebhookTables>;

/** Rotation grace period (Build-05; mirrors the API-key 24h grace, Arch-02 §4.2). */
export const WEBHOOK_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/** Optional Nest injection token for WebhookServiceOptions (deliver/clock). Unprovided → defaults. */
export const WEBHOOK_OPTIONS = 'WEBHOOK_OPTIONS';

export interface DeliverRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Takes url + headers + body, returns the HTTP status code. Throws on timeout / connection failure. */
export type DeliverFn = (request: DeliverRequest) => Promise<number>;

export interface WebhookServiceOptions {
  /** Injectable delivery function. Defaults to fetch with a 5s timeout. Tests MUST inject a fake. */
  deliver?: DeliverFn;
  /** Injectable clock (tests control time for the retry schedule). Defaults to () => new Date(). */
  clock?: () => Date;
  /**
   * Master key for encrypting retiring secrets at rest (Build-06).
   * Overrides the WEBHOOK_ENCRYPTION_KEY env var. When neither is
   * supplied, the deterministic test fallback key applies ONLY when
   * NODE_ENV === 'test'; otherwise the cipher is unavailable and
   * rotation fails loudly instead of silently encrypting under a
   * public key. Build-07: superseded by `encryptionKeys` (the
   * multi-key keyring) when both are given — the keyring wins.
   */
  encryptionKey?: string | Buffer;
  /**
   * Multi-key keyring for encrypting secrets at rest (Build-07):
   * key id -> master key material. When given, `activeKeyId`
   * (or the WEBHOOK_ACTIVE_KEY_ID env var) picks the key id new
   * envelopes are stamped with; every key in the ring can still
   * decrypt. Takes precedence over `encryptionKey` and over the
   * WEBHOOK_ENCRYPTION_KEY env var.
   */
  encryptionKeys?: Record<string, string | Buffer>;
  /**
   * Key id new envelopes are stamped with. Defaults: the single key
   * in a one-key keyring, 'k1' for a single `encryptionKey`, or the
   * WEBHOOK_ACTIVE_KEY_ID env var. With several keys and no
   * explicit active id, construction throws (fail closed — the
   * operator must say which key is active).
   */
  activeKeyId?: string;
  /**
   * Environment to read WEBHOOK_ENCRYPTION_KEY /
   * WEBHOOK_ENCRYPTION_KEYS / WEBHOOK_ACTIVE_KEY_ID / NODE_ENV from.
   * Defaults to process.env. Tests pass a controlled env to simulate
   * a deployment with no key configured.
   */
  env?: NodeJS.ProcessEnv;
}

export interface RegisteredEndpoint {
  endpoint: Selectable<WebhookEndpointsTable>;
  /** The raw secret, shown ONCE at registration. It is never stored. */
  secret: string;
}

export interface RotatedEndpointSecret {
  endpoint: Selectable<WebhookEndpointsTable>;
  /** The raw NEW secret, shown ONCE at rotation. It is never stored. */
  secret: string;
  /** End of the grace window for the retiring secret. */
  previousSecretExpiresAt: Date;
}

/** Result of reEncryptSecrets() — master-key rotation for stored ciphertexts (Build-07). */
export interface ReEncryptSecretsResult {
  /** The retiring master key id ciphertexts were moved FROM. */
  fromKeyId: string;
  /** The active master key id ciphertexts were moved TO. */
  toKeyId: string;
  /** Endpoints that had at least one stored ciphertext. */
  endpointsExamined: number;
  /** Endpoints where at least one ciphertext was re-encrypted. */
  endpointsReEncrypted: number;
  /** Individual ciphertexts (current + previous slots) re-encrypted. */
  ciphertextsReEncrypted: number;
  /** Examined endpoints that needed no work (no ciphertext under fromKeyId). */
  endpointsAlreadyCurrent: number;
  /** Ciphertexts whose envelope key id could not even be read (corrupt values) — left untouched. */
  unreadableCiphertexts: Array<{ endpointId: string; slot: 'current' | 'previous' }>;
}

export interface ListEventsFilters {
  eventType?: string;
  createdAfter?: Date;
  deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  limit?: number;
  /** Opaque cursor from a previous listEvents() response. */
  cursor?: string | null;
}

export interface ListedEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  sequence: bigint;
  payload: Record<string, unknown>;
  created_at: Date;
  deliveries: Array<Selectable<WebhookDeliveriesTable>>;
}

export interface ListEventsResult {
  events: ListedEvent[];
  nextCursor: string | null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertPayloadAllowed(payload: unknown, path = '$'): void {
  if (Array.isArray(payload)) {
    payload.forEach((value, index) => assertPayloadAllowed(value, `${path}[${index}]`));
    return;
  }
  if (payload !== null && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `webhook payload contains forbidden field "${key}" at ${path} — payloads carry references and amounts only (Arch-02 §3.2)`,
        );
      }
      assertPayloadAllowed(value, `${path}.${key}`);
    }
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid events cursor');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string'
  ) {
    throw new BadRequestException('Invalid events cursor');
  }
  const createdAt = new Date((parsed as Record<string, unknown>).createdAt as string);
  if (Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Invalid events cursor');
  }
  return { createdAt, id: (parsed as Record<string, unknown>).id as string };
}

@Injectable()
export class WebhookService implements EventPublisher {
  private readonly db: WebhookDb;
  private readonly deliverFn: DeliverFn;
  private readonly clock: () => Date;
  /** Raw endpoint secrets, held in memory only (never persisted). */
  private readonly endpointSecrets = new Map<string, string>();
  /**
   * Raw RETIRING secrets during their rotation grace window — the
   * in-memory fast path. Since Build-06 the same secret is also
   * persisted encrypted (previous_secret_ciphertext, migration 015),
   * so a fresh instance can recover it from the database; this map
   * only avoids a decryption on the hot path.
   */
  private readonly previousEndpointSecrets = new Map<string, string>();
  /**
   * AES-256-GCM cipher for retiring secrets at rest (Build-06).
   * Undefined when no master key is configured outside tests — see
   * resolveSecretCipher: rotation then fails loudly, delivery sends
   * the new signature only.
   */
  private readonly secretCipher: WebhookSecretCipher | undefined;

  constructor(
    @Inject(DATABASE) db: Kysely<DB>,
    @Optional() private readonly auditService?: AuditService,
    @Optional() @Inject(WEBHOOK_OPTIONS) options: WebhookServiceOptions = {},
  ) {
    // The runtime database really has the webhook tables (migration
    // 011); the cast is contained here so the service stays
    // constructible from the standard DATABASE token (Kysely<DB>).
    this.db = db as unknown as WebhookDb;
    this.deliverFn = options.deliver ?? WebhookService.defaultDeliver;
    this.clock = options.clock ?? (() => new Date());
    this.secretCipher = WebhookService.resolveSecretCipher(options);
  }

  /**
   * Pick the ACTIVE key id out of a keyring (Build-07). Precedence:
   * explicit `activeKeyId` option, then the WEBHOOK_ACTIVE_KEY_ID
   * env var, then the single key in a one-key ring. With several
   * keys and no explicit active id, construction throws — the
   * operator must say which key is active (fail closed, never a
   * silent guess at which key signs new secrets).
   */
  private static resolveActiveKeyId(
    keys: Record<string, string | Buffer>,
    explicitActiveKeyId: string | undefined,
    env: NodeJS.ProcessEnv,
  ): string {
    const candidate = explicitActiveKeyId ?? env.WEBHOOK_ACTIVE_KEY_ID;
    if (candidate !== undefined && candidate.length > 0) {
      if (!(candidate in keys)) {
        throw new Error(
          `WEBHOOK_ACTIVE_KEY_ID ${JSON.stringify(candidate)} is not in WEBHOOK_ENCRYPTION_KEYS — add the key to the keyring or pick an active id that is`,
        );
      }
      return candidate;
    }
    const ids = Object.keys(keys);
    if (ids.length === 1) {
      return ids[0] as string;
    }
    throw new Error(
      'WEBHOOK_ENCRYPTION_KEYS has several keys and no WEBHOOK_ACTIVE_KEY_ID — set WEBHOOK_ACTIVE_KEY_ID to choose the key new secrets are encrypted under',
    );
  }

  /**
   * Resolve the master keyring for secret encryption at rest
   * (Build-06 single key; Build-07 multi-key keyring).
   * Precedence — first match wins:
   *   1. explicit `encryptionKeys` option (keyring) + active key id
   *      from `activeKeyId` / WEBHOOK_ACTIVE_KEY_ID;
   *   2. explicit `encryptionKey` option (single key, key id 'k1'
   *      unless `activeKeyId` says otherwise);
   *   3. WEBHOOK_ENCRYPTION_KEYS env var (JSON map of key id ->
   *      key material) + WEBHOOK_ACTIVE_KEY_ID;
   *   4. WEBHOOK_ENCRYPTION_KEY env var (single key, backward
   *      compatibility);
   *   5. the deterministic test fallback — ONLY when
   *      NODE_ENV === 'test'.
   * Outside tests a missing key yields no cipher (never a
   * well-known key protecting real secrets); registration and
   * rotation then throw instead of silently falling back to
   * in-memory-only secrets. A malformed WEBHOOK_ENCRYPTION_KEYS
   * (bad JSON, not an object, empty values, unknown active id)
   * throws at construction — a bad keyring fails boot loudly.
   */
  static resolveSecretCipher(options: WebhookServiceOptions): WebhookSecretCipher | undefined {
    const env = options.env ?? process.env;
    if (options.encryptionKeys !== undefined) {
      return new WebhookSecretCipher({
        keys: options.encryptionKeys,
        activeKeyId: WebhookService.resolveActiveKeyId(options.encryptionKeys, options.activeKeyId, env),
      });
    }
    if (options.encryptionKey !== undefined && options.encryptionKey.length > 0) {
      return new WebhookSecretCipher({
        secret: options.encryptionKey,
        keyId: options.activeKeyId ?? 'k1',
      });
    }
    const keysJson = env.WEBHOOK_ENCRYPTION_KEYS;
    if (keysJson !== undefined && keysJson.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(keysJson);
      } catch {
        throw new Error('WEBHOOK_ENCRYPTION_KEYS is not valid JSON — it must be a JSON object mapping key_id to key material');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('WEBHOOK_ENCRYPTION_KEYS must be a JSON object mapping key_id to key material');
      }
      const keys = parsed as Record<string, unknown>;
      for (const [keyId, value] of Object.entries(keys)) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(
            `WEBHOOK_ENCRYPTION_KEYS entry ${JSON.stringify(keyId)} must be a non-empty string of key material`,
          );
        }
      }
      return new WebhookSecretCipher({
        keys: keys as Record<string, string>,
        activeKeyId: WebhookService.resolveActiveKeyId(keys as Record<string, string>, options.activeKeyId, env),
      });
    }
    if (env.WEBHOOK_ENCRYPTION_KEY !== undefined && env.WEBHOOK_ENCRYPTION_KEY.length > 0) {
      return new WebhookSecretCipher({
        secret: env.WEBHOOK_ENCRYPTION_KEY,
        keyId: options.activeKeyId ?? 'k1',
      });
    }
    if (env.NODE_ENV === 'test') {
      return new WebhookSecretCipher({ secret: WEBHOOK_SECRET_CIPHER_TEST_KEY });
    }
    return undefined;
  }

  /**
   * Default delivery: fetch with a 5-second abort timeout (Arch-02
   * §3.4 acknowledgement window). Throws on timeout / network failure
   * so the caller treats it as retryable. Never used in tests.
   */
  static async defaultDeliver(request: DeliverRequest): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------
  // Signing (Arch-02 §3.3)
  // ------------------------------------------------------------------

  /** `sha256=<hex hmac-sha256(timestamp + "." + raw_body)>`. */
  static signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
    const hmac = createHmac('sha256', secret)
      .update(`${timestampSeconds}.${rawBody}`, 'utf8')
      .digest('hex');
    return `sha256=${hmac}`;
  }

  /**
   * Verify a received signature. Rejects timestamps outside the
   * 5-minute replay window (in either direction — a future timestamp
   * is as suspicious as a stale one) and compares in constant time.
   * A failed verification is the receiver's problem, never a
   * retryable delivery failure (Arch-02 §3.3).
   */
  static verifySignature(
    secret: string,
    timestampSeconds: number,
    rawBody: string,
    signatureHeader: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): boolean {
    if (!Number.isFinite(timestampSeconds)) {
      return false;
    }
    if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_REPLAY_WINDOW_SECONDS) {
      return false;
    }
    const expected = WebhookService.signPayload(secret, timestampSeconds, rawBody);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const actualBuffer = Buffer.from(signatureHeader, 'utf8');
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, actualBuffer);
  }

  // ------------------------------------------------------------------
  // Endpoints
  // ------------------------------------------------------------------

  /**
   * Register an endpoint. HTTPS only (Arch-02 §3.3 — plain HTTP is
   * rejected). The returned secret is shown ONCE; only its SHA-256
   * hash is stored. The raw secret is kept in memory for signing.
   * Build-07: the raw secret is ALSO stored encrypted
   * (current_secret_ciphertext, migration 016, AES-256-GCM under the
   * active master key), so a fresh service instance recovers it from
   * the database and signs immediately after a restart. Without a
   * configured master key (outside tests) registration fails loudly
   * BEFORE the row is inserted — a signing secret is never
   * memory-only.
   */
  async registerEndpoint(
    tenantId: string,
    url: string,
    eventTypes: WebhookEventType[],
  ): Promise<RegisteredEndpoint> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Webhook endpoint URL is invalid');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Webhook endpoints must use HTTPS');
    }
    if (eventTypes.length === 0) {
      throw new BadRequestException('Webhook endpoint must subscribe to at least one event type');
    }
    for (const eventType of eventTypes) {
      if (!isWebhookEventType(eventType)) {
        throw new BadRequestException(`Unknown webhook event type: ${eventType}`);
      }
    }
    if (this.secretCipher === undefined) {
      throw new Error(
        'WEBHOOK_ENCRYPTION_KEY is not configured — cannot persist the new webhook secret; set WEBHOOK_ENCRYPTION_KEY (or WEBHOOK_ENCRYPTION_KEYS) before registering an endpoint',
      );
    }
    const secret = randomBytes(32).toString('hex');
    const endpoint = await this.db
      .insertInto('webhook_endpoints')
      .values({
        tenant_id: tenantId,
        url,
        secret_hash: sha256Hex(secret),
        event_types: [...eventTypes],
        status: 'active',
        current_secret_ciphertext: this.secretCipher.encrypt(secret),
        encryption_key_id: this.secretCipher.currentKeyId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    this.endpointSecrets.set(endpoint.id, secret);
    return { endpoint, secret };
  }

  /**
   * Re-provision a raw secret after a process restart (signing needs
   * it; it is never stored). Build-07: when a master key is
   * configured the re-provisioned secret is ALSO persisted encrypted
   * (current_secret_ciphertext), so the NEXT restart recovers it
   * from the database and this hatch is only needed once per
   * pre-Build-07 endpoint. Without a configured master key the
   * secret stays memory-only (the operator's own store is the
   * source of truth, and failing this recovery hatch would leave
   * the endpoint undeliverable) — the durable path is
   * registration/rotation, which fail loudly without a key.
   * The optional previousSecret is persisted the same way when a
   * grace window is in effect.
   */
  async setEndpointSecret(endpointId: string, secret: string, previousSecret?: string): Promise<void> {
    const endpoint = await this.db
      .selectFrom('webhook_endpoints')
      .select(['id', 'previous_secret_expires_at'])
      .where('id', '=', endpointId)
      .executeTakeFirst();
    if (endpoint === undefined) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    this.endpointSecrets.set(endpointId, secret);
    if (previousSecret !== undefined) {
      this.previousEndpointSecrets.set(endpointId, previousSecret);
    }
    if (this.secretCipher !== undefined) {
      const patch: { current_secret_ciphertext: string; encryption_key_id: string; previous_secret_ciphertext?: string } = {
        current_secret_ciphertext: this.secretCipher.encrypt(secret),
        encryption_key_id: this.secretCipher.currentKeyId,
      };
      if (previousSecret !== undefined && endpoint.previous_secret_expires_at !== null) {
        patch.previous_secret_ciphertext = this.secretCipher.encrypt(previousSecret);
      }
      await this.db
        .updateTable('webhook_endpoints')
        .set(patch)
        .where('id', '=', endpointId)
        .execute();
    }
  }

  /**
   * Rotate an endpoint's secret (Build-05; mirrors ApiKeyService
   * rotation). A new secret is issued (shown once in the return
   * value, never stored); the old secret's hash moves to
   * previous_secret_hash with previous_secret_expires_at = now +
   * graceMs (default 24h). While the grace window is open,
   * attemptDelivery attaches both X-Webhook-Signature (new secret)
   * and X-Webhook-Signature-Previous (retiring secret). Rotating an
   * endpoint that is already mid-rotation replaces the previous
   * secret: only ONE retiring secret is ever kept (the newest old
   * one), so a second rotation ends the first grace window early.
   * Build-06: the retiring RAW secret is also persisted encrypted
   * (previous_secret_ciphertext, AES-256-GCM under
   * WEBHOOK_ENCRYPTION_KEY) so dual-signing survives a restart; the
   * in-memory map is only a fast path now.
   * Build-07: the NEW current secret is persisted encrypted too
   * (current_secret_ciphertext, migration 016), and the retiring
   * secret is persisted even when this process never held its raw
   * form — the old current_secret_ciphertext is COPIED into the
   * previous slot (same secret, same envelope; no decryption
   * needed), so the "secret lost before rotation" case from
   * Build-06 only survives for legacy pre-Build-07 rows. Without a
   * configured master key rotation throws BEFORE any row changes —
   * the new secret could not be persisted, so rotating into a
   * memory-only state is refused.
   */
  async rotateEndpointSecret(
    tenantId: string,
    endpointId: string,
    graceMs: number = WEBHOOK_ROTATION_GRACE_MS,
    now: Date = this.clock(),
  ): Promise<RotatedEndpointSecret> {
    if (!Number.isFinite(graceMs) || graceMs <= 0) {
      throw new BadRequestException('graceMs must be a positive number of milliseconds');
    }
    const endpoint = await this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', endpointId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (endpoint === undefined) {
      throw new NotFoundException('Resource not found');
    }
    // Build-07: the new CURRENT secret must be persisted encrypted
    // at rotation time. Without a configured master key there is
    // nothing safe to persist under — fail loudly BEFORE any row is
    // changed, instead of silently rotating into the old in-memory-
    // only state.
    if (this.secretCipher === undefined) {
      throw new Error(
        'WEBHOOK_ENCRYPTION_KEY is not configured — cannot persist the new webhook secret; set WEBHOOK_ENCRYPTION_KEY (or WEBHOOK_ENCRYPTION_KEYS) before rotating',
      );
    }
    const previousRaw = this.endpointSecrets.get(endpoint.id);
    // The retiring secret is persisted ENCRYPTED. Prefer a fresh
    // envelope under the active key when the raw secret is held in
    // this process; otherwise COPY the old current_secret_ciphertext
    // (Build-07: the old secret was persisted encrypted at
    // registration, so it survives rotation without ever being held
    // in memory). NULL only for legacy pre-Build-07 rows, whose
    // current secret was never persisted — that secret is
    // unrecoverable.
    const previousSecretCiphertext: string | null =
      previousRaw !== undefined
        ? this.secretCipher.encrypt(previousRaw)
        : endpoint.current_secret_ciphertext;
    const newSecret = randomBytes(32).toString('hex');
    const previousSecretExpiresAt = new Date(now.getTime() + graceMs);
    const updated = await this.db
      .updateTable('webhook_endpoints')
      .set({
        secret_hash: sha256Hex(newSecret),
        previous_secret_hash: endpoint.secret_hash,
        previous_secret_expires_at: previousSecretExpiresAt,
        previous_secret_ciphertext: previousSecretCiphertext,
        current_secret_ciphertext: this.secretCipher.encrypt(newSecret),
        encryption_key_id: this.secretCipher.currentKeyId,
      })
      .where('id', '=', endpoint.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    this.endpointSecrets.set(endpoint.id, newSecret);
    if (previousRaw !== undefined) {
      this.previousEndpointSecrets.set(endpoint.id, previousRaw);
    } else {
      this.previousEndpointSecrets.delete(endpoint.id);
    }
    return { endpoint: updated, secret: newSecret, previousSecretExpiresAt };
  }

  /**
   * Resolve the CURRENT signing secret (Build-07). Fast path first:
   * the in-memory map populated by register/rotate/setEndpointSecret
   * in this process. Otherwise, decrypt `current_secret_ciphertext`
   * from the endpoint row — this is what makes signing survive a
   * restart with no re-provisioning. Returns undefined when there
   * is no secret held, no ciphertext (legacy pre-Build-07 row), no
   * configured master key, or the ciphertext fails authentication
   * (tampered, or encrypted under a key this process no longer
   * holds): the caller then treats the endpoint as unprovisioned
   * and the delivery as retryable — a decryption failure must never
   * break the delivery path with an exception.
   */
  private resolveCurrentSecret(endpoint: Selectable<WebhookEndpointsTable>): string | undefined {
    const inMemory = this.endpointSecrets.get(endpoint.id);
    if (inMemory !== undefined) {
      return inMemory;
    }
    const ciphertext = endpoint.current_secret_ciphertext;
    if (ciphertext === null || this.secretCipher === undefined) {
      return undefined;
    }
    try {
      return this.secretCipher.decrypt(ciphertext);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the retiring secret for dual-signing (Build-06, keyring
   * decryption Build-07). Fast path first: the in-memory map
   * populated by register/rotate in this process. Otherwise, decrypt
   * `previous_secret_ciphertext` from the endpoint row — the
   * envelope's own key id picks the key from the ring, so a retiring
   * master key keeps decrypting while it stays in the ring. Returns
   * undefined when there is no retiring secret, no ciphertext, no
   * configured master key, or the ciphertext fails authentication:
   * a decryption failure must never break the delivery — the caller
   * sends the new signature only. The grace-window expiry is NOT
   * checked here; the caller gates the header on
   * previous_secret_expires_at.
   */
  private resolvePreviousSecret(endpoint: Selectable<WebhookEndpointsTable>): string | undefined {
    const inMemory = this.previousEndpointSecrets.get(endpoint.id);
    if (inMemory !== undefined) {
      return inMemory;
    }
    const ciphertext = endpoint.previous_secret_ciphertext;
    if (ciphertext === null || this.secretCipher === undefined) {
      return undefined;
    }
    try {
      return this.secretCipher.decrypt(ciphertext);
    } catch {
      return undefined;
    }
  }

  /** Load one endpoint (tenant check is the caller's job). */
  async getEndpoint(endpointId: string): Promise<Selectable<WebhookEndpointsTable> | undefined> {
    return this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', endpointId)
      .executeTakeFirst();
  }

  /** A disabled endpoint stops receiving new events; its backlog is preserved in the DLQ (Arch-02 §3.4). */
  async disableEndpoint(endpointId: string): Promise<Selectable<WebhookEndpointsTable>> {
    return this.setEndpointStatus(endpointId, 'disabled');
  }

  async enableEndpoint(endpointId: string): Promise<Selectable<WebhookEndpointsTable>> {
    return this.setEndpointStatus(endpointId, 'active');
  }

  private async setEndpointStatus(
    endpointId: string,
    status: 'active' | 'disabled',
  ): Promise<Selectable<WebhookEndpointsTable>> {
    const updated = await this.db
      .updateTable('webhook_endpoints')
      .set({ status })
      .where('id', '=', endpointId)
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) {
      throw new NotFoundException('Webhook endpoint not found');
    }
    return updated;
  }

  async listEndpoints(tenantId: string): Promise<Array<Selectable<WebhookEndpointsTable>>> {
    return this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * Re-encrypt stored webhook secrets from a retiring master key id
   * to the ACTIVE master key id (Build-07 — master-key rotation).
   * The operator flow is: add the new key to WEBHOOK_ENCRYPTION_KEYS,
   * set WEBHOOK_ACTIVE_KEY_ID to it (new writes already use it),
   * call this to move the STORED ciphertexts over, then (and only
   * then) drop the old key from the ring. Live endpoints never
   * break: deliveries keep signing throughout, because decryption
   * follows each envelope's own key id.
   *
   * Two-phase, fail closed: every candidate ciphertext (envelope
   * key id === fromKeyId) is decrypted FIRST; if any fails
   * (tampered, or the retiring key is not in this service's ring)
   * the method throws BEFORE any row is written, so there is no
   * partial rotation. `fromKeyId` must be in the ring and must
   * differ from the active key id — rotating a key onto itself, or
   * retiring a key this service does not hold, is refused loudly.
   * Ciphertexts already under another key (including the active
   * one) are left alone. A ciphertext whose envelope key id cannot
   * even be read is reported in `unreadableCiphertexts` and left
   * untouched — it was already undecryptable, and blocking the
   * rotation of every other endpoint on it would be worse.
   * `encryption_key_id` is updated to the active id only on rows
   * whose CURRENT ciphertext was re-encrypted (the column records
   * the current slot's key).
   */
  async reEncryptSecrets(fromKeyId: string): Promise<ReEncryptSecretsResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(fromKeyId)) {
      throw new BadRequestException(
        `fromKeyId ${JSON.stringify(fromKeyId)} is not a valid key id — use letters, digits, '-' or '_'`,
      );
    }
    if (this.secretCipher === undefined) {
      throw new Error(
        'WEBHOOK_ENCRYPTION_KEY is not configured — cannot re-encrypt webhook secrets; set WEBHOOK_ENCRYPTION_KEYS (with the retiring and the active key) before rotating a master key',
      );
    }
    const toKeyId = this.secretCipher.currentKeyId;
    if (fromKeyId === toKeyId) {
      throw new BadRequestException(
        `fromKeyId ${JSON.stringify(fromKeyId)} is already the active master key — nothing to re-encrypt`,
      );
    }
    if (!this.secretCipher.hasKey(fromKeyId)) {
      throw new Error(
        `Master key id ${JSON.stringify(fromKeyId)} is not in this service's keyring — add it to WEBHOOK_ENCRYPTION_KEYS before re-encrypting from it`,
      );
    }
    const endpoints = await this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('current_secret_ciphertext', 'is not', null),
          eb('previous_secret_ciphertext', 'is not', null),
        ]),
      )
      .execute();

    const envelopeKeyId = (envelope: string): string | null => {
      const parts = envelope.split(':');
      if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[1] as string)) {
        return null;
      }
      return parts[1] as string;
    };

    // Phase 1 — decrypt every candidate BEFORE writing anything.
    const unreadableCiphertexts: ReEncryptSecretsResult['unreadableCiphertexts'] = [];
    const plan: Array<{
      endpointId: string;
      currentSecret: string | null;
      previousSecret: string | null;
      reEncryptCurrent: boolean;
      reEncryptPrevious: boolean;
    }> = [];
    const failures: string[] = [];
    for (const endpoint of endpoints) {
      let currentSecret: string | null = null;
      let previousSecret: string | null = null;
      let reEncryptCurrent = false;
      let reEncryptPrevious = false;
      for (const slot of ['current', 'previous'] as const) {
        const ciphertext =
          slot === 'current' ? endpoint.current_secret_ciphertext : endpoint.previous_secret_ciphertext;
        if (ciphertext === null) {
          continue;
        }
        const keyId = envelopeKeyId(ciphertext);
        if (keyId === null) {
          unreadableCiphertexts.push({ endpointId: endpoint.id, slot });
          continue;
        }
        if (keyId !== fromKeyId) {
          continue;
        }
        try {
          const plaintext = this.secretCipher.decrypt(ciphertext);
          if (slot === 'current') {
            currentSecret = plaintext;
            reEncryptCurrent = true;
          } else {
            previousSecret = plaintext;
            reEncryptPrevious = true;
          }
        } catch {
          failures.push(`${endpoint.id}:${slot}`);
        }
      }
      plan.push({ endpointId: endpoint.id, currentSecret, previousSecret, reEncryptCurrent, reEncryptPrevious });
    }
    if (failures.length > 0) {
      throw new Error(
        `Cannot re-encrypt from master key ${JSON.stringify(fromKeyId)} — ${failures.length} stored ciphertext(s) failed authentication (${failures.join(', ')}); no rows were changed`,
      );
    }

    // Phase 2 — write the re-encrypted ciphertexts.
    let endpointsReEncrypted = 0;
    let ciphertextsReEncrypted = 0;
    for (const item of plan) {
      if (!item.reEncryptCurrent && !item.reEncryptPrevious) {
        continue;
      }
      const patch: {
        current_secret_ciphertext?: string;
        previous_secret_ciphertext?: string;
        encryption_key_id?: string;
      } = {};
      if (item.reEncryptCurrent && item.currentSecret !== null) {
        patch.current_secret_ciphertext = this.secretCipher.encrypt(item.currentSecret);
        patch.encryption_key_id = toKeyId;
        ciphertextsReEncrypted += 1;
      }
      if (item.reEncryptPrevious && item.previousSecret !== null) {
        patch.previous_secret_ciphertext = this.secretCipher.encrypt(item.previousSecret);
        ciphertextsReEncrypted += 1;
      }
      await this.db
        .updateTable('webhook_endpoints')
        .set(patch)
        .where('id', '=', item.endpointId)
        .execute();
      endpointsReEncrypted += 1;
    }
    return {
      fromKeyId,
      toKeyId,
      endpointsExamined: endpoints.length,
      endpointsReEncrypted,
      ciphertextsReEncrypted,
      endpointsAlreadyCurrent: endpoints.length - endpointsReEncrypted,
      unreadableCiphertexts,
    };
  }

  // ------------------------------------------------------------------
  // Publish (EventPublisher)
  // ------------------------------------------------------------------

  /**
   * Publish an event (EventPublisher interface). The payload MUST
   * carry `tenant_id` (every Arch-02 §3.2 event payload includes it)
   * plus references and amounts only — never PAN, full gift/voucher
   * codes, or customer PII (enforced here). Creates the event row
   * (with the next per-tenant sequence), one pending delivery per
   * subscribed active endpoint, and attempts the initial delivery
   * (attempt 1) for each.
   */
  async publish(eventType: string, payload: Record<string, unknown>): Promise<PublishedEvent> {
    if (!isWebhookEventType(eventType)) {
      throw new BadRequestException(`Unknown webhook event type: ${eventType}`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Webhook payload must be an object');
    }
    const tenantId = payload.tenant_id;
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new BadRequestException('Webhook payload must carry tenant_id');
    }
    assertPayloadAllowed(payload);

    const now = this.clock();
    const { event, deliveryIds } = await this.db.transaction().execute(async (trx) => {
      // Per-tenant advisory lock: two concurrent publishers for the
      // same tenant cannot take the same sequence number.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'webhook-seq:' + tenantId}))`.execute(trx);
      const maxRow = await sql<{ max_seq: bigint | null }>`
        SELECT MAX(sequence) AS max_seq FROM webhook_events WHERE tenant_id = ${tenantId}
      `.execute(trx);
      const sequence = (maxRow.rows[0]?.max_seq ?? 0n) + 1n;

      const inserted = await trx
        .insertInto('webhook_events')
        .values({
          tenant_id: tenantId,
          event_type: eventType,
          payload: payload as Record<string, unknown>,
          sequence,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const endpoints = await trx
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .execute();
      const subscribed = endpoints.filter((endpoint) => endpoint.event_types.includes(eventType));

      const ids: string[] = [];
      for (const endpoint of subscribed) {
        const delivery = await trx
          .insertInto('webhook_deliveries')
          .values({
            tenant_id: tenantId,
            event_id: inserted.id,
            endpoint_id: endpoint.id,
            status: 'pending',
            attempt_count: 0,
            next_attempt_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.push(delivery.id);
      }
      return { event: inserted, deliveryIds: ids };
    });

    // Attempt 1 (the initial delivery) for every new delivery.
    for (const deliveryId of deliveryIds) {
      await this.attemptDelivery(deliveryId, now);
    }

    return {
      eventId: event.id,
      eventType,
      tenantId,
      sequence: event.sequence,
      deliveryIds,
    };
  }

  // ------------------------------------------------------------------
  // Delivery & retries
  // ------------------------------------------------------------------

  async getDelivery(deliveryId: string): Promise<Selectable<WebhookDeliveriesTable> | undefined> {
    return this.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .executeTakeFirst();
  }

  /**
   * Attempt one delivery. Idempotent no-op for terminal states
   * (delivered / failed / dead_letter) and for disabled endpoints.
   * Returns the delivery row after the attempt.
   */
  async attemptDelivery(
    deliveryId: string,
    now: Date = this.clock(),
  ): Promise<Selectable<WebhookDeliveriesTable>> {
    const delivery = await this.getDelivery(deliveryId);
    if (delivery === undefined) {
      throw new NotFoundException('Webhook delivery not found');
    }
    if (delivery.status !== 'pending') {
      return delivery;
    }
    const event = await this.db
      .selectFrom('webhook_events')
      .selectAll()
      .where('id', '=', delivery.event_id)
      .executeTakeFirstOrThrow();
    const endpoint = await this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', delivery.endpoint_id)
      .executeTakeFirstOrThrow();
    if (endpoint.status !== 'active') {
      // Disabled endpoints stop receiving new events; the pending
      // delivery is preserved, not failed (Arch-02 §3.4).
      return delivery;
    }

    const attemptCount = delivery.attempt_count + 1;
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({
      event_id: event.id,
      event_type: event.event_type,
      tenant_id: event.tenant_id,
      sequence: event.sequence.toString(),
      created_at: event.created_at.toISOString(),
      payload: event.payload,
    });

    const secret = this.resolveCurrentSecret(endpoint);
    let statusCode: number | null = null;
    let errorMessage: string | null = null;
    if (secret === undefined) {
      // No secret in memory and none recoverable from the stored
      // ciphertext (legacy pre-Build-07 row, tampered ciphertext, or
      // a master key this process no longer holds). Treat the miss
      // as retryable, never as a silent drop — the operator restores
      // it with setEndpointSecret.
      errorMessage = 'endpoint secret unavailable in this process (re-provision with setEndpointSecret)';
    } else {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': WebhookService.signPayload(secret, timestampSeconds, rawBody),
        'X-Webhook-Timestamp': String(timestampSeconds),
        'X-Webhook-Event-Id': event.id,
      };
      // Build-05 rotation grace: while the retiring secret is inside
      // its grace window, attach the second signature so receivers
      // that have not picked up the new secret yet still verify.
      // After the window only the new signature is sent. Build-06:
      // the retiring secret is recovered from the persisted
      // ciphertext when this process does not hold it in memory, so
      // dual-signing survives a restart.
      const previousSecret = this.resolvePreviousSecret(endpoint);
      if (
        previousSecret !== undefined &&
        endpoint.previous_secret_expires_at !== null &&
        endpoint.previous_secret_expires_at > now
      ) {
        headers['X-Webhook-Signature-Previous'] = WebhookService.signPayload(
          previousSecret,
          timestampSeconds,
          rawBody,
        );
      }
      try {
        statusCode = await this.deliverFn({ url: endpoint.url, headers, body: rawBody });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'delivery failed';
      }
    }

    if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
      return this.updateDelivery(delivery.id, {
        status: 'delivered',
        attempt_count: attemptCount,
        next_attempt_at: null,
        last_status_code: statusCode,
        last_error: null,
      });
    }

    if (statusCode !== null && statusCode >= 300 && statusCode < 500) {
      // 3xx/4xx: terminal — retrying is pointless (Arch-02 §3.4).
      return this.updateDelivery(delivery.id, {
        status: 'failed',
        attempt_count: attemptCount,
        next_attempt_at: null,
        last_status_code: statusCode,
        last_error: `HTTP ${statusCode} (terminal: 3xx/4xx responses are never retried)`,
      });
    }

    // 5xx, timeout, or connection failure: retryable.
    const failureDetail =
      statusCode !== null ? `HTTP ${statusCode}` : (errorMessage ?? 'connection failure');
    if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      const updated = await this.updateDelivery(delivery.id, {
        status: 'dead_letter',
        attempt_count: attemptCount,
        next_attempt_at: null,
        last_status_code: statusCode,
        last_error: `${failureDetail} (attempt ${attemptCount} of ${MAX_DELIVERY_ATTEMPTS} — moved to dead-letter queue)`,
        dlq_entered_at: now,
      });
      await this.recordDlqAudit(delivery, event, 'webhook.dlq_entered', {
        attemptCount,
        failureDetail,
      });
      return updated;
    }
    const delayMs = RETRY_DELAYS_MS[attemptCount - 1] as number;
    return this.updateDelivery(delivery.id, {
      status: 'pending',
      attempt_count: attemptCount,
      next_attempt_at: new Date(now.getTime() + delayMs),
      last_status_code: statusCode,
      last_error: `${failureDetail} (attempt ${attemptCount} of ${MAX_DELIVERY_ATTEMPTS} — next attempt in ${delayMs / 1000}s)`,
    });
  }

  private async updateDelivery(
    deliveryId: string,
    patch: Partial<Selectable<WebhookDeliveriesTable>>,
  ): Promise<Selectable<WebhookDeliveriesTable>> {
    return this.db
      .updateTable('webhook_deliveries')
      .set(patch)
      .where('id', '=', deliveryId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async recordDlqAudit(
    delivery: Selectable<WebhookDeliveriesTable>,
    event: Selectable<WebhookEventsTable>,
    eventType: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (this.auditService === undefined) {
      return;
    }
    await this.auditService.record(this.db as unknown as Kysely<DB>, {
      tenantId: delivery.tenant_id,
      userId: null,
      eventType,
      entityType: 'webhook_delivery',
      entityId: delivery.id,
      payload: {
        eventId: event.id,
        eventTypeName: event.event_type,
        endpointId: delivery.endpoint_id,
        ...extra,
      },
    });
  }

  /** Attempt every pending delivery whose next attempt is due. Returns the attempted delivery ids. */
  async processDueDeliveries(now: Date = this.clock()): Promise<string[]> {
    const due = await this.db
      .selectFrom('webhook_deliveries')
      .select('id')
      .where('status', '=', 'pending')
      .where((eb) =>
        eb.or([eb('next_attempt_at', '<=', now), eb('next_attempt_at', 'is', null)]),
      )
      .orderBy('next_attempt_at', 'asc')
      .orderBy('id', 'asc')
      .limit(100)
      .execute();
    const attempted: string[] = [];
    for (const row of due) {
      await this.attemptDelivery(row.id, now);
      attempted.push(row.id);
    }
    return attempted;
  }

  // ------------------------------------------------------------------
  // Dead-letter queue
  // ------------------------------------------------------------------

  /**
   * Replay a dead-letter delivery: reset it to pending (attempt count
   * cleared, DLQ timestamp cleared) and attempt delivery immediately.
   * A successful replay clears `dead_letter`; a failed replay walks
   * the retry schedule again from attempt 1.
   */
  async replayDeadLetter(
    deliveryId: string,
    now: Date = this.clock(),
  ): Promise<Selectable<WebhookDeliveriesTable>> {
    const delivery = await this.getDelivery(deliveryId);
    if (delivery === undefined) {
      throw new NotFoundException('Webhook delivery not found');
    }
    if (delivery.status !== 'dead_letter') {
      throw new BadRequestException('Only a dead-letter delivery can be replayed');
    }
    const event = await this.db
      .selectFrom('webhook_events')
      .selectAll()
      .where('id', '=', delivery.event_id)
      .executeTakeFirstOrThrow();
    await this.updateDelivery(delivery.id, {
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      last_status_code: null,
      last_error: null,
      dlq_entered_at: null,
    });
    await this.recordDlqAudit(delivery, event, 'webhook.replayed', {});
    return this.attemptDelivery(delivery.id, now);
  }

  /**
   * Explicitly discard a dead-letter delivery. The delivery is
   * marked `failed` with an operator-discard note (it is never
   * auto-deleted or black-holed — Arch-02 §3.4) and audited.
   */
  async discardDeadLetter(deliveryId: string): Promise<Selectable<WebhookDeliveriesTable>> {
    const delivery = await this.getDelivery(deliveryId);
    if (delivery === undefined) {
      throw new NotFoundException('Webhook delivery not found');
    }
    if (delivery.status !== 'dead_letter') {
      throw new BadRequestException('Only a dead-letter delivery can be discarded');
    }
    const event = await this.db
      .selectFrom('webhook_events')
      .selectAll()
      .where('id', '=', delivery.event_id)
      .executeTakeFirstOrThrow();
    const updated = await this.updateDelivery(delivery.id, {
      status: 'failed',
      last_error: 'discarded by operator from the dead-letter queue',
    });
    await this.recordDlqAudit(delivery, event, 'webhook.discarded', {});
    return updated;
  }

  // ------------------------------------------------------------------
  // Events API (Arch-02 §3.5)
  // ------------------------------------------------------------------

  async listEvents(tenantId: string, filters: ListEventsFilters = {}): Promise<ListEventsResult> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    let query = this.db
      .selectFrom('webhook_events')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (filters.eventType !== undefined) {
      query = query.where('event_type', '=', filters.eventType);
    }
    if (filters.createdAfter !== undefined) {
      query = query.where('created_at', '>', filters.createdAfter);
    }
    if (filters.deliveryStatus !== undefined) {
      const status = filters.deliveryStatus;
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('webhook_deliveries')
            .select('id')
            .whereRef('webhook_deliveries.event_id', '=', 'webhook_events.id')
            .where('webhook_deliveries.status', '=', status),
        ),
      );
    }
    if (filters.cursor !== undefined && filters.cursor !== null) {
      const { createdAt, id } = decodeCursor(filters.cursor);
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '<', createdAt),
          eb.and([eb('created_at', '=', createdAt), eb('id', '<', id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id) : null;

    let deliveries: Array<Selectable<WebhookDeliveriesTable>> = [];
    if (page.length > 0) {
      const eventIds = page.map((row) => row.id);
      deliveries = await this.db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('event_id', 'in', eventIds)
        .orderBy('created_at', 'asc')
        .execute();
    }

    return {
      events: page.map((row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        event_type: row.event_type,
        sequence: row.sequence,
        payload: row.payload,
        created_at: row.created_at,
        deliveries: deliveries.filter((delivery) => delivery.event_id === row.id),
      })),
      nextCursor,
    };
  }
}
