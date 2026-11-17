import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { AdminModule } from '../admin/admin.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { SalesModule } from '../sales/sales.module';

/**
 * Sync module (Build-04, Objective 1) — register delta-sync handshake
 * and offline cash flush. Imports AdminModule (AuthGuard, AuditService,
 * TenantWriteGuard), CatalogueModule (server repricing) and SalesModule
 * (order replay through the existing checkout paths).
 */
@Module({
  imports: [AdminModule, CatalogueModule, SalesModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
