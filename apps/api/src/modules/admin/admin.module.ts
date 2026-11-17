import { Module } from '@nestjs/common';
import { AdminController, AdminV1Controller } from './admin.controller';
import { ApiKeysController } from './api-keys.controller';
import { AuthController } from './auth.controller';
import { ComplianceController } from './compliance.controller';
import { CrmController } from './crm.controller';
import { ExitController } from './exit.controller';
import { AdminService } from './admin.service';
import { ApiKeyService } from './api-key.service';
import { ApprovalService } from './approval.service';
import { AuditService } from './audit.service';
import { AuthGuard } from './auth.guard';
import { CrmService } from './crm.service';
import { ExitService, TenantWriteGuard } from './exit.service';
import { ExportService } from './export.service';
import { GdprService } from './gdpr.service';
import { SessionService } from './session.service';
import { TierGate } from './tier-gate';

/**
 * Admin module (Build-02, Objective 2; Build-03 Objective 1) — tenancy,
 * manager approvals, the hash-chained audit service, plus production
 * auth: hashed scoped API keys, PIN sessions, tier gating and the auth
 * guard. Exported so the sales module can record approvals and audit
 * events inside its own order transaction, and so other modules can
 * reuse ApiKeyService / SessionService / TierGate / AuthGuard.
 *
 * Build-03 Objective 4 (coordinator wiring): ExitService, ExportService
 * and GdprService are registered here — the tenant exit state machine,
 * the single-click export, GDPR erasure and hard deletion — plus the
 * TenantWriteGuard, which enforces read-only mode (export_window and
 * later) on HTTP write routes. SalesModule already imports AdminModule,
 * so the guard resolves in SalesController; CatalogueModule imports it
 * too (Build-03 coordinator wiring) for its write routes.
 */
@Module({
  controllers: [AdminController, AdminV1Controller, ApiKeysController, AuthController, ComplianceController, CrmController, ExitController],
  providers: [AdminService, ApprovalService, AuditService, ApiKeyService, CrmService, SessionService, TierGate, AuthGuard, ExitService, ExportService, GdprService, TenantWriteGuard],
  exports: [AdminService, ApprovalService, AuditService, ApiKeyService, CrmService, SessionService, TierGate, AuthGuard, ExitService, ExportService, GdprService, TenantWriteGuard],
})
export class AdminModule {}
