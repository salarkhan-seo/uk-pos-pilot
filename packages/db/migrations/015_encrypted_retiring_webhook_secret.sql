-- =============================================================================
-- 015_encrypted_retiring_webhook_secret.sql — Persistent AES-256-GCM
-- webhook secret rotation (Build-06 Objective 1).
--
-- TABLE NAME NOTE: the commission names the table
-- "webhook_subscriptions"; the table that actually exists (migration
-- 011, extended by 014) is webhook_endpoints, so the column lands
-- there — same correction as migration 014.
--
--   * webhook_endpoints.previous_secret_ciphertext (text, nullable):
--     the retiring signing secret, encrypted at rest with AES-256-GCM
--     under the WEBHOOK_ENCRYPTION_KEY master key (see
--     apps/api/src/modules/integrations/webhook-secret-cipher.ts).
--     Build-05 stored only previous_secret_hash / previous_secret_
--     expires_at and kept the retiring RAW secret in the
--     WebhookService process-memory map, so dual-signing died on
--     restart. With this column, a fresh WebhookService instance can
--     decrypt the retiring secret from the database and keep emitting
--     X-Webhook-Signature-Previous for the whole grace window.
--     NULL when no rotation is in progress (or when the rotation
--     happened while the previous raw secret was not held in memory —
--     a secret lost before rotation cannot be recovered).
--     The value is an envelope `v1:<keyId>:<base64(iv || tag || ct)>`;
--     it is never a plaintext secret and never the hash.
-- =============================================================================

BEGIN;

ALTER TABLE webhook_endpoints
  ADD COLUMN previous_secret_ciphertext text;

COMMIT;
