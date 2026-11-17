import { describe, expect, it } from 'vitest';
import { FakeAdminApiClient } from '../src/api/fake-client';
import { InventoryConsole, STOCK_BALANCE_STALE_MS, toInTransitRows, toStockBalanceRow } from '../src/inventory/console';
import { blankReceivingLine, buildReceivingForm, ReceivingFormController, validateReceivingLines } from '../src/inventory/receiving-form';

describe('goods-in receiving form — no blind receiving', () => {
  it('defaults ALL line received quantities to 0, with separate damaged/short inputs', () => {
    const form = buildReceivingForm([
      { variantId: 'v-1', quantityOrdered: '10', costPence: '100' },
      { variantId: 'v-2', quantityOrdered: '5', costPence: '200' },
    ]);
    expect(form).toHaveLength(2);
    for (const line of form) {
      expect(line.quantityReceived).toBe('0');
      expect(line.quantityDamaged).toBe('0');
      expect(line.quantityShort).toBe('0');
    }
    expect(blankReceivingLine('v-9', '3', '50').quantityReceived).toBe('0');
  });

  it('rejects received + damaged + short exceeding ordered', () => {
    const line = blankReceivingLine('v-1', '10', '100');
    line.quantityReceived = '8';
    line.quantityDamaged = '1';
    line.quantityShort = '2'; // 8+1+2 = 11 > 10
    expect(validateReceivingLines([line]).join(' ')).toContain('exceeds ordered 10');
    line.quantityShort = '1'; // 8+1+1 = 10, exactly ordered
    expect(validateReceivingLines([line])).toEqual([]);
  });

  it('rejects non-integer quantities', () => {
    const line = blankReceivingLine('v-1', '10', '100');
    line.quantityReceived = '1.5';
    expect(validateReceivingLines([line]).length).toBeGreaterThan(0);
  });

  it('submit sends the form to the API and books only the received quantity into stock', async () => {
    const fake = new FakeAdminApiClient({
      stock: [{ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '5', computedAt: new Date().toISOString() }],
    });
    const controller = new ReceivingFormController(fake);
    const form = buildReceivingForm([{ variantId: 'v-1', quantityOrdered: '10', costPence: '100' }]);
    form[0]!.quantityReceived = '8';
    form[0]!.quantityDamaged = '1';
    form[0]!.quantityShort = '1';
    const { receiptId } = await controller.submit({
      supplierId: 'sup-1',
      locationId: 'loc-1',
      warehouseId: 'w-1',
      lines: form,
    });
    expect(receiptId).toBeTruthy();
    expect(fake.callsFor('inventory.receiveGoodsIn')).toHaveLength(1);
    expect(fake.callsFor('inventory.receiveGoodsIn')[0]?.path).toBe('/v1/inventory/goods-in');
    // Only the 8 received units hit stock (5 + 8 = 13); damaged/short do not.
    expect(fake.stock.find((s) => s.variantId === 'v-1')?.quantityOnHand).toBe('13');
  });

  it('submit with no lines is rejected before any API call', async () => {
    const fake = new FakeAdminApiClient();
    const controller = new ReceivingFormController(fake);
    await expect(controller.submit({ supplierId: 's', locationId: 'l', warehouseId: 'w', lines: [] })).rejects.toThrow('no lines');
    expect(fake.callsFor('inventory.receiveGoodsIn')).toHaveLength(0);
  });
});

describe('inventory console — reorder suggestions, transfers, stock', () => {
  it('accepting a suggestion creates a DRAFT purchase order (never sent)', async () => {
    const fake = new FakeAdminApiClient({
      reorderSuggestions: [{ id: 'sug-1', location_id: 'loc-1', variant_id: 'v-1', supplier_id: 'sup-1', suggested_quantity: '24', expected_date: null, status: 'pending' }],
    });
    const console_ = new InventoryConsole(fake);
    const po = await console_.acceptSuggestion('sug-1');
    expect(po.status).toBe('draft');
    expect(po.lines[0]?.quantity_ordered).toBe('24');
    expect(po.sent_at).toBeNull();
    expect(fake.reorderSuggestions[0]?.status).toBe('approved');
    expect(fake.callsFor('inventory.acceptReorderSuggestion')[0]?.path).toBe('/v1/inventory/reorder-suggestions/sug-1/accept');
  });

  it('accepting a non-pending suggestion is rejected', async () => {
    const fake = new FakeAdminApiClient({
      reorderSuggestions: [{ id: 'sug-1', location_id: 'loc-1', variant_id: 'v-1', supplier_id: null, suggested_quantity: '24', expected_date: null, status: 'dismissed' }],
    });
    const console_ = new InventoryConsole(fake);
    await expect(console_.acceptSuggestion('sug-1')).rejects.toThrow('not pending');
  });

  it('dismissing a suggestion requires a reason, and records it', async () => {
    const fake = new FakeAdminApiClient({
      reorderSuggestions: [{ id: 'sug-1', location_id: 'loc-1', variant_id: 'v-1', supplier_id: null, suggested_quantity: '24', expected_date: null, status: 'pending' }],
    });
    const console_ = new InventoryConsole(fake);
    await expect(console_.dismissSuggestion('sug-1', '   ')).rejects.toThrow('reason is required');
    expect(fake.callsFor('inventory.dismissReorderSuggestion')).toHaveLength(0);
    const dismissed = await console_.dismissSuggestion('sug-1', 'Supplier discontinued the line');
    expect(dismissed.status).toBe('dismissed');
    expect(fake.callsFor('inventory.dismissReorderSuggestion')[0]?.body).toMatchObject({ reason: 'Supplier discontinued the line' });
  });

  it('in-transit transfers show outstanding (unreceived) quantities per variant', () => {
    const rows = toInTransitRows([
      { id: 't-1', from_warehouse_id: 'w-1', to_warehouse_id: 'w-2', status: 'in_transit', received_at: null, lines: [{ variant_id: 'v-1', quantity: '10', received_quantity: '4' }] },
      { id: 't-2', from_warehouse_id: 'w-1', to_warehouse_id: 'w-2', status: 'received', received_at: '2026-11-13', lines: [{ variant_id: 'v-1', quantity: '5', received_quantity: '5' }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unreceivedByVariant[0]?.outstanding).toBe('6');
  });

  it('a transfer to the same warehouse is rejected client-side', async () => {
    const fake = new FakeAdminApiClient();
    const console_ = new InventoryConsole(fake);
    await expect(console_.createTransfer({ fromWarehouseId: 'w-1', toWarehouseId: 'w-1', lines: [{ variantId: 'v-1', quantity: '2' }] })).rejects.toThrow('must differ');
    expect(fake.callsFor('inventory.createTransfer')).toHaveLength(0);
  });

  it('stock balances flag a computed_at older than the staleness threshold', () => {
    const now = new Date('2026-11-13T12:00:00.000Z');
    const fresh = toStockBalanceRow({ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '3', computedAt: '2026-11-13T11:55:00.000Z' }, now);
    expect(fresh.stale).toBe(false);
    const stale = toStockBalanceRow({ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '3', computedAt: '2026-11-13T11:00:00.000Z' }, now);
    expect(stale.stale).toBe(true);
    expect(stale.ageMs).toBe(3600 * 1000);
    expect(STOCK_BALANCE_STALE_MS).toBe(15 * 60 * 1000);
    const noTimestamp = toStockBalanceRow({ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '3' }, now);
    expect(noTimestamp.stale).toBe(false);
    expect(noTimestamp.ageMs).toBeNull();
  });

  it('stock counts round-trip through the live count routes', async () => {
    const fake = new FakeAdminApiClient({
      stock: [{ variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '10', computedAt: new Date().toISOString() }],
    });
    const console_ = new InventoryConsole(fake);
    const count = await console_.startCount('loc-1', 'w-1');
    const line = await console_.setCountedQuantity(count.id, 'v-1', '9', 'w-1');
    expect(line.expectedQuantity).toBe('10');
    expect(line.countedQuantity).toBe('9');
    await console_.submitCount(count.id);
    expect(fake.callsFor('inventory.startCount')[0]?.path).toBe('/v1/inventory/counts');
    expect(fake.callsFor('inventory.setCountedQuantity')[0]?.path).toBe(`/v1/inventory/counts/${count.id}/lines`);
    expect(fake.callsFor('inventory.submitCount')[0]?.path).toBe(`/v1/inventory/counts/${count.id}/submit`);
  });
});

describe('inventory console — warehouses + suppliers (Build-10 Objective 2)', () => {
  /**
   * The console delegates to the typed client, whose new methods
   * resolve through the route table — the entries land with Obj 4,
   * so a FakeAdminApiClient call would throw 'Unknown route key'
   * here. These tests drive the console through a minimal stub
   * client instead (no routeFor involved), proving the console's own
   * validation + delegation; the fake/live wire tests land with Obj 4
   * alongside the route-table entries.
   */
  function stubClient(calls: Array<{ method: string; args: unknown[] }>): {
    createWarehouse: (input: unknown) => Promise<unknown>;
    getWarehouse: (id: string) => Promise<unknown>;
    createSupplier: (input: unknown) => Promise<unknown>;
    listSuppliers: () => Promise<unknown>;
    getSupplier: (id: string) => Promise<unknown>;
    linkSupplierVariant: (id: string, input: unknown) => Promise<unknown>;
  } {
    return {
      createWarehouse: async (input: unknown) => {
        calls.push({ method: 'createWarehouse', args: [input] });
        return { id: 'w-new', location_id: 'loc-1', name: 'New Store', type: 'store', is_default: false };
      },
      getWarehouse: async (id: string) => {
        calls.push({ method: 'getWarehouse', args: [id] });
        return { id, location_id: 'loc-1', name: 'Store', type: 'store', is_default: true };
      },
      createSupplier: async (input: unknown) => {
        calls.push({ method: 'createSupplier', args: [input] });
        return { id: 's-new', name: 'Acme', contact_name: null, email: null, phone: null, lead_time_days: null, minimum_order_value_pence: null, currency: 'GBP' };
      },
      listSuppliers: async () => {
        calls.push({ method: 'listSuppliers', args: [] });
        return [{ id: 's-1', name: 'Acme', contact_name: null, email: null, phone: null, lead_time_days: 2, minimum_order_value_pence: '2500', currency: 'GBP' }];
      },
      getSupplier: async (id: string) => {
        calls.push({ method: 'getSupplier', args: [id] });
        return { id, name: 'Acme', contact_name: null, email: null, phone: null, lead_time_days: null, minimum_order_value_pence: null, currency: 'GBP' };
      },
      linkSupplierVariant: async (id: string, input: unknown) => {
        calls.push({ method: 'linkSupplierVariant', args: [id, input] });
        return { supplier_id: id, variant_id: 'v-1', supplier_sku: 'A-1', cost_pence: '350', currency: 'GBP', is_preferred: true };
      },
    };
  }

  it('createWarehouse delegates with the input; a blank name and a bad type are rejected before any API call', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const console_ = new InventoryConsole(stubClient(calls) as never);
    const created = await console_.createWarehouse({ locationId: 'loc-1', name: 'New Store', type: 'store' });
    expect(created.id).toBe('w-new');
    expect(calls).toHaveLength(1);
    await expect(console_.createWarehouse({ locationId: 'loc-1', name: '   ' })).rejects.toThrow('Warehouse name is required.');
    await expect(
      console_.createWarehouse({ locationId: 'loc-1', name: 'Bad', type: 'shed' as never }),
    ).rejects.toThrow("Warehouse type must be 'store' or 'warehouse'.");
    expect(calls).toHaveLength(1);
  });

  it('createSupplier delegates; a blank name is rejected before any API call', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const console_ = new InventoryConsole(stubClient(calls) as never);
    const created = await console_.createSupplier({ name: 'Acme', currency: 'GBP', leadTimeDays: 2 });
    expect(created.id).toBe('s-new');
    expect(calls).toHaveLength(1);
    await expect(console_.createSupplier({ name: '  ' })).rejects.toThrow('Supplier name is required.');
    expect(calls).toHaveLength(1);
  });

  it('list/get suppliers and linkSupplierVariant delegate; a negative cost is rejected before any API call', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const console_ = new InventoryConsole(stubClient(calls) as never);
    const suppliers = await console_.listSuppliers();
    expect(suppliers).toHaveLength(1);
    expect((await console_.getSupplier('s-1')).name).toBe('Acme');
    const link = await console_.linkSupplierVariant('s-1', { variantId: 'v-1', supplierSku: 'A-1', costPence: '350', isPreferred: true });
    expect(link.is_preferred).toBe(true);
    await expect(
      console_.linkSupplierVariant('s-1', { variantId: 'v-1', costPence: '-5' }),
    ).rejects.toThrow('Cost must be a non-negative integer.');
    expect(calls.map((c) => c.method)).toEqual(['listSuppliers', 'getSupplier', 'linkSupplierVariant']);
  });
});

describe('inventory — balances + valuation (Build-11 Objective 1)', () => {
  it('getBalances returns the weighted-average cost and total value, with filters', async () => {
    const fake = new FakeAdminApiClient({
      stock: [
        { variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '20', computedAt: '2026-11-15T00:00:00.000Z', weightedAvgCostPence: '500', totalValuePence: '10000' },
        { variantId: 'v-1', warehouseId: 'w-2', quantityOnHand: '3', computedAt: '2026-11-15T00:00:00.000Z', weightedAvgCostPence: null, totalValuePence: null },
      ],
    });
    const balances = await fake.getBalances();
    expect(balances).toHaveLength(2);
    expect(balances[0]?.weightedAvgCostPence).toBe('500');
    expect(balances[0]?.totalValuePence).toBe('10000');
    expect(balances[1]?.weightedAvgCostPence).toBeNull();
    expect(balances[1]?.totalValuePence).toBeNull();
    expect(await fake.getBalances({ warehouseId: 'w-2' })).toHaveLength(1);
    expect(await fake.getBalances({ variantId: 'v-9' })).toHaveLength(0);
  });

  it('receiveGoodsIn maintains the weighted average (10 @ 400, then 10 @ 600 → avg 500, value 10000)', async () => {
    const fake = new FakeAdminApiClient({ stock: [] });
    const input = {
      poId: null,
      supplierId: 's-1',
      locationId: 'loc-1',
      warehouseId: 'w-1',
      lines: [{ variantId: 'v-1', quantityReceived: '10', quantityDamaged: '0', quantityShort: '0', costPence: '400' }],
    };
    await fake.receiveGoodsIn(input);
    expect(fake.stock[0]?.weightedAvgCostPence).toBe('400');
    expect(fake.stock[0]?.totalValuePence).toBe('4000');
    await fake.receiveGoodsIn({ ...input, lines: [{ variantId: 'v-1', quantityReceived: '10', quantityDamaged: '0', quantityShort: '0', costPence: '600' }] });
    expect(fake.stock[0]?.quantityOnHand).toBe('20');
    expect(fake.stock[0]?.weightedAvgCostPence).toBe('500');
    expect(fake.stock[0]?.totalValuePence).toBe('10000');
  });

  it('getValuation rolls variants up across warehouses; the average rounds half up; unvalued rows give nulls', async () => {
    const fake = new FakeAdminApiClient({
      stock: [
        { variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '1', computedAt: '2026-11-15T00:00:00.000Z', weightedAvgCostPence: '100', totalValuePence: '100' },
        { variantId: 'v-1', warehouseId: 'w-2', quantityOnHand: '1', computedAt: '2026-11-15T00:00:00.000Z', weightedAvgCostPence: '101', totalValuePence: '101' },
        { variantId: 'v-2', warehouseId: 'w-1', quantityOnHand: '5', computedAt: '2026-11-15T00:00:00.000Z', weightedAvgCostPence: null, totalValuePence: null },
      ],
    });
    const summary = await fake.getValuation();
    expect(summary.valuation).toHaveLength(2);
    expect(summary.valuation[0]?.variantId).toBe('v-1');
    expect(summary.valuation[0]?.totalQuantityOnHand).toBe('2');
    expect(summary.valuation[0]?.totalValuePence).toBe('201');
    // 201 / 2 = 100.5 → rounds half up to 101.
    expect(summary.valuation[0]?.weightedAvgCostPence).toBe('101');
    expect(summary.valuation[1]?.variantId).toBe('v-2');
    expect(summary.valuation[1]?.totalQuantityOnHand).toBe('5');
    expect(summary.valuation[1]?.weightedAvgCostPence).toBeNull();
    expect(summary.valuation[1]?.totalValuePence).toBeNull();
    expect(summary.totals.totalQuantityOnHand).toBe('7');
    expect(summary.totals.totalValuePence).toBe('201');
    expect((await fake.getValuation({ variantId: 'v-9' })).valuation).toHaveLength(0);
    const empty = await new FakeAdminApiClient({ stock: [] }).getValuation();
    expect(empty.valuation).toHaveLength(0);
    expect(empty.totals.totalQuantityOnHand).toBe('0');
    expect(empty.totals.totalValuePence).toBeNull();
  });

  it('stockBalances reads through getBalances and carries the cost fields to the view rows', async () => {
    const fake = new FakeAdminApiClient({
      stock: [
        { variantId: 'v-1', warehouseId: 'w-1', quantityOnHand: '42', computedAt: new Date().toISOString(), weightedAvgCostPence: '500', totalValuePence: '21000' },
      ],
    });
    const console_ = new InventoryConsole(fake);
    const rows = await console_.stockBalances();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weightedAvgCostPence).toBe('500');
    expect(rows[0]?.totalValuePence).toBe('21000');
    // The console no longer reads through getStock at all.
    expect(fake.callsFor('inventory.getStock')).toHaveLength(0);
  });
});

describe('inventory console — createPurchaseOrder (Build-12 Objective 3)', () => {
  function seededConsole() {
    const fake = new FakeAdminApiClient({
      suppliers: [
        { id: 'sup-1', name: 'Demo Wholesale', contact_name: null, email: null, phone: null, lead_time_days: 2, minimum_order_value_pence: '2500', currency: 'GBP' },
      ],
      warehouses: [
        { id: 'wh-1', location_id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', is_default: true },
      ],
      variants: [
        { id: 'v-1', product_id: 'p', sku: 'SKU-1', barcode: null, name: 'Tea', price_pence: '250', cost_pence: '100', tax_rate_id: null, is_bundle: false, is_active: true },
        { id: 'v-2', product_id: 'p', sku: 'SKU-2', barcode: null, name: 'Coffee', price_pence: '400', cost_pence: '150', tax_rate_id: null, is_bundle: false, is_active: true },
      ],
    });
    return { fake, console_: new InventoryConsole(fake) };
  }

  it('creates a draft PO with the warehouse, expected date and lines, numbered sequentially', async () => {
    const { console_ } = seededConsole();
    const po = await console_.createPurchaseOrder({
      supplierId: 'sup-1',
      warehouseId: 'wh-1',
      expectedDeliveryDate: '2026-12-01T00:00:00.000Z',
      lines: [
        { variantId: 'v-1', quantityOrdered: '10', unitCostPence: '400' },
        { variantId: 'v-2', quantityOrdered: '5', unitCostPence: '600' },
      ],
    });
    expect(po.status).toBe('draft');
    expect(po.po_number).toBe('1');
    expect(po.location_id).toBe('loc-1');
    expect(po.warehouse_id).toBe('wh-1');
    expect(po.expected_delivery_date).toBe('2026-12-01T00:00:00.000Z');
    expect(po.sent_at).toBeNull();
    expect(po.lines).toHaveLength(2);
    expect(po.lines[0]?.quantity_received).toBe('0');
    const second = await console_.createPurchaseOrder({
      supplierId: 'sup-1',
      warehouseId: 'wh-1',
      lines: [{ variantId: 'v-1', quantityOrdered: '1', unitCostPence: '400' }],
    });
    expect(second.po_number).toBe('2');
    expect(second.expected_delivery_date).toBeNull();
  });

  it('client-side validation rejects empty lines, duplicate variants, zero quantity and a bad date', async () => {
    const { fake, console_ } = seededConsole();
    const base = {
      supplierId: 'sup-1',
      warehouseId: 'wh-1',
      lines: [{ variantId: 'v-1', quantityOrdered: '10', unitCostPence: '400' }],
    };
    await expect(console_.createPurchaseOrder({ ...base, lines: [] })).rejects.toThrow('at least one line');
    await expect(
      console_.createPurchaseOrder({
        ...base,
        lines: [
          { variantId: 'v-1', quantityOrdered: '10', unitCostPence: '400' },
          { variantId: 'v-1', quantityOrdered: '5', unitCostPence: '400' },
        ],
      }),
    ).rejects.toThrow('duplicate variant');
    await expect(
      console_.createPurchaseOrder({ ...base, lines: [{ variantId: 'v-1', quantityOrdered: '0', unitCostPence: '400' }] }),
    ).rejects.toThrow('positive integer');
    await expect(console_.createPurchaseOrder({ ...base, expectedDeliveryDate: 'not-a-date' })).rejects.toThrow(
      'valid date',
    );
    expect(fake.purchaseOrders).toHaveLength(0);
  });

  it('an unknown supplier, warehouse or variant throws 404', async () => {
    const { console_ } = seededConsole();
    const base = {
      supplierId: 'sup-1',
      warehouseId: 'wh-1',
      lines: [{ variantId: 'v-1', quantityOrdered: '10', unitCostPence: '400' }],
    };
    await expect(console_.createPurchaseOrder({ ...base, supplierId: 'no-such-supplier' })).rejects.toThrow(
      'Resource not found',
    );
    await expect(console_.createPurchaseOrder({ ...base, warehouseId: 'no-such-warehouse' })).rejects.toThrow(
      'Resource not found',
    );
    await expect(
      console_.createPurchaseOrder({ ...base, lines: [{ variantId: 'no-such-variant', quantityOrdered: '1', unitCostPence: '1' }] }),
    ).rejects.toThrow('Resource not found');
  });
});
