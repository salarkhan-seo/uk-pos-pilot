import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { AdminModule } from '../admin/admin.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';

/** Sales module (Build-02, Objective 5; Build-03 Objective 2 adds the
 * PaymentsModule import for W-12 resolution and refund processing). */
@Module({
  imports: [AdminModule, CatalogueModule, InventoryModule, PaymentsModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
