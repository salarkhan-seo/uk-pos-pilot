#!/usr/bin/env bash
# UK POS pilot — staging check (Build-12 staging pack).
#
# Applies all 19 PostgreSQL migrations to the cloud Postgres database
# named by DATABASE_URL, then runs the live multi-connection G-A-13
# concurrency check against it. Run from the repo root, or anywhere —
# the script cds to the repo root first.
#
#   DATABASE_URL=<redacted> pnpm staging:check
#   # or: DATABASE_URL=<redacted> bash scripts/staging-check.sh
#
# HOW THE MIGRATIONS RUN — read before changing this script:
# There is NO standalone `migrate` script in this repo. applyMigrations
# (packages/db/src/migrate.ts) is a library function only; its
# DATABASE_URL-backed invocations are (a) inside packages/db/src/
# pg-concurrency-check.ts, exposed as `pnpm --filter @uk-pos/db
# concurrency:live`, and (b) the API itself on boot since Build-13
# (apps/api/src/database/database.module.ts — createApiDatabase applies
# pending migrations after createPgDb). That command applies every
# not-yet-applied migration to DATABASE_URL FIRST
# (pg-concurrency-check.ts:327), then runs the live G-A-13 check. It
# refuses to fall back to PGlite: with DATABASE_URL unset it exits 1
# with a clear message. This script therefore uses that one repo
# command for the migration step and prints the same command below for
# standalone re-runs of G-A-13. If a dedicated migration CLI lands
# later, point step (b) at it instead.
#
# Since Build-13 the API itself also connects to DATABASE_URL on boot
# (real `pg` pool, pending migrations applied). This script still
# verifies the cloud database + live G-A-13 independently of the API.
set -euo pipefail

# Repo root = parent of this script's directory.
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Set it to the cloud Postgres connection string first, e.g.:" >&2
  echo '  export DATABASE_URL="postgresql://<user>:<password>@<host>.eu-west-2.<provider>/ukpos_staging?sslmode=require"' >&2
  echo "See .env.staging.example for the full staging environment." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm is not on PATH. This repo pins pnpm 12.18.0 (see package.json \"packageManager\")." >&2
  echo "Install it first, e.g.: npm install -g --prefix \"\$HOME/.npm-global\" pnpm@12.18.0" >&2
  exit 1
fi

echo "Staging check: applying migrations + running live G-A-13 against DATABASE_URL."
echo "(Host is not printed — the connection string may contain credentials.)"
pnpm --filter @uk-pos/db concurrency:live

echo
echo "Migrations applied and live G-A-13 check passed."
echo "To re-run the live G-A-13 check standalone (same command):"
echo '  DATABASE_URL="<redacted>" pnpm --filter @uk-pos/db concurrency:live'
