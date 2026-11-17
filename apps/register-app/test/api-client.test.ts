/**
 * Register API client tests (Build-05, Objectives 1–2).
 *
 * pinLogin + setPriceBookEntry / updatePriceBookEntry against a
 * recording transport — no live server. Proves the request mapping
 * (method, path, body, Bearer header), that pinLogin stores the
 * session token for later calls, and that price-book writes refuse
 * to run before a login.
 */
import { describe, expect, it } from 'vitest';
import {
  RegisterApiClient,
  RegisterApiError,
  type RegisterApiRequest,
  type RegisterApiResponse,
  type RegisterApiTransport,
} from '../src/api/client';

function recordingTransport(
  body: unknown,
  status = 200,
): {
  transport: RegisterApiTransport;
  seen: Array<{ request: RegisterApiRequest; headers: Record<string, string> }>;
} {
  const seen: Array<{ request: RegisterApiRequest; headers: Record<string, string> }> = [];
  const transport: RegisterApiTransport = async (request, headers) => {
    seen.push({ request, headers });
    const response: RegisterApiResponse = { status, body };
    return response;
  };
  return { transport, seen };
}

describe('RegisterApiClient — pinLogin', () => {
  it('POSTs to /v1/auth/pin-login with no Authorization header and stores the token', async () => {
    const { transport, seen } = recordingTransport({
      token: 'sess_abc',
      actor: { tenantId: 'tenant-1', userId: 'user-1', locationId: 'loc-1', roles: ['cashier'] },
    });
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    expect(client.sessionToken).toBeNull();

    const result = await client.pinLogin({
      tenantId: 'tenant-1',
      userId: 'user-1',
      pin: '1234',
      locationId: 'loc-1',
    });
    expect(result.token).toBe('sess_abc');
    expect(client.sessionToken).toBe('sess_abc');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/auth/pin-login');
    expect(seen[0]?.request.body).toMatchObject({ tenantId: 'tenant-1', pin: '1234' });
    expect(seen[0]?.headers['Authorization']).toBeUndefined();
  });

  it('a non-2xx login surfaces as RegisterApiError with the status', async () => {
    const { transport } = recordingTransport({ message: 'Resource not found' }, 404);
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    await expect(
      client.pinLogin({ tenantId: 'tenant-1', userId: 'user-1', pin: '0000' }),
    ).rejects.toBeInstanceOf(RegisterApiError);
    expect(client.sessionToken).toBeNull();
  });
});

describe('RegisterApiClient — price-book entries', () => {
  it('setPriceBookEntry POSTs the entry with the session Bearer token', async () => {
    const { transport, seen } = recordingTransport({
      price_book_id: 'pb-1',
      variant_id: 'v-1',
      price_pence: '250',
    });
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.setPriceBookEntry('pb-1', { variantId: 'v-1', pricePence: '250' });
    expect(result).toEqual({ price_book_id: 'pb-1', variant_id: 'v-1', price_pence: '250' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/price-books/pb-1/entries');
    expect(seen[0]?.request.body).toEqual({ variantId: 'v-1', pricePence: '250' });
    expect(seen[0]?.headers['Authorization']).toBe('Bearer sess_abc');
  });

  it('updatePriceBookEntry PUTs to /v1/price-books/:id/entries/:variantId', async () => {
    const { transport, seen } = recordingTransport({
      price_book_id: 'pb-1',
      variant_id: 'v-1',
      price_pence: '300',
    });
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    await client.updatePriceBookEntry('pb-1', 'v-1', '300');
    expect(seen[0]?.request.method).toBe('PUT');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/price-books/pb-1/entries/v-1');
    expect(seen[0]?.request.body).toEqual({ pricePence: '300' });
  });

  it('price-book writes refuse to run before pinLogin (no session token)', async () => {
    const { transport, seen } = recordingTransport({});
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    await expect(
      client.setPriceBookEntry('pb-1', { variantId: 'v-1', pricePence: '250' }),
    ).rejects.toThrow('call pinLogin first');
    expect(seen).toHaveLength(0);
  });
});

describe('RegisterApiClient — tax rates (Build-08 Objective 1)', () => {
  it('listTaxRates GETs /v1/tax-rates with the session Bearer <redacted>', async () => {
    const rates = [
      { id: 'r-1', name: 'Standard 20%', rate_bps: 2000, is_exempt: false, is_default_no_tax: false },
      { id: 'r-2', name: 'Exempt', rate_bps: 0, is_exempt: true, is_default_no_tax: true },
    ];
    const { transport, seen } = recordingTransport(rates);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.listTaxRates();
    expect(result).toEqual(rates);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.method).toBe('GET');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/tax-rates');
    expect(seen[0]?.request.body).toBeUndefined();
    expect(seen[0]?.headers['Authorization']).toBe(`Bearer ${client.sessionToken}`);
  });

  it('listTaxRates refuses to run before pinLogin (no session token)', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    await expect(client.listTaxRates()).rejects.toThrow('call pinLogin first');
    expect(seen).toHaveLength(0);
  });
});

describe('RegisterApiClient — products + age restrictions (Build-09 Objective 1)', () => {
  it('createProduct POSTs to /v1/catalogue/products with the session Bearer <redacted>', async () => {
    const product = { id: 'p-1', category_id: null, name: 'Vape Liquid', description: null, is_active: true };
    const { transport, seen } = recordingTransport(product);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.createProduct({ name: 'Vape Liquid' });
    expect(result).toEqual(product);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/catalogue/products');
    expect(seen[0]?.request.body).toEqual({ name: 'Vape Liquid' });
    expect(seen[0]?.headers['Authorization']).toBe(`Bearer ${client.sessionToken}`);
  });

  it('listProducts/getProduct GET the catalogue product routes', async () => {
    const products = [{ id: 'p-1', category_id: null, name: 'Tea', description: null, is_active: true }];
    const { transport, seen } = recordingTransport(products);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    expect(await client.listProducts()).toEqual(products);
    expect(seen[0]?.request.method).toBe('GET');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/catalogue/products');
    const { transport: transport2, seen: seen2 } = recordingTransport(products[0]);
    const client2 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport2,
    });
    expect(await client2.getProduct('p-1')).toEqual(products[0]);
    expect(seen2[0]?.request.path).toBe('http://localhost:3000/v1/catalogue/products/p-1');
  });

  it('createAgeRestriction POSTs to /v1/catalogue/age-restrictions and returns the array', async () => {
    const rows = [
      { id: 'r-1', variant_id: 'v-1', product_id: 'p-1', requires_challenge_25: true, min_age: 18 },
    ];
    const { transport, seen } = recordingTransport(rows);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.createAgeRestriction({ variantId: 'v-1', minAge: 18 });
    expect(result).toEqual(rows);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions');
    expect(seen[0]?.request.body).toEqual({ variantId: 'v-1', minAge: 18 });
  });

  it('listAgeRestrictions GETs with variantId/productId query params', async () => {
    const rows = [
      { id: 'r-1', variant_id: 'v-1', product_id: 'p-1', requires_challenge_25: true, min_age: 18 },
    ];
    const { transport, seen } = recordingTransport(rows);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    expect(await client.listAgeRestrictions({ variantId: 'v-1' })).toEqual(rows);
    expect(seen[0]?.request.path).toBe(
      'http://localhost:3000/v1/catalogue/age-restrictions?variantId=v-1',
    );
    const { transport: transport2, seen: seen2 } = recordingTransport(rows);
    const client2 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport2,
    });
    expect(await client2.listAgeRestrictions({ productId: 'p-1' })).toEqual(rows);
    expect(seen2[0]?.request.path).toBe(
      'http://localhost:3000/v1/catalogue/age-restrictions?productId=p-1',
    );
    const { transport: transport3, seen: seen3 } = recordingTransport(rows);
    const client3 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport3,
    });
    expect(await client3.listAgeRestrictions()).toEqual(rows);
    expect(seen3[0]?.request.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions');
  });

  it('deleteAgeRestriction DELETEs /v1/catalogue/age-restrictions/:id and returns the summary', async () => {
    const summary = {
      deleted_rule: {
        id: 'r-1',
        variant_id: null,
        product_id: 'p-1',
        requires_challenge_25: true,
        min_age: 21,
        rule_source: 'explicit',
      },
      deleted_inherited_rule_ids: ['r-2'],
    };
    const { transport, seen } = recordingTransport(summary);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.deleteAgeRestriction('r-1');
    expect(result).toEqual(summary);
    expect(seen[0]?.request.method).toBe('DELETE');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/catalogue/age-restrictions/r-1');
    expect(seen[0]?.request.body).toBeUndefined();
  });

  it('product + age-restriction calls refuse to run before pinLogin (no session token)', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    await expect(client.createProduct({ name: 'Tea' })).rejects.toThrow('call pinLogin first');
    await expect(client.listProducts()).rejects.toThrow('call pinLogin first');
    await expect(client.createAgeRestriction({ variantId: 'v-1' })).rejects.toThrow(
      'call pinLogin first',
    );
    await expect(client.listAgeRestrictions()).rejects.toThrow('call pinLogin first');
    await expect(client.deleteAgeRestriction('r-1')).rejects.toThrow('call pinLogin first');
    expect(seen).toHaveLength(0);
  });
});

describe('RegisterApiClient — warehouses + suppliers (Build-10 Objective 2)', () => {
  it('createWarehouse POSTs to /v1/inventory/warehouses with the session Bearer token', async () => {
    const warehouse = { id: 'w-1', location_id: 'loc-1', name: 'Back Store', type: 'store', is_default: false };
    const { transport, seen } = recordingTransport(warehouse);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.createWarehouse({ locationId: 'loc-1', name: 'Back Store', type: 'store' });
    expect(result).toEqual(warehouse);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/inventory/warehouses');
    expect(seen[0]?.request.body).toEqual({ locationId: 'loc-1', name: 'Back Store', type: 'store' });
    expect(seen[0]?.headers['Authorization']).toBe(`Bearer ${client.sessionToken}`);
  });

  it('listWarehouses/getWarehouse GET the inventory warehouse routes', async () => {
    const warehouses = [{ id: 'w-1', location_id: 'loc-1', name: 'Main Store', type: 'store', is_default: true }];
    const { transport, seen } = recordingTransport(warehouses);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    expect(await client.listWarehouses()).toEqual(warehouses);
    expect(seen[0]?.request.method).toBe('GET');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/inventory/warehouses');
    const { transport: transport2, seen: seen2 } = recordingTransport(warehouses[0]);
    const client2 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport2,
    });
    expect(await client2.getWarehouse('w-1')).toEqual(warehouses[0]);
    expect(seen2[0]?.request.path).toBe('http://localhost:3000/v1/inventory/warehouses/w-1');
  });

  it('createSupplier POSTs to /v1/purchasing/suppliers; list/getSuppliers GET the supplier routes', async () => {
    const supplier = { id: 's-1', name: 'Acme', contact_name: null, email: null, phone: null, lead_time_days: 2, minimum_order_value_pence: '2500', currency: 'GBP' };
    const { transport, seen } = recordingTransport(supplier);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.createSupplier({ name: 'Acme', leadTimeDays: 2, minOrderValuePence: '2500' });
    expect(result).toEqual(supplier);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/purchasing/suppliers');
    expect(seen[0]?.request.body).toEqual({ name: 'Acme', leadTimeDays: 2, minOrderValuePence: '2500' });
    const { transport: transport2, seen: seen2 } = recordingTransport([supplier]);
    const client2 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport2,
    });
    expect(await client2.listSuppliers()).toEqual([supplier]);
    expect(seen2[0]?.request.path).toBe('http://localhost:3000/v1/purchasing/suppliers');
    const { transport: transport3, seen: seen3 } = recordingTransport(supplier);
    const client3 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport3,
    });
    expect(await client3.getSupplier('s-1')).toEqual(supplier);
    expect(seen3[0]?.request.path).toBe('http://localhost:3000/v1/purchasing/suppliers/s-1');
  });

  it('linkSupplierVariant POSTs to /v1/purchasing/suppliers/:id/variants', async () => {
    const link = { supplier_id: 's-1', variant_id: 'v-1', supplier_sku: 'A-1', cost_pence: '350', currency: 'GBP', is_preferred: true };
    const { transport, seen } = recordingTransport(link);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    const result = await client.linkSupplierVariant('s-1', { variantId: 'v-1', supplierSku: 'A-1', costPence: '350', isPreferred: true });
    expect(result).toEqual(link);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.path).toBe('http://localhost:3000/v1/purchasing/suppliers/s-1/variants');
    expect(seen[0]?.request.body).toEqual({ variantId: 'v-1', supplierSku: 'A-1', costPence: '350', isPreferred: true });
  });

  it('warehouse/supplier calls refuse to run before pinLogin (no session token)', async () => {
    const { transport, seen } = recordingTransport([]);
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    await expect(client.listWarehouses()).rejects.toThrow('call pinLogin first');
    await expect(client.listSuppliers()).rejects.toThrow('call pinLogin first');
    expect(seen).toHaveLength(0);
  });
});

describe('RegisterApiClient — balances + valuation (Build-11 Objective 1)', () => {
  it('getBalances GETs /v1/inventory/balances with variantId/warehouseId query params', async () => {
    const body = {
      balances: [
        {
          variant_id: 'v-1',
          warehouse_id: 'w-1',
          quantity_on_hand: '20',
          weighted_avg_cost_pence: '500',
          total_value_pence: '10000',
          computed_at: '2026-11-15T00:00:00.000Z',
        },
      ],
    };
    const { transport, seen } = recordingTransport(body);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    expect(await client.getBalances({ variantId: 'v-1' })).toEqual(body);
    expect(seen[0]?.request.method).toBe('GET');
    expect(seen[0]?.request.path).toBe(
      'http://localhost:3000/v1/inventory/balances?variantId=v-1',
    );
    expect(seen[0]?.headers['Authorization']).toBe(`Bearer ${client.sessionToken}`);
    const { transport: transport2, seen: seen2 } = recordingTransport(body);
    const client2 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport2,
    });
    expect(await client2.getBalances({ warehouseId: 'w-1' })).toEqual(body);
    expect(seen2[0]?.request.path).toBe(
      'http://localhost:3000/v1/inventory/balances?warehouseId=w-1',
    );
    const { transport: transport3, seen: seen3 } = recordingTransport(body);
    const client3 = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport: transport3,
    });
    expect(await client3.getBalances()).toEqual(body);
    expect(seen3[0]?.request.path).toBe('http://localhost:3000/v1/inventory/balances');
  });

  it('getValuation GETs /v1/inventory/valuation and returns the per-variant rows + totals', async () => {
    const body = {
      valuation: [
        {
          variant_id: 'v-1',
          total_quantity_on_hand: '20',
          weighted_avg_cost_pence: '500',
          total_value_pence: '10000',
        },
      ],
      totals: { total_quantity_on_hand: '20', total_value_pence: '10000' },
    };
    const { transport, seen } = recordingTransport(body);
    const client = new RegisterApiClient({
      baseUrl: 'http://localhost:3000',
      sessionToken: 'sess_abc',
      transport,
    });
    expect(await client.getValuation({ variantId: 'v-1' })).toEqual(body);
    expect(seen[0]?.request.method).toBe('GET');
    expect(seen[0]?.request.path).toBe(
      'http://localhost:3000/v1/inventory/valuation?variantId=v-1',
    );
  });

  it('balances/valuation calls refuse to run before pinLogin (no session token)', async () => {
    const { transport, seen } = recordingTransport({ balances: [] });
    const client = new RegisterApiClient({ baseUrl: 'http://localhost:3000', transport });
    await expect(client.getBalances()).rejects.toThrow('call pinLogin first');
    await expect(client.getValuation()).rejects.toThrow('call pinLogin first');
    expect(seen).toHaveLength(0);
  });
});
