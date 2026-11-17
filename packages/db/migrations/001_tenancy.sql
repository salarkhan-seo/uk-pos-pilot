-- =============================================================================
-- 001_tenancy.sql — Tenancy, locations, registers, users & roles (Arch-01 §2.1)
-- UK POS pilot, Build-01. Owner-approved decisions: D-02 Option A (narrow
-- single-site pilot), D-03 Option A (modular monolith + PostgreSQL).
--
-- Conventions for every migration in this directory:
--   * money is bigint pence, never float (D-13);
--   * timestamps are timestamptz; business dates are Europe/London;
--   * ids are uuid with gen_random_uuid() defaults (pgcrypto extension);
--   * tenant_id is on every tenant-scoped table (tenant isolation).
-- Migration order is by filename. Applied filenames are recorded in the
-- `migrations` table (see packages/db/src/migrate.ts).
-- =============================================================================

BEGIN;

-- No extension is needed for gen_random_uuid(): it is a core PostgreSQL
-- function since PG 13 (this pilot targets PG 16+). Build-01 listed
-- `CREATE EXTENSION pgcrypto` here, but PGlite does not bundle pgcrypto
-- and core gen_random_uuid() makes the extension unnecessary — removed in
-- Build-02 (Objective 1) after the migration run proved it. Real
-- PostgreSQL 13+ behaves the same way.

-- Migration tracking: one row per applied migration file.
CREATE TABLE IF NOT EXISTS migrations (
  id         serial PRIMARY KEY,
  filename   text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Shared trigger: append-only tables reject UPDATE and DELETE.
-- Attached in later migrations to: stock_movements, audit_events,
-- loyalty_ledger, gift_card_ledger, store_credit_ledger, marketing_consents.
CREATE OR REPLACE FUNCTION prevent_append_only_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Tenants. `status` carries the Arch-01 §4.1 exit state machine:
-- active -> termination_requested -> export_window -> hard_delete_scheduled
-- -> deleted. Termination is blocked (D-11 Option A) until open sessions
-- and pending/unknown payments are resolved — enforced by the application
-- in Build-02, not by a CHECK (the block depends on other tables).
-- `plan_tier` is a planning label only (Base / Plus, Arch-02 §4); prices
-- are NOT set here — D-16 is still open.
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  legal_name                text,
  trading_name              text,
  vat_registered            boolean NOT NULL DEFAULT false,
  vat_number                text,
  status                    text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'termination_requested', 'export_window', 'hard_delete_scheduled', 'deleted')),
  plan_tier                 text NOT NULL DEFAULT 'base'
    CHECK (plan_tier IN ('base', 'plus')),
  termination_requested_at  timestamptz,
  export_window_ends_at     timestamptz,
  hard_delete_scheduled_at  timestamptz,
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  address_line_1 text,
  address_line_2 text,
  town         text,
  postcode     text,
  country      text NOT NULL DEFAULT 'GB',
  timezone     text NOT NULL DEFAULT 'Europe/London',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_locations_tenant ON locations (tenant_id);

CREATE TABLE registers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  location_id       uuid NOT NULL REFERENCES locations (id),
  name              text NOT NULL,
  device_id         text,
  status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'lost')),
  last_heartbeat_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_registers_tenant ON registers (tenant_id);
CREATE INDEX idx_registers_location ON registers (location_id);

-- ---------------------------------------------------------------------------
-- Users, roles & permissions (Arch-01 §2.1, Arch-02 §4.2).
-- Roles are tenant-scoped; a user holds roles per location (user_roles).
-- Discount limits live on role_permissions (per-role, per-permission);
-- the pilot default must be set explicitly, never a permissive 100%.
-- Manager approval (requester <> approver) is enforced on approval_events
-- (migration 004). PIN is a till fast-login second factor, never the sole
-- admin credential — auth itself is Build-02.
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE role_permissions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id              uuid NOT NULL REFERENCES roles (id),
  permission           text NOT NULL,
  discount_limit_pence bigint CHECK (discount_limit_pence IS NULL OR discount_limit_pence >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text,
  -- Till PIN hash for manager approvals (Build-02, Objective 2): salted
  -- scrypt hash, format `scrypt$v1$<salt hex>$<hash hex>` (see
  -- packages/shared-kernel/src/pin.ts). A PIN is a second factor for till
  -- approvals, never the sole admin credential.
  pin_hash     text,
  status        text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- A user holds a role at a location (roles are location-scoped, Arch-01 §2.1).
-- A tenant-wide role is represented by one row per location the user works at.
CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  role_id     uuid NOT NULL REFERENCES roles (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, location_id)
);

CREATE TABLE user_locations (
  user_id     uuid NOT NULL REFERENCES users (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location_id)
);

COMMIT;
