import { describe, expect, it } from 'vitest';
import { PosApiClient } from '../src/api/client';
import { ApiError, TerminationBlockedError, mapHttpError } from '../src/api/errors';
import { liveRoutes, notExposedRoutes, routeFor } from '../src/api/route-table';
import type { HttpResponse, HttpTransport } from '../src/api/http';

function recordingTransport(body: unknown, status = 200, headers: Record<string, string | undefined> = {}): { transport: HttpTransport; seen: Array<{ path: string; method: string; headers: Record<string, string>; body?: unknown }> } {
  const seen: Array<{ path: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const transport: HttpTransport = async (req, reqHeaders) => {
    seen.push({ path: req.path, method: req.method, headers: reqHeaders, body: req.body });
    const response: HttpResponse = { status, headers, body };
    return response;
  };
  return { transport, seen };
}

function clientWith(transport: HttpTransport): PosApiClient {
  return new PosApiClient({
    baseUrl: 'http://localhost:3000',
    credentials: { token: 'ukp_test-key', tenantId: 'tenant-1' },
    transport,
  });
}

describe('typed client — request mapping (live routes)', () => {
  it('listVariants sends GET to /v1/catalogue/variants with Bearer + x-tenant-id headers', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = clientWith(transport);
    await client.listVariants({ productId: 'prod-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/variants?productId=prod-1');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers['Authorization']).toBe('Bearer ukp_test-key');
    expect(seen[0]?.headers['x-tenant-id']).toBe('tenant-1');
  });

  it('createVariant POSTs the variant body to /v1/catalogue/variants', async () => {
    const created = { id: 'v-1', product_id: 'p', sku: 'SKU-1', barcode: null, name: 'Tea', price_pence: '250', cost_pence: '100', tax_rate_id: null, is_bundle: false, is_active: true };
    const { transport, seen } = recordingTransport(created);
    const client = clientWith(transport);
    const result = await client.createVariant({ productId: 'p', sku: 'SKU-1', name: 'Tea', pricePence: '250' });
    expect(result).toEqual(created);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/variants');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toMatchObject({ sku: 'SKU-1', pricePence: '250' });
  });

  it('listTaxRates GETs /v1/tax-rates with Bearer <redacted> x-tenant-id headers (Build-08 Objective 1)', async () => {
    const rates = [
      { id: 'r-1', name: 'Standard 20%', rate_bps: 2000, is_exempt: false, is_default_no_tax: false },
      { id: 'r-2', name: 'Exempt', rate_bps: 0, is_exempt: true, is_default_no_tax: true },
    ];
    const { transport, seen } = recordingTransport(rates);
    const client = clientWith(transport);
    const result = await client.listTaxRates();
    expect(result).toEqual(rates);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/tax-rates');
    expect(seen[0]?.method).toBe('GET');
    // A Bearer token is sent (the exact-value proof for this client
    // setup lives in the listVariants test above, same helper).
    expect(seen[0]?.headers['Authorization']).toMatch(/^Bearer \S+$/);
    expect(seen[0]?.headers['x-tenant-id']).toBe('tenant-1');
    expect(routeFor('catalogue.listTaxRates').scope).toBe('catalogue:read');
  });

  it('createProduct POSTs the product body to /v1/catalogue/products (Build-09 Objective 1)', async () => {
    const created = { id: 'p-1', category_id: null, name: 'Vape Liquid', description: null, is_active: true };
    const { transport, seen } = recordingTransport(created);
    const client = clientWith(transport);
    const result = await client.createProduct({ name: 'Vape Liquid' });
    expect(result).toEqual(created);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/products');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toMatchObject({ name: 'Vape Liquid' });
    // A Bearer token is sent (the exact-value proof for this client
    // setup lives in the listVariants test above, same helper).
    expect(seen[0]?.headers['Authorization']).toMatch(/^Bearer \S+$/);
    expect(seen[0]?.headers['x-tenant-id']).toBe('tenant-1');
    expect(routeFor('catalogue.createProduct').scope).toBe('catalogue:write');
  });

  it('listProducts/getProduct GET the catalogue product routes (Build-09 Objective 1)', async () => {
    const products = [{ id: 'p-1', category_id: null, name: 'Tea', description: null, is_active: true }];
    const { transport, seen } = recordingTransport(products);
    const client = clientWith(transport);
    expect(await client.listProducts()).toEqual(products);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/products');
    expect(seen[0]?.method).toBe('GET');
    const { transport: transport2, seen: seen2 } = recordingTransport(products[0]);
    const client2 = clientWith(transport2);
    expect(await client2.getProduct('p-1')).toEqual(products[0]);
    expect(seen2[0]?.path).toBe('http://localhost:3000/v1/catalogue/products/p-1');
    expect(seen2[0]?.method).toBe('GET');
    expect(routeFor('catalogue.listProducts').scope).toBe('catalogue:read');
    expect(routeFor('catalogue.getProduct').scope).toBe('catalogue:read');
  });

  it('createAgeRestriction POSTs to /v1/catalogue/age-restrictions and returns the array (Build-09 Objective 1)', async () => {
    const rows = [
      { id: 'r-1', variant_id: 'v-1', product_id: 'p-1', requires_challenge_25: true, min_age: 18 },
    ];
    const { transport, seen } = recordingTransport(rows);
    const client = clientWith(transport);
    const result = await client.createAgeRestriction({ variantId: 'v-1', minAge: 18 });
    expect(result).toEqual(rows);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toMatchObject({ variantId: 'v-1', minAge: 18 });
    expect(routeFor('catalogue.createAgeRestriction').scope).toBe('catalogue:write');
  });

  it('listAgeRestrictions GETs with variantId/productId query params (Build-09 Objective 1)', async () => {
    const rows = [
      { id: 'r-1', variant_id: 'v-1', product_id: 'p-1', requires_challenge_25: true, min_age: 18 },
    ];
    const { transport, seen } = recordingTransport(rows);
    const client = clientWith(transport);
    expect(await client.listAgeRestrictions({ variantId: 'v-1' })).toEqual(rows);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions?variantId=v-1');
    expect(seen[0]?.method).toBe('GET');
    const { transport: transport2, seen: seen2 } = recordingTransport(rows);
    const client2 = clientWith(transport2);
    expect(await client2.listAgeRestrictions({ productId: 'p-1' })).toEqual(rows);
    expect(seen2[0]?.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions?productId=p-1');
    expect(routeFor('catalogue.listAgeRestrictions').scope).toBe('catalogue:read');
  });

  it('createWarehouse POSTs the warehouse body to /v1/inventory/warehouses (Build-10 Objective 2; route-table entry Obj 4)', async () => {
    const created = { id: 'w-1', location_id: 'loc-1', name: 'Back Store', type: 'warehouse', is_default: false, created_at: '2026-11-15T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z' };
    const { transport, seen } = recordingTransport(created);
    const client = clientWith(transport);
    const result = await client.createWarehouse({ locationId: 'loc-1', name: 'Back Store', type: 'warehouse', isDefault: false });
    expect(result).toEqual(created);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/inventory/warehouses');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toMatchObject({ locationId: 'loc-1', name: 'Back Store', type: 'warehouse', isDefault: false });
    expect(routeFor('inventory.createWarehouse').scope).toBe('stock:write');
  });

  it('listWarehouses/getWarehouse GET the inventory warehouse routes (Build-10 Objective 2; entries Obj 4 — listWarehouses tabled since Build-04)', async () => {
    const warehouses = [{ id: 'w-1', location_id: 'loc-1', name: 'Main Store', type: 'store', is_default: true, created_at: '2026-11-15T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z' }];
    const { transport, seen } = recordingTransport(warehouses);
    const client = clientWith(transport);
    expect(await client.listWarehouses()).toEqual(warehouses);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/inventory/warehouses');
    expect(seen[0]?.method).toBe('GET');
    const { transport: transport2, seen: seen2 } = recordingTransport(warehouses[0]);
    const client2 = clientWith(transport2);
    expect(await client2.getWarehouse('w-1')).toEqual(warehouses[0]);
    expect(seen2[0]?.path).toBe('http://localhost:3000/v1/inventory/warehouses/w-1');
    expect(seen2[0]?.method).toBe('GET');
    expect(routeFor('inventory.listWarehouses').scope).toBe('stock:read');
    expect(routeFor('inventory.getWarehouse').scope).toBe('stock:read');
  });

  it('createSupplier POSTs to /v1/purchasing/suppliers; list/getSuppliers GET the supplier routes (Build-10 Objective 2; entries Obj 4)', async () => {
    const supplier = { id: 's-1', name: 'Acme Wholesale', currency: 'GBP', lead_time_days: 3, minimum_order_value_pence: '1000', contact_name: null, email: null, phone: null, created_at: '2026-11-15T00:00:00.000Z', updated_at: '2026-11-15T00:00:00.000Z' };
    const { transport, seen } = recordingTransport(supplier);
    const client = clientWith(transport);
    const result = await client.createSupplier({ name: 'Acme Wholesale', currency: 'GBP', leadTimeDays: 3, minOrderValuePence: '1000' });
    expect(result).toEqual(supplier);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/purchasing/suppliers');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toMatchObject({ name: 'Acme Wholesale', currency: 'GBP', leadTimeDays: 3, minOrderValuePence: '1000' });
    expect(routeFor('purchasing.createSupplier').scope).toBe('stock:write');
    const { transport: transport2, seen: seen2 } = recordingTransport([supplier]);
    const client2 = clientWith(transport2);
    expect(await client2.listSuppliers()).toEqual([supplier]);
    expect(seen2[0]?.path).toBe('http://localhost:3000/v1/purchasing/suppliers');
    expect(seen2[0]?.method).toBe('GET');
    const { transport: transport3, seen: seen3 } = recordingTransport(supplier);
    const client3 = clientWith(transport3);
    expect(await client3.getSupplier('s-1')).toEqual(supplier);
    expect(seen3[0]?.path).toBe('http://localhost:3000/v1/purchasing/suppliers/s-1');
    expect(seen3[0]?.method).toBe('GET');
    expect(routeFor('purchasing.listSuppliers').scope).toBe('stock:read');
    expect(routeFor('purchasing.getSupplier').scope).toBe('stock:read');
  });

  it('linkSupplierVariant POSTs to /v1/purchasing/suppliers/:id/variants (Build-10 Objective 2; entry Obj 4)', async () => {
    const link = { supplier_id: 's-1', variant_id: 'v-1', supplier_sku: 'A-1', cost_pence: '350', currency: 'GBP', is_preferred: true };
    const { transport, seen } = recordingTransport(link);
    const client = clientWith(transport);
    const result = await client.linkSupplierVariant('s-1', { variantId: 'v-1', supplierSku: 'A-1', costPence: '350', isPreferred: true });
    expect(result).toEqual(link);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/purchasing/suppliers/s-1/variants');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toMatchObject({ variantId: 'v-1', supplierSku: 'A-1', costPence: '350', isPreferred: true });
    expect(routeFor('purchasing.linkSupplierVariant').scope).toBe('stock:write');
  });

  it('getBalances GETs /v1/inventory/balances and maps the snake_case cost fields (Build-11 Objective 1; entries Obj 4)', async () => {
    const body = {
      balances: [
        { variant_id: 'v-1', warehouse_id: 'w-1', quantity_on_hand: '10', weighted_avg_cost_pence: '400', total_value_pence: '4000', computed_at: '2026-11-15T00:00:00.000Z' },
        { variant_id: 'v-2', warehouse_id: 'w-1', quantity_on_hand: '3', weighted_avg_cost_pence: null, total_value_pence: null, computed_at: '2026-11-15T00:00:00.000Z' },
      ],
    };
    const { transport, seen } = recordingTransport(body);
    const client = clientWith(transport);
    const result = await client.getBalances();
    expect(result).toEqual([
      { variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '10', weightedAvgCostPence: '400', totalValuePence: '4000', computedAt: '2026-11-15T00:00:00.000Z' },
      { variantId: 'v-2', warehouseId: 'w-1', quantityOnHand: '3', weightedAvgCostPence: null, totalValuePence: null, computedAt: '2026-11-15T00:00:00.000Z' },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/inventory/balances');
    expect(seen[0]?.method).toBe('GET');
    const { transport: transport2, seen: seen2 } = recordingTransport({ balances: [] });
    const client2 = clientWith(transport2);
    expect(await client2.getBalances({ variantId: 'v-1', warehouseId: 'w-1' })).toEqual([]);
    expect(seen2[0]?.path).toBe('http://localhost:3000/v1/inventory/balances?variantId=v-1&warehouseId=w-1');
    expect(routeFor('inventory.getBalances').scope).toBe('stock:read');
  });

  it('getValuation GETs /v1/inventory/valuation and maps the per-variant roll-up + totals (Build-11 Objective 1; entries Obj 4)', async () => {
    const body = {
      valuation: [
        { variant_id: 'v-1', total_quantity_on_hand: '10', weighted_avg_cost_pence: '400', total_value_pence: '4000' },
      ],
      totals: { total_quantity_on_hand: '10', total_value_pence: '4000' },
    };
    const { transport, seen } = recordingTransport(body);
    const client = clientWith(transport);
    const result = await client.getValuation();
    expect(result).toEqual({
      valuation: [
        { variantId: 'v-1', totalQuantityOnHand: '10', weightedAvgCostPence: '400', totalValuePence: '4000' },
      ],
      totals: { totalQuantityOnHand: '10', totalValuePence: '4000' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/inventory/valuation');
    expect(seen[0]?.method).toBe('GET');
    const { transport: transport2, seen: seen2 } = recordingTransport({ valuation: [], totals: { total_quantity_on_hand: '0', total_value_pence: null } });
    const client2 = clientWith(transport2);
    expect(await client2.getValuation({ variantId: 'v-9' })).toEqual({
      valuation: [],
      totals: { totalQuantityOnHand: '0', totalValuePence: null },
    });
    expect(seen2[0]?.path).toBe('http://localhost:3000/v1/inventory/valuation?variantId=v-9');
    expect(routeFor('inventory.getValuation').scope).toBe('stock:read');
  });

  it('updateVariant PATCHes /v1/catalogue/variants/:id and returns the snake_case view (Build-12 Objective 3; entry Obj 4)', async () => {
    const updated = { id: 'v-1', product_id: 'p-1', sku: 'SKU-1', barcode: null, name: 'Tea', price_pence: '300', cost_pence: '100', tax_rate_id: null, is_bundle: false, is_active: true };
    const { transport, seen } = recordingTransport(updated);
    const client = clientWith(transport);
    const result = await client.updateVariant('v-1', { pricePence: '300' });
    expect(result).toEqual(updated);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/variants/v-1');
    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.body).toEqual({ pricePence: '300' });
    expect(routeFor('catalogue.updateVariant').scope).toBe('catalogue:write');
  });

  it('deleteAgeRestriction DELETEs /v1/catalogue/age-restrictions/:id and returns the deleted rule + inherited ids (Build-12 Objective 2; entry Obj 4)', async () => {
    const deleted = {
      deleted_rule: { id: 'r-1', variant_id: null, product_id: 'p-1', requires_challenge_25: true, min_age: 18, rule_source: 'explicit' },
      deleted_inherited_rule_ids: ['r-2', 'r-3'],
    };
    const { transport, seen } = recordingTransport(deleted);
    const client = clientWith(transport);
    const result = await client.deleteAgeRestriction('r-1');
    expect(result).toEqual(deleted);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions/r-1');
    expect(seen[0]?.method).toBe('DELETE');
    expect(routeFor('catalogue.deleteAgeRestriction').scope).toBe('catalogue:write');
  });

  it('createPurchaseOrder POSTs the draft PO body to /v1/inventory/purchase-orders (Build-12 Objective 3; entry Obj 4)', async () => {
    const created = {
      id: 'po-1', location_id: 'loc-1', supplier_id: 'sup-1', po_number: 'PO-0001', status: 'draft', sent_at: null,
      warehouse_id: 'w-1', expected_delivery_date: '2026-11-20',
      lines: [{ variant_id: 'v-1', quantity_ordered: '10', quantity_received: '0', cost_pence: '400' }],
    };
    const { transport, seen } = recordingTransport(created);
    const client = clientWith(transport);
    const input = { supplierId: 'sup-1', warehouseId: 'w-1', expectedDeliveryDate: '2026-11-20', lines: [{ variantId: 'v-1', quantityOrdered: '10', unitCostPence: '400' }] };
    const result = await client.createPurchaseOrder(input);
    expect(result).toEqual(created);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/inventory/purchase-orders');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual(input);
    expect(routeFor('inventory.createPurchaseOrder').scope).toBe('stock:write');
  });

  it('assignCustomerToGroup POSTs { groupId } to /v1/crm/customers/:id/groups (Build-12 Objective 3; entry Obj 4)', async () => {
    const membership = { customer_id: 'c-1', group_id: 'g-1', created_at: '2026-11-15T00:00:00.000Z' };
    const { transport, seen } = recordingTransport(membership);
    const client = clientWith(transport);
    const result = await client.assignCustomerToGroup('c-1', 'g-1');
    expect(result).toEqual(membership);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/crm/customers/c-1/groups');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual({ groupId: 'g-1' });
    expect(routeFor('crm.assignCustomerToGroup').scope).toBe('admin');
  });

  it('priceBasket POSTs lines to /v1/catalogue/price-basket (the only pricing path)', async () => {
    const basket = { lines: [], subtotalPence: '0', discountPence: '0', taxPence: '0', totalPence: '0', voucherPromotionId: null, voucherDiscountPence: null };
    const { transport, seen } = recordingTransport(basket);
    const client = clientWith(transport);
    await client.priceBasket({ lines: [{ variantId: 'v-1', quantity: '2' }], voucherCode: 'SAVE10' });
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/catalogue/price-basket');
    expect(seen[0]?.body).toMatchObject({ voucherCode: 'SAVE10', lines: [{ variantId: 'v-1', quantity: '2' }] });
  });

  it('getStock maps the { stock: [...] } envelope and sends the stock scope route', async () => {
    const { transport, seen } = recordingTransport({ stock: [{ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '12' }] });
    const client = clientWith(transport);
    const levels = await client.getStock({ variantId: 'v-1' });
    expect(levels).toEqual([{ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '12', computedAt: null }]);
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/inventory/stock?variantId=v-1');
  });

  it('listAuditEvents sends limit + eventType as query params', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = clientWith(transport);
    await client.listAuditEvents({ limit: 10, eventType: 'approval.granted' });
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/audit-events?limit=10&eventType=approval.granted');
  });

  it('listApiKeys hits the admin-scoped route', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = clientWith(transport);
    await client.listApiKeys();
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/api-keys');
    expect(routeFor('apiKeys.list').scope).toBe('admin');
  });

  it('listEvents passes the delivery_status filter for the DLQ view', async () => {
    const { transport, seen } = recordingTransport({ events: [], nextCursor: null });
    const client = clientWith(transport);
    await client.listEvents({ deliveryStatus: 'dead_letter' });
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/events?delivery_status=dead_letter');
  });

  it('sends the key as X-Api-Key when useApiKeyHeader is set', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = new PosApiClient({
      baseUrl: 'http://localhost:3000',
      credentials: { token: 'ukp_test-key', useApiKeyHeader: true },
      transport,
    });
    await client.listApiKeys();
    expect(seen[0]?.headers['X-Api-Key']).toBe('ukp_test-key');
    expect(seen[0]?.headers['Authorization']).toBeUndefined();
  });
});

describe('typed client — error mapping', () => {
  it('maps 404 (cross-tenant is 404, never 403) to ApiError.isNotFound', () => {
    const error = mapHttpError(404, { message: 'Resource not found' }, {});
    expect(error).toBeInstanceOf(ApiError);
    expect(error.isNotFound).toBe(true);
    expect(error.isForbidden).toBe(false);
  });

  it('maps 403 PLAN_GATED distinctly from a scope 403', () => {
    const gated = mapHttpError(403, { message: 'PLAN_GATED: this write requires the plus tier' }, {});
    expect(gated.isPlanGated).toBe(true);
    const scoped = mapHttpError(403, { message: 'This credential does not carry the required scope: admin' }, {});
    expect(scoped.isPlanGated).toBe(false);
    expect(scoped.isForbidden).toBe(true);
  });

  it('maps 429 RATE_LIMITED with Retry-After seconds', () => {
    const error = mapHttpError(429, { message: 'Too many requests', error: { code: 'RATE_LIMITED' } }, { 'retry-after': '7' });
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBe(7);
  });

  it('maps a 409 with blocking ids to TerminationBlockedError carrying the exact ids', () => {
    const error = mapHttpError(
      409,
      { message: 'Termination blocked', openSessionIds: ['sess-1', 'sess-2'], blockingPaymentAttemptIds: ['att-9'] },
      {},
    );
    expect(error).toBeInstanceOf(TerminationBlockedError);
    const blocked = error as TerminationBlockedError;
    expect(blocked.openSessionIds).toEqual(['sess-1', 'sess-2']);
    expect(blocked.blockingPaymentAttemptIds).toEqual(['att-9']);
  });

  it('a live 409 from the transport surfaces as TerminationBlockedError', async () => {
    // requestTermination itself is not exposed over HTTP, so prove the
    // transport→error path on a live route returning the same 409 shape.
    const { transport } = recordingTransport(
      { message: 'Termination blocked', openSessionIds: ['sess-1'], blockingPaymentAttemptIds: [] },
      409,
    );
    const client = clientWith(transport);
    await expect(client.createVariant({ productId: 'p', sku: 'SKU-1', name: 'Tea', pricePence: '250' })).rejects.toBeInstanceOf(TerminationBlockedError);
  });
});

describe('typed client — newly live routes call the server (Build-04 Worker 4)', () => {
  it('the previously not-exposed methods now hit their real routes', async () => {
    const { transport, seen } = recordingTransport({});
    const client = clientWith(transport);
    await client.getZReport('z-1');
    await client.requestTermination();
    await client.listPriceBooks();
    await client.exportZReportCsv('z-1');
    await client.replayDeadLetter('d-1');
    await client.eraseCustomer('c-1');
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET http://localhost:3000/v1/reporting/z-reports/z-1',
      'POST http://localhost:3000/v1/admin/exit/request-termination',
      'GET http://localhost:3000/v1/catalogue/price-books',
      'GET http://localhost:3000/v1/reporting/z-reports/z-1/csv',
      'POST http://localhost:3000/v1/webhooks/deliveries/d-1/replay',
      'POST http://localhost:3000/v1/crm/customers/c-1/erase',
    ]);
  });

  it('setPriceBookEntry POSTs to /v1/price-books/:id/entries (Build-05, live — no longer NotExposed)', async () => {
    const { transport, seen } = recordingTransport({ price_book_id: 'pb-1', variant_id: 'v-1', price_pence: '250' });
    const client = clientWith(transport);
    const result = await client.setPriceBookEntry('pb-1', { price_book_id: 'pb-1', variant_id: 'v-1', price_pence: '250' });
    expect(result).toEqual({ price_book_id: 'pb-1', variant_id: 'v-1', price_pence: '250' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/price-books/pb-1/entries');
    expect(seen[0]?.body).toEqual({ variantId: 'v-1', pricePence: '250' });
  });

  it('updatePriceBookEntry PUTs to /v1/price-books/:id/entries/:variantId (Build-05)', async () => {
    const { transport, seen } = recordingTransport({ price_book_id: 'pb-1', variant_id: 'v-1', price_pence: '300' });
    const client = clientWith(transport);
    await client.updatePriceBookEntry('pb-1', 'v-1', '300');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/price-books/pb-1/entries/v-1');
    expect(seen[0]?.body).toEqual({ pricePence: '300' });
  });

  it('pinLogin POSTs to /v1/auth/pin-login and returns the session token (Build-05)', async () => {
    const { transport, seen } = recordingTransport({ token: 'sess_abc', actor: { tenantId: 'tenant-1', userId: 'user-1', locationId: 'loc-1', roles: ['cashier'] } });
    const client = clientWith(transport);
    const result = await client.pinLogin({ tenantId: 'tenant-1', userId: 'user-1', pin: '1234', locationId: 'loc-1' });
    expect(result.token).toBe('sess_abc');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/auth/pin-login');
    expect(seen[0]?.body).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', pin: '1234' });
  });

  it('generatePromotionVouchers maps the show-once issued_codes envelope (Build-05)', async () => {
    const { transport, seen } = recordingTransport({
      promotion_id: 'promo-1',
      issued_codes: [{ id: 'vc-1', code: 'ABCD-EFGH-IJKL-MNOP', code_last4: 'MNOP', expires_at: null }],
    });
    const client = clientWith(transport);
    const result = await client.generatePromotionVouchers('promo-1', { count: 1, maxUses: 1 });
    expect(result).toEqual({
      promotionId: 'promo-1',
      issuedCodes: [{ id: 'vc-1', code: 'ABCD-EFGH-IJKL-MNOP', code_last4: 'MNOP', expires_at: null }],
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/promotions/promo-1/vouchers/bulk');
  });

  it('rotateWebhookSecret POSTs to /v1/webhooks/subscriptions/:id/rotate-secret (Build-05)', async () => {
    const { transport, seen } = recordingTransport({ endpoint_id: 'ep-1', secret: 'new-secret', previous_secret_expires_at: '2026-11-14T12:00:00.000Z', grace_period_hours: 24 });
    const client = clientWith(transport);
    const result = await client.rotateWebhookSecret('ep-1');
    expect(result.secret).toBe('new-secret');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/webhooks/subscriptions/ep-1/rotate-secret');
    expect(seen[0]?.body).toEqual({});
  });

  it('listStatutoryArchives GETs /v1/compliance/statutory-archives/:tenantId (Build-05)', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = clientWith(transport);
    await client.listStatutoryArchives('tenant-1');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.path).toBe('http://localhost:3000/v1/compliance/statutory-archives/tenant-1');
  });

  it('the route table accounts for every Build-05 route plus Build-06/07/08/09/10/11/12 additions (101 entries; 104 API routes minus 3 sync)', () => {
    const live = liveRoutes().map((r) => r.key);
    expect(liveRoutes()).toHaveLength(101);
    for (const key of ['catalogue.setPriceBookEntry', 'catalogue.updatePriceBookEntry', 'catalogue.generatePromotionVouchers', 'webhooks.rotateSecret', 'compliance.listStatutoryArchives', 'auth.pinLogin', 'reporting.openSession', 'reporting.endSession', 'reporting.closeSession', 'webhooks.reprovisionSecret', 'exit.hardDelete', 'reporting.getVatPeriod', 'webhooks.reEncryptSecrets', 'catalogue.listTaxRates', 'catalogue.getTaxRate', 'catalogue.createProduct', 'catalogue.listProducts', 'catalogue.getProduct', 'catalogue.createAgeRestriction', 'catalogue.listAgeRestrictions', 'sales.listAgeVerifications', 'inventory.createWarehouse', 'inventory.getWarehouse', 'purchasing.createSupplier', 'purchasing.listSuppliers', 'purchasing.getSupplier', 'purchasing.linkSupplierVariant', 'inventory.getBalances', 'inventory.getValuation', 'catalogue.updateVariant', 'catalogue.deleteAgeRestriction', 'inventory.createPurchaseOrder', 'crm.assignCustomerToGroup']) {
      expect(live).toContain(key);
    }
    expect(notExposedRoutes()).toHaveLength(0);
  });

  it('the route table records the live surface exactly (no invented live route)', () => {
    const live = liveRoutes().map((r) => r.key);
    for (const key of ['catalogue.createVariant', 'catalogue.priceBasket', 'inventory.receiveGoodsIn', 'inventory.getStock', 'audit.list', 'apiKeys.list', 'events.list', 'sales.getReceipt']) {
      expect(live).toContain(key);
    }
    // Build-04 Worker 4 wired all 37 previously not-exposed routes.
    for (const key of ['reporting.getZReport', 'reporting.exportZReportCsv', 'exit.requestTermination', 'crm.eraseCustomer', 'webhooks.replayDeadLetter', 'catalogue.listPriceBooks', 'auth.pinLogin']) {
      expect(live).toContain(key);
    }
    // Nothing is left not-exposed: every route in the table is live.
    expect(notExposedRoutes()).toHaveLength(0);
  });

  it('routeAvailability reports live=true with the proposed route for reporting', () => {
    const { transport } = recordingTransport({});
    const client = clientWith(transport);
    const availability = client.routeAvailability('reporting.exportZReportCsv');
    expect(availability.live).toBe(true);
    expect(availability.proposedRoute).toBe('GET /v1/reporting/z-reports/:id/csv');
    expect(availability.serviceMethod).toBe('ReportingService.exportZReportCsv');
  });
});
