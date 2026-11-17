/**
 * Webhooks admin controller (Build-04 Worker 4).
 *
 * Thin HTTP over WebhookService: endpoint list/register and the 30-day
 * dead-letter queue replay/discard. (GET /v1/events already lives in
 * EventsController.) Guarded by AuthGuard with the 'admin' scope;
 * writes are TenantWriteGuarded. The Actor comes from request.actor.
 *
 * Tenant scoping: listEndpoints and registerEndpoint are scoped by the
 * service. replayDeadLetter / discardDeadLetter take only a delivery
 * id in the service, so the controller first loads the delivery and
 * verifies it belongs to the actor's tenant (404 cross-tenant) before
 * delegating. The endpoint list strips secret_hash — the raw secret is
 * shown once, in the register response only, and never stored.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DB } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { AuditService } from '../admin/audit.service';
import { SkipUuidBodyValidation } from '../../common/uuid-validation.interceptor';
import {
  PLATFORM_OPERATOR_KEY_HEADER,
  PLATFORM_OPERATOR_TEST_KEY,
  PlatformOperatorGuard,
} from './platform-operator.guard';
import { WebhookService } from './webhook.service';
import { AuthGuard, RequireScope } from '../admin/auth.guard';
import { TenantWriteGuard } from '../admin/exit.service';
import { assertUuid } from '../../common/uuid';
import { isWebhookEventType, type WebhookEventType } from './webhook-catalog';
import type { Actor } from '../../common/actor';

// Re-exported so existing imports keep working: the operator
// constants and resolver live in platform-operator.guard.ts now
// (Build-11 Objective 3), and the E2E proof imports the test key
// from this controller.
export { PLATFORM_OPERATOR_KEY_HEADER, PLATFORM_OPERATOR_TEST_KEY };

interface GuardedRequest {
  actor?: Actor;
  /** Set by PlatformOperatorGuard on success: the verified operator id. */
  operatorId?: string;
}

function requireActor(req: GuardedRequest): Actor {
  if (req.actor === undefined) {
    throw new BadRequestException('Authenticated actor is required');
  }
  return req.actor;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

interface RegisterEndpointBody {
  url: string;
  eventTypes: string[];
}

interface RotateSecretBody {
  /** Rotation grace window in hours. Default 24 (mirrors API-key rotation). */
  gracePeriodHours?: number;
}

interface ReprovisionSecretBody {
  /** The raw CURRENT secret, restored from the operator's secret store. Never stored, never echoed back. */
  secret: string;
  /** Optional raw RETIRING secret (in-memory fast path; the DB ciphertext is the durable path). */
  previousSecret?: string;
}

interface ReEncryptSecretsBody {
  /** Master key id to retire: stored ciphertexts encrypted under this id are re-encrypted to the active key. */
  fromKeyId: string;
}

/** Default webhook rotation grace (hours), mirroring the 24h API-key grace. */
export const WEBHOOK_ROTATION_GRACE_HOURS_DEFAULT = 24;
/** Longest configurable rotation grace (hours) — a week. */
export const WEBHOOK_ROTATION_GRACE_HOURS_MAX = 168;

/**
 * Platform-operator guard (Build-11 Objective 3): the keyring
 * resolution, the X-Platform-Operator-Id/Key verification and the
 * rejection audit live in PlatformOperatorGuard
 * (platform-operator.guard.ts). This controller keeps only the
 * success audit, recorded after the re-encryption completes.
 */

@Controller('v1/webhooks')
@UseGuards(AuthGuard)
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhookService,
    @Optional() private readonly auditService?: AuditService,
    @Optional() @Inject(DATABASE) private readonly db?: Kysely<DB>,
  ) {}

  @RequireScope('admin')
  @Get('endpoints')
  async listEndpoints(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    const endpoints = await this.webhooks.listEndpoints(actor.tenantId);
    return endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      event_types: endpoint.event_types,
      status: endpoint.status,
      created_at: endpoint.created_at.toISOString(),
    }));
  }

  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('endpoints')
  async registerEndpoint(@Req() req: GuardedRequest, @Body() body: RegisterEndpointBody) {
    const actor = requireActor(req);
    if (typeof body.url !== 'string' || body.url === '') {
      throw new BadRequestException('url is required');
    }
    if (!Array.isArray(body.eventTypes)) {
      throw new BadRequestException('eventTypes must be an array');
    }
    for (const eventType of body.eventTypes) {
      if (!isWebhookEventType(eventType)) {
        throw new BadRequestException(`Unknown webhook event type: ${eventType}`);
      }
    }
    const { endpoint, secret } = await this.webhooks.registerEndpoint(
      actor.tenantId,
      body.url,
      body.eventTypes as WebhookEventType[],
    );
    return {
      endpoint: {
        id: endpoint.id,
        url: endpoint.url,
        event_types: endpoint.event_types,
        status: endpoint.status,
        created_at: endpoint.created_at.toISOString(),
      },
      // Shown ONCE at registration; never stored, never returned again.
      secret,
    };
  }

  /**
   * Rotate an endpoint's secret (Build-05): POST
   * /v1/webhooks/subscriptions/:id/rotate-secret. The path names the
   * resource "subscriptions" as commissioned; the stored resource is
   * the webhook_endpoints row (migration 011). Returns the new secret
   * ONCE, plus the end of the grace window for the retiring secret.
   * While the window is open, deliveries carry both
   * X-Webhook-Signature and X-Webhook-Signature-Previous.
   */
  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('subscriptions/:id/rotate-secret')
  async rotateSecret(
    @Req() req: GuardedRequest,
    @Param('id') endpointId: string,
    @Body() body: RotateSecretBody,
  ) {
    const actor = requireActor(req);
    // Build-05 UUID guard: a malformed id is 400, never a 500
    // uuid-cast error from the database.
    assertUuid(endpointId, 'endpointId');
    const graceHours = body.gracePeriodHours ?? WEBHOOK_ROTATION_GRACE_HOURS_DEFAULT;
    if (
      typeof graceHours !== 'number' ||
      !Number.isFinite(graceHours) ||
      graceHours <= 0 ||
      graceHours > WEBHOOK_ROTATION_GRACE_HOURS_MAX
    ) {
      throw new BadRequestException(
        `gracePeriodHours must be a number between 0 (exclusive) and ${WEBHOOK_ROTATION_GRACE_HOURS_MAX}`,
      );
    }
    const rotated = await this.webhooks.rotateEndpointSecret(
      actor.tenantId,
      endpointId,
      graceHours * 60 * 60 * 1000,
    );
    return {
      endpoint_id: rotated.endpoint.id,
      // Shown ONCE at rotation; never stored, never returned again.
      secret: rotated.secret,
      previous_secret_expires_at: rotated.previousSecretExpiresAt.toISOString(),
      grace_period_hours: graceHours,
    };
  }

  /**
   * Re-provision an endpoint's raw secret after a process restart
   * (Build-06 Objective 4): POST /v1/webhooks/endpoints/:id/secret.
   * The CURRENT secret lives only in process memory, so a restart
   * loses it and deliveries stop entirely (attemptDelivery records
   * 'endpoint secret unavailable in this process (re-provision with
   * setEndpointSecret)' and sends nothing). The operator restores it
   * here from their own secret store — the API never stores the raw
   * secret, and this route never echoes it back. The optional
   * previousSecret restores the in-memory fast path for the retiring
   * secret as well (the DB ciphertext is the durable path; this only
   * avoids a decryption). A malformed id is 400 INVALID_UUID via the
   * global interceptor; a cross-tenant id is 404 (G-B). Deliberately
   * NOT TenantWriteGuarded: re-provisioning writes no business data
   * (it only restores a process-memory secret), and it must stay
   * reachable while the tenant is mid-exit (export_window is
   * read-only) — otherwise the exit events themselves could never be
   * delivered after a restart, which is exactly when they matter.
   */
  @RequireScope('admin')
  @Post('endpoints/:id/secret')
  async reprovisionSecret(
    @Req() req: GuardedRequest,
    @Param('id') endpointId: string,
    @Body() body: ReprovisionSecretBody,
  ) {
    const actor = requireActor(req);
    assertUuid(endpointId, 'endpointId');
    if (typeof body.secret !== 'string' || body.secret === '') {
      throw new BadRequestException('secret is required');
    }
    if (body.previousSecret !== undefined && typeof body.previousSecret !== 'string') {
      throw new BadRequestException('previousSecret must be a string');
    }
    const endpoint = await this.webhooks.getEndpoint(endpointId);
    if (endpoint === undefined || endpoint.tenant_id !== actor.tenantId) {
      throw new NotFoundException('Resource not found');
    }
    await this.webhooks.setEndpointSecret(endpointId, body.secret, body.previousSecret);
    return { id: endpointId, status: 're-provisioned' };
  }

  /**
   * Re-encrypt stored webhook secrets from a retiring master key id
   * to the active master key id (Build-07 Objective 1): POST
   * /v1/webhooks/re-encrypt-secrets.
   *
   * Auth scope: 'admin' (the codebase's existing admin pattern —
   * there is no separate platform/super-admin scope in the pilot)
   * PLUS the platform-operator guard (Build-10 Objective 3, upgraded
   * to a proper guard in Build-11 Objective 3): the
   * X-Platform-Operator-Key header must match a secret in the
   * operator keyring (PLATFORM_OPERATOR_KEYS JSON map, backward
   * compatible with the single PLATFORM_OPERATOR_KEY env var; the
   * X-Platform-Operator-Id header is optional — when sent it must
   * name the key's owner, when omitted the operator id is derived
   * from the key). A single tenant admin therefore cannot trigger
   * platform-wide master-key re-encryption. Missing/wrong header →
   * 403 PLATFORM_OPERATOR_REQUIRED; no key configured outside test
   * mode → 503 PLATFORM_OPERATOR_KEY_NOT_CONFIGURED (fail closed).
   * The guard runs BEFORE body validation, so an unauthorised
   * caller fails fast regardless of the body.
   * This is a PLATFORM operation, not a tenant operation: it walks
   * every tenant's stored ciphertexts, and the actor's tenant is
   * deliberately not used as a filter — document this loudly,
   * because in production this route must be restricted to a
   * platform operator role. Deliberately NOT TenantWriteGuarded:
   * it writes no tenant business data (only re-wraps stored
   * ciphertexts), and it must stay reachable while a tenant is
   * mid-exit (export_window is read-only) — otherwise a key
   * rotation could never complete during an exit.
   *
   * Audit: the verified operator_id is recorded in audit_events
   * for every re-encrypt call — the guard records rejections
   * ('platform_operator.re_encrypt_rejected', chained under the
   * calling admin's tenant) and this handler records successes
   * ('platform_operator.re_encrypt_succeeded', with the counts).
   * Unauthenticated (401) attempts are not audited: AuthGuard
   * rejects them before the operator guard runs, so there is no
   * actor or tenant to chain the event under.
   *
   * Body: { fromKeyId: string }. Response: the re-encryption
   * summary — from/to key ids, endpoints examined/re-encrypted,
   * ciphertexts re-encrypted, endpoints already current, and any
   * unreadable ciphertexts left untouched. A retiring key that is
   * not in the service's keyring, or a tampered candidate
   * ciphertext, fails the whole call BEFORE any row changes.
   *
   * @SkipUuidBodyValidation: `fromKeyId` is a master-key id ('k1'),
   * not a UUID — the global UUID interceptor would otherwise reject
   * every real call with 400 INVALID_UUID before the handler runs.
   * @HttpCode(200): success is 200 (explicit — Nest's POST default
   * would be 201, and this route returns a summary, not a created
   * resource).
   */
  @SkipUuidBodyValidation()
  @RequireScope('admin')
  @UseGuards(PlatformOperatorGuard)
  @HttpCode(200)
  @Post('re-encrypt-secrets')
  async reEncryptSecrets(@Req() req: GuardedRequest, @Body() body: ReEncryptSecretsBody) {
    const actor = requireActor(req);
    // Fail closed if the guard was somehow bypassed (e.g. a test
    // constructing this controller without applying it): no verified
    // operator id, no re-encryption.
    const operatorId = req.operatorId;
    if (operatorId === undefined) {
      throw new ForbiddenException({
        error: {
          code: 'PLATFORM_OPERATOR_REQUIRED',
          message:
            'X-Platform-Operator-Key header is required for platform-wide re-encryption',
        },
      });
    }
    if (typeof body.fromKeyId !== 'string' || body.fromKeyId === '') {
      throw new BadRequestException('fromKeyId is required');
    }
    const result = await this.webhooks.reEncryptSecrets(body.fromKeyId);
    // Success audit, chained under the calling admin's tenant (the
    // only tenant identity a platform-wide call has). A failed audit
    // write propagates here on purpose: a 200 with no audit trail
    // would be a silent integrity gap, and the re-encryption is
    // idempotent, so a retry after a 500 is safe.
    if (this.auditService !== undefined && this.db !== undefined) {
      await this.auditService.record(this.db, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        eventType: 'platform_operator.re_encrypt_succeeded',
        entityType: 'webhook',
        entityId: null,
        payload: {
          operator_id: operatorId,
          verified_operator_id: operatorId,
          from_key_id: result.fromKeyId,
          to_key_id: result.toKeyId,
          endpoints_examined: result.endpointsExamined,
          endpoints_re_encrypted: result.endpointsReEncrypted,
          ciphertexts_re_encrypted: result.ciphertextsReEncrypted,
          endpoints_already_current: result.endpointsAlreadyCurrent,
          unreadable_ciphertexts: result.unreadableCiphertexts,
        },
      });
    }
    return {
      from_key_id: result.fromKeyId,
      to_key_id: result.toKeyId,
      endpoints_examined: result.endpointsExamined,
      endpoints_re_encrypted: result.endpointsReEncrypted,
      ciphertexts_re_encrypted: result.ciphertextsReEncrypted,
      endpoints_already_current: result.endpointsAlreadyCurrent,
      unreadable_ciphertexts: result.unreadableCiphertexts,
    };
  }

  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('deliveries/:id/replay')
  async replayDeadLetter(@Req() req: GuardedRequest, @Param('id') deliveryId: string) {
    const actor = requireActor(req);
    assertUuid(deliveryId, 'deliveryId');
    const delivery = await this.webhooks.getDelivery(deliveryId);
    if (delivery === undefined || delivery.tenant_id !== actor.tenantId) {
      throw new NotFoundException('Resource not found');
    }
    const replayed = await this.webhooks.replayDeadLetter(deliveryId);
    return { id: replayed.id, status: replayed.status };
  }

  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('deliveries/:id/discard')
  async discardDeadLetter(@Req() req: GuardedRequest, @Param('id') deliveryId: string) {
    const actor = requireActor(req);
    assertUuid(deliveryId, 'deliveryId');
    const delivery = await this.webhooks.getDelivery(deliveryId);
    if (delivery === undefined || delivery.tenant_id !== actor.tenantId) {
      throw new NotFoundException('Resource not found');
    }
    const discarded = await this.webhooks.discardDeadLetter(deliveryId);
    return { id: discarded.id, status: discarded.status };
  }
}
