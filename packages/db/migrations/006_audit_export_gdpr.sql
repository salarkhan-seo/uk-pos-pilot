-- =============================================================================
-- 006_audit_export_gdpr.sql — Audit trail, export module, GDPR retention
-- (Arch-01 §2.7, §4, §6).
--
--   * audit_events is append-only (trigger) and hash-chained: prev_hash /
--     event_hash, chain = sha256(prev_hash + canonical JSON of the event).
--     The chain is computed by the shared kernel (packages/shared-kernel).
--   * export is a single-click, 30-day window, one file per table (CSV +
--     JSON) with a manifest carrying row counts and SHA-256 checksums
--     (Arch-01 §4.3). Free and unlimited — stated in the merchant agreement,
--     not enforced by a fee column here (there is no export-fee field).
--   * deletion is automated hard deletion with row-count verification;
--     only a tombstone (id + deleted_at) survives. The 30-day deletion
--     window and the 6-year VAT statutory archive are in tension by design:
--     the archive holds ONLY the VAT record and the sales record needed to
--     rebuild it — no customer personal data beyond the VAT record
--     (Arch-01 §6.3). The exact retention period is a V-04 tax-advice
--     question, not a value set here.
-- =============================================================================

BEGIN;

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  user_id      uuid REFERENCES users (id),
  event_type   text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash    text NOT NULL,
  event_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_events_tenant ON audit_events (tenant_id, created_at);
CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id);

CREATE TRIGGER trg_audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_change();

CREATE TABLE export_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_by_user_id uuid REFERENCES users (id),
  file_count          int NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  total_rows          bigint NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX idx_export_jobs_tenant ON export_jobs (tenant_id, created_at);

CREATE TABLE export_manifests (
  export_job_id   uuid NOT NULL REFERENCES export_jobs (id),
  file_name       text NOT NULL,
  table_name      text NOT NULL,
  row_count       bigint NOT NULL CHECK (row_count >= 0),
  sha256_checksum char(64) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (export_job_id, file_name)
);

-- The 30-day read-only export window (Arch-01 §4.1). The dashboard is
-- read-only during the window; the export does not end the window early.
CREATE TABLE tenant_export_windows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_ends_at   timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'expired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, window_started_at)
);

CREATE TABLE data_retention_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  table_name     text NOT NULL,
  retention_days int NOT NULL CHECK (retention_days >= 0),
  archive_table  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, table_name)
);

-- Automated hard deletion jobs. A non-zero row count after deletion means
-- the job FAILED and is escalated (Arch-01 §6.2).
CREATE TABLE deletion_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  status               text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_by_user_id uuid REFERENCES users (id),
  started_at           timestamptz,
  completed_at         timestamptz,
  verified_row_count   int CHECK (verified_row_count IS NULL OR verified_row_count >= 0),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_deletion_jobs_tenant ON deletion_jobs (tenant_id, created_at);

COMMIT;
