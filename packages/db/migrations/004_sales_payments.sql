-- =============================================================================
-- 004_sales_payments.sql — Sales & payments (Arch-01 §2.5; Arch-02 §6;
-- Arch-10 §2 for the order_lines price columns).
--
-- Invariants (package §9):
--   * completed orders are IMMUTABLE — UPDATE/DELETE on a completed order
--     raises (trigger below). Corrections are separate entries, never edits.
--   * tax is snapshotted per line at sale (tax_rate_kind + tax_rate_percent
--     + tax_amount_pence on the line; a rate change never rewrites history).
--   * basket discounts are allocated pro-rata by line total (D-14) and the
--     allocation is stored on the line (promotion/manual discount columns).
--   * money is integer pence (bigint); rounding is per line round-half-up
--     then sum (D-13) — computed by the shared kernel, stored here.
--   * a payment attempt has a unique idempotency_key and states
--     created/pending/approved/declined/unknown/refunded; `unknown` is
--     first-class (W-12) and an order is never marked paid without
--     provider evidence.
--   * age_verification_events store the VERIFIED AGE, never a date of birth.
--   * approval_events enforce requester <> approver (CHECK below).
--   * offline_payment_records is the Arch-01 §5.2 schema for offline card.
--     OFFLINE CARD IS FEATURE-DISABLED in this pilot (D-06 Option B):
--     the table exists so the design is not lost, but NO offline-card logic
--     is built in Build-01 and the table must stay empty until D-06 is
--     re-decided with written provider terms and V-04 legal review.
--
-- Forward references resolved here: stock_movements.order_id and
-- serial_numbers.order_id get their foreign keys now that orders exist.
-- customers do not exist until migration 007, so orders.customer_id has no
-- foreign key yet — it is added there.
-- =============================================================================

BEGIN;

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  location_id        uuid NOT NULL REFERENCES locations (id),
  register_id        uuid REFERENCES registers (id),
  customer_id        uuid,
  order_number       bigint NOT NULL,
  business_date      date NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_payment', 'completed', 'voided', 'partially_returned', 'returned')),
  subtotal_pence     bigint NOT NULL DEFAULT 0 CHECK (subtotal_pence >= 0),
  discount_pence     bigint NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  tax_pence          bigint NOT NULL DEFAULT 0 CHECK (tax_pence >= 0),
  total_pence        bigint NOT NULL DEFAULT 0 CHECK (total_pence >= 0),
  created_by_user_id uuid REFERENCES users (id),
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id, order_number)
);
CREATE INDEX idx_orders_tenant ON orders (tenant_id, business_date);
CREATE INDEX idx_orders_register ON orders (register_id, business_date);

-- Completed orders are immutable (package §9 invariant 4).
CREATE OR REPLACE FUNCTION prevent_completed_order_change() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'Completed order % is immutable', OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_completed_immutable
  BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION prevent_completed_order_change();

-- Order lines. Price pipeline (Arch-10 §2.1):
-- base variant price -> price book -> automatic promotions -> voucher ->
-- manual discount -> tax and margin. Every step is stored, so a discounted
-- price is always explainable (Z-report, VAT return, returns).
-- price_book_id's foreign key is added in migration 008 (price_books).
CREATE TABLE order_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  order_id                uuid NOT NULL REFERENCES orders (id),
  variant_id              uuid NOT NULL REFERENCES product_variants (id),
  quantity                bigint NOT NULL CHECK (quantity > 0),
  unit_price_pence        bigint NOT NULL CHECK (unit_price_pence >= 0),
  base_price_pence        bigint NOT NULL CHECK (base_price_pence >= 0),
  price_book_id           uuid,
  price_book_price_pence  bigint CHECK (price_book_price_pence IS NULL OR price_book_price_pence >= 0),
  promotion_discount_pence bigint NOT NULL DEFAULT 0 CHECK (promotion_discount_pence >= 0),
  manual_discount_pence   bigint NOT NULL DEFAULT 0 CHECK (manual_discount_pence >= 0),
  final_price_pence       bigint NOT NULL CHECK (final_price_pence >= 0),
  tax_rate_kind           text NOT NULL CHECK (tax_rate_kind IN ('standard', 'reduced', 'zero', 'exempt')),
  tax_rate_percent        numeric(5, 2) NOT NULL CHECK (tax_rate_percent >= 0),
  tax_amount_pence        bigint NOT NULL DEFAULT 0 CHECK (tax_amount_pence >= 0),
  line_total_pence        bigint NOT NULL CHECK (line_total_pence >= 0),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_lines_order ON order_lines (order_id);

-- Payment attempts (Arch-02 §6.1). idempotency_key is globally unique:
-- the same key returns the original attempt, never a second charge.
-- provider_reference is NULL until the provider returns one (offline
-- PaymentIntents have a null id until forwarded — D-06 deferred).
-- Defined BEFORE order_tenders: order_tenders references payment_attempts.
CREATE TABLE payment_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  order_id           uuid NOT NULL REFERENCES orders (id),
  idempotency_key    text NOT NULL UNIQUE,
  provider           text NOT NULL CHECK (provider IN ('stripe', 'sumup', 'standalone')),
  provider_reference text,
  status             text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'approved', 'declined', 'unknown', 'refunded')),
  amount_pence       bigint NOT NULL CHECK (amount_pence > 0),
  currency           char(3) NOT NULL DEFAULT 'GBP',
  attempt_number     int NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_attempts_order ON payment_attempts (order_id);
CREATE INDEX idx_payment_attempts_status ON payment_attempts (tenant_id, status);

-- Tenders (W-09 split tender). An order completes only when the tenders
-- sum to the total. Each card tender has its own payment attempt.
CREATE TABLE order_tenders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  order_id           uuid NOT NULL REFERENCES orders (id),
  tender_type        text NOT NULL CHECK (tender_type IN ('cash', 'card', 'store_credit', 'gift_card', 'loyalty_points')),
  amount_pence       bigint NOT NULL CHECK (amount_pence > 0),
  payment_attempt_id uuid REFERENCES payment_attempts (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_tenders_order ON order_tenders (order_id);

-- Refunds (W-11, D-09 Option C: queue for retry, then manual manager
-- escalation). A refund references the original sale; restock is explicit,
-- never automatic for damaged goods; a refund above the original is
-- blocked by the application (Build-02).
CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  order_id           uuid NOT NULL REFERENCES orders (id),
  payment_attempt_id uuid REFERENCES payment_attempts (id),
  idempotency_key    text NOT NULL UNIQUE,
  amount_pence       bigint NOT NULL CHECK (amount_pence > 0),
  reason             text,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'manual_escalation')),
  provider_reference text,
  created_by_user_id uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refunds_order ON refunds (order_id);

CREATE TABLE receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  location_id    uuid NOT NULL REFERENCES locations (id),
  order_id       uuid NOT NULL REFERENCES orders (id),
  receipt_number bigint NOT NULL,
  -- A till receipt is NOT a VAT invoice (package §11 / Arch-01 §3.2):
  -- the notice is stored on every receipt and printed on it, so a receipt
  -- can never be mistaken for a VAT invoice. (Build-02 fix.)
  vat_invoice_notice text NOT NULL DEFAULT 'This is not a VAT invoice',
  issued_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, location_id, receipt_number),
  UNIQUE (order_id)
);

-- Per-rate VAT breakdown on the receipt, by construction (Arch-01 §3.2).
CREATE TABLE receipt_vat_lines (
  receipt_id       uuid NOT NULL REFERENCES receipts (id),
  tax_rate_kind    text NOT NULL CHECK (tax_rate_kind IN ('standard', 'reduced', 'zero', 'exempt')),
  tax_rate_percent numeric(5, 2) NOT NULL CHECK (tax_rate_percent >= 0),
  gross_pence      bigint NOT NULL CHECK (gross_pence >= 0),
  vat_pence        bigint NOT NULL CHECK (vat_pence >= 0),
  net_pence        bigint NOT NULL CHECK (net_pence >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receipt_id, tax_rate_kind)
);

-- Age verification events. Stores the VERIFIED AGE (e.g. 19), never a
-- date of birth (Arch-01 §2.5, GDPR minimisation). A refusal is also
-- recorded (the item is removed from the sale).
CREATE TABLE age_verification_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  order_id           uuid NOT NULL REFERENCES orders (id),
  variant_id         uuid NOT NULL REFERENCES product_variants (id),
  verified_age_years int NOT NULL CHECK (verified_age_years > 0),
  method             text NOT NULL CHECK (method IN ('manual_confirmation', 'dob_entry')),
  outcome            text NOT NULL DEFAULT 'verified'
    CHECK (outcome IN ('verified', 'refused')),
  verified_by_user_id uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_age_events_order ON age_verification_events (order_id);

-- Manager approvals as first-class events (Arch-01 §2.5, Arch-04 §2.8).
-- The approver must hold a manager role at that location and must not be
-- the requester — the CHECK below enforces the second rule in the database.
CREATE TABLE approval_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  order_id            uuid REFERENCES orders (id),
  action              text NOT NULL,
  amount_pence        bigint CHECK (amount_pence IS NULL OR amount_pence >= 0),
  reason              text,
  requested_by_user_id uuid NOT NULL REFERENCES users (id),
  approved_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by_user_id <> approved_by_user_id)
);
CREATE INDEX idx_approval_events_order ON approval_events (order_id);

-- Offline card payment records (Arch-01 §5.2). OFFLINE CARD IS DISABLED
-- (D-06 Option B). This table exists as schema only: no offline-card logic
-- is built in Build-01, no row should be written until D-06 is re-decided
-- with written provider terms (max forwarding deadline, device-loss
-- handling) and V-04 legal review of the Arch-03 §5 warning. Card data
-- never enters this table — only provider references, amounts and statuses.
CREATE TABLE offline_payment_records (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants (id),
  order_id                    uuid REFERENCES orders (id),
  local_id                    uuid NOT NULL UNIQUE,
  amount_pence                bigint NOT NULL CHECK (amount_pence > 0),
  currency                    char(3) NOT NULL DEFAULT 'GBP',
  status                      text NOT NULL DEFAULT 'pending_forward'
    CHECK (status IN ('pending_forward', 'forwarded', 'declined_after_forward', 'lost')),
  stripe_payment_intent_id    text,
  reader_id                   text,
  location_id                 uuid NOT NULL REFERENCES locations (id),
  offline_created_at          timestamptz NOT NULL DEFAULT now(),
  forwarded_at                timestamptz,
  idempotency_key             text NOT NULL UNIQUE,
  reader_software_version     text,
  connection_token_age_hours  int CHECK (connection_token_age_hours IS NULL OR connection_token_age_hours >= 0),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE offline_payment_records IS
  'Arch-01 §5.2 schema for offline card payments. FEATURE-DISABLED (D-06 Option B): must stay empty until D-06 is re-decided with written provider terms and V-04 legal review. No offline-card logic exists in Build-01.';

-- Forward references from migration 003, resolved now that orders exist.
ALTER TABLE stock_movements
  ADD CONSTRAINT fk_stock_movements_order FOREIGN KEY (order_id) REFERENCES orders (id);

ALTER TABLE serial_numbers ADD COLUMN order_id uuid;
ALTER TABLE serial_numbers
  ADD CONSTRAINT fk_serial_numbers_order FOREIGN KEY (order_id) REFERENCES orders (id);

COMMIT;
