-- =============================================================================
-- 008_phase2_promotions.sql — Phase 2: promotions, discounts & pricing engine
-- (Arch-10 §§2–4).
--
-- Phase 2, NOT pilot (D-02 Option A): structural only, gated by feature
-- flags. The pricing pipeline is deterministic (Arch-10 §2.1):
--   base variant price -> price book -> automatic promotions -> voucher
--   code -> manual discount -> tax and margin, evaluated server-side.
--
-- Rules:
--   * D-14 stated as an exact algorithm (Arch-10 §2.3): basket discounts
--     are allocated pro-rata by line total, rounded per line round-half-up
--     (D-13), rounding remainder to the largest line; tax is computed per
--     line on the discounted price; margin comes from the cost snapshot.
--     The algorithm lives in the shared kernel (packages/shared-kernel);
--     the allocation is stored on order_lines (migration 004) and on
--     applied_promotions here.
--   * voucher vs gift card (Arch-10 §4.4): a voucher is a DISCOUNT (reduces
--     revenue, never a liability); a gift card is a STORED-VALUE instrument
--     (liability on issue, revenue on redemption — migration 007).
--   * voucher codes store code_hash + code_last4 only, exactly as the
--     gift-card code pattern (Arch-09 §4.2); single-use enforced atomically
--     with an idempotency key; codes cannot be redeemed offline.
--   * loyalty campaigns: promotional discounts REDUCE the loyalty earn base
--     (Arch-10 §4.1); a bonus-point campaign multiplies the earn RATE, it
--     does not change the base.
-- =============================================================================

BEGIN;

-- A named, dated set of variant prices — the seasonal mechanism
-- (Arch-10 §2.4). Overlap resolves by priority, then latest effective date.
CREATE TABLE price_books (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  name           text NOT NULL,
  priority       int NOT NULL DEFAULT 0,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  status         text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, effective_from)
);

CREATE TABLE price_book_entries (
  price_book_id uuid NOT NULL REFERENCES price_books (id),
  variant_id    uuid NOT NULL REFERENCES product_variants (id),
  price_pence   bigint NOT NULL CHECK (price_pence >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (price_book_id, variant_id)
);

-- A promotion is a dated, targeted, versioned rule — never a free-text
-- discount applied at the till (that is a manual discount, migration 004).
CREATE TABLE promotions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  name                text NOT NULL,
  type                text NOT NULL CHECK (type IN ('percentage', 'fixed', 'bogo', 'multibuy', 'bundle', 'loyalty_bonus', 'staff')),
  status              text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'expired')),
  version             int NOT NULL DEFAULT 1 CHECK (version >= 1),
  stack_group         text,
  start_at            timestamptz NOT NULL,
  end_at              timestamptz,
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at IS NULL OR end_at > start_at)
);
CREATE INDEX idx_promotions_tenant ON promotions (tenant_id, status, start_at);

-- Conditions that must ALL hold (AND logic; OR is separate promotions).
CREATE TABLE promotion_conditions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id    uuid NOT NULL REFERENCES promotions (id),
  condition_type  text NOT NULL,
  condition_value jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_promotion_conditions ON promotion_conditions (promotion_id);

-- Which catalogue objects the promotion applies to. A promotion with
-- scope `all` has no target rows.
CREATE TABLE promotion_targets (
  promotion_id uuid NOT NULL REFERENCES promotions (id),
  target_type  text NOT NULL CHECK (target_type IN ('category', 'product', 'variant', 'customer_group')),
  target_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, target_type, target_id)
);

-- Every promotion applied to an order is recorded — one row per promotion
-- per order (or per line). Without this table a discounted price is
-- unexplained and the Z-report, VAT return and returns cannot be rebuilt.
CREATE TABLE applied_promotions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  order_id            uuid NOT NULL REFERENCES orders (id),
  order_line_id       uuid REFERENCES order_lines (id),
  promotion_id        uuid NOT NULL REFERENCES promotions (id),
  promotion_version   int NOT NULL CHECK (promotion_version >= 1),
  discount_pence      bigint NOT NULL CHECK (discount_pence >= 0),
  applied_by_user_id  uuid REFERENCES users (id),
  voided              boolean NOT NULL DEFAULT false,
  voided_by_user_id   uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_applied_promotions_order ON applied_promotions (order_id);

-- Voucher codes: server-side generation, hash + last-4 only (the Arch-09
-- §4.2 gift-card code pattern), single-use enforced atomically with an
-- idempotency key, void as a state not a deletion. Codes are never in
-- logs, exports or webhooks. Cannot be redeemed offline.
CREATE TABLE voucher_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  code_hash    text NOT NULL,
  code_last4   char(4) NOT NULL,
  promotion_id uuid REFERENCES promotions (id),
  status       text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'redeemed', 'void', 'expired')),
  max_uses     int NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses_count   int NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code_hash),
  CHECK (uses_count <= max_uses)
);

-- Loyalty campaigns (Arch-10 §4.1). A campaign multiplies the earn rate;
-- it never changes the earn base (discounted line total).
CREATE TABLE loyalty_campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  promotion_id      uuid REFERENCES promotions (id),
  name              text NOT NULL,
  points_multiplier numeric(5, 2) NOT NULL CHECK (points_multiplier > 0),
  category_id       uuid REFERENCES categories (id),
  customer_group_id uuid REFERENCES customer_groups (id),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz,
  status            text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'expired')),
  created_by_user_id uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at IS NULL OR end_at > start_at)
);

-- order_lines.price_book_id (migration 004) gets its foreign key now.
ALTER TABLE order_lines
  ADD CONSTRAINT fk_order_lines_price_book FOREIGN KEY (price_book_id) REFERENCES price_books (id);

COMMIT;
