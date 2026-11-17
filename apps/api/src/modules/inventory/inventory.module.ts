import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';
import { SuppliersController } from './suppliers.controller';

/**
 * Inventory module — stock ledger, counts, goods-in (Build-02) plus
 * the Phase-2 purchasing console (Build-04 Worker 4: warehouses,
 * transfers, reorder suggestions, purchase orders).
 *
 * Build-04 Worker 4 wiring: imports AdminModule so AuthGuard,
 * TenantWriteGuard and the optional AuditService resolve for the
 * PurchasingController — the same import CatalogueModule,
 * ReportingModule and IntegrationsModule already carry for their
 * guarded controllers. Without it the guard's providers cannot be
 * resolved and the new controller cannot be registered.
 */
@Module({
  imports: [AdminModule],
  controllers: [InventoryController, PurchasingController, SuppliersController],
  providers: [InventoryService, PurchasingService],
  exports: [InventoryService, PurchasingService],
})
export class InventoryModule {}
