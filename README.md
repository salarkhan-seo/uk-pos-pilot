# UK POS/EPOS SaaS — Pilot (Build-12, Sandbox Code Freeze)

The pilot implementation of the UK independent-retail POS/EPOS SaaS, built
from the research programme in `~/workspace/uk-pos-research-audit/`
(Phase 2A T-01–T-11, Arch-01–Arch-06, Arch-09, Arch-10, V-04-Prep,
Arch-11 consolidated review).

**Build-12 scope (delivered 15 Nov 2026 — SANDBOX CODE FREEZE):**
everything in Build-01–11, plus uniform `AuthGuard` + `RequireScope`
on every remaining inventory route (closing the Build-11
demo-header exception in the inventory controller), nested
`ageRestriction` on product creation and the age-restriction
removal route (`DELETE /v1/catalogue/age-restrictions/:id`), the
three remaining G-UI-06 endpoints (`PATCH
/v1/catalogue/variants/:id`, `POST /v1/inventory/purchase-orders`,
`POST /v1/crm/customers/:id/groups`), the 3-gate E2E bootstrap
hardened across every remaining server-booting suite, the four
final route-table entries (101 entries + 3 sync = 104 mapped
routes), and this README rewritten to the frozen state — closing
all remaining Build-11 codebase limits. The codebase is frozen
for external V1–V4 validation; no further build is authorised by
Build-12.
**1017/1017 tests passing (Obj 4 verification, 15 Nov 2026 — full
suite re-run by the Objective 4 worker, all five packages; api
`--maxWorkers=2`; the api re-run after a one-line test fix is
519/519, exit 0); 104 mapped API routes; 19 migrations, 89 tables.** No live provider call (the adapter stays
deterministic and simulated; no real Stripe account, keys or network
calls), no physical tablet or hardware attached, no live PostgreSQL
run in this environment (no Docker, no local PostgreSQL binaries).
No database, cloud resource or external service is provisioned here.
The V1–V4 validation gates remain open (see [Gate status](#gate-status)).

> **Separation:** this pilot is a brand-new codebase. It is NOT the legacy
> build in `~/workspace/pos-saas/` — that directory is never inspected,
> read, modified, copied or reused. The research files in
> `~/workspace/uk-pos-research-audit/` are read-only and are never modified.

## Layout

```
uk-pos-pilot/
├── pnpm-workspace.yaml            # workspace: packages/*, apps/*
├── package.json                   # root scripts (test / typecheck / build)
├── tsconfig.base.json             # strict TypeScript shared by all packages
├── docker-compose.yml             # PostgreSQL 16 + Redis 7 — concurrency harness
│                                  # and local dev ONLY, never a deployment
├── README.md
├── packages/
│   ├── shared-kernel/             # pure domain logic, no I/O, no framework
│   │   ├── src/
│   │   │   ├── types.ts           # Money (bigint), tax kinds, order/payment states
│   │   │   ├── money.ts           # integer-pence arithmetic (D-13)
│   │   │   ├── tax.ts             # D-13 per-line round-half-up VAT, tax-inclusive
│   │   │   ├── discounts.ts       # D-14 exact pro-rata basket discount allocation
│   │   │   ├── business-date.ts   # Europe/London business-date resolver
│   │   │   └── hash-chain.ts      # SHA-256 audit hash chain (create / verify)
│   │   └── test/                  # vitest unit tests (money, tax, discounts,
│   │                              # business-date, hash-chain)
│   └── db/                        # PostgreSQL schema + Kysely types + runner
│       ├── migrations/            # 001_tenancy … 017_supplier_variants_is_preferred (SQL)
│       └── src/
│           ├── schema.ts          # Kysely DB interface for every table (89 tables)
│           ├── webhook-schema.ts  # re-exports the webhook tables from schema.ts
│           ├── repository-base.ts # TenantScopedRepository (tenant filter)
│           ├── pglite.ts          # PGlite test/local driver + custom dialect
│           ├── pg-concurrency-check.ts  # live multi-connection G-A-13 check
│           └── migrate.ts         # list / apply migrations (needs a Kysely
│                                  # instance — driver + connection are Build-02)
└── apps/
    ├── api/                       # NestJS modular monolith (Build-03: live)
    │   └── src/
    │       ├── main.ts
    │       ├── app.module.ts
    │       ├── common/            # Actor, roles/discount limits, auth guard,
    │       │                      # scopes, leaky-bucket rate limiter + interceptor
    │       ├── database/          # DATABASE token + module (PGlite, migrations on boot)
    │       └── modules/
    │           ├── admin/         # tenancy/RBAC, approvals, hash-chained audit,
    │           │                  # API keys, PIN sessions, tier gating, exit/export/GDPR
    │           ├── catalogue/     # products/variants, barcodes, pricing pipeline,
    │           │                  # Phase-2 studio services (price books, promotions,
    │           │                  # vouchers — Build-04 integration)
    │           ├── inventory/     # locking, counts, goods-in, purchasing (POs,
    │           │                  # transfers, reorder suggestions — Build-04)
    │           ├── sales/         # checkout state machine, split tenders, receipts,
    │           │                  # returns & refunds, void_post_tender gate
    │           ├── payments/      # simulated Stripe Terminal adapter, W-12
    │           │                  # resolution, discrepancies (no live provider)
    │           ├── reporting/     # sessions, Z-reports, VAT periods, CSV, settlement
    │           ├── integrations/  # HMAC webhooks + DLQ, Events API
    │           └── sync/          # register delta-sync: handshake + FIFO flush
    │                              # (Build-04 Objective 1)
    │   └── test/
    │       ├── admin/ catalogue/ inventory/ sales/ payments/ reporting/
    │       │   integrations/      # module suites (vitest, PGlite-backed)
    │       ├── gates/             # G-A-01–G-A-18 acceptance gate suite (Build-03 Obj 5)
    │       ├── routes/            # Build-04: the 37 newly exposed routes
    │       └── e2e/               # Build-04: offline bounds/sync, receipt formats,
    │                              # age gate, full back-office flow
    ├── register-app/              # Register tablet app (Build-04 Objective 1;
    │                              # Build-06: live-wired HTTP UI shell on 3130;
    │                              # Build-07: React Native component layer)
    │   └── src/                   # framework-free TypeScript view-models/controllers:
    │       ├── storage/           # StorageAdapter + in-memory + node:sqlite drivers
    │       │                      # (AES-256-GCM encrypted, Build-05; key-id
    │       │                      # rotation via reEncryptAllRecords, Build-07)
    │       ├── offline/           # queue bounds + online-only guards (banners)
    │       ├── sync/              # SyncClient (handshake + FIFO flush)
    │       ├── sell/              # sell controller, line pricing, age gate,
    │       │                      # split tender + W-12 screen
    │       ├── session/           # till session + close flow
    │       ├── hardware/          # SIMULATED Stripe Terminal, ESC/POS printer,
    │       │                      # customer display adapters
    │       ├── rn/                # React Native screens/modals + Stripe Terminal
    │       │                      # native bridge (Build-07; unit-tested, no
    │       │                      # physical terminal attached)
    │       └── ui/                # HTTP UI shell (port 3130, live or demo mode)
    └── admin-web/                 # Admin web dashboard (Build-04 Objective 2;
                                   # Build-06: live-wired HTTP shell on 3131)
        └── src/                   # framework-free TypeScript view controllers +
            ├── api/               # typed API client (92 live routes, route table)
            ├── catalogue/         # studio: products, price books, promotions, vouchers
            ├── inventory/         # purchasing console, receiving form (0-defaults)
            ├── crm/               # customers, consents, loyalty, liabilities, GDPR
            └── finance/           # Z-reports, VAT, CSV, settlement, DLQ, exit portal
```

## Owner-approved decisions implemented (Build-01, 13 Nov 2026)

| Decision | Option | What it means here |
|---|---|---|
| D-02 pilot scope | A — narrow single-site | Core schema for one location; Phase 2 tables (warehouses, POs, loyalty, promotions) included as structure, gated by feature flags |
| D-03 architecture | A — modular monolith | TypeScript/NestJS + PostgreSQL + Kysely. No BullMQ/Redis yet — Build-02 needed no queue; that part of the Build-01 plan is deferred to the build that first needs background jobs |
| D-04 register runtime | A — native tablet app | React Native app is NOT built in Build-01; only the backend monorepo |
| D-05 payment provider | A + C fallback | Stripe Terminal direct + standalone fallback; Build-03 adds the DETERMINISTIC SIMULATED adapter only — no live provider, no network calls, no Stripe account/keys |
| D-06 offline card | B — deferred | Cash-only offline queue; `offline_payment_records` schema present but feature-disabled, must stay empty |
| D-07 open without float | B — warn + manager override | Audit-logged; behaviour is Build-03 (sessions) |
| D-08 till variance | C — higher of £10 or 2% | Stored on the Z-report; threshold applied by the application (Build-03 sessions) |
| D-09 refunds | C — queue, then manual escalation | `refunds.status` includes `manual_escalation`; Build-03 adds the retry queue (5 attempts) + async `refund.failed` handling |
| D-10 counts | A — one active count per location | Partial unique index on `stock_counts` |
| D-11 termination | A — block until resolved | Exit state machine on `tenants.status`; block enforced by the application (Build-03) |
| D-12 device loss | A — honest loss + report | Report within 1 business day; credential revocation via user disable / API-key revoke (Build-03) |
| D-13 money & rounding | A — integer pence, round half-up per line | `bigint` everywhere; shared-kernel `tax.ts` |
| D-14 discount allocation | A — pro-rata, remainder to largest line | Shared-kernel `discounts.ts`; zero penny drift, tested |
| D-15 numbering | A — sequential, no gaps, voided retained | Unique `z_number` per register; sequential order/PO numbers |

## Invariants the schema enforces

- **Money is integer pence (`bigint`) everywhere** — never float.
- **Business date is Europe/London** — `timestamptz` + the shared-kernel
  resolver (correct across BST/GMT transitions).
- **Completed orders are immutable** — a trigger raises on UPDATE/DELETE
  once `status = 'completed'`. Corrections are separate entries.
- **Tax is snapshotted per line at sale** — `tax_rate_kind`,
  `tax_rate_percent`, `tax_amount_pence` on `order_lines`.
- **Stock on hand = SUM(stock_movements)** — no settable quantity;
  `stock_balances` / `stock_valuation` are read models.
- **Payment attempts** have states
  `created/pending/approved/declined/unknown/refunded`, a nullable
  `provider_reference`, and a globally unique `idempotency_key`.
  `unknown` is first-class: no path marks an order paid without provider
  evidence (W-12).
- **Age verification stores the verified age, never a date of birth.**
- **Approvals enforce requester ≠ approver** (`CHECK` on
  `approval_events`).
- **Gift cards and voucher codes store `code_hash` + `code_last4` only** —
  the full code is never stored.
- **Append-only tables** (`stock_movements`, `audit_events`,
  `loyalty_ledger`, `gift_card_ledger`, `store_credit_ledger`,
  `marketing_consents`, issued Z-reports) reject UPDATE/DELETE by trigger.
- **Z-reports** have a unique sequential `z_number` per register.
- **Export jobs / manifests carry SHA-256 checksums**; `audit_events`
  carries `prev_hash` / `event_hash` (hash chain, shared kernel).
- **Tenant isolation** — `tenant_id` on every tenant-scoped table; the
  `TenantScopedRepository` applies the filter in one place. Join/child
  tables (e.g. `order_lines`, `stock_count_lines`, `z_report_vat_lines`)
  inherit isolation from their parent row.

### Deliberate schema notes

- `customers` lives in migration 007 (Phase 2, per the commission), so
  `orders.customer_id` has no foreign key in 004 — the FK is added by
  `ALTER TABLE` in 007. Likewise `stock_movements.order_id`,
  `serial_numbers.order_id` (FKs added in 004) and
  `order_lines.price_book_id` (FK added in 008).
- `product_variants` carries a denormalised `tenant_id` so SKU uniqueness
  is per tenant.
- `offline_payment_records` (004) is schema only, feature-disabled
  (D-06 Option B). It must stay empty until D-06 is re-decided with
  written provider terms and V-04 legal review.

## Per-role discount limits (DESIGN DECISION, not a research fact)

Manual discounts are capped per role, as a percentage of the line total
after steps 1–4 of the pricing pipeline. The limits are explicit in code
(`apps/api/src/common/roles.ts`, `DEFAULT_ROLE_DISCOUNT_LIMITS`) —
never Lightspeed's permissive 100% default:

| Role | Manual discount limit |
|---|---|
| cashier | 0% (no manual discount without an approval) |
| manager | 10% |
| admin | 25% |
| owner | unlimited |

Above the caller's limit a discount needs an `approval_events` row from
a manager/admin/owner at the same location (self-approval blocked, PIN
verified). PINs are stored as a salted scrypt hash
(`packages/shared-kernel/src/pin.ts`, `scrypt$v1$<salt>$<hash>`, 4–6
digit PINs) — a pilot-grade scheme; production must use a stronger
scheme. No real 2FA provider is integrated.

## Running the tests

```sh
pnpm install
pnpm test            # shared-kernel, db, api, register-app, admin-web (vitest)
pnpm typecheck       # tsc --noEmit on all five packages
pnpm build           # shared-kernel -> db -> api -> register-app -> admin-web
pnpm start:api       # node apps/api/dist/main.js (PORT env, default 3000)
```

**1017/1017 tests passing (Build-12, Obj 4 verification 15 Nov 2026 — full suite re-run by the Objective 4 worker, all five packages under plain `pnpm test` with default workers; api `--maxWorkers=2`, exit 0; the first full run was 1016/1017 with one api failure — an Obj 3 test bug, fixed test-only, then the api package re-run clean 519/519):**

| Package | Tests | Files | Headline coverage |
|---|---|---|---|
| shared-kernel | 48 | 6 | money, tax (D-13), discounts (D-14), business dates, hash chain, PIN |
| db | 27 | 6 | all 19 migrations execute (89 tables); append-only triggers; 5th-attribute / 21st-bundle-component / self-approval rejection; bigint round-trip; advisory locks; migration 014–019 columns; idempotent demo seeder (Build-08, 2 tests) |
| api | 519 | 43 | admin/RBAC, API keys, PIN sessions, tier gating, rate limiter, exit + GDPR; catalogue pricing pipeline; inventory locking + G-A-13; sales state machine + returns/refunds; simulated payments + W-12; sessions, Z-reports, VAT, CSV, settlement; webhooks HMAC + DLQ + rotation + keyring re-encryption; sync handshake/flush (incl. Challenge 25 flag in the delta, Build-08); tax-rates list + single-rate read (Build-08); product + age-restriction endpoints (Build-09); server-side age verification + 422 `AGE_VERIFICATION_REQUIRED` enforcement + DOB rejection (Build-09); sales AuthGuard + RequireScope `sales:read` / `sales:write` (Build-10 Obj 1); warehouse + supplier endpoints (Build-10 Obj 2); age-rule inheritance + sync `error_code` + platform-operator guard (Build-10 Obj 3); balances/valuation over HTTP with AuthGuard `stock:read` (Build-11 Obj 1); stored product-level age rules + `rule_source` + client `verified_at` persistence (Build-11 Obj 2); operator keyring + `PlatformOperatorGuard` + 3-gate E2E bootstrap (Build-11 Obj 3); inventory AuthGuard + RequireScope on all remaining inventory routes (Build-12 Obj 1); nested ageRestriction on product creation + age-restriction removal (Build-12 Obj 2); variant update + standalone purchase orders + customer-group assignment (Build-12 Obj 3); gates G-A-01–G-A-18 + G-B + G-E; 6 Build-06 E2E HTTP lifecycle tests + pure-HTTP zero-seed Challenge 25 lifecycle E2E (Build-09) + balances/valuation live E2E (Build-11 Obj 1, 4 tests) + stored product-rules live E2E (Build-11 Obj 2, 5 tests) + inventory-auth live E2E (Build-12 Obj 1, 5 tests) + age-restrictions live E2E (Build-12 Obj 2, 4 tests) + G-UI-06 live E2E (Build-12 Obj 3, 8 tests) |
| register-app | 225 | 22 | storage (in-memory + node:sqlite, AES-256-GCM), offline guards, sync client, sell controller, age gate, split tender + W-12, till session, hardware adapters, live transport + live UI shell, RN component layer (Build-07), interactive DOM execution tests (Build-07), live Challenge 25 age-gate E2E (Build-08), product/age-restriction typed clients (Build-09), sales-auth live E2E (Build-10 Obj 1), pure-HTTP zero-DB-seed merchant lifecycle E2E (Build-11 Obj 4, 4 tests — rule-first reorder + balances/valuation assertions), 3-gate E2E bootstrap on every server-booting suite (Build-12 Obj 4) |
| admin-web | 198 | 10 | typed client (101-entry route table, 104 live API routes), catalogue validation, receiving-form 0-defaults, CRM, finance, live shell + demo mode, interactive DOM execution tests (Build-07), tax-rates picker + live variant creation tests (Build-08), demo-seed boot test (Build-08), product/age-restriction client tests + Admin Catalogue Studio product form (Build-09), warehouse/supplier client tests + Inventory & Purchasing Console forms (Build-10 Obj 2/4), balances/valuation typed clients + Inventory Console cost render + recording tests (Build-11 Obj 1/4), variant update + PO + group-assignment clients + recording tests (Build-12 Obj 3/4), 3-gate E2E bootstrap on every server-booting suite (Build-12 Obj 4) |
| **Total** | **1017 of 1017** | **87** | |

The Build-04 per-module breakdown was replaced by the current totals above; the Build-01–04 narrative sections below are kept as build history. Run the suite with `pnpm test` (root script — sequential across packages) or per package; the api package needs `--maxWorkers=2` on this 6 GB machine (see [Environment note](#environment-note)).

The suite covers: mixed-basket VAT (20% / 5% / 0% / exempt) with pro-rata
basket discounts (D-13 + D-14); zero penny drift across multi-line
pro-rata allocations; Europe/London business-date boundaries (00:30 BST
vs UTC, BST spring-forward, GMT winter); SHA-256 hash-chain tamper
detection (tampered payload, tampered hash, reorder, deletion).

## Typechecking

```sh
pnpm typecheck      # tsc --noEmit on all five packages
pnpm build          # shared-kernel -> db -> api -> register-app -> admin-web
```

## Startup

Build first — all five packages compile to `dist/`, in dependency order
(the libraries `@uk-pos/shared-kernel` and `@uk-pos/db` compile first;
plain `node` cannot run TypeScript source, and the Build-01 layout with
exports pointing at `./src/index.ts` meant the compiled API crashed on
boot with `ERR_MODULE_NOT_FOUND`. Fixed in Build-02: `pnpm build`
compiles the libraries first. Tests are unaffected — the Vitest configs
alias the workspace packages back to their TypeScript sources, so
`pnpm test` still runs against source and never against a stale build).

```sh
export PATH="$HOME/.npm-global/bin:$PATH"   # pnpm 12.18.0 lives here (see Environment note)
pnpm install
pnpm build        # shared-kernel -> db -> api -> register-app -> admin-web
```

Run each server from the repo root, each in its own shell. Ports
3127 / 3130 / 3131 are the pilot convention.

```sh
# 1. API — NestJS monolith. In-memory PGlite by default; runs all 19
#    migrations on boot. PORT defaults to 3000 in code; the pilot uses 3127.
PORT=3127 pnpm start:api
# equivalent: PORT=3127 node apps/api/dist/main.js

# 2. Register tablet UI shell — HTTP server. Demo mode by default
#    (in-memory storage seeded with the demo catalogue; DEMO DATA badge).
REGISTER_UI_PORT=3130 node apps/register-app/dist/apps/register-app/src/ui/server.js
# Live mode — talks to the API above. Set real tenant/location UUIDs:
# the demo-* actor defaults are not valid UUIDs and live calls fail.
REGISTER_API_BASE_URL=http://localhost:3127 REGISTER_API_KEY=<redacted> \
  REGISTER_TENANT_ID=<tenant-uuid> REGISTER_LOCATION_ID=<location-uuid> \
  REGISTER_UI_PORT=3130 node apps/register-app/dist/apps/register-app/src/ui/server.js

# 3. Admin web shell — HTTP server. Demo mode by default (DEMO DATA badge).
ADMIN_WEB_PORT=3131 node apps/admin-web/dist/ui/server.js
# Live mode — both variables together switch the shell to the live client:
ADMIN_API_BASE_URL=http://localhost:3127 ADMIN_API_TOKEN=<redacted> \
  ADMIN_TENANT_ID=<tenant-uuid> ADMIN_WEB_PORT=3131 node apps/admin-web/dist/ui/server.js
```

Boot checks (all verified 15 Nov 2026, Build-12):

| Server | Check | Expected |
|---|---|---|
| API 3127 | `GET /catalogue/status`, `/sales/status`, `/inventory/status`, `/payments/status`, `/reporting/status`, `/admin/status`, `/integrations/status` | 200 (no `/v1` prefix on status routes) |
| API 3127 | boot log `Mapped {...} route` lines | 104 routes |
| Register 3130 | `GET /health`, `GET /` | 200 |
| Admin 3131 | `GET /health`, `GET /`, `/catalogue`, `/inventory`, `/crm`, `/finance`, `/webhooks`, `/exit` | 200 |
| All three, `DEMO_SEED_ON_BOOT=true` | register root lists the seeded catalogue, admin shell is LIVE, `GET /v1/tax-rates` returns the four rates | 200, populated till (see [Demo seed](#demo-seed)) |

The sync module (`/v1/sync/*`) has no status endpoint by design; its
guard is proven by `GET /v1/sync/status` returning 401 unauthenticated.

## Demo seed

Build-08 Objective 3. A fresh boot from compiled `dist` used to show
an empty till (the old `seedDemoCatalogue` only seeded the in-memory
path). The idempotent demo seeder (`packages/db/src/demo-seed.ts`,
`seedDemo`) fixes that: fixed ids + `ON CONFLICT DO NOTHING` on
every row, plus existence guards for the append-only stock ledger
and the open session, all in one transaction — running it twice (or
on every boot) creates no duplicates and tops the demo back up after
demo activity (sales, a closed session).

Seed the on-disk database directly (defaults to
`<repo-root>/data/pglite` when `PGLITE_DATA_DIR` is unset):

```sh
pnpm --filter @uk-pos/db seed:demo
```

Or boot everything with the flag — the API seeds its own database
(in-memory or on-disk, whichever it opened) before serving, and both
UI shells default their actor ids and API key to the demo values:

```sh
DEMO_SEED_ON_BOOT=true PORT=3127 pnpm start:api
DEMO_SEED_ON_BOOT=true REGISTER_UI_PORT=3130 node apps/register-app/dist/apps/register-app/src/ui/server.js
DEMO_SEED_ON_BOOT=true ADMIN_WEB_PORT=3131 node apps/admin-web/dist/ui/server.js
```

The API logs `Demo seed on boot: tenant <id>, register <id>, open
session <id> (demo PINs: manager 2468, cashier 1234)`. The register
root then lists the seeded items, the admin shell runs LIVE, and
`GET /v1/tax-rates` returns the four rates.

**What the seed contains** (all fixed ids in `demo-seed.ts`):
demo tenant "Demo Retail Ltd" (VAT-registered), location "Demo High
Street" (1 Demo High Street, London E1 1AA), default warehouse,
register, and four users — owner, admin, manager, cashier. Standard
UK tax rates: Standard 20%, Reduced 5%, Zero-rated 0%, Exempt.
Starter catalogue: Demo Widget, Demo Gadget, Demo Vape Liquid
(Challenge 25 item, £8.00, barcode 5012345678902), Demo Coffee Beans
— Case of 12 (case-breakdown item, £24.00, sold by the case of 12,
breakable into single units). Initial stock movements, and an open
register session with a £50.00 float.

**Demo PINs** (documented, demo-only): owner / admin / cashier
`1234`, manager `2468` (deliberately different so the manager-approval
flow can be demonstrated end to end).

**Demo API key** (fixed public value, demo-only — never production):
`ukp_2eb0267ee1b049098e7f8961d394b5dcc9f8f7e225859725566c9f89235bf909` (constant `DEMO_API_KEY` in
`packages/db/src/demo-seed.ts`, scope `admin`, which implies every
other scope). With `DEMO_SEED_ON_BOOT=true` the shells pick it up
automatically; for a manual live-mode boot, pass it as
`REGISTER_API_KEY` / `ADMIN_API_TOKEN`.

**Never in production:** the demo key and PINs are fixed, public,
documented values for a local demo. `DEMO_SEED_ON_BOOT` must never be
set in production, and the demo seed must never be pointed at a real
tenant's database.

## Environment variables

Every variable below was verified to be read in code. "Required" means
the feature fails without it; "optional" means a default applies.

| Variable | Read in | Required? | Default / notes |
|---|---|---|---|
| `PORT` | `apps/api/src/main.ts` | Optional | `3000` in code; pilot convention `3127`. |
| `PGLITE_DATA_DIR` | `apps/api/src/database/database.module.ts` | Optional | Unset → in-memory PGlite (data lost on restart). Set to a directory path to persist the local API database across restarts. |
| `DEMO_SEED_ON_BOOT` | `apps/api/src/database/database.module.ts`, `apps/register-app/src/ui/server.ts`, `apps/admin-web/src/ui/server.ts` | Optional | Unset / anything other than the string `'true'` → off. `'true'` → the API seeds the demo tenant/catalogue/session idempotently on boot, and both UI shells default their actor ids and API key to the demo values (see [Demo seed](#demo-seed)). **Never set in production.** |
| `DATABASE_URL` | `apps/api/src/database/database.module.ts` via `packages/db/src/pg.ts`; also `packages/db/src/pg-concurrency-check.ts` | Optional | **Build-13: the API reads it.** When set, the API connects via a real `pg` pool (sslmode=require honoured) and applies pending migrations on boot; when unset, PGlite is used exactly as before. It is also used by the live G-A-13 concurrency check. |
| `WEBHOOK_ENCRYPTION_KEY` | `apps/api/src/modules/integrations/webhook.service.ts` | Required in practice | Single master key (backward compatibility with Build-06). With no key configured at all (and not `NODE_ENV=test`), registration and rotation throw instead of silently falling back to memory-only secrets; delivery then sends the new signature only. |
| `WEBHOOK_ENCRYPTION_KEYS` | `apps/api/src/modules/integrations/webhook.service.ts` | Optional | JSON map of `key_id -> key material` (each id scrypt-derives its own 256-bit key). Takes precedence over the single key. A malformed map (bad JSON, not an object, empty values, unknown active id) throws at construction — a bad keyring fails boot loudly. |
| `WEBHOOK_ACTIVE_KEY_ID` | `apps/api/src/modules/integrations/webhook.service.ts` | Required when the keyring has several keys | With a one-key ring that key becomes active automatically. With several keys and no active id, construction throws — the operator must say which key is active (fail closed, never a silent guess). |
| `PLATFORM_OPERATOR_KEY` | `apps/api/src/modules/integrations/platform-operator.guard.ts` | Required for `POST /v1/webhooks/re-encrypt-secrets` outside test mode (unless the keyring is set) | Single shared bearer secret for platform-wide re-encryption (Build-10 Obj 3). The route requires the `X-Platform-Operator-Key` header to match it, in addition to `admin` scope. Wrong/missing key → 403 `PLATFORM_OPERATOR_REQUIRED`; unset outside test mode → 503 `PLATFORM_OPERATOR_KEY_NOT_CONFIGURED` (fail closed). `NODE_ENV=test` uses a deterministic test fallback. A successful or rejected call records an audit event with `operator_id` (`'default'` in single-key mode). |
| `PLATFORM_OPERATOR_KEYS` | `apps/api/src/modules/integrations/platform-operator.guard.ts` | Optional (Build-11 Obj 3) | JSON map of `operator_id -> secret_key` — the rotatable operator keyring. Takes precedence over the single `PLATFORM_OPERATOR_KEY` when set. `X-Platform-Operator-Id` is optional: when present it must name the key's owner; when absent the operator is derived from the key. A malformed map throws at construction (fail closed). Rotation is an env-var change + restart — there is no rotation endpoint. |
| `STATUTORY_ARCHIVE_DIR` | `apps/api/src/modules/admin/statutory-archive.ts` | Optional | `<repo-root>/data/statutory-archives`. On-disk home of the 6-year statutory VAT archive bundles (SHA-256-verified). |
| `UK_POS_SESSION_SECRET` | `apps/api/src/modules/admin/session.service.ts` | Optional | Unset → a dev-only fallback secret. **Must be replaced before any deployment.** PIN sessions are 2h stateless HMAC tokens with no server-side store — an issued token cannot be revoked individually. |
| `REGISTER_API_BASE_URL` | `apps/register-app/src/ui/server.ts` | Optional | `http://localhost:3127`. |
| `REGISTER_API_KEY` | `apps/register-app/src/ui/server.ts` | Optional | Unset → the shell cannot call the live API until a PIN login stores a session token. |
| `REGISTER_TENANT_ID` / `REGISTER_LOCATION_ID` / `REGISTER_REGISTER_ID` / `REGISTER_USER_ID` / `REGISTER_ROLES` | `apps/register-app/src/ui/server.ts` | Optional | Demo defaults (`demo-tenant`, `demo-user`, `demo-location`, `demo-register-1`). Set real tenant/location UUIDs for live mode. |
| `REGISTER_UI_PORT` | `apps/register-app/src/ui/server.ts` | Optional | `3130`. |
| `REGISTER_SQLITE_PATH` | `apps/register-app/src/ui/server.ts` | Optional | Direct-run default `data/register.sqlite` relative to the working directory. Unset in test/imported use → in-memory storage. |
| `REGISTER_APP_DEVICE_SECRET` | `apps/register-app/src/storage/sqlite-cipher.ts` | Optional | Without it the local SQLite file is stored **unencrypted** and the page shows a warning banner. Required for encrypted local storage. |
| `REGISTER_APP_DEVICE_KEY_ID` | `apps/register-app/src/storage/sqlite-cipher.ts` | Optional | `k1`. Key id stamped on local ciphertexts; `reEncryptAllRecords` (Build-07) rotates it. |
| `REGISTER_API_TIMEOUT_MS` | `apps/register-app/src/ui/server.ts` | Optional | `15000`. |
| `ADMIN_WEB_PORT` | `apps/admin-web/src/ui/server.ts` | Optional | `3131`. |
| `ADMIN_API_BASE_URL` / `ADMIN_API_TOKEN` | `apps/admin-web/src/ui/server.ts` | Optional | Both set together → live mode; otherwise demo mode with the seeded demo client. |
| `ADMIN_TENANT_ID` / `ADMIN_LOCATION_ID` | `apps/admin-web/src/ui/server.ts` | Optional | Scope the live client to a tenant/location. |
| `ADMIN_USER_ID` / `ADMIN_USER_ROLES` | `apps/admin-web/src/ui/server.ts` | Optional | Actor identity for the live client. |

`NODE_ENV=test` enables a deterministic test fallback key for the
webhook cipher — test-only, well-known by design, and never to protect
real secrets.


## Database — PGlite (no local PostgreSQL in this environment)

There is **no local PostgreSQL** here (no `initdb` / `pg_ctl` / `psql`),
so Build-02 integrates `@electric-sql/pglite` as the test/local driver
for Kysely (`packages/db/src/pglite.ts`, `createPGliteDb()` /
`createTestDb()`; the API boots an in-memory PGlite instance and runs
all 19 migrations on start). All 19 migration files execute against it,
and the DB integration tests prove the triggers enforce their rules.

**PGlite honest limits (proven by probes, not assumed):**
- A custom Kysely dialect (`packages/db/src/pglite-dialect.ts`) is
  required because the stock driver returns int8 as JS `number`,
  breaking the schema's `bigint` types; the dialect converts int8
  (oid 20) to `bigint` on read. The production `pg` driver must use
  `types.setTypeParser(20, BigInt)` — recorded in the dialect file.
- PGlite is single-connection: two concurrent Kysely transactions
  interleave on it, so their `FOR UPDATE` locks do not block each
  other, and two PGlite instances on one data directory do not
  coordinate locks either. **True concurrent lock contention (G-A-13)
  cannot be exercised on PGlite and must be re-verified against real
  PostgreSQL.** The G-A-13 tests therefore run sequentially and prove
  the outcome plus the lock-held proof (`pg_locks` RowShareLock > 0
  after the `FOR UPDATE` select).
- Migration fixes made in Build-02 (rules specified in Build-01,
  enforced only after the fix — see `packages/db/src/migrate.ts` and
  the migration files): (1) 001 dropped `CREATE EXTENSION pgcrypto`
  (PGlite does not bundle it; `gen_random_uuid()` is core since PG 13);
  (2) 001 added `users.pin_hash`; (3) 004 `order_tenders` CHECK gained
  `'loyalty_points'`; (4) 004 added `receipts.vat_invoice_notice`
  (default `'This is not a VAT invoice'`); (5) 005
  `z_report_tender_lines` CHECK gained `'loyalty_points'`. The
  migration runner also splits files into single statements
  (dollar-quote-aware) because PostgreSQL rejects multi-command
  prepared statements.
- Migration changes made in Build-03: (6) 009 adds `warehouse_id`,
  `unit_id`, `quantity_in_base_units` to `order_lines` (defaulting is
  application-side — a DB default cannot look up the default warehouse
  or base unit; the checkout decrement stamps them at reservation);
  (7) 010 adds `api_keys` (SHA-256 hash only, scopes, rotating/revoked
  states, 24h rotation grace); (8) 011 adds `webhook_endpoints`,
  `webhook_events`, `webhook_deliveries` (DLQ); (9) 012 adds
  `retry_count`, `next_retry_at`, `failure_reason` to `refunds`;
  (10) 013 amends `prevent_completed_order_change()` so a completed
  order may transition ONLY to `partially_returned`/`returned` (and
  `partially_returned` → `returned`) — without it no return could ever
  change order status, since migration 004's trigger rejects all
  updates to completed orders. (11) 014 adds `statutory_vat_archives`
  (append-only, 6-year retention) and the webhook rotation columns
  `previous_secret_hash` / `previous_secret_expires_at` (Build-05);
  (12) 015 adds `previous_secret_ciphertext` — the retiring webhook
  secret encrypted at rest (Build-06); (13) 016 adds
  `current_secret_ciphertext` and `encryption_key_id` (NOT NULL,
  default `'v1'`) — the current signing secret encrypted at rest
  under the active master key, so a fresh service instance signs
  immediately after a restart with no re-provisioning (Build-07).
  89 tables in total across 001–016 (016 adds columns only).

## Live PostgreSQL Docker G-A-13

G-A-13 (concurrent sale of the last item) is the one gate PGlite
cannot prove: PGlite is single-connection, so two concurrent
transactions never truly contend for the same row lock. The harness
for a real multi-connection run is `docker-compose.yml` (PostgreSQL 16
+ Redis 7, dev-only, never a deployment) and
`packages/db/src/pg-concurrency-check.ts`. **No live run has happened
in this environment: no Docker and no local PostgreSQL binaries exist
here.** The commands below are for a machine where Docker exists.

```sh
docker compose up -d            # PostgreSQL 16 on host 5433, Redis 7 on 6380
DATABASE_URL=postgres://ukpos:<dev-password>@localhost:5433/ukpos_pilot pnpm --filter @uk-pos/db concurrency:live
docker compose down             # stop (data survives in the volume)
docker compose down -v          # stop AND delete all local data
```

Smoke mode runs the same seed + assertions sequentially against
PGlite — no Docker needed, and the form the gate is verified in here:

```sh
pnpm --filter @uk-pos/db concurrency:smoke
```

Notes, all verified in code:
- Host ports 5433 (Postgres) and 6380 (Redis) are deliberately
  non-default, to avoid clashing with a locally installed
  PostgreSQL (5432) or Redis (6379).
- The check refuses to run without `DATABASE_URL` and never falls
  back to PGlite in live mode.
- Redis is included because D-03 names BullMQ/Redis for background
  jobs. Nothing in this build connects to it yet — no queue, no
  worker, no BullMQ dependency.
- Credentials are dev-only placeholders (`POSTGRES_USER` /
  `POSTGRES_PASSWORD` / `POSTGRES_DB`, defaults `ukpos` /
  `ukpos_pilot`); override them via a local `.env` file and never
  reuse them anywhere else.


## What Build-02 delivered

Per the Build-01 commission: **Core Backend Modules — Auth/RBAC,
Catalogue, Inventory Concurrency & Checkout State Machine.**

- **Objective 1 — real PostgreSQL execution:** all 8 migrations run
  against PGlite; 17 DB integration tests prove the append-only,
  attribute, bundle and self-approval rules are enforced by the
  database, not just the application.
- **Objective 2 — Admin:** strict tenant isolation (cross-tenant =
  404, never 403, G-B); roles owner/admin/manager/cashier with
  location-scoped checks; explicit per-role discount limits (above);
  `ApprovalService` (manager role at the location, self-approval
  blocked, PIN verified, append-only records for discounts above
  limit, price overrides, refunds above threshold, post-tender voids,
  cash paid out, till-close variance D-08); `AuditService` (SHA-256
  hash-chained `audit_events` via the shared kernel, read-only via
  `GET /v1/audit-events`).
- **Objective 3 — Catalogue:** categories, products, variants (unique
  SKU/barcode per tenant, per-variant tax rate, max 4 attributes),
  units of measure with case-breakdown conversion, serial numbers,
  bundles; EAN-13 / UPC-A embedded barcode parser with one active
  mode per tenant (wrong-mode barcodes rejected, not reinterpreted);
  the Arch-10 deterministic pricing pipeline in exact order
  (base → price book → automatic promotions → voucher → manual →
  D-14/D-13), with `applied_promotions` rows for every automatic
  promotion applied.
- **Objective 4 — Inventory:** no endpoint sets a quantity — stock
  changes only via `stock_movements`; checkout decrement with
  pessimistic locking in `(variant_id, warehouse_id)` order,
  availability checked inside the lock before any payment attempt
  (G-A-13); counts (D-10, one active count per location, variance as
  adjustment movements); goods-in with/without PO, damaged/short
  handling, weighted-average revaluation (integer pence, round half up).
- **Objective 5 — Sales:** state machine draft → pending_payment →
  completed → voided (completed immutable in service + DB trigger);
  sequential gap-free order/receipt numbers via advisory lock + MAX+1
  (voided numbers never reused); split tenders (cash, card, gift card,
  store credit, loyalty points at 1 pt = 1p — design decision);
  5-minute split timeout with unwind to draft (Square's documented
  rule, adopted as a design rule); an order completes only when
  tenders sum to the total AND every card tender has an approved
  attempt — an `unknown` attempt blocks with the W-12 message
  "Payment outcome unknown — do not hand over goods on card until
  checked"; receipts with per-rate VAT breakdown (Net/VAT/Gross) and
  the explicit marking **"This is not a VAT invoice"** (the Build-02
  commission was truncated mid-sentence in objective 5; this marking
  completes it from the specification itself — package §11 / Arch-01
  §3.2: a VAT invoice is not a till receipt). Returns
  (`partially_returned` / `returned`) are NOT implemented — Build-03
  scope. No provider is ever called; card attempts are recorded with
  provider `'standalone'` as a stand-in until the Stripe adapter lands.

**Fixed during Build-02 integration (13 Nov 2026):**
`AuditService.record()` could never succeed when passed a caller
transaction — it wrapped its work in `dbOrTrx.transaction().execute()`,
and Kysely 0.28's `Transaction.transaction()` throws unconditionally.
It never surfaced in the admin tests because `approve()` is only
called there without a transaction; all 13 sales tests failed on it
until the sales module worked around it with a private duplicate of
the audit logic. The fix: `record()` now detects a Transaction (type
guard in `audit.service.ts`) and writes directly on it, so the audit
row commits/rolls back with the caller's work; the sales duplicate
was deleted and all six sales call sites now use `audit.record(trx,
...)`. Covered by a new admin regression test (commit + rollback).
Kysely 0.28 type quirk found while fixing it: narrowing with
`instanceof Transaction` yields `Transaction<any>`, which the types
refuse to assign to `Kysely<DB>` — the predicate guard narrows to
`Transaction<DB>` instead; see the comment in `audit.service.ts`.

**Demo auth (local/test only):** the API reads the actor from demo
headers (`x-tenant-id`, `x-user-id`, `x-location-id`, `x-roles`).
Production auth landed in Build-03 (below) — do not deploy the demo
headers. The demo-header path is kept only so the existing test
helpers keep working; new routes should use `AuthGuard`.

## Auth, scopes & rate limiting (Build-03 Objective 1)

- **API keys** (`ApiKeyService`, migration 010): per-integration,
  per-tenant keys, `ukp_<64 hex>`, shown once at creation, stored as
  SHA-256 hash only (`key_hash`, `key_prefix` for identification).
  Rotation issues a new key with the old key valid for a 24h grace
  period (`grace_until`), then revoked. Revocation is immediate.
- **Scopes** (Arch-02 §4.3): `catalogue:read`, `catalogue:write`,
  `sales:read`, `sales:write`, `stock:read`, `stock:write`,
  `payments:read`, `accounting:read`, `admin`. `admin` implies all.
  PIN-session roles map to scopes (`scopesForRoles`).
- **Tier gating** (`403 PLAN_GATED`, Arch-02 §4.4): tier comes from
  `tenants.plan_tier`, default `'base'` (the tier itself is undecided —
  planning labels only). Gated writes are `cost-vendor-write`,
  `custom-roles`, `advanced-reporting`, `bulk-import-api` (all require
  `'plus'`). Reads, exports, API access itself, webhooks/events and
  rate limits are NEVER gated.
- **PIN sessions** (`SessionService`): PIN verified against the
  Build-02 scrypt hash; issues a 2h stateless HMAC-SHA256 token
  (`UK_POS_SESSION_SECRET`, else a dev-only fallback that MUST be
  replaced before any deployment). No server-side session store — an
  issued token cannot be revoked individually; revocation is by
  disabling the user (checked on every verify) or rotating the secret.
  Pilot-grade; production must use server-side sessions and a stronger
  scheme. No real 2FA provider is integrated.
- **Leaky-bucket rate limiter** (Arch-02 §2.4): per-tenant/per-key
  100 burst / 10 req/s; platform 500/50; bulk import 10/1.
  `X-RateLimit-Limit` / `Remaining` / `Reset` on every response; 429
  with `Retry-After` (seconds) and `error.code = "RATE_LIMITED"`.
  **Till exemption (design decision):** checkout endpoints called with
  a till session actor are counted and get the headers but are never
  answered 429 — the till must never lose a sale because of a rate
  limit.
- **Cross-tenant = 404, never 403** (G-B), enforced by the guard and
  by every service.

## What Build-03 delivered

Per the Build-03 commission (authorised 13 Nov 2026, 12:15 PKT;
complete file, ending `END OF COMMISSION — BUILD-03`):

- **Objective 1 — Build-02 follow-ups, auth, scopes & rate limiter:**
  migration 009 (order-line warehouse/unit/base-unit columns) and 010
  (`api_keys`); the inventory reservation now converts case/pack
  quantities via `variant_units.conversion_factor` and stamps the
  order line — closing the Build-02 honest limit (reservation treated
  stored quantity as base units). End-to-end case-aware checkout is
  wired through sales: `createOrder` stores the sold `unit_id`, and
  `addTender` passes `unitId` + `orderLineId` to the decrement.
  Hashed scoped API keys, PIN sessions, tier gating (`403
  PLAN_GATED`), leaky-bucket limiter with the till checkout exemption
  above. Test helpers in `packages/db/src/testing.ts` keep the
  Build-02 suites passing.
- **Objective 2 — Payments state machine (W-12), returns & refunds:**
  provider-agnostic `PaymentAdapter` + deterministic simulated Stripe
  Terminal adapter (approve, decline, timeout/disconnect, late
  webhook, duplicate webhook, async `refund.failed`, T+3 settlement
  payouts) + Option C standalone manual-reference fallback. No network
  calls anywhere in the adapter layer. W-12 resolution paths (a)
  provider status query, (b) terminal reconciliation, (c) manager
  decision with `approval_event_id` (void-and-retry with a fresh key,
  old attempt retained `unknown`; or standalone tender with a physical
  reference) — no path marks an order paid without provider evidence
  or a manager-approved standalone reference. Late webhooks after a
  void/refund create a `payment.discrepancy` audit alert, never a
  silent second sale. Returns (`partially_returned` / `returned`) with
  explicit restock vs damage write-off, pro-rata/BOGO/multibuy
  discount reversal (Arch-10 §3.4) and loyalty earn reversal
  (Arch-09 §3.2). Linked refunds only, own idempotency key; refund >
  original and refund-of-refunded blocked (G-A-15); refund on an
  unforwarded offline PaymentIntent blocked (G-A-16); provider-
  unavailable refunds retry up to 5 times (backoff 1m/5m/30m/4h) then
  `manual_escalation`; `refund.failed` (G-A-18) and
  `insufficient_balance` (never blindly retried) handled. The
  `void_post_tender` manager-approval gate is now ENFORCED in
  `voidOrder` (Build-02 recorded it, did not enforce it).
- **Objective 3 — Register sessions, immutable Z-reports & accounting
  CSV sync:** sessions with opening float (D-07: zero/delayed float
  only with warning + manager approval; retired registers cannot
  open), typed cash movements with required notes, petty-cash-out
  approval above **£50** (design decision), two-step End (exact
  expected-cash formula) vs Close (counted, variance, required reason),
  close blocked on pending/unknown card payments unless carried
  forward with a manager note, D-08 variance approval. Z-reports
  issued on close with sequential gap-free `z_number` per register;
  aggregates, per-rate VAT lines, per-tender totals, per-promotion
  discount breakdown, card fee estimates (1.4% + 10p per approved
  attempt — design decision), voids, carried corrections; immutable
  once issued (trigger-proven); post-close errors are manager-approved
  `z_report_corrections` carried into the next Z-report. VAT periods
  close by rate with refunds restating (never rewriting) closed
  periods. Z-report + VAT-period CSVs match the exact Arch-02 §5.3
  column contract (integer pence, `GBP`, Europe/London dates) and
  re-run identically. Settlement reconciliation (G-A-17) by settlement
  date (T+3), reserve holds and dispute debits as distinct lines,
  fee-adjustment entries when settled fees differ from estimates.
- **Objective 4 — Webhooks + DLQ, Events API & 30-day exit/export/
  GDPR deletion:** 34-event catalog (Arch-02 §3.2's 22 + the
  Arch-06/09/10 additions), payloads carry references and amounts
  only. HMAC-SHA256 signatures (`X-Webhook-Signature`,
  `X-Webhook-Timestamp` with 5-minute replay check,
  `X-Webhook-Event-Id`). 10-retry exponential schedule (1m→24h) on
  5xx/timeout only (never 3xx/4xx); after attempt 11 the delivery
  moves to the 30-day DLQ (replayable, explicitly discardable, never
  auto-deleted). `GET /v1/events` cursor-paginated. Exit state machine
  `active` → `termination_requested` (D-11: blocked with the exact
  open-session and pending/unknown-attempt ids) → `export_window`
  (30 days, read-only — enforced by `TenantWriteGuard` on the sales
  POST routes and the catalogue variant-create route) →
  `hard_delete_scheduled` → `deleted`. Single-click full export (CSV
  + JSON per table + `manifest.json` with row counts and SHA-256
  checksums, excluding password hashes, MFA secrets, API keys and full
  gift/voucher codes); per-customer GDPR export + erasure (PII deleted,
  orders/audit anonymised and retained for VAT). Hard deletion
  separates the 6-year statutory VAT archive (checksummed JSON
  snapshot — PII stripped; the coordinator must persist it to
  compliance storage, since in-place retention would defeat the
  zero-row check via FKs), hard-deletes remaining tenant rows in
  dependency order, verifies zero remaining rows, retains only the
  tenant tombstone, logs to `deletion_jobs`. Backup/restore verifier
  (G-E) reconciles row counts, ledger sums and Z-report totals
  post-restore. Webhook endpoint secret rotation (24h grace) is NOT
  implemented — follow-up.
- **Objective 5 — Acceptance gate verification suite:**
  `apps/api/test/gates/gates.test.ts` (32 tests) proves G-A-01–G-A-18
  (including G-A-16, which the commission explicitly required despite
  the Arch-05 pilot note), G-B across the new endpoints, G-E
  backup/restore, leaky-bucket 429, webhook HMAC + DLQ replay,
  Z-report/CSV reproducibility, and the D-11/GDPR exit + statutory
  archive deletion flow.

**Fixed during Build-03 integration (13 Nov 2026):**
- `SessionService` could not boot: its constructor took an optional
  `secret?: string` parameter without `@Optional()`, so Nest tried to
  resolve a `String` provider and threw `UnknownDependenciesException`
  on startup — the app would not start at all. Fix: `@Optional()` on
  the parameter (the secret still falls back to
  `UK_POS_SESSION_SECRET`, then the dev-only secret). Found by the
  coordinator's boot check, not by any test (tests instantiate the
  service directly). Verified after the fix: api-keys tests 18/18,
  typecheck clean, build clean, all 7 status endpoints responding.
- Schema merge: the Objective 2 `refund-retry-schema.ts` and Objective
  4 `webhook-schema.ts` local type extensions were merged into
  `packages/db/src/schema.ts` (single source of truth); both files are
  now re-exports.
- Module wiring: `ExitService` / `ExportService` / `GdprService` /
  `TenantWriteGuard` registered in `AdminModule`; `AdminModule`
  imported into `IntegrationsModule` (so the optional `AuditService`
  in `WebhookService` resolves and DLQ audit events are recorded);
  `TenantWriteGuard` applied to the sales POST routes and the
  catalogue variant-create route (price-basket and barcode/parse are
  reads and stay unguarded).
- Case-aware checkout wired through sales (see Objective 1 above).

**Honest limits (carried from the workers, verified by the
coordinator):**
- G-A-13 true concurrent lock contention CANNOT be exercised on
  PGlite (single connection) — the gate test proves the sequential
  outcome + the `FOR UPDATE` lock-held proof (`pg_locks`
  RowShareLock). Re-verification against real PostgreSQL remains open.
- The statutory VAT archive is a checksummed JSON snapshot returned
  by `hardDelete()` — the coordinator must persist it to compliance
  storage (access-controlled, export-only, 6-year retention); nothing
  persists it yet.
- Webhook endpoint secret rotation (24h grace) is not implemented.
- G-A-10/G-A-11/G-A-12 UI-only parts (Pay-button disable, offline
  banner, restart screen) are not provable at the server layer — the
  gate tests assert the server-enforceable state, not the UI.
- The gate suite notes two follow-on gaps (flagged, not fixed): a
  decline recorded via the Build-02 stand-in
  `recordCardAttemptOutcome` leaves the dead card tender row (the
  Build-03 provider-query/webhook decline path removes it); blocked
  refunds/returns surface as typed errors with no `audit_events` row.

## What Build-04 delivered (13 Nov 2026)

Build-04 was authorised by Salar's separate upload (13 Nov 2026, 12:32
PKT, commission `workspace/user/files/gemini-code-1794555125595.md`,
complete, ending `END OF COMMISSION — BUILD-04`) and ran after Build-03
was delivered and verified, because both builds run in this directory
and Build-04 builds on Build-03 output. Delivered, in order:

1. **Register Tablet App** (`apps/register-app`, framework-free
   TypeScript view-models/controllers, no React Native runtime yet):
   local SQLite storage (`StorageAdapter` + in-memory driver + a
   `node:sqlite` driver, verified working here); offline bounds 50
   orders / 24h / £250 single cash sale with explicit reason banners;
   online-only blocks with banners (card, gift card, store credit,
   loyalty, vouchers, counts, transfers, customer lookup); price-book
   pricing + role-bounded manual discounts offline with PIN approval
   recorded locally; delta-sync (`POST /v1/sync/handshake` + FIFO
   `POST /v1/sync/flush`, new `sync` module in the API) with
   snapshot-price honouring and `offline_sync_conflict` reconciliation
   (completed cash sales are never voided; the read-model balance
   floors at 0 while the ledger carries the true shortfall); sell
   screen (shared barcode parser, SKU/name search, quick keys, parked
   baskets holding zero stock), Challenge 25 gate (verified age only,
   never DOB), split tender + W-12 modal with the verbatim blocking
   message and 3 resolution actions, till session flow (D-07/D-08),
   simulated hardware adapters (Stripe Terminal, ESC/POS receipt with
   per-rate VAT + "This is not a VAT invoice", customer display with a
   single tax total only).
2. **Admin Web Dashboard** (`apps/admin-web`, framework-free TypeScript
   view controllers + typed API client): catalogue/promotion studio,
   inventory & purchasing console (receiving form defaults all lines
   to 0), CRM/loyalty/liabilities console, finance/compliance/exit
   centre — wired to the API through **84 live routes** (the 37 routes
   that had no controller in Build-03 were added in Build-04
   integration: thin controllers over existing services, plus minimal
   tenant-scoped services for the Phase-2 tables; `updateVariantPrice`
   now stamps `updated_at` so the sync delta sees price changes).
3. **Real-PostgreSQL concurrency harness** (`docker-compose.yml`
   PostgreSQL 16 + Redis 7, dev-only, never a deployment;
   `packages/db/src/pg-concurrency-check.ts` — true multi-connection
   G-A-13 check, refuses to run without `DATABASE_URL`, never falls
   back to PGlite; `--smoke` mode verifies the same assertions
   sequentially on PGlite). **No live run happened in this
   environment: no Docker and no local PostgreSQL binaries exist here**
   (the `postgres-initdb-cow` wrapper references a packaged
   PostgreSQL 18 path that is not present). The live command is
   `docker compose up -d`, then
   `DATABASE_URL=postgres://ukpos:ukpos-dev-only@localhost:5433/ukpos_pilot pnpm --filter @uk-pos/db concurrency:live`.

**Design decisions set in Build-04 (values, not research facts):**
offline bounds inclusive (50th order / exactly 24h / exactly £250.00
allowed); price honouring at flush — server reprices (authoritative
for VAT), a D-14 basket discount bridges a higher server total down
to the snapshot, a lower server total keeps the server price with the
cash overpayment recorded as a warning; offline promotion discount 0
(server evaluates promotions at flush); flush quantities are base
units; SQLite pence stored as TEXT (exact round-trip past
`Number.MAX_SAFE_INTEGER`); per-role discount limits reused from the
API (cashier 0% / manager 10% / admin 25% / owner unlimited);
abuse-report thresholds (5 discounts / 3 voids / £100) are dashboard
display flags only; stock `computed_at` older than 15 min shown
STALE; list pagination default 50, clamped 1–100; voucher bulk
1–1000 per call, 16-char codes, hash + last-4 only, full codes never
returned; transfers are created `in_transit` (no dispatch route);
dismiss reasons go to `audit_events` only (the suggestion row has no
reason column); new price books/promotions are created `draft`, v1.

**Honest limits / open follow-ups (not completed, with reasons):**
- Live-PostgreSQL G-A-13 still open (no Docker / no local PostgreSQL
  here) — the harness exists and is verified by code review + PGlite
  smoke only.
- No SQLCipher encryption at rest (native dependency this environment
  cannot build) — local SQLite stores plaintext; no card data, PINs,
  or full gift/voucher codes are ever written locally.
- No physical tablet or hardware attached — terminal, printer and
  customer-display adapters are simulated.
- No React Native UI yet — register view-models only, ready to bind;
  no browser rendering tested for the dashboard (HTML-string views).
- `closeVatPeriod` bridge: the route closes an *existing* period by
  id, but `ReportingService.closeVatPeriod` creates-and-closes by
  dates — the controller deletes the open placeholder row (no lines,
  no exports) and calls the service, so the response carries a NEW
  period id, not the `:id` passed in. Consoles must use the returned
  id. A proper fix needs a service method that closes an existing row.
- Bulk-generated voucher codes are unrecoverable after generation
  (hash + last-4 only) — distribution needs a follow-up decision
  (e.g. show-once at generation).
- `setPriceBookEntry` has no route; `auth.pinLogin` has a live route
  but no client method yet.
- `POST /v1/auth/pin-login` with a malformed (non-UUID) tenant/user
  id returns 500 from `SessionService.login` instead of 404
  (pre-existing service behaviour, not changed).
- The statutory VAT archive is a checksummed JSON snapshot — the
  coordinator must persist it to compliance storage; nothing persists
  it yet (carried from Build-03).
- The `recordCardAttemptOutcome` dead-tender cleanup and audit rows
  for blocked refunds/returns remain open from Build-03.

## What Build-05 delivered (13 Nov 2026)

- **Migration 014:** `statutory_vat_archives` (append-only, 6-year
  retention, SHA-256) plus the webhook rotation columns
  (`previous_secret_hash` / `previous_secret_expires_at`).
- `closeVatPeriodById` now closes the existing row in place and
  returns the same `:id` (second close 409, unknown id 404).
- `setPriceBookEntry` POST + PUT routes with typed methods in both
  app clients; `pinLogin` UUID validation (malformed → 400, unknown
  well-formed → 404, never 500).
- Show-once bulk voucher codes (`issued_codes` returned once at
  creation; storage keeps SHA-256 `code_hash` + `code_last4` only).
- Webhook secret rotation endpoint (grace default 24h, max 168h;
  dual `X-Webhook-Signature` / `X-Webhook-Signature-Previous`
  inside the window).
- Statutory archive persistence: the GDPR hard-deletion engine
  persists the PII-stripped archive to the DB and as a SHA-256
  bundle on disk (`STATUTORY_ARCHIVE_DIR`, default
  `data/statutory-archives`), verified by SHA-256 before deleting
  tenant rows.
- `Aes256GcmSqliteCipher` (AES-256-GCM, PBKDF2/scrypt, key-ID
  rotation) wired into the node:sqlite and in-memory drivers;
  tamper throws `LOCAL_STORAGE_TAMPERED`.
- UI shells: register tablet UI (port 3130) and admin web shell
  (port 3131, 7 views), demo mode. Route table 69 → 74 entries;
  77 mapped routes. **531/531 tests.**

## What Build-06 delivered (14 Nov 2026)

- **Migration 015:** `previous_secret_ciphertext` — the retiring
  webhook secret encrypted at rest (AES-256-GCM,
  `WEBHOOK_ENCRYPTION_KEY`); dual-signing now survives a restart.
  Test fallback key only when `NODE_ENV=test`.
- Global UUID interceptor (`APP_INTERCEPTOR` in `app.module.ts`):
  malformed ids → 400 with `error.code = "INVALID_UUID"` on all
  controllers, params and nested body fields; 49 new tests.
- Live-wired register UI (3130) and admin shell (3131) replacing
  the demo placeholders.
- 6 committed E2E HTTP tests (compiled servers booted as child
  processes): restart dual-signing, UUID 400s, the full
  register → API flow (online + offline cash sale → encrypted
  SQLite → FIFO flush → session → Z-report → VAT close → CSV),
  and the full tenant exit lifecycle.
- The E2E work exposed and fixed 6 real bugs: the event publisher
  was never wired in production (the live API published zero
  webhook events); register sync sent no tenant/location headers;
  `api-key:<id>` written into UUID columns (500s at 22 sites);
  `GET /v1/events` bigint 500; a sessions date bug; and the missing
  VAT-period read route (`GET /v1/reporting/vat-periods/:id`,
  resolving G-UI-02).
- Routes 77 → 83 (sessions open/end/close, getVatPeriod, webhook
  re-provision, exit hard-delete). **643/643 tests.**

## What Build-07 delivered (14 Nov 2026)

- **Objective 1 — current secret encryption at rest & keyring:**
  migration 016 adds `current_secret_ciphertext` (nullable text)
  and `encryption_key_id` (NOT NULL, default `'v1'`) to
  `webhook_endpoints`. Both the newly provisioned current secret
  AND the retiring previous secret are encrypted with AES-256-GCM
  at creation and rotation time, so active signing secrets are
  never memory-only and survive a full API restart immediately
  upon creation, with no rotation or re-provisioning first.
  Multi-key keyring (`WEBHOOK_ENCRYPTION_KEYS` JSON map +
  `WEBHOOK_ACTIVE_KEY_ID`, backward compatible with the single
  `WEBHOOK_ENCRYPTION_KEY`). `POST /v1/webhooks/re-encrypt-secrets`
  (scope `admin`, NOT TenantWriteGuarded, platform-wide) rotates
  stored ciphertexts from a retiring master key id to the active
  one without breaking live merchant endpoints. Integration tests
  prove create → restart → event → master-key rotation with valid
  HMAC signatures.
- **Objective 2 — React Native tablet component layer:**
  `apps/register-app/src/rn/` — `StripeTerminalNativeBridge`
  wrapping the `@stripe/stripe-terminal-react-native` 0.0.1-beta.34
  SDK contract (terminal discovery, S700 Wi-Fi / WisePad 3
  Bluetooth connection lifecycle, `collectPaymentMethod` /
  `processPayment` with W-12 `unknown` timeout capture, offline
  card block per D-06) and typed screens/modals
  (`SellScreenRN`, `SplitTenderModalRN`,
  `W12UnknownPaymentModalRN`, `Challenge25ModalRN`,
  `ManagerPinModalRN`, `SessionCloseScreenRN`,
  `HardwareStatusDrawerRN`) wired to the `RegisterApp` state
  controllers. `reEncryptAllRecords` on `Aes256GcmSqliteCipher`
  rotates local register SQLite data to a new device key id.
  Dependencies are real (`react` 19.3.1, `react-native` 0.88.1);
  components are unit-tested with `react-test-renderer` — no
  physical terminal is attached and no RN UI has run on a device.
- **Objective 3 — interactive DOM execution tests:** headless-DOM
  tests against the live booted HTTP servers (register 3130,
  admin 3131) proving real interactive form posts, query state
  transitions, error banners, Challenge 25 approval/refusal, W-12
  resolution clicks, goods-in `0`-default form submission, bulk
  voucher show-once masking, and D-11 exit blocker rendering over
  real HTTP round-trips
  (`apps/register-app/test/ui.test.ts`,
  `apps/admin-web/test/build07-ui-interactions.test.ts`).
- **Objective 4 — route table + this README + verification:**
  `POST /v1/webhooks/re-encrypt-secrets` added to the route table
  (81 entries; 84 API routes). **718/718 tests.**

## What Build-08 delivered (14 Nov 2026)

- **Objective 1 — tax-rates list endpoint & live variant creation:**
  `GET /v1/tax-rates` and `GET /v1/tax-rates/:id` in
  `CatalogueController` / `CatalogueService` (AuthGuard +
  `catalogue:read`, cross-tenant 404 per G-B; `:id` validated by
  the global UuidValidationInterceptor, 400 `INVALID_UUID`),
  returning the tenant's rates (`id`, `name`, `rate_bps`,
  `is_exempt`, `is_default_no_tax`). `listTaxRates()` added to the
  typed API clients in `apps/admin-web` and `apps/register-app`;
  the Admin Web Catalogue Studio variant form now fetches and
  populates valid `tax_rate_id` options from the live endpoint,
  and live variant creation completes with `201 Created` — the
  Build-07 gap ("tax_rate_id is required for a variant", no
  tax-rates list route) is closed. Both routes are in the route
  table (83 entries; 86 API routes).
- **Objective 2 — Challenge 25 flag in the sync delta & live
  register age gate:** `SyncService` joins `age_restrictions` and
  includes `requires_challenge_25` (boolean) and `min_age`
  (integer, nullable) on every synced variant; `RegisterApp` and
  `local_catalog_cache` persist and read the flag from sync
  deltas. An E2E HTTP integration test proves the full path:
  Challenge 25 product/variant created via the Admin API, synced
  to the Register UI (3130), added to the basket triggers the
  Challenge 25 gate in live mode, and approval records
  `verified_age_threshold` (never DOB).
- **Objective 3 — idempotent demo seed & fresh `dist` boot
  bootstrap:** `packages/db/src/demo-seed.ts` (`seedDemo`, plus
  the `pnpm --filter @uk-pos/db seed:demo` CLI) and
  `DEMO_SEED_ON_BOOT=true` support on the API and both UI shells.
  Booting the compiled `dist` servers with the flag starts 3130
  and 3131 with a populated till, active tax rates and
  ready-to-sell inventory — see [Demo seed](#demo-seed).
- **Objective 4 — route table + this README + verification:**
  `GET /v1/tax-rates` and `GET /v1/tax-rates/:id` added to the
  route table (83 entries; 86 API routes). **760/760 tests**
  (admin-web serialised — see Honest limits).

## What Build-09 delivered (14 Nov 2026)

- **Objective 1 — product & age-restriction HTTP endpoints:**
  `POST /v1/catalogue/products` (`catalogue:write`, AuthGuard +
  TenantWriteGuard) and `GET /v1/catalogue/products` /
  `GET /v1/catalogue/products/:id` (`catalogue:read`, AuthGuard;
  malformed `:id` → 400 `INVALID_UUID` via the global interceptor,
  cross-tenant → 404 per G-B) in `CatalogueController` /
  `CatalogueService`, so parent products can be created and listed
  via HTTP with no direct DB inserts. `POST
  /v1/catalogue/age-restrictions` (`catalogue:write`) and `GET
  /v1/catalogue/age-restrictions` (`catalogue:read`) manage
  Challenge 25 / minimum-age rules (`product_id` or `variant_id`,
  `requires_challenge_25`, `min_age`); product-targeted rules
  expand to one row per current variant (snapshot semantics —
  superseded by Build-10 Obj 3: a variant created later now
  INHERITS a uniform product-level rule at creation). Optional
  `age_restriction` fields are accepted during product/variant
  creation. Typed client methods (`createProduct`,
  `listProducts`, `createAgeRestriction`, `listAgeRestrictions`)
  added to `apps/admin-web` and `apps/register-app`, and the Admin
  Catalogue Studio (3131) product creation form is wired to `POST
  /v1/products` — the mounted path is `v1/catalogue/products`
  (the commission's `/v1/products` is shorthand, not the mounted
  path). All six routes are in the route table (89 entries; 92
  API routes).
- **Objective 2 — server-side `age_verification_events`
  persistence & checkout enforcement:** checkout (`POST
  /v1/orders` / tender completion) and offline sync flush (`POST
  /v1/sync/flush`) accept `age_verifications: Array<{ variant_id,
  verified_age_threshold, verified_by_user_id, verified_at }>`.
  If any order line has `requires_challenge_25 = true` (or
  `min_age` set) and lacks a matching verification entry meeting
  the threshold, completion is rejected with **422
  `AGE_VERIFICATION_REQUIRED`** (before any stock is reserved; a
  422 rolls the whole transaction back). Valid verifications are
  persisted into `age_verification_events` linked to `order_id`
  and `tenant_id`, with an `audit_events` entry, storing only
  `verified_age_threshold` — a customer date of birth is never
  accepted or stored (`dob` fields are rejected by
  `assertNoDobFields` on every entry point). `GET
  /v1/sales/orders/:id/age-verifications` exposes the stored
  events for compliance inspection (`verified_age_threshold =
  25`, zero DOB data) — the mounted path is
  `v1/sales/orders/:id/age-verifications` (the commission's
  `/v1/orders/...` is shorthand). **Accuracy (Build-09):** the
  route was recorded in the route table as `sales:read`, but that
  scope was NOT enforced at the time — the sales module used
  demo-header auth (`actorFromHeaders`), not AuthGuard/
  RequireScope. **Build-10 Obj 1 closed this:** `sales:read` is
  now enforced on this route and across all 10 sales routes. A pure-HTTP E2E test proves the full
  zero-DB-seed Challenge 25 lifecycle: create product → create
  variant → attach the rule → sync the register → unverified
  checkout fails 422 → approve Challenge 25 on the Register UI
  (3130) → complete the sale → verify persistence via the GET
  route. This closes the two Build-08 honest limits for
  server-side age verification and product/age-restriction
  routes.
- **Objective 3 — route table + this README + verification:**
  six new route-table entries (89 entries; 92 API routes).
  **831/831 tests** (parent-verified 15 Nov 2026 — the one
  `createProduct` client-test expectation found by Obj 3 was a
  test-only defect and was fixed by the parent during
  verification; see Honest limits).

## What Build-10 delivered (15 Nov 2026)

- **Objective 1 — `AuthGuard` + `RequireScope` across the sales
  module:** all 10 sales routes now enforce AuthGuard with the
  owner-approved scopes (`sales:read` for the order/receipt/
  age-verification reads, `sales:write` for order creation,
  tenders, completion, voids and returns), matching the catalogue,
  reporting and compliance controllers. Scoped API keys (`Bearer
  ...`) and 2-hour HMAC PIN/user sessions satisfy the guard;
  unauthenticated requests return 401, insufficient scopes return
  **403** — Nest's default error shape with the required scope
  named in the message. **Accuracy:** there is NO
  `INSUFFICIENT_SCOPE` code string anywhere — the commission's
  wording is not a code the API returns, so do not assert one.
  This closes the Build-09 honest limit for `sales:read` not
  being enforced on the age-verifications GET route.
- **Objective 2 — warehouse & supplier HTTP endpoints:** `POST
  /v1/inventory/warehouses` (`stock:write`, one default warehouse
  per location — a second default is 409) and `GET
  /v1/inventory/warehouses` / `GET
  /v1/inventory/warehouses/:id` (`stock:read`) in
  `PurchasingController`; `POST /v1/purchasing/suppliers`
  (`stock:write`: `name`, `currency`, `lead_time_days`,
  `min_order_value_pence`), `GET /v1/purchasing/suppliers` /
  `GET /v1/purchasing/suppliers/:id` (`stock:read`), and `POST
  /v1/purchasing/suppliers/:id/variants` (`stock:write`: links
  `supplier_variants` with `supplier_sku`, `cost_pence`,
  `is_preferred`) in `SuppliersController`. Migration 017 adds
  `is_preferred` to `supplier_variants` (17 migrations, 89
  tables). Typed client methods (`createWarehouse`,
  `listWarehouses`, `getWarehouse`, `createSupplier`,
  `listSuppliers`, `getSupplier`, `linkSupplierVariant`) added
  to `apps/admin-web` and `apps/register-app`, wired into the
  Admin Inventory & Purchasing Console (3131). Goods-in stays
  `POST v1/inventory/goods-in` with `poId: null` for no-PO
  receipts — the commission's `POST /v1/purchasing/goods-in` is
  shorthand, NOT a real path; no second goods-in route was
  created. This closes the Build-09 honest limit for "no stock
  create route".
- **Objective 3 — dynamic product-level age-rule inheritance,
  structured sync error codes, platform-operator guard:**
  - *Inheritance:* when `POST /v1/catalogue/variants` creates a
    variant under a product whose EVERY pre-existing variant
    carries an IDENTICAL age rule (same `requires_challenge_25`
    AND same `min_age`), the new variant inherits that rule
    automatically, in the same transaction as the variant insert
    — unless an explicit nested `ageRestriction` on the variant
    creation overrides it (the merchant's explicit choice wins,
    even when it removes the restriction). The rule is DERIVED,
    never stored: there is no product-level marker column. A
    product with no variants yet has nothing to inherit; mixed
    rules (or some variants with no rule) mean no single
    product-level rule exists — nothing is inherited; a lone
    restricted variant IS a uniform rule, so the next variant
    inherits it (the safe direction: a restricted product never
    silently gains an unrestricted variant). This closes the
    Build-09 honest limit for "product-level age rules do not
    propagate to later variants".
  - *Sync error codes:* `POST /v1/sync/flush` failed outcomes
    now carry a structured `error_code` alongside the message
    instead of only the exception class name. Headline codes:
    `AGE_VERIFICATION_REQUIRED`, `INSUFFICIENT_STOCK`,
    `ILLEGAL_ORDER_TRANSITION`, `SPLIT_TIMEOUT`,
    `TENDER_SUM_MISMATCH`, `TENDER_NOT_APPROVED`,
    `UNKNOWN_PAYMENT`, `LOCATION_MISMATCH`, `EMPTY_ORDER`,
    `INVALID_TOTAL`, `SNAPSHOT_MISMATCH`, plus HTTP-status
    codes `BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` /
    `NOT_FOUND` / `CONFLICT` / `UNPROCESSABLE_ENTITY` /
    `INTERNAL_ERROR` (the nested `error.code` of an
    `HttpException` is used when one exists). This closes the
    Build-09 honest limit for the flush `failed` string carrying
    the class name.
  - *Platform-operator guard:* `POST
    /v1/webhooks/re-encrypt-secrets` now requires the
    `X-Platform-Operator-Key` header matching
    `PLATFORM_OPERATOR_KEY` (env var) in addition to `admin`
    scope. Wrong or missing key → 403
    `PLATFORM_OPERATOR_REQUIRED`; unset outside test mode → 503
    `PLATFORM_OPERATOR_KEY_NOT_CONFIGURED` (fail closed);
    `NODE_ENV=test` uses a deterministic test fallback. The
    re-encrypt route also skips the UUID body interceptor
    (`@SkipUuidBodyValidation()`, so `fromKeyId` no longer 400s)
    and returns 200 via `@HttpCode(200)`.
- **Objective 4 — pure-HTTP zero-DB-seed E2E, route table, this
  README, verification:** the new E2E
  (`apps/register-app/test/build10-zero-seed-lifecycle.test.ts`,
  API 4127 / register 4130) proves the complete merchant
  lifecycle strictly over HTTP with zero direct PGlite inserts
  for catalogue or stock — only the tenant + API key come from
  PGlite: create warehouse + supplier → create product + seed
  variant → attach the product-level Challenge 25 rule → create
  a second variant AFTER the rule and prove it inherits
  `requires_challenge_25 = true` (age-restrictions list AND
  sync handshake delta) → link the variant to the supplier →
  receive stock via HTTP goods-in with no PO (into the default
  warehouse, discovered over HTTP, because the sale reserves
  stock from the default warehouse) and verify the balance over
  HTTP → sync the register → unverified checkout 422
  `AGE_VERIFICATION_REQUIRED`, unauthenticated GET
  age-verifications 401 → approve Challenge 25 on the register
  UI → complete the sale → stock decremented, verification
  persisted with threshold 25 and zero DOB data. **Accuracy:**
  the commission's literal step order (attach the rule, then
  create the variant) is impossible by design — a variant-less
  product 400s on a product-targeted rule — so the lifecycle
  uses one seed variant to establish the rule and proves
  inheritance on the second variant. Weighted-average cost is
  NOT exposed over HTTP, so only the stock balance is proven
  over HTTP (cost was proven at service level by Obj 2). Six
  new route-table entries (95 entries; 98 API routes). **Count note:**
  the commission brief said 99 (92 + 7), but the live boot log
  shows 98: `GET /v1/inventory/warehouses` (`listWarehouses`)
  already existed since Build-04, so only 6 of Obj 2's 7 routes
  are new. **910/910 tests** (parent-verified 15 Nov 2026 — the
  single failure in Obj 4's run was the Obj 2 intermediate-state
  UI test asserting the pre-Obj-4 missing route-table entries; the
  parent rewrote it to assert the post-Obj-4 behaviour — see
  Honest limits). **SUPERSEDED by Build-11:** both accuracy notes
  above no longer apply — migration 018 stores a product-level
  rule on a variant-less product, so the lifecycle now attaches
  the rule BEFORE creating any variant (the commission's literal
  step order), and weighted-average cost IS exposed over HTTP
  (Build-11 Obj 1), proven by the lifecycle's balances/valuation
  assertions. See [What Build-11 delivered](#what-build-11-delivered-15-nov-2026).

## What Build-11 delivered (15 Nov 2026)

- **Objective 1 — weighted-average cost & stock valuation over
  HTTP:** `GET /v1/inventory/balances` and `GET
  /v1/inventory/valuation` (`stock:read`, AuthGuard +
  RequireScope — the AuthGuard exception in the inventory
  controller, which otherwise uses demo-header auth; see Honest
  limits). Both accept `?variantId=` / `?warehouseId=` filters
  and return snake_case with money/quantities as decimal strings:
  balances is one row per (variant, warehouse) with
  `quantity_on_hand`, `weighted_avg_cost_pence`,
  `total_value_pence` (= quantity × average) and `computed_at`;
  valuation rolls variants up across warehouses with
  `total_quantity_on_hand`, `weighted_avg_cost_pence`,
  `total_value_pence` plus tenant `totals`. The average is null
  when a variant-warehouse has no `stock_valuation` row — unknown,
  never guessed. Typed clients in both apps (`getBalances`,
  `getValuation`) and the Admin Inventory Console (3131) render
  the cost fields. Live E2E 4/4 (API 4227). This closes the
  Build-10 honest limit for "weighted-average cost not exposed
  over HTTP".
- **Objective 2 — first-class product-level age restrictions &
  client `verified_at` persistence:** migration 018 (18
  migrations, 89 tables) lets `age_restrictions` store a
  product-level rule directly on `product_id` (variant_id NULL)
  even when the product has zero variants yet, and adds
  `rule_source` (`'explicit'` | `'inherited'`, default
  `'explicit'`) on variant-level rows; it also adds `verified_at`
  (`timestamptz`, NOT NULL DEFAULT `NOW()`) to
  `age_verification_events`. `POST
  /v1/catalogue/age-restrictions` targeting a `product_id` now
  201s on a variant-less product (storing the product-level rule)
  AND propagates `rule_source = 'inherited'` rows to existing
  variants that have no `explicit` override (an `explicit` row is
  never overwritten; an `inherited` row is refreshed from the
  product rule). Creating a variant under that `product_id`
  automatically inherits the product-level rule with
  `rule_source = 'inherited'` unless an explicit variant-level
  rule is passed (`rule_source = 'explicit'`). The
  derived-uniformity inference from Build-10 Obj 3 is REMOVED —
  the rule is stored, not derived. `SalesService` and
  `SyncService` persist the client-supplied `verified_at` (when
  valid) into `age_verification_events.verified_at`, and `GET
  /v1/sales/orders/:id/age-verifications` returns both
  `verified_at` and `created_at` — so an offline Challenge 25
  sale flushed hours later keeps its real till timestamp. Live
  E2E 5/5 (API 4327). This closes the Build-10 honest limit for
  "`verified_at` still `created_at`".
- **Objective 3 — platform-operator keyring, guard extraction &
  E2E de-flaking:**
  - *Keyring:* `PlatformOperatorGuard` is now a proper
    `CanActivate` guard
    (`apps/api/src/modules/integrations/platform-operator.guard.ts`).
    `PLATFORM_OPERATOR_KEYS` (JSON map of `operator_id ->
    secret_key`) takes precedence over the single
    `PLATFORM_OPERATOR_KEY`; the test fallback applies only in
    test mode; no key configured anywhere → fail closed (503).
    `X-Platform-Operator-Id` is OPTIONAL: when present it must
    name the key's owner; when absent the operator is derived
    from the key; single-key mode records `'default'`. Success
    and rejection audit events carry `operator_id`. Rotation is
    now possible without a code change (env-var change +
    restart) — but the key is still a shared bearer secret per
    operator, with no rotation endpoint (see Honest limits).
  - *The Build-10 401 flake — mechanism FOUND and fixed:* the old
    E2E bootstrap awaited only an unauthenticated `GET
    /payments/status`, which passes against ANY process holding
    the port — the API child takes ~5.9s to listen and dies
    `EADDRINUSE`, but the probe succeeds in ~250ms, so the first
    authenticated request hit the stranger process and 401d.
    The hardened bootstrap (in the api E2E files) now has three
    gates: (1) the port is free before spawn; (2) the child is
    alive after the probe; (3) an AUTHENTICATED probe — `GET
    /v1/tax-rates` with the seeded admin key → 200. A port
    collision now fails fast naming the cause instead of
    masquerading as a 401. This closes the Build-10 honest limit
    for the one-off Obj 1 E2E flake.
- **Objective 4 — route table, lifecycle E2E, this README,
  verification:** two route-table entries
  (`inventory.getBalances`, `inventory.getValuation`; 97 entries
  + 3 sync = 100 mapped routes, confirmed in the live boot log),
  the fake client's `getBalances`/`getValuation` now record
  through `routeFor`, and live-client recording tests for both
  methods (the Build-10 suppliers pattern). The zero-seed
  lifecycle E2E
  (`apps/register-app/test/build10-zero-seed-lifecycle.test.ts`,
  API 4127 / register 4130) is reordered to the commission's
  literal step order — the product-level rule is attached BEFORE
  any variant exists (migration 018 makes the Build-10 "seed
  variant first" deviation obsolete; the test header and this
  section record the supersession) — and now proves the valuation
  over HTTP: after goods-in (10 × 400p, no PO, default
  warehouse), `GET /v1/inventory/balances` shows
  `weighted_avg_cost_pence = 400` and `total_value_pence = 4000`,
  and `GET /v1/inventory/valuation` reconciles the same numbers;
  the lifecycle still proves variant inheritance (both variants,
  `rule_source = 'inherited'`), the 422, the approval, the sale,
  and stock 10 → 9.

## What Build-12 delivered (15 Nov 2026 — Sandbox Code Freeze)

- **Objective 1 — uniform `AuthGuard` + `RequireScope` across
  all inventory routes:** every remaining route in
  `InventoryController` is now AuthGuard-enforced
  (`stock:read` for reads, `stock:write` for movements, counts
  and transfers), closing the Build-11 demo-header exception —
  `actorFromHeaders` is gone from the inventory controller and
  every controller in `apps/api` now enforces uniform API-key
  and HMAC PIN-session authentication. Unauthenticated calls
  401, wrong scopes 403. Live E2E 5/5
  (`apps/api/test/e2e/build12-inventory-auth-live.test.ts`).
  This closes the Build-11 honest limit for the
  inventory-controller auth-coverage gap.
- **Objective 2 — nested `ageRestriction` on product creation
  & age-restriction removal:** `POST /v1/catalogue/products`
  (`catalogue:write`) now accepts an optional nested
  `ageRestriction` (`{ requiresChallenge25, minAge? }`) and
  inserts the first-class product-level `age_restrictions` row
  (`variant_id IS NULL`, `rule_source = 'explicit'`) in the same
  transaction as the product — resolving the Build-11 400
  inconsistency (its Build-09 justification, "nothing to attach
  it to", was already false once migration 018 stored
  product-level rules). `DELETE
  /v1/catalogue/age-restrictions/:id` (`catalogue:write`,
  UUID-validated, audit-logged): deleting a product-level rule
  removes the product row AND any `'inherited'` variant rows for
  that product while preserving `'explicit'` variant overrides;
  deleting a variant-level rule removes only that row.
  `deleteAgeRestriction(id)` and nested-creation support added to
  the typed clients in both apps and wired into the Admin
  Catalogue Studio (3131). Live E2E 4/4
  (`apps/api/test/e2e/build12-age-restrictions-live.test.ts`).
  This closes the Build-11 honest limits for the `createProduct`
  nested-`ageRestriction` 400 and for no removal route.
- **Objective 3 — remaining G-UI-06 endpoints & admin UI
  wiring:** `PATCH /v1/catalogue/variants/:id`
  (`catalogue:write`, UUID-validated) updates variant `sku`,
  `barcode`, `pricePence`, `costPence`, `taxRateId` or `status`
  and stamps `updated_at` so `/v1/sync/handshake` picks up the
  delta; `POST /v1/inventory/purchase-orders` (`stock:write`,
  mounted under `v1/inventory/` — the commission shorthand
  `/v1/purchasing/purchase-orders` is NOT a mounted path, same
  precedent as Build-09's `v1/catalogue/products`) creates a
  standalone draft purchase order (`supplierId`, `warehouseId`,
  `expectedDeliveryDate`, `lines`) with migration 019 adding
  nullable `warehouse_id` + `expected_delivery_date` to
  `purchase_orders` (19 migrations, 89 tables); `POST
  /v1/crm/customers/:id/groups` (scope `admin` — no `crm:write`
  scope exists anywhere, none invented) assigns an existing
  customer to a manual `customer_groups` record, idempotent when
  already a member. Typed methods (`updateVariant`,
  `createPurchaseOrder`, `assignCustomerToGroup`) in the
  admin-web client, wired into the Admin Catalogue, Purchasing
  and CRM consoles (3131). Live E2E 8/8
  (`apps/api/test/e2e/build12-gui06-live.test.ts`). Real bug
  fixed: the price-change role rule in `updateVariantPrice`
  403'd every API-key price change (API-key actors carry
  `roles: []`) — it now applies to PIN-session/demo actors
  only. This closes the G-UI-06 gaps. Open follow-ups, stated
  plainly: there is no create-group route (groups are
  server-side only); the Update-variant form cannot clear a
  barcode (blank = keep); the PO form takes one line only.
- **Objective 4 — 3-gate E2E hardening, route table, this
  README, verification:** the remaining server-booting E2E
  suites now use the Build-11 3-gate bootstrap (port free
  before spawn, child alive after probe, authenticated `GET
  /v1/tax-rates` probe with the seeded key) — the commission's
  six named suites are eight files, of which the two
  `apps/api/test/routes/` files (`build08-tax-rates`,
  `build09-products`) are service-level route tests that never
  boot a server, so the bootstrap does not apply to them; the
  six that do boot servers are hardened — plus two stragglers
  found by the full sweep
  (`build07-ui-interactions`, five servers, and
  `build11-product-rules-live`) — so all 16 server-booting
  suites now fail fast naming the true cause, never a masked
  mid-`beforeAll` 401. UI children also get the port-free gate
  before spawn. The TOCTOU gap remains (a process can still bind
  between the free check and the spawn) — collisions fail fast,
  they are not eliminated. Four route-table entries
  (`catalogue.deleteAgeRestriction` DELETE, `catalogue.updateVariant`
  PATCH, `inventory.createPurchaseOrder`, `crm.assignCustomerToGroup`;
  `'PATCH'` and `'DELETE'` added to `HttpMethod` in
  `route-table.ts` and to the request method type in `api/http.ts`;
  101 entries + 3 sync = 104 mapped routes, confirmed in the
  live boot log), the fake client's `record()` calls for all
  four methods, and live-client recording tests for all four
  (the Build-11 `getBalances`/`getValuation` pattern). One test
  bug found by the full-suite verification and fixed test-only:
  the Obj 3 `createPurchaseOrder` test asserted PO lines by
  position, but `PurchasingService.purchaseOrderLines` returns
  lines ordered by `variant_id` — with random variant UUIDs the
  5-qty line sorted first and `lines[0]` was 5n, not 10n; the
  test now asserts by variant (the service ordering is
  deliberate; the test was the bug).

## Gate status

### Sandbox-verified here (PGlite; no Docker, no hardware)

| Gate | Status |
|---|---|
| G-A-01–G-A-18 | Proven by the gate suite (`apps/api/test/gates/gates.test.ts`, 32 tests) — **except G-A-13, see below**. |
| G-A-13 (concurrent sale of the last item) | Sequential outcome + `FOR UPDATE` lock-held proof (`pg_locks` RowShareLock) only. True concurrent lock contention **cannot** be exercised on PGlite and is **not** verified — needs the live run in [Live PostgreSQL Docker G-A-13](#live-postgresql-docker-g-a-13). |
| G-A-10 / G-A-11 / G-A-12 UI-only parts | Server-enforceable state proven by the gate suite; interactive UI behaviours (banners, modals, form posts) now proven over real HTTP by the Build-07 DOM execution tests. No browser rendering. |
| G-B (cross-tenant = 404) | Proven across the endpoints. |
| G-E (backup/restore) | Verifier reconciles row counts, ledger sums and Z-report totals post-restore. |
| Webhook HMAC + DLQ, Z-report/CSV reproducibility, D-11/GDPR exit + statutory archive | Proven by the gate suite and the Build-06 E2E tests. |
| Full suite / typecheck / build / boots | 1017/1017 tests (Obj 4 verification 15 Nov 2026), typecheck and build clean on all 5 packages, all 3 servers boot (API 3127, register 3130, admin 3131) under default workers — every server-booting E2E suite now uses the 3-gate bootstrap. |

### External validation gates — OPEN

| Gate | What it needs | Status |
|---|---|---|
| V1 | ≥3 merchants, same subsegment, same pain | No merchant interviewed. |
| V2 | ≥2 catalogues imported and reconciled | No catalogue imported. |
| V3 | ≥3 merchants agree to a PAID trial | None. |
| V4 | ≥1 provider path + ≥1 hardware set confirmed for a new vendor | No provider quote or hardware path confirmed. |
| V-04 | Professional adviser engaged (PCI / GDPR / compliance / tax) | No adviser engaged; no SAQ selected; briefs only. |

V1–V4 are validation, not build scope. No build authorises them;
each needs Salar's separate explicit authorisation.

## Honest limits & known gaps (Build-12 — Sandbox Code Freeze)

- No live-PostgreSQL G-A-13 run (no Docker in this environment);
  G-A-13 is proven sequentially on PGlite only.
- No physical tablet or hardware; the Stripe Terminal bridge and
  RN screens are unit-tested only (react-test-renderer), never run
  on a device or against a real terminal. No browser rendering —
  the UI shells render HTML strings, verified over HTTP and by
  headless-DOM tests.
- Legacy pre-Build-07 webhook rows have NULL
  `current_secret_ciphertext` and still need re-provisioning after
  a restart (`POST /v1/webhooks/endpoints/:id/secret`) — the
  escape hatch from Build-06, now the exception, not the rule.
- The re-encrypt endpoint is `admin`-scoped AND platform-operator
  key-guarded since Build-10 (`X-Platform-Operator-Key` must match
  a configured key; Build-11 adds the `PLATFORM_OPERATOR_KEYS`
  keyring and records `operator_id` on success/rejection audit
  events): a single tenant admin can no longer trigger
  platform-wide re-encryption. The key is still a shared bearer
  secret per operator — rotation is an env-var change + restart,
  with no rotation endpoint, and no per-operator identity beyond
  the recorded `operator_id` (a true per-operator identity and
  rotation endpoint were NOT in Build-12 scope — do not claim
  them).
- A re-encrypt call fails the whole call BEFORE any row changes if
  the retiring key is not in the keyring or a candidate ciphertext
  is tampered. Delivery with an undecryptable/tampered ciphertext
  degrades to the new signature only — it never breaks a delivery.
- **Closed by Build-08:** the three Build-07 known gaps — live
  variant creation (tax-rates list route added, `201 Created`),
  the live-mode age gate on synced items (flag in the sync delta,
  E2E-proven), and the empty demo till on a fresh `dist` boot
  (idempotent demo seed + `DEMO_SEED_ON_BOOT=true`).
- **Closed by Build-09:** the two Build-08 honest limits for
  server-side age verification and product/age-restriction routes
  — `verified_age_threshold` is now persisted server-side in
  `age_verification_events` (with an `audit_events` entry), and
  products and age restrictions have HTTP create/list routes.
- **Closed by Build-10:** the four Build-09 honest limits —
  `sales:read` is now ENFORCED across all 10 sales routes
  (AuthGuard + RequireScope, Obj 1); stock has HTTP create
  routes (warehouses + suppliers, Obj 2) so the lifecycle E2E
  creates stock purely over HTTP; sync flush `failed` outcomes
  now carry a structured `error_code` + the real message (Obj 3);
  and a variant created after a product-level rule now INHERITS
  it (Obj 3).
- **Closed by Build-11:** the four Build-10 honest limits —
  weighted-average cost is now exposed over HTTP (`GET
  /v1/inventory/balances` + `GET /v1/inventory/valuation`, Obj 1)
  and proven by the lifecycle E2E; `verified_at` is now the
  client-supplied till timestamp, persisted on
  `age_verification_events` (migration 018, Obj 2); the Obj 1
  E2E flake mechanism was found and fixed with the 3-gate
  bootstrap (Obj 3); and the inherited rule is now STORED
  (product-level row + `rule_source`), not derived (Obj 2).
- **Closed by Build-12:** all five Build-11 honest limits —
  the inventory-controller auth-coverage gap is closed
  (AuthGuard + RequireScope on every remaining inventory route,
  Obj 1); `createProduct` nested `ageRestriction` no longer
  400s (Obj 2); the age-restriction removal route exists (Obj
  2); the six unhardened E2E bootstraps are hardened to the
  3-gate pattern, plus two stragglers found by the sweep (Obj
  4); and the G-UI-06 gaps are closed — variant update,
  standalone purchase orders and customer-group assignment all
  have routes, typed clients and admin console wiring (Obj 3).
- **Build-12 limits (new, stated plainly):**
  - **Port collisions are NOT eliminated (TOCTOU gap):** the
    3-gate bootstrap makes a collision fail fast naming the
    cause instead of masquerading as a 401, but two processes can
    still race for a port between the free-check and the bind.
    All 16 server-booting E2E suites now use the hardened
    bootstrap; the two `apps/api/test/routes/` files
    (`build08-tax-rates`, `build09-products`) are service-level
    route tests that never boot a server, so the bootstrap does
    not apply to them.
  - **Pre-migration `verified_at` ≈ migration time for old
    rows:** migration 018 backfills existing
    `age_verification_events` rows with `NOW()` at migration
    time, so their `verified_at` is the migration timestamp, not
    the original till verification time. New rows carry the real
    client timestamp.
  - **`stock_valuation.quantity_on_hand` is a goods-in-time
    snapshot, not live:** the valuation row's quantity is
    stamped when goods are received; the live quantity is
    `stock_balances.quantity_on_hand` (what `/balances` reports).
    The two can diverge after sales until the next receipt.
  - **No create-group route:** groups are server-side only; the
    CRM console assigns members to existing groups but cannot
    create a group.
  - **The Update-variant form cannot clear a barcode:** blank
    means keep the current barcode (the API accepts
    `barcode: null` to clear it, but the form has no way to send
    it).
  - **The PO form takes one line only:** the standalone
    purchase-order form submits a single line; multi-line POs
    need the API directly.
- **Known failure (found by Obj 4 verification, NOT fixed — the
  test is outside Obj 4's scope; a follow-up decision):**
  `apps/admin-web/test/ui.test.ts:743` — `the suppliers section
  reports the missing route-table entry as a section error, never
  a page crash` (Build-10 Obj 2). The test asserts the
  intermediate state BEFORE Obj 4: its own comment says "Until
  Obj 4 adds the route-table entries, the typed client's
  listSuppliers resolves through routeFor and throws 'Unknown
  route key'". With the entries landed, the demo shell loads the
  demo supplier ("Demo Wholesale", `sup-demo-1`) instead of
  erroring, so `data.suppliers` is `[supplier]` rather than `[]`
  and the test failed. **FIXED by the parent during verification:**
  the test was rewritten to assert the post-Obj-4 behaviour —
  suppliers load from the demo client and no `Suppliers` section
  error is recorded. The full suite now reports 910/910; see
  [Running the tests](#running-the-tests).
- **Port collision (Build-08, fixed during Build-08 parent
  verification):** the two Build-08 admin-web E2E files
  (`test/build08-tax-rates.test.ts` and
  `test/build08-demo-seed-boot.test.ts`) both hardcoded the same
  ports (API 3427, admin 3431) and the default parallel run
  failed 6–8 tests. The parent moved the demo-seed-boot test to
  3527/3530/3531 (test-only change); admin-web now passes under
  default workers — see [Running the tests](#running-the-tests).
- **Defect found by Obj 3 verification, FIXED by the parent
  during verification (test-only, not a product defect):**
  `apps/admin-web/test/client.test.ts` — `createProduct POSTs the
  product body to /v1/catalogue/products (Build-09 Objective 1)`
  asserted the literal string `'Bearer <redacted>'` as the
  Authorization header, but the recording transport captures the
  real value (`'Bearer ukp_test-key'`); `<redacted>` is only
  vitest's display redaction. The parent changed the expectation
  to the sibling `listTaxRates` test's pattern (`/^Bearer \S+$/`);
  the suite now passes 831/831. The bug was masked until Obj 3
  because the test previously failed earlier on `Unknown route
  key: catalogue.createProduct`.
- **New limit (Obj 3):** the demo API key is a fixed public value,
  demo-only. `DEMO_SEED_ON_BOOT` must never be set in production,
  and the demo seed must never be pointed at a real database.
- **Stale doc note (not fixed — outside Obj 4 scope):**
  `apps/admin-web/src/ui/server.ts` still says the VAT period read
  "degrades as documented in shell.ts (G-UI-02)" — G-UI-02 was
  resolved in Build-06 (`GET /v1/reporting/vat-periods/:id`).
- PIN sessions are 2h stateless HMAC tokens with no server-side
  store; the dev-only secret fallback must be replaced before any
  deployment. No real 2FA provider is integrated.
- `DATABASE_URL` is never read by the API; setting it does not
  change the API's database (it is only for the G-A-13 check).
- The Build-04 "Honest limits" list above is a snapshot from that
  build: several of its items were closed by Build-05–08 (AES-256-GCM
  local cipher instead of SQLCipher; RN component layer; the
  `closeVatPeriod` in-place fix; voucher show-once; `setPriceBookEntry`
  routes; `pinLogin` 400/404; statutory archive persistence;
  tax-rates list route; sync-delta age flag; demo seed). The
  list in this section is the current one. The Build-09 closures
  (server-side age verification; product/age-restriction routes),
  the Build-10 closures (sales scope enforcement; warehouse/
  supplier routes; structured sync error codes; age-rule
  inheritance) and the Build-11 closures (cost/valuation over
  HTTP; stored product-level rules + `verified_at`; the flake
  mechanism fix) and the Build-12 closures (uniform inventory
  auth; nested age restriction + removal route; G-UI-06
  endpoints; 3-gate hardening of every server-booting E2E suite)
  are recorded in this section above.

**What comes after Build-12 (Sandbox Code Freeze — recommended only, NOT authorised):**
the two desk re-checks (Stripe SSA §13.6; Dojo reserve-hold clause
location); V1 merchant interviews; V2 catalogue trial; V3/V4 provider quotes and vendor
contact; the live-PostgreSQL G-A-13 run where Docker exists; a
true per-operator identity and rotation endpoint for the
platform-operator key; a merchant export
test with consent; V-04 professional advice engagement; or park
the programme. Each needs Salar's separate explicit
authorisation. The V1–V4 validation gates stay open.
Completing Build-12 authorises nothing further — the codebase is
frozen for external validation.


## Environment note

The commission named pnpm 10.9.4, but that version does not exist on the
npm registry (latest 10.x is 10.34.9; the installed npm is 10.9.4 — the
two were conflated). pnpm **12.18.0** is the version recorded in
`packageManager`. Node v24.22.1, npm 10.9.4.

**Runtime survival:** global installs outside the home directory do
not survive a VM replacement. On 14 Nov 2026 a runtime restart wiped
the globally installed pnpm (it had lived in `/usr/lib/node_modules`).
pnpm 12.18.0 is now installed at `~/.npm-global/bin/pnpm` (via
`npm install -g --prefix "$HOME/.npm-global" pnpm@12.18.0`); that path
persists because it is inside home. Every shell command that needs
pnpm must put `~/.npm-global/bin` on PATH first:
`export PATH="$HOME/.npm-global/bin:$PATH"`.

**`/tmp` is a 512MB tmpfs wiped on VM replacement.** Never write a
test log you need later to `/tmp`; use `~/workspace/` instead. The
E2E suite's per-run pgdata (~40–60MB each) can also fill it — the
suite self-cleans its temp dirs.

**Memory:** this machine has 6 GB. Run test suites sequentially and
the api package with `--maxWorkers=2` — parallel vitest forks have
been OOM-killed here more than once.

## Free Cloud Staging Deployment (Neon/Supabase + Render)

Staging pack: `render.yaml`, `.env.staging.example`,
`scripts/staging-check.sh` and the `pnpm staging:check` script.
Build-13 added the cloud-Postgres runtime adapter (no migration or
route changed): when `DATABASE_URL` is set the API connects to the
cloud Postgres with a real `pg` pool and applies pending migrations
on boot (see `packages/db/src/pg.ts`); when it is unset the API uses
PGlite exactly as before.

### 1. Create the free Postgres host

Create a free Postgres database on Neon or Supabase in **eu-west-2
(London)**. Copy the connection string — it must include
`sslmode=require`. Keep it in `.env.staging` (copy
`.env.staging.example` first); never commit a filled-in copy.

### 2. Migrate the cloud database and run live G-A-13

From the repo root, with `DATABASE_URL` pointing at the staging database:

```sh
DATABASE_URL=<redacted> pnpm staging:check
```

That runs `pnpm --filter @uk-pos/db concurrency:live`, which applies
all 19 migrations (001–019) to `DATABASE_URL` and then runs the live
multi-connection G-A-13 concurrency check against it. There is no
standalone `migrate` script in this repo. `concurrency:live` applies
migrations to a `DATABASE_URL` database before the check
(`packages/db/src/pg-concurrency-check.ts:327`) and refuses to fall
back to PGlite — and since Build-13 the API itself also applies any
pending migrations on boot when `DATABASE_URL` is set, so deploying
the API migrates the database as well. To re-run G-A-13 on its own
later, use the same command:

```sh
DATABASE_URL=<redacted> pnpm --filter @uk-pos/db concurrency:live
```

### 3. Create the Render services from render.yaml

In the Render dashboard: New → Blueprint, point it at this repo.
Three free Web Services are created: `uk-pos-api`, `uk-pos-register`,
`uk-pos-admin` (Frankfurt — Render has no London region; the database
stays in eu-west-2 London). Fill in every variable marked `sync: false`
in `render.yaml` in the Render dashboard (`DATABASE_URL`,
`WEBHOOK_ENCRYPTION_KEYS` / `WEBHOOK_ACTIVE_KEY_ID`,
`PLATFORM_OPERATOR_KEYS`, `REGISTER_APP_DEVICE_SECRET`). Then deploy.

### 4. Verify

Open the register UI (`uk-pos-register.onrender.com`) and the admin
shell (`uk-pos-admin.onrender.com`) in a desktop/tablet browser. With
`DEMO_SEED_ON_BOOT=true` both come up live against the seeded API
(demo tenant, demo catalogue, open session). Check the API status
endpoints, e.g. `https://uk-pos-api.onrender.com/payments/status`.

### What staging does NOT do

- **No live card processing.** Staging uses the simulated Stripe
  Terminal adapter — no real card payment can run on this stack.
- **No real customer data.** `DEMO_SEED_ON_BOOT=true` seeds a fixed
  demo tenant with fixed demo credentials; it is staging/demo only and
  must never be used with real customer PII or live card processing.
- **The Build-12 PGlite-only limit is closed by Build-13.** The API
  now reads `DATABASE_URL` and connects to the cloud Postgres with a
  real `pg` pool (`packages/db/src/pg.ts`), applying pending
  migrations on boot. PGlite is only used when `DATABASE_URL` is
  unset (local/test). The pg path is proven by construction +
  integration tests in this repo, not by a live cloud boot — no live
  cloud database exists in this environment yet — so run
  `staging:check` against the real database before treating staging
  as verified.
- **The register offline queue is not durable on free Render.** The
  register defaults to in-memory storage; a `REGISTER_SQLITE_PATH`
  file would sit on Render's ephemeral filesystem and be lost on
  redeploy/restart. Without `REGISTER_APP_DEVICE_SECRET` a local
  SQLite file is stored unencrypted (warning banner shown).
- **Statutory archive bundles** default to
  `<repo-root>/data/statutory-archives` (`STATUTORY_ARCHIVE_DIR`) —
  also ephemeral on free Render.
