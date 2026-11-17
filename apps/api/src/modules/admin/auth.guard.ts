/**
 * AuthGuard — production auth for v1 routes (Build-03 Objective 1;
 * Arch-02 §4.2–§4.4).
 *
 * Accepts EITHER:
 *  - a scoped API key (Authorization: Bearer ukp_... or X-Api-Key), with
 *    the required scope checked server-side on every request, or
 *  - a PIN-issued session token (Authorization: Bearer <token>), whose
 *    roles map to scopes (see common/scopes.ts scopesForRoles).
 *
 * No credentials → 401. A valid credential without the required scope →
 * 403. A credential for another tenant than the one addressed (x-tenant-id
 * header or :tenantId route param) → 404, never 403 (G-B: the resource's
 * existence is not leaked). The authenticated Actor is attached to the
 * request as request.actor for controllers and the rate limiter.
 *
 * The guard does NOT fall back to the Build-02 demo headers — those stay
 * on the Build-02 controllers only, and must be replaced before the
 * pilot goes live.
 *
 * Tier gating: a handler may declare @TierGated('cost-vendor-write')
 * (or any GatedWriteFeature); the guard then runs TierGate before the
 * handler. Reads and exports are never tier-gated (TierGate has no
 * read/export gate to declare).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { SessionService } from './session.service';
import { TierGate, type GatedWriteFeature } from './tier-gate';
import { scopeIncludes, scopesForRoles, type ApiScope } from '../../common/scopes';
import type { Actor } from '../../common/actor';

export const REQUIRE_SCOPE_KEY = 'requiredScope';
export const TIER_GATED_WRITE_KEY = 'tierGatedWrite';

/** Require one scope on the handler (checked after authentication). */
export const RequireScope = (scope: ApiScope) => SetMetadata(REQUIRE_SCOPE_KEY, scope);

/** Require the tenant's tier to allow this gated write (Arch-02 §4.4). */
export const TierGated = (feature: GatedWriteFeature) =>
  SetMetadata(TIER_GATED_WRITE_KEY, feature);

interface GuardRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  actor?: Actor;
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly sessions: SessionService,
    private readonly tierGate: TierGate,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GuardRequest>();
    const actor = await this.authenticate(req);
    if (actor === null) {
      throw new UnauthorizedException('Authentication required');
    }

    // Cross-tenant addressing is 404, never 403 (G-B).
    const addressedTenant =
      firstHeader(req.headers, 'x-tenant-id') ?? req.params?.tenantId;
    if (addressedTenant !== undefined && addressedTenant !== actor.tenantId) {
      throw new NotFoundException('Resource not found');
    }

    const requiredScope = this.reflector.get<ApiScope | undefined>(
      REQUIRE_SCOPE_KEY,
      context.getHandler(),
    );
    if (requiredScope !== undefined) {
      const granted =
        actor.authKind === 'api-key'
          ? (actor.scopes ?? [])
          : scopesForRoles(actor.roles);
      if (!scopeIncludes(granted, requiredScope)) {
        throw new ForbiddenException(
          `This credential does not carry the required scope: ${requiredScope}`,
        );
      }
    }

    const gatedWrite = this.reflector.get<GatedWriteFeature | undefined>(
      TIER_GATED_WRITE_KEY,
      context.getHandler(),
    );
    if (gatedWrite !== undefined) {
      await this.tierGate.assertWriteAllowed(actor.tenantId, gatedWrite);
    }

    req.actor = actor;
    return true;
  }

  private async authenticate(req: GuardRequest): Promise<Actor | null> {
    const bearer = firstHeader(req.headers, 'authorization');
    const presented =
      bearer !== undefined && bearer.toLowerCase().startsWith('bearer ')
        ? bearer.slice(7).trim()
        : (firstHeader(req.headers, 'x-api-key') ?? '');
    if (presented === '') {
      return null;
    }
    if (presented.startsWith('ukp_')) {
      const verified = await this.apiKeys.verifyKey(presented);
      if (verified === null) {
        return null;
      }
      return {
        tenantId: verified.tenantId,
        userId: `api-key:${verified.keyId}`,
        locationId: firstHeader(req.headers, 'x-location-id') ?? '',
        roles: [],
        authKind: 'api-key',
        scopes: verified.scopes,
        apiKeyId: verified.keyId,
      };
    }
    return this.sessions.verifyToken(presented);
  }
}
