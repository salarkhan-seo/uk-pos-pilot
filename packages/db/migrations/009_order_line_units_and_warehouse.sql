-- =============================================================================
-- 009_order_line_units_and_warehouse.sql — order lines carry the unit and
-- warehouse they were sold from (Build-03 Objective 1; Arch-06 §2).
--
-- Adds warehouse_id, unit_id and quantity_in_base_units to order_lines so
-- a sale in a case/pack converts to base units exactly (Arch-06 §2.2:
-- "A sale of a case of 12 decrements the pool by 12 base units... The
-- order line records the unit sold and the base-unit quantity, so a
-- return can restock in the same unit").
--
-- DEFAULTING CHOICE (recorded here, per the Build-03 commission): a
-- database DEFAULT cannot look up the location's default warehouse or
-- the variant's base unit, so the columns are NULLABLE and the
-- application defaults them at write time — InventoryService.
-- decrementStockForOrder (the checkout decrement) fills them when the
-- stock is reserved: warehouse defaults to the location's default
-- warehouse, unit defaults to the variant's base unit
-- (variant_units.is_base = true; NULL when the variant has no
-- variant_units rows, i.e. it is only ever sold in base units), and
-- quantity_in_base_units = quantity x variant_units.conversion_factor.
-- Rows written before this migration keep NULLs (unknown unit/warehouse
-- for historical lines); new lines always carry the three columns after
-- the first tender reserves stock.
-- =============================================================================

BEGIN;

ALTER TABLE order_lines
  ADD COLUMN warehouse_id uuid REFERENCES warehouses (id);

ALTER TABLE order_lines
  ADD COLUMN unit_id uuid REFERENCES variant_units (id);

ALTER TABLE order_lines
  ADD COLUMN quantity_in_base_units bigint
    CHECK (quantity_in_base_units IS NULL OR quantity_in_base_units > 0);

CREATE INDEX idx_order_lines_warehouse ON order_lines (warehouse_id);
CREATE INDEX idx_order_lines_unit ON order_lines (unit_id);

COMMIT;
