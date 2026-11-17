/**
 * Admin Web Dashboard Shell — controller binding & page assembly
 * (Build-05 Objective 4, Worker D).
 *
 * BINDING NOTE: Build-04 shipped no `AdminWebApp` class — the back-office
 * is a set of controllers over one `AdminApiClient` (see src/index.ts).
 * This shell is the binding: `createAdminDashboardShell(api)` constructs
 * every controller from the one client and renders all six views from
 * them. If a controller lacks a hook the UI needs, the shell works around
 * it here and records the gap (see GAPS below) — it never edits a
 * controller.
 *
 * GAPS (workarounds in this layer, not controller edits):
 *  - G-UI-01 (RESOLVED Build-06 Obj 3): setPriceBookEntry /
 *    updatePriceBookEntry routes + client methods landed in Build-05;
 *    the shell now wires them directly (shell.setPriceBookEntry /
 *    shell.updatePriceBookEntry) — the catalogue studio has no such
 *    method, so the shell calls the typed client itself.
 *  - G-UI-02 (RESOLVED Build-06 Objective 4): no list/read method for VAT periods on
 *    FinanceConsole — the finance view loads by explicit id. The read
 *    route GET /v1/reporting/vat-periods/:id now exists (with the
 *    reporting.getVatPeriod route-table entry + typed client method),
 *    and the live shell wires it as the getVatPeriod resolver, so a
 *    closed period renders with its CLOSED badge in live mode.
 *  - G-UI-03 (RESOLVED Build-06 Obj 3): the statutory-archive route
 *    (compliance.listStatutoryArchives) and client method landed in
 *    Build-05; the shell now fetches live archive records when a
 *    tenant id is configured (ShellOptions.tenantId).
 *  - G-UI-04: no audit-event list ordering guarantee beyond created_at —
 *    the verifier reverses the newest-first listing into creation order,
 *    as IntegrityController already does.
 *  - G-UI-05: InventoryConsole exposes only in-transit transfers (no
 *    full transfer list) — the shell reads the full list from the client
 *    and in-transit rows from the console.
 *  - G-UI-06 (CLOSED Build-12 Objective 3 at the API + client
 *    level): the three missing operations now exist — PATCH
 *    /v1/catalogue/variants/:id (client.updateVariant, studio
 *    .updateVariant), POST /v1/inventory/purchase-orders (client
 *    .createPurchaseOrder, inventory console.createPurchaseOrder),
 *    and POST /v1/crm/customers/:id/groups (client
 *    .assignCustomerToGroup, CRM console.assignCustomerToGroup).
 *    The three route-table entries landed with Obj 4; the live
 *    client works end to end for these three calls (demo mode works
 *    fully). There is still no create-group
 *    route (groups are created server-side; the console only
 *    assigns members) and no standalone create-PO-from-suggestion
 *    variant beyond the existing accept path.
 *
 * Each view loader catches errors PER SECTION so one failing controller
 * renders an error box instead of killing the whole page. POST actions
 * surface API errors on the page via the `action` field (Build-06 Obj
 * 3) instead of crashing with a 500.
 */
import type { AdminApiClient } from '../api/client';
import { routeFor } from '../api/route-table';
import { CatalogueStudio, sanitiseVoucherViews } from '../catalogue/studio';
import { InventoryConsole } from '../inventory/console';
import { buildReceivingForm, ReceivingFormController, type ReceivingLine } from '../inventory/receiving-form';
import { CrmConsole, giftCardLiabilityPence, loyaltyBalancePence, storeCreditLiabilityPence } from '../crm/console';
import { CsvDownloadController } from '../finance/downloads';
import { ExitPortal, STATUTORY_ARCHIVE_TABLES, STATUTORY_VAT_ARCHIVE_YEARS } from '../finance/exit';
import { IntegrityController } from '../finance/integrity';
import { FinanceConsole } from '../finance/reporting';
import { WebhookConsole } from '../finance/webhooks';
import type {
  ActionResult,
  CatalogueViewData,
  CrmViewData,
  DashboardViewName,
  DataSource,
  ExitViewData,
  FinanceViewData,
  InventoryViewData,
  SectionError,
  StatutoryArchiveStatus,
  WebhooksViewData,
} from './types';
import type {
  IssuedVoucherCodeView,
  PriceBookEntryView,
  RotateWebhookSecretView,
  SettlementView,
  StatutoryArchiveView,
  SupplierView,
  VatPeriodView,
} from '../api/types';
import {
  renderCatalogueView,
  renderCrmView,
  renderExitView,
  renderFinanceView,
  renderHome,
  renderInventoryView,
  renderPage,
  renderWebhooksView,
} from './views';

export interface ShellOptions {
  /** 'demo' when the client is the seeded demo client; 'live' otherwise. */
  dataSource: DataSource;
  /** Default Z-report / VAT period ids pre-filled in the finance view (demo seed ids). */
  defaultZReportId?: string | null;
  defaultVatPeriodId?: string | null;
  /**
   * Tenant id for tenant-scoped reads that need it (statutory
   * archives). Demo: the demo tenant. Live: ADMIN_TENANT_ID from the
   * server environment; null when unconfigured (the exit portal then
   * says archives cannot be fetched without it).
   */
  tenantId?: string | null;
  /**
   * VAT-period read hook (G-UI-02 workaround). FinanceConsole has no
   * VAT-period getter — only closeVatPeriod — so the shell cannot read
   * a period through a controller. The demo server supplies a resolver
   * over the fake client's seed; with a live client this stays unset
   * and the finance view renders "VAT period unavailable" with the
   * reason instead of ever closing a period just to read it.
   */
  getVatPeriod?: (vatPeriodId: string) => Promise<VatPeriodView | null>;
}

export interface FinanceQuery {
  zReportId?: string | null;
  vatPeriodId?: string | null;
}

export interface CrmQuery {
  customerId?: string | null;
  /** Substring filter over name/email/phone (shell-side; no server search route exists). */
  searchQuery?: string | null;
}

/** Transient results of a POST action, threaded into the re-rendered view (never stored on the shell). */
export interface RenderExtra {
  vatPeriodJustClosed?: boolean;
  /** True when a VAT close was just attempted (success or fail): the finance loader must not report a spurious "no VAT read" error on top of the action result. */
  vatCloseAttempted?: boolean;
  closedVatPeriod?: VatPeriodView | null;
  settlement?: SettlementView | null;
  justIssuedCodes?: IssuedVoucherCodeView[] | null;
  justIssuedPromotionId?: string | null;
  justRotatedSecret?: RotateWebhookSecretView | null;
  exitActionMessage?: string | null;
  action?: ActionResult | null;
}

export function statutoryArchiveStatus(): StatutoryArchiveStatus {
  let routePresent = false;
  try {
    routeFor('compliance.listStatutoryArchives');
    routePresent = true;
  } catch {
    routePresent = false;
  }
  return {
    routePresent,
    routeKey: 'compliance.listStatutoryArchives',
    proposedRoute: 'GET /v1/compliance/statutory-archives/:tenantId',
    tables: STATUTORY_ARCHIVE_TABLES,
    retentionYears: STATUTORY_VAT_ARCHIVE_YEARS,
    note: 'Before tenant hard deletion the PII-stripped archive (vat_periods, vat_period_lines, z_reports, orders, order_lines, order_tenders, payment_attempts, refunds) is persisted to statutory_vat_archives and verified by SHA-256 before any tenant row is deleted.',
  };
}

export class AdminDashboardShell {
  readonly catalogue: CatalogueStudio;
  readonly inventory: InventoryConsole;
  readonly receiving: ReceivingFormController;
  readonly crm: CrmConsole;
  readonly finance: FinanceConsole;
  readonly downloads: CsvDownloadController;
  readonly webhooks: WebhookConsole;
  readonly integrity: IntegrityController;
  readonly exit: ExitPortal;
  private readonly options: ShellOptions;

  constructor(
    private readonly api: AdminApiClient,
    options: ShellOptions,
  ) {
    this.options = options;
    this.catalogue = new CatalogueStudio(api);
    this.inventory = new InventoryConsole(api);
    this.receiving = new ReceivingFormController(api);
    this.crm = new CrmConsole(api);
    this.finance = new FinanceConsole(api);
    this.downloads = new CsvDownloadController(api);
    this.webhooks = new WebhookConsole(api);
    this.integrity = new IntegrityController(api);
    this.exit = new ExitPortal(api);
  }

  get dataSource(): DataSource {
    return this.options.dataSource;
  }

  /** Run a loader, capturing its failure as a section error instead of throwing. */
  private async trySection<T>(errors: SectionError[], section: string, load: () => Promise<T>): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      errors.push({ section, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async loadCatalogueData(
    action: ActionResult | null = null,
    justIssued: { codes: IssuedVoucherCodeView[]; promotionId: string | null } | null = null,
  ): Promise<CatalogueViewData> {
    const errors: SectionError[] = [];
    const products = (await this.trySection(errors, 'Products', () => this.catalogue.listProducts())) ?? [];
    const variants = (await this.trySection(errors, 'Variants', () => this.catalogue.listVariants())) ?? [];
    const taxRates = (await this.trySection(errors, 'Tax rates', () => this.catalogue.listTaxRates())) ?? [];
    // Age restrictions (Build-12 Objective 2): listed so a rule can be
    // deleted from the studio. trySection keeps a live-mode failure
    // (e.g. a missing route-table entry) a section error, never a crash.
    const ageRestrictions =
      (await this.trySection(errors, 'Age restrictions', () => this.catalogue.listAgeRestrictions())) ?? [];
    const priceBooks = (await this.trySection(errors, 'Price books', () => this.catalogue.listPriceBooks())) ?? [];
    const promotions = (await this.trySection(errors, 'Promotions', () => this.catalogue.listPromotions())) ?? [];
    const rawVouchers = (await this.trySection(errors, 'Vouchers', () => this.catalogue.listVouchers())) ?? [];
    // Defence in depth: sanitise again at the shell boundary — any
    // full-code field in a payload is dropped and reported, never rendered.
    let vouchers: CatalogueViewData['vouchers'] = [];
    let droppedVoucherKeys: string[] = [];
    try {
      const clean = sanitiseVoucherViews(rawVouchers as unknown as Array<Record<string, unknown>>);
      vouchers = clean.vouchers;
      droppedVoucherKeys = clean.droppedKeys;
    } catch (error) {
      errors.push({ section: 'Vouchers', message: error instanceof Error ? error.message : String(error) });
    }
    return {
      dataSource: this.options.dataSource,
      products,
      variants,
      taxRates,
      ageRestrictions,
      priceBooks,
      promotions,
      vouchers,
      droppedVoucherKeys,
      justIssuedCodes: justIssued?.codes ?? [],
      justIssuedPromotionId: justIssued?.promotionId ?? null,
      action,
      errors,
    };
  }

  /**
   * Set a price-book entry (POST upsert). No CatalogueStudio method
   * exists for this, so the shell calls the typed client directly
   * (G-UI-01, resolved Build-06).
   */
  async setPriceBookEntry(priceBookId: string, variantId: string, pricePence: string): Promise<PriceBookEntryView> {
    if (!/^\d+$/.test(pricePence.trim())) {
      throw new Error('Price must be an integer number of pence (decimal string).');
    }
    return this.api.setPriceBookEntry(priceBookId, {
      price_book_id: priceBookId,
      variant_id: variantId,
      price_pence: pricePence.trim(),
    });
  }

  /** Update-only price-book entry (PUT; 404 when the entry was never set). */
  async updatePriceBookEntry(priceBookId: string, variantId: string, pricePence: string): Promise<PriceBookEntryView> {
    if (!/^\d+$/.test(pricePence.trim())) {
      throw new Error('Price must be an integer number of pence (decimal string).');
    }
    return this.api.updatePriceBookEntry(priceBookId, variantId, pricePence.trim());
  }

  /**
   * Bulk voucher generation, promotion-scoped when a promotion id is
   * given, unscoped otherwise. Returns the show-once result; the
   * caller must display the plaintext codes once and never store them.
   */
  async generateBulkVouchers(
    promotionId: string | null,
    input: { count: number; maxUses: number; validTo?: string | null },
  ): Promise<{ promotionId: string | null; issuedCodes: IssuedVoucherCodeView[] }> {
    if (promotionId !== null && promotionId !== '') {
      return this.api.generatePromotionVouchers(promotionId, input);
    }
    return this.api.generateVouchers({ promotionId: null, ...input });
  }

  /**
   * Rotate a webhook endpoint secret (POST). No WebhookConsole method
   * exists for this, so the shell calls the typed client directly.
   * The new secret is returned once — the caller displays it once and
   * never stores it.
   */
  async rotateWebhookSecret(endpointId: string, gracePeriodHours?: number): Promise<RotateWebhookSecretView> {
    return this.api.rotateWebhookSecret(endpointId, gracePeriodHours);
  }

  async loadInventoryData(action: ActionResult | null = null): Promise<InventoryViewData> {
    const errors: SectionError[] = [];
    const warehouses = (await this.trySection(errors, 'Warehouses', () => this.inventory.listWarehouses())) ?? [];
    // Suppliers (Build-10 Objective 2): loaded like every other
    // section — a missing route-table entry surfaces as a section
    // error until Obj 4 adds the entries, never a page crash.
    const suppliers = (await this.trySection(errors, 'Suppliers', () => this.inventory.listSuppliers())) ?? [];
    const stock = (await this.trySection(errors, 'Stock balances', () => this.inventory.stockBalances())) ?? [];
    // G-UI-05: InventoryConsole exposes only in-transit transfers (no
    // full transfer list), so the shell reads the full list from the
    // client and derives in-transit rows from the console.
    const transfers = (await this.trySection(errors, 'Transfers', () => this.api.listTransfers())) ?? [];
    const inTransitRows = (await this.trySection(errors, 'In-transit transfers', () => this.inventory.inTransitTransfers())) ?? [];
    const suggestions = (await this.trySection(errors, 'Reorder suggestions', () => this.inventory.listReorderSuggestions())) ?? [];
    const purchaseOrders = (await this.trySection(errors, 'Purchase orders', () => this.inventory.listPurchaseOrders())) ?? [];
    // Goods-in form: built from the first purchase order with lines so the
    // receiver works against a real order; every received quantity
    // defaults to '0' via buildReceivingForm (D-AW-05).
    const firstPoWithLines = purchaseOrders.find((po) => po.lines.length > 0);
    let goodsInLines: ReceivingLine[] = [];
    let goodsInPoId: string | null = null;
    let goodsInSupplierId: string | null = null;
    let goodsInLocationId: string | null = null;
    if (firstPoWithLines !== undefined) {
      goodsInLines = buildReceivingForm(
        firstPoWithLines.lines.map((l) => ({ variantId: l.variant_id, quantityOrdered: l.quantity_ordered, costPence: l.cost_pence })),
      );
      goodsInPoId = firstPoWithLines.id;
      goodsInSupplierId = firstPoWithLines.supplier_id;
      goodsInLocationId = firstPoWithLines.location_id;
    } else {
      // No PO to receive against: the manual goods-in form still needs
      // a location, so fall back to the default warehouse's location
      // (Build-07 Obj 3 — without this the manual form submitted the
      // handler's demo ids and 400d "Resource not found" in live mode).
      goodsInLocationId = warehouses[0]?.location_id ?? null;
    }
    return {
      dataSource: this.options.dataSource,
      warehouses,
      suppliers,
      stockBalances: stock,
      transfers,
      inTransit: inTransitRows.map((row) => row.transfer),
      reorderSuggestions: suggestions,
      purchaseOrders,
      goodsInLines,
      goodsInPoId,
      goodsInSupplierId,
      goodsInLocationId,
      goodsInWarehouseId: warehouses[0]?.id ?? null,
      action,
      errors,
    };
  }

  async loadCrmData(query: CrmQuery = {}, action: ActionResult | null = null): Promise<CrmViewData> {
    const errors: SectionError[] = [];
    const allCustomers = (await this.trySection(errors, 'Customers', () => this.crm.listCustomers())) ?? [];
    // Customer search is a shell-side filter: no server search route
    // exists, so the full directory is fetched via the typed client
    // and filtered here (name / email / phone, case-insensitive).
    const searchQuery = query.searchQuery?.trim() ?? null;
    const customers =
      searchQuery === null || searchQuery === ''
        ? allCustomers
        : allCustomers.filter((c) => {
            const haystack = `${c.first_name} ${c.last_name ?? ''} ${c.email ?? ''} ${c.phone ?? ''}`.toLowerCase();
            return haystack.includes(searchQuery.toLowerCase());
          });
    const selectedCustomerId = query.customerId ?? customers[0]?.id ?? null;
    let consents: CrmViewData['consents'] = [];
    let loyaltyEntries: CrmViewData['loyaltyEntries'] = [];
    let loyaltyBalancePoints = '0';
    let storeCreditOutstandingPence = '0';
    if (selectedCustomerId !== null) {
      const history = await this.trySection(errors, 'Consents', () => this.crm.consentHistory(selectedCustomerId));
      consents = history?.history ?? [];
      const ledger = await this.trySection(errors, 'Loyalty ledger', () => this.crm.loyaltyLedger(selectedCustomerId));
      loyaltyEntries = ledger?.entries ?? [];
      loyaltyBalancePoints = ledger?.balancePoints ?? loyaltyBalancePence(loyaltyEntries);
      const credit = await this.trySection(errors, 'Store credit', () => this.crm.storeCreditLiability(selectedCustomerId));
      storeCreditOutstandingPence = credit?.outstandingPence ?? storeCreditLiabilityPence([]);
    }
    const gift = (await this.trySection(errors, 'Gift cards', () => this.crm.giftCardLiabilities())) ?? null;
    return {
      dataSource: this.options.dataSource,
      customers,
      searchQuery,
      selectedCustomerId,
      consents,
      loyaltyEntries,
      loyaltyBalancePoints,
      giftCards: gift?.cards ?? [],
      giftCardOutstandingPence: gift?.outstandingPence ?? giftCardLiabilityPence([]),
      storeCreditOutstandingPence,
      action,
      errors,
    };
  }

  async loadFinanceData(
    query: FinanceQuery = {},
    extra: { vatPeriodJustClosed?: boolean; vatCloseAttempted?: boolean; closedVatPeriod?: VatPeriodView | null; settlement?: SettlementView | null; action?: ActionResult | null } = {},
  ): Promise<FinanceViewData> {
    const errors: SectionError[] = [];
    const zReportId = query.zReportId ?? this.options.defaultZReportId ?? null;
    const vatPeriodId = query.vatPeriodId ?? this.options.defaultVatPeriodId ?? null;
    const zReport =
      zReportId === null ? null : await this.trySection(errors, 'Z-report', () => this.finance.getZReport(zReportId));
    let vatPeriod: VatPeriodView | null = null;
    const vatPeriodJustClosed = extra.vatPeriodJustClosed ?? false;
    // A period closed by THIS request is carried through from the close
    // response (G-UI-02): the live client has no VAT-period read route,
    // so the re-render must not attempt a read — and must not report a
    // spurious "no read available" error after a successful close.
    // When a read resolver exists (demo mode), re-read the period:
    // after a close it now reports status 'closed'.
    if (extra.closedVatPeriod !== undefined && extra.closedVatPeriod !== null) {
      vatPeriod = extra.closedVatPeriod;
    } else if (vatPeriodId !== null) {
      if (this.options.getVatPeriod === undefined) {
        errors.push({
          section: 'VAT period',
          message:
            'No VAT-period read is available through the typed client (FinanceConsole has no VAT-period getter; only closeVatPeriod). Supply a VAT-period id to the close action, or wire a getVatPeriod resolver.',
        });
      } else {
        vatPeriod = await this.trySection(errors, 'VAT period', () => this.options.getVatPeriod!(vatPeriodId));
      }
    }
    return {
      dataSource: this.options.dataSource,
      zReportId,
      zReport,
      vatPeriodId,
      vatPeriod,
      vatPeriodJustClosed,
      closedVatPeriod: extra.closedVatPeriod ?? null,
      settlement: extra.settlement ?? null,
      action: extra.action ?? null,
      errors,
    };
  }

  async loadWebhooksData(
    action: ActionResult | null = null,
    justRotatedSecret: RotateWebhookSecretView | null = null,
  ): Promise<WebhooksViewData> {
    const errors: SectionError[] = [];
    const endpoints = (await this.trySection(errors, 'Webhook endpoints', () => this.webhooks.listEndpoints())) ?? [];
    const deadLetters = (await this.trySection(errors, 'Dead-letter queue', () => this.webhooks.deadLetterQueue())) ?? [];
    const chain = await this.trySection(errors, 'Audit hash-chain', () => this.integrity.verifyAuditChain({ limit: 200 }));
    // Audit events for the table: re-list newest-first then reverse into
    // creation order (same as IntegrityController).
    const eventsNewestFirst = (await this.trySection(errors, 'Audit events', () => this.api.listAuditEvents({ limit: 200 }))) ?? [];
    const auditEvents = [...eventsNewestFirst].reverse();
    return {
      dataSource: this.options.dataSource,
      endpoints,
      deadLetters,
      auditEvents,
      auditChain: chain,
      justRotatedSecret,
      action,
      errors,
    };
  }

  async loadExitData(actionMessage: string | null = null, action: ActionResult | null = null): Promise<ExitViewData> {
    const errors: SectionError[] = [];
    const portal = await this.trySection(errors, 'Exit status', () => this.exit.status());
    const exit = portal ?? null;
    // Live statutory archives (G-UI-03, resolved Build-06): fetched
    // through the typed client when a tenant id is configured.
    const tenantId = this.options.tenantId ?? null;
    let archives: StatutoryArchiveView[] = [];
    if (tenantId !== null && tenantId !== '') {
      archives = (await this.trySection(errors, 'Statutory archives', () => this.api.listStatutoryArchives(tenantId))) ?? [];
    }
    return {
      dataSource: this.options.dataSource,
      exit,
      blockers: {
        openSessionIds: exit?.blockers.openSessionIds ?? [],
        blockingPaymentAttemptIds: exit?.blockers.blockingPaymentAttemptIds ?? [],
      },
      statutoryArchive: statutoryArchiveStatus(),
      archives,
      actionMessage,
      action: action ?? (actionMessage === null ? null : { message: actionMessage, ok: true }),
      errors,
    };
  }

  async renderHomePage(): Promise<string> {
    return renderPage('Dashboard', 'home', renderHome(), this.options.dataSource);
  }

  async renderView(
    view: DashboardViewName,
    query: FinanceQuery & CrmQuery = {},
    extra: RenderExtra = {},
  ): Promise<string> {
    switch (view) {
      case 'catalogue':
        return renderPage(
          'Catalogue & Price-Book Studio',
          view,
          renderCatalogueView(
            await this.loadCatalogueData(
              extra.action ?? null,
              extra.justIssuedCodes === undefined || extra.justIssuedCodes === null
                ? null
                : { codes: extra.justIssuedCodes, promotionId: extra.justIssuedPromotionId ?? null },
            ),
          ),
          this.options.dataSource,
        );
      case 'inventory':
        return renderPage(
          'Inventory & Goods-In',
          view,
          renderInventoryView(await this.loadInventoryData(extra.action ?? null)),
          this.options.dataSource,
        );
      case 'crm':
        return renderPage('CRM / Loyalty & GDPR', view, renderCrmView(await this.loadCrmData(query, extra.action ?? null)), this.options.dataSource);
      case 'finance':
        return renderPage(
          'Finance / Z-Report / VAT',
          view,
          renderFinanceView(
            await this.loadFinanceData(query, {
              vatPeriodJustClosed: extra.vatPeriodJustClosed ?? false,
              vatCloseAttempted: extra.vatCloseAttempted ?? false,
              closedVatPeriod: extra.closedVatPeriod ?? null,
              settlement: extra.settlement ?? null,
              action: extra.action ?? null,
            }),
          ),
          this.options.dataSource,
        );
      case 'webhooks':
        return renderPage(
          'Webhooks DLQ & Audit Chain',
          view,
          renderWebhooksView(await this.loadWebhooksData(extra.action ?? null, extra.justRotatedSecret ?? null)),
          this.options.dataSource,
        );
      case 'exit':
        return renderPage(
          'Tenant Exit & Archive Portal',
          view,
          renderExitView(await this.loadExitData(extra.exitActionMessage ?? null, extra.action ?? null)),
          this.options.dataSource,
        );
    }
  }

  /** Close a VAT period (POST action) and report the result for re-rendering. */
  async closeVatPeriod(vatPeriodId: string): Promise<{ closed: boolean; message: string; period: VatPeriodView | null }> {
    try {
      const period = await this.finance.closeVatPeriod(vatPeriodId);
      return {
        closed: period.status === 'closed',
        message: `VAT period ${vatPeriodId} closed in place (status: ${period.status}). The same period ID was closed — no new period was created.`,
        period,
      };
    } catch (error) {
      return { closed: false, message: error instanceof Error ? error.message : String(error), period: null };
    }
  }
}

/** Build a dashboard shell bound to one API client (the AdminWebApp binding). */
export function createAdminDashboardShell(api: AdminApiClient, options: ShellOptions): AdminDashboardShell {
  return new AdminDashboardShell(api, options);
}
