/**
 * Catalogue validation — client-side mirrors of the server rules.
 * The server is always the authority (DB triggers + CatalogueService);
 * these checks exist so the dashboard fails fast with a clear message
 * instead of round-tripping an obviously invalid form.
 *
 * Limits (Build-02, proven by db tests):
 *  - max 4 attributes per variant (5th attribute rejected by the DB);
 *  - max 20 bundle components per bundle (21st rejected by the DB);
 *  - case-breakdown units: a variant unit names a conversion factor to
 *    base units; the checkout decrement converts via
 *    variant_units.conversion_factor and stamps the order line.
 */
export const MAX_ATTRIBUTES_PER_VARIANT = 4;
export const MAX_BUNDLE_COMPONENTS = 20;

export interface VariantAttribute {
  name: string;
  value: string;
}

export interface BundleComponentInput {
  variantId: string;
  quantity: number;
}

export interface VariantUnitInput {
  unitId: string;
  /** Integer conversion factor to base units (e.g. case of 12 → 12). */
  conversionFactor: number;
  isBaseUnit: boolean;
}

export function validateAttributes(attributes: VariantAttribute[]): string[] {
  const errors: string[] = [];
  if (attributes.length > MAX_ATTRIBUTES_PER_VARIANT) {
    errors.push(`A variant may have at most ${MAX_ATTRIBUTES_PER_VARIANT} attributes; got ${attributes.length}.`);
  }
  const seen = new Set<string>();
  for (const attr of attributes) {
    if (attr.name.trim() === '') {
      errors.push('Attribute names must not be blank.');
    }
    const key = attr.name.trim().toLowerCase();
    if (seen.has(key)) {
      errors.push(`Duplicate attribute name: ${attr.name}.`);
    }
    seen.add(key);
  }
  return errors;
}

export function validateBundleComponents(components: BundleComponentInput[], bundleVariantId: string): string[] {
  const errors: string[] = [];
  if (components.length > MAX_BUNDLE_COMPONENTS) {
    errors.push(`A bundle may have at most ${MAX_BUNDLE_COMPONENTS} components; got ${components.length}.`);
  }
  for (const component of components) {
    if (component.variantId === bundleVariantId) {
      errors.push('A bundle cannot contain itself as a component.');
    }
    if (!Number.isInteger(component.quantity) || component.quantity <= 0) {
      errors.push(`Bundle component ${component.variantId} must have a positive integer quantity.`);
    }
  }
  const seen = new Set<string>();
  for (const component of components) {
    if (seen.has(component.variantId)) {
      errors.push(`Duplicate bundle component: ${component.variantId}.`);
    }
    seen.add(component.variantId);
  }
  return errors;
}

export function validateVariantUnits(units: VariantUnitInput[]): string[] {
  const errors: string[] = [];
  const baseUnits = units.filter((u) => u.isBaseUnit);
  if (baseUnits.length !== 1) {
    errors.push(`Exactly one base unit is required; got ${baseUnits.length}.`);
  }
  for (const unit of units) {
    if (!Number.isInteger(unit.conversionFactor) || unit.conversionFactor <= 0) {
      errors.push(`Unit ${unit.unitId} must have a positive integer conversion factor to base units.`);
    }
    if (unit.isBaseUnit && unit.conversionFactor !== 1) {
      errors.push(`Base unit ${unit.unitId} must have conversion factor 1.`);
    }
  }
  return errors;
}

/** Integer-pence amount as a decimal string; rejects floats/negatives where not allowed. */
export function validatePenceString(value: string, field: string, opts: { allowNegative?: boolean } = {}): string[] {
  if (!/^-?\d+$/.test(value.trim())) {
    return [`${field} must be an integer number of pence (decimal string), got "${value}".`];
  }
  if (!opts.allowNegative && BigInt(value.trim()) < 0n) {
    return [`${field} must not be negative.`];
  }
  return [];
}
