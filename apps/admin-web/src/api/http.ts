/**
 * Minimal HTTP transport for the typed client.
 *
 * The transport is injectable so tests can record exact requests (method,
 * path, headers, body) without a live server, and so the client never
 * depends on a browser `fetch` — `globalThis.fetch` (Node 20+) is the
 * default. Auth follows apps/api/src/modules/admin/auth.guard.ts:
 *  - API key (`ukp_…`) or PIN-session token as `Authorization: Bearer <token>`
 *    (API keys are also accepted as `X-Api-Key` when `useApiKeyHeader` is set);
 *  - `x-tenant-id` when the caller knows the tenant (the guard answers
 *    404, never 403, when the addressed tenant differs from the
 *    credential's tenant — G-B).
 *  - Build-02 demo-header routes (catalogue/inventory/sales/audit) still
 *    read the actor from `x-tenant-id` / `x-user-id` / `x-location-id` /
 *    `x-roles`; the client sends those headers too when supplied, so one
 *    client works against both the demo-header routes and the guarded
 *    routes. Demo headers are local/test auth only and must be replaced
 *    before the pilot goes live (README).
 */
import { mapHttpError } from './errors';
import type { ApiCredentials } from './types';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (null when the response has no JSON body). */
  body: unknown;
}

export type HttpTransport = (req: HttpRequest, headers: Record<string, string>) => Promise<HttpResponse>;

export interface DemoActorHeaders {
  userId?: string;
  locationId?: string;
  roles?: string[];
}

export function buildHeaders(credentials: ApiCredentials, demo?: DemoActorHeaders): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials.useApiKeyHeader) {
    headers['X-Api-Key'] = credentials.token;
  } else {
    headers['Authorization'] = `Bearer ${credentials.token}`;
  }
  if (credentials.tenantId !== undefined) {
    headers['x-tenant-id'] = credentials.tenantId;
  }
  const locationId = demo?.locationId ?? credentials.locationId;
  if (locationId !== undefined) {
    headers['x-location-id'] = locationId;
  }
  if (demo?.userId !== undefined) {
    headers['x-user-id'] = demo.userId;
  }
  if (demo?.roles !== undefined && demo.roles.length > 0) {
    headers['x-roles'] = demo.roles.join(',');
  }
  return headers;
}

export function buildUrl(baseUrl: string, req: HttpRequest): string {
  const url = new URL(req.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (req.query !== undefined) {
    for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

export const fetchTransport: HttpTransport = async (req, headers) => {
  // The base URL is baked into the request path by PosApiClient via
  // buildUrl; fetchTransport receives the full URL in req.path.
  const response = await globalThis.fetch(req.path, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
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
  const outHeaders: Record<string, string | undefined> = {};
  response.headers.forEach((value, name) => {
    outHeaders[name.toLowerCase()] = value;
  });
  return { status: response.status, headers: outHeaders, body };
};

/** Execute one request and throw a typed ApiError on any non-2xx status. */
export async function requestJson<T>(
  transport: HttpTransport,
  credentials: ApiCredentials,
  baseUrl: string,
  req: HttpRequest,
  demo?: DemoActorHeaders,
): Promise<T> {
  const headers = buildHeaders(credentials, demo);
  const url = buildUrl(baseUrl, req);
  const response = await transport({ ...req, path: url }, headers);
  if (response.status < 200 || response.status >= 300) {
    throw mapHttpError(response.status, response.body, response.headers);
  }
  return response.body as T;
}
