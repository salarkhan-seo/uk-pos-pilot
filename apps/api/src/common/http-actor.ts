/**
 * Demo header auth for controllers (Build-02).
 *
 * Controllers build the Actor from request headers:
 *   x-tenant-id, x-user-id, x-location-id, x-roles (comma-separated).
 *
 * This is LOCAL/TEST auth only — it exists so the API can be exercised
 * without a login flow. Production auth (real JWT sessions, PIN fast
 * login, credential revocation on device loss — D-12) is Build-03 work,
 * and this helper must be replaced by it before the pilot goes live.
 * Services never see headers: they take the Actor object, so swapping
 * the auth mechanism touches controllers only.
 */
import { BadRequestException } from '@nestjs/common';
import type { Actor } from './actor';
import type { RoleName } from './roles';

const VALID_ROLES: RoleName[] = ['owner', 'admin', 'manager', 'cashier'];

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first.trim() === '') {
    throw new BadRequestException(`Missing required header: ${name}`);
  }
  return first.trim();
}

export function actorFromHeaders(headers: Record<string, string | string[] | undefined>): Actor {
  const tenantId = header(headers, 'x-tenant-id');
  const userId = header(headers, 'x-user-id');
  const locationId = header(headers, 'x-location-id');
  const rolesRaw = header(headers, 'x-roles');
  const roles = rolesRaw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  for (const role of roles) {
    if (!(VALID_ROLES as string[]).includes(role)) {
      throw new BadRequestException(`Unknown role in x-roles header: ${role}`);
    }
  }
  if (roles.length === 0) {
    throw new BadRequestException('x-roles header must name at least one role');
  }
  return { tenantId, userId, locationId, roles: roles as RoleName[] };
}
