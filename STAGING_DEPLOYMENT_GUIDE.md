# UK POS/EPOS SaaS Pilot — Staging Deployment Guide

Deploy the pilot to free cloud staging: **Neon or Supabase Postgres** (database) + **Render** (three Node services). Nothing here deploys anything by itself — follow the steps in order. Each step says exactly what to click or type.

## What gets deployed

| Service | What it is | Render URL after deploy |
|---|---|---|
| `uk-pos-api` | NestJS API (Build-13: reads `DATABASE_URL`, applies migrations 001–019 on boot) | `https://uk-pos-api.onrender.com` |
| `uk-pos-register` | Register tablet UI | `https://uk-pos-register.onrender.com` |
| `uk-pos-admin` | Admin web shell | `https://uk-pos-admin.onrender.com` |

Staging runs the **demo seed** (`DEMO_SEED_ON_BOOT=true`): demo tenant "Demo Retail Ltd", demo catalogue (Widget, Gadget, Vape Liquid, Coffee Beans), one open session. Demo PINs: **manager 2468, cashier 1234**. Payments use the **simulated** Stripe Terminal adapter — no real card can be charged on staging.

## Prerequisites

- A GitHub account.
- A Render account (free plan is enough).
- A Neon or Supabase account (free plan is enough).
- `git`, `node` and `pnpm` on your own machine for the local steps. The repo pins pnpm 12.18.0 (`package.json` → `packageManager`).

## Step 0 — Fix `.gitignore` FIRST (required, do not skip)

The repo's `.gitignore` currently covers only `node_modules/` and `dist/`. It does **not** ignore local data or filled-in env files. Right now `data/` holds `register.sqlite` and `statutory-archives/` — those must never reach GitHub, and neither must any filled-in `.env.staging`.

In the repo root, add these lines to `.gitignore`:

```gitignore
data/
.env
.env.staging
.env*.local
*.sqlite
```

Then check nothing sensitive is staged before you commit (Step 1): `git status` must show no `.env*` file except `.env.staging.example`, and no `data/` entries.

## Step 1 — Push the repo to GitHub

The pilot is not a git repository yet. From the repo root (`~/workspace/uk-pos-pilot/` on this machine):

```bash
git init
git add .
git commit -m "UK POS pilot — Build-13 staging baseline"
```

On GitHub, create a **new empty repository** — no README, no license, no `.gitignore` (adding any of those creates a first commit that conflicts with yours). Then:

```bash
git remote add origin https://github.com/<your-github-user>/<repo-name>.git
git branch -M main
git push -u origin main
```

## Step 2 — Create the cloud Postgres (Neon or Supabase)

1. In Neon or Supabase, create a **new free project in `eu-west-2` (London)**.
2. Create a database named `ukpos_staging`.
3. Copy the connection string from the provider dashboard. It must look like this — note `sslmode=require`:

```
postgresql://<user>:<password>@<host>.eu-west-2.<provider>/ukpos_staging?sslmode=require
```

Keep this string private. It goes into the Render dashboard in Step 4, never into the repo, never into a committed file.

## Step 3 — Link Render to the repo (Blueprint)

1. In the Render dashboard: **New → Blueprint**.
2. Connect the GitHub repository from Step 1.
3. Render detects `render.yaml` and proposes three free web services (`uk-pos-api`, `uk-pos-register`, `uk-pos-admin`, region Frankfurt — Render has no London region; the database is still in London).
4. Click **Apply**. The first deploy starts.

> If Render says the service name is taken, it appends a suffix (for example `uk-pos-api-xxxx`). The register and admin services call the API at `https://uk-pos-api.onrender.com` (set in `render.yaml`). If the API service is renamed, update `REGISTER_API_BASE_URL` (register service) and `ADMIN_API_BASE_URL` (admin service) in the Render dashboard to the real API URL, then redeploy those two services.

## Step 4 — Fill in the secrets in Render (required before the API works fully)

In the Render dashboard, open each service → **Environment** and fill the variables marked `sync: false` in `render.yaml`. Nothing secret is in the repo; generate the keys with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it once per key you need — never reuse one value for two keys.

| Variable (service) | Value | Required? |
|---|---|---|
| `DATABASE_URL` (api) | The connection string from Step 2, with `sslmode=require` | Yes — without it the API falls back to PGlite, and staging is not testing the cloud database |
| `WEBHOOK_ENCRYPTION_KEYS` (api) | JSON map, e.g. `{"k1":"<hex-from-above>"}` | Yes for webhook secrets to persist |
| `WEBHOOK_ACTIVE_KEY_ID` (api) | `k1` | Yes, with the line above |
| `PLATFORM_OPERATOR_KEYS` (api) | JSON map, e.g. `{"operator-1":"<hex-from-above>"}` | Yes for `POST /v1/webhooks/re-encrypt-secrets` (without it that route answers 503) |
| `REGISTER_APP_DEVICE_SECRET` (register) | A generated secret | No — without it the register's local SQLite is unencrypted and the page shows a warning banner |

After saving, **manually redeploy** the affected services (Render does not always redeploy on env changes alone).

## Step 5 — Verify the live staging stack

Wait for all three services to show **Live** in Render (first build takes a few minutes; free services sleep after inactivity, so the first request after a pause takes ~1 minute to wake up).

```bash
curl -s -o /dev/null -w 'api catalogue/status: %{http_code}\n' https://uk-pos-api.onrender.com/catalogue/status
curl -s -o /dev/null -w 'register: %{http_code}\n' https://uk-pos-register.onrender.com/
curl -s -o /dev/null -w 'admin: %{http_code}\n' https://uk-pos-admin.onrender.com/
```

All three must answer **200**. Then open the register URL in a browser: the Sell screen lists the four demo items and the session is open (manager PIN 2468). Open the admin URL: the dashboard shows the **LIVE** badge, not demo-fallback data.

## Step 6 — Prove the cloud database (local check, optional but recommended)

From your own machine, with the repo checked out and the same `DATABASE_URL` from Step 2:

```bash
DATABASE_URL="<your-connection-string>" pnpm staging:check
```

This applies all 19 migrations to the cloud database and runs the live multi-connection G-A-13 concurrency check against it. It refuses to run without `DATABASE_URL` and never falls back to PGlite. You can run this **before** Step 3 too — it proves the database works before Render ever touches it.

## What staging is — and is not

- **Demo data only.** The fixed demo tenant, demo PINs and demo API key are public by design. Never seed real customer data and never run live card processing here.
- **Simulated payments.** The Stripe Terminal adapter is simulated; no network calls, no real charges.
- **Ephemeral filesystem.** On Render free, the register's offline queue and the statutory VAT archive bundles live on a disk that is wiped on restart/redeploy. Do not rely on staging for durable records.
- **Free-tier sleep.** Services sleep after inactivity; the first request wakes them (~1 minute).
- **No uptime guarantee.** This is a staging stack for testing, not production.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| API service crashes on boot, log mentions `DATABASE_URL` | Connection string wrong, unreachable, or missing `sslmode=require` | Recheck the string in the dashboard (Step 4); the API fails loudly on purpose and never silently falls back to PGlite |
| `GET /catalogue/status` returns 404 or the service never goes Live | Build failed | Read the deploy log in Render; the build runs `pnpm install --frozen-lockfile` then `pnpm build:api` (api) or `pnpm build` (register/admin) |
| Register/admin show demo-fallback data or cannot reach the API | API base URL wrong | Check `REGISTER_API_BASE_URL` / `ADMIN_API_BASE_URL` — see the rename note in Step 3 |
| `POST /v1/webhooks/re-encrypt-secrets` answers 503 | Operator keyring not set | Fill `PLATFORM_OPERATOR_KEYS` (Step 4) and redeploy the API |
| First page load is very slow | Free-tier sleep | Wait ~1 minute; this is normal on the free plan |

## Verified state (16 Nov 2026)

- `render.yaml` parses; three free services (`uk-pos-api`, `uk-pos-register`, `uk-pos-admin`), Frankfurt; build/start commands use the real repo scripts; all secret vars are `sync: false`.
- `.env.staging.example` matches `render.yaml` variable-for-variable, including the `DATABASE_URL` template with `sslmode=require`.
- `scripts/staging-check.sh` is executable and syntactically clean; it fails closed without `DATABASE_URL` and runs migrations + live G-A-13 via `pnpm --filter @uk-pos/db concurrency:live`.
- Build-13 `DATABASE_URL` factory verified in `apps/api/src/database/database.module.ts` + `packages/db/src/pg.ts`: `DATABASE_URL` set → real `pg` pool with libpq `sslmode` semantics and migrations applied on boot; unset → PGlite as before; malformed/unreachable → loud failure, never a silent fallback.
- 19 migrations (001–019) in `packages/db/migrations/`.
- Final health check (run 16 Nov 2026): full suite **1034/1034, exit 0** — shared-kernel 48, db 27, api 536, register-app 225, admin-web 198 (finished ~14:56 PKT; log `~/workspace/staging-finalisation-test.log`, `FINALISATION_FULL_SUITE_EXIT:0`); typecheck **clean on all 5 packages** and build **clean on all 5 packages** (log `~/workspace/staging-finalisation-tc-build.log`, `FINALISATION_TC_BUILD_EXIT:0`).
