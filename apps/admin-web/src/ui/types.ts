/**
 * Admin Web Dashboard Shell — shared view-data types (Build-05 Objective 4, Worker D).
 *
 * The shell is a thin rendering layer over the existing Build-04
 * controllers (CatalogueStudio, InventoryConsole, ReceivingFormController,
 * CrmConsole, FinanceConsole, CsvDownloadController, WebhookConsole,
 * IntegrityController, ExitPortal). It holds no business logic: pricing,
 * stock, VAT, settlement and exit decisions stay server-side; the shell
 * shapes requests and renders what the controllers return.
 *
 * HONEST-DATA RULE: every view carries a `dataSource` marker. Data that
 * came from the controllers/client is `live`; data that is only present
 * because the shell booted with the seeded demo client is `demo`. The
 * rendered page always shows which one applies, so demo rows can never
 * be mistaken for live state.
 */
import type {
  AgeRestrictionView,
  AuditEventView,
  CustomerView,
  ExitStatusView,
  GiftCardView,
  IssuedVoucherCodeView,
  LoyaltyLedgerEntryView,
  MarketingConsentView,
  PriceBookView,
  ProductView,
  PromotionView,
  PurchaseOrderView,
  ReorderSuggestionView,
  RotateWebhookSecretView,
  SettlementView,
  StatutoryArchiveView,
  StockLevelView,
  StockTransferView,
  SupplierView,
  TaxRateView,
  VatPeriodView,
  VariantView,
  VoucherView,
  WarehouseView,
  WebhookDeliveryView,
  WebhookEndpointView,
  ZReportSummaryView,
} from '../api/types';
import type { AuditChainReport } from '../finance/integrity';
import type { DeadLetterRow } from '../finance/webhooks';
import type { ExitPortalView } from '../finance/exit';
import type { ReceivingLine } from '../inventory/receiving-form';
import type { StockBalanceRow } from '../inventory/console';

export type DashboardViewName =
  | 'catalogue'
  | 'inventory'
  | 'crm'
  | 'finance'
  | 'webhooks'
  | 'exit';

export const DASHBOARD_VIEWS: ReadonlyArray<{ key: DashboardViewName; label: string; path: string }> = [
  { key: 'catalogue', label: 'Catalogue & Price-Book Studio', path: '/catalogue' },
  { key: 'inventory', label: 'Inventory & Goods-In', path: '/inventory' },
  { key: 'crm', label: 'CRM / Loyalty & GDPR', path: '/crm' },
  { key: 'finance', label: 'Finance / Z-Report / VAT', path: '/finance' },
  { key: 'webhooks', label: 'Webhooks DLQ & Audit Chain', path: '/webhooks' },
  { key: 'exit', label: 'Tenant Exit & Archive Portal', path: '/exit' },
];

/** Where a rendered section's rows came from. */
export type DataSource = 'live' | 'demo';

export interface SectionError {
  section: string;
  message: string;
}

/**
 * Result of a POST action, rendered once on the re-rendered view.
 * `ok: false` means the action failed — the message is the API error,
 * surfaced on the page instead of a 500 crash (Build-06 Obj 3).
 */
export interface ActionResult {
  message: string;
  ok: boolean;
}

export interface CatalogueViewData {
  dataSource: DataSource;
  /** Parent products (Build-09 Objective 1). */
  products: ProductView[];
  variants: VariantView[];
  /** Active tax rates for the variant-creation picker (Build-08 Objective 1). */
  taxRates: TaxRateView[];
  /** Age-restriction rules (Build-12 Objective 2): product-level rows have variant_id NULL. */
  ageRestrictions: AgeRestrictionView[];
  priceBooks: PriceBookView[];
  promotions: PromotionView[];
  /** Sanitised vouchers: code_last4 only, never a full code (D-AW-06). */
  vouchers: VoucherView[];
  /** Keys dropped by sanitisation, if any payload carried full-code material. */
  droppedVoucherKeys: string[];
  /** Bulk vouchers issued by THIS request only (show-once, Build-05/06). Never persisted; a later GET has []. */
  justIssuedCodes: IssuedVoucherCodeView[];
  /** Promotion the just-issued codes belong to (null = unscoped generation). */
  justIssuedPromotionId: string | null;
  action: ActionResult | null;
  errors: SectionError[];
}

export interface InventoryViewData {
  dataSource: DataSource;
  warehouses: WarehouseView[];
  /** Suppliers (Build-10 Objective 2). */
  suppliers: SupplierView[];
  stockBalances: StockBalanceRow[];
  transfers: StockTransferView[];
  inTransit: StockTransferView[];
  reorderSuggestions: ReorderSuggestionView[];
  purchaseOrders: PurchaseOrderView[];
  /** Goods-in form lines; every received quantity defaults to '0' (D-AW-05). */
  goodsInLines: ReceivingLine[];
  /** Purchase order the goods-in form was built from, if any. */
  goodsInPoId: string | null;
  goodsInSupplierId: string | null;
  goodsInLocationId: string | null;
  goodsInWarehouseId: string | null;
  action: ActionResult | null;
  errors: SectionError[];
}

export interface CrmViewData {
  dataSource: DataSource;
  customers: CustomerView[];
  /** Substring the customer list was filtered by (shell-side filter over listCustomers; no server search route exists). */
  searchQuery: string | null;
  selectedCustomerId: string | null;
  consents: MarketingConsentView[];
  loyaltyEntries: LoyaltyLedgerEntryView[];
  loyaltyBalancePoints: string;
  giftCards: GiftCardView[];
  giftCardOutstandingPence: string;
  storeCreditOutstandingPence: string;
  action: ActionResult | null;
  errors: SectionError[];
}

export interface FinanceViewData {
  dataSource: DataSource;
  zReportId: string | null;
  zReport: ZReportSummaryView | null;
  vatPeriodId: string | null;
  vatPeriod: VatPeriodView | null;
  /** True when the VAT period was closed by this shell session (POST). */
  vatPeriodJustClosed: boolean;
  /** Period returned by the close call itself (Build-06): the live client has no VAT-period read route, so the just-closed period is carried through from the close response instead of re-read. */
  closedVatPeriod: VatPeriodView | null;
  /** Last settlement reconciliation result (this request only). */
  settlement: SettlementView | null;
  action: ActionResult | null;
  errors: SectionError[];
}

export interface WebhooksViewData {
  dataSource: DataSource;
  endpoints: WebhookEndpointView[];
  deadLetters: DeadLetterRow[];
  auditEvents: AuditEventView[];
  auditChain: AuditChainReport | null;
  /** Secret returned by THIS request's rotation only (show-once, Build-05/06). Never persisted; a later GET has null. */
  justRotatedSecret: RotateWebhookSecretView | null;
  action: ActionResult | null;
  errors: SectionError[];
}

export interface StatutoryArchiveStatus {
  /**
   * Route key `compliance.listStatutoryArchives` (Build-05 Obj 2).
   * Present in the route table since Build-05; the shell fetches live
   * archive records through the typed client when a tenant id is
   * configured (ShellOptions.tenantId). Without a tenant id the portal
   * shows the requirement and retention only.
   */
  routePresent: boolean;
  routeKey: string;
  proposedRoute: string;
  /** Tables the statutory archive must cover (exit.ts STATUTORY_ARCHIVE_TABLES). */
  tables: readonly string[];
  retentionYears: number;
  note: string;
}

export interface ExitViewData {
  dataSource: DataSource;
  exit: ExitPortalView | null;
  /** D-11 blockers surfaced verbatim, exactly as the server reports them. */
  blockers: { openSessionIds: string[]; blockingPaymentAttemptIds: string[] };
  statutoryArchive: StatutoryArchiveStatus;
  /** Persisted 6-year statutory VAT archives for this tenant (live fetch via the typed client; [] when none stored or no tenant id configured). */
  archives: StatutoryArchiveView[];
  /** Last exit action result / error, for rendering after a POST. */
  actionMessage: string | null;
  action: ActionResult | null;
  errors: SectionError[];
}

export type DashboardViewData =
  | { view: 'catalogue'; data: CatalogueViewData }
  | { view: 'inventory'; data: InventoryViewData }
  | { view: 'crm'; data: CrmViewData }
  | { view: 'finance'; data: FinanceViewData }
  | { view: 'webhooks'; data: WebhooksViewData }
  | { view: 'exit'; data: ExitViewData };
