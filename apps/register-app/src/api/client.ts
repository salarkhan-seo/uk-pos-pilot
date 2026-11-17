/**
 * Typed API client for apps/api (Build-05, Objectives 1–2).
 *
 * The register tablet needs exactly two server calls outside delta
 * sync (which has its own SyncClient/SyncTransport): PIN login and
 * price-book entry writes. Before Build-05 there was no typed client
 * for either in this package — only the sync transport — so both are
 * wired here, against the same routes the admin-web client uses.
 *
 *  - POST /v1/auth/pin-login — unguarded (it IS the login). A
 *    successful login stores the returned 2h HMAC session token on
 *    the client, so later calls send it as `Authorization: Bearer`.
 *    Malformed tenant/user/location ids are 400 from the server,
 *    never 500 (apps/api uuid guard).
 *  - POST /v1/price-books/:id/entries (upsert) and
 *    PUT /v1/price-books/:id/entries/:variantId (update-only, 404
 *    when the entry was never set).
 *
 * The transport is injectable (same pattern as SyncClient) so tests
 * record exact requests without a live server; the default is
 * `globalThis.fetch` (Node 20+). No UI code lives here and no
 * business logic: the client maps wire shapes to typed views only.
 */

export type RegisterApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RegisterApiRequest {
  method: RegisterApiMethod;
  /** Full URL (baseUrl + path), built by the client. */
  path: string;
  body?: unknown;
}

export interface RegisterApiResponse {
  status: number;
  body: unknown;
}

export type RegisterApiTransport = (
  request: RegisterApiRequest,
  headers: Record<string, string>,
) => Promise<RegisterApiResponse>;

export class RegisterApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = 'RegisterApiError';
    this.status = status;
    this.body = body;
  }
}

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

export interface PriceBookEntryInput {
  variantId: string;
  /** Integer pence as a decimal string (JSON has no bigint). */
  pricePence: string;
}

export interface PriceBookEntryView {
  price_book_id: string;
  variant_id: string;
  price_pence: string;
}

/**
 * Tax-rate wire view (Build-08 Objective 1) — mirrors
 * apps/api CatalogueService.toTaxRateView: rate_bps is exact integer
 * basis points (20% → 2000); is_exempt = kind 'exempt';
 * is_default_no_tax = kind 'zero' or 'exempt' (the rate charges no tax).
 */
export interface TaxRateView {
  id: string;
  name: string;
  rate_bps: number;
  is_exempt: boolean;
  is_default_no_tax: boolean;
}

/**
 * Parent-product wire view (Build-09 Objective 1) — mirrors
 * apps/api CatalogueService.toProductView (snake_case).
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

/**
 * Warehouse wire view (Build-10 Objective 2) — mirrors the
 * PurchasingService warehouse rows (snake_case).
 */
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

/**
 * Supplier wire view (Build-10 Objective 2) — mirrors the
 * PurchasingService supplier rows (snake_case; money as decimal
 * strings).
 */
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

/**
 * Balance + valuation wire views (Build-11 Objective 1) — mirrors the
 * GET /v1/inventory/balances and GET /v1/inventory/valuation responses
 * (snake_case; money/quantities as decimal strings; the cost fields
 * are null when the variant-warehouse has no stock_valuation row).
 */
export interface BalanceView {
  variant_id: string;
  warehouse_id: string;
  quantity_on_hand: string;
  weighted_avg_cost_pence: string | null;
  total_value_pence: string | null;
  computed_at: string;
}

export interface ValuationRowView {
  variant_id: string;
  total_quantity_on_hand: string;
  weighted_avg_cost_pence: string | null;
  total_value_pence: string | null;
}

export interface ValuationSummaryView {
  valuation: ValuationRowView[];
  totals: { total_quantity_on_hand: string; total_value_pence: string | null };
}

export interface RegisterApiClientOptions {
  baseUrl: string;
  /** Session token from a previous login (pinLogin stores it when it runs). */
  sessionToken?: string | null;
  transport?: RegisterApiTransport;
}

export const fetchTransport: RegisterApiTransport = async (request, headers) => {
  const response = await globalThis.fetch(request.path, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
};

export class RegisterApiClient {
  private readonly baseUrl: string;
  private readonly transport: RegisterApiTransport;
  private token: string | null;

  constructor(options: RegisterApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.transport = options.transport ?? fetchTransport;
    this.token = options.sessionToken ?? null;
  }

  /** Current session token (null until pinLogin succeeds). */
  get sessionToken(): string | null {
    return this.token;
  }

  /** Replace the session token (e.g. after a re-login elsewhere). */
  setSessionToken(token: string | null): void {
    this.token = token;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    method: RegisterApiMethod,
    path: string,
    opts: { body?: unknown; authenticated?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.authenticated ?? true) {
      if (this.token === null) {
        throw new Error('RegisterApiClient: no session token — call pinLogin first');
      }
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const response = await this.transport(
      { method, path: this.url(path), body: opts.body },
      headers,
    );
    if (response.status < 200 || response.status >= 300) {
      // API error bodies use the codebase's `{ error: { code, message } }`
      // convention as well as Nest's top-level `message` — read both,
      // so the caller sees why a request failed instead of a bare
      // status code (same rule as live-transport's httpJson).
      const nested =
        typeof response.body === 'object' &&
        response.body !== null &&
        'error' in response.body &&
        typeof (response.body as { error: unknown }).error === 'object' &&
        (response.body as { error: unknown }).error !== null &&
        'message' in (response.body as { error: Record<string, unknown> }).error &&
        typeof (response.body as { error: { message: unknown } }).error.message === 'string'
          ? (response.body as { error: { message: string } }).error.message
          : null;
      const message =
        typeof response.body === 'object' &&
        response.body !== null &&
        'message' in response.body &&
        typeof (response.body as { message: unknown }).message === 'string'
          ? (response.body as { message: string }).message
          : (nested ?? `Request failed with status ${response.status}`);
      throw new RegisterApiError(response.status, message, response.body);
    }
    return response.body as T;
  }

  /**
   * PIN login. Stores the returned session token on this client, so
   * the till can call setPriceBookEntry / updatePriceBookEntry
   * afterwards without threading the token through every call.
   */
  async pinLogin(input: PinLoginInput): Promise<PinLoginResult> {
    const result = await this.request<PinLoginResult>('POST', '/v1/auth/pin-login', {
      body: input,
      authenticated: false,
    });
    this.token = result.token;
    return result;
  }

  /** Upsert a price-book entry (creates or replaces the price). */
  async setPriceBookEntry(
    priceBookId: string,
    entry: PriceBookEntryInput,
  ): Promise<PriceBookEntryView> {
    return this.request<PriceBookEntryView>(
      'POST',
      `/v1/price-books/${encodeURIComponent(priceBookId)}/entries`,
      { body: { variantId: entry.variantId, pricePence: entry.pricePence } },
    );
  }

  /**
   * Update an existing price-book entry only (404 when the entry was
   * never set — it never creates pricing by typo).
   */
  async updatePriceBookEntry(
    priceBookId: string,
    variantId: string,
    pricePence: string,
  ): Promise<PriceBookEntryView> {
    return this.request<PriceBookEntryView>(
      'PUT',
      `/v1/price-books/${encodeURIComponent(priceBookId)}/entries/${encodeURIComponent(variantId)}`,
      { body: { pricePence } },
    );
  }

  /**
   * List the tenant's active tax rates (Build-08 Objective 1).
   * Authenticated like every other call on this client: the PIN-session
   * token from pinLogin (cashiers and managers both carry
   * catalogue:read). The register never needs the single-rate read —
   * the list is the picker.
   */
  async listTaxRates(): Promise<TaxRateView[]> {
    return this.request<TaxRateView[]>('GET', '/v1/tax-rates');
  }

  /**
   * Parent products + age-restriction rules (Build-09 Objective 1).
   * Authenticated with the PIN-session token: creating needs
   * catalogue:write (manager/admin/owner), listing needs
   * catalogue:read. createAgeRestriction always returns an array —
   * one row for a variant target, one row per current variant for a
   * product target.
   */
  async createProduct(input: CreateProductInput): Promise<ProductView> {
    return this.request<ProductView>('POST', '/v1/catalogue/products', { body: input });
  }

  async listProducts(): Promise<ProductView[]> {
    return this.request<ProductView[]>('GET', '/v1/catalogue/products');
  }

  async getProduct(productId: string): Promise<ProductView> {
    return this.request<ProductView>('GET', `/v1/catalogue/products/${encodeURIComponent(productId)}`);
  }

  async createAgeRestriction(input: CreateAgeRestrictionInput): Promise<AgeRestrictionView[]> {
    return this.request<AgeRestrictionView[]>('POST', '/v1/catalogue/age-restrictions', {
      body: input,
    });
  }

  async listAgeRestrictions(filters: { variantId?: string; productId?: string } = {}): Promise<
    AgeRestrictionView[]
  > {
    const query = new URLSearchParams();
    if (filters.variantId !== undefined) query.set('variantId', filters.variantId);
    if (filters.productId !== undefined) query.set('productId', filters.productId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<AgeRestrictionView[]>('GET', `/v1/catalogue/age-restrictions${suffix}`);
  }

  /**
   * Delete one age-restriction rule (Build-12 Objective 2). The
   * register UI does not surface a delete button — this method exists
   * for API parity with the admin client. A product-level delete
   * also removes the 'inherited' variant rows propagated from it,
   * never an 'explicit' override (server-enforced).
   */
  async deleteAgeRestriction(id: string): Promise<DeleteAgeRestrictionResult> {
    return this.request<DeleteAgeRestrictionResult>(
      'DELETE',
      `/v1/catalogue/age-restrictions/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Warehouses + suppliers (Build-10 Objective 2). Authenticated with
   * the PIN-session token: creating needs stock:write
   * (manager/admin/owner), listing needs stock:read. linkSupplierVariant
   * upserts — re-linking the same pair replaces the row.
   */
  async createWarehouse(input: CreateWarehouseInput): Promise<WarehouseView> {
    return this.request<WarehouseView>('POST', '/v1/inventory/warehouses', { body: input });
  }

  async listWarehouses(): Promise<WarehouseView[]> {
    return this.request<WarehouseView[]>('GET', '/v1/inventory/warehouses');
  }

  async getWarehouse(warehouseId: string): Promise<WarehouseView> {
    return this.request<WarehouseView>(
      'GET',
      `/v1/inventory/warehouses/${encodeURIComponent(warehouseId)}`,
    );
  }

  async createSupplier(input: CreateSupplierInput): Promise<SupplierView> {
    return this.request<SupplierView>('POST', '/v1/purchasing/suppliers', { body: input });
  }

  async listSuppliers(): Promise<SupplierView[]> {
    return this.request<SupplierView[]>('GET', '/v1/purchasing/suppliers');
  }

  async getSupplier(supplierId: string): Promise<SupplierView> {
    return this.request<SupplierView>(
      'GET',
      `/v1/purchasing/suppliers/${encodeURIComponent(supplierId)}`,
    );
  }

  async linkSupplierVariant(
    supplierId: string,
    input: LinkSupplierVariantInput,
  ): Promise<SupplierVariantView> {
    return this.request<SupplierVariantView>(
      'POST',
      `/v1/purchasing/suppliers/${encodeURIComponent(supplierId)}/variants`,
      { body: input },
    );
  }

  /**
   * Balances + valuation (Build-11 Objective 1). Authenticated with
   * the PIN-session token: both need stock:read.
   */
  async getBalances(filters: { variantId?: string; warehouseId?: string } = {}): Promise<{
    balances: BalanceView[];
  }> {
    const query = new URLSearchParams();
    if (filters.variantId !== undefined) query.set('variantId', filters.variantId);
    if (filters.warehouseId !== undefined) query.set('warehouseId', filters.warehouseId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<{ balances: BalanceView[] }>('GET', `/v1/inventory/balances${suffix}`);
  }

  async getValuation(filters: { variantId?: string; warehouseId?: string } = {}): Promise<ValuationSummaryView> {
    const query = new URLSearchParams();
    if (filters.variantId !== undefined) query.set('variantId', filters.variantId);
    if (filters.warehouseId !== undefined) query.set('warehouseId', filters.warehouseId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.request<ValuationSummaryView>('GET', `/v1/inventory/valuation${suffix}`);
  }
}
