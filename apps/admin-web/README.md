# @uk-pos/admin-web — Admin Web Dashboard / Back-Office (Build-04 Objective 2)

Framework-free TypeScript back-office application: a typed API client
plus view controllers/components wired to `apps/api`. No React/Next
runtime dependency — the view layer is view-models plus plain
string/template rendering (`src/render.ts`), testable in Node without
a browser.

## Layout

```
apps/admin-web/
├── src/
│   ├── api/
│   │   ├── types.ts        # wire types (money = decimal-string pence)
│   │   ├── errors.ts       # 401/403/404/409/429 mapping; TerminationBlockedError; NotExposedError
│   │   ├── route-table.ts  # live vs not-exposed route table (single source of truth)
│   │   ├── http.ts         # injectable transport; Bearer / X-Api-Key + x-tenant-id headers
│   │   ├── client.ts       # PosApiClient (live) + AdminApiClient interface
│   │   └── fake-client.ts  # in-memory fake implementing the full interface (tests)
│   ├── catalogue/          # studio (variants, price books, promotions, vouchers) + validation
│   ├── inventory/          # receiving form (defaults 0), console (stock/transfers/reorder/PO/counts)
│   ├── crm/                # customers, consents, loyalty, liabilities, GDPR export/erasure
│   ├── finance/            # abuse reports, hash-chain + manifest integrity, CSV downloads,
│   │                       # webhooks/DLQ, Z-report/VAT/settlement view-models, exit portal
│   ├── render.ts           # framework-free HTML string helpers
│   └── index.ts
└── test/                   # vitest: client, catalogue, inventory, crm, finance
```

## How to run

```sh
pnpm --filter @uk-pos/admin-web test       # vitest (fake client only — never a live server)
pnpm --filter @uk-pos/admin-web typecheck  # tsc --noEmit
pnpm --filter @uk-pos/admin-web build      # tsc to dist/
```

## Auth

The client takes a caller-supplied credential — a scoped API key
(`ukp_…`) or a PIN-session token — sent as `Authorization: Bearer
<token>` (or `X-Api-Key` for keys). `x-tenant-id` is sent when the
tenant is known. Cross-tenant access is 404, never 403 (G-B). The
Build-02 demo-header routes still read the actor from
`x-tenant-id` / `x-user-id` / `x-location-id` / `x-roles`; pass those
explicitly via `demoActor` — the client never invents them. Demo
headers are local/test auth only.

Error mapping: 401 unauthenticated; 403 scope vs `403 PLAN_GATED`
(tier gate) distinguished; 404 not-found-or-not-yours; 409 D-11
termination blocked (exact blocking ids carried);
429 `RATE_LIMITED` with `Retry-After` seconds.

## Route status — read this before wiring a console to "live"

Verified against the Build-03 controllers. **Live over HTTP:**
audit-events, approvals, api-keys, catalogue variants / price-basket /
barcode-parse, inventory counts / goods-in / stock, sales orders /
tenders / complete / void / returns / refunds / receipt, GET
/v1/events, and the module status endpoints.

**Service exists, NO HTTP route yet** (see `src/api/route-table.ts`
for the full list with the service method and proposed route):
PIN login (`SessionService.login` — no auth controller at all);
everything in `ReportingService` (sessions, Z-reports, VAT periods,
CSV export, settlement); `ExitService` / `ExportService` /
`GdprService` (termination, full export, per-customer export/erasure,
hard delete); webhook admin actions (register/disable/replay/discard —
only GET /v1/events is live); and all Phase-2 structural tables
(price books, promotions, vouchers, warehouses, transfers, reorder
suggestions, purchase orders, customers, consents, loyalty, gift
cards, store credit) — schema + pricing pipeline exist, no CRUD
controller routes were shipped in Build-02/03.

The live client **never guesses a URL** for these: it throws
`NotExposedError` naming the service method and proposed route. The
fake client implements them in memory, so every console is fully
testable today; flipping a method to live is a route-table change
plus the client method — no console changes.

## Design decisions (decisions, not research findings)

| ID | Decision | Value |
|---|---|---|
| D-AW-01 | Money on the wire | Decimal-string integer pence (JSON has no bigint), matching the API controllers |
| D-AW-02 | Auth | Caller-supplied API key or PIN-session token as Bearer (or X-Api-Key); `x-tenant-id` when known; demo actor headers explicit opt-in only |
| D-AW-03 | Unexposed surfaces | Typed route descriptors with `live: false`; live client throws `NotExposedError` (service + proposed route); fake implements them in memory |
| D-AW-04 | Basket preview | Always via `POST /v1/catalogue/price-basket` (Arch-10 pipeline order); no local pricing reimplementation |
| D-AW-05 | Goods-in receiving | Every line defaults received quantity to `0` (never pre-filled); damaged/short are separate inputs; received+damaged+short ≤ ordered (client check; server authoritative) |
| D-AW-06 | Voucher / gift-card display | Only `code_last4` + usage metrics; any full-code field in a payload is stripped and reported, never rendered |
| D-AW-07 | Integrity verification | Shared-kernel `verifyHashChain` (audit) and `sha256Hex` (export manifest); never reimplemented locally |
| D-AW-08 | Abuse-report thresholds | Dashboard display rules only: 5+ manual discounts, 3+ voids, or £100+ discounts/comps in the window → `review` flag for a manager; not a finding of misconduct |
| D-AW-09 | View layer | Framework-free string rendering; no browser runtime; no browser rendering tested |
| D-AW-10 | GDPR erasure | Two-step: `requestErasure` returns the acknowledgement; only `confirmErasure(..., acknowledged=true)` calls the API |
| D-AW-11 | Stock balance staleness | `computed_at` older than 15 minutes is shown STALE (display hint only; the live stock endpoint returns ledger sums) |
| D-AW-12 | Loyalty points | Balance = sum of the append-only ledger; 1 pt = 1p at tender time (Build-02 decision, reused) |

## Honest limits

- **No browser rendering tested.** The view layer produces HTML
  strings; mounting them in a real browser shell is a follow-up.
- **No live server is called in tests.** All tests run against the
  fake client; live-client tests use a recording transport.
- **Reporting / exit / GDPR / webhook-admin / Phase-2 CRUD consoles
  run against the fake** until the coordinator adds the HTTP routes
  listed in `route-table.ts` — the live client refuses those calls
  rather than guessing URLs.
- **Audit-chain verification** reverses the newest-first
  `/v1/audit-events` listing into creation order; rows sharing an
  identical `created_at` could order ambiguously (the server orders
  by `created_at, id`).
- **The fake's `priceBasket`** mirrors the response shape, not the
  server's Arch-10 arithmetic — real pricing is always the server's.
- **Statutory VAT archive persistence** (6-year, compliance storage)
  is a coordinator follow-up from Build-03; the exit portal shows the
  archive status as reported by the API and does not claim storage.
