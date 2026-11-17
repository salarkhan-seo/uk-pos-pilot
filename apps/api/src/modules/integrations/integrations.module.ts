import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { EventsController } from './events.controller';
import { WebhooksController } from './webhooks.controller';
import { WebhookService } from './webhook.service';
import { PlatformOperatorGuard } from './platform-operator.guard';

/**
 * Integrations module — Build-03 Objective 4 adds the outbound
 * webhook service (Arch-02 §3) and the Events API controller
 * (GET /v1/events, Arch-02 §3.5). The Build-01 stub status surface is
 * kept unchanged.
 *
 * NOTE (coordinator): WebhookService takes an optional AuditService.
 * Wire AdminModule into this module's imports if DLQ audit events
 * (webhook.dlq_entered / webhook.replayed / webhook.discarded) are
 * wanted from the Nest app; without it the service still works and
 * DLQ transitions are recorded on the delivery rows only. The
 * deliver function is injectable via the WebhookService constructor
 * options — the Nest provider below uses the default fetch-based
 * implementation (5s timeout); a queue/worker wiring can replace it.
 *
 * Build-03 coordinator wiring: AdminModule is imported so the optional
 * AuditService in WebhookService resolves from the Nest app and DLQ
 * audit events (webhook.dlq_entered / webhook.replayed /
 * webhook.discarded) are recorded.
 */
@Module({
  imports: [AdminModule],
  controllers: [IntegrationsController, EventsController, WebhooksController],
  providers: [IntegrationsService, WebhookService, PlatformOperatorGuard],
  exports: [IntegrationsService, WebhookService],
})
export class IntegrationsModule {}
