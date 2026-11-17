-- =============================================================================
-- 003_inventory_ledger.sql — Inventory: append-only stock ledger, warehouses,
-- counts, transfers, reorder points, purchase orders, goods-in, valuation
-- (Arch-01 §2.3–2.4; Arch-06 §§2–5).
--
-- Core invariant (package §9): stock on hand = SUM(stock_movements) for a
-- variant in a warehouse. There is NO settable quantity anywhere.
-- stock_balances and stock_valuation are READ MODELS (computed, cached),
-- never the truth and never written by the till.
--
-- Constraints C-INV-01–05 (Arch-06 §2.6):
--   C-INV-01 no negative stock — enforced by the application at tender time
--              (pessimistic lock, availability check inside the lock before
--              any payment attempt — G-A-13) and by the balance CHECK here;
--   C-INV-02 one movement, one cause — cause is a single NOT NULL value
--              from the closed list below;
--   C-INV-03 transfer pairing — transfer_out and transfer_in movements
--              share one transfer_id (reference_id + reference_type);
--   C-INV-04 no direct quantity set — there is no quantity column to set;
--   C-INV-05 one active count per location — partial unique index below.
-- Phase 2 tables (warehouses, transfers, POs, goods-in) are included as
-- structure now, gated by feature flags (D-02 Option A).
-- =============================================================================

BEGIN;

-- A stock-holding place inside a location: a shop's back room or a separate
-- store/warehouse (Arch-06 §2.1). One default per location.
CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  name       text NOT NULL,
  type       text NOT NULL DEFAULT 'store' CHECK (type IN ('store', 'warehouse')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_warehouses_one_default_per_location
  ON warehouses (location_id) WHERE is_default;
CREATE INDEX idx_warehouses_tenant ON warehouses (tenant_id);

-- Read model: cached on-hand per variant per warehouse. NEVER set directly;
-- recomputed from stock_movements. quantity_on_hand must never go negative.
CREATE TABLE stock_balances (
  variant_id       uuid NOT NULL REFERENCES product_variants (id),
  warehouse_id     uuid NOT NULL REFERENCES warehouses (id),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  location_id      uuid NOT NULL REFERENCES locations (id),
  quantity_on_hand bigint NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, warehouse_id)
);

-- The ledger. Append-only: UPDATE/DELETE are blocked by trigger.
-- quantity_change is signed (sale negative, goods-in positive) and never 0.
-- cost_pence_at_movement snapshots the cost at the moment of the movement
-- (weighted-average valuation, Arch-06 §5.3).
-- order_id is added in migration 004 (orders do not exist yet).
CREATE TABLE stock_movements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  variant_id              uuid NOT NULL REFERENCES product_variants (id),
  warehouse_id            uuid REFERENCES warehouses (id),
  location_id             uuid NOT NULL REFERENCES locations (id),
  cause                   text NOT NULL CHECK (cause IN (
    'sale', 'return', 'adjustment', 'count', 'goods_in',
    'transfer_out', 'transfer_in', 'damage', 'shrinkage', 'found',
    'supplier_error', 'offline_sync_conflict', 'case_breakdown'
  )),
  quantity_change         bigint NOT NULL CHECK (quantity_change <> 0),
  quantity_in_base_units  bigint,
  unit_id                 uuid REFERENCES units_of_measure (id),
  cost_pence_at_movement  bigint CHECK (cost_pence_at_movement IS NULL OR cost_pence_at_movement >= 0),
  order_id                uuid,
  reference_id            uuid,
  reference_type          text,
  created_by_user_id      uuid REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_variant ON stock_movements (tenant_id, variant_id, warehouse_id, created_at);
CREATE INDEX idx_stock_movements_order ON stock_movements (order_id);

CREATE TRIGGER trg_stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_change();

-- Counts: one active (draft) count per location (D-10 Option A).
-- Stock does not change until the count is submitted; differences become
-- adjustment movements with a reason (Arch-04 §2.9).
CREATE TABLE stock_counts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  location_id          uuid NOT NULL REFERENCES locations (id),
  warehouse_id         uuid REFERENCES warehouses (id),
  status               text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'cancelled')),
  started_by_user_id   uuid REFERENCES users (id),
  submitted_by_user_id uuid REFERENCES users (id),
  submitted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_stock_counts_one_active_per_location
  ON stock_counts (location_id) WHERE status = 'draft';

CREATE TABLE stock_count_lines (
  count_id           uuid NOT NULL REFERENCES stock_counts (id),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  warehouse_id       uuid REFERENCES warehouses (id),
  expected_quantity  bigint NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity   bigint CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (count_id, variant_id, warehouse_id)
);

-- Transfers between warehouses (same location or different locations).
-- A transfer is TWO movements (transfer_out + transfer_in) sharing the
-- transfer id as reference_id (C-INV-03).
CREATE TABLE stock_transfers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  from_warehouse_id     uuid NOT NULL REFERENCES warehouses (id),
  to_warehouse_id       uuid NOT NULL REFERENCES warehouses (id),
  status                text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_transit', 'received', 'cancelled')),
  requested_by_user_id  uuid REFERENCES users (id),
  received_by_user_id   uuid REFERENCES users (id),
  received_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE stock_transfer_lines (
  transfer_id        uuid NOT NULL REFERENCES stock_transfers (id),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  quantity           bigint NOT NULL CHECK (quantity > 0),
  received_quantity  bigint NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transfer_id, variant_id)
);

-- Reorder points: per outlet, per variant (Arch-06 §4.1).
CREATE TABLE reorder_points (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  location_id   uuid NOT NULL REFERENCES locations (id),
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  min_quantity  bigint NOT NULL CHECK (min_quantity >= 0),
  max_quantity  bigint NOT NULL CHECK (max_quantity >= min_quantity),
  supplier_id   uuid REFERENCES suppliers (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, variant_id)
);

-- A suggestion is NOT an order. It never sends a PO (Arch-06 §4.2).
CREATE TABLE purchase_order_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  location_id        uuid NOT NULL REFERENCES locations (id),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  supplier_id        uuid REFERENCES suppliers (id),
  suggested_quantity bigint NOT NULL CHECK (suggested_quantity > 0),
  expected_date      date,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_suggestions ON purchase_order_suggestions (tenant_id, location_id, status);

-- Purchase orders: sequential PO numbers per tenant/location, no gaps
-- (D-15 Option A). Lifecycle: draft -> sent -> partially_received ->
-- received / cancelled. Sending is email/portal in Phase 2, no EDI.
CREATE TABLE purchase_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  supplier_id uuid NOT NULL REFERENCES suppliers (id),
  po_number   bigint NOT NULL,
  status      text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
  currency    char(3) NOT NULL DEFAULT 'GBP',
  exchange_rate numeric(12, 6),
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id, po_number)
);

CREATE TABLE purchase_order_lines (
  po_id              uuid NOT NULL REFERENCES purchase_orders (id),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  quantity_ordered   bigint NOT NULL CHECK (quantity_ordered > 0),
  quantity_received  bigint NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  cost_pence         bigint NOT NULL CHECK (cost_pence >= 0),
  currency           char(3) NOT NULL DEFAULT 'GBP',
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (po_id, variant_id)
);

-- Goods-in receipts. Receiving without a PO is supported (po_id null,
-- supplier still recorded — Arch-06 §5.2). The receipt form defaults to
-- ZERO received, never to the ordered quantity.
CREATE TABLE goods_in_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  po_id                uuid REFERENCES purchase_orders (id),
  location_id          uuid NOT NULL REFERENCES locations (id),
  warehouse_id         uuid REFERENCES warehouses (id),
  received_by_user_id  uuid REFERENCES users (id),
  received_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE goods_in_lines (
  receipt_id        uuid NOT NULL REFERENCES goods_in_receipts (id),
  variant_id        uuid NOT NULL REFERENCES product_variants (id),
  quantity_ordered  bigint NOT NULL DEFAULT 0 CHECK (quantity_ordered >= 0),
  quantity_received bigint NOT NULL CHECK (quantity_received >= 0),
  quantity_damaged  bigint NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
  quantity_short    bigint NOT NULL DEFAULT 0 CHECK (quantity_short >= 0),
  cost_pence        bigint NOT NULL CHECK (cost_pence >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receipt_id, variant_id)
);

-- Read model: weighted-average cost per variant per warehouse.
-- new average = (old qty x old avg + received qty x received cost)
--               / (old qty + received qty); revalued on goods-in only,
-- never retroactively (Arch-06 §5.3).
CREATE TABLE stock_valuation (
  variant_id                   uuid NOT NULL REFERENCES product_variants (id),
  warehouse_id                 uuid NOT NULL REFERENCES warehouses (id),
  tenant_id                    uuid NOT NULL REFERENCES tenants (id),
  weighted_average_cost_pence  bigint NOT NULL DEFAULT 0 CHECK (weighted_average_cost_pence >= 0),
  quantity_on_hand             bigint NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  computed_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, warehouse_id)
);

COMMIT;
