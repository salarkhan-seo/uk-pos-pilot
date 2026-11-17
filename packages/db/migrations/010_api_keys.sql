-- =============================================================================
-- 010_api_keys.sql — hashed, scoped API keys (Build-03 Objective 1;
-- Arch-02 §4.2–§4.3).
--
-- Rules:
--   * Keys are generated server-side, shown ONCE at creation, and stored
--     as a SHA-256 hash only — the full key is never stored (same pattern
--     as gift/voucher code_hash in migrations 007/008).
--   * key_prefix is the first 8 characters of the full key, for
--     identification in the dashboard/logs only; it cannot authenticate.
--   * status 'rotating' + grace_until implements the 24-hour rotation
--     grace period (Arch-02 §4.2): the old key stays valid until
--     grace_until, then it is treated as revoked. The application (not
--     a trigger) enforces the grace expiry, because "now" is evaluated
--     at verification time.
--   * expires_at is an optional hard expiry; last_used_at is updated on
--     each successful verification.
--   * Scopes are the Arch-02 §4.3 list (catalogue:read/write,
--     sales:read/write, stock:read/write, payments:read, accounting:read,
--     admin). 'admin' implies every scope (see apps/api/src/common/
--     scopes.ts). Scope values are validated by the application; the
--     column is text[] so a future scope can be added without a DDL
--     change.
-- =============================================================================

BEGIN;

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  name         text,
  scopes       text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotating', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  grace_until  timestamptz
);
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);
CREATE INDEX idx_api_keys_prefix ON api_keys (tenant_id, key_prefix);

COMMIT;
