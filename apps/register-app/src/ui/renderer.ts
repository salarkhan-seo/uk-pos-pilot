/**
 * Register Tablet UI — HTML renderer (Build-05, Objective 4).
 *
 * Dependency-free: renders HTML strings from TypeScript, no
 * framework, no external assets. Every value shown comes from the
 * RegisterUiState snapshot (which itself is read from the real
 * view-models) or from the pure hardware formatters
 * (`formatReceipt` / `formatCustomerDisplay`).
 *
 * Honesty rules enforced here:
 * - The receipt preview uses `formatReceipt` with a per-rate VAT
 *   table (D-13, via `mixedBasketBreakdown`) and the exact text
 *   "This is not a VAT invoice".
 * - The customer display preview uses `formatCustomerDisplay` and
 *   therefore shows a SINGLE tax total — never a per-rate breakdown
 *   (Arch-01 §3.3).
 * - The Challenge 25 modal has Approve / Refuse buttons and NO
 *   date-of-birth field of any kind.
 * - The W-12 modal shows the verbatim message from
 *   `UNKNOWN_PAYMENT_MESSAGE` with the 3 resolution actions.
 * - Offline-only actions render `disabled` with the explicit reason
 *   banner from `offline-guards.ts`.
 */
import { formatPounds, mixedBasketBreakdown, TAX_RATES, type TaxRateKind } from '@uk-pos/shared-kernel';
import { UNKNOWN_PAYMENT_MESSAGE, SPLIT_TENDER_TIMEOUT_MS } from '../constants';
import {
  OFFLINE_BANNERS,
  type OnlineOnlyFeature,
} from '../offline/offline-guards';
import { formatCustomerDisplay, type CustomerDisplayInput } from '../hardware/customer-display';
import { formatReceipt, VAT_INVOICE_NOTICE, type ReceiptInput } from '../hardware/receipt-printer';
import type { RegisterUiState } from './state';

export { VAT_INVOICE_NOTICE, UNKNOWN_PAYMENT_MESSAGE };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pounds(pence: bigint): string {
  return formatPounds(pence);
}

function ratePercent(kind: string): string {
  const rate = (TAX_RATES as Record<string, { rateNum: bigint; rateDen: bigint }>)[kind];
  if (!rate) return '0.00';
  const pct = (rate.rateNum * 100n) / rate.rateDen;
  return `${pct.toString()}.00`;
}

/** Per-rate VAT lines for the receipt, computed from the live basket (D-13). */
export function buildReceiptInput(state: RegisterUiState): ReceiptInput {
  const breakdown = mixedBasketBreakdown(
    state.lines.map((line) => ({
      totalPence: line.lineTotalPence,
      rateKind: (line.taxRateKind ?? 'exempt') as TaxRateKind,
    })),
  );
  return {
    shopName: state.shopName,
    receiptNumber: state.receiptNumber,
    issuedAt: new Date(),
    lines: state.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPricePence: line.finalPricePence,
      lineTotalPence: line.lineTotalPence,
    })),
    totalPence: state.lines.reduce((sum, line) => sum + line.lineTotalPence, 0n),
    vatLines: breakdown.lines.map((line) => ({
      taxRateKind: line.rateKind,
      taxRatePercent: ratePercent(line.rateKind),
      netPence: line.netPence,
      vatPence: line.vatPence,
      grossPence: line.grossPence,
    })),
  };
}

/** Customer display input: a single tax total only (Arch-01 §3.3). */
export function buildCustomerDisplayInput(state: RegisterUiState): CustomerDisplayInput {
  const breakdown = mixedBasketBreakdown(
    state.lines.map((line) => ({
      totalPence: line.lineTotalPence,
      rateKind: (line.taxRateKind ?? 'exempt') as TaxRateKind,
    })),
  );
  return {
    lines: state.lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      lineTotalPence: line.lineTotalPence,
      discountPence: line.promotionDiscountPence + line.manualDiscountPence,
    })),
    taxTotalPence: breakdown.totals.vatPence,
    totalPence: state.lines.reduce((sum, line) => sum + line.lineTotalPence, 0n),
  };
}

/** Remaining split-tender countdown (5 minutes from the first tender). */
export function splitTenderCountdownMs(state: RegisterUiState): number | null {
  const split = state.splitTender;
  if (!split || split.firstTenderAtMs === null) return null;
  const remaining = SPLIT_TENDER_TIMEOUT_MS - (split.nowMs - split.firstTenderAtMs);
  return remaining > 0 ? remaining : 0;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString()}:${seconds.toString().padStart(2, '0')}`;
}

// -- API connectivity ------------------------------------------------------

export function renderApiBanner(state: RegisterUiState): string {
  if (state.apiReachable === false) {
    return `<div class="banner offline-banner" id="api-unreachable-banner">API unreachable at ${escapeHtml(state.apiBaseUrl)} — working offline with ${state.liveCatalogue ? 'the last synced catalogue' : 'the demo catalogue'}. Cash sales queue locally; card, loyalty, gift card and voucher actions are unavailable until the register reconnects.</div>`;
  }
  if (state.liveCatalogue) {
    return `<div class="banner online-banner" id="api-live-banner">Live — connected to the API at ${escapeHtml(state.apiBaseUrl)}; catalogue synced${state.lastSyncAt ? ` ${escapeHtml(state.lastSyncAt)}` : ''}.</div>`;
  }
  if (state.apiReachable === true) {
    return `<div class="banner" id="api-connected-banner">Connected to the API at ${escapeHtml(state.apiBaseUrl)} — catalogue not synced yet. Use “Sync catalogue” below.</div>`;
  }
  return '';
}

// -- Offline -----------------------------------------------------------------

const OFFLINE_BUTTONS: Array<{ feature: OnlineOnlyFeature; label: string; action: string }> = [
  { feature: 'card_payment', label: 'Card', action: 'card' },
  { feature: 'gift_card_redeem', label: 'Gift Card', action: 'gift-card' },
  { feature: 'loyalty_redeem', label: 'Loyalty', action: 'loyalty' },
  { feature: 'voucher_validation', label: 'Voucher', action: 'voucher' },
  { feature: 'customer_lookup', label: 'Customer Lookup', action: 'customer-lookup' },
];

export function renderOfflineBanners(state: RegisterUiState): string {
  if (state.online) return '';
  const banners = OFFLINE_BUTTONS.map(
    (button) =>
      `<div class="banner offline-banner" data-offline-feature="${button.feature}">${escapeHtml(
        OFFLINE_BANNERS[button.feature],
      )}</div>`,
  ).join('\n');
  return `<section id="offline-banners" aria-label="Offline restrictions">
    <div class="banner offline-banner" id="connectivity-banner">Offline — cash only. Card, gift card, loyalty and voucher actions are unavailable until the register reconnects.${state.offlineSinceMs !== null ? ` Offline since ${escapeHtml(new Date(state.offlineSinceMs).toISOString())}.` : ''} ${state.queuedCount} offline order(s) queued.</div>
    ${banners}
  </section>`;
}

export function renderOnlineBanner(state: RegisterUiState): string {
  if (!state.online) return '';
  return `<div class="banner online-banner" id="connectivity-banner">Online — all payment methods available.</div>`;
}

// -- Sell screen ---------------------------------------------------------------

function renderBasketLine(line: RegisterUiState['lines'][number], index: number): string {
  const gross = line.unitPricePence * line.quantity;
  return `<tr data-line-index="${index}">
    <td>${escapeHtml(line.name)}<br><small>${escapeHtml(line.sku)} × ${line.quantity.toString()}</small></td>
    <td data-price="base">${pounds(line.basePricePence)}</td>
    <td data-price="price-book">${line.priceBookPricePence === null ? '—' : pounds(line.priceBookPricePence)}</td>
    <td data-price="promo">−${pounds(line.promotionDiscountPence)}</td>
    <td data-price="manual">−${pounds(line.manualDiscountPence)}</td>
    <td data-price="final"><strong>${pounds(line.finalPricePence)}</strong> each</td>
    <td data-price="line-total"><strong>${pounds(line.lineTotalPence)}</strong></td>
  </tr>
  <tr class="line-breakdown"><td colspan="7">Base ${pounds(line.basePricePence)} → price book ${line.priceBookPricePence === null ? '—' : pounds(line.priceBookPricePence)} (unit ${pounds(line.unitPricePence)}) → promo −${pounds(line.promotionDiscountPence)} → manual −${pounds(line.manualDiscountPence)} → final ${pounds(line.finalPricePence)} each, line total ${pounds(line.lineTotalPence)}${line.requiresChallenge25 ? ' — Challenge 25 applies' : ''}</td></tr>`;
}

export function renderSellScreen(state: RegisterUiState): string {
  const total = state.lines.reduce((sum, line) => sum + line.lineTotalPence, 0n);
  const quickKeys = state.quickKeys
    .map(
      (key) =>
        `<button type="submit" name="sku" value="${escapeHtml(key.sku)}" class="quick-key" data-quick-key="${escapeHtml(key.sku)}">${escapeHtml(key.label)}${key.pricePence !== null ? `<br><small>${pounds(key.pricePence)}</small>` : ''}</button>`,
    )
    .join('\n');
  const tenderButtons = OFFLINE_BUTTONS.map((button) => {
    const disabled = !state.online ? ' disabled aria-disabled="true"' : '';
    return `<button type="button" class="tender-btn" data-feature="${button.feature}" data-action="${button.action}"${disabled}>${button.label}</button>`;
  }).join('\n');
  const basketEmpty = state.lines.length === 0;
  const searchResults =
    state.searchResults === null
      ? ''
      : `<div id="search-results" aria-label="Catalogue search results">
      ${state.searchResults.length === 0 ? `<p>No matches for “${escapeHtml(state.searchQuery ?? '')}”.</p>` : state.searchResults.map((result) => `<form method="post" action="/action" class="inline-form"><input type="hidden" name="action" value="quick-key"><button type="submit" name="sku" value="${escapeHtml(result.sku)}" data-search-result="${escapeHtml(result.sku)}">${escapeHtml(result.name)} — ${pounds(result.pricePence)}</button></form>`).join('\n')}
    </div>`;
  const parked =
    state.parkedCount === 0
      ? ''
      : `<div id="parked-baskets" aria-label="Parked baskets">
      <h3>Parked baskets</h3>
      ${state.parkedLocalIds.map((localId) => `<form method="post" action="/action" class="inline-form"><input type="hidden" name="action" value="resume-park"><button type="submit" name="local-id" value="${escapeHtml(localId)}" data-parked-basket="${escapeHtml(localId)}">Resume parked basket ${escapeHtml(localId.slice(0, 8))}</button></form>`).join('\n')}
    </div>`;
  const lastSync = state.lastSyncAt
    ? `Last catalogue sync ${escapeHtml(state.lastSyncAt)}.`
    : 'Catalogue not synced yet.';
  const lastFlush = state.lastFlush
    ? `Last flush ${escapeHtml(state.lastFlush.at)}: ${state.lastFlush.synced} synced, ${state.lastFlush.conflicts} conflict(s), ${state.lastFlush.failed} failed.`
    : 'Queue never flushed.';
  const lastSale =
    state.liveOrder === null
      ? ''
      : `<div id="last-sale" aria-label="Last completed sale">
      <h3>Last completed sale (live)</h3>
      <p>Order <code>${escapeHtml(state.liveOrder.orderId)}</code> — receipt #${escapeHtml(state.liveOrder.receiptNumber)} — total <strong>${pounds(state.liveOrder.totalPence)}</strong>.</p>
      <ul>${state.liveOrder.receiptLines.map((line) => `<li>${escapeHtml(line.taxRateKind)} ${escapeHtml(line.taxRatePercent)}% — net ${pounds(line.netPence)}, VAT ${pounds(line.vatPence)}, gross ${pounds(line.grossPence)}</li>`).join('\n')}</ul>
    </div>`;
  const openOrder =
    state.liveOrderOpen === null
      ? ''
      : `<div id="open-live-order" aria-label="Open live order">
      <h3>Open live order</h3>
      <p>Order <code>${escapeHtml(state.liveOrderOpen.orderId)}</code> — total <strong>${pounds(state.liveOrderOpen.totalPence)}</strong> — is waiting on the API (a card tender was declined or is unresolved). Complete it from the pending attempts above, or void it with a manager approval to re-take the sale from the same basket.</p>
      <form method="post" action="/action" class="inline-form">
        <label for="open-order-manager-pin">Manager PIN (voids the live order)</label>
        <input id="open-order-manager-pin" name="manager-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••">
        <button type="submit" name="action" value="w12-manager" data-resolution="manager_void_or_retry">Void order — manager approval</button>
      </form>
    </div>`;
  const pendingCards =
    state.pendingCardAttempts.length === 0
      ? ''
      : `<div id="pending-card-attempts" aria-label="Card terminal results needed">
      <h3>Card terminal result needed</h3>
      <p>Key in the result the terminal showed for each card attempt. “Unknown” locks the register on the W-12 modal.</p>
      ${state.pendingCardAttempts.map((attempt) => `<form method="post" action="/action" class="inline-form">
        <input type="hidden" name="action" value="card-outcome">
        <input type="hidden" name="attempt-id" value="${escapeHtml(attempt.attemptId)}">
        <span>Attempt <code>${escapeHtml(attempt.attemptId.slice(0, 8))}</code> — ${pounds(attempt.amountPence)}</span>
        <select name="outcome" aria-label="Terminal result">
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
          <option value="unknown">Unknown</option>
        </select>
        <button type="submit" data-testid="card-outcome">Record result</button>
      </form>`).join('\n')}
    </div>`;
  return `<section id="sell-screen" aria-label="Sell screen">
    <h2>Sell</h2>
    <form method="post" action="/action" class="barcode-form">
      <label for="barcode">Barcode</label>
      <input id="barcode" name="barcode" type="text" inputmode="numeric" autocomplete="off" placeholder="Scan or type barcode" autofocus>
      <button type="submit" name="action" value="scan">Add</button>
    </form>
    <form method="post" action="/action" class="search-form">
      <label for="search-query">Search catalogue</label>
      <input id="search-query" name="search-query" type="search" autocomplete="off" placeholder="SKU or name" value="${escapeHtml(state.searchQuery ?? '')}">
      <button type="submit" name="action" value="search">Search</button>
    </form>
    ${searchResults}
    <div class="quick-keys" aria-label="Quick keys">
      <form method="post" action="/action"><input type="hidden" name="action" value="quick-key">${quickKeys}</form>
    </div>
    <table class="basket" aria-label="Basket">
      <thead><tr><th>Item</th><th>Base</th><th>Price book</th><th>Promo</th><th>Manual</th><th>Final</th><th>Line total</th></tr></thead>
      <tbody>
        ${state.lines.length === 0 ? '<tr><td colspan="7">Basket is empty — scan a barcode or tap a quick key.</td></tr>' : state.lines.map(renderBasketLine).join('\n')}
      </tbody>
      <tfoot><tr><td colspan="6">Basket total</td><td data-testid="basket-total"><strong>${pounds(total)}</strong></td></tr></tfoot>
    </table>
    <div class="basket-actions">
      <span class="parked-badge" id="parked-baskets-badge">Parked baskets (${state.parkedCount})</span>
      <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="park"${basketEmpty ? ' disabled' : ''}>Park basket</button></form>
      <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="clear"${basketEmpty ? ' disabled' : ''}>Clear basket</button></form>
      <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="checkout-online"${!state.online || basketEmpty ? ' disabled' : ''}>Checkout — online</button></form>
      <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="checkout-cash"${state.online || basketEmpty ? ' disabled' : ''}>Checkout — offline cash</button></form>
    </div>
    ${parked}
    ${lastSale}
    ${openOrder}
    ${pendingCards}
    <div class="sync-controls" aria-label="Catalogue sync and queue flush">
      <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="sync-catalogue">Sync catalogue</button></form>
      <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="sync-flush"${state.queuedCount === 0 ? ' disabled' : ''}>Flush queue (${state.queuedCount})</button></form>
      <p class="hint">${escapeHtml(lastSync)} ${escapeHtml(lastFlush)}${state.lastSyncError ? ` Sync error: ${escapeHtml(state.lastSyncError)}` : ''}</p>
    </div>
    <div class="tender-buttons" aria-label="Payment methods">${tenderButtons}
      <button type="button" class="tender-btn" data-action="cash">Cash</button>
      <button type="button" class="tender-btn" data-action="split-tender">Split tender</button>
    </div>
    <p class="hint">Card, gift card, loyalty and voucher actions are online-only and are disabled while offline, with the reason shown above.</p>
  </section>`;
}

// -- Modals --------------------------------------------------------------------

export function renderChallenge25Modal(state: RegisterUiState): string {
  const show = state.ageGate.required && state.ageGate.verifiedThreshold === null;
  if (!show) {
    if (state.ageGate.verifiedThreshold !== null) {
      return `<div id="challenge-25-modal" class="modal verified" data-verified-threshold="${state.ageGate.verifiedThreshold}"><p>Challenge 25 verified (threshold ${state.ageGate.verifiedThreshold}).</p></div>`;
    }
    return '';
  }
  return `<div id="challenge-25-modal" class="modal" role="dialog" aria-label="Challenge 25 age verification">
    <h3>Challenge 25 — Age Verification</h3>
    <p>Age-restricted item(s) in the basket: ${state.ageGate.requiredSkus.map(escapeHtml).join(', ')}. Check ID and confirm the customer is 25 or over, or refuse the sale of those items.</p>
    <p class="hint">Only the verified age threshold (25) is recorded.</p>
    <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="age-approve" data-testid="age-approve">Approve</button></form>
    <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="age-refuse" data-testid="age-refuse">Refuse</button></form>
  </div>`;
}

export function renderW12Modal(state: RegisterUiState): string {
  const split = state.splitTender;
  if (!split || !split.locked || split.blockingMessage === null) return '';
  return `<div id="w12-modal" class="modal blocking" role="alertdialog" aria-label="Unknown payment">
    <h3>Payment blocked — W-12</h3>
    <p class="w12-message">${escapeHtml(split.blockingMessage)}</p>
    <p>Do not hand over goods on card until checked. No further tender can be taken until this is resolved.</p>
    <div class="w12-actions">
      <form method="post" action="/action" class="inline-form">
        <label for="w12-outcome">Terminal result</label>
        <select id="w12-outcome" name="w12-outcome">
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
        </select>
        <button type="submit" name="action" value="w12-poll" data-resolution="poll_provider_status">1. Poll Provider Status</button>
      </form>
      <form method="post" action="/action" class="inline-form">
        <label for="terminal-evidence">Reader report reference</label>
        <input id="terminal-evidence" name="terminal-evidence" type="text" placeholder="e.g. S700 report 2026-11-14/07">
        <button type="submit" name="action" value="w12-reconcile" data-resolution="reconcile_terminal">2. Reconcile Terminal</button>
      </form>
      <form method="post" action="/action" class="inline-form">
        <label for="w12-manager-pin">Manager PIN (voids the live order)</label>
        <input id="w12-manager-pin" name="manager-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••">
        <button type="submit" name="action" value="w12-manager" data-resolution="manager_void_or_retry">3. Manager Approval to Void/Retry or Record Standalone Reference</button>
      </form>
      <form method="post" action="/action" class="inline-form">
        <label for="standalone-reference">Standalone terminal reference</label>
        <input id="standalone-reference" name="standalone-reference" type="text" placeholder="Physical terminal reference">
        <label for="w12-standalone-pin">Manager PIN</label>
        <input id="w12-standalone-pin" name="manager-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••">
        <button type="submit" name="action" value="w12-manager-standalone" data-resolution="manager_standalone_reference">4. Manager: record standalone terminal reference</button>
      </form>
    </div>
    <p class="hint">Live wiring: actions 1–2 record the terminal result you key in against the server payment attempt (the API's stand-in for the terminal callback). Action 3 voids the attempt server-side (records “declined”, so the order stays open for a fresh card tender) and needs a manager approval — use the Manager PIN pad first. Action 4 records the attempt approved against the physical terminal reference you typed in, and also needs a manager approval. With no server attempt (simulated unknown), the actions resolve locally only.</p>
  </div>`;
}

export function renderSplitTenderModal(state: RegisterUiState): string {
  const split = state.splitTender;
  if (!split) return '';
  const countdownMs = splitTenderCountdownMs(state);
  const countdown = countdownMs === null ? '5:00' : formatCountdown(countdownMs);
  const tenders = split.tenders
    .map((t) => `<li>${escapeHtml(t.kind)} — ${pounds(t.amountPence)}</li>`)
    .join('\n');
  return `<div id="split-tender-modal" class="modal" role="dialog" aria-label="Split tender">
    <h3>Split Tender</h3>
    <p>Total ${pounds(split.totalPence)} — Tendered ${pounds(split.tenderedPence)} — Remaining <strong>${pounds(split.remainingPence)}</strong></p>
    <p>Time remaining: <span id="split-tender-countdown" data-countdown-ms="${countdownMs === null ? SPLIT_TENDER_TIMEOUT_MS : countdownMs}">${countdown}</span> (5-minute limit from the first tender${split.firstTenderAtMs === null ? ' — countdown starts on the first tender' : ''})</p>
    ${split.timedOut ? '<p class="banner offline-banner">Split tender timed out after 5 minutes: the sale was unwound — start again from draft.</p>' : ''}
    <ul>${tenders === '' ? '<li>No tenders yet.</li>' : tenders}</ul>
    <form method="post" action="/action" class="tender-form">
      <label for="tender-kind">Tender</label>
      <select id="tender-kind" name="tender-kind">
        <option value="cash">Cash</option>
        <option value="card">Card</option>
        <option value="gift_card">Gift card</option>
        <option value="store_credit">Store credit</option>
        <option value="loyalty_points">Loyalty points</option>
      </select>
      <label for="tender-amount-pence">Amount (pence)</label>
      <input id="tender-amount-pence" name="tender-amount-pence" type="number" min="1" value="${split.remainingPence.toString()}">
      <button type="submit" name="action" value="add-tender"${split.locked || split.timedOut ? ' disabled' : ''}>Add tender</button>
    </form>
    <form method="post" action="/action" class="inline-form"><button type="submit" name="action" value="mark-unknown">Simulate card attempt unknown (W-12)</button></form>
    ${split.complete ? '<p class="banner online-banner">Split tender complete.</p>' : ''}
  </div>`;
}

export function renderManagerPinModal(state: RegisterUiState): string {
  return `<div id="manager-pin-modal" class="modal" role="dialog" aria-label="Manager PIN approval">
    <h3>Manager PIN Approval</h3>
    <p>Enter the manager PIN to approve a discount above the role limit, a petty-cash movement, or a W-12 manager resolution. The PIN is verified, never stored, and only an opaque approval reference is recorded${state.pinApprovalRef ? ` — current approval: <code>${escapeHtml(state.pinApprovalRef)}</code>` : ''}.</p>
    <form method="post" action="/action" class="pin-form">
      <label for="tenant-id">Tenant ID</label>
      <input id="tenant-id" name="tenant-id" type="text" autocomplete="off" value="${escapeHtml(state.tenantId)}">
      <label for="manager-user-id">Manager user ID</label>
      <input id="manager-user-id" name="manager-user-id" type="text" autocomplete="off" value="${escapeHtml(state.userId)}">
      <label for="manager-pin">Manager PIN</label>
      <input id="manager-pin" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••">
      <div class="pin-pad" aria-label="PIN pad">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => `<button type="button" class="pin-key" data-pin-key="${d}">${d}</button>`).join('')}
        <button type="button" class="pin-key" data-pin-key="clear">C</button>
      </div>
      <button type="submit" name="action" value="pin-approve">Approve with PIN</button>
    </form>
    <p class="hint">When the API is reachable the PIN is verified live via PIN login and the session token is stored for sync and price-book calls; the PIN itself is never stored. When the API is unreachable the pad verifies the format only (4+ digits) and records an opaque demo approval reference.</p>
  </div>`;
}

// -- Till session ---------------------------------------------------------------

export function renderTillSession(state: RegisterUiState): string {
  const till = state.till;
  const zReport = till.zReport
    ? `<div id="z-report-view"><h4>Z-Report ${escapeHtml(till.zReport.zNumber)}</h4><p>Z-report ID: <code>${escapeHtml(till.zReport.zReportId)}</code>. ${till.zReport.zReportId.startsWith('local-') ? 'Local till record — the API exposes no till-session endpoints, so no server Z-report is issued for this close.' : 'Issued by the reporting service on close.'}</p></div>`
    : '';
  return `<section id="till-session" aria-label="Till session">
    <h2>Till Session — ${escapeHtml(till.state)}</h2>
    ${till.sessionId ? `<p>Session: <code>${escapeHtml(till.sessionId)}</code></p>` : '<p>No session open.</p>'}
    ${till.zeroFloatWarning ? `<p class="banner offline-banner">${escapeHtml(till.zeroFloatWarning)}</p>` : ''}
    ${till.expectedCashPence !== null ? `<p>Expected cash: <strong>${pounds(till.expectedCashPence)}</strong></p>` : ''}
    <form method="post" action="/action" class="till-form">
      <label for="opening-float-pence">Opening float (pence)</label>
      <input id="opening-float-pence" name="opening-float-pence" type="number" min="0" value="10000">
      <button type="submit" name="action" value="till-open"${till.state !== 'closed' ? ' disabled' : ''}>Open session</button>
      <button type="submit" name="action" value="till-end"${till.state !== 'open' ? ' disabled' : ''}>End session</button>
    </form>
    <form method="post" action="/action" class="till-form">
      <label for="counted-cash-pence">Blind count — counted cash (pence)</label>
      <input id="counted-cash-pence" name="counted-cash-pence" type="number" min="0" value="0">
      <label for="variance-reason">Variance reason (required if counted differs from expected)</label>
      <input id="variance-reason" name="variance-reason" type="text" placeholder="e.g. till short £2 — recount checked">
      <button type="submit" name="action" value="till-close"${till.state !== 'ended' ? ' disabled' : ''}>Blind-close session</button>
    </form>
    ${zReport}
    <p class="hint">Close is two-step: End freezes the session and computes expected cash; Blind-close takes the counted cash, computes the variance, and needs manager approval above the D-08 threshold (higher of £10 or 2% of expected cash). The Z-report is issued by the reporting service, never computed on the register.</p>
  </section>`;
}

// -- Hardware simulator ---------------------------------------------------------

export function renderHardwarePanel(state: RegisterUiState): string {
  const receipt = formatReceipt(buildReceiptInput(state));
  const display = formatCustomerDisplay(buildCustomerDisplayInput(state));
  return `<section id="hardware-panel" aria-label="Hardware simulator">
    <h2>Hardware Simulator</h2>
    <p>Card reader: ${escapeHtml(state.readerModel)} — ${escapeHtml(state.readerStatus)}. ${state.demo ? 'Simulated hardware — no live reader, printer or display attached.' : ''}</p>
    <div class="hardware-grid">
      <div>
        <h3>Receipt preview — 80mm thermal (ESC/POS)</h3>
        <pre id="receipt-preview" class="receipt">${escapeHtml(receipt)}</pre>
      </div>
      <div>
        <h3>Customer display preview</h3>
        <pre id="customer-display-preview" class="customer-display">${escapeHtml(display)}</pre>
        <p class="hint">The customer display shows a single tax total only — never a per-rate VAT breakdown (Arch-01 §3.3).</p>
      </div>
    </div>
  </section>`;
}

// -- Full page ------------------------------------------------------------------

const CSS = `
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#f4f4f2;color:#111}
h1{font-size:22px}h2{font-size:18px;margin-top:28px}h3{font-size:16px}
button{font-size:18px;padding:12px 18px;margin:4px;min-height:48px;touch-action:manipulation}
button:disabled{opacity:.45;cursor:not-allowed}
input,select{font-size:18px;padding:10px;margin:4px}
.banner{padding:12px;margin:12px 0;border-radius:6px;font-weight:600}
.online-banner{background:#d7f0dd}.offline-banner{background:#fde3a7}
.modal{border:2px solid #111;border-radius:8px;padding:16px;margin:16px 0;background:#fff}
.modal.blocking{border-color:#b00020;background:#fff0f0}
.w12-message{font-weight:700;font-size:18px}
table.basket{border-collapse:collapse;width:100%;background:#fff}
table.basket th,table.basket td{border:1px solid #ccc;padding:8px;text-align:left}
tr.line-breakdown td{font-size:13px;color:#444;background:#fafafa}
.quick-keys{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.quick-key{min-width:120px}
.receipt{width:320px;max-width:100%;background:#fff;border:1px solid #999;padding:12px;font-family:monospace;font-size:13px;white-space:pre-wrap}
.customer-display{background:#111;color:#0f0;padding:12px;font-family:monospace;font-size:15px;white-space:pre-wrap}
.hardware-grid{display:flex;flex-wrap:wrap;gap:24px}
.pin-pad{display:grid;grid-template-columns:repeat(3,64px);gap:6px;margin:8px 0}
.pin-key{min-width:64px}
.inline-form{display:inline}
.demo-label{background:#eef;border:1px solid #99c;padding:8px;margin:12px 0}
.hint{color:#444;font-size:14px}
`;

export function renderRegisterPage(state: RegisterUiState): string {
  const total = state.lines.reduce((sum, line) => sum + line.lineTotalPence, 0n);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Register — ${escapeHtml(state.shopName)}</title>
<style>${CSS}</style></head>
<body>
<header><h1>Register — ${escapeHtml(state.shopName)}</h1>
${state.demo ? '<p class="demo-label">Demo data — simulated catalogue, simulated hardware, no live backend connected. Basket, receipt and customer-display previews render from the live view-model state on this page.</p>' : ''}
${state.storageWarning ? `<p class="banner offline-banner" id="storage-warning">${escapeHtml(state.storageWarning)}</p>` : ''}
${renderApiBanner(state)}
${state.notice ? `<p class="banner" id="action-notice">${escapeHtml(state.notice)}</p>` : ''}
</header>
${state.online ? renderOnlineBanner(state) : renderOfflineBanners(state)}
<main>
${renderSellScreen(state)}
${renderChallenge25Modal(state)}
${renderSplitTenderModal(state)}
${renderW12Modal(state)}
${renderManagerPinModal(state)}
${renderTillSession(state)}
${renderHardwarePanel(state)}
</main>
<footer><p>Basket total ${pounds(total)} — ${state.lines.length} line(s), ${state.parkedCount} parked basket(s), ${state.queuedCount} queued offline order(s). Register UI (Build-05) — framework-light HTML renderer bound to the RegisterApp view-models.</p></footer>
<script>
document.querySelectorAll('.pin-key').forEach(function (key) {
  key.addEventListener('click', function () {
    var input = document.getElementById('manager-pin');
    if (!input) return;
    if (key.dataset.pinKey === 'clear') { input.value = ''; } else { input.value += key.dataset.pinKey; }
  });
});
</script>
</body>
</html>`;
}
