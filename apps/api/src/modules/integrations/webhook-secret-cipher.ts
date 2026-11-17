/**
 * AES-256-GCM encryption for webhook secrets at rest
 * (Build-06 Objective 1; keyring support added Build-07 Objective 1).
 *
 * Why this exists: Build-05 rotation stored only
 * `previous_secret_hash` / `previous_secret_expires_at` and kept the
 * retiring RAW secret in the WebhookService process-memory map, so
 * dual-signing (X-Webhook-Signature-Previous) died on restart. This
 * cipher encrypts secrets into `webhook_endpoints` ciphertext columns
 * (migration 015 for the retiring secret, migration 016 for the
 * current secret) so a fresh WebhookService instance can decrypt
 * them from the database and keep signing for the whole grace
 * window — no re-provisioning, no rotation first.
 *
 * ALGORITHM (same envelope approach as the register-app
 * Aes256GcmSqliteCipher, Build-05 Objective 3 — reimplemented here
 * because apps/api must not depend on apps/register-app):
 *  - AES-256-GCM, random 96-bit IV per encryption, 128-bit auth tag.
 *  - Key derivation: scrypt(secret, salt, 32 bytes) with N=16384,
 *    r=8, p=1; salt is `uk-pos/api/webhook-secret/v1/<keyId>`, so
 *    each key id derives an independent 256-bit (32-byte) key.
 *  - Envelope (stored in the TEXT column in place of the secret):
 *      `v1:<keyId>:<base64(iv || authTag || ciphertext)>`
 *    The key id is plaintext by design — the reader needs it to pick
 *    the key before it can authenticate anything.
 *
 * KEYRING (Build-07): the cipher holds a MAP of key id -> derived
 * key plus one ACTIVE key id. `encrypt()` always uses the active
 * key; `decrypt()` looks the envelope's key id up in the map, so
 * ciphertexts encrypted under a RETIRING key keep decrypting while
 * that key stays in the ring — which is what makes master-key
 * rotation safe: add the new key, make it active, re-encrypt stored
 * ciphertexts to it, then (and only then) drop the old key.
 *
 * KEY SOURCE (resolved by WebhookService, not here):
 *  - `WEBHOOK_ENCRYPTION_KEYS` env var (JSON map) + active key id
 *    from `WEBHOOK_ACTIVE_KEY_ID`, or the `encryptionKeys` /
 *    `activeKeyId` constructor options (tests / explicit wiring).
 *  - `WEBHOOK_ENCRYPTION_KEY` env var (single key, backward
 *    compatibility) or the `encryptionKey` constructor option.
 *  - Deterministic test fallback `WEBHOOK_SECRET_CIPHER_TEST_KEY`:
 *    used ONLY when `NODE_ENV === 'test'` and no key was supplied.
 *    It is a well-known constant by design — it must never protect
 *    real secrets. Outside tests, a missing key means the cipher is
 *    unavailable and registration/rotation fail loudly instead of
 *    silently encrypting under a public key.
 *
 * TAMPER DETECTION
 *  - Any modification to the ciphertext or the auth tag fails GCM
 *    authentication and throws `WebhookSecretTamperedError`
 *    (`.code === 'WEBHOOK_SECRET_TAMPERED'`). Malformed envelopes,
 *    and envelopes whose key id is not in this cipher's ring, throw
 *    the same error — fail closed. Callers that only need a
 *    best-effort decryption (delivery signing) catch it and send the
 *    new signature only (or, for the current secret, treat the
 *    endpoint as unprovisioned).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const WEBHOOK_SECRET_TAMPERED = 'WEBHOOK_SECRET_TAMPERED';

/**
 * Deterministic test-only master key. Well-known by design: it exists
 * so the test suite can exercise encryption without an env var. It
 * must NEVER be used outside tests — WebhookService only applies it
 * when NODE_ENV === 'test'.
 */
export const WEBHOOK_SECRET_CIPHER_TEST_KEY =
  'build-06-test-only-webhook-encryption-key — never use outside tests';

const ENVELOPE_VERSION = 'v1';
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SALT_PREFIX = 'uk-pos/api/webhook-secret/v1/';
const IV_BYTES = 12; // 96-bit IV
const TAG_BYTES = 16; // 128-bit auth tag
const KEY_BYTES = 32; // 256-bit key

export class WebhookSecretTamperedError extends Error {
  readonly code = WEBHOOK_SECRET_TAMPERED;
  constructor(message = 'Stored webhook secret failed authentication — ciphertext was modified') {
    super(message);
    this.name = 'WebhookSecretTamperedError';
  }
}

export interface WebhookSecretCipherOptions {
  /** Master key material (from WEBHOOK_ENCRYPTION_KEY or an explicit option). */
  secret: string | Buffer;
  /** Key id stamped into envelopes. Defaults to 'k1'. */
  keyId?: string;
}

/**
 * Multi-key keyring options (Build-07). `keys` maps key id -> master
 * key material; each material is scrypt-derived (salt includes the
 * key id) into an independent 256-bit key. `activeKeyId` is the key
 * id `encrypt()` stamps into new envelopes.
 */
export interface WebhookSecretKeyringOptions {
  /** Key id -> master key material. Must be non-empty; every value non-empty. */
  keys: Record<string, string | Buffer>;
  /** Key id used for new encryptions. Must be one of the keys. */
  activeKeyId: string;
}

export type WebhookSecretCipherInit = WebhookSecretCipherOptions | WebhookSecretKeyringOptions;

function isKeyringOptions(options: WebhookSecretCipherInit): options is WebhookSecretKeyringOptions {
  return (options as WebhookSecretKeyringOptions).keys !== undefined;
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(
      `Invalid webhook cipher key id ${JSON.stringify(keyId)} — use letters, digits, '-' or '_'`,
    );
  }
}

function toSecretBytes(secret: string | Buffer): Buffer {
  return typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
}

function deriveKey(secret: string | Buffer, keyId: string): Buffer {
  return scryptSync(toSecretBytes(secret), `${SALT_PREFIX}${keyId}`, KEY_BYTES, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export class WebhookSecretCipher {
  /** Derived 256-bit key per key id. */
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyIdValue: string;

  constructor(options: WebhookSecretCipherInit) {
    if (isKeyringOptions(options)) {
      const entries = Object.entries(options.keys);
      if (entries.length === 0) {
        throw new Error('WebhookSecretCipher keyring requires at least one key');
      }
      for (const [keyId, secret] of entries) {
        assertKeyId(keyId);
        if (toSecretBytes(secret).length === 0) {
          throw new Error(
            `WebhookSecretCipher requires a non-empty master key for key id ${JSON.stringify(keyId)}`,
          );
        }
        this.keys.set(keyId, deriveKey(secret, keyId));
      }
      assertKeyId(options.activeKeyId);
      if (!this.keys.has(options.activeKeyId)) {
        throw new Error(
          `WebhookSecretCipher active key id ${JSON.stringify(options.activeKeyId)} is not in the keyring`,
        );
      }
      this.activeKeyIdValue = options.activeKeyId;
      return;
    }
    const keyId = options.keyId ?? 'k1';
    assertKeyId(keyId);
    if (toSecretBytes(options.secret).length === 0) {
      throw new Error('WebhookSecretCipher requires a non-empty master key');
    }
    this.keys.set(keyId, deriveKey(options.secret, keyId));
    this.activeKeyIdValue = keyId;
  }

  /** Key id stamped into new envelopes (the active master key). */
  get currentKeyId(): string {
    return this.activeKeyIdValue;
  }

  /** Key ids this cipher can decrypt (the whole ring, active included). */
  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  /** Whether an envelope stamped with `keyId` can be decrypted by this cipher. */
  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  /** Encrypt `plaintext` under the ACTIVE master key. Fresh random IV each call. */
  encrypt(plaintext: string): string {
    const key = this.keys.get(this.activeKeyIdValue) as Buffer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_BYTES) {
      throw new Error(`Unexpected GCM auth tag length: ${tag.length}`);
    }
    const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64');
    return `${ENVELOPE_VERSION}:${this.activeKeyIdValue}:${payload}`;
  }

  /**
   * Decrypt an envelope produced by `encrypt()`. The key is picked
   * from the ring by the envelope's own key id, so ciphertexts
   * encrypted under a retiring key keep decrypting while that key
   * stays in the ring. Throws `WebhookSecretTamperedError` on any
   * authentication failure, malformed envelope, or an envelope whose
   * key id is not in this cipher's ring (a master-key rotation that
   * drops an old key before re-encrypting must fail closed, not
   * silently accept).
   */
  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
      throw new WebhookSecretTamperedError('Stored value is not a recognised encrypted envelope');
    }
    const keyId = parts[1] as string;
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new WebhookSecretTamperedError('Stored envelope has an unrecognised key id');
    }
    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new WebhookSecretTamperedError(
        `Stored envelope was encrypted under key id ${JSON.stringify(keyId)}, which is not in this cipher's keyring`,
      );
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(parts[2] as string, 'base64');
    } catch {
      throw new WebhookSecretTamperedError('Stored envelope has invalid base64 payload');
    }
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new WebhookSecretTamperedError('Stored envelope payload is truncated');
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new WebhookSecretTamperedError();
    }
  }
}
