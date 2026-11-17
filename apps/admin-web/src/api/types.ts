/**
 * Shared wire types for the admin-web typed API client.
 *
 * DESIGN DECISION (D-AW-01): money and quantities cross the JSON boundary
 * as DECIMAL STRINGS of integer pence / integer units — JSON has no
 * bigint, and this is exactly the contract the API controllers use
 * (see apps/api catalogue/sales/inventory controllers: request bodies
 * carry pence as strings, responses return pence as strings). The
 * dashboard never parses money into floats.
 */

export type PenceString = string;
export type QuantityString = string;

/** Scopes from apps/api/src/common/scopes.ts (Arch-02 §4.3). */
export const SCOPES = [
  'catalogue:read',
  'catalogue:write',
  'sales:read',
  'sales:write',
  'stock:read',
  'stock:write',
  'payments:read',
  'accounting:read',
  'admin',
] as const;
export type ApiScope = (typeof SCOPES)[number];

/** How the dashboard authenticates (apps/api auth.guard.ts). */
export interface ApiCredentials {
  /**
   * API key (`ukp_…`) or PIN-session token. Sent as
   * `Authorization: Bearer <token>`; API keys are also accepted by the
   * guard as `X-Api-Key`. The dashboard never stores a credential in
   * localStorage in this pilot build — the caller supplies it per client.
   */
  token: string;
  /** Tenant the caller is acting for; sent as `x-tenant-id` when set. */
  tenantId?: string;
  /** Location scope header, sent as `x-location-id` when set. */
  locationId?: string;
  /** Send the token as X-Api-Key instead of Authorization Bearer. */
  useApiKeyHeader?: boolean;
}

export interface VariantView {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price_pence: PenceString;
  cost_pence: PenceString;
  tax_rate_id: string | null;
  is_bundle: boolean;
  /** The server returns the row's is_active (the table carries no
   * status column); the admin UI renders it as active/inactive. */
  is_active: boolean;
}

/**
 * Tax-rate wire view (Build-08 Objective 1) — mirrors apps/api
 * CatalogueService.toTaxRateView: rate_bps is exact integer basis
 * points (20% → 2000); is_exempt = kind 'exempt'; is_default_no_tax
 * = kind 'zero' or 'exempt' (the rate charges no tax).
 */
export interface TaxRateView {
  id: string;
  name: string;
  rate_bps: number;
  is_exempt: boolean;
  is_default_no_tax: boolean;
}

export interface CreateVariantInput {
  productId: string;
  sku: string;
  barcode?: string | null;
  name: string;
  /** Integer pence, decimal string. */
  pricePence: PenceString;
  costPence?: PenceString;
  taxRateId?: string | null;
  isBundle?: boolean;
  /** Optional nested age restriction, created in the same transaction as the variant. */
  ageRestriction?: AgeRestrictionInput | null;
}

/**
 * Variant-update fields (Build-12 Objective 3) — mirrors
 * PATCH /v1/catalogue/variants/:id. Only the fields supplied are
 * updated; `status` maps to the variant's `is_active` boolean (the
 * table carries no status column). Absent fields keep their value;
 * `barcode: null` clears the barcode.
 */
export interface UpdateVariantInput {
  sku?: string;
  barcode?: string | null;
  pricePence?: PenceString;
  costPence?: PenceString;
  taxRateId?: string | null;
  status?: 'active' | 'inactive';
}

/**
 * Parent-product wire view (Build-09 Objective 1) — mirrors apps/api
 * CatalogueService.toProductView (snake_case, like VariantView).
 */
export interface ProductView {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
}

export interface CreateProductInput {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  /**
   * Optional nested age restriction (Build-12 Objective 2): the
   * server inserts a first-class product-level rule atomically with
   * the product (migration 018). A variant created under the product
   * afterwards inherits it unless it carries an explicit nested rule
   * of its own.
   */
  ageRestriction?: AgeRestrictionInput | null;
}

/** Nested age-restriction fields on a create body (camelCase, like the API). */
export interface AgeRestrictionInput {
  requiresChallenge25?: boolean | null;
  minAge?: number | null;
}

/**
 * Age-restriction wire view (Build-09 Objective 1; stored product
 * rules Build-11 Objective 2) — mirrors apps/api
 * CatalogueService.toAgeRestrictionView. A product-level rule has
 * variant_id NULL; rule_source says whether a variant row was set
 * explicitly by the merchant or propagated from the product rule.
 */
export interface AgeRestrictionView {
  id: string;
  variant_id: string | null;
  product_id: string;
  requires_challenge_25: boolean;
  min_age: number;
  rule_source: 'explicit' | 'inherited';
}

/**
 * Result of DELETE /v1/catalogue/age-restrictions/:id (Build-12
 * Objective 2) — mirrors apps/api
 * CatalogueService.DeleteAgeRestrictionResult (snake_case).
 */
export interface DeleteAgeRestrictionResult {
  deleted_rule: AgeRestrictionView;
  deleted_inherited_rule_ids: string[];
}

export interface CreateAgeRestrictionInput {
  productId?: string | null;
  variantId?: string | null;
  requiresChallenge25?: boolean | null;
  minAge?: number | null;
}

export interface PriceBasketLineInput {
  variantId: string;
  quantity: QuantityString;
  unitId?: string | null;
  manualDiscountPence?: PenceString;
}

export interface PriceBasketInput {
  lines: PriceBasketLineInput[];
  voucherCode?: string;
  basketDiscountPence?: PenceString;
  approvalEventsId?: string | null;
}

export interface AppliedPromotionView {
  promotion_id: string;
  promotion_version: number;
  discountPence: PenceString;
}

export interface PricedLineView {
  variantId: string;
  quantity: QuantityString;
  basePricePence: PenceString;
  priceBookPricePence: PenceString | null;
  promotionDiscountPence: PenceString;
  manualDiscountPence: PenceString;
  finalPricePence: PenceString;
  lineTotalPence: PenceString;
  taxAmountPence: PenceString;
  appliedPromotions: AppliedPromotionView[];
}

export interface PriceBasketView {
  lines: PricedLineView[];
  subtotalPence: PenceString;
  discountPence: PenceString;
  taxPence: PenceString;
  totalPence: PenceString;
  voucherPromotionId: string | null;
  voucherDiscountPence: PenceString | null;
}

export interface StockLevelView {
  variantId: string;
  warehouseId: string;
  quantityOnHand: QuantityString;
  /** Read-model timestamp; display hint only, never authoritative. */
  computedAt?: string | null;
  /**
   * Weighted-average cost from stock_valuation (Build-11 Objective 1).
   * Null when the variant-warehouse has no valuation row — the average
   * is never guessed from the variant's cost_pence.
   */
  weightedAvgCostPence?: PenceString | null;
  /** quantityOnHand × weightedAvgCostPence; null when the average is null. */
  totalValuePence?: PenceString | null;
}

/** Per-variant-warehouse balance with valuation (Build-11 Objective 1). */
export interface BalanceView extends StockLevelView {
  computedAt: string;
}

/** One per-variant roll-up row of GET /v1/inventory/valuation (Build-11 Objective 1). */
export interface ValuationRowView {
  variantId: string;
  totalQuantityOnHand: QuantityString;
  weightedAvgCostPence: PenceString | null;
  totalValuePence: PenceString | null;
}

/** GET /v1/inventory/valuation response (Build-11 Objective 1). */
export interface ValuationSummaryView {
  valuation: ValuationRowView[];
  totals: { totalQuantityOnHand: QuantityString; totalValuePence: PenceString | null };
}

export interface CountLineInput {
  variantId: string;
  warehouseId?: string | null;
  countedQuantity: QuantityString;
}

export interface GoodsInLineInput {
  variantId: string;
  quantityReceived: QuantityString;
  quantityDamaged?: QuantityString;
  quantityShort?: QuantityString;
  costPence: QuantityString;
}

export interface GoodsInInput {
  poId?: string | null;
  supplierId: string;
  locationId: string;
  warehouseId: string;
  lines: GoodsInLineInput[];
}

export interface AuditEventView {
  id: string;
  tenant_id: string;
  user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  /** The canonical hashed payload (JSON-safe; money as strings). */
  payload: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
  created_at: string;
}

export interface ApprovalInput {
  action: string;
  amountPence?: PenceString | null;
  reason?: string | null;
  requestedByUserId: string;
  orderId?: string | null;
  approverPin: string;
}

export interface ApiKeyView {
  id: string;
  name: string | null;
  key_prefix: string;
  scopes: string[];
  status: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  grace_until: string | null;
}

export interface ApiKeyCreatedView extends ApiKeyView {
  /** Full key, returned ONLY at creation/rotation. Never stored, never re-fetched. */
  key: string;
}

export interface WebhookDeliveryView {
  id: string;
  event_id: string;
  endpoint_id: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ListedEventView {
  id: string;
  tenant_id: string;
  event_type: string;
  sequence: string;
  payload: Record<string, unknown>;
  created_at: string;
  deliveries: WebhookDeliveryView[];
}

export interface ListEventsResultView {
  events: ListedEventView[];
  nextCursor: string | null;
}

export interface ListEventsFilters {
  eventType?: string;
  createdAfter?: string;
  deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  limit?: number;
  cursor?: string | null;
}

export interface ReceiptView {
  receiptNumber: string;
  orderId: string;
  issuedAt: string;
  lines: Array<{
    taxRateKind: string;
    taxRatePercent: string;
    grossPence: PenceString;
    vatPence: PenceString;
    netPence: PenceString;
  }>;
  totalPence: PenceString;
  vatInvoiceNotice: string;
}

export interface StatusView {
  module: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/* Shapes for service-layer surfaces with NO HTTP route yet (Build-03) */
/* ------------------------------------------------------------------ */

/**
 * These types mirror the service-layer / schema shapes exactly (field
 * names from packages/db/src/schema.ts and the Build-03 services) so
 * the dashboard consoles can be written and tested against the fake
 * client today, and switched to live calls the moment the coordinator
 * adds the HTTP routes. The live client reports them via
 * `routeAvailability()` / NotExposedError — it never invents a URL.
 */
export interface PriceBookView {
  id: string;
  name: string;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  status: 'draft' | 'active' | 'expired';
}
export interface PriceBookEntryView {
  price_book_id: string;
  variant_id: string;
  price_pence: PenceString;
}
export interface PromotionView {
  id: string;
  name: string;
  type: 'percentage' | 'fixed' | 'bogo' | 'multibuy' | 'bundle' | 'loyalty_bonus' | 'staff';
  status: 'draft' | 'active' | 'paused' | 'expired';
  version: number;
  stack_group: string | null;
  start_at: string;
  end_at: string | null;
}
/**
 * Voucher display shape — DELIBERATELY contains only `code_last4`.
 * The full code is never stored server-side (code_hash + code_last4
 * only, Arch-01) and must never appear in any dashboard view, log or
 * test fixture (D-AW-06).
 */
export interface VoucherView {
  id: string;
  code_last4: string;
  promotion_id: string | null;
  status: 'active' | 'redeemed' | 'void' | 'expired';
  max_uses: number;
  uses_count: number;
  valid_from: string;
  valid_to: string | null;
}
export interface WarehouseView {
  id: string;
  location_id: string;
  name: string;
  type: 'store' | 'warehouse';
  is_default: boolean;
}

export interface CreateWarehouseInput {
  locationId: string;
  name: string;
  type?: 'store' | 'warehouse';
  isDefault?: boolean;
}

/** Supplier wire view (Build-10 Objective 2) — snake_case, money as decimal strings. */
export interface SupplierView {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  lead_time_days: number | null;
  minimum_order_value_pence: string | null;
  currency: string;
}

export interface CreateSupplierInput {
  name: string;
  currency?: string;
  leadTimeDays?: number | null;
  minOrderValuePence?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Supplier-variant link wire view (Build-10 Objective 2). */
export interface SupplierVariantView {
  supplier_id: string;
  variant_id: string;
  supplier_sku: string | null;
  cost_pence: string;
  currency: string;
  is_preferred: boolean;
}

export interface LinkSupplierVariantInput {
  variantId: string;
  supplierSku?: string | null;
  costPence: string;
  currency?: string;
  isPreferred?: boolean;
}
export interface StockTransferView {
  id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  status: 'draft' | 'in_transit' | 'received' | 'cancelled';
  received_at: string | null;
  lines: Array<{ variant_id: string; quantity: QuantityString; received_quantity: QuantityString }>;
}
export interface ReorderSuggestionView {
  id: string;
  location_id: string;
  variant_id: string;
  supplier_id: string | null;
  suggested_quantity: QuantityString;
  expected_date: string | null;
  status: 'pending' | 'approved' | 'dismissed';
}
export interface PurchaseOrderView {
  id: string;
  location_id: string;
  supplier_id: string;
  po_number: string;
  status: 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled';
  sent_at: string | null;
  /**
   * Warehouse the delivery is due at (Build-12 Objective 3,
   * migration 019). Null on POs created by accepting a reorder
   * suggestion, which never named a warehouse.
   */
  warehouse_id: string | null;
  /** Optional expected delivery date (Build-12 Objective 3, migration 019). */
  expected_delivery_date: string | null;
  lines: Array<{
    variant_id: string;
    quantity_ordered: QuantityString;
    quantity_received: QuantityString;
    cost_pence: PenceString;
  }>;
}

/** Standalone purchase-order creation (Build-12 Objective 3). */
export interface CreatePurchaseOrderInput {
  supplierId: string;
  warehouseId: string;
  expectedDeliveryDate?: string | null;
  lines: Array<{ variantId: string; quantityOrdered: QuantityString; unitCostPence: PenceString }>;
}
export interface CustomerView {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

/** Manual customer group (Build-12 Objective 3) — mirrors the
 * customer_groups table. There is no create-group route in this
 * dashboard; groups are created server-side, and this console only
 * assigns members to them. */
export interface CustomerGroupView {
  id: string;
  name: string;
  description: string | null;
}

/** One customer-group membership (Build-12 Objective 3) — mirrors
 * POST /v1/crm/customers/:id/groups. The membership row carries no
 * tenant_id; tenant scoping comes from verifying both sides first. */
export interface CustomerGroupMembershipView {
  customer_id: string;
  group_id: string;
  created_at: string;
}
export interface MarketingConsentView {
  id: string;
  customer_id: string;
  purpose: string;
  channel: string;
  consented: boolean;
  recorded_at: string;
  recorded_by_user_id: string | null;
}
export interface LoyaltyLedgerEntryView {
  id: string;
  customer_id: string;
  membership_id: string;
  kind: 'earn' | 'redeem' | 'correction' | 'expiry';
  points: string;
  order_id: string | null;
  reason: string | null;
  created_at: string;
}
export interface GiftCardView {
  id: string;
  code_last4: string;
  initial_amount_pence: PenceString;
  balance_pence: PenceString;
  status: 'active' | 'redeemed' | 'expired' | 'void';
  expires_at: string | null;
}
export interface ZReportSummaryView {
  id: string;
  z_number: string;
  business_date: string;
  register_id: string;
  gross_pence: PenceString;
  net_pence: PenceString;
  vat_pence: PenceString;
  cash_variance_pence: PenceString;
}
export interface VatPeriodView {
  id: string;
  period_start: string;
  period_end: string;
  status: string;
}
export interface SettlementView {
  businessDate: string;
  settlementDate: string;
  cardGrossPence: PenceString;
  feeEstimatePence: PenceString;
  settledGrossPence: PenceString;
  settledFeePence: PenceString;
  reserveHoldTotalPence: PenceString;
  disputeDebitTotalPence: PenceString;
  expectedNetPayoutPence: PenceString;
  status: 'reconciled' | 'discrepancy';
  discrepancyReason: string | null;
}
export interface WebhookEndpointView {
  id: string;
  url: string;
  event_types: string[];
  status: 'active' | 'disabled';
}
/**
 * PIN login (Build-05): POST /v1/auth/pin-login. The endpoint is
 * unguarded — it IS the login — so the client sends whatever
 * credential it was constructed with (the server ignores it) and
 * the returned session token replaces it for later calls.
 */
export interface PinLoginInput {
  tenantId: string;
  userId: string;
  pin: string;
  locationId?: string | null;
  isTill?: boolean;
}
export interface PinLoginResult {
  token: string;
  actor: {
    tenantId: string;
    userId: string;
    locationId: string | null;
    roles: string[];
  };
}
/**
 * Show-once voucher code (Build-05): returned ONLY in the bulk
 * generation response (`issued_codes`), never on reads. The
 * dashboard must display it once for distribution and never store
 * or log it — the server stores code_hash + code_last4 only.
 */
export interface IssuedVoucherCodeView {
  id: string;
  code: string;
  code_last4: string;
  expires_at: string | null;
}
export interface GeneratePromotionVouchersResult {
  promotionId: string;
  issuedCodes: IssuedVoucherCodeView[];
}
/**
 * Unscoped bulk voucher generation result (Build-05 show-once fix):
 * same shape as the promotion-scoped result, but the promotion may be
 * null (unscoped generation). Plaintext codes exist only here, exactly
 * once at creation; reads return VoucherView rows (code_last4 only).
 */
export interface GenerateVouchersResult {
  promotionId: string | null;
  issuedCodes: IssuedVoucherCodeView[];
}
/** Webhook secret rotation result (Build-05): the new secret is shown once, never stored. */
export interface RotateWebhookSecretView {
  endpoint_id: string;
  secret: string;
  previous_secret_expires_at: string;
  grace_period_hours: number;
}
/** One persisted 6-year statutory VAT archive, with verification flags (Build-05). */
export interface StatutoryArchiveView {
  id: string;
  tenant_id: string;
  archived_at: string;
  retention_until: string;
  archive_sha256: string;
  row_counts: Record<string, number>;
  storage_bundle_path: string;
  payload_verified: boolean;
  file_verified: boolean;
  verified: boolean;
}
export interface ExitStatusView {
  tenantId: string;
  status: 'active' | 'termination_requested' | 'export_window' | 'hard_delete_scheduled' | 'deleted';
  exportWindowEndsAt: string | null;
  /** D-11 blockers, exactly as ExitService.findBlockers reports them. */
  openSessionIds: string[];
  blockingPaymentAttemptIds: string[];
}
export interface ExportManifestEntryView {
  file_name: string;
  table_name: string;
  row_count: number;
  sha256_checksum: string;
}
export interface ExportResultView {
  jobId: string;
  files: Record<string, string>;
  manifest: ExportManifestEntryView[];
  totalRows: number;
  fileCount: number;
}
export interface CustomerExportView {
  customerId: string;
  files: Record<string, string>;
  manifest: ExportManifestEntryView[];
  totalRows: number;
  fileCount: number;
}
export interface ErasureResultView {
  customerId: string;
  anonymisedOrderCount: number;
  anonymisedLedgerRowCount: number;
  placeholderCustomerId: string;
}
