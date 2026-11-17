/**
 * SessionService — user session tokens after PIN verification
 * (Build-03 Objective 1; Arch-02 §4.2).
 *
 * A till user logs in with their user id + till PIN (verified against
 * users.pin_hash with the Build-02 scrypt check — the PIN is a second
 * factor / fast till login, never the sole admin credential). On success
 * the service issues a short-lived (2h) stateless HMAC-SHA256 token:
 * base64url(payload).base64url(signature), the payload carrying
 * tenant/user/location/roles, an isTill flag and exp.
 *
 * PILOT-GRADE LIMITS (recorded here, not claimed away):
 *  - The token is STATELESS: there is no server-side session store, so
 *    an issued token cannot be revoked individually before expiry —
 *    revocation is by disabling the user (verifyToken re-checks the
 *    user's status on every verification) or by rotating the server
 *    secret, which invalidates every token at once. Production must use
 *    server-side sessions (or a denylist) with a stronger scheme.
 *  - The server secret comes from UK_POS_SESSION_SECRET; when unset, a
 *    hard-coded development secret is used and MUST be replaced before
 *    any deployment. No real 2FA provider is integrated (Arch-02 §4.2
 *    MFA for admin/owner accounts is out of scope for this build).
 *  - Tokens are verified with a constant-time signature compare.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { verifyPin } from '@uk-pos/shared-kernel';
import { DATABASE } from '../../database/database';
import { assertUuid } from '../../common/uuid';
import type { Actor } from '../../common/actor';
import type { RoleName } from '../../common/roles';

/** Short-lived session: 2 hours. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export const DEV_ONLY_SESSION_SECRET = 'pilot-dev-only-session-secret-change-before-deployment';

export interface LoginInput {
  tenantId: string;
  userId: string;
  pin: string;
  locationId?: string | null;
  /** True for a till session (checkout 429 exemption — Arch-02 §2.4). */
  isTill?: boolean;
  /** Test override for the token lifetime. */
  ttlMs?: number;
}

export interface SessionPayload {
  v: 1;
  tenantId: string;
  userId: string;
  locationId: string;
  roles: RoleName[];
  isTill: boolean;
  iat: number;
  exp: number;
}

function base64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

@Injectable()
export class SessionService {
  private readonly secret: string;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    // Build-03 coordinator fix: without @Optional(), Nest tries to
    // resolve the `secret?: string` parameter as a `String` provider
    // and the app cannot boot (UnknownDependenciesException). The
    // secret falls back to UK_POS_SESSION_SECRET, then the dev-only
    // secret (see the header comment).
    @Optional() secret?: string,
  ) {
    this.secret =
      secret ?? process.env.UK_POS_SESSION_SECRET ?? DEV_ONLY_SESSION_SECRET;
  }

  /** Verify the PIN and issue a session token. Wrong PIN / disabled user = 403. */
  async login(input: LoginInput): Promise<{ token: string; actor: Actor }> {
    // Build-05: malformed ids are a client error (400) before any
    // uuid-column comparison can raise a 500 cast error. Well-formed
    // UUIDs that match nothing still resolve to 404 below.
    assertUuid(input.tenantId, 'tenantId');
    assertUuid(input.userId, 'userId');
    if (input.locationId !== undefined && input.locationId !== null) {
      assertUuid(input.locationId, 'locationId');
    }
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'pin_hash', 'status'])
      .where('id', '=', input.userId)
      .where('tenant_id', '=', input.tenantId)
      .executeTakeFirst();
    if (user === undefined) {
      throw new NotFoundException('Resource not found');
    }
    if (
      user.status !== 'active' ||
      user.pin_hash === null ||
      !verifyPin(input.pin, user.pin_hash)
    ) {
      throw new ForbiddenException('Invalid PIN');
    }

    // Roles at the login location (or the user's first location).
    let locationId = input.locationId ?? null;
    if (locationId === null) {
      const first = await this.db
        .selectFrom('user_locations')
        .select('location_id')
        .where('user_id', '=', user.id)
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
      locationId = first?.location_id ?? null;
    }
    if (locationId === null) {
      throw new ForbiddenException('User has no location');
    }
    const location = await this.db
      .selectFrom('locations')
      .select('id')
      .where('id', '=', locationId)
      .where('tenant_id', '=', input.tenantId)
      .executeTakeFirst();
    if (location === undefined) {
      throw new NotFoundException('Resource not found');
    }

    const roleRows = await this.db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select('roles.name')
      .where('user_roles.user_id', '=', user.id)
      .where('user_roles.location_id', '=', locationId)
      .execute();
    const roles = roleRows.map((row) => row.name as RoleName);
    if (roles.length === 0) {
      throw new ForbiddenException('User has no role at this location');
    }

    const now = Date.now();
    const payload: SessionPayload = {
      v: 1,
      tenantId: input.tenantId,
      userId: user.id,
      locationId,
      roles,
      isTill: input.isTill ?? false,
      iat: now,
      exp: now + (input.ttlMs ?? SESSION_TTL_MS),
    };
    const encoded = base64urlEncode(JSON.stringify(payload));
    const signature = base64urlEncode(
      createHmac('sha256', this.secret).update(encoded).digest(),
    );
    const actor: Actor = {
      tenantId: payload.tenantId,
      userId: payload.userId,
      locationId: payload.locationId,
      roles: payload.roles,
      authKind: 'session',
      isTillSession: payload.isTill,
    };
    return { token: `${encoded}.${signature}`, actor };
  }

  /** Verify a token. Null on any failure (bad signature, expired, disabled user). */
  async verifyToken(token: string): Promise<Actor | null> {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) {
        return null;
      }
      const [encoded, signature] = parts as [string, string];
      const expected = base64urlEncode(
        createHmac('sha256', this.secret).update(encoded).digest(),
      );
      const expectedBuf = Buffer.from(expected, 'utf8');
      const presentedBuf = Buffer.from(signature, 'utf8');
      if (
        expectedBuf.length !== presentedBuf.length ||
        !timingSafeEqual(expectedBuf, presentedBuf)
      ) {
        return null;
      }
      const payload = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as SessionPayload;
      if (
        payload.v !== 1 ||
        typeof payload.tenantId !== 'string' ||
        typeof payload.userId !== 'string' ||
        typeof payload.locationId !== 'string' ||
        !Array.isArray(payload.roles) ||
        typeof payload.exp !== 'number' ||
        payload.exp <= Date.now()
      ) {
        return null;
      }
      // The user must still be active — disabling a user revokes their
      // sessions (the only per-user revocation a stateless token has).
      const user = await this.db
        .selectFrom('users')
        .select(['id', 'status'])
        .where('id', '=', payload.userId)
        .where('tenant_id', '=', payload.tenantId)
        .executeTakeFirst();
      if (user === undefined || user.status !== 'active') {
        return null;
      }
      return {
        tenantId: payload.tenantId,
        userId: payload.userId,
        locationId: payload.locationId,
        roles: payload.roles as RoleName[],
        authKind: 'session',
        isTillSession: payload.isTill === true,
      };
    } catch {
      return null;
    }
  }
}
