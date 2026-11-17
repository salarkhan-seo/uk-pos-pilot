/**
 * Demo seed for the Admin Web Dashboard Shell (Build-05 Objective 4, Worker D).
 *
 * The shell boots by default against this seeded in-memory fake client so
 * the dashboard renders without a live API server. EVERYTHING here is
 * clearly-labelled demo data: the shell renders it under a
 * "DEMO DATA — no live backend connected" badge, and no demo row may be
 * mistaken for live state.
 *
 * - Voucher / gift-card rows carry ONLY code_last4 (D-AW-06); no full
 *   code exists anywhere in the seed.
 * - Audit events are built with the shared kernel's createHashChain, so
 *   the audit hash-chain verifier reports a genuinely verified chain.
 * - The exit seed deliberately carries D-11 blockers (one open session,
 *   one pending/unknown payment) so the exit portal demonstrates the
 *   blocked state.
 */
import { createHashChain } from '@uk-pos/shared-kernel';
import { FakeAdminApiClient } from '../api/fake-client';
import type { AuditEventView } from '../api/types';
import { createAdminDashboardShell, type AdminDashboardShell } from './shell';

export const DEMO_Z_REPORT_ID = 'z-demo-1';
export const DEMO_VAT_PERIOD_ID = 'vat-demo-1';
export const DEMO_CUSTOMER_ID = 'cust-demo-1';

function demoAuditEvents(): AuditEventView[] {
  const payloads = [
    { event: 'variant_created', entity: 'variant-demo-1', sku: 'SKU-001' },
    { event: 'goods_in_received', entity: 'receipt-demo-1', variant: 'variant-demo-1', qty: '8' },
    { event: 'z_report_issued', entity: 'z-demo-1', z_number: '42' },
  ];
  const chained = createHashChain(payloads);
  // The API lists audit events newest-first (see IntegrityController,
  // which reverses into creation order before verifying), so the seed
  // mirrors that order: newest first.
  const events = chained.map((link, i) => ({
    id: `audit-demo-${i + 1}`,
    tenant_id: 'tenant-demo-1',
    user_id: 'user-demo-1',
    event_type: (link.payload as { event: string }).event,
    entity_type: 'demo',
    entity_id: (link.payload as { entity: string }).entity,
    payload: link.payload as Record<string, unknown>,
    prev_hash: link.prevHash,
    event_hash: link.eventHash,
    created_at: `2026-11-13T0${i + 8}:00:00.000Z`,
  }));
  return events.reverse();
}

/** Seeded fake client with labelled demo data. */
export function createDemoClient(): FakeAdminApiClient {
  return new FakeAdminApiClient({
    variants: [
      { id: 'variant-demo-1', product_id: 'prod-demo-1', sku: 'SKU-001', barcode: '5012345678900', name: 'Demo Tea Towel', price_pence: '1299', cost_pence: '500', tax_rate_id: null, is_bundle: false, is_active: true },
      { id: 'variant-demo-2', product_id: 'prod-demo-1', sku: 'SKU-002', barcode: null, name: 'Demo Mug', price_pence: '899', cost_pence: '300', tax_rate_id: null, is_bundle: false, is_active: true },
    ],
    priceBooks: [
      { id: 'pb-demo-1', name: 'Demo Winter Sale', priority: 10, effective_from: '2026-11-01', effective_to: '2026-12-31', status: 'active' },
    ],
    promotions: [
      { id: 'promo-demo-1', name: 'Demo 10% Off', type: 'percentage', status: 'active', version: 1, stack_group: null, start_at: '2026-11-01T00:00:00.000Z', end_at: null },
    ],
    vouchers: [
      { id: 'voucher-demo-1', code_last4: '4821', promotion_id: 'promo-demo-1', status: 'active', max_uses: 1, uses_count: 0, valid_from: '2026-11-01T00:00:00.000Z', valid_to: null },
      { id: 'voucher-demo-2', code_last4: '7734', promotion_id: 'promo-demo-1', status: 'redeemed', max_uses: 1, uses_count: 1, valid_from: '2026-11-01T00:00:00.000Z', valid_to: null },
    ],
    warehouses: [
      { id: 'wh-demo-1', location_id: 'loc-demo-1', name: 'Demo Main Warehouse', type: 'warehouse', is_default: true },
      { id: 'wh-demo-2', location_id: 'loc-demo-1', name: 'Demo Shop Floor', type: 'store', is_default: false },
    ],
    suppliers: [
      { id: 'sup-demo-1', name: 'Demo Wholesale', contact_name: null, email: null, phone: null, lead_time_days: 2, minimum_order_value_pence: '2500', currency: 'GBP' },
    ],
    stock: [
      { variantId: 'variant-demo-1', warehouseId: 'wh-demo-1', quantityOnHand: '42', computedAt: new Date().toISOString(), weightedAvgCostPence: '500', totalValuePence: '21000' },
      { variantId: 'variant-demo-2', warehouseId: 'wh-demo-1', quantityOnHand: '17', computedAt: new Date().toISOString(), weightedAvgCostPence: '350', totalValuePence: '5950' },
    ],
    transfers: [
      { id: 'transfer-demo-1', from_warehouse_id: 'wh-demo-1', to_warehouse_id: 'wh-demo-2', status: 'in_transit', received_at: null, lines: [{ variant_id: 'variant-demo-1', quantity: '10', received_quantity: '4' }] },
    ],
    reorderSuggestions: [
      { id: 'sug-demo-1', location_id: 'loc-demo-1', variant_id: 'variant-demo-2', supplier_id: 'sup-demo-1', suggested_quantity: '24', expected_date: null, status: 'pending' },
    ],
    purchaseOrders: [
      {
        id: 'po-demo-1',
        location_id: 'loc-demo-1',
        supplier_id: 'sup-demo-1',
        po_number: 'PO-1001',
        status: 'sent',
        sent_at: '2026-11-12T09:00:00.000Z',
        // A sent PO, delivered to the main warehouse (Build-12
        // Objective 3, migration 019).
        warehouse_id: 'wh-demo-1',
        expected_delivery_date: null,
        lines: [
          { variant_id: 'variant-demo-1', quantity_ordered: '10', quantity_received: '0', cost_pence: '500' },
          { variant_id: 'variant-demo-2', quantity_ordered: '5', quantity_received: '0', cost_pence: '300' },
        ],
      },
    ],
    customers: [
      { id: DEMO_CUSTOMER_ID, first_name: 'Demo', last_name: 'Customer', email: 'demo@example.co.uk', phone: '07123456789' },
    ],
    // One demo group (Build-12 Objective 3) so the CRM console's
    // assign-to-group form works end to end in demo mode. There is
    // no create-group route in this dashboard; groups are created
    // server-side.
    customerGroups: [
      { id: 'group-demo-1', name: 'VIP Customers', description: 'Demo group for regulars' },
    ],
    consents: [
      { id: 'consent-demo-1', customer_id: DEMO_CUSTOMER_ID, purpose: 'marketing', channel: 'email', consented: true, recorded_at: '2026-11-01T10:00:00.000Z', recorded_by_user_id: null },
    ],
    loyaltyLedger: [
      { id: 'loy-demo-1', customer_id: DEMO_CUSTOMER_ID, membership_id: 'mem-demo-1', kind: 'earn', points: '250', order_id: 'order-demo-1', reason: null, created_at: '2026-11-10T12:00:00.000Z' },
    ],
    giftCards: [
      { id: 'gc-demo-1', code_last4: '9901', initial_amount_pence: '5000', balance_pence: '3200', status: 'active', expires_at: null },
    ],
    zReports: [
      { id: DEMO_Z_REPORT_ID, z_number: '42', business_date: '2026-11-13', register_id: 'reg-demo-1', gross_pence: '12500', net_pence: '10417', vat_pence: '2083', cash_variance_pence: '0' },
    ],
    vatPeriods: [
      { id: DEMO_VAT_PERIOD_ID, period_start: '2026-10-01', period_end: '2026-12-31', status: 'open' },
    ],
    webhookEndpoints: [
      { id: 'wh-ep-demo-1', url: 'https://example.co.uk/webhooks/pos', event_types: ['order.completed'], status: 'active' },
    ],
    statutoryArchives: [
      {
        id: 'arch-demo-1',
        tenant_id: 'tenant-demo-1',
        archived_at: '2026-11-13T10:00:00.000Z',
        retention_until: '2032-11-13T10:00:00.000Z',
        archive_sha256: 'demo-sha256-archive-000000000000000000000000000000000000000000000000',
        row_counts: { vat_periods: 1, z_reports: 1, orders: 3, order_lines: 5, order_tenders: 3, payment_attempts: 3, refunds: 0 },
        storage_bundle_path: 'data/statutory-archives/tenant-demo-1/arch-demo-1-statutory-archive.json',
        payload_verified: true,
        file_verified: true,
        verified: true,
      },
    ],
    events: {
      events: [
        {
          id: 'evt-demo-1',
          tenant_id: 'tenant-demo-1',
          event_type: 'order.completed',
          sequence: '7',
          payload: { order_id: 'order-demo-1' },
          created_at: '2026-11-13T09:00:00.000Z',
          deliveries: [
            { id: 'dlq-demo-1', event_id: 'evt-demo-1', endpoint_id: 'wh-ep-demo-1', status: 'dead_letter', attempts: 11, next_attempt_at: null, last_error: 'Endpoint returned 500', created_at: '2026-11-12T09:00:00.000Z' },
          ],
        },
      ],
      nextCursor: null,
    },
    auditEvents: demoAuditEvents(),
    exitStatus: {
      tenantId: 'tenant-demo-1',
      status: 'active',
      exportWindowEndsAt: null,
      // Deliberate D-11 blockers so the portal demonstrates the blocked state.
      openSessionIds: ['session-demo-open-1'],
      blockingPaymentAttemptIds: ['pay-attempt-demo-unknown-1'],
    },
  });
}

/** Demo shell: seeded fake client + VAT-period read resolver over the fake's seed (G-UI-02). */
export function createDemoShell(): { shell: AdminDashboardShell; client: FakeAdminApiClient } {
  const client = createDemoClient();
  const shell = createAdminDashboardShell(client, {
    dataSource: 'demo',
    tenantId: 'tenant-demo-1',
    defaultZReportId: DEMO_Z_REPORT_ID,
    defaultVatPeriodId: DEMO_VAT_PERIOD_ID,
    getVatPeriod: async (vatPeriodId) => client.vatPeriods.find((p) => p.id === vatPeriodId) ?? null,
  });
  return { shell, client };
}
