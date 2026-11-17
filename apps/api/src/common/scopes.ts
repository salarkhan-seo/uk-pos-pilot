/**
 * API scopes (Build-03 Objective 1; Arch-02 §4.3).
 *
 * Least privilege, per integration key: a key carries only the scopes it
 * needs, and every scope check is server-side on each request. The
 * 'admin' scope implies every other scope (Arch-02 §4.3: admin manages
 * users, roles, locations, registers, API keys, webhook endpoints and
 * exports).
 *
 * Session (PIN) actors carry roles, not scopes: scopesForRoles maps a
 * role set to the scopes that role may exercise through the API, so the
 * AuthGuard can apply one scope check to both auth kinds. Owners and
 * admins hold every scope; managers hold the operational read/write
 * scopes; cashiers hold the till read scopes plus sales write (taking
 * tenders is the till's job).
 */
import type { RoleName } from './roles';

export const SCOPES = [
  'catalogue:read',
  'catalogue:write',
  'sales:read',
  'sales:write',
  'stock:read',
  'stock:write',
  'payments:read',
  'accounting:read',
  'admin',
] as const;

export type ApiScope = (typeof SCOPES)[number];

export function isValidScope(scope: string): scope is ApiScope {
  return (SCOPES as readonly string[]).includes(scope);
}

/** True when the granted scopes cover the required scope ('admin' covers all). */
export function scopeIncludes(granted: readonly string[], required: ApiScope): boolean {
  return granted.includes('admin') || granted.includes(required);
}

/** Scopes a PIN-session actor may exercise, derived from its roles. */
export function scopesForRoles(roles: readonly RoleName[]): ApiScope[] {
  if (roles.includes('owner') || roles.includes('admin')) {
    return [...SCOPES];
  }
  const scopes = new Set<ApiScope>(['catalogue:read', 'sales:read', 'stock:read', 'payments:read']);
  if (roles.includes('manager')) {
    scopes.add('catalogue:write');
    scopes.add('sales:write');
    scopes.add('stock:write');
    scopes.add('accounting:read');
  }
  if (roles.includes('cashier')) {
    scopes.add('sales:write');
  }
  return [...scopes];
}
