/**
 * AES-256-GCM application-layer encryption for local SQLite storage
 * (Build-05, Objective 3).
 *
 * Why application-layer, not SQLCipher: SQLCipher is a native
 * dependency this environment cannot build (see the Build-04 note in
 * sqlite-storage.ts). This cipher encrypts the sensitive payload
 * columns in the drivers before they reach SQLite, using only
 * Node's built-in `node:crypto` — no new dependencies.
 *
 * ALGORITHM
 *  - AES-256-GCM, random 96-bit IV per encryption, 128-bit auth tag.
 *  - Key derivation: scrypt(secret, salt, 32 bytes) with
 *    N=16384, r=8, p=1; salt is `uk-pos/register-app/aes-256-gcm/v1/<keyId>`,
 *    so each key id derives an independent 256-bit key from its secret.
 *  - Envelope (stored in the TEXT column in place of the plaintext):
 *      `v1:<keyId>:<base64(iv || authTag || ciphertext)>`
 *    The key id is plaintext by design — the reader needs it to pick
 *    the key before it can authenticate anything. The version prefix
 *    lets the format evolve without silent mis-decryption.
 *
 * SECRET SOURCE
 *  - The secret is NEVER hardcoded. It must be supplied by the caller
 *    (constructor `secret` / `keys` option) or read from the
 *    environment by `fromEnvironment()`:
 *      `REGISTER_APP_DEVICE_SECRET` (required),
 *      `REGISTER_APP_DEVICE_KEY_ID` (optional, default `k1`).
 *    In production the secret comes from the device keystore
 *    (OS keychain / MDM-managed secret) and is passed in at adapter
 *    construction; the env var is the seam for that handoff. Tests
 *    must supply their own test-only secrets.
 *
 * KEY ROTATION
 *  - A cipher holds a map of key id -> derived key plus one current
 *    key id. `encrypt()` always uses the current key; `decrypt()`
 *    selects the key by the envelope's key id, so rows encrypted
 *    under a retired key still decrypt while that key is retained.
 *  - `rotateTo(newKeyId, newSecret)` returns a NEW cipher that
 *    retains every previously held key and makes the new key current.
 *    The old cipher instance is unchanged.
 *  - To fully retire an old key: (1) rotate to the new key,
 *    (2) re-write every stored row through the adapter (a catalog
 *    upsert / queue re-enqueue / audit re-log re-encrypts under the
 *    current key — reads do NOT re-encrypt in place, so rotation
 *    alone does not rewrite disk), (3) drop the old key from the
 *    retained set by constructing a cipher without it. After step 3,
 *    any surviving old-key row fails to decrypt with
 *    `LOCAL_STORAGE_UNKNOWN_KEY_ID` — that is the signal that a row
 *    was missed by the re-write, not tampering.
 *
 * TAMPER DETECTION
 *  - Any modification to the ciphertext or the auth tag fails GCM
 *    authentication and throws `LocalStorageTamperedError`
 *    (`.code === 'LOCAL_STORAGE_TAMPERED'`). Malformed envelopes
 *    (bad version, bad base64, truncated payload) throw the same
 *    error — fail closed. A stored value that is not an envelope at
 *    all while a cipher is configured (e.g. a legacy plaintext row)
 *    also throws it: an encrypted store must never silently accept
 *    plaintext. An envelope whose key id is not held throws the
 *    distinct `LocalStorageUnknownKeyError`
 *    (`.code === 'LOCAL_STORAGE_UNKNOWN_KEY_ID'`).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const LOCAL_STORAGE_TAMPERED = 'LOCAL_STORAGE_TAMPERED';
export const LOCAL_STORAGE_UNKNOWN_KEY_ID = 'LOCAL_STORAGE_UNKNOWN_KEY_ID';

const ENVELOPE_VERSION = 'v1';
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SALT_PREFIX = 'uk-pos/register-app/aes-256-gcm/v1/';
const IV_BYTES = 12; // 96-bit IV
const TAG_BYTES = 16; // 128-bit auth tag
const KEY_BYTES = 32; // 256-bit key

export class LocalStorageTamperedError extends Error {
  readonly code = LOCAL_STORAGE_TAMPERED;
  constructor(message = 'Local storage failed authentication — stored data was modified') {
    super(message);
    this.name = 'LocalStorageTamperedError';
  }
}

export class LocalStorageUnknownKeyError extends Error {
  readonly code = LOCAL_STORAGE_UNKNOWN_KEY_ID;
  constructor(keyId: string) {
    super(`Local storage key id is not held by this cipher: ${keyId}`);
    this.name = 'LocalStorageUnknownKeyError';
  }
}

export interface Aes256GcmSqliteCipherOptions {
  /**
   * Device-keystore secret for the (single) current key. Mutually
   * exclusive with `keys` — pass one or the other.
   */
  secret?: string | Buffer;
  /** Key id for `secret`. Defaults to 'k1'. */
  keyId?: string;
  /**
   * Retained keys: key id -> secret. Use for rotation — include the
   * outgoing key(s) so older rows still decrypt.
   */
  keys?: Readonly<Record<string, string | Buffer>>;
  /**
   * Which entry of `keys` is current for encryption. Defaults to the
   * sole entry when `keys` has exactly one; required when it has
   * more than one.
   */
  currentKeyId?: string;
}

function toSecretBytes(secret: string | Buffer): Buffer {
  return typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(
      `Invalid cipher key id ${JSON.stringify(keyId)} — use letters, digits, '-' or '_'`,
    );
  }
}

function deriveKey(secret: string | Buffer, keyId: string): Buffer {
  return scryptSync(toSecretBytes(secret), `${SALT_PREFIX}${keyId}`, KEY_BYTES, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export class Aes256GcmSqliteCipher {
  private readonly keys = new Map<string, Buffer>();
  private currentKeyIdValue: string;

  constructor(options: Aes256GcmSqliteCipherOptions) {
    if (options.secret !== undefined && options.keys !== undefined) {
      throw new Error('Pass either `secret` or `keys`, not both');
    }
    if (options.secret !== undefined) {
      const keyId = options.keyId ?? 'k1';
      assertKeyId(keyId);
      if (toSecretBytes(options.secret).length === 0) {
        throw new Error('Aes256GcmSqliteCipher requires a non-empty device secret');
      }
      this.keys.set(keyId, deriveKey(options.secret, keyId));
      this.currentKeyIdValue = keyId;
      return;
    }
    if (options.keys !== undefined) {
      const entries = Object.entries(options.keys);
      if (entries.length === 0) {
        throw new Error('Aes256GcmSqliteCipher requires at least one key');
      }
      for (const [keyId, secret] of entries) {
        assertKeyId(keyId);
        if (toSecretBytes(secret).length === 0) {
          throw new Error(`Aes256GcmSqliteCipher key ${JSON.stringify(keyId)} has an empty secret`);
        }
        this.keys.set(keyId, deriveKey(secret, keyId));
      }
      if (options.currentKeyId !== undefined) {
        if (!this.keys.has(options.currentKeyId)) {
          throw new Error(`currentKeyId ${JSON.stringify(options.currentKeyId)} is not in \`keys\``);
        }
        this.currentKeyIdValue = options.currentKeyId;
      } else if (entries.length === 1) {
        this.currentKeyIdValue = entries[0]![0];
      } else {
        throw new Error('currentKeyId is required when `keys` holds more than one key');
      }
      return;
    }
    throw new Error(
      'Aes256GcmSqliteCipher requires a device secret — pass `secret`/`keys`, or use fromEnvironment(). Never hardcode a production secret.',
    );
  }

  /**
   * Build a cipher from the environment. Reads
   * `REGISTER_APP_DEVICE_SECRET` (required) and
   * `REGISTER_APP_DEVICE_KEY_ID` (optional, default 'k1').
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): Aes256GcmSqliteCipher {
    const secret = env.REGISTER_APP_DEVICE_SECRET;
    if (secret === undefined || secret.length === 0) {
      throw new Error(
        'REGISTER_APP_DEVICE_SECRET is not set — the device-keystore secret must be supplied before encrypted local storage can be used',
      );
    }
    return new Aes256GcmSqliteCipher({
      secret,
      keyId: env.REGISTER_APP_DEVICE_KEY_ID ?? 'k1',
    });
  }

  /** Key id used for new encryptions. */
  get currentKeyId(): string {
    return this.currentKeyIdValue;
  }

  /** Key ids this cipher can decrypt (current + retained). */
  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  /**
   * Return a new cipher that retains every key held here and makes
   * `newKeyId`/`newSecret` the current encryption key. Rows encrypted
   * under older retained keys still decrypt. The old instance is
   * unchanged.
   */
  rotateTo(newKeyId: string, newSecret: string | Buffer): Aes256GcmSqliteCipher {
    assertKeyId(newKeyId);
    if (this.keys.has(newKeyId)) {
      throw new Error(`Key id ${JSON.stringify(newKeyId)} is already held — rotation needs a fresh key id`);
    }
    // Build the new cipher from the new secret, then copy the
    // retained derived keys across (private access to another
    // instance of this class is allowed here).
    const rotated = new Aes256GcmSqliteCipher({ secret: newSecret, keyId: newKeyId });
    for (const [keyId, key] of this.keys) {
      rotated.keys.set(keyId, key);
    }
    rotated.currentKeyIdValue = newKeyId;
    return rotated;
  }

  /**
   * Master key-ID rotation for stored envelopes (Build-07,
   * Objective 2). Re-encrypts every envelope in `records` from the
   * keys held by THIS cipher to a fresh `newKeyId`/`newSecret`, and
   * returns the rotated cipher (old keys retained, new key current)
   * together with the re-encrypted envelopes in the same order.
   *
   * - The envelope format is unchanged (`v1:<keyId>:<base64...>`),
   *   only the key id and ciphertext change. Old records still
   *   decrypt with the old key until rotated — the rotated cipher
   *   retains it, so a caller can verify round-trip before dropping
   *   the old key.
   * - A tampered record throws `LocalStorageTamperedError` and
   *   aborts the whole batch before anything is returned — no
   *   partial result is ever handed back. An envelope whose key id
   *   is not held throws `LocalStorageUnknownKeyError`.
   * - This method is pure: it touches no storage. The SQLite
   *   adapter's `reEncryptAllRecords` applies it to the three
   *   encrypted tables inside one transaction.
   */
  reEncryptAllRecords(
    records: readonly string[],
    newKeyId: string,
    newSecret: string | Buffer,
  ): { cipher: Aes256GcmSqliteCipher; records: string[] } {
    const rotated = this.rotateTo(newKeyId, newSecret);
    const reEncrypted = records.map((record) => rotated.encrypt(this.decrypt(record)));
    return { cipher: rotated, records: reEncrypted };
  }

  /** Encrypt `plaintext` under the current key. Fresh random IV each call. */
  encrypt(plaintext: string): string {
    const key = this.keys.get(this.currentKeyIdValue);
    if (key === undefined) {
      throw new Error(`Current key ${JSON.stringify(this.currentKeyIdValue)} is not held`);
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_BYTES) {
      throw new Error(`Unexpected GCM auth tag length: ${tag.length}`);
    }
    const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64');
    return `${ENVELOPE_VERSION}:${this.currentKeyIdValue}:${payload}`;
  }

  /**
   * Decrypt an envelope produced by `encrypt()`. Throws
   * `LocalStorageTamperedError` on any authentication failure or
   * malformed envelope, and `LocalStorageUnknownKeyError` when the
   * envelope's key id is not held.
   */
  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
      throw new LocalStorageTamperedError(
        'Stored value is not a recognised encrypted envelope',
      );
    }
    const keyId = parts[1] as string;
    assertKeyIdFormatForDecrypt(keyId);
    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new LocalStorageUnknownKeyError(keyId);
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(parts[2] as string, 'base64');
    } catch {
      throw new LocalStorageTamperedError('Stored envelope has invalid base64 payload');
    }
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new LocalStorageTamperedError('Stored envelope payload is truncated');
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new LocalStorageTamperedError();
    }
  }
}

function assertKeyIdFormatForDecrypt(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new LocalStorageTamperedError('Stored envelope has an invalid key id');
  }
}
