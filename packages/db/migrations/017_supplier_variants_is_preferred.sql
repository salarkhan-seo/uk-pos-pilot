-- =============================================================================
-- 017_supplier_variants_is_preferred.sql — Preferred-supplier flag on
-- supplier-variant links (Build-10 Objective 2).
--
-- The commission requires POST /v1/purchasing/suppliers/:id/variants to
-- link a variant with supplier_sku, cost_pence and is_preferred, but the
-- supplier_variants table (migration 002) has no is_preferred column —
-- it was never stored anywhere. This migration adds it; no new table,
-- so the table count stays 89.
-- =============================================================================

BEGIN;

ALTER TABLE supplier_variants
  ADD COLUMN is_preferred boolean NOT NULL DEFAULT false;

COMMIT;
