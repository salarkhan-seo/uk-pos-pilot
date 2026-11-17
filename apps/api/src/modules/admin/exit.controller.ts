/**
 * Exit controller (Build-04 Worker 4).
 *
 * Thin HTTP over ExitService (termination state machine) and
 * ExportService (single-click full export). Guarded by AuthGuard with
 * the 'admin' scope; the Actor comes from request.actor.
 *
 * TenantWriteGuard: applied to requestTermination and beginExportWindow
 * only. It is deliberately NOT applied to runFullExport or
 * scheduleHardDelete — both run while the tenant is IN the export
 * window, which is a read-only status, so the guard would make them
 * unreachable (the window exists so the export can run). The exit
 * state machine itself enforces the legal transitions (active ->
 * termination_requested -> export_window -> hard_delete_scheduled),
 * and D-11 blocking (409 with the exact blocking ids) comes from the
 * service, unchanged.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ExitService } from './exit.service';
import { ExportService } from './export.service';
import { GdprService } from './gdpr.service';
import { AuthGuard, RequireScope } from './auth.guard';
import { TenantWriteGuard } from './exit.service';
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

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

@Controller('v1/admin/exit')
@UseGuards(AuthGuard)
export class ExitController {
  constructor(
    private readonly exit: ExitService,
    private readonly exports: ExportService,
    private readonly gdpr: GdprService,
  ) {}

  private async statusView(actor: Actor) {
    const tenant = await this.exit.getTenant(actor.tenantId);
    const blockers = await this.exit.findBlockers(actor.tenantId);
    return {
      tenantId: tenant.id,
      status: tenant.status,
      exportWindowEndsAt: iso(tenant.export_window_ends_at),
      openSessionIds: blockers.openSessionIds,
      blockingPaymentAttemptIds: blockers.blockingPaymentAttemptIds,
    };
  }

  @RequireScope('admin')
  @Get('status')
  async getStatus(@Req() req: GuardedRequest) {
    return this.statusView(requireActor(req));
  }

  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('request-termination')
  async requestTermination(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    await this.exit.requestTermination(actor.tenantId, actor.userId);
    return this.statusView(actor);
  }

  @RequireScope('admin')
  @UseGuards(TenantWriteGuard)
  @Post('begin-export-window')
  async beginExportWindow(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    await this.exit.beginExportWindow(actor.tenantId, actor.userId);
    return this.statusView(actor);
  }

  @RequireScope('admin')
  @Post('full-export')
  async runFullExport(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    return this.exports.runFullExport(actor.tenantId, actor.userId);
  }

  @RequireScope('admin')
  @Post('schedule-hard-delete')
  async scheduleHardDelete(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    await this.exit.scheduleHardDelete(actor.tenantId, actor.userId);
    return this.statusView(actor);
  }

  /**
   * Execute the hard deletion (Build-06 Objective 4): POST
   * /v1/admin/exit/hard-delete. GdprService.hardDelete() existed
   * since Build-03 but no HTTP route ever called it — the exit
   * lifecycle stopped at schedule-hard-delete and the deletion
   * itself (plus the 6-year statutory VAT archive it separates
   * first) could only run from a service-level call. Requires
   * status 'hard_delete_scheduled' and an ended 30-day window; the
   * service enforces both, plus D-11 blockers, plus zero-row
   * verification with a '[deleted]' tombstone. Deliberately NOT
   * TenantWriteGuarded: hard_delete_scheduled is a read-only status
   * and the guard would make this route unreachable (same reasoning
   * as full-export and schedule-hard-delete). Returns the deletion
   * job id, the verified statutory archive (SHA-256 + on-disk bundle
   * path — the caller re-hashes the bundle to prove the archive)
   * and the verified row count (0). The tenant's API key is deleted
   * with the tenant, so this is the last call that key can make.
   */
  @RequireScope('admin')
  @Post('hard-delete')
  async hardDelete(@Req() req: GuardedRequest) {
    const actor = requireActor(req);
    const result = await this.gdpr.hardDelete(actor.tenantId, actor.userId);
    return {
      jobId: result.jobId,
      tenantId: result.tenantId,
      deletedAt: result.deletedAt.toISOString(),
      verifiedRowCount: result.verifiedRowCount,
      statutoryArchive: {
        archiveId: result.statutoryArchive.archiveId,
        tenantId: result.statutoryArchive.tenantId,
        archivedAt: result.statutoryArchive.archivedAt.toISOString(),
        retentionUntil: result.statutoryArchive.retentionUntil.toISOString(),
        archiveSha256: result.statutoryArchive.archiveSha256,
        storageBundlePath: result.statutoryArchive.storageBundlePath,
        rowCounts: result.statutoryArchive.rowCounts,
      },
    };
  }
}
