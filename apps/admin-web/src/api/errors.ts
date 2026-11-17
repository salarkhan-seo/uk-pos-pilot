/**
 * Error mapping for the typed API client.
 *
 * The API's error contract (Build-02/03):
 *  - 401 — no / invalid credential (AuthGuard).
 *  - 403 — valid credential without the required scope, OR tier-gated
 *    write (`403 PLAN_GATED`, TierGate). The dashboard must tell the
 *    operator which of the two it is — a scope problem is fixed by a
 *    different key, a PLAN_GATED problem is fixed by a tier change.
 *  - 404 — cross-tenant access is 404, NEVER 403 (G-B: the resource's
 *    existence is not leaked). A 404 therefore means "not found OR not
 *    yours" and the dashboard must not distinguish the two to the user.
 *  - 409 — D-11 termination blocked; the response body carries the exact
 *    blocking ids (ExitService.TerminationBlockedError).
 *  - 429 — leaky-bucket rate limit; `Retry-After` seconds and
 *    `error.code = "RATE_LIMITED"`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    opts: { code?: string | null; retryAfterSeconds?: number | null; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = opts.code ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.body = opts.body ?? null;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isUnauthorised(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** 403 with the tier-gate marker (TierGate throws PLAN_GATED). */
  get isPlanGated(): boolean {
    return this.status === 403 && (this.code === 'PLAN_GATED' || /PLAN_GATED/i.test(this.message));
  }
  get isRateLimited(): boolean {
    return this.status === 429 || this.code === 'RATE_LIMITED';
  }
  get isTerminationBlocked(): boolean {
    return this.status === 409;
  }
}

/** D-11 blockers carried on a 409 termination-blocked response. */
export interface TerminationBlockers {
  openSessionIds: string[];
  blockingPaymentAttemptIds: string[];
}

export class TerminationBlockedError extends ApiError {
  readonly openSessionIds: string[];
  readonly blockingPaymentAttemptIds: string[];

  constructor(blockers: TerminationBlockers, message = 'Termination blocked: open sessions or pending/unknown payments must be resolved first') {
    super(409, message, { body: blockers });
    this.name = 'TerminationBlockedError';
    this.openSessionIds = blockers.openSessionIds;
    this.blockingPaymentAttemptIds = blockers.blockingPaymentAttemptIds;
  }
}

/**
 * Thrown by the LIVE client when a dashboard action targets a service
 * surface the API has not exposed over HTTP yet (Build-03 services with
 * no controller route). This is a dashboard-side signal, not an API
 * error: the operation is valid, the route does not exist yet. Carries
 * the service method and the proposed route so the coordinator can wire
 * it without guessing.
 */
export class NotExposedError extends Error {
  readonly serviceMethod: string;
  readonly proposedRoute: string;

  constructor(serviceMethod: string, proposedRoute: string) {
    super(
      `Not exposed over HTTP yet: ${serviceMethod} (proposed route ${proposedRoute}). ` +
        `The API service exists; the coordinator must add the controller route.`,
    );
    this.name = 'NotExposedError';
    this.serviceMethod = serviceMethod;
    this.proposedRoute = proposedRoute;
  }
}

export interface ErrorBody {
  message?: string | string[];
  error?: { code?: string };
  statusCode?: number;
  openSessionIds?: string[];
  blockingPaymentAttemptIds?: string[];
}

/** Map a raw HTTP failure (status + parsed body + headers) to a typed error. */
export function mapHttpError(
  status: number,
  body: unknown,
  headers: Record<string, string | undefined>,
): ApiError {
  const parsed = (body ?? {}) as ErrorBody;
  const message =
    typeof parsed.message === 'string'
      ? parsed.message
      : Array.isArray(parsed.message)
        ? parsed.message.join('; ')
        : `Request failed with status ${status}`;
  const code = parsed.error?.code ?? null;
  const retryAfterRaw = headers['retry-after'];
  const retryAfterSeconds =
    retryAfterRaw !== undefined && retryAfterRaw !== '' ? Number(retryAfterRaw) : null;

  if (status === 409 && Array.isArray(parsed.openSessionIds) && Array.isArray(parsed.blockingPaymentAttemptIds)) {
    return new TerminationBlockedError({
      openSessionIds: parsed.openSessionIds.filter((v): v is string => typeof v === 'string'),
      blockingPaymentAttemptIds: parsed.blockingPaymentAttemptIds.filter((v): v is string => typeof v === 'string'),
    }, message);
  }
  return new ApiError(status, message, {
    code,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    body,
  });
}
