import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { AdminModule } from '../admin/admin.module';

/**
 * Payments module (Build-03 Objective 2) — the provider adapter layer
 * (simulated Stripe Terminal + standalone fallback), W-12 unknown-payment
 * resolution, late-webhook discrepancies. Imports AdminModule for the
 * ApprovalService (manager decisions) and AuditService (hash-chained
 * audit + discrepancy alerts). The EventPublisher is set later by the
 * integrations module — the service works without one.
 */
@Module({
  imports: [AdminModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
