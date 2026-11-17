-- =============================================================================
-- 016_webhook_current_secret_encryption_and_keyring.sql — Current
-- webhook secret encryption at rest & master-key keyring (Build-07
-- Objective 1).
--
-- Build-06 (migration 015) encrypted only the RETIRING secret
-- (previous_secret_ciphertext); the CURRENT signing secret was still
-- memory-only — a process restart lost it until the operator
-- re-provisioned it via POST /v1/webhooks/endpoints/:id/secret.
-- This migration closes that gap:
--
--   * webhook_endpoints.current_secret_ciphertext (text, nullable):
--     the CURRENT signing secret, encrypted at rest with AES-256-GCM
--     under the active master key (see
--     apps/api/src/modules/integrations/webhook-secret-cipher.ts).
--     Written at registration and at every rotation, so a fresh
--     WebhookService instance can decrypt it from the database and
--     sign immediately — no re-provisioning, no rotation first.
--     NULL only for legacy rows created before Build-07 (those
--     endpoints still need re-provisioning after a restart — the
--     pre-Build-07 behaviour, now the exception, not the rule).
--     The value is an envelope `v1:<keyId>:<base64(iv || tag || ct)>`;
--     it is never a plaintext secret and never the hash.
--
--   * webhook_endpoints.encryption_key_id (text, NOT NULL
--     DEFAULT 'v1'): the master key id that encrypted
--     current_secret_ciphertext at the most recent write. The default
--     'v1' is the pre-keyring placeholder for rows written before
--     Build-07 (the commission-mandated default); every Build-07
--     write stores the real active key id (e.g. 'k1'). The envelope
--     itself also carries its key id, so decryption never depends on
--     this column — it is a record for operators and the
--     re-encryption endpoint. previous_secret_ciphertext keeps its
--     own envelope key id (rotation may COPY the old current
--     ciphertext into the previous slot, so the two slots can
--     legitimately differ).
-- =============================================================================

BEGIN;

ALTER TABLE webhook_endpoints
  ADD COLUMN current_secret_ciphertext text,
  ADD COLUMN encryption_key_id text NOT NULL DEFAULT 'v1';

COMMIT;
