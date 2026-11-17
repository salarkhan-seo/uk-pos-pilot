import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { AuthGuard, RequireScope } from './auth.guard';
import { isValidScope, type ApiScope } from '../../common/scopes';
import type { Actor } from '../../common/actor';

interface CreateApiKeyBody {
  name?: string | null;
  scopes: string[];
  expiresAt?: string | null;
}

interface GuardedRequest {
  actor?: Actor;
}

/**
 * API key management (Build-03 Objective 1; Arch-02 §4.2–§4.3).
 *
 * Guarded by AuthGuard with the 'admin' scope: only an admin-scoped
 * credential (API key with admin scope, or an owner/admin session) may
 * create, rotate or revoke keys. The full key is returned ONLY in the
 * create/rotate responses — list responses never contain a hash or a key.
 */
@Controller('v1/api-keys')
@UseGuards(AuthGuard)
@RequireScope('admin')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Post()
  async create(@Req() req: GuardedRequest, @Body() body: CreateApiKeyBody) {
    const actor = req.actor;
    if (actor === undefined) {
      throw new BadRequestException('Authenticated actor is required');
    }
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      throw new BadRequestException('scopes must be a non-empty array');
    }
    for (const scope of body.scopes) {
      if (!isValidScope(scope)) {
        throw new BadRequestException(`Unknown scope: ${scope}`);
      }
    }
    let expiresAt: Date | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new BadRequestException('expiresAt must be an ISO date');
      }
    }
    const created = await this.apiKeys.createKey(actor.tenantId, {
      name: body.name ?? null,
      scopes: body.scopes as ApiScope[],
      expiresAt,
    });
    return created;
  }

  @Get()
  async list(@Req() req: GuardedRequest) {
    const actor = req.actor;
    if (actor === undefined) {
      throw new BadRequestException('Authenticated actor is required');
    }
    const keys = await this.apiKeys.listKeys(actor.tenantId);
    return keys.map((key) => ({
      ...key,
      created_at: key.created_at.toISOString(),
      last_used_at: key.last_used_at?.toISOString() ?? null,
      expires_at: key.expires_at?.toISOString() ?? null,
      grace_until: key.grace_until?.toISOString() ?? null,
    }));
  }

  @Post(':id/rotate')
  async rotate(@Req() req: GuardedRequest, @Param('id') keyId: string) {
    const actor = req.actor;
    if (actor === undefined) {
      throw new BadRequestException('Authenticated actor is required');
    }
    return this.apiKeys.rotateKey(actor.tenantId, keyId);
  }

  @Post(':id/revoke')
  async revoke(@Req() req: GuardedRequest, @Param('id') keyId: string) {
    const actor = req.actor;
    if (actor === undefined) {
      throw new BadRequestException('Authenticated actor is required');
    }
    await this.apiKeys.revokeKey(actor.tenantId, keyId);
    return { id: keyId, status: 'revoked' };
  }
}
