import { Module, OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { SalesModule } from './modules/sales/sales.module';
import { SyncModule } from './modules/sync/sync.module';
import { UuidValidationInterceptor } from './common/uuid-validation.interceptor';
import { ExitService } from './modules/admin/exit.service';
import { GdprService } from './modules/admin/gdpr.service';
import { PaymentsService } from './modules/payments/payments.service';
import { WebhookService } from './modules/integrations/webhook.service';

/**
 * Root module of the UK POS pilot API (Build-01 skeleton).
 * One feature module per domain, matching the package §8 module list:
 * catalogue, sales, inventory, payments, reporting, admin, integrations.
 * Every module is a stub in Build-01 — controllers and services compile,
 * but no business logic is implemented. Behaviour is Build-02 work.
 */
@Module({
  imports: [
    DatabaseModule,
    CatalogueModule,
    SalesModule,
    InventoryModule,
    PaymentsModule,
    ReportingModule,
    AdminModule,
    IntegrationsModule,
    SyncModule,
  ],
  providers: [
    // Build-06 Objective 2: global UUID validation on every route
    // param and UUID body field, in every controller. Bound here (not
    // in main.ts) so any Nest application built from AppModule — the
    // production server and test apps alike — gets the check. The
    // interceptor throws InvalidUuidException (400 INVALID_UUID) for
    // malformed identifiers; well-formed unknown UUIDs still reach
    // their handler and answer 404.
    { provide: APP_INTERCEPTOR, useClass: UuidValidationInterceptor },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly exitService: ExitService,
    private readonly gdprService: GdprService,
    private readonly paymentsService: PaymentsService,
    private readonly webhookService: WebhookService,
  ) {}

  /**
   * Build-06 Objective 4 (E2E gap fix): wire WebhookService as the
   * EventPublisher for every service that publishes domain events.
   * ExitService (tenant.export_window_started / tenant.deleted),
   * GdprService (tenant.deleted) and PaymentsService (payment.* /
   * refund.failed) all expose an optional setEventPublisher() and
   * silently publish NOTHING while it is unset — the payments module
   * comment says the publisher "is set later by the integrations
   * module", but no code ever did it, so the live API never created
   * a webhook event or attempted a delivery. Wiring it here (the
   * root module is the only place that can see all four providers)
   * makes the outbound webhook pipeline actually run. A publish
   * failure still never fails the originating operation: every
   * caller publishes best-effort.
   */
  onModuleInit(): void {
    this.exitService.setEventPublisher(this.webhookService);
    this.gdprService.setEventPublisher(this.webhookService);
    this.paymentsService.setEventPublisher(this.webhookService);
  }
}
