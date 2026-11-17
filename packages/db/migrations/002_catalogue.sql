-- =============================================================================
-- 002_catalogue.sql — Catalogue: categories, products, variants, tax rates,
-- age restrictions, serial numbers, bundles, barcode rules, suppliers
-- (Arch-01 §2.2; Arch-06 §2.4 for suppliers).
--
-- Rules enforced here:
--   * at most 4 attributes per product (Arch-01 §2.2) — trigger;
--   * at most 20 components per bundle, no nesting, no self-reference
--     (Arch-01 §2.2) — trigger;
--   * SKU unique per tenant (product_variants carries tenant_id for this);
--   * barcode mode is one mode account-wide (price-embedded OR
--     weight-embedded, Arch-01 §2.2 / Arch-06) — one row per tenant.
-- Prices are tax-inclusive pence (bigint). Tax is assigned per variant and
-- snapshotted on the order line at sale (migration 004).
-- =============================================================================

BEGIN;

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  parent_id  uuid REFERENCES categories (id),
  name       text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, parent_id, name)
);
CREATE INDEX idx_categories_tenant ON categories (tenant_id);

-- Tax rates are versioned: a rate change is a new row, future sales only.
-- The rate in force at sale time is snapshotted on order_lines (004).
CREATE TABLE tax_rates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  kind         text NOT NULL
    CHECK (kind IN ('standard', 'reduced', 'zero', 'exempt')),
  rate_percent numeric(5, 2) NOT NULL CHECK (rate_percent >= 0),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, valid_from)
);
CREATE INDEX idx_tax_rates_tenant ON tax_rates (tenant_id);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  category_id uuid REFERENCES categories (id),
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_tenant ON products (tenant_id);
CREATE INDEX idx_products_category ON products (category_id);

CREATE TABLE product_attributes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  product_id uuid NOT NULL REFERENCES products (id),
  name       text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, name)
);

CREATE TABLE attribute_values (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_attribute_id uuid NOT NULL REFERENCES product_attributes (id),
  value               text NOT NULL,
  sort_order          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_attribute_id, value)
);

CREATE TABLE units_of_measure (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  abbreviation text NOT NULL,
  is_base      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, abbreviation)
);

-- Variants carry their own stock and barcode from day one (package §6).
-- tenant_id is denormalised here so SKU uniqueness is per tenant.
CREATE TABLE product_variants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  product_id   uuid NOT NULL REFERENCES products (id),
  sku          text NOT NULL,
  barcode      text,
  name         text NOT NULL,
  price_pence  bigint NOT NULL CHECK (price_pence >= 0),
  cost_pence   bigint NOT NULL DEFAULT 0 CHECK (cost_pence >= 0),
  tax_rate_id  uuid REFERENCES tax_rates (id),
  is_bundle    boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);
CREATE INDEX idx_variants_tenant ON product_variants (tenant_id);
CREATE INDEX idx_variants_product ON product_variants (product_id);
CREATE INDEX idx_variants_barcode ON product_variants (barcode);

CREATE TABLE variant_attribute_values (
  variant_id           uuid NOT NULL REFERENCES product_variants (id),
  product_attribute_id uuid NOT NULL REFERENCES product_attributes (id),
  attribute_value_id   uuid NOT NULL REFERENCES attribute_values (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, product_attribute_id)
);

-- At most 4 attributes per product (Arch-01 §2.2; Lightspeed's official
-- ceiling is 3 attributes / 200 variants — this pilot allows 4 by design).
CREATE OR REPLACE FUNCTION check_max_4_attributes() RETURNS trigger AS $$
DECLARE
  product_id_val uuid;
  attr_count int;
BEGIN
  SELECT pv.product_id INTO product_id_val
    FROM product_variants pv WHERE pv.id = NEW.variant_id;
  SELECT COUNT(DISTINCT vav.product_attribute_id) INTO attr_count
    FROM variant_attribute_values vav
    JOIN product_variants pv2 ON pv2.id = vav.variant_id
   WHERE pv2.product_id = product_id_val
     AND vav.variant_id = NEW.variant_id
     AND (TG_OP <> 'UPDATE' OR vav.product_attribute_id <> OLD.product_attribute_id);
  IF attr_count >= 4 THEN
    RAISE EXCEPTION 'A product may have at most 4 attributes (Arch-01 §2.2)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_variant_attribute_values_max_4
  BEFORE INSERT OR UPDATE ON variant_attribute_values
  FOR EACH ROW EXECUTE FUNCTION check_max_4_attributes();

-- Units for case-breakdown conversion (single stock pool, base units —
-- Arch-06 §5.3, Square model). One base unit per variant.
CREATE TABLE variant_units (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id        uuid NOT NULL REFERENCES product_variants (id),
  unit_id           uuid NOT NULL REFERENCES units_of_measure (id),
  conversion_factor numeric(12, 4) NOT NULL CHECK (conversion_factor > 0),
  is_base           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, unit_id)
);

-- Age restrictions per variant (Arch-01 §2.2). Challenge 25 is a flag in
-- the schema; no Challenge 25 prompt is documented on either incumbent.
CREATE TABLE age_restrictions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  variant_id      uuid NOT NULL REFERENCES product_variants (id),
  min_age_years   int NOT NULL CHECK (min_age_years > 0),
  challenge_25    boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id)
);

-- Serial numbers: tracked in core (Square has a hard gap here, Lightspeed
-- a paid add-on — Arch-01 §2.2). order_id is added in migration 004
-- (orders do not exist yet at this point).
CREATE TABLE serial_numbers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  serial_number text NOT NULL,
  status        text NOT NULL DEFAULT 'in_stock'
    CHECK (status IN ('in_stock', 'sold', 'returned', 'written_off')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial_number)
);
CREATE INDEX idx_serials_variant ON serial_numbers (variant_id);

-- Bundles: own SKU, no nesting, cap 20 components (Square cap adopted,
-- Arch-01 §2.2 / Arch-10 §2.4).
CREATE TABLE bundle_components (
  bundle_variant_id    uuid NOT NULL REFERENCES product_variants (id),
  component_variant_id uuid NOT NULL REFERENCES product_variants (id),
  quantity             int NOT NULL CHECK (quantity > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bundle_variant_id, component_variant_id)
);

CREATE OR REPLACE FUNCTION check_bundle_component() RETURNS trigger AS $$
DECLARE
  component_count int;
  component_is_bundle boolean;
BEGIN
  IF NEW.component_variant_id = NEW.bundle_variant_id THEN
    RAISE EXCEPTION 'A bundle cannot contain itself';
  END IF;
  SELECT is_bundle INTO component_is_bundle
    FROM product_variants WHERE id = NEW.component_variant_id;
  IF component_is_bundle THEN
    RAISE EXCEPTION 'Bundle components cannot themselves be bundles (no nesting, Arch-01 §2.2)';
  END IF;
  SELECT COUNT(*) INTO component_count
    FROM bundle_components WHERE bundle_variant_id = NEW.bundle_variant_id;
  IF component_count >= 20 THEN
    RAISE EXCEPTION 'A bundle may have at most 20 components (Arch-01 §2.2)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bundle_components_rules
  BEFORE INSERT ON bundle_components
  FOR EACH ROW EXECUTE FUNCTION check_bundle_component();

-- Barcode mode: exactly one mode per tenant (price-embedded OR
-- weight-embedded), account-wide (Arch-01 §2.2).
CREATE TABLE barcode_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  mode         text NOT NULL CHECK (mode IN ('price_embedded', 'weight_embedded')),
  sku_length   int NOT NULL DEFAULT 5 CHECK (sku_length > 0),
  price_digits int NOT NULL DEFAULT 5 CHECK (price_digits > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- Suppliers (Arch-06 §2.4). A supplier belongs to one merchant.
CREATE TABLE suppliers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants (id),
  name                       text NOT NULL,
  contact_name               text,
  email                      text,
  phone                      text,
  lead_time_days             int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  minimum_order_value_pence  bigint CHECK (minimum_order_value_pence IS NULL OR minimum_order_value_pence >= 0),
  currency                   char(3) NOT NULL DEFAULT 'GBP',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_suppliers_tenant ON suppliers (tenant_id);

CREATE TABLE supplier_variants (
  supplier_id uuid NOT NULL REFERENCES suppliers (id),
  variant_id  uuid NOT NULL REFERENCES product_variants (id),
  supplier_sku text,
  cost_pence  bigint NOT NULL CHECK (cost_pence >= 0),
  currency    char(3) NOT NULL DEFAULT 'GBP',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, variant_id)
);

COMMIT;
