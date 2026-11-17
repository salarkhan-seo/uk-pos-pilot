/**
 * Route table — the single source of truth for which dashboard actions
 * have a live HTTP route in apps/api and which do not.
 *
 * VERIFIED against the Build-03 controllers (13 Nov 2026), then made
 * fully live by Build-04 integration (13 Nov 2026): all 69 routes are
 * LIVE. Build-05 added 5 more (price-book entries POST/PUT,
 * promotion-scoped bulk vouchers, webhook secret rotation, statutory
 * archives read), so all 74 routes in this table are LIVE.
 * ReportingService (sessions, Z-reports, VAT periods, CSV export,
 * settlement), ExitService / ExportService / GdprService (termination,
 * full export, per-customer export/erasure, hard delete), WebhookService
 * admin actions, and the Phase-2 services (price books, promotions,
 * vouchers, warehouses, transfers, reorder suggestions, purchase
 * orders, customers, consents, loyalty, gift cards, store credit) —
 * were wired by Worker 4 of Build-04 (thin controllers over the
 * existing services, plus minimal tenant-scoped services where none
 * existed). Build-05 wired the last routes: price-book entries
 * (POST upsert / PUT update-only), promotion-scoped bulk vouchers,
 * webhook secret rotation, and the statutory-archives compliance
 * read — so every route the API serves is in this table. Build-06
 * added sessions, VAT-period read and webhook re-provisioning; Build-07
 * added webhook re-encryption; Build-08 added the tax-rates list and
 * single-rate read — 83 entries in this table, 86 API routes
 * (83 + 3 sync routes). Build-09 added product create/list/get,
 * age-restriction create/list, and the sales age-verifications read —
 * 89 entries in this table, 92 API routes (89 + 3 sync routes).
 *
 * The live client refuses to guess a URL for a not-exposed route: it
 * throws NotExposedError naming the service method and the proposed
 * route. The fake client implements surfaces in memory so every
 * console is fully testable; swapping a method to live is a one-line
 * change in this table plus the client method.
 */
import type { ApiScope } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDescriptor {
  /** Stable key used by the client, fake and tests. */
  key: string;
  method: HttpMethod;
  /** Path template; `:id` segments are filled by the caller. */
  path: string;
  /** Scope the AuthGuard requires on the guarded routes; null = demo-header / unguarded route. */
  scope: ApiScope | null;
  live: boolean;
  /** Service method that implements this when there is no HTTP route. */
  serviceMethod?: string;
  /** Human note for the coordinator when wiring the route. */
  note?: string;
}

export const ROUTES: readonly RouteDescriptor[] = [
  // --- status (live, unguarded) ---
  { key: 'admin.status', method: 'GET', path: '/admin/status', scope: null, live: true },
  { key: 'catalogue.status', method: 'GET', path: '/catalogue/status', scope: null, live: true },
  { key: 'inventory.status', method: 'GET', path: '/inventory/status', scope: null, live: true },
  { key: 'sales.status', method: 'GET', path: '/sales/status', scope: null, live: true },
  { key: 'payments.status', method: 'GET', path: '/payments/status', scope: null, live: true },
  { key: 'reporting.status', method: 'GET', path: '/reporting/status', scope: null, live: true },
  { key: 'integrations.status', method: 'GET', path: '/integrations/status', scope: null, live: true },

  // --- admin: audit + approvals (live, demo-header auth) ---
  { key: 'audit.list', method: 'GET', path: '/v1/audit-events', scope: null, live: true, note: 'Demo-header auth (Build-02); AuthGuard not applied.' },
  { key: 'approvals.create', method: 'POST', path: '/v1/approvals', scope: null, live: true, note: 'Demo-header auth (Build-02).' },

  // --- api keys (live, AuthGuard + admin scope) ---
  { key: 'apiKeys.create', method: 'POST', path: '/v1/api-keys', scope: 'admin', live: true },
  { key: 'apiKeys.list', method: 'GET', path: '/v1/api-keys', scope: 'admin', live: true },
  { key: 'apiKeys.rotate', method: 'POST', path: '/v1/api-keys/:id/rotate', scope: 'admin', live: true },
  { key: 'apiKeys.revoke', method: 'POST', path: '/v1/api-keys/:id/revoke', scope: 'admin', live: true },

  // --- catalogue (live, demo-header auth; variant-create is TenantWriteGuarded) ---
  { key: 'catalogue.createVariant', method: 'POST', path: '/v1/catalogue/variants', scope: 'catalogue:write', live: true },
  { key: 'catalogue.listVariants', method: 'GET', path: '/v1/catalogue/variants', scope: 'catalogue:read', live: true },
  { key: 'catalogue.updateVariant', method: 'PATCH', path: '/v1/catalogue/variants/:id', scope: 'catalogue:write', live: true, serviceMethod: 'CatalogueService.updateVariant', note: 'Live since Build-12 (CatalogueController). AuthGuard + TenantWriteGuard + catalogue:write; updates sku, barcode, pricePence, costPence, taxRateId or status (status maps to is_active); stamps updated_at so /v1/sync/handshake picks up the delta. :id is named `id` so the global UuidValidationInterceptor answers 400 INVALID_UUID for malformed ids; cross-tenant 404 (G-B).' },
  { key: 'catalogue.listTaxRates', method: 'GET', path: '/v1/tax-rates', scope: 'catalogue:read', live: true, serviceMethod: 'CatalogueService.listTaxRates', note: 'Live since Build-08 (CatalogueController). Tenant tax rates (id, name, rate_bps, is_exempt, is_default_no_tax); AuthGuard + catalogue:read, cross-tenant 404 (G-B).' },
  { key: 'catalogue.getTaxRate', method: 'GET', path: '/v1/tax-rates/:id', scope: 'catalogue:read', live: true, serviceMethod: 'CatalogueService.getTaxRate', note: 'Live since Build-08 (CatalogueController). :id is named `id` so the global UuidValidationInterceptor answers 400 INVALID_UUID for malformed ids.' },
  { key: 'catalogue.createProduct', method: 'POST', path: '/v1/catalogue/products', scope: 'catalogue:write', live: true, serviceMethod: 'CatalogueService.createProduct', note: 'Live since Build-09 (CatalogueController). AuthGuard + TenantWriteGuard + catalogue:write; accepts an optional ageRestriction on creation.' },
  { key: 'catalogue.listProducts', method: 'GET', path: '/v1/catalogue/products', scope: 'catalogue:read', live: true, serviceMethod: 'CatalogueService.listProducts', note: 'Live since Build-09 (CatalogueController). AuthGuard + catalogue:read; optional categoryId query.' },
  { key: 'catalogue.getProduct', method: 'GET', path: '/v1/catalogue/products/:id', scope: 'catalogue:read', live: true, serviceMethod: 'CatalogueService.getProduct', note: 'Live since Build-09 (CatalogueController). AuthGuard + catalogue:read; :id is named `id` so the global UuidValidationInterceptor answers 400 INVALID_UUID for malformed ids; cross-tenant 404 (G-B).' },
  { key: 'catalogue.createAgeRestriction', method: 'POST', path: '/v1/catalogue/age-restrictions', scope: 'catalogue:write', live: true, serviceMethod: 'CatalogueService.createAgeRestriction', note: 'Live since Build-09 (CatalogueController). AuthGuard + TenantWriteGuard + catalogue:write. Returns an array: one row for a variant target, one row per current variant for a product target (snapshot expansion — a variant added later does NOT inherit the rule). Exactly one of productId/variantId must be present (400 otherwise); target must exist and belong to the tenant (404 otherwise).' },
  { key: 'catalogue.listAgeRestrictions', method: 'GET', path: '/v1/catalogue/age-restrictions', scope: 'catalogue:read', live: true, serviceMethod: 'CatalogueService.listAgeRestrictions', note: 'Live since Build-09 (CatalogueController). AuthGuard + catalogue:read; optional variantId / productId query.' },
  { key: 'catalogue.deleteAgeRestriction', method: 'DELETE', path: '/v1/catalogue/age-restrictions/:id', scope: 'catalogue:write', live: true, serviceMethod: 'CatalogueService.deleteAgeRestriction', note: 'Live since Build-12 (CatalogueController). AuthGuard + TenantWriteGuard + catalogue:write; a product-level delete removes the product row AND the propagated inherited variant rows, never an explicit override; a variant-level delete removes only that row. :id is named `id` so the global UuidValidationInterceptor answers 400 INVALID_UUID for malformed ids; cross-tenant 404 (G-B).' },
  { key: 'catalogue.priceBasket', method: 'POST', path: '/v1/catalogue/price-basket', scope: 'catalogue:read', live: true },
  { key: 'catalogue.parseBarcode', method: 'POST', path: '/v1/catalogue/barcode/parse', scope: 'catalogue:read', live: true },

  // --- inventory (live, demo-header auth) ---
  { key: 'inventory.startCount', method: 'POST', path: '/v1/inventory/counts', scope: 'stock:write', live: true },
  { key: 'inventory.setCountedQuantity', method: 'POST', path: '/v1/inventory/counts/:id/lines', scope: 'stock:write', live: true },
  { key: 'inventory.submitCount', method: 'POST', path: '/v1/inventory/counts/:id/submit', scope: 'stock:write', live: true },
  { key: 'inventory.receiveGoodsIn', method: 'POST', path: '/v1/inventory/goods-in', scope: 'stock:write', live: true },
  { key: 'inventory.getStock', method: 'GET', path: '/v1/inventory/stock', scope: 'stock:read', live: true },
  { key: 'inventory.getBalances', method: 'GET', path: '/v1/inventory/balances', scope: 'stock:read', live: true, serviceMethod: 'InventoryService.getBalances' },
  { key: 'inventory.getValuation', method: 'GET', path: '/v1/inventory/valuation', scope: 'stock:read', live: true, serviceMethod: 'InventoryService.getValuation' },

  // --- sales (live, demo-header auth; writes are TenantWriteGuarded) ---
  { key: 'sales.createOrder', method: 'POST', path: '/v1/sales/orders', scope: 'sales:write', live: true },
  { key: 'sales.addTender', method: 'POST', path: '/v1/sales/orders/:id/tenders', scope: 'sales:write', live: true },
  { key: 'sales.completeOrder', method: 'POST', path: '/v1/sales/orders/:id/complete', scope: 'sales:write', live: true },
  { key: 'sales.voidOrder', method: 'POST', path: '/v1/sales/orders/:id/void', scope: 'sales:write', live: true },
  { key: 'sales.returnOrder', method: 'POST', path: '/v1/sales/orders/:id/returns', scope: 'sales:write', live: true },
  { key: 'sales.retryRefund', method: 'POST', path: '/v1/sales/refunds/:id/retry', scope: 'sales:write', live: true },
  { key: 'sales.manualCompleteRefund', method: 'POST', path: '/v1/sales/refunds/:id/manual-complete', scope: 'sales:write', live: true },
  { key: 'sales.recordCardAttemptOutcome', method: 'POST', path: '/v1/sales/payment-attempts/:id/outcome', scope: 'sales:write', live: true },
  { key: 'sales.getReceipt', method: 'GET', path: '/v1/sales/orders/:id/receipt', scope: 'sales:read', live: true },
  { key: 'sales.listAgeVerifications', method: 'GET', path: '/v1/sales/orders/:id/age-verifications', scope: 'sales:read', live: true, serviceMethod: 'SalesService.listAgeVerifications', note: 'Live since Build-09 (SalesController). Compliance inspection of stored age_verification_events for an order (verified_age_threshold, verified_by_user_id, verified_at = the row created_at; never any DOB). ACCURACY: scope is recorded as sales:read per the commission, but it is NOT enforced — the sales module uses demo-header auth (actorFromHeaders), not AuthGuard/RequireScope, like every other sales route. A decision is needed before treating this scope as enforced. :id is named `id` so the global UuidValidationInterceptor answers 400 INVALID_UUID for malformed ids; cross-tenant 404 (G-B).' },

  // --- events API (live, demo-header auth) ---
  { key: 'events.list', method: 'GET', path: '/v1/events', scope: null, live: true, note: 'Demo-header auth; cursor-paginated.' },

  // --- auth: PIN login (live since Build-04) ---
  { key: 'auth.pinLogin', method: 'POST', path: '/v1/auth/pin-login', scope: null, live: true, serviceMethod: 'SessionService.login', note: 'Live since Build-04 (auth.controller.ts -> SessionService.login). Unguarded: it IS the login; malformed ids are 400, never 500 (Build-05 UUID guard).' },

  // --- catalogue Phase-2 studio surfaces (live since Build-04/05) ---
  { key: 'catalogue.listPriceBooks', method: 'GET', path: '/v1/catalogue/price-books', scope: 'catalogue:read', live: true, serviceMethod: 'Phase2CatalogueService', note: 'Live since Build-04 (Phase2CatalogueService).' },
  { key: 'catalogue.createPriceBook', method: 'POST', path: '/v1/catalogue/price-books', scope: 'catalogue:write', live: true, serviceMethod: 'Phase2CatalogueService', note: 'Live since Build-04.' },
  { key: 'catalogue.setPriceBookEntry', method: 'POST', path: '/v1/price-books/:id/entries', scope: 'catalogue:write', live: true, serviceMethod: 'Phase2CatalogueService.setPriceBookEntry', note: 'Live since Build-05 (PriceBookEntriesController). Upsert: creates or replaces the entry.' },
  { key: 'catalogue.updatePriceBookEntry', method: 'PUT', path: '/v1/price-books/:id/entries/:variantId', scope: 'catalogue:write', live: true, serviceMethod: 'Phase2CatalogueService.updatePriceBookEntry', note: 'Live since Build-05 (PriceBookEntriesController). Update-only: 404 when the entry was never set.' },
  { key: 'catalogue.listPromotions', method: 'GET', path: '/v1/catalogue/promotions', scope: 'catalogue:read', live: true, serviceMethod: 'Phase2CatalogueService', note: 'Live since Build-04.' },
  { key: 'catalogue.createPromotion', method: 'POST', path: '/v1/catalogue/promotions', scope: 'catalogue:write', live: true, serviceMethod: 'Phase2CatalogueService', note: 'Live since Build-04.' },
  { key: 'catalogue.generateVouchers', method: 'POST', path: '/v1/catalogue/vouchers/bulk', scope: 'catalogue:write', live: true, serviceMethod: 'Phase2CatalogueService', note: 'Live since Build-04. Build-05 show-once: plaintext codes are returned exactly once at creation (issued_codes) and never on reads; only code_last4 is stored/returned afterwards.' },
  { key: 'catalogue.generatePromotionVouchers', method: 'POST', path: '/v1/promotions/:id/vouchers/bulk', scope: 'catalogue:write', live: true, serviceMethod: 'Phase2CatalogueService.generateVouchersShowOnce', note: 'Live since Build-05 (PromotionVouchersController). Same show-once issued_codes as catalogue.generateVouchers, scoped to one promotion (404 when unknown).' },
  { key: 'catalogue.listVouchers', method: 'GET', path: '/v1/catalogue/vouchers', scope: 'catalogue:read', live: true, serviceMethod: 'Phase2CatalogueService', note: 'Live since Build-04.' },

  // --- inventory Phase-2 console surfaces: no controller routes ---
  { key: 'inventory.listWarehouses', method: 'GET', path: '/v1/inventory/warehouses', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService', note: 'Live since Build-04.' },
  { key: 'inventory.createWarehouse', method: 'POST', path: '/v1/inventory/warehouses', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService.createWarehouse', note: 'Live since Build-10 (Obj 2, PurchasingController). One default warehouse per location; a second default is 409.' },
  { key: 'inventory.getWarehouse', method: 'GET', path: '/v1/inventory/warehouses/:id', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService.getWarehouse', note: 'Live since Build-10 (Obj 2, PurchasingController). Malformed :id → 400 INVALID_UUID; cross-tenant → 404.' },
  { key: 'purchasing.createSupplier', method: 'POST', path: '/v1/purchasing/suppliers', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService.createSupplier', note: 'Live since Build-10 (Obj 2, SuppliersController).' },
  { key: 'purchasing.listSuppliers', method: 'GET', path: '/v1/purchasing/suppliers', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService.listSuppliers', note: 'Live since Build-10 (Obj 2, SuppliersController).' },
  { key: 'purchasing.getSupplier', method: 'GET', path: '/v1/purchasing/suppliers/:id', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService.getSupplier', note: 'Live since Build-10 (Obj 2, SuppliersController). Malformed :id → 400 INVALID_UUID; cross-tenant → 404.' },
  { key: 'purchasing.linkSupplierVariant', method: 'POST', path: '/v1/purchasing/suppliers/:id/variants', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService.linkSupplierVariant', note: 'Live since Build-10 (Obj 2, SuppliersController). Upsert: re-linking the same pair replaces the row; is_preferred stored on the link (migration 017).' },
  { key: 'inventory.listTransfers', method: 'GET', path: '/v1/inventory/transfers', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService', note: 'Live since Build-04.' },
  { key: 'inventory.createTransfer', method: 'POST', path: '/v1/inventory/transfers', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService', note: 'Live since Build-04.' },
  { key: 'inventory.listReorderSuggestions', method: 'GET', path: '/v1/inventory/reorder-suggestions', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService', note: 'Live since Build-04.' },
  { key: 'inventory.acceptReorderSuggestion', method: 'POST', path: '/v1/inventory/reorder-suggestions/:id/accept', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService', note: 'Accept creates a draft purchase order. Live since Build-04.' },
  { key: 'inventory.dismissReorderSuggestion', method: 'POST', path: '/v1/inventory/reorder-suggestions/:id/dismiss', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService', note: 'Dismiss requires a reason. Live since Build-04.' },
  { key: 'inventory.listPurchaseOrders', method: 'GET', path: '/v1/inventory/purchase-orders', scope: 'stock:read', live: true, serviceMethod: 'PurchasingService', note: 'Live since Build-04.' },
  { key: 'inventory.createPurchaseOrder', method: 'POST', path: '/v1/inventory/purchase-orders', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService.createPurchaseOrder', note: 'Live since Build-12 (PurchasingController, mounted under v1/inventory/ — the commission shorthand /v1/purchasing/purchase-orders is NOT a mounted path, same precedent as Build-09 v1/catalogue/products). AuthGuard + TenantWriteGuard + stock:write; standalone draft PO (supplierId, warehouseId, expectedDeliveryDate, lines); migration 019 adds warehouse_id + expected_delivery_date.' },
  { key: 'inventory.sendPurchaseOrder', method: 'POST', path: '/v1/inventory/purchase-orders/:id/send', scope: 'stock:write', live: true, serviceMethod: 'PurchasingService', note: 'Live since Build-04.' },

  // --- CRM / loyalty / liabilities: no controller routes ---
  { key: 'crm.listCustomers', method: 'GET', path: '/v1/crm/customers', scope: 'sales:read', live: true, serviceMethod: 'CrmService', note: 'Live since Build-04.' },
  { key: 'crm.listConsents', method: 'GET', path: '/v1/crm/customers/:id/consents', scope: 'sales:read', live: true, serviceMethod: 'CrmService', note: 'Append-only history; no edit/delete route must ever be added.' },
  { key: 'crm.listLoyaltyLedger', method: 'GET', path: '/v1/crm/customers/:id/loyalty-ledger', scope: 'sales:read', live: true, serviceMethod: 'CrmService', note: 'Live since Build-04.' },
  { key: 'crm.listGiftCards', method: 'GET', path: '/v1/crm/gift-cards', scope: 'sales:read', live: true, serviceMethod: 'CrmService', note: 'Live since Build-04. Only code_last4 is ever returned.' },
  { key: 'crm.listStoreCredit', method: 'GET', path: '/v1/crm/customers/:id/store-credit', scope: 'sales:read', live: true, serviceMethod: 'CrmService', note: 'Live since Build-04.' },
  { key: 'crm.exportCustomer', method: 'POST', path: '/v1/crm/customers/:id/export', scope: 'admin', live: true, serviceMethod: 'GdprService.exportCustomer', note: 'Live since Build-04.' },
  { key: 'crm.eraseCustomer', method: 'POST', path: '/v1/crm/customers/:id/erase', scope: 'admin', live: true, serviceMethod: 'GdprService.eraseCustomer', note: 'Live since Build-04. Art. 17 erasure; PII deleted, orders/audit anonymised for VAT.' },
  { key: 'crm.assignCustomerToGroup', method: 'POST', path: '/v1/crm/customers/:id/groups', scope: 'admin', live: true, serviceMethod: 'CrmService.assignCustomerToGroup', note: 'Live since Build-12 (CrmController). AuthGuard + TenantWriteGuard + admin scope — no crm:write scope exists anywhere, none invented; idempotent when already a member (returns the existing membership). :id is named `id` so the global UuidValidationInterceptor answers 400 INVALID_UUID for malformed ids; customer and group must exist and belong to the tenant (404 otherwise — G-B).' },

  // --- finance: reporting service (live since Build-04/05) ---
  { key: 'reporting.getZReport', method: 'GET', path: '/v1/reporting/z-reports/:id', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.getZReport', note: 'Live since Build-04.' },
  { key: 'reporting.recordCorrection', method: 'POST', path: '/v1/reporting/z-reports/:id/corrections', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.recordCorrection', note: 'Live since Build-04. Requires a manager approval_event_id.' },
  { key: 'reporting.closeVatPeriod', method: 'POST', path: '/v1/reporting/vat-periods/:id/close', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.closeVatPeriodById', note: 'Live since Build-04. Build-05: closes the existing open row IN PLACE and returns the same :id (ReportingService.closeVatPeriodById); the creation path (closeVatPeriod) is separate.' },
  { key: 'reporting.getVatPeriod', method: 'GET', path: '/v1/reporting/vat-periods/:id', scope: 'accounting:read', live: true, serviceMethod: 'ReportingV1Controller.getVatPeriod', note: 'Live since Build-06 Objective 4: resolves G-UI-02 — the admin shell finance view can now read a VAT period in live mode (previously close + CSV only).' },
  { key: 'reporting.exportZReportCsv', method: 'GET', path: '/v1/reporting/z-reports/:id/csv', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.exportZReportCsv', note: 'Arch-02 §5.3 column contract. Live since Build-04.' },
  { key: 'reporting.exportVatPeriodCsv', method: 'GET', path: '/v1/reporting/vat-periods/:id/csv', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.exportVatPeriodCsv', note: 'Arch-02 §5.3 column contract. Live since Build-04.' },
  { key: 'reporting.reconcileSettlement', method: 'POST', path: '/v1/reporting/settlements/reconcile', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.reconcileSettlement', note: 'T+3 settlement. Live since Build-04.' },
  { key: 'reporting.openSession', method: 'POST', path: '/v1/reporting/sessions', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.openSession', note: 'Live since Build-06 (SessionsController). D-07 zero-float needs a manager approval_event_id.' },
  { key: 'reporting.endSession', method: 'POST', path: '/v1/reporting/sessions/:id/end', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.endSession', note: 'Live since Build-06 (SessionsController). Computes expected cash; session must be open.' },
  { key: 'reporting.closeSession', method: 'POST', path: '/v1/reporting/sessions/:id/close', scope: 'accounting:read', live: true, serviceMethod: 'ReportingService.closeSession', note: 'Live since Build-06 (SessionsController). Issues the Z-report in the same transaction; D-08 variance and W-13 pending/unknown card blocks apply.' },

  // --- webhooks admin (live since Build-04/05) ---
  { key: 'webhooks.listEndpoints', method: 'GET', path: '/v1/webhooks/endpoints', scope: 'admin', live: true, serviceMethod: 'WebhookService.listEndpoints', note: 'Live since Build-04.' },
  { key: 'webhooks.registerEndpoint', method: 'POST', path: '/v1/webhooks/endpoints', scope: 'admin', live: true, serviceMethod: 'WebhookService.registerEndpoint', note: 'Live since Build-04. Secret shown once at registration.' },
  { key: 'webhooks.rotateSecret', method: 'POST', path: '/v1/webhooks/subscriptions/:id/rotate-secret', scope: 'admin', live: true, serviceMethod: 'WebhookService.rotateEndpointSecret', note: 'Live since Build-05 (WebhooksController). New secret shown once; grace default 24h (max 168h) with dual X-Webhook-Signature / X-Webhook-Signature-Previous inside the window.' },
  { key: 'webhooks.reprovisionSecret', method: 'POST', path: '/v1/webhooks/endpoints/:id/secret', scope: 'admin', live: true, serviceMethod: 'WebhookService.setEndpointSecret', note: 'Live since Build-06 (WebhooksController). Restores the in-memory current secret after a process restart (the raw secret is never stored); never echoes the secret back. Deliberately NOT TenantWriteGuarded so it stays reachable mid-exit.' },
  { key: 'webhooks.reEncryptSecrets', method: 'POST', path: '/v1/webhooks/re-encrypt-secrets', scope: 'admin', live: true, serviceMethod: 'WebhookService.reEncryptSecrets', note: 'Live since Build-07 (WebhooksController). Platform-wide master-key rotation: re-encrypts stored webhook secret ciphertexts from a retiring key id to the active key id; body { fromKeyId }. Deliberately NOT TenantWriteGuarded (writes no tenant business data, only re-wraps ciphertexts) and admin-scoped — a platform operation, not a tenant operation; in production restrict to a platform-operator role.' },
  { key: 'webhooks.replayDeadLetter', method: 'POST', path: '/v1/webhooks/deliveries/:id/replay', scope: 'admin', live: true, serviceMethod: 'WebhookService.replayDeadLetter', note: '30-day DLQ. Live since Build-04.' },
  { key: 'webhooks.discardDeadLetter', method: 'POST', path: '/v1/webhooks/deliveries/:id/discard', scope: 'admin', live: true, serviceMethod: 'WebhookService.discardDeadLetter', note: 'Explicit discard only; never auto-deleted. Live since Build-04.' },

  // --- exit / export / GDPR (live since Build-04/05) ---
  { key: 'exit.getStatus', method: 'GET', path: '/v1/admin/exit/status', scope: 'admin', live: true, serviceMethod: 'ExitService.getTenant + findBlockers', note: 'Live since Build-04.' },
  { key: 'exit.requestTermination', method: 'POST', path: '/v1/admin/exit/request-termination', scope: 'admin', live: true, serviceMethod: 'ExitService.requestTermination', note: 'D-11: blocked (409) while open sessions / pending-unknown payments exist. Live since Build-04.' },
  { key: 'exit.beginExportWindow', method: 'POST', path: '/v1/admin/exit/begin-export-window', scope: 'admin', live: true, serviceMethod: 'ExitService.beginExportWindow', note: 'Starts the 30-day read-only export window. Live since Build-04.' },
  { key: 'exit.runFullExport', method: 'POST', path: '/v1/admin/exit/full-export', scope: 'admin', live: true, serviceMethod: 'ExportService.runFullExport', note: 'Single-click full export; manifest.json with SHA-256 checksums. Live since Build-04.' },
  { key: 'exit.scheduleHardDelete', method: 'POST', path: '/v1/admin/exit/schedule-hard-delete', scope: 'admin', live: true, serviceMethod: 'ExitService.scheduleHardDelete', note: 'Live since Build-04. 6-year statutory VAT archive is separated first (GdprService.hardDelete).' },
  { key: 'exit.hardDelete', method: 'POST', path: '/v1/admin/exit/hard-delete', scope: 'admin', live: true, serviceMethod: 'GdprService.hardDelete', note: 'Live since Build-06 (ExitController). Executes the deletion after the 30-day window has ended; separates the 6-year statutory VAT archive first (DB row + on-disk SHA-256 bundle, verified before any tenant row is deleted) and returns its SHA-256 + bundle path. The caller key is deleted with the tenant.' },

  // --- compliance: statutory VAT archives (Build-05) ---
  { key: 'compliance.listStatutoryArchives', method: 'GET', path: '/v1/compliance/statutory-archives/:tenantId', scope: 'admin', live: true, serviceMethod: 'GdprService.listStatutoryArchives', note: 'Live since Build-05 (ComplianceController). Own tenant only (cross-tenant is 404); each archive carries payload/file SHA-256 verification flags.' },
];

export function routeFor(key: string): RouteDescriptor {
  const route = ROUTES.find((r) => r.key === key);
  if (route === undefined) {
    throw new Error(`Unknown route key: ${key}`);
  }
  return route;
}

/** Fill `:id` style segments in a path template. */
export function fillPath(path: string, params: Record<string, string>): string {
  let filled = path;
  for (const [name, value] of Object.entries(params)) {
    filled = filled.replace(`:${name}`, encodeURIComponent(value));
  }
  return filled;
}

export function liveRoutes(): RouteDescriptor[] {
  return ROUTES.filter((r) => r.live);
}

export function notExposedRoutes(): RouteDescriptor[] {
  return ROUTES.filter((r) => !r.live);
}
