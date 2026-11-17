-- =============================================================================
-- 011_webhook_events_dlq.sql — Outbound webhooks, event log & dead-letter
-- queue (Arch-02 §3; Build-03 Objective 4).
--
--   * webhook_endpoints: one row per subscriber endpoint. The secret is
--     stored HASHED (secret_hash = sha256 of the server-generated secret,
--     shown once at registration); the raw secret is never persisted.
--     HTTPS only is enforced by the application at registration
--     (Arch-02 §3.3) — the URL column itself carries no scheme check so
--     a future non-HTTPS test double is not a schema change.
--   * webhook_events: the append-only event log (the Events API source,
--     Arch-02 §3.5). `sequence` is a per-tenant monotonic sequence
--     (unique on (tenant_id, sequence)); the application assigns it
--     under a per-tenant advisory lock. `payload` carries references
--     and amounts only — never PAN, full gift/voucher codes, or
--     customer PII (Arch-02 §3.2 rule, enforced by the service).
--   * webhook_deliveries: one row per (event, endpoint) delivery.
--     status: pending (awaiting first or next retry), delivered,
--     failed (terminal 3xx/4xx — never retried, Arch-02 §3.4),
--     dead_letter (attempt 11 failed; held 30 days, replayable or
--     explicitly discardable, never auto-deleted — Arch-02 §3.4).
--     Retry delays are 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 16h, 24h
--     (10 retries; attempt 11 is the last).
--
-- No new dependency. Types for these tables live in
-- packages/db/src/webhook-schema.ts (schema.ts is frozen for the
-- coordinator to merge — see that file's header).
-- =============================================================================

BEGIN;

CREATE TABLE webhook_endpoints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  url          text NOT NULL,
  secret_hash  text NOT NULL,
  event_types  text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_endpoints_tenant ON webhook_endpoints (tenant_id, status);

CREATE TABLE webhook_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  event_type text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  sequence   bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sequence)
);
CREATE INDEX idx_webhook_events_tenant_created ON webhook_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX idx_webhook_events_type ON webhook_events (tenant_id, event_type, created_at DESC);

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  event_id         uuid NOT NULL REFERENCES webhook_events (id),
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints (id),
  status           text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempt_count    int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at  timestamptz,
  last_status_code int,
  last_error       text,
  dlq_entered_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_event ON webhook_deliveries (event_id);
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC);

COMMIT;
