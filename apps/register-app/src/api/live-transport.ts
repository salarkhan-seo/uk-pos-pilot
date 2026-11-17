/**
 * Live HTTP wiring for the register app (Build-06, Objective 3).
 *
 * The register talks to apps/api over plain `fetch` — no NestJS, no
 * generated client. Three seams, each injectable for tests:
 *
 *  - `createHttpSyncTransport` — the SyncTransport the SyncClient
 *    needs (POST /v1/sync/handshake + /v1/sync/flush). Bearer token:
 *    the PIN-session token when logged in, else the REGISTER_API_KEY
 *    env fallback, else no token (the server answers 401, surfaced
 *    as a notice — never a crash).
 *  - `LiveSalesClient` — the sales endpoints the register drives for
 *    ONLINE checkout. Build-10: the sales controllers are AuthGuarded,
 *    so the client sends `Authorization: Bearer ...` (the PIN-session
 *    token when logged in, else the REGISTER_API_KEY env fallback,
 *    else no token and the server answers 401) alongside the actor
 *    headers (x-tenant-id / x-location-id still matter — see the
 *    LiveSalesClientOptions note). The actor comes from the shell's
 *    logged-in actor (updated by pinLogin), falling back to the
 *    device-configured ids. Money crosses the boundary as decimal
 *    strings (JSON has no bigint).
 *  - `CompositeReportingClient` — the ReportingClient the
 *    TillSessionController needs. There are NO till-session endpoints
 *    in apps/api (ReportingService has openSession/endSession/
 *    closeSession, but no controller exposes them — checked
 *    2026-11-14), so sessions are tracked by the local tracker and
 *    the Z-report it issues is labelled a LOCAL record (see
 *    renderer). getZReport goes LIVE (GET /v1/reporting/z-reports/:id,
 *    accounting:read) for server-issued ids, and to the local tracker
 *    for `local-*` ids.
 *
 * W-12 live mapping (the only HTTP route for it is
 * POST /v1/sales/payment-attempts/:id/outcome — the PaymentsService
 * resolveUnknownByProviderQuery / reconcileTerminal /
 * resolveUnknownByManagerDecision paths have no HTTP routes):
 *  - poll / reconcile: the operator keys in the terminal result
 *    (the API's documented stand-in for the terminal callback) and
 *    the outcome is recorded.
 *  - manager void & retry: record 'declined' on the old attempt —
 *    the order stays open for a fresh card tender, which creates a
 *    new attempt. The old attempt is never silently approved.
 *  - manager standalone reference: record 'approved' with the
 *    physical terminal reference the manager typed in.
 */

import { RegisterApiError } from './client';
import type { ReportingClient } from '../session/till-session';
import type { SyncTransport } from '../sync/sync-client';
import type { AgeVerificationWire } from '../../../api/src/modules/sales/sales.service';
import type {
  FlushRequest,
  FlushResponse,
  HandshakeRequest,
  HandshakeResponse,
} from '../../../api/src/modules/sync/sync.dto';

export type LiveFetch = typeof globalThis.fetch;

/** Actor headers sent with every live call (x-tenant-id / x-location-id still matter under AuthGuard; x-user-id / x-roles are carried for the shell's own actor display). */
export interface ActorHeaders {
  tenantId: string;
  userId: string;
  locationId: string;
  roles: string[];
}

export function actorHeaders(actor: ActorHeaders): Record<string, string> {
  return {
    'x-tenant-id': actor.tenantId,
    'x-user-id': actor.userId,
    'x-location-id': actor.locationId,
    'x-roles': actor.roles.join(','),
  };
}

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function requestTimeoutMs(): number {
  const raw = process.env.REGISTER_API_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

/** One JSON request against the API. Throws RegisterApiError on non-2xx. */
async function httpJson<T>(
  baseUrl: string,
  path: string,
  fetchImpl: LiveFetch,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetchImpl(url, {
    method: init.method,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(requestTimeoutMs()),
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
  if (response.status < 200 || response.status >= 300) {
    // API error bodies use the codebase's `{ error: { code, message } }`
    // convention (e.g. INVALID_UUID, AGE_VERIFICATION_REQUIRED) as
    // well as Nest's top-level `message` — read both, so the cashier
    // sees why a request failed instead of a bare status code.
    const nested =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'object' &&
      (body as { error: unknown }).error !== null &&
      'message' in (body as { error: Record<string, unknown> }).error &&
      typeof (body as { error: { message: unknown } }).error.message === 'string'
        ? (body as { error: { message: string } }).error.message
        : null;
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
        ? (body as { message: string }).message
        : (nested ?? `Request failed with status ${response.status}`);
    throw new RegisterApiError(response.status, message, body);
  }
  return body as T;
}

/**
 * Probe whether the API answers at all. Never throws: true on any 2xx
 * from the public module-status endpoint, false otherwise (refused,
 * timeout, 4xx/5xx). The shell uses this to decide live vs offline.
 */
export async function probeApi(baseUrl: string, fetchImpl: LiveFetch = globalThis.fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/sales/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

// -- Sync transport --------------------------------------------------------

export interface HttpSyncTransportOptions {
  baseUrl: string;
  /** Current Bearer token, or null when logged out (sync then 401s). */
  getToken: () => string | null;
  /**
   * Tenant/location actor. The sync routes are AuthGuarded and location-scoped:
   * without `x-tenant-id` / `x-location-id` the API actor carries an empty
   * locationId, which fails the register lookup's uuid comparison (500).
   * The server always passes its own `getActor`; the option stays optional
   * only so unit tests can construct a Bearer-only transport.
   */
  getActor?: () => ActorHeaders;
  fetchImpl?: LiveFetch;
}

/** SyncTransport over real HTTP (handshake + flush). */
export function createHttpSyncTransport(options: HttpSyncTransportOptions): SyncTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const authHeaders = (): Record<string, string> => {
    const token = options.getToken();
    const bearer: Record<string, string> =
      token === null ? {} : { Authorization: `Bearer ${token}` };
    const actor = options.getActor === undefined ? {} : actorHeaders(options.getActor());
    return { ...bearer, ...actor };
  };
  return {
    handshake: (request: HandshakeRequest): Promise<HandshakeResponse> =>
      httpJson<HandshakeResponse>(options.baseUrl, '/v1/sync/handshake', fetchImpl, {
        method: 'POST',
        headers: authHeaders(),
        body: request,
      }),
    flush: (request: FlushRequest): Promise<FlushResponse> =>
      httpJson<FlushResponse>(options.baseUrl, '/v1/sync/flush', fetchImpl, {
        method: 'POST',
        headers: authHeaders(),
        body: request,
      }),
  };
}

// -- Sales client ----------------------------------------------------------

export type SalesTenderType = 'cash' | 'card' | 'gift_card' | 'store_credit' | 'loyalty_points';

export interface CreateOrderLineInput {
  variantId: string;
  /** Quantity in base units, as a decimal string. */
  quantity: string;
  manualDiscountPence?: string;
}

export interface CreateOrderInput {
  locationId: string;
  registerId?: string | null;
  customerId?: string | null;
  lines: CreateOrderLineInput[];
}

export interface CreateOrderResponse {
  id: string;
  status: string;
  total_pence: string;
  order_number: string;
}

export interface AddTenderInput {
  tenderType: SalesTenderType;
  amountPence: string;
  giftCardCode?: string;
  customerId?: string;
  /**
   * Age verifications to send with the tender (Build-09, Objective
   * 2) — wire shape, snake_case. The server records them against the
   * order and enforces Challenge 25 before reserving stock.
   */
  age_verifications?: AgeVerificationWire[];
}

export interface AddTenderResponse {
  id: string;
  order_id: string;
  tender_type: SalesTenderType;
  amount_pence: string;
  /** Server payment attempt id for card tenders, else null. */
  payment_attempt_id: string | null;
}

export interface ReceiptLineView {
  taxRateKind: string;
  taxRatePercent: string;
  grossPence: string;
  vatPence: string;
  netPence: string;
}

export interface ReceiptView {
  receiptNumber: string;
  orderId: string;
  issuedAt: string;
  lines: ReceiptLineView[];
  totalPence: string;
  vatInvoiceNotice: string;
}

export interface CompleteOrderResponse {
  order: { id: string; status: string; total_pence: string };
  receipt: ReceiptView;
}

export type PaymentOutcome = 'approved' | 'declined' | 'unknown';

export interface ZReportView {
  id: string;
  z_number: string;
  business_date: string;
  register_id: string;
  gross_pence: string;
  net_pence: string;
  vat_pence: string;
  cash_variance_pence: string;
}

export interface LiveSalesClientOptions {
  baseUrl: string;
  /** Current actor (logged-in user; updated by pinLogin). */
  getActor: () => ActorHeaders;
  /**
   * Current Bearer token, or null when logged out. Sales routes are
   * AuthGuarded (Build-10): the token is sent as `Authorization:
   * Bearer ...` alongside the actor headers — the API key
   * (REGISTER_API_KEY, scope `admin`) or the PIN session token. The
   * `x-tenant-id` header still matters (AuthGuard cross-tenant 404)
   * and `x-location-id` still sets the API-key actor's location
   * (createOrder requires it to match the body's locationId).
   */
  getToken?: () => string | null;
  fetchImpl?: LiveFetch;
}

/**
 * Live sales + reporting reads against apps/api. All calls send the
 * actor headers plus, when a token is available, `Authorization:
 * Bearer ...` (Build-10 — the sales routes are AuthGuarded).
 */
export class LiveSalesClient {
  private readonly baseUrl: string;
  private readonly getActor: () => ActorHeaders;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: LiveFetch;

  constructor(options: LiveSalesClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getActor = options.getActor;
    this.getToken = options.getToken ?? (() => null);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    const token = this.getToken();
    return {
      ...actorHeaders(this.getActor()),
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    };
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResponse> {
    return httpJson<CreateOrderResponse>(this.baseUrl, '/v1/sales/orders', this.fetchImpl, {
      method: 'POST',
      headers: this.headers(),
      body: input,
    });
  }

  async addTender(orderId: string, input: AddTenderInput): Promise<AddTenderResponse> {
    return httpJson<AddTenderResponse>(
      this.baseUrl,
      `/v1/sales/orders/${encodeURIComponent(orderId)}/tenders`,
      this.fetchImpl,
      { method: 'POST', headers: this.headers(), body: input },
    );
  }

  async completeOrder(
    orderId: string,
    ageVerifications?: AgeVerificationWire[],
  ): Promise<CompleteOrderResponse> {
    return httpJson<CompleteOrderResponse>(
      this.baseUrl,
      `/v1/sales/orders/${encodeURIComponent(orderId)}/complete`,
      this.fetchImpl,
      {
        method: 'POST',
        headers: this.headers(),
        body:
          ageVerifications === undefined ? {} : { age_verifications: ageVerifications },
      },
    );
  }

  async recordPaymentAttemptOutcome(
    attemptId: string,
    input: { outcome: PaymentOutcome; providerReference?: string },
  ): Promise<unknown> {
    return httpJson<unknown>(
      this.baseUrl,
      `/v1/sales/payment-attempts/${encodeURIComponent(attemptId)}/outcome`,
      this.fetchImpl,
      { method: 'POST', headers: this.headers(), body: input },
    );
  }

  async getReceipt(orderId: string): Promise<ReceiptView> {
    return httpJson<ReceiptView>(
      this.baseUrl,
      `/v1/sales/orders/${encodeURIComponent(orderId)}/receipt`,
      this.fetchImpl,
      { method: 'GET', headers: this.headers() },
    );
  }

  /**
   * Void a live order. A void after any tender was taken requires a
   * manager `void_post_tender` approval id (see LiveApprovalsClient);
   * a void before any tender needs none.
   */
  async voidOrder(
    orderId: string,
    input: { reason?: string; approvalEventsId?: string | null } = {},
  ): Promise<{ orderId: string; status: string }> {
    return httpJson<{ orderId: string; status: string }>(
      this.baseUrl,
      `/v1/sales/orders/${encodeURIComponent(orderId)}/void`,
      this.fetchImpl,
      {
        method: 'POST',
        headers: this.headers(),
        body: { reason: input.reason, approvalEventsId: input.approvalEventsId ?? null },
      },
    );
  }
}

/**
 * Live approvals client (Build-06): POST /v1/approvals creates a
 * manager approval event after verifying the approver's PIN against
 * the stored hash. Demo-header auth — the approver is the actor in
 * the headers and must differ from the requester. The PIN is sent in
 * the request body only and is never stored.
 */
export class LiveApprovalsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getActor: () => ActorHeaders,
    private readonly fetchImpl: LiveFetch = globalThis.fetch,
  ) {}

  async createApproval(input: {
    action:
      | 'discount_above_limit'
      | 'price_override'
      | 'refund_above_threshold'
      | 'void_post_tender'
      | 'cash_paid_out'
      | 'till_close_variance';
    requestedByUserId: string;
    approverPin: string;
    orderId?: string | null;
    reason?: string | null;
  }): Promise<{ id: string; action: string }> {
    const actor = this.getActor();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...actorHeaders(actor),
      },
      body: JSON.stringify({
        action: input.action,
        requestedByUserId: input.requestedByUserId,
        approverPin: input.approverPin,
        orderId: input.orderId ?? null,
        reason: input.reason ?? null,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Approval request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    const text = await response.text();
    return JSON.parse(text) as { id: string; action: string };
  }
}

// -- Reporting client (local till tracker + live Z-report read) -----------

export interface LiveReportingClientOptions {
  baseUrl: string;
  /** Current Bearer token, or null when logged out. */
  getToken: () => string | null;
  fetchImpl?: LiveFetch;
}

/**
 * Local till-session tracker. There is no API endpoint for till
 * sessions, so the register tracks its own sessions in memory:
 * expected cash is the opening float plus the cash movements recorded
 * through this shell (cash sales are NOT included — the server is the
 * source of truth for those, and the UI labels the figure as local).
 * The Z-report id it issues is prefixed `local-` so the composite
 * below (and the renderer) can tell a local record from a server one.
 */
export class LocalSessionTracker implements ReportingClient {
  private sessions = 0;
  private current: {
    sessionId: string;
    openingFloatPence: bigint;
    movementsPence: bigint;
  } | null = null;

  async openSession(input: {
    registerId: string;
    openingFloatPence: bigint;
    approvalEventId?: string | null;
  }): Promise<{ sessionId: string; warning: string | null }> {
    this.sessions += 1;
    const sessionId = `local-session-${this.sessions}`;
    this.current = { sessionId, openingFloatPence: input.openingFloatPence, movementsPence: 0n };
    return {
      sessionId,
      warning:
        input.openingFloatPence === 0n
          ? 'Session opened with no float: float must be counted and recorded before trading; manager approval recorded.'
          : null,
    };
  }

  async recordCashMovement(input: {
    sessionId: string;
    type: 'cash_in' | 'cash_out' | 'petty_cash_in' | 'petty_cash_out';
    amountPence: bigint;
    note: string;
    approvalEventId?: string | null;
  }): Promise<{ movementId: string }> {
    if (this.current === null || this.current.sessionId !== input.sessionId) {
      throw new Error('No such local session — open a session before recording cash movements');
    }
    const delta =
      input.type === 'cash_in' || input.type === 'petty_cash_in' ? input.amountPence : -input.amountPence;
    this.current.movementsPence += delta;
    return { movementId: `local-movement-${Date.now()}` };
  }

  async endSession(sessionId: string): Promise<{ sessionId: string; expectedCashPence: bigint }> {
    if (this.current === null || this.current.sessionId !== sessionId) {
      throw new Error('No such local session — open a session before ending it');
    }
    // Local figure only: float + locally recorded movements. Server
    // sales are excluded (no till-session endpoint exists to ask).
    return {
      sessionId,
      expectedCashPence: this.current.openingFloatPence + this.current.movementsPence,
    };
  }

  async closeSession(input: {
    sessionId: string;
    countedCashPence: bigint;
    varianceReason?: string | null;
    approvalEventId?: string | null;
    carryForward?: { attemptIds: string[]; approvalEventId: string; note: string } | null;
  }): Promise<{ sessionId: string; zReportId: string; zNumber: string }> {
    if (this.current === null || this.current.sessionId !== input.sessionId) {
      throw new Error('No such local session — open a session before closing it');
    }
    const n = this.sessions;
    this.current = null;
    return { sessionId: input.sessionId, zReportId: `local-z-${n}`, zNumber: `LOCAL-Z-${n}` };
  }

  async getZReport(zReportId: string): Promise<{ zReportId: string; zNumber: string }> {
    const match = /^local-z-(\d+)$/.exec(zReportId);
    if (match === null) {
      throw new Error(`Unknown local Z-report: ${zReportId}`);
    }
    return { zReportId, zNumber: `LOCAL-Z-${match[1]}` };
  }
}

/**
 * ReportingClient for the till controller: sessions stay local (see
 * LocalSessionTracker), while getZReport for a SERVER-issued id goes
 * live (GET /v1/reporting/z-reports/:id, accounting:read scope — a
 * manager token is needed; a cashier token gets 403, surfaced as an
 * error, never a crash).
 */
export class CompositeReportingClient implements ReportingClient {
  private readonly local = new LocalSessionTracker();
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: LiveFetch;

  constructor(options: LiveReportingClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getToken = options.getToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  openSession(input: {
    registerId: string;
    openingFloatPence: bigint;
    approvalEventId?: string | null;
  }): Promise<{ sessionId: string; warning: string | null }> {
    return this.local.openSession(input);
  }

  recordCashMovement(input: {
    sessionId: string;
    type: 'cash_in' | 'cash_out' | 'petty_cash_in' | 'petty_cash_out';
    amountPence: bigint;
    note: string;
    approvalEventId?: string | null;
  }): Promise<{ movementId: string }> {
    return this.local.recordCashMovement(input);
  }

  endSession(sessionId: string): Promise<{ sessionId: string; expectedCashPence: bigint }> {
    return this.local.endSession(sessionId);
  }

  closeSession(input: {
    sessionId: string;
    countedCashPence: bigint;
    varianceReason?: string | null;
    approvalEventId?: string | null;
    carryForward?: { attemptIds: string[]; approvalEventId: string; note: string } | null;
  }): Promise<{ sessionId: string; zReportId: string; zNumber: string }> {
    return this.local.closeSession(input);
  }

  async getZReport(zReportId: string): Promise<{ zReportId: string; zNumber: string }> {
    if (zReportId.startsWith('local-')) {
      return this.local.getZReport(zReportId);
    }
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const view = await httpJson<ZReportView>(
      this.baseUrl,
      `/v1/reporting/z-reports/${encodeURIComponent(zReportId)}`,
      this.fetchImpl,
      { method: 'GET', headers },
    );
    return { zReportId: view.id, zNumber: `Z-${view.z_number}` };
  }
}
