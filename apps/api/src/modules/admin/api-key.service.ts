/**
 * ApiKeyService — hashed, scoped API keys (Build-03 Objective 1;
 * Arch-02 §4.2–§4.3).
 *
 *  - create: 32 random bytes, shown ONCE as `ukp_<64 hex>`; only the
 *    SHA-256 hash is stored (constant-time compare on verify, so a
 *    stolen database cannot be used to present a key and timing cannot
 *    leak a prefix match). key_prefix is the first 8 chars, for
 *    identification only.
 *  - verify: the presented key must hash to a stored key_hash whose
 *    status is 'active', or 'rotating' inside its 24h grace period
 *    (grace_until in the future). Expired keys (expires_at passed) and
 *    revoked keys never verify. last_used_at is updated on success.
 *  - rotate: a new key is issued with the same name/scopes; the old key
 *    moves to 'rotating' with grace_until = now + 24h, after which
 *    verify() rejects it. The old row is NOT deleted, so an audit of
 *    which key did what survives rotation.
 *  - revoke: immediate, no grace. A revoked key never verifies again.
 *
 * Tenant isolation (G-B): every lookup is tenant-scoped; a key id from
 * another tenant is NotFoundException, never 403.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import type { ApiKeysTable, DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { isValidScope, type ApiScope } from '../../common/scopes';

/** Rotation grace period (Arch-02 §4.2): the old key stays valid 24h. */
export const KEY_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export function hashApiKey(presentedKey: string): string {
  return createHash('sha256').update(presentedKey).digest('hex');
}

export function generateApiKey(): string {
  return `ukp_${randomBytes(32).toString('hex')}`;
}

export interface CreateApiKeyInput {
  name?: string | null;
  scopes: ApiScope[];
  expiresAt?: Date | null;
}

export interface CreatedApiKey {
  id: string;
  /** The full key — returned ONCE. It is never stored and never returned again. */
  key: string;
  keyPrefix: string;
  name: string | null;
  scopes: ApiScope[];
  status: 'active';
  expiresAt: Date | null;
}

export interface VerifiedApiKey {
  keyId: string;
  tenantId: string;
  name: string | null;
  scopes: ApiScope[];
  status: 'active' | 'rotating';
}

export type ApiKeyRow = Selectable<ApiKeysTable>;

@Injectable()
export class ApiKeyService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async createKey(tenantId: string, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    if (input.scopes.length === 0) {
      throw new BadRequestException('An API key must carry at least one scope');
    }
    for (const scope of input.scopes) {
      if (!isValidScope(scope)) {
        throw new BadRequestException(`Unknown scope: ${scope}`);
      }
    }
    const key = generateApiKey();
    const row = await this.db
      .insertInto('api_keys')
      .values({
        tenant_id: tenantId,
        key_hash: hashApiKey(key),
        key_prefix: key.slice(0, 8),
        name: input.name ?? null,
        scopes: [...input.scopes],
        status: 'active',
        last_used_at: null,
        expires_at: input.expiresAt ?? null,
        grace_until: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      key,
      keyPrefix: row.key_prefix,
      name: row.name,
      scopes: row.scopes as ApiScope[],
      status: 'active',
      expiresAt: row.expires_at,
    };
  }

  /**
   * Verify a presented key. Returns the key's identity and scopes, or
   * null when the key is unknown, revoked, expired, or past its
   * rotation grace. The hash lookup is by exact key_hash; the
   * timingSafeEqual compare below guards the (unreachable in practice)
   * case of a hash collision row.
   */
  async verifyKey(presentedKey: string): Promise<VerifiedApiKey | null> {
    if (typeof presentedKey !== 'string' || presentedKey === '') {
      return null;
    }
    const presentedHash = hashApiKey(presentedKey);
    const row = await this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('key_hash', '=', presentedHash)
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    const stored = Buffer.from(row.key_hash, 'hex');
    const presented = Buffer.from(presentedHash, 'hex');
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
      return null;
    }
    if (row.status === 'revoked') {
      return null;
    }
    const now = new Date();
    if (row.expires_at !== null && row.expires_at <= now) {
      return null;
    }
    if (row.status === 'rotating') {
      if (row.grace_until === null || row.grace_until <= now) {
        return null;
      }
    }
    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: now })
      .where('id', '=', row.id)
      .execute();
    return {
      keyId: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      scopes: row.scopes as ApiScope[],
      status: row.status,
    };
  }

  async rotateKey(tenantId: string, keyId: string): Promise<CreatedApiKey> {
    const existing = await this.requireKey(tenantId, keyId);
    if (existing.status === 'revoked') {
      throw new BadRequestException('A revoked key cannot be rotated');
    }
    const created = await this.createKey(tenantId, {
      name: existing.name,
      scopes: existing.scopes as ApiScope[],
      expiresAt: existing.expires_at,
    });
    await this.db
      .updateTable('api_keys')
      .set({ status: 'rotating', grace_until: new Date(Date.now() + KEY_ROTATION_GRACE_MS) })
      .where('id', '=', existing.id)
      .execute();
    return created;
  }

  async revokeKey(tenantId: string, keyId: string): Promise<void> {
    await this.requireKey(tenantId, keyId);
    await this.db
      .updateTable('api_keys')
      .set({ status: 'revoked', grace_until: null })
      .where('id', '=', keyId)
      .where('tenant_id', '=', tenantId)
      .execute();
  }

  /** Keys for a tenant, without hashes — the full key is never listed. */
  async listKeys(tenantId: string): Promise<Array<Omit<ApiKeyRow, 'key_hash'>>> {
    const rows = await this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(({ key_hash: _hash, ...rest }) => rest);
  }

  private async requireKey(tenantId: string, keyId: string): Promise<ApiKeyRow> {
    const row = await this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('id', '=', keyId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundException('Resource not found');
    }
    return row;
  }
}
