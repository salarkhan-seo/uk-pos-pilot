/**
 * Route test — catalogue price-change visibility (Build-04 Worker 4).
 *
 * CatalogueService.updateVariantPrice used to set price_pence only and
 * never stamp updated_at, so a register relying on the handshake `since`
 * delta (SyncService: variants WHERE updated_at > since) could miss a
 * price change and keep selling at the stale price until a full
 * snapshot. This test proves a price change is visible to a `since`
 * query afterwards.
 */
import { describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { createTestDb, seedTenant, seedVariant } from '@uk-pos/db';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service';
import { actorFor, withDb } from './helpers';

describe('CatalogueService.updateVariantPrice — updated_at stamp', () => {
  it('stamps updated_at so the change is visible to a since delta query', async () => {
    await withDb(async ({ db, tenant }) => {
      const catalogue = new CatalogueService(db);
      const admin = actorFor(tenant, 'admin');
      const { variantId } = await seedVariant(db, tenant, { pricePence: 1000n });
      // Backdate the row so the before/after is unambiguous.
      await db
        .updateTable('product_variants')
        .set({ updated_at: new Date('2026-01-01T00:00:00Z') })
        .where('id', '=', variantId)
        .execute();
      const sinceBefore = new Date('2026-06-01T00:00:00Z');

      const updated = await catalogue.updateVariantPrice(admin, variantId, 1250n);
      expect(updated.price_pence).toBe(1250n);
      expect(updated.updated_at.getTime()).toBeGreaterThan(
        new Date('2026-01-01T00:00:00Z').getTime(),
      );

      // The exact delta predicate the register handshake uses
      // (sync.service.ts: variants WHERE updated_at > since).
      const visible = await db
        .selectFrom('product_variants')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .where('updated_at', '>', sinceBefore)
        .execute();
      expect(visible.map((row) => row.id)).toContain(variantId);

      // A since AFTER the change sees nothing (no false positive).
      const afterChange = new Date(Date.now() + 60_000);
      const notVisible = await db
        .selectFrom('product_variants')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .where('updated_at', '>', afterChange)
        .execute();
      expect(notVisible.map((row) => row.id)).not.toContain(variantId);
    });
  });

  it('still enforces admin/owner-only repricing and cross-tenant 404', async () => {
    const { db, close } = await createTestDb();
    try {
      const tenantA = await seedTenant(db);
      const tenantB = await seedTenant(db, { name: 'Other Shop Ltd' });
      const catalogue = new CatalogueService(db);
      const { variantId } = await seedVariant(db, tenantA);
      await expect(
        catalogue.updateVariantPrice(actorFor(tenantA, 'manager'), variantId, 999n),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        catalogue.updateVariantPrice(actorFor(tenantB, 'admin'), variantId, 999n),
      ).rejects.toBeInstanceOf(NotFoundException);
    } finally {
      await close();
    }
  });
});
