/**
 * Idempotent demo seeder (Build-08, Objective 3).
 *
 * Populates a demo tenant, location, default warehouse, register,
 * manager + cashier users (plus owner/admin), the four standard UK tax
 * rates, a starter catalogue (including a Challenge 25 item and a
 * case-breakdown item), initial stock movements, and an open register
 * session — plus one demo API key with the `admin` scope (which implies
 * every other scope, Arch-02 §4.3), so the Register UI (3130) and the
 * Admin Shell (3131) can run live against a demo-seeded API with only
 * DEMO_SEED_ON_BOOT=true set.
 *
 * IDEMPOTENCY: every row carries a FIXED UUID (below) and is inserted
 * with ON CONFLICT DO NOTHING on its primary/unique key, so running the
 * seeder twice creates no duplicates. The two append-only cases are
 * guarded by existence checks instead: initial stock is inserted only
 * when a variant has no stock movements yet, and an open session is
 * created only when the register has none. Re-running after demo
 * activity (sales, a closed session) therefore tops the demo back up
 * to "ready to sell" without duplicating anything or resurrecting
 * closed work.
 *
 * DEMO ONLY — never point this at a real tenant. The demo API key and
 * PINs below are fixed, public, documented values for a local demo
 * database (in-memory PGlite or a local data directory). They must
 * never be used against a production database, and DEMO_SEED_ON_BOOT
 * must never be set in production: the flag is the gate, and it is
 * off unless explicitly set to the string 'true'.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { hashPin } from '@uk-pos/shared-kernel';
import type { DB } from './schema';
import { APPROVAL_PERMISSIONS } from './testing';

/* ------------------------------------------------------------------ */
/* Fixed demo identity — the single source of truth. The UI shells    */
/* (apps/register-app, apps/admin-web) default to these same values    */
/* when DEMO_SEED_ON_BOOT=true, so one flag boots a populated till.   */
/* ------------------------------------------------------------------ */

export const DEMO_TENANT_ID = 'bda08d75-c3b4-49d2-9538-166e5b58fa34';
export const DEMO_LOCATION_ID = '3180230d-b91a-45e5-9b18-6e85435c1535';
export const DEMO_WAREHOUSE_ID = '09bd0b6d-fb64-41b1-afa5-076d2c7aca99';
export const DEMO_REGISTER_ID = 'b64daa4c-83f2-4729-8a40-0c0235857ede';

export const DEMO_OWNER_ID = '00ced943-a555-4e41-be77-e9383363e611';
export const DEMO_ADMIN_ID = '49056700-9c4e-4099-86e3-cd869b1bc2f0';
export const DEMO_MANAGER_ID = 'd6be1dc4-3d28-41ad-8c57-958ce5aaa7d1';
export const DEMO_CASHIER_ID = 'a037e258-86f8-4806-b9cf-28b978ad03d3';

export const DEMO_ROLE_OWNER_ID = '3d971f93-396d-4509-8557-0e474eb8a289';
export const DEMO_ROLE_ADMIN_ID = 'b34ac67a-dc63-4157-ba01-235705573c59';
export const DEMO_ROLE_MANAGER_ID = 'fe8662fa-6d25-4314-95a3-e613fe11c720';
export const DEMO_ROLE_CASHIER_ID = 'e0bcc197-2ee3-4136-9ccf-ac7cd976fb68';

export const DEMO_TAX_STANDARD_ID = 'be462f7d-7a2f-414e-b826-76bfbdefdd87';
export const DEMO_TAX_REDUCED_ID = 'd40aa338-33e9-41c3-8aba-ada028ec62ee';
export const DEMO_TAX_ZERO_ID = '5848158d-34ba-45da-9f82-27a47d0138bb';
export const DEMO_TAX_EXEMPT_ID = 'dee27be2-6112-4867-b3d9-c2319f75b361';

export const DEMO_PRODUCT_WIDGET_ID = '455ebc43-93c0-4d36-888d-554a87b76002';
export const DEMO_PRODUCT_GADGET_ID = '51517625-9db5-4110-b84e-728785275eee';
export const DEMO_PRODUCT_VAPE_ID = '3b7d3ec7-abde-4569-b880-b7609d6e1f15';
export const DEMO_PRODUCT_COFFEE_ID = '298559ea-38f5-42e1-9fee-dc7d19ba9c6b';

export const DEMO_VARIANT_WIDGET_ID = '22390979-2da9-4c25-a66b-e2043d353267';
export const DEMO_VARIANT_GADGET_ID = 'b76e239a-1ba6-4a1b-bc06-fed2f9328379';
export const DEMO_VARIANT_VAPE_ID = 'bfae62dc-8e30-49b1-8214-f9696b37b493';
export const DEMO_VARIANT_COFFEE_ID = '97697601-91d7-4116-a7e0-075ce416d142';

export const DEMO_AGE_RESTRICTION_ID = '383109b8-5810-42d4-8023-7e30d79f76cd';

export const DEMO_UNIT_EACH_ID = 'd167689d-5e0b-4058-ad23-c295fc982935';
export const DEMO_UNIT_CASE_ID = 'b71d66bc-5da4-4a7e-923f-c02101577348';
export const DEMO_VARIANT_UNIT_EACH_ID = 'a1ff0776-71bd-4f02-b734-cfa359652921';
export const DEMO_VARIANT_UNIT_CASE_ID = '63b132bb-535b-49f9-8fc1-8ff33c403345';

export const DEMO_API_KEY_ID = 'b792b602-d5aa-492f-b963-0373b3c3626e';

/**
 * Fixed demo API key (DEMO ONLY — see the header). Scope `admin`
 * implies every other scope, so one key serves both UI shells.
 * The full key is stored only as its SHA-256 hash in `api_keys`;
 * this constant is the only place the plaintext exists.
 */
export const DEMO_API_KEY = 'ukp_2eb0267ee1b049098e7f8961d394b5dcc9f8f7e225859725566c9f89235bf909';
export const DEMO_API_KEY_NAME = 'Demo key (DEMO_SEED_ON_BOOT)';
/** Scopes carried by the demo key. */
export const DEMO_API_SCOPES = ['admin'] as const;

/**
 * Documented demo PINs (DEMO ONLY — see the header). The manager PIN
 * deliberately differs from the cashier PIN so the approval flow can
 * be demonstrated end to end; owner/admin share the cashier PIN.
 */
export const DEMO_MANAGER_PIN = '2468';
export const DEMO_CASHIER_PIN = '1234';
export const DEMO_OWNER_PIN = '1234';
export const DEMO_ADMIN_PIN = '1234';

/** Demo tenant / shop details. */
export const DEMO_TENANT_NAME = 'Demo Retail Ltd';
export const DEMO_LOCATION_NAME = 'Demo High Street';
export const DEMO_REGISTER_NAME = 'TILL-01';
/** Opening float for the seeded open session: £50.00. */
export const DEMO_OPENING_FLOAT_PENCE = 5000n;

export interface SeedDemoResult {
  tenantId: string;
  locationId: string;
  warehouseId: string;
  registerId: string;
  userIds: { owner: string; admin: string; manager: string; cashier: string };
  taxRateIds: { standard: string; reduced: string; zero: string; exempt: string };
  productIds: { widget: string; gadget: string; vape: string; coffee: string };
  variantIds: { widget: string; gadget: string; vape: string; coffee: string };
  /** The open register session (found or created by this run). */
  sessionId: string;
  /** The demo API key plaintext — returned once, like ApiKeyService. */
  apiKey: string;
}

type RoleName = 'owner' | 'admin' | 'manager' | 'cashier';

const DEMO_USERS: Array<{
  role: RoleName;
  id: string;
  roleId: string;
  email: string;
  pin: string;
}> = [
  { role: 'owner', id: DEMO_OWNER_ID, roleId: DEMO_ROLE_OWNER_ID, email: 'owner@demo.test', pin: DEMO_OWNER_PIN },
  { role: 'admin', id: DEMO_ADMIN_ID, roleId: DEMO_ROLE_ADMIN_ID, email: 'admin@demo.test', pin: DEMO_ADMIN_PIN },
  { role: 'manager', id: DEMO_MANAGER_ID, roleId: DEMO_ROLE_MANAGER_ID, email: 'manager@demo.test', pin: DEMO_MANAGER_PIN },
  { role: 'cashier', id: DEMO_CASHIER_ID, roleId: DEMO_ROLE_CASHIER_ID, email: 'cashier@demo.test', pin: DEMO_CASHIER_PIN },
];

const DEMO_TAX_RATES: Array<{
  key: keyof SeedDemoResult['taxRateIds'];
  id: string;
  name: string;
  kind: 'standard' | 'reduced' | 'zero' | 'exempt';
  ratePercent: string;
}> = [
  { key: 'standard', id: DEMO_TAX_STANDARD_ID, name: 'Standard 20%', kind: 'standard', ratePercent: '20.00' },
  { key: 'reduced', id: DEMO_TAX_REDUCED_ID, name: 'Reduced 5%', kind: 'reduced', ratePercent: '5.00' },
  { key: 'zero', id: DEMO_TAX_ZERO_ID, name: 'Zero-rated 0%', kind: 'zero', ratePercent: '0.00' },
  { key: 'exempt', id: DEMO_TAX_EXEMPT_ID, name: 'Exempt', kind: 'exempt', ratePercent: '0.00' },
];

interface DemoCatalogueItem {
  key: keyof SeedDemoResult['variantIds'];
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  barcode: string;
  pricePence: bigint;
  costPence: bigint;
  taxRateId: string;
  stock: bigint;
}

const DEMO_CATALOGUE: DemoCatalogueItem[] = [
  {
    key: 'widget', productId: DEMO_PRODUCT_WIDGET_ID, variantId: DEMO_VARIANT_WIDGET_ID,
    productName: 'Demo Widget', variantName: 'Demo Widget',
    sku: 'DEMO-WIDGET-1', barcode: '5012345678900',
    pricePence: 1200n, costPence: 500n, taxRateId: DEMO_TAX_STANDARD_ID, stock: 25n,
  },
  {
    key: 'gadget', productId: DEMO_PRODUCT_GADGET_ID, variantId: DEMO_VARIANT_GADGET_ID,
    productName: 'Demo Gadget', variantName: 'Demo Gadget',
    sku: 'DEMO-GADGET-1', barcode: '5012345678901',
    pricePence: 1050n, costPence: 500n, taxRateId: DEMO_TAX_REDUCED_ID, stock: 12n,
  },
  {
    // Challenge 25 item: vapes are 18+ by law; the gate still verifies
    // the 25 threshold — minAge is the legal minimum, not the threshold.
    key: 'vape', productId: DEMO_PRODUCT_VAPE_ID, variantId: DEMO_VARIANT_VAPE_ID,
    productName: 'Demo Vape Liquid', variantName: 'Demo Vape Liquid',
    sku: 'DEMO-VAPE-1', barcode: '5012345678902',
    pricePence: 800n, costPence: 400n, taxRateId: DEMO_TAX_STANDARD_ID, stock: 40n,
  },
  {
    // Case-breakdown item: sold by the case of 12, breakable into
    // single units — see the variant_units rows below (case = 12 each).
    key: 'coffee', productId: DEMO_PRODUCT_COFFEE_ID, variantId: DEMO_VARIANT_COFFEE_ID,
    productName: 'Demo Coffee Beans — Case of 12', variantName: 'Demo Coffee Beans — Case of 12',
    sku: 'DEMO-COFFEE-CASE', barcode: '5012345678903',
    pricePence: 2400n, costPence: 1200n, taxRateId: DEMO_TAX_STANDARD_ID, stock: 10n,
  },
];

/**
 * Seed the demo data. Idempotent — safe to run twice (or on every boot
 * with DEMO_SEED_ON_BOOT=true): fixed ids + ON CONFLICT DO NOTHING on
 * every row, plus existence guards for the append-only stock ledger
 * and the open session. Runs in one transaction so a failure leaves
 * nothing half-seeded.
 */
export async function seedDemo(db: Kysely<DB>): Promise<SeedDemoResult> {
  const result = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: DEMO_TENANT_ID,
        name: DEMO_TENANT_NAME,
        legal_name: DEMO_TENANT_NAME,
        trading_name: DEMO_TENANT_NAME,
        vat_registered: true,
        vat_number: 'GB123456789',
        status: 'active',
        plan_tier: 'base',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('locations')
      .values({
        id: DEMO_LOCATION_ID,
        tenant_id: DEMO_TENANT_ID,
        name: DEMO_LOCATION_NAME,
        address_line_1: '1 Demo High Street',
        town: 'London',
        postcode: 'E1 1AA',
        country: 'GB',
        timezone: 'Europe/London',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('warehouses')
      .values({
        id: DEMO_WAREHOUSE_ID,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_ID,
        name: 'Demo Store',
        type: 'store',
        is_default: true,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('registers')
      .values({
        id: DEMO_REGISTER_ID,
        tenant_id: DEMO_TENANT_ID,
        location_id: DEMO_LOCATION_ID,
        name: DEMO_REGISTER_NAME,
        device_id: null,
        status: 'active',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Roles + approval permissions (owner/admin/manager hold all six;
    // a cashier holds none and can only request an approval).
    for (const user of DEMO_USERS) {
      await trx
        .insertInto('roles')
        .values({ id: user.roleId, tenant_id: DEMO_TENANT_ID, name: user.role, is_system: true })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
    for (const role of ['owner', 'admin', 'manager'] as const) {
      const roleId = DEMO_USERS.find((u) => u.role === role)?.roleId as string;
      for (const permission of APPROVAL_PERMISSIONS) {
        await trx
          .insertInto('role_permissions')
          .values({ role_id: roleId, permission, discount_limit_pence: null })
          .onConflict((oc) => oc.columns(['role_id', 'permission']).doNothing())
          .execute();
      }
    }

    // Users (one per role) + role/location links.
    for (const user of DEMO_USERS) {
      await trx
        .insertInto('users')
        .values({
          id: user.id,
          tenant_id: DEMO_TENANT_ID,
          email: user.email,
          display_name: `${user.role} User`,
          pin_hash: hashPin(user.pin),
          status: 'active',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('user_roles')
        .values({ user_id: user.id, role_id: user.roleId, location_id: DEMO_LOCATION_ID })
        .onConflict((oc) => oc.columns(['user_id', 'role_id', 'location_id']).doNothing())
        .execute();
      await trx
        .insertInto('user_locations')
        .values({ user_id: user.id, location_id: DEMO_LOCATION_ID })
        .onConflict((oc) => oc.columns(['user_id', 'location_id']).doNothing())
        .execute();
    }

    // Standard UK tax rates.
    for (const rate of DEMO_TAX_RATES) {
      await trx
        .insertInto('tax_rates')
        .values({
          id: rate.id,
          tenant_id: DEMO_TENANT_ID,
          name: rate.name,
          kind: rate.kind,
          rate_percent: rate.ratePercent,
          is_active: true,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }

    // Units of measure for the case-breakdown item.
    await trx
      .insertInto('units_of_measure')
      .values({ id: DEMO_UNIT_EACH_ID, tenant_id: DEMO_TENANT_ID, name: 'Each', abbreviation: 'each', is_base: true })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('units_of_measure')
      .values({ id: DEMO_UNIT_CASE_ID, tenant_id: DEMO_TENANT_ID, name: 'Case', abbreviation: 'case', is_base: false })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Starter catalogue + stock (ledger movement + read-model rows,
    // the way production writes stock — see testing.ts setStock).
    for (const item of DEMO_CATALOGUE) {
      await trx
        .insertInto('products')
        .values({ id: item.productId, tenant_id: DEMO_TENANT_ID, name: item.productName, description: null, is_active: true })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('product_variants')
        .values({
          id: item.variantId,
          tenant_id: DEMO_TENANT_ID,
          product_id: item.productId,
          sku: item.sku,
          barcode: item.barcode,
          name: item.variantName,
          price_pence: item.pricePence,
          cost_pence: item.costPence,
          tax_rate_id: item.taxRateId,
          is_bundle: false,
          is_active: true,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      // Initial stock, once only: a second seed run must not book a
      // second goods_in for the same variant.
      const movements = await trx
        .selectFrom('stock_movements')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('tenant_id', '=', DEMO_TENANT_ID)
        .where('variant_id', '=', item.variantId)
        .executeTakeFirstOrThrow();
      if (Number(movements.n) === 0) {
        await trx
          .insertInto('stock_movements')
          .values({
            tenant_id: DEMO_TENANT_ID,
            variant_id: item.variantId,
            warehouse_id: DEMO_WAREHOUSE_ID,
            location_id: DEMO_LOCATION_ID,
            cause: 'goods_in',
            quantity_change: item.stock,
            quantity_in_base_units: item.stock,
            cost_pence_at_movement: item.costPence,
            created_by_user_id: DEMO_MANAGER_ID,
          })
          .execute();
      }
      await trx
        .insertInto('stock_balances')
        .values({
          variant_id: item.variantId,
          warehouse_id: DEMO_WAREHOUSE_ID,
          tenant_id: DEMO_TENANT_ID,
          location_id: DEMO_LOCATION_ID,
          quantity_on_hand: item.stock,
        })
        .onConflict((oc) =>
          oc.columns(['variant_id', 'warehouse_id']).doUpdateSet({ quantity_on_hand: item.stock }),
        )
        .execute();
      await trx
        .insertInto('stock_valuation')
        .values({
          variant_id: item.variantId,
          warehouse_id: DEMO_WAREHOUSE_ID,
          tenant_id: DEMO_TENANT_ID,
          weighted_average_cost_pence: item.costPence,
          quantity_on_hand: item.stock,
        })
        .onConflict((oc) =>
          oc.columns(['variant_id', 'warehouse_id']).doUpdateSet({
            weighted_average_cost_pence: item.costPence,
            quantity_on_hand: item.stock,
          }),
        )
        .execute();
    }

    // Challenge 25 restriction on the vape (18+, challenge_25 true).
    // Build-11 Objective 2: the variant unique index is now the
    // partial index uq_age_restrictions_variant (WHERE variant_id IS
    // NOT NULL), so the ON CONFLICT arbiter must carry the matching
    // predicate or Postgres cannot infer the index.
    await trx
      .insertInto('age_restrictions')
      .values({
        id: DEMO_AGE_RESTRICTION_ID,
        tenant_id: DEMO_TENANT_ID,
        variant_id: DEMO_VARIANT_VAPE_ID,
        min_age_years: 18,
        challenge_25: true,
        rule_source: 'explicit',
      })
      .onConflict((oc) => oc.column('variant_id').where('variant_id', 'is not', null).doNothing())
      .execute();

    // Case breakdown: the coffee variant sells by the case (12 each)
    // and by the single unit (the base unit).
    await trx
      .insertInto('variant_units')
      .values({
        id: DEMO_VARIANT_UNIT_EACH_ID,
        variant_id: DEMO_VARIANT_COFFEE_ID,
        unit_id: DEMO_UNIT_EACH_ID,
        conversion_factor: '1.0000',
        is_base: true,
      })
      .onConflict((oc) => oc.columns(['variant_id', 'unit_id']).doNothing())
      .execute();
    await trx
      .insertInto('variant_units')
      .values({
        id: DEMO_VARIANT_UNIT_CASE_ID,
        variant_id: DEMO_VARIANT_COFFEE_ID,
        unit_id: DEMO_UNIT_CASE_ID,
        conversion_factor: '12.0000',
        is_base: false,
      })
      .onConflict((oc) => oc.columns(['variant_id', 'unit_id']).doNothing())
      .execute();

    // Demo API key: fixed plaintext, SHA-256 hash stored (the full key
    // is never persisted — same rule as ApiKeyService).
    await trx
      .insertInto('api_keys')
      .values({
        id: DEMO_API_KEY_ID,
        tenant_id: DEMO_TENANT_ID,
        key_hash: createHash('sha256').update(DEMO_API_KEY).digest('hex'),
        key_prefix: DEMO_API_KEY.slice(0, 8),
        name: DEMO_API_KEY_NAME,
        scopes: [...DEMO_API_SCOPES],
        status: 'active',
        last_used_at: null,
        expires_at: null,
        grace_until: null,
      })
      .onConflict((oc) => oc.column('key_hash').doNothing())
      .execute();

    // Open register session (float £50.00), only when the register has
    // no open session — a re-seed after the demo session was closed
    // opens a fresh one instead of duplicating or resurrecting it.
    const openSession = await trx
      .selectFrom('register_sessions')
      .select('id')
      .where('register_id', '=', DEMO_REGISTER_ID)
      .where('status', '=', 'open')
      .executeTakeFirst();
    let sessionId: string;
    if (openSession !== undefined) {
      sessionId = openSession.id;
    } else {
      sessionId = randomUUID();
      await trx
        .insertInto('register_sessions')
        .values({
          id: sessionId,
          tenant_id: DEMO_TENANT_ID,
          register_id: DEMO_REGISTER_ID,
          opened_by_user_id: DEMO_MANAGER_ID,
          float_pence: DEMO_OPENING_FLOAT_PENCE,
          status: 'open',
        })
        .execute();
    }

    return {
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_ID,
      warehouseId: DEMO_WAREHOUSE_ID,
      registerId: DEMO_REGISTER_ID,
      userIds: {
        owner: DEMO_OWNER_ID,
        admin: DEMO_ADMIN_ID,
        manager: DEMO_MANAGER_ID,
        cashier: DEMO_CASHIER_ID,
      },
      taxRateIds: {
        standard: DEMO_TAX_STANDARD_ID,
        reduced: DEMO_TAX_REDUCED_ID,
        zero: DEMO_TAX_ZERO_ID,
        exempt: DEMO_TAX_EXEMPT_ID,
      },
      productIds: {
        widget: DEMO_PRODUCT_WIDGET_ID,
        gadget: DEMO_PRODUCT_GADGET_ID,
        vape: DEMO_PRODUCT_VAPE_ID,
        coffee: DEMO_PRODUCT_COFFEE_ID,
      },
      variantIds: {
        widget: DEMO_VARIANT_WIDGET_ID,
        gadget: DEMO_VARIANT_GADGET_ID,
        vape: DEMO_VARIANT_VAPE_ID,
        coffee: DEMO_VARIANT_COFFEE_ID,
      },
      sessionId,
      apiKey: DEMO_API_KEY,
    };
  });
  return result;
}
