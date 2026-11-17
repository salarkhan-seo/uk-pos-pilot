/**
 * Admin Web Dashboard Shell — rendered UI tests (Build-05 Objective 4, Worker D).
 *
 * These tests assert on what the renderers actually produce (HTML
 * strings / HTTP responses), not just on controller state:
 *  - goods-in line received quantities default to `value="0"` inputs;
 *  - voucher codes are masked (never plaintext) in rendered output;
 *  - D-11 exit blockers render in the exit portal;
 *  - the VAT period closure view renders, and closing preserves the id.
 * The server tests boot the real HTTP server on an ephemeral port.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/errors';
import { FakeAdminApiClient } from '../src/api/fake-client';
import { sanitiseVoucherViews } from '../src/catalogue/studio';
import { createDemoClient, createDemoShell, DEMO_VAT_PERIOD_ID, DEMO_Z_REPORT_ID } from '../src/ui/demo-data';
import { createAdminDashboardShell } from '../src/ui/shell';
import { createAdminWebServer, createShellFromEnv } from '../src/ui/server';
import { renderCatalogueView, renderExitView, renderInventoryView } from '../src/ui/views';

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

async function bootDemoServer(): Promise<{ base: string; client: FakeAdminApiClient }> {
  const { shell, client } = createDemoShell();
  const server = createAdminWebServer(shell);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, client };
}

async function getText(base: string, path: string): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function postForm(base: string, path: string, params: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
  });
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}

describe('inventory view — goods-in received quantities default to 0', () => {
  it('renders one value="0" received-quantity input per PO line (never the ordered qty)', async () => {
    const { shell } = createDemoShell();
    const data = await shell.loadInventoryData();
    expect(data.goodsInLines).toHaveLength(2);
    for (const line of data.goodsInLines) {
      expect(line.quantityReceived).toBe('0');
    }
    const html = renderInventoryView(data);
    // Each line's received input defaults to 0; no input is pre-filled
    // with the ordered quantity (10 / 5).
    expect(html).toContain('name="received:variant-demo-1" value="0"');
    expect(html).toContain('name="received:variant-demo-2" value="0"');
    expect(html).not.toContain('name="received:variant-demo-1" value="10"');
    expect(html).not.toContain('name="received:variant-demo-2" value="5"');
    expect(html).toContain('Received quantities default to <strong>0</strong>');
  });

  it('goods-in POST books only the received quantity into stock', async () => {
    const { base, client } = await bootDemoServer();
    const body = new URLSearchParams({
      poId: 'po-demo-1',
      supplierId: 'sup-demo-1',
      locationId: 'loc-demo-1',
      warehouseId: 'wh-demo-1',
      'received:variant-demo-1': '8',
      'damaged:variant-demo-1': '1',
      'short:variant-demo-1': '1',
      'received:variant-demo-2': '0',
      'damaged:variant-demo-2': '0',
      'short:variant-demo-2': '0',
    });
    const res = await fetch(`${base}/inventory/goods-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/inventory');
    // Only the 8 received units hit stock (42 + 8 = 50); damaged/short do not.
    expect(client.stock.find((s) => s.variantId === 'variant-demo-1')?.quantityOnHand).toBe('50');
  });
});

describe('catalogue view — voucher codes are masked, never plaintext', () => {
  it('renders vouchers as •••• last4 only', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('catalogue');
    expect(html).toContain('•••• 4821');
    expect(html).toContain('•••• 7734');
    expect(html).toContain('Voucher codes are shown masked only');
  });

  it('a planted full code in a voucher payload is dropped before rendering and never appears', async () => {
    const { vouchers, droppedKeys } = sanitiseVoucherViews([
      {
        id: 'voucher-planted',
        code: 'VOUCHER-FULL-SECRET-1234',
        code_last4: '1234',
        promotion_id: null,
        status: 'active',
        max_uses: 1,
        uses_count: 0,
        valid_from: '2026-11-01T00:00:00.000Z',
        valid_to: null,
      } as unknown as Record<string, unknown>,
    ]);
    expect(droppedKeys).toContain('code');
    const html = renderCatalogueView({
      dataSource: 'demo',
      products: [],
      variants: [],
      taxRates: [],
      ageRestrictions: [],
      priceBooks: [],
      promotions: [],
      vouchers,
      droppedVoucherKeys: droppedKeys,
      justIssuedCodes: [],
      justIssuedPromotionId: null,
      action: null,
      errors: [],
    });
    expect(html).not.toContain('VOUCHER-FULL-SECRET-1234');
    expect(html).toContain('•••• 1234');
    expect(html).toContain('Dropped full-code material');
  });

  it('price-book entry editing is wired (set/upsert + update-only forms)', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('catalogue');
    expect(html).toContain('/catalogue/price-books/entries');
    expect(html).toContain('Save price-book entry');
    expect(html).toContain('Set (create or replace)');
    expect(html).toContain('Update only (404 if never set)');
    expect(html).not.toContain('not available in this build');
  });

  it('variant creation and price-book creation forms are present', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('catalogue');
    expect(html).toContain('/catalogue/variants/create');
    expect(html).toContain('Create variant');
    // Build-08 Objective 1: the variant form carries the tax-rate
    // picker fed by GET /v1/tax-rates (no more hardcoded null).
    expect(html).toContain('name="taxRateId"');
    expect(html).toContain('— choose a tax rate —');
    expect(html).toContain('/catalogue/price-books/create');
    expect(html).toContain('Create price book');
    expect(html).toContain('/catalogue/vouchers/generate');
    expect(html).toContain('Generate bulk vouchers');
  });

  it('product creation with a nested age restriction + rule deletion round-trips through the studio (demo)', async () => {
    const { base } = await bootDemoServer();
    // Create an age-restricted product from the catalogue form.
    const created = await postForm(base, '/catalogue/products/create', {
      name: 'Demo Vape Liquid',
      description: '',
      ageRestricted: '1',
      minAge: '21',
    });
    expect(created.status).toBe(303);
    expect(created.location).toBe('/catalogue');
    const afterCreate = await getText(base, '/catalogue');
    expect(afterCreate.status).toBe(200);
    expect(afterCreate.text).toContain('Demo Vape Liquid');
    expect(afterCreate.text).toContain('Age restrictions');
    expect(afterCreate.text).toContain('min age 21');
    expect(afterCreate.text).toContain('explicit');
    expect(afterCreate.text).toContain('product rule');
    expect(afterCreate.text).toContain('/catalogue/age-restrictions/delete');
    // Delete the rule from the catalogue form (rule id from the select).
    const option = /<option value="([^"]+)">Demo Vape Liquid — product rule — min age 21 \(explicit\)<\/option>/.exec(
      afterCreate.text,
    );
    expect(option?.[1], 'delete select carries the product rule id').toBeDefined();
    const deleted = await postForm(base, '/catalogue/age-restrictions/delete', {
      ruleId: option?.[1] as string,
    });
    expect(deleted.status).toBe(303);
    expect(deleted.location).toBe('/catalogue');
    const afterDelete = await getText(base, '/catalogue');
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.text).toContain('No age-restriction rules.');
    expect(afterDelete.text).not.toContain('min age 21');
  });
});

describe('exit portal — D-11 blockers render verbatim', () => {
  it('renders every blocking id when termination is blocked', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('exit');
    expect(html).toContain('D-11 BLOCKED');
    expect(html).toContain('session-demo-open-1');
    expect(html).toContain('pay-attempt-demo-unknown-1');
    expect(html).toContain('Open register session');
    expect(html).toContain('Pending/unknown payment attempt');
  });

  it('renders the no-blockers state when nothing blocks termination', async () => {
    const client = new FakeAdminApiClient({
      exitStatus: {
        tenantId: 'tenant-1',
        status: 'active',
        exportWindowEndsAt: null,
        openSessionIds: [],
        blockingPaymentAttemptIds: [],
      },
    });
    const shell = createAdminDashboardShell(client, { dataSource: 'demo' });
    const html = await shell.renderView('exit');
    expect(html).toContain('NO D-11 BLOCKERS');
    expect(html).not.toContain('D-11 BLOCKED');
  });

  it('statutory archives are fetched live and render with verification flags', async () => {
    const { shell } = createDemoShell();
    const data = await shell.loadExitData();
    expect(data.statutoryArchive.routePresent).toBe(true);
    expect(data.statutoryArchive.routeKey).toBe('compliance.listStatutoryArchives');
    expect(data.archives).toHaveLength(1);
    expect(data.archives[0]?.verified).toBe(true);
    const html = renderExitView(data);
    expect(html).toContain('arch-demo-1');
    expect(html).toContain('VERIFIED');
    expect(html).toContain('6-year retention');
    expect(html).toContain('vat_periods');
    expect(html).toContain('z_reports');
    expect(html).not.toContain('Statutory archive records not yet available');
  });

  it('exit portal without a tenant id says archives cannot be fetched', async () => {
    const client = new FakeAdminApiClient({
      exitStatus: {
        tenantId: 'tenant-1',
        status: 'active',
        exportWindowEndsAt: null,
        openSessionIds: [],
        blockingPaymentAttemptIds: [],
      },
    });
    const shell = createAdminDashboardShell(client, { dataSource: 'demo' });
    const data = await shell.loadExitData();
    expect(data.archives).toHaveLength(0);
    const html = renderExitView(data);
    expect(html).toContain('No statutory archives are stored for this tenant yet.');
  });
});

describe('finance view — VAT period closure renders and preserves :id', () => {
  it('renders the open VAT period with a Close VAT period action', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('finance');
    expect(html).toContain(DEMO_VAT_PERIOD_ID);
    expect(html).toContain('Close VAT period');
    expect(html).toContain('VAT-period closure');
    expect(html).toContain(DEMO_Z_REPORT_ID);
    expect(html).toContain('/download/z-report/');
    expect(html).toContain('/download/vat-period/');
  });

  it('closing the period closes the same :id in place and re-renders CLOSED', async () => {
    const { shell, client } = createDemoShell();
    const result = await shell.closeVatPeriod(DEMO_VAT_PERIOD_ID);
    expect(result.closed).toBe(true);
    expect(client.vatPeriods.find((p) => p.id === DEMO_VAT_PERIOD_ID)?.status).toBe('closed');
    const html = await shell.renderView('finance', { vatPeriodId: DEMO_VAT_PERIOD_ID }, { vatPeriodJustClosed: true });
    expect(html).toContain('CLOSED');
    expect(html).toContain('closed in place');
    expect(html).not.toContain('Close VAT period');
  });
});

describe('webhooks view — DLQ replay and audit hash-chain verifier', () => {
  it('renders the dead-letter row with Replay/Discard and a verified audit chain', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('webhooks');
    expect(html).toContain('dlq-demo-1');
    expect(html).toContain('order.completed');
    expect(html).toContain('Replay');
    expect(html).toContain('Discard');
    expect(html).toContain('CHAIN VERIFIED');
    expect(html).toContain('30-day retention');
  });

  it('a tampered audit event breaks the chain at the first affected link', async () => {
    const client = createDemoClient();
    // Tamper with the second event's payload after the chain was built.
    const second = client.auditEvents[1];
    if (second !== undefined) {
      second.payload = { ...second.payload, qty: '999' };
    }
    const shell = createAdminDashboardShell(client, {
      dataSource: 'demo',
      defaultZReportId: DEMO_Z_REPORT_ID,
      defaultVatPeriodId: DEMO_VAT_PERIOD_ID,
      getVatPeriod: async (id) => client.vatPeriods.find((p) => p.id === id) ?? null,
    });
    const html = await shell.renderView('webhooks');
    expect(html).toContain('CHAIN BROKEN');
    expect(html).toContain('tampered');
  });
});

describe('admin-web HTTP server', () => {
  it('serves every view, health, and the demo-data badge', async () => {
    const { base } = await bootDemoServer();
    for (const path of ['/', '/catalogue', '/inventory', '/crm', '/finance', '/webhooks', '/exit']) {
      const { status, text } = await getText(base, path);
      expect(status).toBe(200);
      expect(text).toContain('UK POS — Admin Back-Office');
      expect(text).toContain('DEMO DATA');
    }
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', shell: 'admin-web', dataSource: 'demo' });
  });

  it('serves the inventory view over HTTP with value="0" received inputs', async () => {
    const { base } = await bootDemoServer();
    const { text } = await getText(base, '/inventory');
    expect(text).toContain('name="received:variant-demo-1" value="0"');
  });

  it('serves the exit portal over HTTP with D-11 blockers', async () => {
    const { base } = await bootDemoServer();
    const { text } = await getText(base, '/exit');
    expect(text).toContain('session-demo-open-1');
    expect(text).toContain('pay-attempt-demo-unknown-1');
  });

  it('downloads the Z-report CSV with the Arch-02 §5.3 header', async () => {
    const { base } = await bootDemoServer();
    const res = await fetch(`${base}/download/z-report/${DEMO_Z_REPORT_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('z_number,business_date');
  });

  it('POST close VAT period over HTTP closes the same id and renders CLOSED', async () => {
    const { base } = await bootDemoServer();
    const res = await fetch(`${base}/finance/vat-periods/${DEMO_VAT_PERIOD_ID}/close`, { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('CLOSED');
    expect(text).toContain(DEMO_VAT_PERIOD_ID);
  });

  it('POST request-termination with D-11 blockers re-renders the portal with the blocking ids', async () => {
    const { base } = await bootDemoServer();
    const res = await fetch(`${base}/exit/request-termination`, { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Termination blocked (D-11)');
    expect(text).toContain('session-demo-open-1');
    expect(text).toContain('pay-attempt-demo-unknown-1');
  });

  it('unknown paths return 404', async () => {
    const { base } = await bootDemoServer();
    const { status } = await getText(base, '/no-such-view');
    expect(status).toBe(404);
  });
});

describe('catalogue POST actions — live wiring via the typed client (Build-06 Obj 3)', () => {
  it('create variant POST reaches the client and the new variant lists', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/variants/create', {
      productId: 'prod-demo-1',
      sku: 'NEW-SKU-1',
      barcode: '',
      name: 'New Widget',
      pricePence: '1500',
      costPence: '700',
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/catalogue');
    expect(client.calls.some((c) => c.routeKey === 'catalogue.createVariant')).toBe(true);
    const page = await getText(base, '/catalogue');
    expect(page.text).toContain('New Widget');
    expect(page.text).toContain('NEW-SKU-1');
  });

  it('create price book POST reaches the client and the book lists', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/price-books/create', {
      name: 'Clearance',
      priority: '5',
      effectiveFrom: '2026-11-14',
      effectiveTo: '',
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/catalogue');
    expect(client.calls.some((c) => c.routeKey === 'catalogue.createPriceBook')).toBe(true);
    const page = await getText(base, '/catalogue');
    expect(page.text).toContain('Clearance');
  });

  it('set price-book entry (upsert) POST reaches the client with the right payload', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/price-books/entries', {
      priceBookId: 'pb-demo-1',
      variantId: 'variant-demo-1',
      pricePence: '1999',
      mode: 'upsert',
    });
    expect(res.status).toBe(303);
    const call = client.calls.find((c) => c.routeKey === 'catalogue.setPriceBookEntry');
    expect(call).toBeDefined();
    expect(call?.path).toBe('/v1/price-books/pb-demo-1/entries');
  });

  it('update-only entry POST on a never-set entry surfaces the API error on the page (400, not 500)', async () => {
    const { base } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/price-books/entries', {
      priceBookId: 'pb-demo-1',
      variantId: 'variant-demo-2',
      pricePence: '899',
      mode: 'update',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Resource not found');
    expect(res.text).not.toContain('Internal Server Error');
  });

  it('bulk vouchers show the codes once, then mask them on the next GET', async () => {
    const { base } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/vouchers/generate', {
      promotionId: '',
      count: '2',
      maxUses: '1',
      validTo: '',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('shown once');
    expect(res.text).toContain('FAKE-');
    const issued = res.text.match(/FAKE-\d{4}-CODE-\d{4}/g) ?? [];
    expect(issued.length).toBeGreaterThanOrEqual(2);
    // A fresh GET must not contain any of the plaintext codes — only the masked last4.
    const page = await getText(base, '/catalogue');
    for (const code of issued) {
      expect(page.text).not.toContain(code);
    }
    expect(page.text).toContain('••••');
  });

  it('bulk vouchers with an invalid count surface the API error (400, not 500)', async () => {
    const { base } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/vouchers/generate', {
      promotionId: '',
      count: '0',
      maxUses: '1',
      validTo: '',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('count must be an integer between 1 and 1000');
  });
});

describe('inventory POST actions — live wiring via the typed client (Build-06 Obj 3)', () => {
  it('accept reorder suggestion POST creates a draft PO and shows the confirmation', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/inventory/reorder-suggestions/sug-demo-1/accept', {});
    expect(res.status).toBe(200);
    expect(res.text).toContain('draft purchase order');
    expect(client.calls.some((c) => c.routeKey === 'inventory.acceptReorderSuggestion')).toBe(true);
    const page = await getText(base, '/inventory');
    expect(page.text).toContain('Purchase orders');
  });

  it('dismiss reorder suggestion without a reason surfaces the API error (400, not 500)', async () => {
    const { base } = await bootDemoServer();
    const res = await postForm(base, '/inventory/reorder-suggestions/sug-demo-1/dismiss', { reason: '' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('A reason is required to dismiss a reorder suggestion');
  });

  it('dismiss reorder suggestion with a reason redirects and the suggestion is dismissed', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/inventory/reorder-suggestions/sug-demo-1/dismiss', { reason: 'Overstocked' });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/inventory');
    expect(client.reorderSuggestions.find((s) => s.id === 'sug-demo-1')?.status).toBe('dismissed');
  });

  it('send purchase order POST reaches the client and marks the PO sent', async () => {
    // The seeded demo PO (PO-1001) is already sent, so accept a
    // suggestion first to create a fresh draft PO, then send that one.
    const { base, client } = await bootDemoServer();
    const accepted = await postForm(base, '/inventory/reorder-suggestions/sug-demo-1/accept', {});
    expect(accepted.status).toBe(200);
    const draft = client.purchaseOrders.find((p) => p.status === 'draft');
    expect(draft).toBeDefined();
    const res = await postForm(base, `/inventory/purchase-orders/${draft?.id}/send`, {});
    expect(res.status).toBe(200);
    expect(res.text).toContain('sent to the supplier');
    expect(client.purchaseOrders.find((p) => p.id === draft?.id)?.status).toBe('sent');
  });

  it('create transfer POST reaches the client; same-warehouse transfer surfaces the API error', async () => {
    const { base, client } = await bootDemoServer();
    const ok = await postForm(base, '/inventory/transfers/create', {
      fromWarehouseId: 'wh-demo-1',
      toWarehouseId: 'wh-demo-2',
      variantId: 'variant-demo-1',
      quantity: '3',
    });
    expect(ok.status).toBe(303);
    expect(client.calls.some((c) => c.routeKey === 'inventory.createTransfer')).toBe(true);
    const bad = await postForm(base, '/inventory/transfers/create', {
      fromWarehouseId: 'wh-demo-1',
      toWarehouseId: 'wh-demo-1',
      variantId: 'variant-demo-1',
      quantity: '3',
    });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('must differ');
  });
});

describe('CRM — customer search and group assignment (Build-06 Obj 3 gap, closed Build-12 Obj 3)', () => {
  it('GET /crm?q= filters customers by name; a non-matching query shows none', async () => {
    const { base } = await bootDemoServer();
    const hit = await getText(base, '/crm?q=demo');
    expect(hit.text).toContain('Demo Customer');
    const miss = await getText(base, '/crm?q=zzzz-no-such-customer');
    expect(miss.text).toContain('No customers.');
    expect(miss.text).not.toContain('Demo Customer');
  });

  it('CRM view renders the assign-to-group form, and a demo POST assigns the customer', async () => {
    const { base, client } = await bootDemoServer();
    const { text } = await getText(base, '/crm');
    expect(text).toContain('Assign to group');
    expect(text).toContain('/crm/customers/groups');
    expect(text).not.toContain('no group-assignment route exposed');
    // Demo end to end: the demo customer joins the demo group.
    const assigned = await postForm(base, '/crm/customers/groups', {
      customerId: 'cust-demo-1',
      groupId: 'group-demo-1',
    });
    expect(assigned.status).toBe(200);
    expect(assigned.text).toContain('Customer assigned to group group-demo-1');
    expect(client.customerGroupMemberships).toHaveLength(1);
    expect(client.customerGroupMemberships[0]?.customer_id).toBe('cust-demo-1');
    // Idempotent on repeat: the same membership, no duplicate row.
    const repeated = await postForm(base, '/crm/customers/groups', {
      customerId: 'cust-demo-1',
      groupId: 'group-demo-1',
    });
    expect(repeated.status).toBe(200);
    expect(client.customerGroupMemberships).toHaveLength(1);
  });
});

describe('finance — live-shaped shell without a VAT read resolver (Build-06 Obj 3)', () => {
  it('close re-renders CLOSED with the same id and no spurious read error', async () => {
    const client = new FakeAdminApiClient({
      vatPeriods: [{ id: 'vat-live-1', period_start: '2026-10-01', period_end: '2026-12-31', status: 'open' }],
    });
    const shell = createAdminDashboardShell(client, { dataSource: 'live', tenantId: 'tenant-1' });
    const before = await shell.renderView('finance', { vatPeriodId: 'vat-live-1' });
    expect(before).toContain('No VAT-period read is available');
    const result = await shell.closeVatPeriod('vat-live-1');
    expect(result.closed).toBe(true);
    expect(result.period?.id).toBe('vat-live-1');
    const html = await shell.renderView('finance', { vatPeriodId: 'vat-live-1' }, {
      vatPeriodJustClosed: true,
      vatCloseAttempted: true,
      closedVatPeriod: result.period,
      action: { message: result.message, ok: true },
    });
    expect(html).toContain('CLOSED');
    expect(html).toContain('vat-live-1');
    expect(html).not.toContain('No VAT-period read is available');
  });

  it('settlement reconcile POST shows the T+3 summary with the expected net payout', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/finance/settlements/reconcile', {
      businessDate: '2026-11-13',
      providerReference: 'settle-1',
      settlementDate: '2026-11-16',
      grossPence: '10000',
      feePence: '140',
      reserveHoldPence: '0',
      disputeDebitPence: '0',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Business date 2026-11-13 settles 2026-11-16 (T+3)');
    expect(res.text).toContain('expected net payout 9860p');
    expect(res.text).toContain('Reconciled.');
    expect(client.calls.some((c) => c.routeKey === 'reporting.reconcileSettlement')).toBe(true);
  });
});

describe('webhooks — rotate secret show-once (Build-06 Obj 3)', () => {
  it('rotate-secret POST shows the secret once, then it disappears on the next GET', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/webhooks/endpoints/wh-ep-demo-1/rotate-secret', { gracePeriodHours: '24' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('whsec_fake-rotated-secret-shown-once');
    expect(res.text).toContain('shown once');
    expect(client.calls.some((c) => c.routeKey === 'webhooks.rotateSecret')).toBe(true);
    const page = await getText(base, '/webhooks');
    expect(page.text).not.toContain('whsec_fake-rotated-secret-shown-once');
  });

  it('rotate-secret on an unknown endpoint surfaces the API error (400, not 500)', async () => {
    const { base } = await bootDemoServer();
    const res = await postForm(base, '/webhooks/endpoints/wh-ep-nope/rotate-secret', { gracePeriodHours: '24' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('not found');
  });
});

describe('error surfacing — API failures render on the page, never a 500 (Build-06 Obj 3)', () => {
  it('a failing API call on a POST action returns 400 with the error message', async () => {
    const { shell, client } = createDemoShell();
    client.failNext(new ApiError(403, 'Forbidden: PLAN_GATED — webhooks not on this plan'));
    const server = createAdminWebServer(shell);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const res = await postForm(base, '/catalogue/price-books/create', {
      name: 'Blocked Book',
      priority: '1',
      effectiveFrom: '2026-11-14',
      effectiveTo: '',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('PLAN_GATED');
  });

  it('a throwing variant create (API error, not a validation failure) returns 400, not 500', async () => {
    // Regression: the variants/create handler checked result.ok but did
    // not catch a throw from the client call, so a live 401 became a 500.
    const { shell, client } = createDemoShell();
    client.failNext(new ApiError(401, 'Authentication required'));
    const server = createAdminWebServer(shell);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const res = await postForm(base, '/catalogue/variants/create', {
      productId: 'prod-demo-1',
      sku: 'FAIL-SKU-1',
      barcode: '',
      name: 'Failing Widget',
      pricePence: '1000',
      costPence: '400',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Authentication required');
    expect(res.text).not.toContain('Internal Server Error');
  });
});

describe('live-mode selection via createShellFromEnv (Build-06 Obj 3)', () => {
  const savedEnv = {
    ADMIN_API_BASE_URL: process.env.ADMIN_API_BASE_URL,
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
    ADMIN_TENANT_ID: process.env.ADMIN_TENANT_ID,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('without env vars the shell is demo; with ADMIN_API_BASE_URL + ADMIN_API_TOKEN it is live', () => {
    delete process.env.ADMIN_API_BASE_URL;
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.ADMIN_TENANT_ID;
    expect(createShellFromEnv().dataSource).toBe('demo');
    process.env.ADMIN_API_BASE_URL = 'http://127.0.0.1:3127';
    process.env.ADMIN_API_TOKEN = 'ukp_test_token';
    expect(createShellFromEnv().dataSource).toBe('live');
    process.env.ADMIN_TENANT_ID = 'tenant-1';
    expect(createShellFromEnv().dataSource).toBe('live');
  });

  it('live mode: a real PosApiClient over HTTP reaches the stub API and a form POST lands with the right payload', async () => {
    // Stub API implementing the wire shapes of apps/api for the catalogue
    // read routes and the price-book entry upsert.
    const requests: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
    const stub = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        await new Promise<void>((resolve) => req.on('end', resolve));
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        const url = new URL(req.url ?? '/', 'http://stub');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        }
        requests.push({ method: req.method ?? '', path: url.pathname, body, headers });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'GET' && url.pathname === '/v1/catalogue/variants') {
          return send(200, [{
            id: 'variant-stub-1', product_id: 'prod-stub-1', sku: 'STUB-001', barcode: null,
            name: 'Stub Widget', price_pence: '2500', cost_pence: '1000', tax_rate_id: null, is_bundle: false, is_active: true,
          }]);
        }
        if (req.method === 'GET' && url.pathname === '/v1/catalogue/price-books') return send(200, []);
        if (req.method === 'GET' && url.pathname === '/v1/catalogue/promotions') return send(200, []);
        if (req.method === 'GET' && url.pathname === '/v1/catalogue/vouchers') return send(200, []);
        const entry = /^\/v1\/price-books\/([^/]+)\/entries$/.exec(url.pathname);
        if (req.method === 'POST' && entry !== null) {
          const b = body as { variantId: string; pricePence: string };
          return send(200, { price_book_id: entry[1], variant_id: b.variantId, price_pence: b.pricePence });
        }
        return send(404, { message: 'not found' });
      })();
    });
    servers.push(stub);
    await new Promise<void>((resolve) => stub.listen(0, () => resolve()));
    const stubAddress = stub.address();
    const stubPort = typeof stubAddress === 'object' && stubAddress !== null ? stubAddress.port : 0;

    process.env.ADMIN_API_BASE_URL = `http://127.0.0.1:${stubPort}`;
    process.env.ADMIN_API_TOKEN = 'stub-token';
    process.env.ADMIN_TENANT_ID = 'tenant-stub-1';
    const shell = createShellFromEnv();
    expect(shell.dataSource).toBe('live');
    const server = createAdminWebServer(shell);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const page = await getText(base, '/catalogue');
    expect(page.status).toBe(200);
    expect(page.text).toContain('LIVE DATA');
    expect(page.text).toContain('Stub Widget');
    expect(page.text).toContain('STUB-001');

    const res = await postForm(base, '/catalogue/price-books/entries', {
      priceBookId: 'pb-stub-1',
      variantId: 'variant-stub-1',
      pricePence: '1999',
      mode: 'upsert',
    });
    expect(res.status).toBe(303);
    const entryCall = requests.find((r) => r.method === 'POST' && r.path === '/v1/price-books/pb-stub-1/entries');
    expect(entryCall).toBeDefined();
    expect(entryCall?.body).toEqual({ variantId: 'variant-stub-1', pricePence: '1999' });
    expect(entryCall?.headers['authorization']).toBe('Bearer stub-token');
  });
});

describe('inventory view — warehouses + suppliers forms (Build-10 Objective 2)', () => {
  it('renders the create-warehouse and create-supplier forms on the inventory page', async () => {
    const { shell } = createDemoShell();
    const data = await shell.loadInventoryData();
    const html = renderInventoryView(data);
    expect(html).toContain('action="/inventory/warehouses/create"');
    expect(html).toContain('name="locationId"');
    expect(html).toContain('action="/inventory/suppliers/create"');
    expect(html).toContain('name="leadTimeDays"');
    expect(html).toContain('Suppliers');
  });

  it('the suppliers section loads suppliers from the demo client, with no section error (Build-10 Objective 4)', async () => {
    // Obj 4 added the route-table entries, so the typed client's
    // listSuppliers now resolves through routeFor and the demo shell
    // loads the demo supplier instead of recording a section error
    // (the Build-09 product-routes intermediate state, same pattern,
    // resolved the same way). A section error here would mean the
    // route-table entry or the demo client regressed.
    const { shell } = createDemoShell();
    const data = await shell.loadInventoryData();
    expect(data.suppliers).toHaveLength(1);
    expect(data.suppliers[0]?.name).toBe('Demo Wholesale');
    expect(data.errors.some((e) => e.section === 'Suppliers')).toBe(false);
    const html = renderInventoryView(data);
    expect(html).toContain('Suppliers');
    expect(html).toContain('Demo Wholesale');
  });
});

describe('inventory view — stock balances show avg cost + total value (Build-11 Objective 1)', () => {
  it('renders the Avg cost and Total value columns from the demo balances', async () => {
    const { shell } = createDemoShell();
    const data = await shell.loadInventoryData();
    expect(data.stockBalances).toHaveLength(2);
    expect(data.stockBalances[0]?.weightedAvgCostPence).toBe('500');
    expect(data.stockBalances[0]?.totalValuePence).toBe('21000');
    const html = renderInventoryView(data);
    expect(html).toContain('Avg cost');
    expect(html).toContain('Total value');
    // 42 on hand × £5.00 avg = £210.00; 17 × £3.50 = £59.50.
    expect(html).toContain('£5.00');
    expect(html).toContain('£210.00');
    expect(html).toContain('£3.50');
    expect(html).toContain('£59.50');
  });

  it('a balance with no valuation row renders a dash in both cost columns', () => {
    const data = {
      dataSource: 'demo' as const,
      warehouses: [],
      stockBalances: [
        { variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '7', computedAt: new Date().toISOString(), weightedAvgCostPence: null, totalValuePence: null, stale: false, ageMs: 0 },
      ],
      transfers: [],
      inTransit: [],
      reorderSuggestions: [],
      purchaseOrders: [],
      goodsInLines: [],
      goodsInPoId: null,
      goodsInSupplierId: null,
      goodsInLocationId: null,
      goodsInWarehouseId: null,
      suppliers: [],
      supplierVariants: [],
      action: null,
      errors: [],
    };
    const html = renderInventoryView(data as never);
    expect(html).toContain('Avg cost');
    expect(html).toContain('<td>—</td>');
  });
});

describe('G-UI-06 forms — Build-12 Objective 3', () => {
  it('the catalogue view renders the update-variant form and no longer says there is no variant-update route', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('catalogue');
    expect(html).toContain('/catalogue/variants/update');
    expect(html).toContain('Update variant');
    expect(html).not.toContain('There is no variant-update route');
  });

  it('the inventory view renders the create-purchase-order form and no longer says there is no standalone route', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('inventory');
    expect(html).toContain('/inventory/purchase-orders/create');
    expect(html).toContain('Create draft purchase order');
    expect(html).not.toContain('There is no standalone create-PO route');
  });

  it('the CRM view renders the assign-to-group form and no longer says groups cannot be assigned', async () => {
    const { shell } = createDemoShell();
    const html = await shell.renderView('crm');
    expect(html).toContain('/crm/customers/groups');
    expect(html).toContain('Assign to group');
    expect(html).not.toContain('groups cannot be assigned from here');
  });

  it('a demo POST updates a variant price end to end (redirect + re-rendered price)', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/catalogue/variants/update', {
      variantId: 'variant-demo-1',
      pricePence: '1399',
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/catalogue');
    expect(client.variants.find((v) => v.id === 'variant-demo-1')?.price_pence).toBe('1399');
    const { text } = await getText(base, '/catalogue');
    expect(text).toContain('£13.99');
  });

  it('a demo POST creates a draft purchase order end to end (success message + new row)', async () => {
    const { base, client } = await bootDemoServer();
    const res = await postForm(base, '/inventory/purchase-orders/create', {
      supplierId: 'sup-demo-1',
      warehouseId: 'wh-demo-1',
      expectedDeliveryDate: '2026-12-01',
      variantId: 'variant-demo-1',
      quantityOrdered: '10',
      unitCostPence: '500',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Draft purchase order');
    expect(res.text).toContain('created (not sent)');
    const created = client.purchaseOrders.find((p) => p.status === 'draft');
    expect(created).toBeDefined();
    expect(created?.warehouse_id).toBe('wh-demo-1');
    expect(created?.expected_delivery_date).toBe('2026-12-01');
  });
});
