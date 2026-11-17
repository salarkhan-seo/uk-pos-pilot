/**
 * Arch-02 §5.3 CSV column contracts, copied verbatim from
 * apps/api/src/modules/reporting/reporting.service.ts
 * (Z_REPORT_CSV_COLUMNS / VAT_PERIOD_CSV_COLUMNS) so the dashboard can
 * check a downloaded CSV's header against the contract without
 * re-fetching it. If the server contract changes, this copy must change
 * with it — the download controller's header check will fail loudly
 * rather than silently accept a drifted CSV.
 */
export const Z_REPORT_CSV_COLUMNS = [
  'z_number',
  'business_date',
  'location_id',
  'location_name',
  'register_id',
  'register_name',
  'tax_rate_name',
  'tax_rate_percent',
  'net_pence',
  'vat_pence',
  'gross_pence',
  'line_count',
  'tender_type',
  'tender_total_pence',
  'tender_count',
  'discount_total_pence',
  'refund_total_pence',
  'refund_count',
  'card_fee_estimate_pence',
  'cash_expected_pence',
  'cash_counted_pence',
  'cash_variance_pence',
  'variance_reason',
  'order_count',
  'void_count',
  'void_total_pence',
  'correction_total_pence',
  'correction_reason',
  'currency',
  'export_generated_at',
  'promotion_id',
  'promotion_name',
  'promotion_discount_pence',
] as const;

export const VAT_PERIOD_CSV_COLUMNS = [
  'vat_period_id',
  'period_start',
  'period_end',
  'tax_rate_name',
  'tax_rate_percent',
  'net_pence',
  'vat_pence',
  'gross_pence',
  'order_line_count',
  'refund_adjustment_pence',
  'currency',
  'export_generated_at',
] as const;
