/**
 * Admin Web Dashboard Shell — pure HTML renderers (Build-05 Objective 4, Worker D).
 *
 * Every renderer is a pure function of its view data: no client calls, no
 * business logic, no state. Rendering is plain string templates (same
 * framework-free approach as src/render.ts). All user/server-supplied
 * strings pass through escapeHtml. Voucher and gift-card codes are
 * rendered ONLY as `•••• <last4>` via formatMaskedCode — a full code can
 * never reach the page because the data layer strips it first
 * (sanitiseVoucherViews) and the renderers never accept a `code` field.
 */
import { escapeHtml, formatMaskedCode, formatPence, renderSection, renderTable } from '../render';
import { DASHBOARD_VIEWS } from './types';
import type {
  CatalogueViewData,
  CrmViewData,
  DashboardViewName,
  DataSource,
  ExitViewData,
  FinanceViewData,
  InventoryViewData,
  SectionError,
  WebhooksViewData,
} from './types';
import { EXPORT_WINDOW_DAYS, STATUTORY_ARCHIVE_TABLES, STATUTORY_VAT_ARCHIVE_YEARS } from '../finance/exit';
import { DLQ_RETENTION_DAYS } from '../finance/webhooks';
import { settlementSummary } from '../finance/reporting';
import type { WebhookDeliveryView } from '../api/types';

export const SHELL_CSS = [
  'body{font-family:system-ui,sans-serif;margin:0;background:#0f1f2e;color:#e8f0f2}',
  'header{background:#12324a;padding:16px 24px}header h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:#9fc3d4}',
  'nav{background:#0b1a26;padding:10px 24px}nav a{color:#7fd1c0;margin-right:18px;text-decoration:none}nav a.active{color:#fff;font-weight:700;text-decoration:underline}',
  'main{padding:24px;max-width:1100px}section{background:#16324a;border-radius:8px;padding:16px 20px;margin-bottom:20px}h2{margin-top:0;color:#7fd1c0}',
  'table{border-collapse:collapse;width:100%}th,td{border:1px solid #2a4a63;padding:6px 8px;text-align:left;font-size:14px}th{background:#0f2a3d}',
  'input,select{padding:6px 8px;border-radius:4px;border:1px solid #2a4a63;background:#0b1a26;color:#e8f0f2}',
  'button{padding:8px 14px;border-radius:4px;border:0;background:#2a9d8f;color:#fff;cursor:pointer;font-weight:600}button.danger{background:#b3261e}button:disabled{background:#555;cursor:not-allowed}',
  '.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700}.badge.demo{background:#8a6d00;color:#fff}.badge.live{background:#1b6e3f;color:#fff}.badge.blocked{background:#b3261e;color:#fff}.badge.ok{background:#1b6e3f;color:#fff}.badge.stale{background:#8a6d00;color:#fff}',
  '.error{background:#4a1414;border:1px solid #b3261e;border-radius:6px;padding:10px 14px;margin-bottom:12px}',
  '.note{background:#12324a;border-left:4px solid #7fd1c0;padding:10px 14px;margin-bottom:12px;font-size:14px}',
  '.blockers{background:#4a1414;border:1px solid #b3261e;border-radius:6px;padding:12px 16px;margin-bottom:12px}code{background:#0b1a26;padding:1px 5px;border-radius:3px}',
  'footer{padding:16px 24px;color:#9fc3d4;font-size:13px}',
].join('\n');

function dataSourceBadge(source: DataSource): string {
  return source === 'demo'
    ? '<span class="badge demo">DEMO DATA — no live backend connected</span>'
    : '<span class="badge live">LIVE DATA</span>';
}

function renderErrors(errors: SectionError[]): string {
  if (errors.length === 0) return '';
  return errors
    .map((e) => `<div class="error"><strong>${escapeHtml(e.section)} unavailable:</strong> ${escapeHtml(e.message)}</div>`)
    .join('');
}

function renderAction(action: { message: string; ok: boolean } | null): string {
  if (action === null) return '';
  return action.ok
    ? `<div class="note">${escapeHtml(action.message)}</div>`
    : `<div class="error"><strong>Action failed:</strong> ${escapeHtml(action.message)}</div>`;
}

function nav(active: DashboardViewName | 'home'): string {
  const links = DASHBOARD_VIEWS.map(
    (v) => `<a href="${v.path}" class="${active === v.key ? 'active' : ''}">${escapeHtml(v.label)}</a>`,
  ).join('');
  return `<nav><a href="/" class="${active === 'home' ? 'active' : ''}">Dashboard</a>${links}</nav>`;
}

/** Full HTML page for one dashboard view. */
export function renderPage(title: string, active: DashboardViewName | 'home', innerHtml: string, dataSource: DataSource): string {
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — UK POS Admin</title>`,
    `<style>${SHELL_CSS}</style></head><body>`,
    '<header><h1>UK POS — Admin Back-Office</h1><p>Framework-free dashboard shell bound to the AdminWebApp controllers. Money is integer pence; prices and VAT are server-side only.</p></header>',
    nav(active),
    `<main>${dataSourceBadge(dataSource)}${innerHtml}</main>`,
    '<footer>UK POS pilot — Build-06 admin-web shell. Demo data is labelled wherever it appears; live data comes from the typed API client only.</footer>',
    '</body></html>',
  ].join('');
}

export function renderHome(): string {
  const cards = DASHBOARD_VIEWS.map(
    (v) => `<section><h2><a href="${v.path}" style="color:#7fd1c0">${escapeHtml(v.label)}</a></h2></section>`,
  ).join('');
  return cards;
}

/* ------------------------------------------------------------------ */
/* Catalogue & Price-Book Studio                                       */
/* ------------------------------------------------------------------ */

export function renderCatalogueView(data: CatalogueViewData): string {
  const productRows = data.products.map((p) => [p.name, p.description ?? '—', p.is_active ? 'active' : 'inactive']);
  // Age restrictions (Build-12 Objective 2): product-level rows have
  // variant_id NULL; rule_source says explicit vs inherited. Names
  // are resolved from the loaded products/variants for display.
  const productNameById = new Map(data.products.map((p) => [p.id, p.name]));
  const variantSkuById = new Map(data.variants.map((v) => [v.id, `${v.sku} — ${v.name}`]));
  const ageRestrictionRows = data.ageRestrictions.map((r) => [
    productNameById.get(r.product_id) ?? r.product_id,
    r.variant_id === null ? '— product rule —' : (variantSkuById.get(r.variant_id) ?? r.variant_id),
    String(r.min_age),
    r.requires_challenge_25 ? 'Challenge 25' : 'No',
    r.rule_source,
  ]);
  const ageRestrictionOptions = data.ageRestrictions
    .map(
      (r) =>
        `<option value="${escapeHtml(r.id)}">${escapeHtml(
          `${productNameById.get(r.product_id) ?? r.product_id} — ${r.variant_id === null ? 'product rule' : (variantSkuById.get(r.variant_id) ?? r.variant_id)} — min age ${r.min_age} (${r.rule_source})`,
        )}</option>`,
    )
    .join('');
  const variantRows = data.variants.map((v) => [
    v.sku, v.name, formatPence(v.price_pence), v.barcode ?? '—', v.is_bundle ? 'bundle' : 'single',
  ]);
  const bookRows = data.priceBooks.map((b) => [
    b.name, String(b.priority), b.effective_from, b.effective_to ?? '—', b.status,
  ]);
  const promoRows = data.promotions.map((p) => [p.name, p.type, p.status, `v${p.version}`, p.start_at]);
  // Vouchers: masked only. formatMaskedCode shows "•••• <last4>"; the full
  // code is never in the data (sanitised upstream) and never rendered here.
  const voucherRows = data.vouchers.map((v) => [
    formatMaskedCode(v.code_last4), v.promotion_id ?? '—', v.status, `${v.uses_count}/${v.max_uses}`, v.valid_to ?? '—',
  ]);
  const droppedNote =
    data.droppedVoucherKeys.length > 0
      ? `<div class="error">Dropped full-code material from a voucher payload before rendering: ${data.droppedVoucherKeys.map(escapeHtml).join(', ')}. Full voucher codes are never displayed.</div>`
      : '';
  // Show-once codes issued by THIS request only: rendered once, in
  // full, with a copy-now warning. A later GET has justIssuedCodes
  // empty, so the codes can never be re-displayed (Build-05/06).
  const issuedSection =
    data.justIssuedCodes.length === 0
      ? ''
      : renderSection(
          'Issued voucher codes — shown once',
          '<p class="note"><strong>Copy these codes now.</strong> They are shown exactly once at creation time and will never be displayed again — later reads show only <code>•••• last4</code>. The server stores code_hash + code_last4 only.</p>' +
            renderTable(
              ['Code', 'Last 4', 'Expires'],
              data.justIssuedCodes.map((c) => [c.code, c.code_last4, c.expires_at ?? '—']),
            ),
        );
  const variantOptions = data.variants.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(`${v.sku} — ${v.name}`)}</option>`).join('');
  // Tax-rate picker (Build-08 Objective 1): options come from
  // GET /v1/tax-rates, loaded by the shell. A disabled placeholder is
  // selected first so a variant is never created against the
  // alphabetically-first rate by accident; submitting without a
  // choice sends no taxRateId and the server answers 400 with the
  // error banner (the Build-07 failure this closes).
  const taxRateOptions =
    '<option value="" selected disabled>— choose a tax rate —</option>' +
    data.taxRates
      .map(
        (r) =>
          `<option value="${escapeHtml(r.id)}">${escapeHtml(`${r.name} (${String(r.rate_bps / 100)}%)`)}</option>`,
      )
      .join('');
  const bookOptions = data.priceBooks.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('');
  const promoOptions =
    '<option value="">— unscoped —</option>' +
    data.promotions.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  return [
    renderErrors(data.errors),
    renderAction(data.action),
    droppedNote,
    issuedSection,
    renderSection(
      'Products',
      (data.products.length === 0
        ? '<p>No products.</p>'
        : renderTable(['Name', 'Description', 'Status'], productRows)) +
        '<p class="note">Creates a parent product via the typed client (<code>POST /v1/catalogue/products</code>). Variants belong to a product — create the product first, then its variants below. Tick “Age-restricted” to attach a Challenge 25 rule to the product itself (min age 18 by default): variants created under it inherit the rule unless they carry an explicit rule of their own.</p>' +
        '<form method="post" action="/catalogue/products/create"><p>' +
        'Name <input name="name" required> Description <input name="description"> ' +
        'Age-restricted <input type="checkbox" name="ageRestricted" value="1"> Min age <input type="number" name="minAge" value="18" min="1"> ' +
        '<button type="submit">Create product</button></p></form>',
    ),
    renderSection(
      'Age restrictions',
      (data.ageRestrictions.length === 0
        ? '<p>No age-restriction rules.</p>'
        : renderTable(
            ['Product', 'Variant', 'Min age', 'Challenge 25', 'Source'],
            ageRestrictionRows,
          )) +
        '<p class="note">Deleting a product rule also removes the <code>inherited</code> variant rows propagated from it, and never an <code>explicit</code> variant override. Deleting a variant rule removes only that row. Every delete is audit-logged (<code>age_restriction.deleted</code>).</p>' +
        (data.ageRestrictions.length === 0
          ? ''
          : '<form method="post" action="/catalogue/age-restrictions/delete"><p>' +
            `Rule <select name="ruleId">${ageRestrictionOptions}</select> ` +
            '<button type="submit">Delete rule</button></p></form>'),
    ),
    renderSection(
      'Variants',
      data.variants.length === 0
        ? '<p>No variants.</p>'
        : renderTable(['SKU', 'Name', 'Price', 'Barcode', 'Type'], variantRows),
    ),
    renderSection(
      'Create variant',
      '<p class="note">Creates a variant via the typed client (<code>POST /v1/catalogue/variants</code>). The server validates attributes and bundle components; the dashboard never prices locally. The tax rate is required — pick one from the live list (<code>GET /v1/tax-rates</code>).</p>' +
        '<form method="post" action="/catalogue/variants/create"><p>' +
        'Product ID <input name="productId" required> SKU <input name="sku" required> Name <input name="name" required> ' +
        'Barcode <input name="barcode"> Price (pence) <input type="number" name="pricePence" min="0" required> ' +
        'Cost (pence) <input type="number" name="costPence" min="0" value="0"> ' +
        `Tax rate <select name="taxRateId">${taxRateOptions}</select> ` +
        '<button type="submit">Create variant</button></p></form>',
    ),
    renderSection(
      'Update variant',
      '<p class="note">Updates a variant in place via the typed client (<code>PATCH /v1/catalogue/variants/:id</code>, Build-12 Objective 3). Only the fields you fill in change — leave a field blank to keep its current value. A price change needs an admin or owner PIN session; a manager or cashier session is refused by the server (403). The change stamps <code>updated_at</code>, so the register handshake delta picks it up on the next sync.</p>' +
        (data.variants.length === 0
          ? '<p>No variants to update.</p>'
          : '<form method="post" action="/catalogue/variants/update"><p>' +
            `Variant <select name="variantId">${variantOptions}</select> ` +
            'SKU <input name="sku"> Barcode <input name="barcode"> Price (pence) <input type="number" name="pricePence" min="0"> ' +
            'Cost (pence) <input type="number" name="costPence" min="0"> ' +
            `Tax rate <select name="taxRateId"><option value="" selected>— keep current —</option>${data.taxRates.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(`${r.name} (${String(r.rate_bps / 100)}%)`)}</option>`).join('')}</select> ` +
            '<select name="status"><option value="" selected>— keep status —</option><option value="active">active</option><option value="inactive">inactive</option></select> ' +
            '<button type="submit">Update variant</button></p></form>'),
    ),
    renderSection(
      'Price Books',
      (data.priceBooks.length === 0 ? '<p>No price books.</p>' : renderTable(['Name', 'Priority', 'Effective from', 'Effective to', 'Status'], bookRows)) +
        '<form method="post" action="/catalogue/price-books/create"><p>' +
        'Name <input name="name" required> Priority <input type="number" name="priority" value="0" min="0" required> ' +
        'Effective from <input type="date" name="effectiveFrom" required> Effective to <input type="date" name="effectiveTo"> ' +
        '<button type="submit">Create price book</button></p></form>' +
        (data.priceBooks.length === 0 || data.variants.length === 0
          ? '<p class="note">Add a price book and a variant to set a price-book entry.</p>'
          : '<form method="post" action="/catalogue/price-books/entries"><p>' +
            `Price book <select name="priceBookId">${bookOptions}</select> Variant <select name="variantId">${variantOptions}</select> ` +
            'Price (pence) <input type="number" name="pricePence" min="0" required> ' +
            '<select name="mode"><option value="upsert">Set (create or replace)</option><option value="update">Update only (404 if never set)</option></select> ' +
            '<button type="submit">Save price-book entry</button></p></form>') +
        '<p class="note">A variant\u2019s base price can also be edited directly — see “Update variant” above (<code>PATCH /v1/catalogue/variants/:id</code>).</p>',
    ),
    renderSection(
      'Promotions',
      data.promotions.length === 0
        ? '<p>No promotions.</p>'
        : renderTable(['Name', 'Type', 'Status', 'Version', 'Starts'], promoRows),
    ),
    renderSection(
      'Generate bulk vouchers — show-once',
      '<form method="post" action="/catalogue/vouchers/generate"><p>' +
        `Promotion <select name="promotionId">${promoOptions}</select> Count <input type="number" name="count" value="10" min="1" max="1000" required> ` +
        'Max uses <input type="number" name="maxUses" value="1" min="1" required> Valid to <input type="date" name="validTo"> ' +
        '<button type="submit">Generate bulk vouchers</button></p></form>' +
        '<p class="note">Generated codes are displayed exactly once above, then never again. Use the promotion-scoped form when the vouchers belong to one promotion; leave the promotion blank for unscoped generation.</p>',
    ),
    renderSection(
      'Vouchers — masked',
      '<p class="note">Voucher codes are shown masked only (<code>•••• last4</code>). Full codes are issued once at creation time by the API and are never returned on reads (Build-05 Objective 1 show-once rule).</p>' +
        (data.vouchers.length === 0
          ? '<p>No vouchers.</p>'
          : renderTable(['Code', 'Promotion', 'Status', 'Uses', 'Valid to'], voucherRows)),
    ),
    renderSection(
      'Basket preview',
      '<p>Price-basket previews are computed only by the server (<code>POST /v1/catalogue/price-basket</code>, Arch-10 pipeline order base → price book → promotions → voucher → manual). Use the API client; the dashboard never prices locally.</p>',
    ),
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Multi-Warehouse Inventory & Goods-In                                */
/* ------------------------------------------------------------------ */

export function renderInventoryView(data: InventoryViewData): string {
  const warehouseRows = data.warehouses.map((w) => [w.name, w.type, w.is_default ? 'default' : '—']);
  const stockRows = data.stockBalances.map((s) => [
    s.variantId,
    s.warehouseId,
    s.quantityOnHand,
    s.weightedAvgCostPence === undefined || s.weightedAvgCostPence === null
      ? '—'
      : formatPence(s.weightedAvgCostPence),
    s.totalValuePence === undefined || s.totalValuePence === null
      ? '—'
      : formatPence(s.totalValuePence),
    s.stale ? 'STALE' : 'fresh',
  ]);
  const transitRows = data.inTransit.map((t) =>
    t.lines.map((l) => [t.id, l.variant_id, l.quantity, l.received_quantity, (BigInt(l.quantity) - BigInt(l.received_quantity)).toString()]),
  ).flat();
  const suggestionRows = data.reorderSuggestions
    .map((s) => {
      const accept =
        s.status === 'pending'
          ? `<form method="post" action="/inventory/reorder-suggestions/${escapeHtml(s.id)}/accept" style="display:inline"><button type="submit">Accept → create draft PO</button></form>`
          : '—';
      const dismiss =
        s.status === 'pending'
          ? `<form method="post" action="/inventory/reorder-suggestions/${escapeHtml(s.id)}/dismiss" style="display:inline"><input name="reason" placeholder="Reason (required)" required> <button type="submit" class="danger">Dismiss</button></form>`
          : '—';
      return `<tr><td>${escapeHtml(s.variant_id)}</td><td>${escapeHtml(s.suggested_quantity)}</td><td>${escapeHtml(s.supplier_id ?? '—')}</td><td>${escapeHtml(s.status)}</td><td>${accept} ${dismiss}</td></tr>`;
    })
    .join('');
  const poRows = data.purchaseOrders
    .map((p) => {
      const send =
        p.status === 'draft'
          ? `<form method="post" action="/inventory/purchase-orders/${escapeHtml(p.id)}/send" style="display:inline"><button type="submit">Send PO</button></form>`
          : '—';
      return `<tr><td>${escapeHtml(p.po_number)}</td><td>${escapeHtml(p.supplier_id)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.sent_at ?? '—')}</td><td>${send}</td></tr>`;
    })
    .join('');
  const warehouseOptions = data.warehouses.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('');
  const stockVariantIds = [...new Set(data.stockBalances.map((s) => s.variantId))];
  const variantField =
    stockVariantIds.length > 0
      ? `Variant <select name="variantId">${stockVariantIds.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}</select>`
      : 'Variant ID <input name="variantId" required>';

  // Goods-in form: EVERY line's received quantity input defaults to value="0"
  // (D-AW-05). Damaged/short are separate inputs, also 0. The form never
  // pre-fills the ordered quantity.
  const goodsInInputs = data.goodsInLines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.variantId)}</td><td>${escapeHtml(line.quantityOrdered)}</td>` +
        `<td><input type="number" name="received:${escapeHtml(line.variantId)}" value="0" min="0" required></td>` +
        `<td><input type="number" name="damaged:${escapeHtml(line.variantId)}" value="0" min="0"></td>` +
        `<td><input type="number" name="short:${escapeHtml(line.variantId)}" value="0" min="0"></td>` +
        `<td>${formatPence(line.costPence)}</td></tr>`,
    )
    .join('');
  const goodsInSection =
    data.goodsInLines.length === 0
      ? '<p>No purchase-order lines to receive. Raise a purchase order first, or add a line manually below.</p>' +
        '<form method="post" action="/inventory/goods-in"><p>' +
        'Variant ID <input name="variantId" required> Ordered qty <input type="number" name="quantityOrdered" value="1" min="0" required> ' +
        'Received qty <input type="number" name="quantityReceived" value="0" min="0" required> Cost (pence) <input type="number" name="costPence" value="0" min="0" required> ' +
        // Build-07 Obj 3: the manual form must carry the supplier /
        // location / warehouse itself — the handler's demo-id fallback
        // 400d "Resource not found" on every live submit. There is no
        // supplier-list route, so the supplier id is a text field the
        // operator copies from the purchase-order table on this page.
        'Supplier ID <input name="supplierId" required> ' +
        `<input type="hidden" name="locationId" value="${escapeHtml(data.goodsInLocationId ?? '')}">` +
        `<input type="hidden" name="warehouseId" value="${escapeHtml(data.goodsInWarehouseId ?? '')}">` +
        '<button type="submit">Receive goods-in</button></p></form>'
      : `<p>Receiving against purchase order <code>${escapeHtml(data.goodsInPoId ?? '')}</code>. Received quantities default to <strong>0</strong> — enter what actually arrived; never blind-accept the ordered quantity.</p>` +
        '<form method="post" action="/inventory/goods-in">' +
        '<table><thead><tr><th>Variant</th><th>Ordered</th><th>Received</th><th>Damaged</th><th>Short</th><th>Cost</th></tr></thead><tbody>' +
        goodsInInputs +
        '</tbody></table>' +
        `<input type="hidden" name="poId" value="${escapeHtml(data.goodsInPoId ?? '')}">` +
        `<input type="hidden" name="supplierId" value="${escapeHtml(data.goodsInSupplierId ?? '')}">` +
        `<input type="hidden" name="locationId" value="${escapeHtml(data.goodsInLocationId ?? '')}">` +
        `<input type="hidden" name="warehouseId" value="${escapeHtml(data.goodsInWarehouseId ?? '')}">` +
        '<p><button type="submit">Submit goods-in receipt</button></p></form>';

  const supplierRows = data.suppliers.map((s) => [
    s.name,
    s.currency,
    s.lead_time_days === null ? '—' : String(s.lead_time_days),
    s.minimum_order_value_pence === null ? '—' : formatPence(s.minimum_order_value_pence),
  ]);
  const supplierOptions = data.suppliers
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
    .join('');

  return [
    renderErrors(data.errors),
    renderAction(data.action),
    renderSection(
      'Warehouses',
      (data.warehouses.length === 0
        ? '<p>No warehouses.</p>'
        : renderTable(['Name', 'Type', 'Default'], warehouseRows)) +
        // Create warehouse (Build-10 Objective 2): the location comes
        // from the default warehouse, as the goods-in form does —
        // single-location pilot, so the first warehouse's location is
        // the tenant's location.
        '<form method="post" action="/inventory/warehouses/create"><p>' +
        'Name <input name="name" required> ' +
        'Type <select name="type"><option value="store">store</option><option value="warehouse">warehouse</option></select> ' +
        '<label><input type="checkbox" name="isDefault" value="true"> Default for this location</label> ' +
        `<input type="hidden" name="locationId" value="${escapeHtml(data.goodsInLocationId ?? '')}">` +
        '<button type="submit">Create warehouse</button></p></form>',
    ),
    renderSection(
      'Suppliers',
      '<p class="note">Suppliers feed goods-in and reorder suggestions. Linking a variant records its supplier SKU, cost and preferred flag.</p>' +
        (data.suppliers.length === 0
          ? '<p>No suppliers.</p>'
          : renderTable(['Name', 'Currency', 'Lead time (days)', 'Min order'], supplierRows)) +
        '<form method="post" action="/inventory/suppliers/create"><p>' +
        'Name <input name="name" required> Currency <input name="currency" value="GBP" size="3"> ' +
        'Lead time (days) <input type="number" name="leadTimeDays" min="0"> ' +
        'Min order (pence) <input type="number" name="minOrderValuePence" min="0"> ' +
        '<button type="submit">Create supplier</button></p></form>' +
        (data.suppliers.length === 0
          ? ''
          : '<form method="post" action="/inventory/suppliers/link-variant"><p>' +
            `Supplier <select name="supplierId">${supplierOptions}</select> ` +
            'Variant ID <input name="variantId" required> Supplier SKU <input name="supplierSku"> ' +
            'Cost (pence) <input type="number" name="costPence" value="0" min="0" required> ' +
            '<label><input type="checkbox" name="isPreferred" value="true"> Preferred</label> ' +
            '<button type="submit">Link variant</button></p></form>'),
    ),
    renderSection(
      'Stock balances',
      '<p class="note">Balances older than 15 minutes are flagged STALE (display hint only; the live stock endpoint returns ledger sums). Avg cost is the weighted-average cost from stock valuation; Total value is on hand × avg cost; a dash means no valuation row exists yet.</p>' +
        (data.stockBalances.length === 0
          ? '<p>No stock rows.</p>'
          : renderTable(['Variant', 'Warehouse', 'On hand', 'Avg cost', 'Total value', 'Freshness'], stockRows)),
    ),
    renderSection(
      'In-transit transfers',
      transitRows.length === 0
        ? '<p>No transfers in transit.</p>'
        : renderTable(['Transfer', 'Variant', 'Qty', 'Received', 'Outstanding'], transitRows),
    ),
    renderSection('Goods-In — receive delivery', goodsInSection),
    renderSection(
      'Reorder suggestions',
      '<p class="note">Accepting a suggestion creates a <strong>draft</strong> purchase order (never sent). Dismissing requires a reason, recorded with the dismissal.</p>' +
        (data.reorderSuggestions.length === 0
          ? '<p>No pending reorder suggestions.</p>'
          : `<table><thead><tr><th>Variant</th><th>Suggested qty</th><th>Supplier</th><th>Status</th><th>Actions</th></tr></thead><tbody>${suggestionRows}</tbody></table>`),
    ),
    renderSection(
      'Purchase orders',
      '<p class="note">Draft POs are sent from here. A draft PO is created either by accepting a reorder suggestion above, or with the standalone form below.</p>' +
        (data.purchaseOrders.length === 0
          ? '<p>No purchase orders.</p>'
          : `<table><thead><tr><th>PO number</th><th>Supplier</th><th>Status</th><th>Sent at</th><th>Actions</th></tr></thead><tbody>${poRows}</tbody></table>`),
    ),
    renderSection(
      'Create purchase order',
      '<p class="note">Creates a standalone <strong>draft</strong> purchase order via the typed client (<code>POST /v1/inventory/purchase-orders</code>, Build-12 Objective 3). The delivery warehouse fixes the PO\u2019s location; the expected date is optional. One line only in this form — add further lines by accepting a reorder suggestion, or raise another PO.</p>' +
        (data.suppliers.length === 0 || data.warehouses.length === 0
          ? '<p>A supplier and a warehouse are needed to raise a purchase order.</p>'
          : '<form method="post" action="/inventory/purchase-orders/create"><p>' +
            `Supplier <select name="supplierId">${supplierOptions}</select> ` +
            `Warehouse <select name="warehouseId">${warehouseOptions}</select> ` +
            'Expected delivery <input type="date" name="expectedDeliveryDate"> ' +
            `${variantField} Quantity <input type="number" name="quantityOrdered" value="1" min="1" required> ` +
            'Unit cost (pence) <input type="number" name="unitCostPence" value="0" min="0" required> ' +
            '<button type="submit">Create draft purchase order</button></p></form>'),
    ),
    renderSection(
      'Create transfer',
      data.warehouses.length < 2
        ? '<p>Two warehouses are needed to create a transfer.</p>'
        : '<form method="post" action="/inventory/transfers/create"><p>' +
          `From <select name="fromWarehouseId">${warehouseOptions}</select> To <select name="toWarehouseId">${warehouseOptions}</select> ` +
          `${variantField} Quantity <input type="number" name="quantity" value="1" min="1" required> ` +
          '<button type="submit">Create transfer</button></p></form>',
    ),
  ].join('');
}

/* ------------------------------------------------------------------ */
/* CRM / Loyalty & GDPR Console                                        */
/* ------------------------------------------------------------------ */

export function renderCrmView(data: CrmViewData): string {
  const customerRows = data.customers.map((c) => [
    `${c.first_name} ${c.last_name ?? ''}`.trim(), c.email ?? '—', c.phone ?? '—',
  ]);
  const consentRows = data.consents.map((c) => [c.purpose, c.channel, c.consented ? 'yes' : 'no', c.recorded_at]);
  const loyaltyRows = data.loyaltyEntries.map((e) => [e.kind, e.points, e.order_id ?? '—', e.reason ?? '—', e.created_at]);
  const giftRows = data.giftCards.map((g) => [
    formatMaskedCode(g.code_last4), formatPence(g.balance_pence), g.status, g.expires_at ?? '—',
  ]);
  const customerOptions = data.customers
    .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === data.selectedCustomerId ? 'selected' : ''}>${escapeHtml(`${c.first_name} ${c.last_name ?? ''}`.trim())}</option>`)
    .join('');
  return [
    renderErrors(data.errors),
    renderAction(data.action),
    renderSection(
      'Customers',
      '<form method="get" action="/crm"><p>Search <input name="q" value="' +
        escapeHtml(data.searchQuery ?? '') +
        '" placeholder="name, email or phone"> <button type="submit">Search</button>' +
        (data.searchQuery !== null && data.searchQuery !== '' ? ` <a href="/crm">Clear search</a>` : '') +
        '</p></form>' +
        (data.customers.length === 0 ? '<p>No customers.</p>' : renderTable(['Name', 'Email', 'Phone'], customerRows)) +
        (data.customers.length > 0
          ? `<form method="get" action="/crm"><p><label>Customer <select name="customer">${customerOptions}</select></label> <button type="submit">Show detail</button></p></form>`
          : '') +
        '<p class="note">Assign a customer to a manual customer group via the typed client (<code>POST /v1/crm/customers/:id/groups</code>, Build-12 Objective 3). The assignment is idempotent — assigning a customer who is already a member returns the existing membership. There is no create-group route in this dashboard; groups are created server-side, so paste the group ID here.</p>' +
        (data.customers.length === 0
          ? '<p>No customers to assign.</p>'
          : '<form method="post" action="/crm/customers/groups"><p>' +
            `Customer <select name="customerId">${customerOptions}</select> ` +
            'Group ID <input name="groupId" required placeholder="group id"> ' +
            '<button type="submit">Assign to group</button></p></form>'),
    ),
    renderSection(
      'Marketing consents — append-only history',
      '<p class="note">Consents are append-only: there is no edit or delete path. A change is a new row.</p>' +
        (data.consents.length === 0
          ? '<p>No consent rows for the selected customer.</p>'
          : renderTable(['Purpose', 'Channel', 'Consented', 'Recorded at'], consentRows)),
    ),
    renderSection(
      'Loyalty ledger',
      `<p>Balance: <strong>${escapeHtml(data.loyaltyBalancePoints)} points</strong> (sum of the append-only ledger; 1 pt = 1p at tender).</p>` +
        (data.loyaltyEntries.length === 0
          ? '<p>No loyalty entries for the selected customer.</p>'
          : renderTable(['Kind', 'Points', 'Order', 'Reason', 'Created'], loyaltyRows)),
    ),
    renderSection(
      'Gift cards & store credit — liabilities',
      `<p>Gift-card outstanding: <strong>${formatPence(data.giftCardOutstandingPence)}</strong>. Store-credit outstanding (selected customer): <strong>${formatPence(data.storeCreditOutstandingPence)}</strong>.</p>` +
        '<p class="note">Gift-card codes are shown masked only (<code>•••• last4</code>).</p>' +
        (data.giftCards.length === 0
          ? '<p>No gift cards.</p>'
          : renderTable(['Code', 'Balance', 'Status', 'Expires'], giftRows)),
    ),
    renderSection(
      'GDPR console',
      '<p>Per-customer export (read-only) and Art. 17 erasure. Erasure is two-step: request the acknowledgement, then confirm explicitly. Erasure deletes PII; orders and audit rows are anonymised and retained for VAT.</p>' +
        (data.selectedCustomerId === null
          ? '<p>Select a customer above to run an export or erasure.</p>'
          : `<form method="post" action="/crm/export"><input type="hidden" name="customerId" value="${escapeHtml(data.selectedCustomerId)}"><button type="submit">Export customer data</button></form> ` +
            `<form method="post" action="/crm/erase" style="display:inline"><input type="hidden" name="customerId" value="${escapeHtml(data.selectedCustomerId)}"><input type="hidden" name="acknowledged" value="true"><button type="submit" class="danger">Erase customer (Art. 17) — acknowledged</button></form>`),
    ),
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Finance / Z-Report / VAT-Period Closure & CSV downloads             */
/* ------------------------------------------------------------------ */

export function renderFinanceView(data: FinanceViewData): string {
  const z = data.zReport;
  const zHtml =
    z === null
      ? '<p>No Z-report loaded. Enter a Z-report ID below.</p>'
      : renderTable(
          ['Field', 'Value'],
          [
            ['Z number', z.z_number],
            ['Business date', z.business_date],
            ['Register', z.register_id],
            ['Gross', formatPence(z.gross_pence)],
            ['Net', formatPence(z.net_pence)],
            ['VAT', formatPence(z.vat_pence)],
            ['Cash variance', formatPence(z.cash_variance_pence)],
          ],
        ) +
        `<p><a href="/download/z-report/${escapeHtml(z.id)}">Download Z-report CSV (Xero/QBO, Arch-02 §5.3)</a></p>`;
  const vat = data.vatPeriod;
  const vatHtml =
    vat === null
      ? '<p>No VAT period loaded. Enter a VAT period ID below.</p>'
      : renderTable(
          ['Field', 'Value'],
          [
            ['Period', `${vat.period_start} → ${vat.period_end}`],
            ['Status', vat.status],
          ],
        ) +
        (vat.status === 'closed'
          ? '<p><span class="badge ok">CLOSED</span></p>'
          : `<form method="post" action="/finance/vat-periods/${escapeHtml(vat.id)}/close"><button type="submit">Close VAT period</button></form>`) +
        `<p><a href="/download/vat-period/${escapeHtml(vat.id)}">Download VAT-period CSV (Xero/QBO, Arch-02 §5.3)</a></p>`;
  const closedNote = data.vatPeriodJustClosed
    ? '<div class="note">VAT period closed — the same period ID was closed in place (Build-05 Objective 1 fix: closeVatPeriod preserves :id).</div>'
    : '';
  const settlement = data.settlement;
  const settlementHtml =
    settlement === null
      ? '<p>No settlement reconciled in this session. Enter a business date and one payout line below to reconcile T+3 settlement against the reporting service.</p>'
      : `<p>${escapeHtml(settlementSummary(settlement))}</p>` +
        renderTable(
          ['Field', 'Value'],
          [
            ['Business date', settlement.businessDate],
            ['Settlement date', settlement.settlementDate],
            ['Card gross', formatPence(settlement.cardGrossPence)],
            ['Settled fees', formatPence(settlement.settledFeePence)],
            ['Reserve holds', formatPence(settlement.reserveHoldTotalPence)],
            ['Dispute debits', formatPence(settlement.disputeDebitTotalPence)],
            ['Expected net payout', formatPence(settlement.expectedNetPayoutPence)],
            ['Status', settlement.status],
          ],
        );
  return [
    renderErrors(data.errors),
    renderAction(data.action),
    closedNote,
    renderSection(
      'Z-Report',
      zHtml +
        '<form method="get" action="/finance"><p>Z-report ID <input name="z" value="' +
        escapeHtml(data.zReportId ?? '') +
        '"> VAT period ID <input name="vat" value="' +
        escapeHtml(data.vatPeriodId ?? '') +
        '"> <button type="submit">Load</button></p></form>',
    ),
    renderSection(
      'VAT-period closure',
      '<p class="note">Closing a VAT period is irreversible in the reporting service: a closed period is never rewritten; later corrections are restated into the next period.</p>' +
        vatHtml,
    ),
    renderSection(
      'Settlement — T+3 reconciliation',
      '<p class="note">Card gross, settled fees, reserve holds and dispute debits are distinct lines; fee-adjustment entries appear when settled fees differ from estimates. The dashboard never recomputes a settlement — the reporting service is authoritative.</p>' +
        settlementHtml +
        '<form method="post" action="/finance/settlements/reconcile"><p>' +
        'Business date <input type="date" name="businessDate" required> Provider ref <input name="providerReference" required> ' +
        'Settlement date <input type="date" name="settlementDate" required> Gross (pence) <input type="number" name="grossPence" min="0" required> ' +
        'Fee (pence) <input type="number" name="feePence" min="0" value="0"> Reserve hold (pence) <input type="number" name="reserveHoldPence" min="0" value="0"> ' +
        'Dispute debit (pence) <input type="number" name="disputeDebitPence" min="0" value="0"> ' +
        '<button type="submit">Reconcile settlement</button></p></form>',
    ),
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Webhook DLQ Replay & Audit Hash-Chain Verifier                      */
/* ------------------------------------------------------------------ */

function deliveryStatusBadge(d: WebhookDeliveryView): string {
  return d.status === 'dead_letter' ? '<span class="badge blocked">DEAD LETTER</span>' : escapeHtml(d.status);
}

export function renderWebhooksView(data: WebhooksViewData): string {
  const endpointRows = data.endpoints.map((e) => [e.url, e.event_types.join(', '), e.status]);
  const endpointForms = data.endpoints
    .map(
      (e) =>
        `<form method="post" action="/webhooks/endpoints/${escapeHtml(e.id)}/rotate-secret"><p>` +
        `Endpoint <code>${escapeHtml(e.url)}</code> Grace (hours) <input type="number" name="gracePeriodHours" value="24" min="1" max="168" required> ` +
        '<button type="submit">Rotate secret</button></p></form>',
    )
    .join('');
  const rotatedSection =
    data.justRotatedSecret === null
      ? ''
      : renderSection(
          'Rotated secret — shown once',
          '<p class="note"><strong>Copy this secret now.</strong> It is shown exactly once at rotation time and will never be displayed again. ' +
            `The previous secret stays valid until <code>${escapeHtml(data.justRotatedSecret.previous_secret_expires_at)}</code> (grace ${data.justRotatedSecret.grace_period_hours}h, dual signatures inside the window).</p>` +
            `<p>New secret: <code>${escapeHtml(data.justRotatedSecret.secret)}</code></p>`,
        );
  const dlqRows = data.deadLetters.map((row) => {
    const d = row.delivery;
    return `<tr><td>${escapeHtml(d.id)}</td><td>${escapeHtml(row.event.event_type)}</td><td>${d.attempts}</td>` +
      `<td>${row.daysRemaining === null ? '—' : `${row.daysRemaining} days left of ${DLQ_RETENTION_DAYS}`}</td>` +
      `<td>${escapeHtml(d.last_error ?? '')}</td>` +
      `<td><form method="post" action="/webhooks/deliveries/${escapeHtml(d.id)}/replay" style="display:inline"><button type="submit">Replay</button></form> ` +
      `<form method="post" action="/webhooks/deliveries/${escapeHtml(d.id)}/discard" style="display:inline"><button type="submit" class="danger">Discard</button></form></td></tr>`;
  }).join('');
  const chain = data.auditChain;
  const chainHtml =
    chain === null
      ? '<p>Audit chain not verified (no events loaded).</p>'
      : chain.verification.ok
        ? `<p><span class="badge ok">CHAIN VERIFIED</span> ${chain.eventCount} audit event(s); every link recomputes (sha256(prev_hash + canonical JSON(payload))).</p>`
        : `<p><span class="badge blocked">CHAIN BROKEN</span> ${chain.eventCount} event(s); first broken link at index ${chain.verification.brokenIndex ?? '?'}: ${escapeHtml(chain.verification.reason ?? 'unknown reason')}.</p>`;
  const eventRows = data.auditEvents.map((e) => [e.event_type, e.entity_type ?? '—', e.created_at]);
  return [
    renderErrors(data.errors),
    renderAction(data.action),
    rotatedSection,
    renderSection(
      'Webhook endpoints',
      '<p class="note">Endpoint secrets are shown once at registration and never again.</p>' +
        (data.endpoints.length === 0
          ? '<p>No webhook endpoints.</p>'
          : renderTable(['URL', 'Event types', 'Status'], endpointRows)) +
        (data.endpoints.length === 0
          ? ''
          : '<p class="note">Rotating an endpoint secret issues a new secret (shown once above) and keeps the previous secret valid for the grace window, with dual <code>X-Webhook-Signature</code> / <code>X-Webhook-Signature-Previous</code> headers inside it.</p>' +
            endpointForms),
    ),
    renderSection(
      'Dead-letter queue (30-day retention)',
      '<p class="note">After 11 attempts a delivery moves to the DLQ, where it is retained 30 days, is replayable, is explicitly discardable, and is never auto-deleted.</p>' +
        (data.deadLetters.length === 0
          ? '<p>DLQ is empty.</p>'
          : `<table><thead><tr><th>Delivery</th><th>Event</th><th>Attempts</th><th>Retention</th><th>Last error</th><th>Actions</th></tr></thead><tbody>${dlqRows}</tbody></table>`),
    ),
    renderSection(
      'Audit hash-chain verifier',
      chainHtml +
        (data.auditEvents.length === 0
          ? '<p>No audit events loaded.</p>'
          : renderTable(['Event type', 'Entity', 'Created at'], eventRows)),
    ),
  ].join('');
}

/* ------------------------------------------------------------------ */
/* Tenant Exit / 30-Day Export / 6-Year Statutory Archive Portal       */
/* ------------------------------------------------------------------ */

export function renderExitView(data: ExitViewData): string {
  const exit = data.exit;
  const statusHtml =
    exit === null
      ? '<p>Exit status unavailable.</p>'
      : renderTable(
          ['Field', 'Value'],
          [
            ['Tenant', exit.status.tenantId],
            ['Status', exit.status.status],
            ['Export window ends', exit.exportWindowEndsAt ?? '—'],
            ['Read-only', exit.readOnly ? 'yes' : 'no'],
          ],
        );
  const blockers = data.blockers;
  const hasBlockers = blockers.openSessionIds.length > 0 || blockers.blockingPaymentAttemptIds.length > 0;
  const blockersHtml = hasBlockers
    ? `<div class="blockers"><strong><span class="badge blocked">D-11 BLOCKED</span> Termination is blocked until every item below is resolved:</strong>` +
      '<ul>' +
      blockers.openSessionIds.map((id) => `<li>Open register session: <code>${escapeHtml(id)}</code></li>`).join('') +
      blockers.blockingPaymentAttemptIds.map((id) => `<li>Pending/unknown payment attempt: <code>${escapeHtml(id)}</code></li>`).join('') +
      '</ul><p>Resolve each open session and each pending/unknown payment, then request termination again. Blockers are never hidden behind a generic message.</p></div>'
    : '<p><span class="badge ok">NO D-11 BLOCKERS</span> No open sessions and no pending/unknown payments are blocking termination.</p>';
  const archive = data.statutoryArchive;
  const archiveRows = data.archives.map((a) => [
    a.id,
    a.archived_at,
    a.retention_until,
    a.archive_sha256.slice(0, 16) + '…',
    a.verified ? 'VERIFIED' : 'NOT VERIFIED',
    Object.entries(a.row_counts)
      .map(([table, count]) => `${table}:${count}`)
      .join(', '),
  ]);
  const archiveHtml =
    `<p>Statutory VAT archive: <strong>${STATUTORY_VAT_ARCHIVE_YEARS}-year retention</strong> (${EXPORT_WINDOW_DAYS}-day export window first). Tables archived: ${STATUTORY_ARCHIVE_TABLES.map((t) => `<code>${escapeHtml(t)}</code>`).join(', ')}.</p>` +
    (data.archives.length === 0
      ? `<p class="note">${archive.routePresent ? 'No statutory archives are stored for this tenant yet.' : 'Statutory archive records are not available.'} ${escapeHtml(archive.note)}</p>`
      : renderTable(['Archive', 'Archived at', 'Retention until', 'SHA-256', 'Verified', 'Row counts'], archiveRows) +
        '<p class="note">Each archive is verified by SHA-256 (payload + on-disk bundle) before any tenant row is deleted. The full checksum is available from the compliance read.</p>');
  const action = data.action ?? (data.actionMessage === null ? null : { message: data.actionMessage, ok: true });
  return [
    renderErrors(data.errors),
    renderAction(action),
    renderSection('Tenant status', statusHtml),
    renderSection('D-11 exit blockers', blockersHtml),
    renderSection(
      '30-day export window',
      '<p>Termination starts a 30-day read-only export window. The single-click full export produces manifest.json with SHA-256 checksums per file, verified on download.</p>' +
        '<form method="post" action="/exit/request-termination" style="display:inline"><button type="submit">Request termination</button></form> ' +
        '<form method="post" action="/exit/begin-export-window" style="display:inline"><button type="submit">Begin 30-day export window</button></form> ' +
        '<form method="post" action="/exit/full-export" style="display:inline"><button type="submit">Run full export</button></form> ' +
        '<form method="post" action="/exit/schedule-hard-delete" style="display:inline"><button type="submit" class="danger">Schedule hard delete</button></form>',
    ),
    renderSection('6-year statutory VAT archive', archiveHtml),
  ].join('');
}
