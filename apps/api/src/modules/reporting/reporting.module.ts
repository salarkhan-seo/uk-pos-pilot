import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller';
import { ReportingV1Controller } from './reporting.v1.controller';
import { SessionsController } from './reporting.sessions.controller';
import { ReportingService } from './reporting.service';
import { AdminModule } from '../admin/admin.module';

/**
 * Reporting module (Build-03, Objective 3) — register sessions,
 * immutable Z-reports, VAT periods, CSV accounting export and settlement
 * reconciliation. Imports AdminModule for ApprovalService (D-08 variance
 * and petty-cash approvals) and AuditService (every session/Z/VAT/
 * settlement event is audit-logged).
 */
@Module({
  imports: [AdminModule],
  controllers: [ReportingController, ReportingV1Controller, SessionsController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
