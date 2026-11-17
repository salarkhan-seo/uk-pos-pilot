/**
 * Typed API client for apps/api (Build-04 Objective 2).
 *
 * DESIGN DECISIONS:
 *  - D-AW-02: one client, two auth kinds. The caller supplies either a
 *    scoped API key (`ukp_…`) or a PIN-session token; both travel as
 *    `Authorization: Bearer <token>` (or `X-Api-Key` for keys). The
 *    client never invents credentials and never falls back to demo
 *    headers on its own — demo actor headers are an explicit opt-in
 *    (`demoActor`) for the Build-02 routes that still use them.
 *  - D-AW-03: every method is backed by the route table. A method whose
 *    route is not live throws NotExposedError (service method + proposed
 *    route) instead of calling a guessed URL. The fake client implements
 *    the same interface in memory, so consoles and tests never depend on
 *    a live server and never call a route that does not exist.
 *  - The client does NO business logic: pricing, stock, VAT, settlement
 *    and exit decisions are the server's. It maps wire shapes to typed
 *    views and errors only.
 */
import { NotExposedError } from './errors';
import { fetchTransport, requestJson, type DemoActorHeaders, type HttpTransport } from './http';
import { fillPath, routeFor } from './route-table';
import type {
  AgeRestrictionView,
  ApiCredentials,
  ApiKeyCreatedView,
  ApiKeyView,
  ApprovalInput,
  AuditEventView,
  BalanceView,
  CountLineInput,
  CreateAgeRestrictionInput,
  CreateProductInput,
  CreatePurchaseOrderInput,
  CreateSupplierInput,
  CreateVariantInput,
  CreateWarehouseInput,
  CustomerExportView,
  CustomerGroupMembershipView,
  CustomerView,
  DeleteAgeRestrictionResult,
  ErasureResultView,
  ExitStatusView,
  ExportResultView,
  GiftCardView,
  GoodsInInput,
  GeneratePromotionVouchersResult,
  GenerateVouchersResult,
  ListEventsFilters,
  ListEventsResultView,
  LinkSupplierVariantInput,
  LoyaltyLedgerEntryView,
  MarketingConsentView,
  PinLoginInput,
  PinLoginResult,
  PriceBasketInput,
  PriceBasketView,
  PriceBookEntryView,
  PriceBookView,
  ProductView,
  PromotionView,
  PurchaseOrderView,
  ReceiptView,
  ReorderSuggestionView,
  RotateWebhookSecretView,
  SettlementView,
  StatutoryArchiveView,
  StatusView,
  StockLevelView,
  StockTransferView,
  SupplierVariantView,
  SupplierView,
  TaxRateView,
  ValuationSummaryView,
  VatPeriodView,
  VariantView,
  VoucherView,
  WarehouseView,
  UpdateVariantInput,
  WebhookDeliveryView,
  WebhookEndpointView,
  ZReportSummaryView,
} from './types';

export interface ClientOptions {
  baseUrl: string;
  credentials: ApiCredentials;
  /** Explicit opt-in demo actor headers for the Build-02 routes. */
  demoActor?: DemoActorHeaders;
  transport?: HttpTransport;
}

/**
 * Full dashboard API surface. Live methods hit apps/api; methods whose
 * route is not exposed yet are implemented by the fake client and throw
 * NotExposedError on the live client (see route-table.ts).
 */
export interface AdminApiClient {
  // status
  getStatus(module: 'admin' | 'catalogue' | 'inventory' | 'sales' | 'payments' | 'reporting' | 'integrations'): Promise<StatusView>;
  // auth (Build-05: typed pinLogin; the endpoint is unguarded — it IS the login)
  pinLogin(input: PinLoginInput): Promise<PinLoginResult>;
  // admin
  listAuditEvents(opts?: { limit?: number; eventType?: string }): Promise<AuditEventView[]>;
  createApproval(input: ApprovalInput): Promise<Record<string, unknown>>;
  // api keys
  listApiKeys(): Promise<ApiKeyView[]>;
  createApiKey(input: { name?: string | null; scopes: string[]; expiresAt?: string | null }): Promise<ApiKeyCreatedView>;
  rotateApiKey(keyId: string): Promise<ApiKeyCreatedView>;
  revokeApiKey(keyId: string): Promise<{ id: string; status: string }>;
  // catalogue
  createVariant(input: CreateVariantInput): Promise<VariantView>;
  listVariants(filters?: { productId?: string; categoryId?: string }): Promise<VariantView[]>;
  /**
   * Update a variant in place (Build-12 Objective 3). The
   * route-table entry landed with Obj 4; the live client works end
   * to end. The demo client implements it in memory.
   */
  updateVariant(id: string, input: UpdateVariantInput): Promise<VariantView>;
  /** Active tax rates for the variant-creation picker (Build-08 Objective 1). */
  listTaxRates(): Promise<TaxRateView[]>;
  /** Parent products (Build-09 Objective 1). */
  createProduct(input: CreateProductInput): Promise<ProductView>;
  listProducts(filters?: { categoryId?: string }): Promise<ProductView[]>;
  getProduct(productId: string): Promise<ProductView>;
  /** Age-restriction rules (Build-09 Objective 1). createAgeRestriction always returns an array. */
  createAgeRestriction(input: CreateAgeRestrictionInput): Promise<AgeRestrictionView[]>;
  listAgeRestrictions(filters?: { variantId?: string; productId?: string }): Promise<AgeRestrictionView[]>;
  /**
   * Delete one age-restriction rule (Build-12 Objective 2). The
   * route-table entry landed with Obj 4; the live client works end
   * to end. The demo client implements it in memory.
   */
  deleteAgeRestriction(id: string): Promise<DeleteAgeRestrictionResult>;
  priceBasket(input: PriceBasketInput): Promise<PriceBasketView>;
  parseBarcode(code: string, requestedMode?: 'ean13' | 'upca' | 'embedded-price' | 'embedded-weight'): Promise<{ sku: string; pricePence: string | null; weightGrams: string | null }>;
  // inventory
  startCount(input: { locationId: string; warehouseId?: string | null }): Promise<{ id: string; status: string }>;
  setCountedQuantity(countId: string, line: CountLineInput): Promise<{ countId: string; variantId: string; expectedQuantity: string; countedQuantity: string | null }>;
  submitCount(countId: string): Promise<{ adjustments: Array<{ variantId: string; variance: string }> }>;
  receiveGoodsIn(input: GoodsInInput): Promise<{ receiptId: string }>;
  getStock(filters?: { variantId?: string; warehouseId?: string }): Promise<StockLevelView[]>;
  /** Balances + valuation (Build-11 Objective 1). Route-table entries land with Obj 4. */
  getBalances(filters?: { variantId?: string; warehouseId?: string }): Promise<BalanceView[]>;
  getValuation(filters?: { variantId?: string; warehouseId?: string }): Promise<ValuationSummaryView>;
  // sales
  getReceipt(orderId: string): Promise<ReceiptView>;
  voidOrder(orderId: string, input?: { reason?: string; approvalEventsId?: string | null }): Promise<{ orderId: string; status: string }>;
  // events
  listEvents(filters?: ListEventsFilters): Promise<ListEventsResultView>;
  // --- live over HTTP (Build-04 wired the routes; Build-05 wired the rest) ---
  listPriceBooks(): Promise<PriceBookView[]>;
  createPriceBook(input: { name: string; priority: number; effectiveFrom: string; effectiveTo?: string | null }): Promise<PriceBookView>;
  setPriceBookEntry(priceBookId: string, entry: PriceBookEntryView): Promise<PriceBookEntryView>;
  updatePriceBookEntry(priceBookId: string, variantId: string, pricePence: string): Promise<PriceBookEntryView>;
  listPromotions(): Promise<PromotionView[]>;
  createPromotion(input: { name: string; type: PromotionView['type']; startAt: string; endAt?: string | null }): Promise<PromotionView>;
  generateVouchers(input: { promotionId: string | null; count: number; maxUses: number; validTo?: string | null }): Promise<GenerateVouchersResult>;
  generatePromotionVouchers(promotionId: string, input: { count: number; maxUses: number; validTo?: string | null }): Promise<GeneratePromotionVouchersResult>;
  listVouchers(): Promise<VoucherView[]>;
  listWarehouses(): Promise<WarehouseView[]>;
  /** Create a warehouse (Build-10 Objective 2). Route-table entry landed with Build-10 Obj 4. */
  createWarehouse(input: CreateWarehouseInput): Promise<WarehouseView>;
  getWarehouse(warehouseId: string): Promise<WarehouseView>;
  /** Suppliers (Build-10 Objective 2). Route-table entries land with Obj 4. */
  createSupplier(input: CreateSupplierInput): Promise<SupplierView>;
  listSuppliers(): Promise<SupplierView[]>;
  getSupplier(supplierId: string): Promise<SupplierView>;
  linkSupplierVariant(supplierId: string, input: LinkSupplierVariantInput): Promise<SupplierVariantView>;
  listTransfers(): Promise<StockTransferView[]>;
  createTransfer(input: { fromWarehouseId: string; toWarehouseId: string; lines: Array<{ variantId: string; quantity: string }> }): Promise<StockTransferView>;
  listReorderSuggestions(): Promise<ReorderSuggestionView[]>;
  acceptReorderSuggestion(suggestionId: string): Promise<PurchaseOrderView>;
  dismissReorderSuggestion(suggestionId: string, reason: string): Promise<ReorderSuggestionView>;
  listPurchaseOrders(): Promise<PurchaseOrderView[]>;
  sendPurchaseOrder(poId: string): Promise<PurchaseOrderView>;
  /**
   * Create a standalone DRAFT purchase order (Build-12 Objective 3).
   * The route-table entry landed with Obj 4; the live client works
   * end to end. The demo client implements it in memory.
   */
  createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrderView>;
  listCustomers(): Promise<CustomerView[]>;
  /**
   * Assign a customer to a manual customer group (Build-12
   * Objective 3). Idempotent: a repeat call returns the existing
   * membership. The route-table entry landed with Obj 4; the live
   * client works end to end. The demo client implements it in memory.
   */
  assignCustomerToGroup(customerId: string, groupId: string): Promise<CustomerGroupMembershipView>;
  listConsents(customerId: string): Promise<MarketingConsentView[]>;
  listLoyaltyLedger(customerId: string): Promise<LoyaltyLedgerEntryView[]>;
  listGiftCards(): Promise<GiftCardView[]>;
  listStoreCredit(customerId: string): Promise<Array<{ kind: string; amount_pence: string; created_at: string }>>;
  exportCustomer(customerId: string): Promise<CustomerExportView>;
  eraseCustomer(customerId: string): Promise<ErasureResultView>;
  getZReport(zReportId: string): Promise<ZReportSummaryView>;
  recordZReportCorrection(zReportId: string, input: { correctionType: string; amountPence: string; reason: string; approvalEventId: string }): Promise<{ id: string }>;
  closeVatPeriod(vatPeriodId: string): Promise<VatPeriodView>;
  getVatPeriod(vatPeriodId: string): Promise<VatPeriodView>;
  exportZReportCsv(zReportId: string): Promise<string>;
  exportVatPeriodCsv(vatPeriodId: string): Promise<string>;
  reconcileSettlement(input: { businessDate: string; payouts: Array<{ providerReference: string; settlementDate: string; grossPence: string; feePence: string; reserveHoldPence: string; disputeDebitPence: string }> }): Promise<SettlementView>;
  listWebhookEndpoints(): Promise<WebhookEndpointView[]>;
  registerWebhookEndpoint(input: { url: string; eventTypes: string[] }): Promise<{ endpoint: WebhookEndpointView; secret: string }>;
  rotateWebhookSecret(endpointId: string, gracePeriodHours?: number): Promise<RotateWebhookSecretView>;
  replayDeadLetter(deliveryId: string): Promise<{ id: string; status: string }>;
  discardDeadLetter(deliveryId: string): Promise<{ id: string; status: string }>;
  listStatutoryArchives(tenantId: string): Promise<StatutoryArchiveView[]>;
  getExitStatus(): Promise<ExitStatusView>;
  requestTermination(): Promise<ExitStatusView>;
  beginExportWindow(): Promise<ExitStatusView>;
  runFullExport(): Promise<ExportResultView>;
  scheduleHardDelete(): Promise<ExitStatusView>;
}

export class PosApiClient implements AdminApiClient {
  private readonly baseUrl: string;
  private readonly credentials: ApiCredentials;
  private readonly demoActor?: DemoActorHeaders;
  private readonly transport: HttpTransport;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.credentials = options.credentials;
    this.demoActor = options.demoActor;
    this.transport = options.transport ?? fetchTransport;
  }

  /** Route availability, for consoles that must render "not yet exposed" states. */
  routeAvailability(routeKey: string): { live: boolean; serviceMethod?: string; proposedRoute: string } {
    const route = routeFor(routeKey);
    return { live: route.live, serviceMethod: route.serviceMethod, proposedRoute: `${route.method} ${route.path}` };
  }

  private async call<T>(routeKey: string, opts: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const route = routeFor(routeKey);
    if (!route.live) {
      throw new NotExposedError(route.serviceMethod ?? route.key, `${route.method} ${route.path}`);
    }
    return requestJson<T>(this.transport, this.credentials, this.baseUrl, {
      method: route.method,
      path: fillPath(route.path, opts.params ?? {}),
      query: opts.query,
      body: opts.body,
    }, this.demoActor);
  }

  async getStatus(module: 'admin' | 'catalogue' | 'inventory' | 'sales' | 'payments' | 'reporting' | 'integrations'): Promise<StatusView> {
    return this.call<StatusView>(`${module}.status`);
  }

  async pinLogin(input: PinLoginInput): Promise<PinLoginResult> {
    // The endpoint is unguarded (it IS the login): the server ignores
    // whatever credential this client was constructed with. The
    // caller swaps the returned token in as the client's credential
    // for subsequent calls. Malformed ids are 400, never 500.
    return this.call<PinLoginResult>('auth.pinLogin', { body: input });
  }

  async listAuditEvents(opts: { limit?: number; eventType?: string } = {}): Promise<AuditEventView[]> {
    return this.call<AuditEventView[]>('audit.list', {
      query: {
        limit: opts.limit === undefined ? undefined : String(opts.limit),
        eventType: opts.eventType,
      },
    });
  }

  async createApproval(input: ApprovalInput): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('approvals.create', { body: input });
  }

  async listApiKeys(): Promise<ApiKeyView[]> {
    return this.call<ApiKeyView[]>('apiKeys.list');
  }

  async createApiKey(input: { name?: string | null; scopes: string[]; expiresAt?: string | null }): Promise<ApiKeyCreatedView> {
    return this.call<ApiKeyCreatedView>('apiKeys.create', { body: input });
  }

  async rotateApiKey(keyId: string): Promise<ApiKeyCreatedView> {
    return this.call<ApiKeyCreatedView>('apiKeys.rotate', { params: { id: keyId } });
  }

  async revokeApiKey(keyId: string): Promise<{ id: string; status: string }> {
    return this.call<{ id: string; status: string }>('apiKeys.revoke', { params: { id: keyId } });
  }

  async createVariant(input: CreateVariantInput): Promise<VariantView> {
    return this.call<VariantView>('catalogue.createVariant', { body: input });
  }

  async updateVariant(id: string, input: UpdateVariantInput): Promise<VariantView> {
    return this.call<VariantView>('catalogue.updateVariant', { params: { id }, body: input });
  }

  async listVariants(filters: { productId?: string; categoryId?: string } = {}): Promise<VariantView[]> {
    return this.call<VariantView[]>('catalogue.listVariants', { query: filters });
  }

  async listTaxRates(): Promise<TaxRateView[]> {
    return this.call<TaxRateView[]>('catalogue.listTaxRates');
  }

  async createProduct(input: CreateProductInput): Promise<ProductView> {
    return this.call<ProductView>('catalogue.createProduct', { body: input });
  }

  async listProducts(filters: { categoryId?: string } = {}): Promise<ProductView[]> {
    return this.call<ProductView[]>('catalogue.listProducts', { query: filters });
  }

  async getProduct(productId: string): Promise<ProductView> {
    return this.call<ProductView>('catalogue.getProduct', { params: { id: productId } });
  }

  async createAgeRestriction(input: CreateAgeRestrictionInput): Promise<AgeRestrictionView[]> {
    return this.call<AgeRestrictionView[]>('catalogue.createAgeRestriction', { body: input });
  }

  async listAgeRestrictions(
    filters: { variantId?: string; productId?: string } = {},
  ): Promise<AgeRestrictionView[]> {
    return this.call<AgeRestrictionView[]>('catalogue.listAgeRestrictions', { query: filters });
  }

  async deleteAgeRestriction(id: string): Promise<DeleteAgeRestrictionResult> {
    return this.call<DeleteAgeRestrictionResult>('catalogue.deleteAgeRestriction', {
      params: { id },
    });
  }

  async priceBasket(input: PriceBasketInput): Promise<PriceBasketView> {
    return this.call<PriceBasketView>('catalogue.priceBasket', { body: input });
  }

  async parseBarcode(code: string, requestedMode?: 'ean13' | 'upca' | 'embedded-price' | 'embedded-weight'): Promise<{ sku: string; pricePence: string | null; weightGrams: string | null }> {
    return this.call('catalogue.parseBarcode', { body: { code, requestedMode } });
  }

  async startCount(input: { locationId: string; warehouseId?: string | null }): Promise<{ id: string; status: string }> {
    return this.call('inventory.startCount', { body: input });
  }

  async setCountedQuantity(countId: string, line: CountLineInput): Promise<{ countId: string; variantId: string; expectedQuantity: string; countedQuantity: string | null }> {
    return this.call('inventory.setCountedQuantity', { params: { id: countId }, body: line });
  }

  async submitCount(countId: string): Promise<{ adjustments: Array<{ variantId: string; variance: string }> }> {
    return this.call('inventory.submitCount', { params: { id: countId } });
  }

  async receiveGoodsIn(input: GoodsInInput): Promise<{ receiptId: string }> {
    return this.call('inventory.receiveGoodsIn', { body: input });
  }

  async getStock(filters: { variantId?: string; warehouseId?: string } = {}): Promise<StockLevelView[]> {
    const res = await this.call<{ stock: Array<{ variantId: string; warehouseId: string; quantityOnHand: string }> }>('inventory.getStock', { query: filters });
    return res.stock.map((level) => ({ ...level, computedAt: null }));
  }

  async getBalances(filters: { variantId?: string; warehouseId?: string } = {}): Promise<BalanceView[]> {
    const res = await this.call<{
      balances: Array<{
        variant_id: string;
        warehouse_id: string;
        quantity_on_hand: string;
        weighted_avg_cost_pence: string | null;
        total_value_pence: string | null;
        computed_at: string;
      }>;
    }>('inventory.getBalances', { query: filters });
    return res.balances.map((row) => ({
      variantId: row.variant_id,
      warehouseId: row.warehouse_id,
      quantityOnHand: row.quantity_on_hand,
      weightedAvgCostPence: row.weighted_avg_cost_pence,
      totalValuePence: row.total_value_pence,
      computedAt: row.computed_at,
    }));
  }

  async getValuation(filters: { variantId?: string; warehouseId?: string } = {}): Promise<ValuationSummaryView> {
    const res = await this.call<{
      valuation: Array<{
        variant_id: string;
        total_quantity_on_hand: string;
        weighted_avg_cost_pence: string | null;
        total_value_pence: string | null;
      }>;
      totals: { total_quantity_on_hand: string; total_value_pence: string | null };
    }>('inventory.getValuation', { query: filters });
    return {
      valuation: res.valuation.map((row) => ({
        variantId: row.variant_id,
        totalQuantityOnHand: row.total_quantity_on_hand,
        weightedAvgCostPence: row.weighted_avg_cost_pence,
        totalValuePence: row.total_value_pence,
      })),
      totals: {
        totalQuantityOnHand: res.totals.total_quantity_on_hand,
        totalValuePence: res.totals.total_value_pence,
      },
    };
  }

  async getReceipt(orderId: string): Promise<ReceiptView> {
    return this.call<ReceiptView>('sales.getReceipt', { params: { id: orderId } });
  }

  async voidOrder(orderId: string, input: { reason?: string; approvalEventsId?: string | null } = {}): Promise<{ orderId: string; status: string }> {
    return this.call('sales.voidOrder', { params: { id: orderId }, body: input });
  }

  async listEvents(filters: ListEventsFilters = {}): Promise<ListEventsResultView> {
    const res = await this.call<{
      events: Array<{
        id: string; tenant_id: string; event_type: string; sequence: bigint | string;
        payload: Record<string, unknown>; created_at: string | Date;
        deliveries: Array<Record<string, unknown>>;
      }>;
      nextCursor: string | null;
    }>('events.list', {
      query: {
        event_type: filters.eventType,
        created_after: filters.createdAfter,
        delivery_status: filters.deliveryStatus,
        limit: filters.limit === undefined ? undefined : String(filters.limit),
        cursor: filters.cursor ?? undefined,
      },
    });
    // Normalise bigint sequence + Date created_at to the JSON wire shape.
    return {
      events: res.events.map((event) => ({
        id: event.id,
        tenant_id: event.tenant_id,
        event_type: event.event_type,
        sequence: String(event.sequence),
        payload: event.payload,
        created_at: event.created_at instanceof Date ? event.created_at.toISOString() : String(event.created_at),
        deliveries: (event.deliveries as unknown as WebhookDeliveryView[]).map((d) => ({
          ...d,
          next_attempt_at: d.next_attempt_at === null || d.next_attempt_at === undefined ? null : String(d.next_attempt_at),
          created_at: String(d.created_at),
        })),
      })),
      nextCursor: res.nextCursor,
    };
  }

  // --- Live over HTTP (Build-04 wired the routes; Build-05 wired the
  // rest: setPriceBookEntry / updatePriceBookEntry, promotion-scoped
  // bulk vouchers, webhook rotation, statutory archives). The fake
  // client still implements the same interface in memory for consoles
  // and tests that never depend on a live server. ---
  async listPriceBooks(): Promise<PriceBookView[]> { return this.call<PriceBookView[]>('catalogue.listPriceBooks'); }
  async createPriceBook(input: { name: string; priority: number; effectiveFrom: string; effectiveTo?: string | null }): Promise<PriceBookView> { return this.call<PriceBookView>('catalogue.createPriceBook', { body: input }); }
  async setPriceBookEntry(priceBookId: string, entry: PriceBookEntryView): Promise<PriceBookEntryView> {
    // Wire shape is camelCase in the body ({ variantId, pricePence });
    // the response is the snake_case entry view.
    return this.call<PriceBookEntryView>('catalogue.setPriceBookEntry', {
      params: { id: priceBookId },
      body: { variantId: entry.variant_id, pricePence: entry.price_pence },
    });
  }
  async updatePriceBookEntry(priceBookId: string, variantId: string, pricePence: string): Promise<PriceBookEntryView> {
    return this.call<PriceBookEntryView>('catalogue.updatePriceBookEntry', {
      params: { id: priceBookId, variantId },
      body: { pricePence },
    });
  }
  async listPromotions(): Promise<PromotionView[]> { return this.call<PromotionView[]>('catalogue.listPromotions'); }
  async createPromotion(input: { name: string; type: PromotionView['type']; startAt: string; endAt?: string | null }): Promise<PromotionView> { return this.call<PromotionView>('catalogue.createPromotion', { body: input }); }
  async generateVouchers(input: { promotionId: string | null; count: number; maxUses: number; validTo?: string | null }): Promise<GenerateVouchersResult> {
    // Show-once (Build-05 fix): the live route returns { issued_codes }
    // only — NOT VoucherView[]. The wire carries no promotion_id, so the
    // promotion comes from the request input. Map to camelCase; callers
    // must display the plaintext codes once and never store or log them.
    const res = await this.call<{
      issued_codes: Array<{ id: string; code: string; code_last4: string; expires_at: string | null }>;
    }>('catalogue.generateVouchers', { body: input });
    return {
      promotionId: input.promotionId,
      issuedCodes: res.issued_codes.map((issued) => ({
        id: issued.id,
        code: issued.code,
        code_last4: issued.code_last4,
        expires_at: issued.expires_at,
      })),
    };
  }
  async generatePromotionVouchers(promotionId: string, input: { count: number; maxUses: number; validTo?: string | null }): Promise<GeneratePromotionVouchersResult> {
    // Show-once (Build-05): the wire shape is { promotion_id,
    // issued_codes: [{ id, code, code_last4, expires_at }] } — the
    // plaintext codes exist only in this response. Map to camelCase;
    // callers must display them once and never store or log them.
    const res = await this.call<{
      promotion_id: string;
      issued_codes: Array<{ id: string; code: string; code_last4: string; expires_at: string | null }>;
    }>('catalogue.generatePromotionVouchers', { params: { id: promotionId }, body: input });
    return {
      promotionId: res.promotion_id,
      issuedCodes: res.issued_codes.map((issued) => ({
        id: issued.id,
        code: issued.code,
        code_last4: issued.code_last4,
        expires_at: issued.expires_at,
      })),
    };
  }
  async listVouchers(): Promise<VoucherView[]> { return this.call<VoucherView[]>('catalogue.listVouchers'); }
  async listWarehouses(): Promise<WarehouseView[]> { return this.call<WarehouseView[]>('inventory.listWarehouses'); }
  /** Create a warehouse (Build-10 Objective 2). Route-table entry landed with Build-10 Obj 4. */
  async createWarehouse(input: CreateWarehouseInput): Promise<WarehouseView> { return this.call<WarehouseView>('inventory.createWarehouse', { body: input }); }
  async getWarehouse(warehouseId: string): Promise<WarehouseView> { return this.call<WarehouseView>('inventory.getWarehouse', { params: { id: warehouseId } }); }
  /** Suppliers (Build-10 Objective 2). Route-table entries landed with Build-10 Obj 4. */
  async createSupplier(input: CreateSupplierInput): Promise<SupplierView> { return this.call<SupplierView>('purchasing.createSupplier', { body: input }); }
  async listSuppliers(): Promise<SupplierView[]> { return this.call<SupplierView[]>('purchasing.listSuppliers'); }
  async getSupplier(supplierId: string): Promise<SupplierView> { return this.call<SupplierView>('purchasing.getSupplier', { params: { id: supplierId } }); }
  async linkSupplierVariant(supplierId: string, input: LinkSupplierVariantInput): Promise<SupplierVariantView> { return this.call<SupplierVariantView>('purchasing.linkSupplierVariant', { params: { id: supplierId }, body: input }); }
  async listTransfers(): Promise<StockTransferView[]> { return this.call<StockTransferView[]>('inventory.listTransfers'); }
  async createTransfer(input: { fromWarehouseId: string; toWarehouseId: string; lines: Array<{ variantId: string; quantity: string }> }): Promise<StockTransferView> { return this.call<StockTransferView>('inventory.createTransfer', { body: input }); }
  async listReorderSuggestions(): Promise<ReorderSuggestionView[]> { return this.call<ReorderSuggestionView[]>('inventory.listReorderSuggestions'); }
  async acceptReorderSuggestion(suggestionId: string): Promise<PurchaseOrderView> { return this.call<PurchaseOrderView>('inventory.acceptReorderSuggestion', { params: { id: suggestionId } }); }
  async dismissReorderSuggestion(suggestionId: string, reason: string): Promise<ReorderSuggestionView> { return this.call<ReorderSuggestionView>('inventory.dismissReorderSuggestion', { params: { id: suggestionId }, body: { reason } }); }
  async listPurchaseOrders(): Promise<PurchaseOrderView[]> { return this.call<PurchaseOrderView[]>('inventory.listPurchaseOrders'); }
  async sendPurchaseOrder(poId: string): Promise<PurchaseOrderView> { return this.call<PurchaseOrderView>('inventory.sendPurchaseOrder', { params: { id: poId } }); }
  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> { return this.call<PurchaseOrderView>('inventory.createPurchaseOrder', { body: input }); }
  async listCustomers(): Promise<CustomerView[]> { return this.call<CustomerView[]>('crm.listCustomers'); }
  async assignCustomerToGroup(customerId: string, groupId: string): Promise<CustomerGroupMembershipView> {
    return this.call<CustomerGroupMembershipView>('crm.assignCustomerToGroup', {
      params: { id: customerId },
      body: { groupId },
    });
  }
  async listConsents(customerId: string): Promise<MarketingConsentView[]> { return this.call<MarketingConsentView[]>('crm.listConsents', { params: { id: customerId } }); }
  async listLoyaltyLedger(customerId: string): Promise<LoyaltyLedgerEntryView[]> { return this.call<LoyaltyLedgerEntryView[]>('crm.listLoyaltyLedger', { params: { id: customerId } }); }
  async listGiftCards(): Promise<GiftCardView[]> { return this.call<GiftCardView[]>('crm.listGiftCards'); }
  async listStoreCredit(customerId: string): Promise<Array<{ kind: string; amount_pence: string; created_at: string }>> { return this.call('crm.listStoreCredit', { params: { id: customerId } }); }
  async exportCustomer(customerId: string): Promise<CustomerExportView> { return this.call<CustomerExportView>('crm.exportCustomer', { params: { id: customerId } }); }
  async eraseCustomer(customerId: string): Promise<ErasureResultView> { return this.call<ErasureResultView>('crm.eraseCustomer', { params: { id: customerId } }); }
  async getZReport(zReportId: string): Promise<ZReportSummaryView> { return this.call<ZReportSummaryView>('reporting.getZReport', { params: { id: zReportId } }); }
  async recordZReportCorrection(zReportId: string, input: { correctionType: string; amountPence: string; reason: string; approvalEventId: string }): Promise<{ id: string }> { return this.call<{ id: string }>('reporting.recordCorrection', { params: { id: zReportId }, body: input }); }
  async closeVatPeriod(vatPeriodId: string): Promise<VatPeriodView> { return this.call<VatPeriodView>('reporting.closeVatPeriod', { params: { id: vatPeriodId } }); }
  async getVatPeriod(vatPeriodId: string): Promise<VatPeriodView> { return this.call<VatPeriodView>('reporting.getVatPeriod', { params: { id: vatPeriodId } }); }
  async exportZReportCsv(zReportId: string): Promise<string> { return this.call<string>('reporting.exportZReportCsv', { params: { id: zReportId } }); }
  async exportVatPeriodCsv(vatPeriodId: string): Promise<string> { return this.call<string>('reporting.exportVatPeriodCsv', { params: { id: vatPeriodId } }); }
  async reconcileSettlement(input: { businessDate: string; payouts: Array<{ providerReference: string; settlementDate: string; grossPence: string; feePence: string; reserveHoldPence: string; disputeDebitPence: string }> }): Promise<SettlementView> { return this.call<SettlementView>('reporting.reconcileSettlement', { body: input }); }
  async listWebhookEndpoints(): Promise<WebhookEndpointView[]> { return this.call<WebhookEndpointView[]>('webhooks.listEndpoints'); }
  async registerWebhookEndpoint(input: { url: string; eventTypes: string[] }): Promise<{ endpoint: WebhookEndpointView; secret: string }> { return this.call<{ endpoint: WebhookEndpointView; secret: string }>('webhooks.registerEndpoint', { body: input }); }
  async rotateWebhookSecret(endpointId: string, gracePeriodHours?: number): Promise<RotateWebhookSecretView> {
    // The new secret is shown once in this response; never stored.
    return this.call<RotateWebhookSecretView>('webhooks.rotateSecret', {
      params: { id: endpointId },
      body: gracePeriodHours === undefined ? {} : { gracePeriodHours },
    });
  }
  async replayDeadLetter(deliveryId: string): Promise<{ id: string; status: string }> { return this.call<{ id: string; status: string }>('webhooks.replayDeadLetter', { params: { id: deliveryId } }); }
  async discardDeadLetter(deliveryId: string): Promise<{ id: string; status: string }> { return this.call<{ id: string; status: string }>('webhooks.discardDeadLetter', { params: { id: deliveryId } }); }
  async listStatutoryArchives(tenantId: string): Promise<StatutoryArchiveView[]> {
    return this.call<StatutoryArchiveView[]>('compliance.listStatutoryArchives', { params: { tenantId } });
  }
  async getExitStatus(): Promise<ExitStatusView> { return this.call<ExitStatusView>('exit.getStatus'); }
  async requestTermination(): Promise<ExitStatusView> { return this.call<ExitStatusView>('exit.requestTermination'); }
  async beginExportWindow(): Promise<ExitStatusView> { return this.call<ExitStatusView>('exit.beginExportWindow'); }
  async runFullExport(): Promise<ExportResultView> { return this.call<ExportResultView>('exit.runFullExport'); }
  async scheduleHardDelete(): Promise<ExitStatusView> { return this.call<ExitStatusView>('exit.scheduleHardDelete'); }
}
