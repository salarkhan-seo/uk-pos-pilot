-- 012_refund_retry_fields.sql — refund retry queue state (Build-03 Objective 2;
-- Arch-02 §6.4 step 4, D-09 Option C).
--
-- The `refunds` table (004) has NO metadata/notes column: the only text
-- column is `reason` (the refund's business reason), which must not be
-- overloaded with retry bookkeeping. The retry queue therefore needs its
-- own columns:
--   * retry_count     — provider attempts made for this refund (initial
--     provider call counts as attempt 1). After attempt 5 fails the
--     refund moves to `manual_escalation` (D-09 Option C).
--   * next_retry_at   — when the next queued attempt is due (exponential
--     backoff: 1m, 5m, 30m, 4h after attempts 1–4; NULL when not queued).
--   * failure_reason  — distinct machine-readable failure code, so
--     `insufficient_balance` (Arch-02 §6.4 step 6: never blindly retried,
--     routed to manual escalation with the top-up instruction) and
--     `refund_failed` (async `refund.failed`, G-A-18) are distinguishable
--     from `provider_unavailable` (retryable). Values used by the
--     application: 'provider_unavailable' | 'insufficient_balance' |
--     'refund_failed' | 'standalone_manual_refund' | NULL.
--
-- No new table is created, so the table count is unchanged.
-- The Kysely types for these columns live in a local type-extension file
-- (apps/api/src/modules/sales/refund-retry-schema.ts) — packages/db/src/
-- schema.ts is frozen for the Build-03 coordinator to merge.

ALTER TABLE refunds
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  ADD COLUMN next_retry_at timestamptz,
  ADD COLUMN failure_reason text;

CREATE INDEX idx_refunds_retry_due ON refunds (next_retry_at)
  WHERE status = 'pending' AND next_retry_at IS NOT NULL;
