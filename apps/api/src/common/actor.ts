/**
 * Actor — who is making the request (Build-02, Objective 2).
 *
 * Services take an Actor explicitly on every method; there is no ambient
 * request context in the service layer. Controllers build the Actor from
 * request headers (demo header auth — see controllers; production auth
 * with real JWT sessions is Build-03 work).
 *
 * Tenant isolation (G-B) is enforced by the Actor: every repository query
 * filters tenant_id = actor.tenantId, and a resource that belongs to
 * another tenant is reported as NOT FOUND (never 403), so a caller cannot
 * enumerate other tenants' resources.
 *
 * Location scoping: the Actor works at ONE location (the till's
 * location). A resource at another location is likewise not found, and
 * manager approvals are valid only at the approver's location.
 */
import type { RoleName } from './roles';
import type { ApiScope } from './scopes';

export interface Actor {
  tenantId: string;
  userId: string;
  locationId: string;
  roles: RoleName[];
  /**
   * Build-03: how this actor authenticated. 'demo' is the Build-02
   * header auth (local/test only); 'session' is a PIN-issued HMAC
   * session token; 'api-key' is a scoped API key. Absent = demo/legacy.
   */
  authKind?: 'session' | 'api-key' | 'demo';
  /** Scopes carried by an API-key actor (Arch-02 §4.3). */
  scopes?: ApiScope[];
  /** The api_keys row id, for API-key actors (rate-limit bucketing). */
  apiKeyId?: string;
  /**
   * True when the session is a till session. Checkout endpoints called
   * with a till session actor are exempt from hard 429 rejection
   * (Arch-02 §2.4: the till must never lose a sale because of a 429).
   */
  isTillSession?: boolean;
}

export function actorHasRole(actor: Actor, role: RoleName): boolean {
  return actor.roles.includes(role);
}

/** Manager, admin or owner — the roles that may approve (never cashier). */
export function actorCanApprove(actor: Actor): boolean {
  return actor.roles.some((role) => role === 'manager' || role === 'admin' || role === 'owner');
}
