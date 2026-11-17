/**
 * ExitService — the tenant exit state machine (Build-03 Objective 4;
 * Arch-01 §4.2, §6.2).
 *
 *   active -> termination_requested -> export_window
 *     -> hard_delete_scheduled -> deleted
 *
 * D-11 (block until resolved): requesting termination is BLOCKED while
 * open register sessions or pending/unknown payment attempts exist.
 * The block error (TerminationBlockedError) returns the EXACT blocking
 * ids — open session ids and pending/unknown payment attempt ids — so
 * the merchant can resolve them (Arch-01 §4.2). The same block
 * applies to hard deletion (Arch-01 §6.3 pre-deletion check) and is
 * enforced there by GdprService via findBlockers().
 *
 * Read-only mode: once a tenant is in `export_window` (or later) the
 * dashboard is read-only — no new sales, no catalogue edits, no new
 * users (Arch-01 §4.2). assertTenantWritable() enforces that; the
 * TenantWriteGuard applies it to HTTP write routes. This file does
 * NOT wire the guard into sales/catalogue modules — the coordinator
 * adds @UseGuards(TenantWriteGuard) to the write routes (see the
 * guard's doc comment for the wiring point).
 *
 * The export window is 30 days from termination taking effect
 * (beginExportWindow), not from the termination request. Exporting
 * does not end the window early.
 *
 * The optional EventPublisher is set via setEventPublisher() (never
 * required): exit transitions publish tenant.export_window_started /
 * tenant.deleted best-effort — a webhook failure never fails the
 * transition. Clock is injectable via setClock() for tests.
 */
import {
  BadRequestException,
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import type { DB, TenantsTable } from '@uk-pos/db';
import { DATABASE } from '../../database/database';
import { AuditService } from './audit.service';
import type { EventPublisher } from '../payments/event-publisher.interface';

export const EXPORT_WINDOW_DAYS = 30;

/** Tenant statuses from which no write is allowed (read-only mode, Arch-01 §4.2). */
export const READ_ONLY_STATUSES: ReadonlyArray<TenantsTable['status']> = [
  'export_window',
  'hard_delete_scheduled',
  'deleted',
];

export interface ExitBlockers {
  openSessionIds: string[];
  blockingPaymentAttemptIds: string[];
}

/**
 * Thrown when termination (or hard deletion) is blocked by unresolved
 * work. Carries the exact blocking ids (D-11 / Arch-01 §4.2).
 */
export class TerminationBlockedError extends ConflictException {
  readonly openSessionIds: string[];
  readonly blockingPaymentAttemptIds: string[];

  constructor(blockers: ExitBlockers) {
    super({
      message: 'Termination blocked: open sessions or pending/unknown payments must be resolved first',
      openSessionIds: blockers.openSessionIds,
      blockingPaymentAttemptIds: blockers.blockingPaymentAttemptIds,
    });
    this.openSessionIds = blockers.openSessionIds;
    this.blockingPaymentAttemptIds = blockers.blockingPaymentAttemptIds;
  }
}

@Injectable()
export class ExitService {
  private eventPublisher?: EventPublisher;
  private clock: () => Date = () => new Date();

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly auditService: AuditService,
  ) {}

  /** Optional: publish exit events (tenant.export_window_started / tenant.deleted). Best-effort only. */
  setEventPublisher(publisher: EventPublisher): void {
    this.eventPublisher = publisher;
  }

  /** Injectable clock (tests control time for the 30-day window). */
  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  async getTenant(tenantId: string): Promise<Selectable<TenantsTable>> {
    const tenant = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant === undefined) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  /**
   * D-11 blockers: open register sessions (status 'open') and payment
   * attempts in 'pending' or 'unknown'. A 'created' attempt has not
   * started and does not block; 'approved' / 'declined' / 'refunded'
   * are resolved.
   */
  async findBlockers(tenantId: string): Promise<ExitBlockers> {
    const openSessions = await this.db
      .selectFrom('register_sessions')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'open')
      .execute();
    const blockingPayments = await this.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', 'in', ['pending', 'unknown'])
      .execute();
    return {
      openSessionIds: openSessions.map((row) => row.id),
      blockingPaymentAttemptIds: blockingPayments.map((row) => row.id),
    };
  }

  static hasBlockers(blockers: ExitBlockers): boolean {
    return blockers.openSessionIds.length > 0 || blockers.blockingPaymentAttemptIds.length > 0;
  }

  private async recordTenantAudit(
    tenantId: string,
    userId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.auditService.record(this.db, {
      tenantId,
      userId,
      eventType,
      entityType: 'tenant',
      entityId: tenantId,
      payload,
    });
  }

  private async publishBestEffort(eventType: 'tenant.export_window_started' | 'tenant.deleted', tenantId: string, payload: Record<string, unknown>): Promise<void> {
    if (this.eventPublisher === undefined) {
      return;
    }
    try {
      await this.eventPublisher.publish(eventType, { tenant_id: tenantId, ...payload });
    } catch {
      // A webhook failure never fails an exit transition (Arch-02 §3.1:
      // webhooks are notifications, not the system of record).
    }
  }

  /**
   * active -> termination_requested. Blocked (D-11) while open
   * sessions or pending/unknown payments exist.
   */
  async requestTermination(
    tenantId: string,
    userId: string | null = null,
  ): Promise<Selectable<TenantsTable>> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.status !== 'active') {
      throw new BadRequestException(
        `Termination can only be requested from status 'active' (current: '${tenant.status}')`,
      );
    }
    const blockers = await this.findBlockers(tenantId);
    if (ExitService.hasBlockers(blockers)) {
      throw new TerminationBlockedError(blockers);
    }
    const now = this.clock();
    const updated = await this.db
      .updateTable('tenants')
      .set({ status: 'termination_requested', termination_requested_at: now, updated_at: now })
      .where('id', '=', tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.recordTenantAudit(tenantId, userId, 'tenant.termination_requested', {
      requestedAt: now.toISOString(),
    });
    return updated;
  }

  /**
   * termination_requested -> export_window. Termination takes effect
   * here: the 30-day read-only window starts now (export_window_ends_at
   * = now + 30 days) and a tenant_export_windows row is opened.
   */
  async beginExportWindow(
    tenantId: string,
    userId: string | null = null,
  ): Promise<{ tenant: Selectable<TenantsTable>; windowEndsAt: Date }> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.status !== 'termination_requested') {
      throw new BadRequestException(
        `Export window can only start from status 'termination_requested' (current: '${tenant.status}')`,
      );
    }
    const now = this.clock();
    const windowEndsAt = new Date(now.getTime() + EXPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const updated = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('tenants')
        .set({ status: 'export_window', export_window_ends_at: windowEndsAt, updated_at: now })
        .where('id', '=', tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('tenant_export_windows')
        .values({
          tenant_id: tenantId,
          window_started_at: now,
          window_ends_at: windowEndsAt,
          status: 'open',
        })
        .execute();
      return row;
    });
    await this.recordTenantAudit(tenantId, userId, 'tenant.export_window_started', {
      terminatedAt: now.toISOString(),
      exportWindowEndsAt: windowEndsAt.toISOString(),
    });
    await this.publishBestEffort('tenant.export_window_started', tenantId, {
      terminated_at: now.toISOString(),
      export_window_ends_at: windowEndsAt.toISOString(),
    });
    return { tenant: updated, windowEndsAt };
  }

  /**
   * export_window -> hard_delete_scheduled. Only once the 30-day
   * window has ended (export_window_ends_at <= now). Automated hard
   * deletion itself is GdprService.hardDelete().
   */
  async scheduleHardDelete(
    tenantId: string,
    userId: string | null = null,
  ): Promise<Selectable<TenantsTable>> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.status !== 'export_window') {
      throw new BadRequestException(
        `Hard deletion can only be scheduled from status 'export_window' (current: '${tenant.status}')`,
      );
    }
    const now = this.clock();
    if (tenant.export_window_ends_at === null || tenant.export_window_ends_at > now) {
      throw new BadRequestException('The 30-day export window has not ended yet');
    }
    const updated = await this.db
      .updateTable('tenants')
      .set({ status: 'hard_delete_scheduled', hard_delete_scheduled_at: now, updated_at: now })
      .where('id', '=', tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.recordTenantAudit(tenantId, userId, 'tenant.hard_delete_scheduled', {
      scheduledAt: now.toISOString(),
    });
    return updated;
  }

  /**
   * Read-only enforcement (Arch-01 §4.2). Throws ForbiddenException
   * when the tenant is in `export_window` or later; returns the tenant
   * row when writes are allowed. Throws NotFoundException for an
   * unknown tenant (never leaks existence across tenants — G-B).
   */
  async assertTenantWritable(tenantId: string): Promise<Selectable<TenantsTable>> {
    const tenant = await this.getTenant(tenantId);
    if ((READ_ONLY_STATUSES as readonly string[]).includes(tenant.status)) {
      throw new ForbiddenException(
        `Tenant is read-only (status '${tenant.status}'): no new sales, catalogue edits or users`,
      );
    }
    return tenant;
  }
}


// ---------------------------------------------------------------------
// TenantWriteGuard — Nest guard applying assertTenantWritable to HTTP
// write routes.
//
// WIRING POINT (coordinator — this file does NOT wire it in, so no
// sales/catalogue file is touched by Objective 4):
//   import { TenantWriteGuard } from '../admin/exit.service';
//   @UseGuards(TenantWriteGuard)
//   @Post('orders') ...   // sales.controller.ts
//   @Post('products') ... // catalogue.controller.ts (and variants, categories)
//   ... plus any other write route that must stop in the export window.
// The guard reads the tenant id from the x-tenant-id header (the same
// demo header auth the controllers already use). It fails closed: no
// tenant id, or a read-only tenant, blocks the write.
// ---------------------------------------------------------------------
@Injectable()
export class TenantWriteGuard implements CanActivate {
  constructor(private readonly exitService: ExitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest() as {
      headers?: Record<string, string | string[] | undefined>;
      body?: Record<string, unknown>;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
    };
    const headerValue = request.headers?.['x-tenant-id'];
    const tenantId =
      (Array.isArray(headerValue) ? headerValue[0] : headerValue) ??
      (typeof request.body?.tenantId === 'string' ? request.body.tenantId : undefined) ??
      (typeof request.params?.tenantId === 'string' ? request.params.tenantId : undefined) ??
      (typeof request.query?.tenantId === 'string' ? request.query.tenantId : undefined);
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new BadRequestException('Tenant id is required for this write');
    }
    await this.exitService.assertTenantWritable(tenantId);
    return true;
  }
}
