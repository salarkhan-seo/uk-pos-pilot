# Register Tablet App — `@uk-pos/register-app` (Build-04, Objective 1)

Offline-first register for the UK POS pilot. Pure, framework-free
TypeScript view-models and controllers — **no React Native runtime
dependency**. Bind these to a React Native UI later; every workflow
here is testable without a device.

## What is in here

| Area | Files | Notes |
|---|---|---|
| Local storage | `src/storage/` | `StorageAdapter` interface + in-memory driver (all tests) + SQLite driver on Node 24's built-in `node:sqlite` (verified working here). Tables: `local_catalog_cache`, `local_cash_queue`, `sync_audit_log`, plus `local_parked_baskets`. |
| Offline bounds & guards | `src/offline/offline-guards.ts` | Hard bounds: 50 queued orders / 24h offline / £250 single cash sale, each with its reason banner. Online-only blocks: card, gift card issue/redeem, store credit issue/redeem, loyalty enrol/earn/redeem, voucher validation, stock counts, stock transfers, customer lookup — each with its banner. |
| Delta-sync | `src/sync/sync-client.ts` | `SyncClient` against the API's `/v1/sync/handshake` + `/v1/sync/flush` (FIFO, `created_at ASC`). Server-side: `apps/api/src/modules/sync/`. |
| Sell screen | `src/sell/sell-controller.ts`, `line-pricing.ts` | Barcode scan via the **shared** parser (`apps/api/src/modules/catalogue/barcode.ts`, imported not copied), SKU/name search, quick-key grid, customer attach (online only), parked baskets (draft, **zero stock reservation**). Each line exposes base / price-book / promotion / manual / final price. |
| Age gate | `src/sell/age-gate.ts` | Challenge 25: blocks checkout until confirmed (records `verified_age_threshold` only) or logs a refusal. **Never stores a customer DOB** — no DOB field exists anywhere in this package. |
| Split tender & W-12 | `src/sell/split-tender.ts` | Multi-tender, 5-minute timeout. On any `unknown` card attempt the register locks on the verbatim modal "Payment outcome unknown — do not hand over goods on card until checked" with the 3 resolution actions (Poll Provider Status, Reconcile Terminal, Manager Approval to Void/Retry or Record Standalone Reference). |
| Till session | `src/session/till-session.ts` | Open (D-07 zero-float warning + manager override), cash in/out + petty cash (£50 approval threshold), two-step End vs blind Close, D-08 variance approval at max(£10, 2% of expected cash). Z-report generation is **delegated** to the API reporting service via the typed `ReportingClient` — no Z-report logic is reimplemented locally. |
| Hardware | `src/hardware/` | Simulated `StripeTerminalHardwareAdapter` (S700 Wi-Fi / WisePad 3 Bluetooth, battery/firmware telemetry, pre-dip/tap block until ready), `EscPosReceiptPrinterAdapter` (Star TSP143IV / Epson TM-m30III: itemised lines, promotion names, per-rate VAT [Net, VAT, Gross], "This is not a VAT invoice", RJ12 drawer-kick bytes `1B 70 00 19 FA`), `CustomerDisplayAdapter` (line items, discounts, **single tax total — never per-rate VAT**, Arch-01 §3.3). No live hardware, no network. |

## Offline rules the register enforces

- **Cash only offline** (D-06 deferred): card, gift card, store credit,
  loyalty and vouchers are blocked with banners while offline.
- **Price-book pricing and role-bounded manual discounts work
  offline.** A discount above the cashier's role limit needs a manager
  PIN, verified against the manager's stored scrypt hash
  (`verifyPin`); only an opaque approval reference is recorded —
  the PIN is never stored.
- **Offline lines carry promotion discount 0**: automatic promotions
  are evaluated server-side at flush. The snapshot total is what the
  customer paid in cash; if the server reprices differently, the flush
  records a non-blocking discrepancy warning (see below).
- **Parked baskets hold zero stock**: parking writes a local draft
  row only. Stock is reserved at the first tender, server-side
  (G-A-13).

## Sync semantics (client + server)

- Handshake returns server time, tenant/register state, and the
  catalogue delta (variants changed since `since`, tax rates, active
  price-book entries, barcode mode, cached stock with `computed_at`).
  Cached stock is a **display hint only**, never authoritative.
- Flush replays queued offline cash orders FIFO through the existing
  `SalesService`/`InventoryService` paths with the order's original
  idempotency key (a replay returns the stored outcome, no second
  order).
- **Price changes while offline**: the server reprices at current
  prices (authoritative for VAT). If the server total exceeds the
  snapshot, a D-14 basket discount bridges it down to the snapshot
  amount the customer paid, with a discrepancy warning. If the server
  total is lower, the order totals the server price and the cash
  overpayment is recorded as a warning (excess stays in the till,
  reconciled at close).
- **Stock shortfalls**: a completed physical cash sale is never
  voided or dropped. The flush writes a `stock_movements` row with
  `cause = 'offline_sync_conflict'` for the shortfall (the commission
  calls the column `movement_type`; the Build-01 schema names it
  `cause` and `'offline_sync_conflict'` is already one of its CHECK
  values), completes the order, and records a hash-chained audit
  alert. **Design decision**: `stock_balances` has a CHECK
  (`quantity_on_hand >= 0`), so the read-model balance floors at 0
  while the append-only ledger carries the true negative shortfall —
  the two diverge by exactly the shortfall until the next goods-in,
  and the divergence is visible in the audit alert rather than hidden.

## Design decisions (not research facts)

- Role discount limits are imported from
  `apps/api/src/common/roles.ts` (single source of truth) and the
  barcode parser from `apps/api/src/modules/catalogue/barcode.ts`
  (imported, never copied). That cross-app import is a pilot coupling:
  both belong in `@uk-pos/shared-kernel` in a later build, and the
  register app's `tsconfig.build.json` uses `rootDir: ../..` so the
  build can emit those two files alongside. The `@nestjs/common`
  dependency exists only because the shared parser throws
  `BadRequestException`.
- The SQLite driver stores bigint pence as TEXT (exact round-trip;
  `node:sqlite` returns INTEGERs as JS numbers and throws RangeError
  above `Number.MAX_SAFE_INTEGER`).
- The register app's `pnpm build` emits the two reused API source
  files under `dist/apps/api/...` alongside the app — see above.
- Flush payload quantities are **base units** (the server conflict
  path treats them as such).

## Honest limits

- **No encryption at rest.** The commission names an encrypted
  SQLCipher adapter; SQLCipher is a native dependency this
  environment cannot build, so the SQLite driver stores plaintext.
  Device-level encryption (OS full-disk / MDM) is the only at-rest
  protection until a SQLCipher-backed driver lands. No card data,
  PINs, or full gift/voucher codes are ever written locally.
- **No physical tablet or hardware attached.** The terminal, printer
  and customer-display adapters are simulated; no live reader,
  printer or display has been exercised.
- **Age restrictions are not in the handshake delta yet.** The
  server exposes `age_restrictions` per variant but the delta does
  not carry the flag, so the local cache keeps its existing
  `requiresChallenge25` value for known variants and defaults new
  variants to `false`. The gate itself is fully implemented and
  tested; wiring the flag into the delta is a follow-up.
- **Weight-embedded barcodes** resolve the SKU; the weighed quantity
  is keyed by the cashier — no scale integration exists yet.
- **No React Native UI.** The view-models are framework-free and
  ready to bind; no screens have been built.

## Running the tests

```sh
pnpm --filter @uk-pos/register-app test      # vitest, in-memory + node:sqlite drivers
pnpm --filter @uk-pos/register-app typecheck
pnpm --filter @uk-pos/api test -- test/sync  # server handshake + flush suite
```
