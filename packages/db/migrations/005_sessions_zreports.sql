-- =============================================================================
-- 005_sessions_zreports.sql — Register sessions, cash movements, Z-reports,
-- VAT periods (Arch-01 §2.6 and §3).
--
-- Rules:
--   * a Z-report is a FIRST-CLASS IMMUTABLE entity: one per register per
--     business date, sequential z_number per register with no gaps and
--     never reused (D-15 Option A); once issued it cannot be updated or
--     deleted — corrections are separate rows in z_report_corrections.
--   * End vs Close are distinct (Arch-01 §2.6, T-07 §7.3): Ending a session
--     records the expected cash; Closing records the counted cash, the
--     variance and issues the Z-report.
--   * till close is BLOCKED while card payments are pending (W-13) —
--     enforced by the application in Build-02.
--   * variance above the higher of £10 or 2% of expected cash needs manager
--     approval + a reason (D-08 Option C) — the threshold is a policy
--     value, applied by the application; the Z-report stores the variance.
--   * cash variance is never netted: it is a separately identified line.
--   * one Z-report = one accounting posting batch (Arch-02 §5.1).
-- =============================================================================

BEGIN;

CREATE TABLE register_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  register_id          uuid NOT NULL REFERENCES registers (id),
  opened_by_user_id    uuid REFERENCES users (id),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  float_pence          bigint NOT NULL DEFAULT 0 CHECK (float_pence >= 0),
  status               text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'ended', 'closed')),
  ended_at             timestamptz,
  closed_at            timestamptz,
  closed_by_user_id    uuid REFERENCES users (id),
  expected_cash_pence  bigint CHECK (expected_cash_pence IS NULL OR expected_cash_pence >= 0),
  counted_cash_pence   bigint CHECK (counted_cash_pence IS NULL OR counted_cash_pence >= 0),
  variance_pence       bigint,
  variance_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_register ON register_sessions (register_id, opened_at);
CREATE INDEX idx_sessions_tenant ON register_sessions (tenant_id, status);

-- Typed cash movements (Arch-01 §2.6): Cash in/out, Petty cash in/out,
-- Paid In/Out — each with an amount and a note.
CREATE TABLE cash_movements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  session_id         uuid NOT NULL REFERENCES register_sessions (id),
  type               text NOT NULL CHECK (type IN ('cash_in', 'cash_out', 'petty_cash_in', 'petty_cash_out', 'paid_in', 'paid_out')),
  amount_pence       bigint NOT NULL CHECK (amount_pence > 0),
  note               text,
  created_by_user_id uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cash_movements_session ON cash_movements (session_id);

-- Z-reports. z_number is sequential per register (D-15); the application
-- allocates it inside the close transaction (no gaps, never reused).
CREATE TABLE z_reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  register_id          uuid NOT NULL REFERENCES registers (id),
  session_id           uuid NOT NULL REFERENCES register_sessions (id),
  z_number             bigint NOT NULL,
  business_date        date NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued')),
  issued_at            timestamptz,
  gross_pence          bigint NOT NULL DEFAULT 0 CHECK (gross_pence >= 0),
  net_pence            bigint NOT NULL DEFAULT 0 CHECK (net_pence >= 0),
  vat_pence            bigint NOT NULL DEFAULT 0 CHECK (vat_pence >= 0),
  discount_pence       bigint NOT NULL DEFAULT 0 CHECK (discount_pence >= 0),
  refund_pence         bigint NOT NULL DEFAULT 0 CHECK (refund_pence >= 0),
  cash_expected_pence  bigint CHECK (cash_expected_pence IS NULL OR cash_expected_pence >= 0),
  cash_counted_pence   bigint CHECK (cash_counted_pence IS NULL OR cash_counted_pence >= 0),
  cash_variance_pence  bigint,
  order_count          int NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  void_count           int NOT NULL DEFAULT 0 CHECK (void_count >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (register_id, z_number),
  UNIQUE (session_id)
);
CREATE INDEX idx_z_reports_register ON z_reports (register_id, business_date);

-- An issued Z-report is immutable; corrections are separate linked rows.
CREATE OR REPLACE FUNCTION prevent_issued_zreport_change() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    RAISE EXCEPTION 'Issued Z-report % is immutable', OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_z_reports_issued_immutable
  BEFORE UPDATE OR DELETE ON z_reports
  FOR EACH ROW EXECUTE FUNCTION prevent_issued_zreport_change();

CREATE TABLE z_report_vat_lines (
  z_report_id      uuid NOT NULL REFERENCES z_reports (id),
  tax_rate_kind    text NOT NULL CHECK (tax_rate_kind IN ('standard', 'reduced', 'zero', 'exempt')),
  tax_rate_percent numeric(5, 2) NOT NULL CHECK (tax_rate_percent >= 0),
  gross_pence      bigint NOT NULL CHECK (gross_pence >= 0),
  vat_pence        bigint NOT NULL CHECK (vat_pence >= 0),
  net_pence        bigint NOT NULL CHECK (net_pence >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (z_report_id, tax_rate_kind)
);

CREATE TABLE z_report_tender_lines (
  z_report_id       uuid NOT NULL REFERENCES z_reports (id),
  tender_type       text NOT NULL CHECK (tender_type IN ('cash', 'card', 'store_credit', 'gift_card', 'loyalty_points')),
  amount_pence      bigint NOT NULL CHECK (amount_pence >= 0),
  transaction_count int NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (z_report_id, tender_type)
);

-- Corrections to an issued Z-report are separate linked entries, never
-- edits to the Z-report itself (Arch-01 §3.1).
CREATE TABLE z_report_corrections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  z_report_id         uuid NOT NULL REFERENCES z_reports (id),
  correction_type     text NOT NULL,
  amount_pence        bigint NOT NULL,
  reason              text NOT NULL,
  corrected_by_user_id uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_z_corrections ON z_report_corrections (z_report_id);

-- VAT periods and the VAT return export (Arch-01 §3.3).
-- Re-running an export for the same period must produce an identical file
-- (W-17); corrections are separate entries.
CREATE TABLE vat_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  status       text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'exported')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, period_end),
  CHECK (period_end >= period_start)
);

CREATE TABLE vat_period_lines (
  vat_period_id    uuid NOT NULL REFERENCES vat_periods (id),
  tax_rate_kind    text NOT NULL CHECK (tax_rate_kind IN ('standard', 'reduced', 'zero', 'exempt')),
  tax_rate_percent numeric(5, 2) NOT NULL CHECK (tax_rate_percent >= 0),
  gross_pence      bigint NOT NULL CHECK (gross_pence >= 0),
  vat_pence        bigint NOT NULL CHECK (vat_pence >= 0),
  net_pence        bigint NOT NULL CHECK (net_pence >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vat_period_id, tax_rate_kind)
);

CREATE TABLE vat_return_exports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  vat_period_id     uuid NOT NULL REFERENCES vat_periods (id),
  file_name         text NOT NULL,
  sha256_checksum   char(64) NOT NULL,
  exported_by_user_id uuid REFERENCES users (id),
  exported_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMIT;
