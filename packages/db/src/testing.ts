/**
 * Shared test seeding for the pilot (Build-02).
 *
 * Used by the database integration tests (packages/db/test) and by the API
 * service tests (apps/api/test). Every helper writes through the same
 * Kysely instance the test uses, so the seeded rows obey the same
 * triggers, checks and tenant rules as production writes.
 *
 * Per-role discount limits are NOT stored here: they are percentages
 * defined in code (apps/api/src/modules/admin/roles.ts — cashier 0%,
 * manager 10%, admin 25%, owner unlimited). role_permissions rows are
 * seeded for the approval permissions only; discount_limit_pence stays
 * NULL because the percentage rule governs manual discounts in Build-02.
 */
import type { Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { hashPin } from '@uk-pos/shared-kernel';
import type { DB } from './schema';

export type RoleName = 'owner' | 'admin' | 'manager' | 'cashier';

export const APPROVAL_PERMISSIONS = [
  'discount.manual',
  'price.override',
  'refund.approve',
  'void.post_tender',
  'cash.paid_out',
  'till.close.variance',
] as const;

export interface SeededUser {
  id: string;
  email: string;
  displayName: string;
  role: RoleName;
  /** The PIN seeded for this user (till approvals). Same PIN for every role in tests. */
  pin: string;
}

export interface SeededTenant {
  tenantId: string;
  locationId: string;
  warehouseId: string;
  registerId: string;
  users: Record<RoleName, SeededUser>;
  roleIds: Record<RoleName, string>;
  taxRates: { standard: string; reduced: string; zero: string; exempt: string };
}

export interface SeedTenantOptions {
  name?: string;
  /** PIN seeded for every user. Default '1234'. */
  pin?: string;
}

/**
 * Seed one tenant with a location, a default warehouse, a register, the
 * four built-in roles, one user per role (each holding that role at the
 * location), the approval permissions, and the four UK tax rates.
 */
export async function seedTenant(db: Kysely<DB>, options: SeedTenantOptions = {}): Promise<SeededTenant> {
  const name = options.name ?? 'Acme Retail Ltd';
  const pin = options.pin ?? '1234';
  const pinHash = hashPin(pin);

  const tenant = await db
    .insertInto('tenants')
    .values({
      name,
      legal_name: name,
      trading_name: name,
      vat_registered: true,
      vat_number: 'GB123456789',
      status: 'active',
      plan_tier: 'base',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const tenantId = tenant.id;

  const location = await db
    .insertInto('locations')
    .values({ tenant_id: tenantId, name: 'Main Shop', town: 'London', postcode: 'E1 1AA', country: 'GB', timezone: 'Europe/London' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const locationId = location.id;

  const warehouse = await db
    .insertInto('warehouses')
    .values({ tenant_id: tenantId, location_id: locationId, name: 'Main Store', type: 'store', is_default: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  const warehouseId = warehouse.id;

  const register = await db
    .insertInto('registers')
    .values({ tenant_id: tenantId, location_id: locationId, name: 'TILL-01', status: 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const roleNames: RoleName[] = ['owner', 'admin', 'manager', 'cashier'];
  const roleIds = {} as Record<RoleName, string>;
  for (const roleName of roleNames) {
    const role = await db
      .insertInto('roles')
      .values({ tenant_id: tenantId, name: roleName, is_system: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds[roleName] = role.id;
  }

  // Approval permissions: owner, admin and manager hold all six; a
  // cashier holds none (a cashier can only REQUEST an approval).
  const approverRoles: RoleName[] = ['owner', 'admin', 'manager'];
  for (const roleName of approverRoles) {
    for (const permission of APPROVAL_PERMISSIONS) {
      await db
        .insertInto('role_permissions')
        .values({ role_id: roleIds[roleName] as string, permission, discount_limit_pence: null })
        .execute();
    }
  }

  const users = {} as Record<RoleName, SeededUser>;
  for (const roleName of roleNames) {
    const email = `${roleName}@${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.test`;
    const user = await db
      .insertInto('users')
      .values({ tenant_id: tenantId, email, display_name: `${roleName} User`, pin_hash: pinHash, status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('user_roles')
      .values({ user_id: user.id, role_id: roleIds[roleName] as string, location_id: locationId })
      .execute();
    await db.insertInto('user_locations').values({ user_id: user.id, location_id: locationId }).execute();
    users[roleName] = { id: user.id, email, displayName: `${roleName} User`, role: roleName, pin };
  }

  const taxRates = {} as SeededTenant['taxRates'];
  const rates: Array<[keyof SeededTenant['taxRates'], string, 'standard' | 'reduced' | 'zero' | 'exempt', string]> = [
    ['standard', 'Standard 20%', 'standard', '20.00'],
    ['reduced', 'Reduced 5%', 'reduced', '5.00'],
    ['zero', 'Zero-rated 0%', 'zero', '0.00'],
    ['exempt', 'Exempt', 'exempt', '0.00'],
  ];
  for (const [key, label, kind, percent] of rates) {
    const row = await db
      .insertInto('tax_rates')
      .values({ tenant_id: tenantId, name: label, kind, rate_percent: percent, is_active: true })
      .returning('id')
      .executeTakeFirstOrThrow();
    taxRates[key] = row.id;
  }

  return {
    tenantId,
    locationId,
    warehouseId,
    registerId: register.id,
    users,
    roleIds,
    taxRates,
  };
}

export interface SeedVariantOptions {
  sku?: string;
  barcode?: string;
  name?: string;
  pricePence?: bigint;
  costPence?: bigint;
  taxRateId?: string | null;
  isBundle?: boolean;
}

export interface SeededVariant {
  productId: string;
  variantId: string;
  sku: string;
}

/** Create one product with one variant. No stock is created — use setStock for that. */
export async function seedVariant(
  db: Kysely<DB>,
  tenant: SeededTenant,
  options: SeedVariantOptions = {},
): Promise<SeededVariant> {
  const sku = options.sku ?? `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const product = await db
    .insertInto('products')
    .values({ tenant_id: tenant.tenantId, name: options.name ?? `Product ${sku}`, is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  const variant = await db
    .insertInto('product_variants')
    .values({
      tenant_id: tenant.tenantId,
      product_id: product.id,
      sku,
      barcode: options.barcode ?? null,
      name: options.name ?? `Variant ${sku}`,
      price_pence: options.pricePence ?? 1000n,
      cost_pence: options.costPence ?? 500n,
      tax_rate_id: options.taxRateId ?? tenant.taxRates.standard,
      is_bundle: options.isBundle ?? false,
      is_active: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { productId: product.id, variantId: variant.id, sku };
}

export interface SetStockOptions {
  quantity: bigint;
  costPence?: bigint;
  userId?: string | null;
}

/**
 * Seed stock for a variant the way production does it: a goods_in
 * stock_movement (the ledger is the truth) plus the matching read-model
 * rows (stock_balances, stock_valuation). Test-seed only — the application
 * never writes a balance directly.
 */
export async function setStock(
  db: Kysely<DB>,
  tenant: SeededTenant,
  variantId: string,
  options: SetStockOptions,
): Promise<void> {
  const quantity = options.quantity;
  const costPence = options.costPence ?? 500n;
  await db
    .insertInto('stock_movements')
    .values({
      tenant_id: tenant.tenantId,
      variant_id: variantId,
      warehouse_id: tenant.warehouseId,
      location_id: tenant.locationId,
      cause: 'goods_in',
      quantity_change: quantity,
      quantity_in_base_units: quantity,
      cost_pence_at_movement: costPence,
      created_by_user_id: options.userId ?? tenant.users.manager.id,
    })
    .execute();
  await db
    .insertInto('stock_balances')
    .values({
      variant_id: variantId,
      warehouse_id: tenant.warehouseId,
      tenant_id: tenant.tenantId,
      location_id: tenant.locationId,
      quantity_on_hand: quantity,
    })
    .onConflict((oc) => oc.columns(['variant_id', 'warehouse_id']).doUpdateSet({ quantity_on_hand: quantity }))
    .execute();
  await db
    .insertInto('stock_valuation')
    .values({
      variant_id: variantId,
      warehouse_id: tenant.warehouseId,
      tenant_id: tenant.tenantId,
      weighted_average_cost_pence: costPence,
      quantity_on_hand: quantity,
    })
    .onConflict((oc) =>
      oc.columns(['variant_id', 'warehouse_id']).doUpdateSet({
        weighted_average_cost_pence: costPence,
        quantity_on_hand: quantity,
      }),
    )
    .execute();
}

/* ------------------------------------------------------------------ */
/* Build-03 Objective 1 — auth test helpers                            */
/*                                                                     */
/* These helpers mirror exactly what ApiKeyService does (SHA-256 hash */
/* stored, full key returned once, first-8-chars prefix) so tests can  */
/* seed a key without going through the service under test. The Actor  */
/* shape below is structural — it matches apps/api/src/common/actor.ts */
/* (authKind / scopes / apiKeyId / isTillSession are optional there),  */
/* so no import from the API package is needed here.                   */
/* ------------------------------------------------------------------ */

export interface CreatedTestApiKey {
  keyId: string;
  /** The full key, returned once — keep it in the test, never persist it. */
  key: string;
  keyPrefix: string;
  scopes: string[];
}

/** Insert an api_keys row for a seeded tenant; returns the full key once. */
export async function createTestApiKey(
  db: Kysely<DB>,
  tenant: SeededTenant,
  options: { name?: string; scopes?: string[]; expiresAt?: Date | null } = {},
): Promise<CreatedTestApiKey> {
  const key = `ukp_${randomBytes(32).toString('hex')}`;
  const scopes = options.scopes ?? ['catalogue:read'];
  const row = await db
    .insertInto('api_keys')
    .values({
      tenant_id: tenant.tenantId,
      key_hash: createHash('sha256').update(key).digest('hex'),
      key_prefix: key.slice(0, 8),
      name: options.name ?? 'Test key',
      scopes,
      status: 'active',
      last_used_at: null,
      expires_at: options.expiresAt ?? null,
      grace_until: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { keyId: row.id, key, keyPrefix: key.slice(0, 8), scopes };
}

export interface TestActor {
  tenantId: string;
  userId: string;
  locationId: string;
  roles: RoleName[];
  authKind?: 'session' | 'api-key' | 'demo';
  scopes?: string[];
  apiKeyId?: string;
  isTillSession?: boolean;
}

/**
 * Build an actor carrying API-key authentication (tenant-scoped, with
 * the given scopes) for a seeded tenant. The userId is the seeded user's
 * id; the actor is identified as an API-key actor via authKind/apiKeyId.
 */
export function apiKeyActor(
  tenant: SeededTenant,
  testKey: CreatedTestApiKey,
  role: RoleName = 'manager',
): TestActor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
    authKind: 'api-key',
    scopes: testKey.scopes,
    apiKeyId: testKey.keyId,
  };
}

/** Build a session actor (PIN-authenticated user), optionally a till session. */
export function sessionActor(
  tenant: SeededTenant,
  role: RoleName = 'cashier',
  options: { isTillSession?: boolean } = {},
): TestActor {
  return {
    tenantId: tenant.tenantId,
    userId: tenant.users[role].id,
    locationId: tenant.locationId,
    roles: [role],
    authKind: 'session',
    isTillSession: options.isTillSession ?? false,
  };
}
