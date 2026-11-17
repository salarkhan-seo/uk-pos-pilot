-- =============================================================================
-- 007_phase2_crm_loyalty.sql — Phase 2: CRM, loyalty, gift cards, store
-- credit, marketing consent (Arch-09 §§2–5).
--
-- Phase 2, NOT pilot (D-02 Option A): these tables are structural only and
-- are gated by feature flags. Loyalty/CRM/gift cards/store credit are
-- deferred per package §6 and Arch-02 §5.2.
--
-- Rules:
--   * customers are minimal (Arch-09 §2.2): no date of birth is stored —
--     age is verified at the till and recorded as a verified age
--     (age_verification_events, migration 004).
--   * loyalty_ledger, gift_card_ledger, store_credit_ledger and
--     marketing_consents are APPEND-ONLY (triggers); corrections are new
--     rows with a reason and a link to the original.
--   * loyalty: earn only on completed orders, redeem only as a tender;
--     balance = sum of movements; no negative balance (enforced by the
--     application — the ledger stores signed points and the balance is a
--     derived read model, customer_purchase_summaries / balance queries).
--   * gift cards are BEARER instruments: code_hash + code_last4 only, the
--     full code is never stored. Store credit is PER-CUSTOMER.
--   * consent history is separate from the transaction profile: enrolment
--     in loyalty is NOT marketing consent (Arch-09 §5.2).
--   * gift-card issuance posts as a liability (unearned revenue);
--     redemption recognises revenue (Arch-02 §5.2) — accounting treatment,
--     applied by the application in Phase 2.
-- =============================================================================

BEGIN;

CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  first_name text NOT NULL,
  last_name  text,
  email      text,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX idx_customers_tenant ON customers (tenant_id);

-- orders.customer_id (migration 004) gets its foreign key now.
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id);

-- Append-only consent history. A consent change is a new row, never an
-- edit. Separate consents per purpose and channel.
CREATE TABLE marketing_consents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  customer_id          uuid NOT NULL REFERENCES customers (id),
  purpose              text NOT NULL,
  channel              text NOT NULL,
  consented            boolean NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id  uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consents_customer ON marketing_consents (customer_id, purpose, channel, recorded_at);

CREATE TRIGGER trg_marketing_consents_append_only
  BEFORE UPDATE OR DELETE ON marketing_consents
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_change();

-- One membership per customer per tenant.
CREATE TABLE loyalty_memberships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  customer_id       uuid NOT NULL REFERENCES customers (id),
  membership_number text NOT NULL,
  status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id),
  UNIQUE (tenant_id, membership_number)
);

-- Groups are on every tier that offers CRM (Arch-09 §2.3).
CREATE TABLE customer_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE customer_group_memberships (
  customer_id uuid NOT NULL REFERENCES customers (id),
  group_id    uuid NOT NULL REFERENCES customer_groups (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, group_id)
);

-- Optional, and flagged as a minimisation risk (Arch-09 §5.3): free text is
-- the hardest personal data to minimise, erase and export.
CREATE TABLE customer_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  customer_id        uuid NOT NULL REFERENCES customers (id),
  note               text NOT NULL,
  created_by_user_id uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE customer_notes IS
  'Optional. Minimisation risk (Arch-09 §5.3): free text is the hardest personal data to minimise, erase and export.';

-- Purchase history is DERIVED from the ledger; this is a cached read model,
-- never a second truth (Arch-09 §2.4).
CREATE TABLE customer_purchase_summaries (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  customer_id     uuid NOT NULL REFERENCES customers (id),
  total_orders    int NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  total_spend_pence bigint NOT NULL DEFAULT 0 CHECK (total_spend_pence >= 0),
  last_order_at   timestamptz,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id)
);

-- Append-only loyalty ledger. Earn on discounted line totals (D-14);
-- gift-card purchases do not earn; returns reverse the earn.
-- points-per-pound is the recommended Phase 2 default; tiers are deferred.
CREATE TABLE loyalty_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  customer_id       uuid NOT NULL REFERENCES customers (id),
  membership_id     uuid NOT NULL REFERENCES loyalty_memberships (id),
  kind              text NOT NULL CHECK (kind IN ('earn', 'redeem', 'correction', 'expiry')),
  points            bigint NOT NULL,
  order_id          uuid REFERENCES orders (id),
  reason            text,
  idempotency_key   text NOT NULL UNIQUE,
  reverses_ledger_id uuid REFERENCES loyalty_ledger (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_loyalty_ledger_customer ON loyalty_ledger (customer_id, created_at);

CREATE TRIGGER trg_loyalty_ledger_append_only
  BEFORE UPDATE OR DELETE ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_change();

-- One active earning rule set per tenant in Phase 2.
CREATE TABLE loyalty_earning_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  points_per_pound     numeric(10, 4) NOT NULL CHECK (points_per_pound >= 0),
  category_multipliers jsonb NOT NULL DEFAULT '{}'::jsonb,
  minimum_spend_pence  bigint NOT NULL DEFAULT 0 CHECK (minimum_spend_pence >= 0),
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_loyalty_earning_rules_one_active
  ON loyalty_earning_rules (tenant_id) WHERE is_active;

-- Only if tiers are adopted (Arch-09 §3.5). Empty until the owner decides.
CREATE TABLE loyalty_tiers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  min_points bigint NOT NULL CHECK (min_points >= 0),
  multiplier numeric(5, 2) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Gift cards: bearer instruments. code_hash + code_last4 ONLY — the full
-- code is shown once at issue and never stored (Arch-09 §4.2).
CREATE TABLE gift_cards (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  code_hash             text NOT NULL,
  code_last4            char(4) NOT NULL,
  initial_amount_pence  bigint NOT NULL CHECK (initial_amount_pence > 0),
  balance_pence         bigint NOT NULL CHECK (balance_pence >= 0),
  currency              char(3) NOT NULL DEFAULT 'GBP',
  status                text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'redeemed', 'expired', 'void')),
  issued_at             timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code_hash)
);

CREATE TABLE gift_card_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  gift_card_id    uuid NOT NULL REFERENCES gift_cards (id),
  kind            text NOT NULL CHECK (kind IN ('issue', 'redeem', 'refund', 'correction', 'expiry')),
  amount_pence    bigint NOT NULL,
  order_id        uuid REFERENCES orders (id),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gift_card_ledger_card ON gift_card_ledger (gift_card_id, created_at);

CREATE TRIGGER trg_gift_card_ledger_append_only
  BEFORE UPDATE OR DELETE ON gift_card_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_change();

-- Store credit: per-customer (no store_credit_cards table — the balance is
-- per customer, not per instrument). Append-only.
CREATE TABLE store_credit_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  customer_id     uuid NOT NULL REFERENCES customers (id),
  kind            text NOT NULL CHECK (kind IN ('issue', 'redeem', 'refund', 'correction', 'expiry')),
  amount_pence    bigint NOT NULL,
  order_id        uuid REFERENCES orders (id),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_store_credit_ledger_customer ON store_credit_ledger (customer_id, created_at);

CREATE TRIGGER trg_store_credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON store_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_change();

COMMIT;
