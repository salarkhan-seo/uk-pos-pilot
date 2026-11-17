-- =============================================================================
-- 014_statutory_vat_archives_and_webhook_rotation.sql — Statutory VAT
-- archive persistence + webhook secret rotation + VAT-period close
-- columns (Build-05 Objectives 1–2).
--
-- MIGRATION NUMBER CORRECTION (Build-05 handover): the commission names
-- this file "Migration 011 (011_statutory_vat_archives_and_webhook_
-- rotation.sql)", but 011 already exists (011_webhook_events_dlq.sql,
-- Build-03) and migrations 001–013 are all applied. This file is
-- therefore 014, the next free number. Nothing in 011 is overwritten.
--
--   * vat_periods: closed_at / closed_by_user_id — the columns the
--     in-place closeVatPeriod(:id) fix needs (migration 005 created the
--     table without them; the Build-04 controller bridge deleted the
--     open row and created a new one instead).
--   * webhook_endpoints: previous_secret_hash / previous_secret_expires_at
--     — the commission names the table "webhook_subscriptions"; the
--     table that actually exists (migration 011) is webhook_endpoints,
--     so the columns land there. The raw previous secret is never
--     stored, only its SHA-256 hash (same rule as secret_hash).
--   * statutory_vat_archives: the append-only 6-year statutory VAT
--     archive (Arch-01 §6.4). tenant_id carries NO foreign key: the
--     archive must survive the tenant row's hard deletion, so it
--     references the tenant id only as a plain uuid. retention_until is
--     6 years from the archive date (VAT Notice 700/21). The
--     immutability trigger blocks UPDATE always and DELETE while the
--     retention window is still open; an explicit purge function
--     deletes only rows whose retention has expired
--     (NOW() >= retention_until).
-- =============================================================================

BEGIN;

ALTER TABLE vat_periods
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by_user_id uuid REFERENCES users (id);

ALTER TABLE webhook_endpoints
  ADD COLUMN previous_secret_hash text,
  ADD COLUMN previous_secret_expires_at timestamptz;

CREATE TABLE statutory_vat_archives (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  archived_at          timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL,
  archive_sha256       char(64) NOT NULL,
  row_counts_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  archive_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_bundle_path  text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_until > archived_at)
);
CREATE INDEX idx_statutory_vat_archives_tenant ON statutory_vat_archives (tenant_id, archived_at DESC);
CREATE INDEX idx_statutory_vat_archives_retention ON statutory_vat_archives (retention_until);

CREATE OR REPLACE FUNCTION prevent_statutory_archive_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Statutory VAT archive % is immutable', OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.retention_until > now() THEN
      RAISE EXCEPTION 'Statutory VAT archive % is within its 6-year retention window (until %)', OLD.id, OLD.retention_until;
    END IF;
    RETURN OLD;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_statutory_vat_archives_immutable
  BEFORE UPDATE OR DELETE ON statutory_vat_archives
  FOR EACH ROW EXECUTE FUNCTION prevent_statutory_archive_change();

-- Explicit expiry purge: deletes ONLY archives whose retention has
-- expired (NOW() >= retention_until). The trigger above permits exactly
-- those deletes and blocks every other DELETE, so the purge cannot be
-- used to drop a live archive. Returns the purged archive ids.
CREATE OR REPLACE FUNCTION purge_expired_statutory_vat_archives()
  RETURNS TABLE (id uuid)
  LANGUAGE sql AS $$
    DELETE FROM statutory_vat_archives
    WHERE retention_until <= now()
    RETURNING statutory_vat_archives.id;
  $$;

COMMIT;
