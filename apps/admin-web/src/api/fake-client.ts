/**
 * Fake (in-memory) implementation of AdminApiClient for tests and for
 * exercising every console without a live server.
 *
 * - Records every call (method, route key, path, headers it WOULD send,
 *   scopes) so tests can assert the client sends the right paths,
 *   headers and scopes — see test/client.test.ts.
 * - Implements the not-yet-exposed surfaces in memory (price books,
 *   promotions, vouchers, warehouses, transfers, reorder suggestions,
 *   POs, CRM, loyalty, gift cards, Z-reports, VAT, settlement, webhooks,
 *   exit/export) with the same shapes the live client will return once
 *   the routes exist, so console logic is testable end-to-end today.
 * - Error injection: `failNext(error)` makes the next call throw the
 *   given error (used to prove 404 / 403 PLAN_GATED / 429 / D-11 409
 *   handling). Voucher views never contain a full code — the fake
 *   generates only `code_last4` (D-AW-06).
 * - Tests must NEVER call a live server; the fake has no transport.
 */
import { ApiError, TerminationBlockedError } from './errors';
import type { AdminApiClient } from './client';
import { fillPath, routeFor } from './route-table';
import type {
  AgeRestrictionView,
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
  CustomerGroupView,
  CustomerView,
  DeleteAgeRestrictionResult,
  ErasureResultView,
  ExitStatusView,
  ExportResultView,
  GeneratePromotionVouchersResult,
  GenerateVouchersResult,
  GiftCardView,
  GoodsInInput,
  IssuedVoucherCodeView,
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
  UpdateVariantInput,
  ValuationRowView,
  ValuationSummaryView,
  VatPeriodView,
  VariantView,
  VoucherView,
  WarehouseView,
  WebhookEndpointView,
  ZReportSummaryView,
} from './types';

export interface RecordedCall {
  routeKey: string;
  method: string;
  path: string;
  /** The scope the route requires (null = unguarded/demo-header route). */
  scope: string | null;
  /** Headers the live client would send for this call. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface FakeSeed {
  variants?: VariantView[];
  /** Demo products (Build-09 Objective 1). */
  products?: ProductView[];
  /** Demo age-restriction rows (Build-09 Objective 1). */
  ageRestrictions?: AgeRestrictionView[];
  /** Demo tax rates (Build-08 Objective 1); defaults to the four standard UK rates. */
  taxRates?: TaxRateView[];
  stock?: StockLevelView[];
  auditEvents?: AuditEventView[];
  priceBooks?: PriceBookView[];
  promotions?: PromotionView[];
  vouchers?: VoucherView[];
  warehouses?: WarehouseView[];
  /** Demo suppliers (Build-10 Objective 2). */
  suppliers?: SupplierView[];
  supplierVariants?: SupplierVariantView[];
  transfers?: StockTransferView[];
  reorderSuggestions?: ReorderSuggestionView[];
  purchaseOrders?: PurchaseOrderView[];
  customers?: CustomerView[];
  /** Demo customer groups (Build-12 Objective 3). */
  customerGroups?: CustomerGroupView[];
  /** Demo customer-group memberships (Build-12 Objective 3). */
  customerGroupMemberships?: CustomerGroupMembershipView[];
  consents?: MarketingConsentView[];
  loyaltyLedger?: LoyaltyLedgerEntryView[];
  giftCards?: GiftCardView[];
  storeCredit?: Record<string, Array<{ kind: string; amount_pence: string; created_at: string }>>;
  zReports?: ZReportSummaryView[];
  vatPeriods?: VatPeriodView[];
  webhookEndpoints?: WebhookEndpointView[];
  statutoryArchives?: StatutoryArchiveView[];
  exitStatus?: ExitStatusView;
  events?: ListEventsResultView;
}

function last4From(seed: string): string {
  const digits = seed.replace(/\D/g, '');
  return (digits.slice(-4) || '0000').padStart(4, '0');
}

export class FakeAdminApiClient implements AdminApiClient {
  readonly calls: RecordedCall[] = [];
  private failQueue: Error[] = [];
  private idCounter = 100;

  variants: VariantView[];
  products: ProductView[];
  ageRestrictions: AgeRestrictionView[];
  taxRates: TaxRateView[];
  stock: StockLevelView[];
  auditEvents: AuditEventView[];
  priceBooks: PriceBookView[];
  priceBookEntries: PriceBookEntryView[] = [];
  promotions: PromotionView[];
  vouchers: VoucherView[];
  warehouses: WarehouseView[];
  suppliers: SupplierView[];
  supplierVariants: SupplierVariantView[];
  transfers: StockTransferView[];
  reorderSuggestions: ReorderSuggestionView[];
  purchaseOrders: PurchaseOrderView[];
  customers: CustomerView[];
  customerGroups: CustomerGroupView[];
  customerGroupMemberships: CustomerGroupMembershipView[];
  consents: MarketingConsentView[];
  loyaltyLedger: LoyaltyLedgerEntryView[];
  giftCards: GiftCardView[];
  storeCredit: Record<string, Array<{ kind: string; amount_pence: string; created_at: string }>>;
  zReports: ZReportSummaryView[];
  vatPeriods: VatPeriodView[];
  webhookEndpoints: WebhookEndpointView[];
  statutoryArchives: StatutoryArchiveView[];
  exitStatus: ExitStatusView;
  events: ListEventsResultView;
  exportedCsv: Array<{ routeKey: string; zReportIdOrPeriodId: string; csv: string }> = [];
  discardedDlq: string[] = [];
  replayedDlq: string[] = [];

  constructor(seed: FakeSeed = {}) {
    this.variants = seed.variants ?? [];
    this.products = seed.products ?? [];
    this.ageRestrictions = seed.ageRestrictions ?? [];
    // The four standard UK rates, same as the seeded tenant in
    // packages/db/src/testing.ts (ids are fake-stable, not UUIDs).
    this.taxRates = seed.taxRates ?? [
      { id: 'tax-exempt', name: 'Exempt', rate_bps: 0, is_exempt: true, is_default_no_tax: true },
      { id: 'tax-reduced', name: 'Reduced 5%', rate_bps: 500, is_exempt: false, is_default_no_tax: false },
      { id: 'tax-standard', name: 'Standard 20%', rate_bps: 2000, is_exempt: false, is_default_no_tax: false },
      { id: 'tax-zero', name: 'Zero-rated 0%', rate_bps: 0, is_exempt: false, is_default_no_tax: true },
    ];
    this.stock = seed.stock ?? [];
    this.auditEvents = seed.auditEvents ?? [];
    this.priceBooks = seed.priceBooks ?? [];
    this.promotions = seed.promotions ?? [];
    this.vouchers = seed.vouchers ?? [];
    this.warehouses = seed.warehouses ?? [];
    this.suppliers = seed.suppliers ?? [];
    this.supplierVariants = seed.supplierVariants ?? [];
    this.transfers = seed.transfers ?? [];
    this.reorderSuggestions = seed.reorderSuggestions ?? [];
    this.purchaseOrders = seed.purchaseOrders ?? [];
    this.customers = seed.customers ?? [];
    this.customerGroups = seed.customerGroups ?? [];
    this.customerGroupMemberships = seed.customerGroupMemberships ?? [];
    this.consents = seed.consents ?? [];
    this.loyaltyLedger = seed.loyaltyLedger ?? [];
    this.giftCards = seed.giftCards ?? [];
    this.storeCredit = seed.storeCredit ?? {};
    this.zReports = seed.zReports ?? [];
    this.vatPeriods = seed.vatPeriods ?? [];
    this.webhookEndpoints = seed.webhookEndpoints ?? [];
    this.statutoryArchives = seed.statutoryArchives ?? [];
    this.exitStatus = seed.exitStatus ?? {
      tenantId: 'tenant-1',
      status: 'active',
      exportWindowEndsAt: null,
      openSessionIds: [],
      blockingPaymentAttemptIds: [],
    };
    this.events = seed.events ?? { events: [], nextCursor: null };
  }

  /** Make the next call throw `error` (then clear it). */
  failNext(error: Error): void {
    this.failQueue.push(error);
  }

  private record(routeKey: string, params: Record<string, string> = {}, body?: unknown): void {
    const route = routeFor(routeKey);
    this.calls.push({
      routeKey,
      method: route.method,
      path: fillPath(route.path, params),
      scope: route.scope,
      headers: {
        Authorization: 'Bearer ukp_fake-test-key',
        'x-tenant-id': 'tenant-1',
      },
      body,
    });
    const failure = this.failQueue.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  callsFor(routeKey: string): RecordedCall[] {
    return this.calls.filter((c) => c.routeKey === routeKey);
  }

  async getStatus(module: 'admin' | 'catalogue' | 'inventory' | 'sales' | 'payments' | 'reporting' | 'integrations'): Promise<StatusView> {
    this.record(`${module}.status`);
    return { module, status: 'ok (fake)' };
  }

  async pinLogin(input: PinLoginInput): Promise<PinLoginResult> {
    this.record('auth.pinLogin', {}, input);
    return {
      token: 'fake-session-token',
      actor: {
        tenantId: input.tenantId,
        userId: input.userId,
        locationId: input.locationId ?? null,
        roles: ['cashier'],
      },
    };
  }

  async listAuditEvents(opts: { limit?: number; eventType?: string } = {}): Promise<AuditEventView[]> {
    this.record('audit.list');
    let events = [...this.auditEvents];
    if (opts.eventType !== undefined) {
      events = events.filter((e) => e.event_type === opts.eventType);
    }
    if (opts.limit !== undefined) {
      events = events.slice(0, opts.limit);
    }
    return events;
  }

  async createApproval(input: ApprovalInput): Promise<Record<string, unknown>> {
    this.record('approvals.create', {}, input);
    return { id: this.nextId('approval'), action: input.action, status: 'approved' };
  }

  async listApiKeys(): Promise<ApiKeyView[]> {
    this.record('apiKeys.list');
    return [{ id: 'key-1', name: 'dashboard', key_prefix: 'ukp_ab12', scopes: ['admin'], status: 'active', created_at: '2026-11-13T00:00:00.000Z', last_used_at: null, expires_at: null, grace_until: null }];
  }

  async createApiKey(input: { name?: string | null; scopes: string[]; expiresAt?: string | null }): Promise<ApiKeyCreatedView> {
    this.record('apiKeys.create', {}, input);
    return { id: this.nextId('key'), name: input.name ?? null, key_prefix: 'ukp_9f99', scopes: input.scopes, status: 'active', created_at: new Date().toISOString(), last_used_at: null, expires_at: input.expiresAt ?? null, grace_until: null, key: 'ukp_fake-created-key-only-shown-once' };
  }

  async rotateApiKey(keyId: string): Promise<ApiKeyCreatedView> {
    this.record('apiKeys.rotate', { id: keyId });
    return { id: keyId, name: 'dashboard', key_prefix: 'ukp_77aa', scopes: ['admin'], status: 'active', created_at: new Date().toISOString(), last_used_at: null, expires_at: null, grace_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), key: 'ukp_fake-rotated-key-only-shown-once' };
  }

  async revokeApiKey(keyId: string): Promise<{ id: string; status: string }> {
    this.record('apiKeys.revoke', { id: keyId });
    return { id: keyId, status: 'revoked' };
  }

  async createVariant(input: CreateVariantInput): Promise<VariantView> {
    this.record('catalogue.createVariant', {}, input);
    const variant: VariantView = {
      id: this.nextId('variant'),
      product_id: input.productId,
      sku: input.sku,
      barcode: input.barcode ?? null,
      name: input.name,
      price_pence: input.pricePence,
      cost_pence: input.costPence ?? '0',
      tax_rate_id: input.taxRateId ?? null,
      is_bundle: input.isBundle ?? false,
      is_active: true,
    };
    this.variants.push(variant);
    // Mirror the server (Build-09/Build-11): an explicit nested rule
    // wins ('explicit'); otherwise the variant inherits the stored
    // product-level rule ('inherited') when one exists.
    if (input.ageRestriction !== undefined && input.ageRestriction !== null) {
      this.ageRestrictions.push({
        id: this.nextId('age-restriction'),
        variant_id: variant.id,
        product_id: variant.product_id,
        requires_challenge_25: input.ageRestriction.requiresChallenge25 ?? true,
        min_age: input.ageRestriction.minAge ?? 18,
        rule_source: 'explicit',
      });
    } else {
      const productRule = this.ageRestrictions.find(
        (r) => r.product_id === variant.product_id && r.variant_id === null,
      );
      if (productRule !== undefined) {
        this.ageRestrictions.push({
          id: this.nextId('age-restriction'),
          variant_id: variant.id,
          product_id: variant.product_id,
          requires_challenge_25: productRule.requires_challenge_25,
          min_age: productRule.min_age,
          rule_source: 'inherited',
        });
      }
    }
    return variant;
  }

  async listVariants(filters: { productId?: string; categoryId?: string } = {}): Promise<VariantView[]> {
    this.record('catalogue.listVariants');
    if (filters.productId !== undefined) {
      return this.variants.filter((v) => v.product_id === filters.productId);
    }
    return [...this.variants];
  }

  /**
   * Update a variant in place (Build-12 Objective 3). Mirrors the
   * server: only supplied fields change; SKU/barcode uniqueness is
   * per tenant (409, excluding the variant itself); a supplied
   * taxRateId must exist (404); price/cost must be non-negative
   * (400); status must be active/inactive (400); an empty update is
   * a 400. Recorded since Obj 4 (route-table entry landed).
   */
  async updateVariant(id: string, input: UpdateVariantInput): Promise<VariantView> {
    this.record('catalogue.updateVariant', { id }, input);
    const variant = this.variants.find((v) => v.id === id);
    if (variant === undefined) {
      throw new ApiError(404, 'Resource not found');
    }
    const hasAnyField =
      input.sku !== undefined ||
      input.barcode !== undefined ||
      input.pricePence !== undefined ||
      input.costPence !== undefined ||
      input.taxRateId !== undefined ||
      input.status !== undefined;
    if (!hasAnyField) {
      throw new ApiError(400, 'At least one field to update is required');
    }
    if (input.sku !== undefined) {
      if (input.sku.trim() === '') {
        throw new ApiError(400, 'SKU is required');
      }
      if (this.variants.some((v) => v.id !== id && v.sku === input.sku)) {
        throw new ApiError(409, `SKU ${input.sku} already exists`);
      }
    }
    if (input.barcode !== undefined && input.barcode !== null) {
      if (this.variants.some((v) => v.id !== id && v.barcode === input.barcode)) {
        throw new ApiError(409, `Barcode ${input.barcode} already exists`);
      }
    }
    if (input.pricePence !== undefined && BigInt(input.pricePence) < 0n) {
      throw new ApiError(400, 'pricePence must be a non-negative integer');
    }
    if (input.costPence !== undefined && BigInt(input.costPence) < 0n) {
      throw new ApiError(400, 'costPence must be a non-negative integer');
    }
    if (input.taxRateId !== undefined && input.taxRateId !== null) {
      if (!this.taxRates.some((t) => t.id === input.taxRateId)) {
        throw new ApiError(404, 'Resource not found');
      }
    }
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'inactive') {
      throw new ApiError(400, "status must be 'active' or 'inactive'");
    }
    if (input.sku !== undefined) variant.sku = input.sku;
    if (input.barcode !== undefined) variant.barcode = input.barcode;
    if (input.pricePence !== undefined) variant.price_pence = input.pricePence;
    if (input.costPence !== undefined) variant.cost_pence = input.costPence;
    if (input.taxRateId !== undefined) variant.tax_rate_id = input.taxRateId;
    if (input.status !== undefined) variant.is_active = input.status === 'active';
    return variant;
  }

  async listTaxRates(): Promise<TaxRateView[]> {
    this.record('catalogue.listTaxRates');
    return [...this.taxRates];
  }

  async createProduct(input: CreateProductInput): Promise<ProductView> {
    this.record('catalogue.createProduct', {}, input);
    if (input.name.trim() === '') {
      throw new Error('Product name is required.');
    }
    const product: ProductView = {
      id: this.nextId('product'),
      category_id: input.categoryId ?? null,
      name: input.name.trim(),
      description: input.description ?? null,
      is_active: true,
    };
    this.products.push(product);
    // Build-12 Objective 2: a nested age restriction creates a
    // first-class product-level row (variant_id NULL, 'explicit') —
    // same as the server. A variant created under the product
    // afterwards inherits it (see createVariant in this fake, which
    // mirrors the server's inheritance).
    if (input.ageRestriction !== undefined && input.ageRestriction !== null) {
      this.ageRestrictions.push({
        id: this.nextId('age-restriction'),
        variant_id: null,
        product_id: product.id,
        requires_challenge_25: input.ageRestriction.requiresChallenge25 ?? true,
        min_age: input.ageRestriction.minAge ?? 18,
        rule_source: 'explicit',
      });
    }
    return product;
  }

  async listProducts(filters: { categoryId?: string } = {}): Promise<ProductView[]> {
    this.record('catalogue.listProducts');
    if (filters.categoryId !== undefined) {
      return this.products.filter((p) => p.category_id === filters.categoryId);
    }
    return [...this.products];
  }

  async getProduct(productId: string): Promise<ProductView> {
    this.record('catalogue.getProduct', { id: productId });
    const product = this.products.find((p) => p.id === productId);
    if (product === undefined) {
      throw new Error('Resource not found');
    }
    return product;
  }

  async createAgeRestriction(input: CreateAgeRestrictionInput): Promise<AgeRestrictionView[]> {
    this.record('catalogue.createAgeRestriction', {}, input);
    const hasProduct = input.productId !== undefined && input.productId !== null;
    const hasVariant = input.variantId !== undefined && input.variantId !== null;
    if (hasProduct === hasVariant) {
      throw new Error('Exactly one of product_id or variant_id must be provided.');
    }
    const requiresChallenge25 = input.requiresChallenge25 ?? true;
    const minAge = input.minAge ?? 18;
    if (hasVariant) {
      const variant = this.variants.find((v) => v.id === input.variantId);
      if (variant === undefined) {
        throw new Error('Resource not found');
      }
      const existing = this.ageRestrictions.find((r) => r.variant_id === variant.id);
      if (existing !== undefined) {
        existing.requires_challenge_25 = requiresChallenge25;
        existing.min_age = minAge;
        existing.rule_source = 'explicit';
        return [existing];
      }
      const row: AgeRestrictionView = {
        id: this.nextId('age-restriction'),
        variant_id: variant.id,
        product_id: variant.product_id,
        requires_challenge_25: requiresChallenge25,
        min_age: minAge,
        rule_source: 'explicit',
      };
      this.ageRestrictions.push(row);
      return [row];
    }
    // Product target (Build-11 Objective 2, mirrored): store the
    // product-level row ('explicit') first, then propagate to the
    // product's current variants — an 'explicit' variant row is never
    // overwritten, an 'inherited' row is refreshed, a variant with no
    // row gains an 'inherited' row. A variant-less product returns
    // just the product-level row (no 400).
    const product = this.products.find((p) => p.id === input.productId);
    if (product === undefined) {
      throw new Error('Resource not found');
    }
    let productRow = this.ageRestrictions.find(
      (r) => r.product_id === product.id && r.variant_id === null,
    );
    if (productRow === undefined) {
      productRow = {
        id: this.nextId('age-restriction'),
        variant_id: null,
        product_id: product.id,
        requires_challenge_25: requiresChallenge25,
        min_age: minAge,
        rule_source: 'explicit',
      };
      this.ageRestrictions.push(productRow);
    } else {
      productRow.requires_challenge_25 = requiresChallenge25;
      productRow.min_age = minAge;
    }
    const variants = this.variants.filter((v) => v.product_id === product.id);
    if (variants.length === 0) {
      return [productRow];
    }
    const created: AgeRestrictionView[] = [];
    for (const variant of variants) {
      const existing = this.ageRestrictions.find((r) => r.variant_id === variant.id);
      if (existing !== undefined) {
        if (existing.rule_source === 'inherited') {
          existing.requires_challenge_25 = requiresChallenge25;
          existing.min_age = minAge;
        }
        created.push(existing);
      } else {
        const row: AgeRestrictionView = {
          id: this.nextId('age-restriction'),
          variant_id: variant.id,
          product_id: variant.product_id,
          requires_challenge_25: requiresChallenge25,
          min_age: minAge,
          rule_source: 'inherited',
        };
        this.ageRestrictions.push(row);
        created.push(row);
      }
    }
    return created;
  }

  async listAgeRestrictions(
    filters: { variantId?: string; productId?: string } = {},
  ): Promise<AgeRestrictionView[]> {
    this.record('catalogue.listAgeRestrictions');
    return this.ageRestrictions.filter(
      (r) =>
        (filters.variantId === undefined || r.variant_id === filters.variantId) &&
        (filters.productId === undefined || r.product_id === filters.productId),
    );
  }

  /**
   * Delete one age-restriction rule (Build-12 Objective 2), mirroring
   * the server: a product-level delete removes the product row AND
   * the 'inherited' variant rows propagated from it, never an
   * 'explicit' override; a variant-level delete removes only that
   * row. Recorded since Obj 4 (route-table entry landed).
   */
  async deleteAgeRestriction(id: string): Promise<DeleteAgeRestrictionResult> {
    this.record('catalogue.deleteAgeRestriction', { id });
    const index = this.ageRestrictions.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error('Resource not found');
    }
    const [deleted] = this.ageRestrictions.splice(index, 1) as [AgeRestrictionView];
    const deletedInheritedRuleIds: string[] = [];
    if (deleted.variant_id === null) {
      // Product-level delete: drop the 'inherited' rows propagated
      // from this product rule; 'explicit' overrides survive.
      for (let i = this.ageRestrictions.length - 1; i >= 0; i--) {
        const row = this.ageRestrictions[i] as AgeRestrictionView;
        if (row.product_id === deleted.product_id && row.rule_source === 'inherited') {
          deletedInheritedRuleIds.push(row.id);
          this.ageRestrictions.splice(i, 1);
        }
      }
    }
    return { deleted_rule: deleted, deleted_inherited_rule_ids: deletedInheritedRuleIds };
  }

  async priceBasket(input: PriceBasketInput): Promise<PriceBasketView> {
    this.record('catalogue.priceBasket', {}, input);
    // The fake mirrors the SHAPE of the server pipeline, not its
    // arithmetic: totals are the sum of the variant base prices it knows.
    // Real pricing is always the server's (PricingService, Arch-10).
    let subtotal = 0n;
    const lines: PriceBasketView['lines'] = input.lines.map((line) => {
      const variant = this.variants.find((v) => v.id === line.variantId);
      const base = variant === undefined ? 0n : BigInt(variant.price_pence);
      const qty = BigInt(line.quantity);
      const total = base * qty;
      subtotal += total;
      return {
        variantId: line.variantId,
        quantity: line.quantity,
        basePricePence: base.toString(),
        priceBookPricePence: null,
        promotionDiscountPence: '0',
        manualDiscountPence: line.manualDiscountPence ?? '0',
        finalPricePence: base.toString(),
        lineTotalPence: total.toString(),
        taxAmountPence: '0',
        appliedPromotions: [],
      };
    });
    const basketDiscount = input.basketDiscountPence === undefined ? 0n : BigInt(input.basketDiscountPence);
    return { lines, subtotalPence: subtotal.toString(), discountPence: basketDiscount.toString(), taxPence: '0', totalPence: (subtotal - basketDiscount).toString(), voucherPromotionId: null, voucherDiscountPence: null };
  }

  async parseBarcode(code: string, requestedMode?: 'ean13' | 'upca' | 'embedded-price' | 'embedded-weight'): Promise<{ sku: string; pricePence: string | null; weightGrams: string | null }> {
    this.record('catalogue.parseBarcode', {}, { code, requestedMode });
    return { sku: code, pricePence: null, weightGrams: null };
  }

  async startCount(input: { locationId: string; warehouseId?: string | null }): Promise<{ id: string; status: string }> {
    this.record('inventory.startCount', {}, input);
    return { id: this.nextId('count'), status: 'draft' };
  }

  async setCountedQuantity(countId: string, line: CountLineInput): Promise<{ countId: string; variantId: string; expectedQuantity: string; countedQuantity: string | null }> {
    this.record('inventory.setCountedQuantity', { id: countId }, line);
    const level = this.stock.find((s) => s.variantId === line.variantId);
    return { countId, variantId: line.variantId, expectedQuantity: level?.quantityOnHand ?? '0', countedQuantity: line.countedQuantity };
  }

  async submitCount(countId: string): Promise<{ adjustments: Array<{ variantId: string; variance: string }> }> {
    this.record('inventory.submitCount', { id: countId });
    return { adjustments: [] };
  }

  async receiveGoodsIn(input: GoodsInInput): Promise<{ receiptId: string }> {
    this.record('inventory.receiveGoodsIn', {}, input);
    for (const line of input.lines) {
      const level = this.stock.find((s) => s.variantId === line.variantId && s.warehouseId === input.warehouseId);
      if (level !== undefined) {
        const oldQty = BigInt(level.quantityOnHand);
        const received = BigInt(line.quantityReceived);
        const newQty = oldQty + received;
        level.quantityOnHand = newQty.toString();
        // Weighted average, mirroring the service: (oldQty*oldAvg +
        // received*cost) / newQty, round half up; a row with no average
        // yet takes the first receipt's cost.
        if (level.weightedAvgCostPence === undefined || level.weightedAvgCostPence === null) {
          level.weightedAvgCostPence = line.costPence;
        } else {
          const numerator = oldQty * BigInt(level.weightedAvgCostPence) + received * BigInt(line.costPence);
          level.weightedAvgCostPence = ((2n * numerator + newQty) / (2n * newQty)).toString();
        }
        level.totalValuePence = (newQty * BigInt(level.weightedAvgCostPence)).toString();
      } else {
        this.stock.push({
          variantId: line.variantId,
          warehouseId: input.warehouseId,
          quantityOnHand: line.quantityReceived,
          computedAt: new Date().toISOString(),
          weightedAvgCostPence: line.costPence,
          totalValuePence: (BigInt(line.quantityReceived) * BigInt(line.costPence)).toString(),
        });
      }
    }
    return { receiptId: this.nextId('receipt') };
  }

  async getStock(filters: { variantId?: string; warehouseId?: string } = {}): Promise<StockLevelView[]> {
    this.record('inventory.getStock');
    return this.stock.filter(
      (s) =>
        (filters.variantId === undefined || s.variantId === filters.variantId) &&
        (filters.warehouseId === undefined || s.warehouseId === filters.warehouseId),
    );
  }

  async getBalances(filters: { variantId?: string; warehouseId?: string } = {}): Promise<BalanceView[]> {
    this.record('inventory.getBalances');
    return this.stock
      .filter(
        (s) =>
          (filters.variantId === undefined || s.variantId === filters.variantId) &&
          (filters.warehouseId === undefined || s.warehouseId === filters.warehouseId),
      )
      .map((s) => ({ ...s, computedAt: s.computedAt ?? new Date().toISOString() }));
  }

  async getValuation(filters: { variantId?: string; warehouseId?: string } = {}): Promise<ValuationSummaryView> {
    this.record('inventory.getValuation');
    const rows = this.stock.filter(
      (s) =>
        (filters.variantId === undefined || s.variantId === filters.variantId) &&
        (filters.warehouseId === undefined || s.warehouseId === filters.warehouseId),
    );
    const byVariant = new Map<string, { qty: bigint; value: bigint | null; knownQty: bigint }>();
    for (const row of rows) {
      const entry = byVariant.get(row.variantId) ?? { qty: 0n, value: null, knownQty: 0n };
      const qty = BigInt(row.quantityOnHand);
      entry.qty += qty;
      if (row.weightedAvgCostPence !== undefined && row.weightedAvgCostPence !== null) {
        entry.value = (entry.value ?? 0n) + qty * BigInt(row.weightedAvgCostPence);
        entry.knownQty += qty;
      }
      byVariant.set(row.variantId, entry);
    }
    const valuation: ValuationRowView[] = [...byVariant.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([variantId, entry]) => ({
        variantId,
        totalQuantityOnHand: entry.qty.toString(),
        weightedAvgCostPence:
          entry.value === null || entry.knownQty === 0n
            ? null
            : ((2n * entry.value + entry.knownQty) / (2n * entry.knownQty)).toString(),
        totalValuePence: entry.value === null ? null : entry.value.toString(),
      }));
    let totalQty = 0n;
    let totalValue: bigint | null = null;
    for (const row of valuation) {
      totalQty += BigInt(row.totalQuantityOnHand);
      if (row.totalValuePence !== null) totalValue = (totalValue ?? 0n) + BigInt(row.totalValuePence);
    }
    return {
      valuation,
      totals: {
        totalQuantityOnHand: totalQty.toString(),
        totalValuePence: totalValue === null ? null : totalValue.toString(),
      },
    };
  }

  async getReceipt(orderId: string): Promise<ReceiptView> {
    this.record('sales.getReceipt', { id: orderId });
    return { receiptNumber: '1', orderId, issuedAt: new Date().toISOString(), lines: [], totalPence: '0', vatInvoiceNotice: 'This is not a VAT invoice' };
  }

  async voidOrder(orderId: string, input: { reason?: string; approvalEventsId?: string | null } = {}): Promise<{ orderId: string; status: string }> {
    this.record('sales.voidOrder', { id: orderId }, input);
    return { orderId, status: 'voided' };
  }

  async listEvents(filters: ListEventsFilters = {}): Promise<ListEventsResultView> {
    this.record('events.list');
    let events = [...this.events.events];
    if (filters.deliveryStatus !== undefined) {
      events = events.filter((e) => e.deliveries.some((d) => d.status === filters.deliveryStatus));
    }
    if (filters.eventType !== undefined) {
      events = events.filter((e) => e.event_type === filters.eventType);
    }
    return { events, nextCursor: null };
  }

  // --- Not-yet-exposed surfaces, implemented in memory ---
  async listPriceBooks(): Promise<PriceBookView[]> {
    this.record('catalogue.listPriceBooks');
    return [...this.priceBooks];
  }

  async createPriceBook(input: { name: string; priority: number; effectiveFrom: string; effectiveTo?: string | null }): Promise<PriceBookView> {
    this.record('catalogue.createPriceBook', {}, input);
    const book: PriceBookView = { id: this.nextId('price-book'), name: input.name, priority: input.priority, effective_from: input.effectiveFrom, effective_to: input.effectiveTo ?? null, status: 'draft' };
    this.priceBooks.push(book);
    return book;
  }

  async setPriceBookEntry(priceBookId: string, entry: PriceBookEntryView): Promise<PriceBookEntryView> {
    this.record('catalogue.setPriceBookEntry', { id: priceBookId }, entry);
    // Upsert on the composite key, like the server (POST replaces).
    const existing = this.priceBookEntries.findIndex(
      (e) => e.price_book_id === entry.price_book_id && e.variant_id === entry.variant_id,
    );
    if (existing >= 0) {
      this.priceBookEntries[existing] = entry;
    } else {
      this.priceBookEntries.push(entry);
    }
    return entry;
  }

  async updatePriceBookEntry(priceBookId: string, variantId: string, pricePence: string): Promise<PriceBookEntryView> {
    this.record('catalogue.updatePriceBookEntry', { id: priceBookId, variantId }, { pricePence });
    const existing = this.priceBookEntries.find(
      (e) => e.price_book_id === priceBookId && e.variant_id === variantId,
    );
    if (existing === undefined) {
      throw new ApiError(404, 'Resource not found');
    }
    const updated: PriceBookEntryView = { price_book_id: priceBookId, variant_id: variantId, price_pence: pricePence };
    this.priceBookEntries[this.priceBookEntries.indexOf(existing)] = updated;
    return updated;
  }

  async listPromotions(): Promise<PromotionView[]> {
    this.record('catalogue.listPromotions');
    return [...this.promotions];
  }

  async createPromotion(input: { name: string; type: PromotionView['type']; startAt: string; endAt?: string | null }): Promise<PromotionView> {
    this.record('catalogue.createPromotion', {}, input);
    const promo: PromotionView = { id: this.nextId('promo'), name: input.name, type: input.type, status: 'draft', version: 1, stack_group: null, start_at: input.startAt, end_at: input.endAt ?? null };
    this.promotions.push(promo);
    return promo;
  }

  async generateVouchers(input: { promotionId: string | null; count: number; maxUses: number; validTo?: string | null }): Promise<GenerateVouchersResult> {
    this.record('catalogue.generateVouchers', {}, input);
    if (!Number.isInteger(input.count) || input.count <= 0 || input.count > 1000) {
      throw new ApiError(400, 'count must be an integer between 1 and 1000');
    }
    // Show-once IN THE FAKE TOO (Build-05 fix): plaintext codes are
    // returned here only. The stored VoucherView rows carry code_last4
    // only — the fake never retains a full code.
    const issuedCodes: IssuedVoucherCodeView[] = [];
    for (let i = 0; i < input.count; i += 1) {
      const code = `FAKE-${String(this.idCounter + i).padStart(4, '0')}-CODE-${String(i).padStart(4, '0')}`;
      const voucher: VoucherView = {
        id: this.nextId('voucher'),
        code_last4: code.slice(-4),
        promotion_id: input.promotionId,
        status: 'active',
        max_uses: input.maxUses,
        uses_count: 0,
        valid_from: new Date().toISOString(),
        valid_to: input.validTo ?? null,
      };
      this.vouchers.push(voucher);
      issuedCodes.push({ id: voucher.id, code, code_last4: voucher.code_last4, expires_at: input.validTo ?? null });
    }
    return { promotionId: input.promotionId, issuedCodes };
  }

  async generatePromotionVouchers(promotionId: string, input: { count: number; maxUses: number; validTo?: string | null }): Promise<GeneratePromotionVouchersResult> {
    this.record('catalogue.generatePromotionVouchers', { id: promotionId }, input);
    if (!Number.isInteger(input.count) || input.count <= 0 || input.count > 1000) {
      throw new ApiError(400, 'count must be an integer between 1 and 1000');
    }
    // Show-once IN THE FAKE TOO: plaintext codes are returned here
    // only. listVouchers / the stored VoucherView rows carry
    // code_last4 only — the fake never retains a full code.
    const issuedCodes: IssuedVoucherCodeView[] = [];
    for (let i = 0; i < input.count; i += 1) {
      const code = `FAKE-${String(this.idCounter + i).padStart(4, '0')}-CODE-${String(i).padStart(4, '0')}`;
      const voucher: VoucherView = {
        id: this.nextId('voucher'),
        code_last4: code.slice(-4),
        promotion_id: promotionId,
        status: 'active',
        max_uses: input.maxUses,
        uses_count: 0,
        valid_from: new Date().toISOString(),
        valid_to: input.validTo ?? null,
      };
      this.vouchers.push(voucher);
      issuedCodes.push({ id: voucher.id, code, code_last4: voucher.code_last4, expires_at: input.validTo ?? null });
    }
    return { promotionId, issuedCodes };
  }

  async listVouchers(): Promise<VoucherView[]> {
    this.record('catalogue.listVouchers');
    return [...this.vouchers];
  }

  async listWarehouses(): Promise<WarehouseView[]> {
    this.record('inventory.listWarehouses');
    return [...this.warehouses];
  }

  /**
   * Warehouses + suppliers (Build-10 Objective 2). The record() calls
   * resolve through the route table; the entries landed with
   * Build-10 Obj 4.
   */
  async createWarehouse(input: CreateWarehouseInput): Promise<WarehouseView> {
    this.record('inventory.createWarehouse', {}, input);
    if (input.name.trim() === '') {
      throw new Error('Warehouse name is required.');
    }
    if (
      this.warehouses.some((w) => w.location_id === input.locationId && w.is_default) &&
      input.isDefault === true
    ) {
      throw new ApiError(409, 'A default warehouse already exists for this location');
    }
    const warehouse: WarehouseView = {
      id: this.nextId('warehouse'),
      location_id: input.locationId,
      name: input.name.trim(),
      type: input.type ?? 'store',
      is_default: input.isDefault ?? false,
    };
    this.warehouses.push(warehouse);
    return warehouse;
  }

  async getWarehouse(warehouseId: string): Promise<WarehouseView> {
    this.record('inventory.getWarehouse', { id: warehouseId });
    const warehouse = this.warehouses.find((w) => w.id === warehouseId);
    if (warehouse === undefined) {
      throw new Error('Resource not found');
    }
    return warehouse;
  }

  async createSupplier(input: CreateSupplierInput): Promise<SupplierView> {
    this.record('purchasing.createSupplier', {}, input);
    if (input.name.trim() === '') {
      throw new Error('Supplier name is required.');
    }
    const supplier: SupplierView = {
      id: this.nextId('supplier'),
      name: input.name.trim(),
      contact_name: input.contactName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      lead_time_days: input.leadTimeDays ?? null,
      minimum_order_value_pence: input.minOrderValuePence ?? null,
      currency: (input.currency ?? 'GBP').toUpperCase(),
    };
    this.suppliers.push(supplier);
    return supplier;
  }

  async listSuppliers(): Promise<SupplierView[]> {
    this.record('purchasing.listSuppliers');
    return [...this.suppliers];
  }

  async getSupplier(supplierId: string): Promise<SupplierView> {
    this.record('purchasing.getSupplier', { id: supplierId });
    const supplier = this.suppliers.find((s) => s.id === supplierId);
    if (supplier === undefined) {
      throw new Error('Resource not found');
    }
    return supplier;
  }

  async linkSupplierVariant(
    supplierId: string,
    input: LinkSupplierVariantInput,
  ): Promise<SupplierVariantView> {
    this.record('purchasing.linkSupplierVariant', { id: supplierId }, input);
    const supplier = this.suppliers.find((s) => s.id === supplierId);
    if (supplier === undefined) {
      throw new Error('Resource not found');
    }
    if (!/^\d+$/.test(input.costPence.trim())) {
      throw new Error('Cost must be a non-negative integer.');
    }
    const existing = this.supplierVariants.find(
      (l) => l.supplier_id === supplierId && l.variant_id === input.variantId,
    );
    const link: SupplierVariantView = {
      supplier_id: supplierId,
      variant_id: input.variantId,
      supplier_sku: input.supplierSku ?? null,
      cost_pence: input.costPence,
      currency: (input.currency ?? supplier.currency).toUpperCase(),
      is_preferred: input.isPreferred ?? false,
    };
    if (existing !== undefined) {
      Object.assign(existing, link);
      return existing;
    }
    this.supplierVariants.push(link);
    return link;
  }

  async listTransfers(): Promise<StockTransferView[]> {
    this.record('inventory.listTransfers');
    return [...this.transfers];
  }

  async createTransfer(input: { fromWarehouseId: string; toWarehouseId: string; lines: Array<{ variantId: string; quantity: string }> }): Promise<StockTransferView> {
    this.record('inventory.createTransfer', {}, input);
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new ApiError(400, 'Transfer source and destination warehouses must differ');
    }
    const transfer: StockTransferView = {
      id: this.nextId('transfer'),
      from_warehouse_id: input.fromWarehouseId,
      to_warehouse_id: input.toWarehouseId,
      status: 'in_transit',
      received_at: null,
      lines: input.lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity, received_quantity: '0' })),
    };
    this.transfers.push(transfer);
    return transfer;
  }

  async listReorderSuggestions(): Promise<ReorderSuggestionView[]> {
    this.record('inventory.listReorderSuggestions');
    return [...this.reorderSuggestions];
  }

  async acceptReorderSuggestion(suggestionId: string): Promise<PurchaseOrderView> {
    this.record('inventory.acceptReorderSuggestion', { id: suggestionId });
    const suggestion = this.reorderSuggestions.find((s) => s.id === suggestionId);
    if (suggestion === undefined) {
      throw new ApiError(404, 'Reorder suggestion not found');
    }
    if (suggestion.status !== 'pending') {
      throw new ApiError(409, `Reorder suggestion is ${suggestion.status}, not pending`);
    }
    suggestion.status = 'approved';
    const po: PurchaseOrderView = {
      id: this.nextId('po'),
      location_id: suggestion.location_id,
      supplier_id: suggestion.supplier_id ?? 'unknown-supplier',
      po_number: String(this.purchaseOrders.length + 1),
      status: 'draft',
      sent_at: null,
      // A suggestion-created PO never names a warehouse or an
      // expected date (Build-12 Objective 3, migration 019).
      warehouse_id: null,
      expected_delivery_date: null,
      lines: [{ variant_id: suggestion.variant_id, quantity_ordered: suggestion.suggested_quantity, quantity_received: '0', cost_pence: '0' }],
    };
    this.purchaseOrders.push(po);
    return po;
  }

  async dismissReorderSuggestion(suggestionId: string, reason: string): Promise<ReorderSuggestionView> {
    this.record('inventory.dismissReorderSuggestion', { id: suggestionId }, { reason });
    if (reason.trim() === '') {
      throw new ApiError(400, 'A dismiss reason is required');
    }
    const suggestion = this.reorderSuggestions.find((s) => s.id === suggestionId);
    if (suggestion === undefined) {
      throw new ApiError(404, 'Reorder suggestion not found');
    }
    suggestion.status = 'dismissed';
    return suggestion;
  }

  async listPurchaseOrders(): Promise<PurchaseOrderView[]> {
    this.record('inventory.listPurchaseOrders');
    return [...this.purchaseOrders];
  }

  async sendPurchaseOrder(poId: string): Promise<PurchaseOrderView> {
    this.record('inventory.sendPurchaseOrder', { id: poId });
    const po = this.purchaseOrders.find((p) => p.id === poId);
    if (po === undefined) {
      throw new ApiError(404, 'Purchase order not found');
    }
    if (po.status !== 'draft') {
      throw new ApiError(409, `Purchase order is ${po.status}, not draft`);
    }
    po.status = 'sent';
    po.sent_at = new Date().toISOString();
    return po;
  }

  /**
   * Create a standalone DRAFT purchase order (Build-12 Objective 3).
   * Mirrors the server: supplier, warehouse and every variant must
   * exist (404); lines must be non-empty with no duplicate variant,
   * quantityOrdered a positive integer and unitCostPence a
   * non-negative integer (400); the location is derived from the
   * warehouse; the PO number is sequential. Recorded since Obj 4
   * (route-table entry landed).
   */
  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> {
    this.record('inventory.createPurchaseOrder', {}, input);
    const supplier = this.suppliers.find((s) => s.id === input.supplierId);
    if (supplier === undefined) {
      throw new ApiError(404, 'Resource not found');
    }
    const warehouse = this.warehouses.find((w) => w.id === input.warehouseId);
    if (warehouse === undefined) {
      throw new ApiError(404, 'Resource not found');
    }
    if (input.lines.length === 0) {
      throw new ApiError(400, 'lines must not be empty');
    }
    const seen = new Set<string>();
    for (const line of input.lines) {
      if (seen.has(line.variantId)) {
        throw new ApiError(400, 'lines must not contain a duplicate variant');
      }
      seen.add(line.variantId);
      if (!this.variants.some((v) => v.id === line.variantId)) {
        throw new ApiError(404, 'Resource not found');
      }
      const qty = BigInt(line.quantityOrdered);
      if (qty <= 0n) {
        throw new ApiError(400, 'quantityOrdered must be a positive integer');
      }
      if (BigInt(line.unitCostPence) < 0n) {
        throw new ApiError(400, 'unitCostPence must be a non-negative integer');
      }
    }
    const po: PurchaseOrderView = {
      id: this.nextId('po'),
      location_id: warehouse.location_id,
      supplier_id: supplier.id,
      po_number: String(this.purchaseOrders.length + 1),
      status: 'draft',
      sent_at: null,
      warehouse_id: warehouse.id,
      expected_delivery_date: input.expectedDeliveryDate ?? null,
      lines: input.lines.map((line) => ({
        variant_id: line.variantId,
        quantity_ordered: line.quantityOrdered,
        quantity_received: '0',
        cost_pence: line.unitCostPence,
      })),
    };
    this.purchaseOrders.push(po);
    return po;
  }

  async listCustomers(): Promise<CustomerView[]> {
    this.record('crm.listCustomers');
    return [...this.customers];
  }

  /**
   * Assign a customer to a manual customer group (Build-12
   * Objective 3). Mirrors the server: customer and group must exist
   * (404); a repeat call returns the existing membership with its
   * original created_at (idempotent, no duplicate row). Recorded
   * since Obj 4 (route-table entry landed).
   */
  async assignCustomerToGroup(customerId: string, groupId: string): Promise<CustomerGroupMembershipView> {
    this.record('crm.assignCustomerToGroup', { id: customerId }, { groupId });
    if (!this.customers.some((c) => c.id === customerId)) {
      throw new ApiError(404, 'Resource not found');
    }
    if (!this.customerGroups.some((g) => g.id === groupId)) {
      throw new ApiError(404, 'Resource not found');
    }
    const existing = this.customerGroupMemberships.find(
      (m) => m.customer_id === customerId && m.group_id === groupId,
    );
    if (existing !== undefined) {
      return existing;
    }
    const membership: CustomerGroupMembershipView = {
      customer_id: customerId,
      group_id: groupId,
      created_at: new Date().toISOString(),
    };
    this.customerGroupMemberships.push(membership);
    return membership;
  }

  async listConsents(customerId: string): Promise<MarketingConsentView[]> {
    this.record('crm.listConsents', { id: customerId });
    return this.consents.filter((c) => c.customer_id === customerId);
  }

  async listLoyaltyLedger(customerId: string): Promise<LoyaltyLedgerEntryView[]> {
    this.record('crm.listLoyaltyLedger', { id: customerId });
    return this.loyaltyLedger.filter((e) => e.customer_id === customerId);
  }

  async listGiftCards(): Promise<GiftCardView[]> {
    this.record('crm.listGiftCards');
    return [...this.giftCards];
  }

  async listStoreCredit(customerId: string): Promise<Array<{ kind: string; amount_pence: string; created_at: string }>> {
    this.record('crm.listStoreCredit', { id: customerId });
    return [...(this.storeCredit[customerId] ?? [])];
  }

  async exportCustomer(customerId: string): Promise<CustomerExportView> {
    this.record('crm.exportCustomer', { id: customerId });
    const customer = this.customers.find((c) => c.id === customerId);
    if (customer === undefined) {
      throw new ApiError(404, 'Customer not found');
    }
    return { customerId, files: {}, manifest: [], totalRows: 0, fileCount: 0 };
  }

  async eraseCustomer(customerId: string): Promise<ErasureResultView> {
    this.record('crm.eraseCustomer', { id: customerId });
    return { customerId, anonymisedOrderCount: 0, anonymisedLedgerRowCount: 0, placeholderCustomerId: 'erased-customer' };
  }

  async getZReport(zReportId: string): Promise<ZReportSummaryView> {
    this.record('reporting.getZReport', { id: zReportId });
    const report = this.zReports.find((z) => z.id === zReportId);
    if (report === undefined) {
      throw new ApiError(404, 'Z-report not found');
    }
    return report;
  }

  async recordZReportCorrection(zReportId: string, input: { correctionType: string; amountPence: string; reason: string; approvalEventId: string }): Promise<{ id: string }> {
    this.record('reporting.recordCorrection', { id: zReportId }, input);
    return { id: this.nextId('correction') };
  }

  async closeVatPeriod(vatPeriodId: string): Promise<VatPeriodView> {
    this.record('reporting.closeVatPeriod', { id: vatPeriodId });
    const period = this.vatPeriods.find((p) => p.id === vatPeriodId);
    if (period === undefined) {
      throw new ApiError(404, 'VAT period not found');
    }
    period.status = 'closed';
    return period;
  }

  async getVatPeriod(vatPeriodId: string): Promise<VatPeriodView> {
    this.record('reporting.getVatPeriod', { id: vatPeriodId });
    const period = this.vatPeriods.find((p) => p.id === vatPeriodId);
    if (period === undefined) {
      throw new ApiError(404, 'VAT period not found');
    }
    return period;
  }

  async exportZReportCsv(zReportId: string): Promise<string> {
    this.record('reporting.exportZReportCsv', { id: zReportId });
    const csv = 'z_number,business_date,currency\n1,2026-11-13,GBP\n';
    this.exportedCsv.push({ routeKey: 'reporting.exportZReportCsv', zReportIdOrPeriodId: zReportId, csv });
    return csv;
  }

  async exportVatPeriodCsv(vatPeriodId: string): Promise<string> {
    this.record('reporting.exportVatPeriodCsv', { id: vatPeriodId });
    const csv = 'vat_period_id,period_start,period_end,currency\n';
    this.exportedCsv.push({ routeKey: 'reporting.exportVatPeriodCsv', zReportIdOrPeriodId: vatPeriodId, csv });
    return csv;
  }

  async reconcileSettlement(input: { businessDate: string; payouts: Array<{ providerReference: string; settlementDate: string; grossPence: string; feePence: string; reserveHoldPence: string; disputeDebitPence: string }> }): Promise<SettlementView> {
    this.record('reporting.reconcileSettlement', {}, input);
    const gross = input.payouts.reduce((sum, p) => sum + BigInt(p.grossPence), 0n);
    const fees = input.payouts.reduce((sum, p) => sum + BigInt(p.feePence), 0n);
    const reserve = input.payouts.reduce((sum, p) => sum + BigInt(p.reserveHoldPence), 0n);
    const disputes = input.payouts.reduce((sum, p) => sum + BigInt(p.disputeDebitPence), 0n);
    return {
      businessDate: input.businessDate,
      settlementDate: input.payouts[0]?.settlementDate ?? input.businessDate,
      cardGrossPence: gross.toString(),
      feeEstimatePence: fees.toString(),
      settledGrossPence: gross.toString(),
      settledFeePence: fees.toString(),
      reserveHoldTotalPence: reserve.toString(),
      disputeDebitTotalPence: disputes.toString(),
      expectedNetPayoutPence: (gross - fees - reserve - disputes).toString(),
      status: 'reconciled',
      discrepancyReason: null,
    };
  }

  async listWebhookEndpoints(): Promise<WebhookEndpointView[]> {
    this.record('webhooks.listEndpoints');
    return [...this.webhookEndpoints];
  }

  async registerWebhookEndpoint(input: { url: string; eventTypes: string[] }): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
    this.record('webhooks.registerEndpoint', {}, input);
    const endpoint: WebhookEndpointView = { id: this.nextId('webhook-endpoint'), url: input.url, event_types: input.eventTypes, status: 'active' };
    this.webhookEndpoints.push(endpoint);
    return { endpoint, secret: 'whsec_fake-secret-shown-once' };
  }

  async rotateWebhookSecret(endpointId: string, gracePeriodHours = 24): Promise<RotateWebhookSecretView> {
    this.record('webhooks.rotateSecret', { id: endpointId }, { gracePeriodHours });
    const endpoint = this.webhookEndpoints.find((e) => e.id === endpointId);
    if (endpoint === undefined) {
      throw new ApiError(404, 'Resource not found');
    }
    return {
      endpoint_id: endpointId,
      secret: 'whsec_fake-rotated-secret-shown-once',
      previous_secret_expires_at: new Date(Date.now() + gracePeriodHours * 60 * 60 * 1000).toISOString(),
      grace_period_hours: gracePeriodHours,
    };
  }

  async listStatutoryArchives(tenantId: string): Promise<StatutoryArchiveView[]> {
    this.record('compliance.listStatutoryArchives', { tenantId });
    return this.statutoryArchives.filter((a) => a.tenant_id === tenantId);
  }

  async replayDeadLetter(deliveryId: string): Promise<{ id: string; status: string }> {
    this.record('webhooks.replayDeadLetter', { id: deliveryId });
    this.replayedDlq.push(deliveryId);
    return { id: deliveryId, status: 'pending' };
  }

  async discardDeadLetter(deliveryId: string): Promise<{ id: string; status: string }> {
    this.record('webhooks.discardDeadLetter', { id: deliveryId });
    this.discardedDlq.push(deliveryId);
    return { id: deliveryId, status: 'discarded' };
  }

  async getExitStatus(): Promise<ExitStatusView> {
    this.record('exit.getStatus');
    return { ...this.exitStatus };
  }

  async requestTermination(): Promise<ExitStatusView> {
    this.record('exit.requestTermination');
    if (this.exitStatus.openSessionIds.length > 0 || this.exitStatus.blockingPaymentAttemptIds.length > 0) {
      throw new TerminationBlockedError({
        openSessionIds: [...this.exitStatus.openSessionIds],
        blockingPaymentAttemptIds: [...this.exitStatus.blockingPaymentAttemptIds],
      });
    }
    this.exitStatus = { ...this.exitStatus, status: 'termination_requested' };
    return { ...this.exitStatus };
  }

  async beginExportWindow(): Promise<ExitStatusView> {
    this.record('exit.beginExportWindow');
    if (this.exitStatus.status !== 'termination_requested') {
      throw new ApiError(409, 'Export window can only begin after termination is requested');
    }
    const endsAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    this.exitStatus = { ...this.exitStatus, status: 'export_window', exportWindowEndsAt: endsAt };
    return { ...this.exitStatus };
  }

  async runFullExport(): Promise<ExportResultView> {
    this.record('exit.runFullExport');
    if (this.exitStatus.status !== 'export_window' && this.exitStatus.status !== 'termination_requested') {
      throw new ApiError(409, 'Full export requires the export window');
    }
    return { jobId: this.nextId('export-job'), files: { 'manifest.json': '{}' }, manifest: [], totalRows: 0, fileCount: 1 };
  }

  async scheduleHardDelete(): Promise<ExitStatusView> {
    this.record('exit.scheduleHardDelete');
    this.exitStatus = { ...this.exitStatus, status: 'hard_delete_scheduled' };
    return { ...this.exitStatus };
  }
}

