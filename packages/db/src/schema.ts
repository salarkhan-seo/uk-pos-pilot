/**
 * Kysely database schema types for the UK POS pilot.
 *
 * These types mirror the DDL migrations in packages/db/migrations/ one to
 * one. Money columns are bigint (integer pence, D-13); timestamps are Date
 * (timestamptz); ids are string (uuid). Columns with a database default are
 * wrapped in Generated<> so inserts may omit them.
 *
 * This file defines TYPES ONLY. No connection, no driver, no runtime query
 * is created here — the driver (pg) and the connection are Build-02 work.
 */
import type { Generated } from 'kysely';

export interface MigrationsTable {
  id: Generated<number>;
  filename: string;
  applied_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 001_tenancy — Arch-01 §2.1                                          */
/* ------------------------------------------------------------------ */

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  legal_name: string | null;
  trading_name: string | null;
  vat_registered: boolean;
  vat_number: string | null;
  status: 'active' | 'suspended' | 'termination_requested' | 'export_window' | 'hard_delete_scheduled' | 'deleted';
  plan_tier: 'base' | 'plus';
  termination_requested_at: Date | null;
  export_window_ends_at: Date | null;
  hard_delete_scheduled_at: Date | null;
  deleted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LocationsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  address_line_1: string | null;
  address_line_2: string | null;
  town: string | null;
  postcode: string | null;
  country: string;
  timezone: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RegistersTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  name: string;
  device_id: string | null;
  status: 'active' | 'disabled' | 'lost';
  last_heartbeat_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RolesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  is_system: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RolePermissionsTable {
  id: Generated<string>;
  role_id: string;
  permission: string;
  discount_limit_pence: bigint | null;
  created_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  /** Till PIN hash (salted scrypt, see shared-kernel pin.ts). Build-02. */
  pin_hash: string | null;
  status: 'active' | 'disabled';
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UserRolesTable {
  id: Generated<string>;
  user_id: string;
  role_id: string;
  location_id: string;
  created_at: Generated<Date>;
}

export interface UserLocationsTable {
  user_id: string;
  location_id: string;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 002_catalogue — Arch-01 §2.2, Arch-06 §2.4                         */
/* ------------------------------------------------------------------ */

export interface CategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TaxRatesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  kind: 'standard' | 'reduced' | 'zero' | 'exempt';
  rate_percent: string;
  valid_from: Generated<Date>;
  valid_to: Date | null;
  is_active: boolean;
  created_at: Generated<Date>;
}

export interface ProductsTable {
  id: Generated<string>;
  tenant_id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProductAttributesTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  name: string;
  sort_order: number;
  created_at: Generated<Date>;
}

export interface AttributeValuesTable {
  id: Generated<string>;
  product_attribute_id: string;
  value: string;
  sort_order: number;
  created_at: Generated<Date>;
}

export interface UnitsOfMeasureTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  abbreviation: string;
  is_base: boolean;
  created_at: Generated<Date>;
}

export interface ProductVariantsTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  name: string;
  price_pence: bigint;
  cost_pence: bigint;
  tax_rate_id: string | null;
  is_bundle: boolean;
  is_active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VariantAttributeValuesTable {
  variant_id: string;
  product_attribute_id: string;
  attribute_value_id: string;
  created_at: Generated<Date>;
}

export interface VariantUnitsTable {
  id: Generated<string>;
  variant_id: string;
  unit_id: string;
  conversion_factor: string;
  is_base: boolean;
  created_at: Generated<Date>;
}

export interface AgeRestrictionsTable {
  id: Generated<string>;
  tenant_id: string;
  /** Set on a product-level rule; NULL on a variant-level row. */
  product_id: string | null;
  /** Set on a variant-level row; NULL on a product-level rule. */
  variant_id: string | null;
  min_age_years: number;
  challenge_25: boolean;
  /** 'explicit' = merchant-set; 'inherited' = propagated from the product rule. */
  rule_source: Generated<'explicit' | 'inherited'>;
  created_at: Generated<Date>;
}

export interface SerialNumbersTable {
  id: Generated<string>;
  tenant_id: string;
  variant_id: string;
  serial_number: string;
  status: 'in_stock' | 'sold' | 'returned' | 'written_off';
  order_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BundleComponentsTable {
  bundle_variant_id: string;
  component_variant_id: string;
  quantity: number;
  created_at: Generated<Date>;
}

export interface BarcodeRulesTable {
  id: Generated<string>;
  tenant_id: string;
  mode: 'price_embedded' | 'weight_embedded';
  sku_length: number;
  price_digits: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SuppliersTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  lead_time_days: number | null;
  minimum_order_value_pence: bigint | null;
  currency: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SupplierVariantsTable {
  supplier_id: string;
  variant_id: string;
  supplier_sku: string | null;
  cost_pence: bigint;
  currency: string;
  /** Preferred supplier for this variant (Build-10 Objective 2, migration 017). */
  is_preferred: boolean;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 003_inventory_ledger — Arch-01 §2.3–2.4, Arch-06 §§2–5             */
/* ------------------------------------------------------------------ */

export interface WarehousesTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  name: string;
  type: 'store' | 'warehouse';
  is_default: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StockBalancesTable {
  variant_id: string;
  warehouse_id: string;
  tenant_id: string;
  location_id: string;
  quantity_on_hand: bigint;
  computed_at: Generated<Date>;
}

export interface StockMovementsTable {
  id: Generated<string>;
  tenant_id: string;
  variant_id: string;
  warehouse_id: string | null;
  location_id: string;
  cause:
    | 'sale' | 'return' | 'adjustment' | 'count' | 'goods_in'
    | 'transfer_out' | 'transfer_in' | 'damage' | 'shrinkage' | 'found'
    | 'supplier_error' | 'offline_sync_conflict' | 'case_breakdown';
  quantity_change: bigint;
  quantity_in_base_units: bigint | null;
  unit_id: string | null;
  cost_pence_at_movement: bigint | null;
  order_id: string | null;
  reference_id: string | null;
  reference_type: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface StockCountsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  warehouse_id: string | null;
  status: 'draft' | 'submitted' | 'cancelled';
  started_by_user_id: string | null;
  submitted_by_user_id: string | null;
  submitted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StockCountLinesTable {
  count_id: string;
  variant_id: string;
  warehouse_id: string | null;
  expected_quantity: bigint;
  counted_quantity: bigint | null;
  created_at: Generated<Date>;
}

export interface StockTransfersTable {
  id: Generated<string>;
  tenant_id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  status: 'draft' | 'in_transit' | 'received' | 'cancelled';
  requested_by_user_id: string | null;
  received_by_user_id: string | null;
  received_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StockTransferLinesTable {
  transfer_id: string;
  variant_id: string;
  quantity: bigint;
  received_quantity: bigint;
  created_at: Generated<Date>;
}

export interface ReorderPointsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  variant_id: string;
  min_quantity: bigint;
  max_quantity: bigint;
  supplier_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PurchaseOrderSuggestionsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  variant_id: string;
  supplier_id: string | null;
  suggested_quantity: bigint;
  expected_date: string | null;
  status: 'pending' | 'approved' | 'dismissed';
  created_at: Generated<Date>;
}

export interface PurchaseOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  supplier_id: string;
  po_number: bigint;
  status: 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled';
  currency: string;
  exchange_rate: string | null;
  sent_at: Date | null;
  /**
   * Warehouse the delivery is due at (Build-12 Objective 3:
   * standalone PO creation). NULL on POs created by accepting a
   * reorder suggestion, which never named a warehouse.
   */
  warehouse_id: string | null;
  /** Optional expected delivery date (Build-12 Objective 3). */
  expected_delivery_date: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PurchaseOrderLinesTable {
  po_id: string;
  variant_id: string;
  quantity_ordered: bigint;
  quantity_received: bigint;
  cost_pence: bigint;
  currency: string;
  created_at: Generated<Date>;
}

export interface GoodsInReceiptsTable {
  id: Generated<string>;
  tenant_id: string;
  po_id: string | null;
  location_id: string;
  warehouse_id: string | null;
  received_by_user_id: string | null;
  received_at: Generated<Date>;
  created_at: Generated<Date>;
}

export interface GoodsInLinesTable {
  receipt_id: string;
  variant_id: string;
  quantity_ordered: bigint;
  quantity_received: bigint;
  quantity_damaged: bigint;
  quantity_short: bigint;
  cost_pence: bigint;
  created_at: Generated<Date>;
}

export interface StockValuationTable {
  variant_id: string;
  warehouse_id: string;
  tenant_id: string;
  weighted_average_cost_pence: bigint;
  quantity_on_hand: bigint;
  computed_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 004_sales_payments — Arch-01 §2.5, Arch-02 §6, Arch-10 §2          */
/* ------------------------------------------------------------------ */

export interface OrdersTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  register_id: string | null;
  customer_id: string | null;
  order_number: bigint;
  business_date: string;
  status: 'draft' | 'pending_payment' | 'completed' | 'voided' | 'partially_returned' | 'returned';
  subtotal_pence: bigint;
  discount_pence: bigint;
  tax_pence: bigint;
  total_pence: bigint;
  created_by_user_id: string | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderLinesTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  variant_id: string;
  quantity: bigint;
  /** Build-03 migration 009: warehouse the line was reserved from (Arch-06 §2). Generated<> so inserts may omit it (the checkout decrement stamps it); NULL on pre-009 lines. */
  warehouse_id: Generated<string | null>;
  /** Build-03 migration 009: variant_units ROW id the line was sold in. NULL = base unit / pre-009 line. */
  unit_id: Generated<string | null>;
  /** Build-03 migration 009: quantity x variant_units.conversion_factor (base units). NULL on pre-009 lines. */
  quantity_in_base_units: Generated<bigint | null>;
  unit_price_pence: bigint;
  base_price_pence: bigint;
  price_book_id: string | null;
  price_book_price_pence: bigint | null;
  promotion_discount_pence: bigint;
  manual_discount_pence: bigint;
  final_price_pence: bigint;
  tax_rate_kind: 'standard' | 'reduced' | 'zero' | 'exempt';
  tax_rate_percent: string;
  tax_amount_pence: bigint;
  line_total_pence: bigint;
  created_at: Generated<Date>;
}

export interface PaymentAttemptsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  idempotency_key: string;
  provider: 'stripe' | 'sumup' | 'standalone';
  provider_reference: string | null;
  status: 'created' | 'pending' | 'approved' | 'declined' | 'unknown' | 'refunded';
  amount_pence: bigint;
  currency: string;
  attempt_number: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderTendersTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  tender_type: 'cash' | 'card' | 'store_credit' | 'gift_card' | 'loyalty_points';
  amount_pence: bigint;
  payment_attempt_id: string | null;
  created_at: Generated<Date>;
}

export interface RefundsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  payment_attempt_id: string | null;
  idempotency_key: string;
  amount_pence: bigint;
  reason: string | null;
  status: 'pending' | 'completed' | 'failed' | 'manual_escalation';
  provider_reference: string | null;
  /** Build-03 migration 012: provider attempts made for this refund; 5 failures → manual_escalation. */
  retry_count: Generated<number>;
  /** Build-03 migration 012: when the next queued attempt is due (exponential backoff); null when not queued. */
  next_retry_at: Generated<Date | null>;
  /** Build-03 migration 012: distinct machine-readable failure code ('provider_unavailable' | 'insufficient_balance' | 'refund_failed' | 'standalone_manual_refund' | null). */
  failure_reason: Generated<string | null>;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReceiptsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  order_id: string;
  receipt_number: bigint;
  /** Stored on every receipt: a till receipt is not a VAT invoice. */
  vat_invoice_notice: string;
  issued_at: Generated<Date>;
  created_at: Generated<Date>;
}

export interface ReceiptVatLinesTable {
  receipt_id: string;
  tax_rate_kind: 'standard' | 'reduced' | 'zero' | 'exempt';
  tax_rate_percent: string;
  gross_pence: bigint;
  vat_pence: bigint;
  net_pence: bigint;
  created_at: Generated<Date>;
}

export interface AgeVerificationEventsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  variant_id: string;
  verified_age_years: number;
  method: 'manual_confirmation' | 'dob_entry';
  outcome: 'verified' | 'refused';
  verified_by_user_id: string | null;
  /** Client till timestamp (Build-11 Obj 2); defaults to the server record time. */
  verified_at: Generated<Date>;
  created_at: Generated<Date>;
}

export interface ApprovalEventsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string | null;
  action: string;
  amount_pence: bigint | null;
  reason: string | null;
  requested_by_user_id: string;
  approved_by_user_id: string;
  created_at: Generated<Date>;
}

export interface OfflinePaymentRecordsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string | null;
  local_id: string;
  amount_pence: bigint;
  currency: string;
  status: 'pending_forward' | 'forwarded' | 'declined_after_forward' | 'lost';
  stripe_payment_intent_id: string | null;
  reader_id: string | null;
  location_id: string;
  offline_created_at: Generated<Date>;
  forwarded_at: Date | null;
  idempotency_key: string;
  reader_software_version: string | null;
  connection_token_age_hours: number | null;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 010_api_keys — Arch-02 §4.2–§4.3 (Build-03 Objective 1)             */
/* ------------------------------------------------------------------ */

export interface ApiKeysTable {
  id: Generated<string>;
  tenant_id: string;
  /** SHA-256 hex of the full key. The full key is never stored. */
  key_hash: string;
  /** First 8 characters of the full key, for identification only. */
  key_prefix: string;
  name: string | null;
  scopes: string[];
  status: 'active' | 'rotating' | 'revoked';
  created_at: Generated<Date>;
  last_used_at: Date | null;
  expires_at: Date | null;
  /** Old key stays valid until this time during rotation (24h grace). */
  grace_until: Date | null;
}

/* ------------------------------------------------------------------ */
/* 011_webhook_events_dlq — Arch-02 §3 (Build-03 Objective 4)         */
/* Merged in by the Build-03 coordinator from                         */
/* packages/db/src/webhook-schema.ts (now a re-export of these).      */
/* ------------------------------------------------------------------ */

export interface WebhookEndpointsTable {
  id: Generated<string>;
  tenant_id: string;
  url: string;
  /** SHA-256 hex of the server-generated endpoint secret (shown once). */
  secret_hash: string;
  /** SHA-256 hex of the retiring secret during its rotation grace window (migration 014). */
  previous_secret_hash: string | null;
  /** End of the rotation grace window; null when no rotation is in progress (migration 014). */
  previous_secret_expires_at: Date | null;
  /**
   * AES-256-GCM envelope of the retiring secret (`v1:<keyId>:<base64(iv || tag || ct)>`),
   * encrypted under the WEBHOOK_ENCRYPTION_KEY master key (migration 015, Build-06).
   * Null when no rotation is in progress, or when the rotation happened while the
   * previous raw secret was not held in memory. Never a plaintext secret.
   */
  previous_secret_ciphertext: string | null;
  /**
   * AES-256-GCM envelope of the CURRENT signing secret (same envelope
   * format), encrypted under the active master key (migration 016,
   * Build-07). Written at registration and at every rotation, so a
   * fresh service instance recovers the signing secret from the
   * database instead of needing re-provisioning. Null only for legacy
   * rows created before Build-07. Never a plaintext secret.
   */
  current_secret_ciphertext: string | null;
  /**
   * Master key id that encrypted current_secret_ciphertext at the most
   * recent write (migration 016, Build-07). 'v1' is the pre-keyring
   * placeholder for rows written before Build-07; Build-07 writes
   * store the real active key id (e.g. 'k1'). The envelope itself
   * also carries its key id — decryption never depends on this
   * column. previous_secret_ciphertext keeps its own envelope key id.
   */
  encryption_key_id: string;
  event_types: string[];
  status: 'active' | 'disabled';
  created_at: Generated<Date>;
}

export interface WebhookEventsTable {
  id: Generated<string>;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  /** Per-tenant monotonic sequence; unique on (tenant_id, sequence). */
  sequence: bigint;
  created_at: Generated<Date>;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  tenant_id: string;
  event_id: string;
  endpoint_id: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead_letter';
  attempt_count: number;
  next_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  dlq_entered_at: Date | null;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 005_sessions_zreports — Arch-01 §2.6 and §3                        */
/* ------------------------------------------------------------------ */

export interface RegisterSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  register_id: string;
  opened_by_user_id: string | null;
  opened_at: Generated<Date>;
  float_pence: bigint;
  status: 'open' | 'ended' | 'closed';
  ended_at: Date | null;
  closed_at: Date | null;
  closed_by_user_id: string | null;
  expected_cash_pence: bigint | null;
  counted_cash_pence: bigint | null;
  variance_pence: bigint | null;
  variance_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CashMovementsTable {
  id: Generated<string>;
  tenant_id: string;
  session_id: string;
  type: 'cash_in' | 'cash_out' | 'petty_cash_in' | 'petty_cash_out' | 'paid_in' | 'paid_out';
  amount_pence: bigint;
  note: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface ZReportsTable {
  id: Generated<string>;
  tenant_id: string;
  register_id: string;
  session_id: string;
  z_number: bigint;
  business_date: string;
  status: 'draft' | 'issued';
  issued_at: Date | null;
  gross_pence: bigint;
  net_pence: bigint;
  vat_pence: bigint;
  discount_pence: bigint;
  refund_pence: bigint;
  cash_expected_pence: bigint | null;
  cash_counted_pence: bigint | null;
  cash_variance_pence: bigint | null;
  order_count: number;
  void_count: number;
  created_at: Generated<Date>;
}

export interface ZReportVatLinesTable {
  z_report_id: string;
  tax_rate_kind: 'standard' | 'reduced' | 'zero' | 'exempt';
  tax_rate_percent: string;
  gross_pence: bigint;
  vat_pence: bigint;
  net_pence: bigint;
  created_at: Generated<Date>;
}

export interface ZReportTenderLinesTable {
  z_report_id: string;
  tender_type: 'cash' | 'card' | 'store_credit' | 'gift_card' | 'loyalty_points';
  amount_pence: bigint;
  transaction_count: number;
  created_at: Generated<Date>;
}

export interface ZReportCorrectionsTable {
  id: Generated<string>;
  z_report_id: string;
  correction_type: string;
  amount_pence: bigint;
  reason: string;
  corrected_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface VatPeriodsTable {
  id: Generated<string>;
  tenant_id: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed' | 'exported';
  /** Set in place by closeVatPeriod(:id) (migration 014). */
  closed_at: Date | null;
  closed_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VatPeriodLinesTable {
  vat_period_id: string;
  tax_rate_kind: 'standard' | 'reduced' | 'zero' | 'exempt';
  tax_rate_percent: string;
  gross_pence: bigint;
  vat_pence: bigint;
  net_pence: bigint;
  created_at: Generated<Date>;
}

export interface VatReturnExportsTable {
  id: Generated<string>;
  tenant_id: string;
  vat_period_id: string;
  file_name: string;
  sha256_checksum: string;
  exported_by_user_id: string | null;
  exported_at: Generated<Date>;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 006_audit_export_gdpr — Arch-01 §2.7, §4, §6                      */
/* ------------------------------------------------------------------ */

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
  created_at: Generated<Date>;
}

export interface ExportJobsTable {
  id: Generated<string>;
  tenant_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  requested_by_user_id: string | null;
  file_count: number;
  total_rows: bigint;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface ExportManifestsTable {
  export_job_id: string;
  file_name: string;
  table_name: string;
  row_count: bigint;
  sha256_checksum: string;
  created_at: Generated<Date>;
}

export interface TenantExportWindowsTable {
  id: Generated<string>;
  tenant_id: string;
  window_started_at: Generated<Date>;
  window_ends_at: Date;
  status: 'open' | 'closed' | 'expired';
  created_at: Generated<Date>;
}

export interface DataRetentionPoliciesTable {
  id: Generated<string>;
  tenant_id: string;
  table_name: string;
  retention_days: number;
  archive_table: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeletionJobsTable {
  id: Generated<string>;
  tenant_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  requested_by_user_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  verified_row_count: number | null;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 007_phase2_crm_loyalty — Arch-09 §§2–5 (Phase 2, structural only)  */
/* ------------------------------------------------------------------ */

export interface CustomersTable {
  id: Generated<string>;
  tenant_id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MarketingConsentsTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  purpose: string;
  channel: string;
  consented: boolean;
  recorded_at: Generated<Date>;
  recorded_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface LoyaltyMembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  membership_number: string;
  status: 'active' | 'suspended' | 'closed';
  enrolled_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerGroupsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CustomerGroupMembershipsTable {
  customer_id: string;
  group_id: string;
  created_at: Generated<Date>;
}

export interface CustomerNotesTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  note: string;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface CustomerPurchaseSummariesTable {
  tenant_id: string;
  customer_id: string;
  total_orders: number;
  total_spend_pence: bigint;
  last_order_at: Date | null;
  computed_at: Generated<Date>;
}

export interface LoyaltyLedgerTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  membership_id: string;
  kind: 'earn' | 'redeem' | 'correction' | 'expiry';
  points: bigint;
  order_id: string | null;
  reason: string | null;
  idempotency_key: string;
  reverses_ledger_id: string | null;
  created_at: Generated<Date>;
}

export interface LoyaltyEarningRulesTable {
  id: Generated<string>;
  tenant_id: string;
  points_per_pound: string;
  category_multipliers: Record<string, unknown>;
  minimum_spend_pence: bigint;
  is_active: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoyaltyTiersTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  min_points: bigint;
  multiplier: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GiftCardsTable {
  id: Generated<string>;
  tenant_id: string;
  code_hash: string;
  code_last4: string;
  initial_amount_pence: bigint;
  balance_pence: bigint;
  currency: string;
  status: 'active' | 'redeemed' | 'expired' | 'void';
  issued_at: Generated<Date>;
  expires_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GiftCardLedgerTable {
  id: Generated<string>;
  tenant_id: string;
  gift_card_id: string;
  kind: 'issue' | 'redeem' | 'refund' | 'correction' | 'expiry';
  amount_pence: bigint;
  order_id: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
}

export interface StoreCreditLedgerTable {
  id: Generated<string>;
  tenant_id: string;
  customer_id: string;
  kind: 'issue' | 'redeem' | 'refund' | 'correction' | 'expiry';
  amount_pence: bigint;
  order_id: string | null;
  idempotency_key: string;
  created_at: Generated<Date>;
}

/* ------------------------------------------------------------------ */
/* 008_phase2_promotions — Arch-10 §§2–4 (Phase 2, structural only)   */
/* ------------------------------------------------------------------ */

export interface PriceBooksTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  priority: number;
  effective_from: Date;
  effective_to: Date | null;
  status: 'draft' | 'active' | 'expired';
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PriceBookEntriesTable {
  price_book_id: string;
  variant_id: string;
  price_pence: bigint;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PromotionsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  type: 'percentage' | 'fixed' | 'bogo' | 'multibuy' | 'bundle' | 'loyalty_bonus' | 'staff';
  status: 'draft' | 'active' | 'paused' | 'expired';
  version: number;
  stack_group: string | null;
  start_at: Date;
  end_at: Date | null;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PromotionConditionsTable {
  id: Generated<string>;
  promotion_id: string;
  condition_type: string;
  condition_value: Record<string, unknown>;
  created_at: Generated<Date>;
}

export interface PromotionTargetsTable {
  promotion_id: string;
  target_type: 'category' | 'product' | 'variant' | 'customer_group';
  target_id: string;
  created_at: Generated<Date>;
}

export interface AppliedPromotionsTable {
  id: Generated<string>;
  tenant_id: string;
  order_id: string;
  order_line_id: string | null;
  promotion_id: string;
  promotion_version: number;
  discount_pence: bigint;
  applied_by_user_id: string | null;
  voided: boolean;
  voided_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface VoucherCodesTable {
  id: Generated<string>;
  tenant_id: string;
  code_hash: string;
  code_last4: string;
  promotion_id: string | null;
  status: 'active' | 'redeemed' | 'void' | 'expired';
  max_uses: number;
  uses_count: number;
  valid_from: Generated<Date>;
  valid_to: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LoyaltyCampaignsTable {
  id: Generated<string>;
  tenant_id: string;
  promotion_id: string | null;
  name: string;
  points_multiplier: string;
  category_id: string | null;
  customer_group_id: string | null;
  start_at: Date;
  end_at: Date | null;
  status: 'draft' | 'active' | 'paused' | 'expired';
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** The full database: every table in migrations 001–008. */
export interface DB {
  migrations: MigrationsTable;
  tenants: TenantsTable;
  locations: LocationsTable;
  registers: RegistersTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  users: UsersTable;
  user_roles: UserRolesTable;
  user_locations: UserLocationsTable;
  categories: CategoriesTable;
  tax_rates: TaxRatesTable;
  products: ProductsTable;
  product_attributes: ProductAttributesTable;
  attribute_values: AttributeValuesTable;
  units_of_measure: UnitsOfMeasureTable;
  product_variants: ProductVariantsTable;
  variant_attribute_values: VariantAttributeValuesTable;
  variant_units: VariantUnitsTable;
  age_restrictions: AgeRestrictionsTable;
  serial_numbers: SerialNumbersTable;
  bundle_components: BundleComponentsTable;
  barcode_rules: BarcodeRulesTable;
  suppliers: SuppliersTable;
  supplier_variants: SupplierVariantsTable;
  warehouses: WarehousesTable;
  stock_balances: StockBalancesTable;
  stock_movements: StockMovementsTable;
  stock_counts: StockCountsTable;
  stock_count_lines: StockCountLinesTable;
  stock_transfers: StockTransfersTable;
  stock_transfer_lines: StockTransferLinesTable;
  reorder_points: ReorderPointsTable;
  purchase_order_suggestions: PurchaseOrderSuggestionsTable;
  purchase_orders: PurchaseOrdersTable;
  purchase_order_lines: PurchaseOrderLinesTable;
  goods_in_receipts: GoodsInReceiptsTable;
  goods_in_lines: GoodsInLinesTable;
  stock_valuation: StockValuationTable;
  orders: OrdersTable;
  order_lines: OrderLinesTable;
  payment_attempts: PaymentAttemptsTable;
  order_tenders: OrderTendersTable;
  refunds: RefundsTable;
  receipts: ReceiptsTable;
  receipt_vat_lines: ReceiptVatLinesTable;
  age_verification_events: AgeVerificationEventsTable;
  approval_events: ApprovalEventsTable;
  offline_payment_records: OfflinePaymentRecordsTable;
  register_sessions: RegisterSessionsTable;
  cash_movements: CashMovementsTable;
  z_reports: ZReportsTable;
  z_report_vat_lines: ZReportVatLinesTable;
  z_report_tender_lines: ZReportTenderLinesTable;
  z_report_corrections: ZReportCorrectionsTable;
  vat_periods: VatPeriodsTable;
  vat_period_lines: VatPeriodLinesTable;
  vat_return_exports: VatReturnExportsTable;
  audit_events: AuditEventsTable;
  export_jobs: ExportJobsTable;
  export_manifests: ExportManifestsTable;
  tenant_export_windows: TenantExportWindowsTable;
  data_retention_policies: DataRetentionPoliciesTable;
  deletion_jobs: DeletionJobsTable;
  customers: CustomersTable;
  marketing_consents: MarketingConsentsTable;
  loyalty_memberships: LoyaltyMembershipsTable;
  customer_groups: CustomerGroupsTable;
  customer_group_memberships: CustomerGroupMembershipsTable;
  customer_notes: CustomerNotesTable;
  customer_purchase_summaries: CustomerPurchaseSummariesTable;
  loyalty_ledger: LoyaltyLedgerTable;
  loyalty_earning_rules: LoyaltyEarningRulesTable;
  loyalty_tiers: LoyaltyTiersTable;
  gift_cards: GiftCardsTable;
  gift_card_ledger: GiftCardLedgerTable;
  store_credit_ledger: StoreCreditLedgerTable;
  price_books: PriceBooksTable;
  price_book_entries: PriceBookEntriesTable;
  promotions: PromotionsTable;
  promotion_conditions: PromotionConditionsTable;
  promotion_targets: PromotionTargetsTable;
  applied_promotions: AppliedPromotionsTable;
  voucher_codes: VoucherCodesTable;
  loyalty_campaigns: LoyaltyCampaignsTable;
  api_keys: ApiKeysTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_events: WebhookEventsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  statutory_vat_archives: StatutoryVatArchivesTable;
}

/* ------------------------------------------------------------------ */
/* 014_statutory_vat_archives_and_webhook_rotation — Build-05          */
/* ------------------------------------------------------------------ */

/**
 * Append-only 6-year statutory VAT archive (Arch-01 §6.4). tenant_id
 * carries NO foreign key on purpose: the archive must survive the
 * tenant row's hard deletion. Immutability is enforced by the
 * trg_statutory_vat_archives_immutable trigger (UPDATE always blocked;
 * DELETE only once NOW() >= retention_until, via
 * purge_expired_statutory_vat_archives()).
 */
export interface StatutoryVatArchivesTable {
  id: Generated<string>;
  tenant_id: string;
  archived_at: Generated<Date>;
  retention_until: Date;
  archive_sha256: string;
  row_counts_json: Record<string, unknown>;
  archive_payload_json: Record<string, unknown>;
  storage_bundle_path: string;
  created_at: Generated<Date>;
}
