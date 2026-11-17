-- Build-12 Objective 3: standalone purchase-order creation takes a
-- warehouseId and an optional expectedDeliveryDate, but purchase_orders
-- had neither column (the reorder-suggestion conversion derives the
-- location from the suggestion and never records a warehouse or a
-- delivery date). Both columns are nullable: POs created by accepting
-- a reorder suggestion carry neither, and the standalone create may
-- omit the date. The warehouse is validated against the tenant and
-- its location becomes the PO's location_id; the warehouse itself is
-- now recorded on the PO so goods-in knows where the delivery is due.
ALTER TABLE purchase_orders ADD COLUMN warehouse_id uuid REFERENCES warehouses (id);
ALTER TABLE purchase_orders ADD COLUMN expected_delivery_date timestamptz;
