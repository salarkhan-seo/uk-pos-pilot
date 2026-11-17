/**
 * Compliance controller (Build-05, Objective 2).
 *
 * GET /v1/compliance/statutory-archives/:tenantId — list the
 * persisted 6-year statutory VAT archives for a tenant, each with
 * its SHA-256 verification status (database payload AND on-disk
 * bundle re-hashed against the stored checksum). Guarded by
 * AuthGuard with the 'admin' scope; the :tenantId must be the
 * caller's own tenant (anything else is 404, never 403 — G-B).
 * A malformed tenant id is 400, never a 500 uuid-cast error.
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { GdprService } from './gdpr.service';
import { AuthGuard, RequireScope } from './auth.guard';
import { assertUuid } from '../../common/uuid';
import type { Actor } from '../../common/actor';

interface GuardedRequest {
  actor?: Actor;
}

function requireActor(req: GuardedRequest): Actor {
  if (req.actor === undefined) {
    throw new BadRequestException('Authenticated actor is required');
  }
  return req.actor;
}

@Controller('v1/compliance')
@UseGuards(AuthGuard)
export class ComplianceController {
  constructor(private readonly gdpr: GdprService) {}

  @RequireScope('admin')
  @Get('statutory-archives/:tenantId')
  async listStatutoryArchives(@Req() req: GuardedRequest, @Param('tenantId') tenantId: string) {
    const actor = requireActor(req);
    assertUuid(tenantId, 'tenantId');
    if (tenantId !== actor.tenantId) {
      throw new NotFoundException('Resource not found');
    }
    const archives = await this.gdpr.listStatutoryArchives(tenantId);
    const verified = await Promise.all(
      archives.map((archive) => this.gdpr.verifyStatutoryArchive(tenantId, archive.id)),
    );
    return verified.map((archive) => ({
      id: archive.archiveId,
      tenant_id: archive.tenantId,
      archived_at: archive.archivedAt.toISOString(),
      retention_until: archive.retentionUntil.toISOString(),
      archive_sha256: archive.archiveSha256,
      row_counts: archive.rowCounts,
      storage_bundle_path: archive.storageBundlePath,
      payload_verified: archive.payloadVerified,
      file_verified: archive.fileVerified,
      verified: archive.verified,
    }));
  }
}
