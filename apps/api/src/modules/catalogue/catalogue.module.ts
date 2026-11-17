import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { Phase2CatalogueController, PriceBookEntriesController, PromotionVouchersController } from './phase2.controller';
import { Phase2CatalogueService } from './phase2.service';
import { PricingService } from './pricing.service';

/** Catalogue module (Build-02, Objective 3) — provides and exports both services for the sales module. Build-03 coordinator wiring: imports AdminModule so the TenantWriteGuard resolves on the write routes (read-only mode during the tenant export window). */
@Module({
  imports: [AdminModule],
  controllers: [CatalogueController, Phase2CatalogueController, PriceBookEntriesController, PromotionVouchersController],
  providers: [CatalogueService, PricingService, Phase2CatalogueService],
  exports: [CatalogueService, PricingService, Phase2CatalogueService],
})
export class CatalogueModule {}
