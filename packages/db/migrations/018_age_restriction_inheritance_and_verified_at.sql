-- =============================================================================
-- 018_age_restriction_inheritance_and_verified_at.sql — First-class
-- product-level age restrictions & client verified_at persistence
-- (Build-11 Objective 2).
--
-- 1. age_restrictions gains a stored product-level rule:
--      * product_id (nullable, REFERENCES products) — a product-level
--        row has product_id set and variant_id NULL, so a rule can be
--        stored on a variant-less product (Build-09's "Product has no
--        variants: create a variant first" 400 is gone).
--      * variant_id relaxes from NOT NULL to nullable.
--      * rule_source ('explicit' | 'inherited', default 'explicit'):
--        a variant row created by product-level propagation is
--        'inherited'; a merchant-set row (variant target, nested on
--        variant creation) is 'explicit'. Product-level rows always
--        carry 'explicit' (they ARE the merchant's explicit rule).
--    Constraint set (replaces UNIQUE (variant_id) from migration 002):
--      * age_restrictions_one_of_product_or_variant — CHECK that
--        exactly one of product_id / variant_id is set (XOR).
--      * uq_age_restrictions_product_level — partial unique index on
--        (product_id) WHERE variant_id IS NULL: at most one
--        product-level row per product.
--      * uq_age_restrictions_variant — partial unique index on
--        (variant_id) WHERE variant_id IS NOT NULL: at most one row
--        per variant. (Partial indexes are used because a plain
--        UNIQUE (variant_id) would not constrain NULLs and a plain
--        UNIQUE (product_id, variant_id) would allow two product rows
--        — Postgres treats NULLs as distinct in unique constraints.
--        ON CONFLICT upserts must carry the matching WHERE predicate
--        or Postgres cannot infer the partial index.)
--    This SUPERSEDES Build-10 Objective 3's derived inference (a rule
--    was product-level when every pre-existing variant carried an
--    identical restriction): the stored product-level row is now the
--    authoritative source of truth, and the derived inference is
--    removed from CatalogueService.
--
-- 2. age_verification_events gains verified_at (timestamptz, NOT NULL
--    DEFAULT now()): the actual till verification timestamp supplied
--    by the client, preserved even when an offline sale is flushed
--    hours later. Rows recorded before this migration (and rows where
--    the client supplies no verified_at) take the default — the
--    server record time. GET
--    /v1/sales/orders/:id/age-verifications now returns BOTH
--    verified_at (client till timestamp) and created_at (server
--    record time); previously it returned created_at as verified_at.
-- =============================================================================

BEGIN;

ALTER TABLE age_restrictions ALTER COLUMN variant_id DROP NOT NULL;
ALTER TABLE age_restrictions ADD COLUMN product_id uuid REFERENCES products (id);
ALTER TABLE age_restrictions ADD COLUMN rule_source text NOT NULL DEFAULT 'explicit'
  CHECK (rule_source IN ('explicit', 'inherited'));
ALTER TABLE age_restrictions DROP CONSTRAINT age_restrictions_variant_id_key;
ALTER TABLE age_restrictions ADD CONSTRAINT age_restrictions_one_of_product_or_variant
  CHECK ((product_id IS NULL) <> (variant_id IS NULL));
CREATE UNIQUE INDEX uq_age_restrictions_product_level
  ON age_restrictions (product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX uq_age_restrictions_variant
  ON age_restrictions (variant_id) WHERE variant_id IS NOT NULL;

ALTER TABLE age_verification_events ADD COLUMN verified_at timestamptz NOT NULL DEFAULT now();

COMMIT;
