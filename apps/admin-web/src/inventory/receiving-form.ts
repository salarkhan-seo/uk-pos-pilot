/**
 * Goods-in receiving form (Build-04 Objective 2).
 *
 * DESIGN DECISION (D-AW-05): every line's received quantity defaults to
 * `0` — the form NEVER pre-fills the ordered quantity — so a receiver
 * cannot blindly accept a delivery. Damaged and short quantities are
 * separate inputs (they map to the API's `quantityDamaged` /
 * `quantityShort`, which the server books as damage / supplier-error
 * movements, not as stock). Client-side rule: received + damaged +
 * short must not exceed the ordered quantity; the server remains the
 * authority (weighted-average revaluation happens server-side).
 */
import type { AdminApiClient } from '../api/client';
import type { GoodsInInput } from '../api/types';

export interface ReceivingLine {
  variantId: string;
  quantityOrdered: string;
  /** Defaults to '0' — never pre-filled from the order (D-AW-05). */
  quantityReceived: string;
  quantityDamaged: string;
  quantityShort: string;
  costPence: string;
}

export function blankReceivingLine(variantId: string, quantityOrdered: string, costPence: string): ReceivingLine {
  return { variantId, quantityOrdered, quantityReceived: '0', quantityDamaged: '0', quantityShort: '0', costPence };
}

export function buildReceivingForm(lines: Array<{ variantId: string; quantityOrdered: string; costPence: string }>): ReceivingLine[] {
  return lines.map((l) => blankReceivingLine(l.variantId, l.quantityOrdered, l.costPence));
}

export function validateReceivingLines(lines: ReceivingLine[]): string[] {
  const errors: string[] = [];
  for (const line of lines) {
    for (const [field, value] of [
      ['quantityReceived', line.quantityReceived],
      ['quantityDamaged', line.quantityDamaged],
      ['quantityShort', line.quantityShort],
    ] as const) {
      if (!/^\d+$/.test(value.trim())) {
        errors.push(`Line ${line.variantId}: ${field} must be a non-negative integer.`);
      }
    }
    if (!/^\d+$/.test(line.costPence.trim())) {
      errors.push(`Line ${line.variantId}: costPence must be a non-negative integer.`);
    }
    const ordered = BigInt(line.quantityOrdered);
    const allIntegers = /^\d+$/.test(line.quantityReceived.trim()) && /^\d+$/.test(line.quantityDamaged.trim()) && /^\d+$/.test(line.quantityShort.trim());
    if (!allIntegers) {
      continue;
    }
    const total = BigInt(line.quantityReceived) + BigInt(line.quantityDamaged) + BigInt(line.quantityShort);
    if (total > ordered) {
      errors.push(
        `Line ${line.variantId}: received (${line.quantityReceived}) + damaged (${line.quantityDamaged}) + short (${line.quantityShort}) = ${total} exceeds ordered ${ordered}.`,
      );
    }
  }
  return errors;
}

export class ReceivingFormController {
  constructor(private readonly api: AdminApiClient) {}

  async submit(input: {
    poId?: string | null;
    supplierId: string;
    locationId: string;
    warehouseId: string;
    lines: ReceivingLine[];
  }): Promise<{ receiptId: string }> {
    const errors = validateReceivingLines(input.lines);
    if (input.lines.length === 0) {
      errors.push('Goods-in receipt has no lines.');
    }
    if (errors.length > 0) {
      throw new Error(`Receiving form invalid: ${errors.join(' ')}`);
    }
    const payload: GoodsInInput = {
      poId: input.poId ?? null,
      supplierId: input.supplierId,
      locationId: input.locationId,
      warehouseId: input.warehouseId,
      lines: input.lines.map((l) => ({
        variantId: l.variantId,
        quantityReceived: l.quantityReceived,
        quantityDamaged: l.quantityDamaged,
        quantityShort: l.quantityShort,
        costPence: l.costPence,
      })),
    };
    return this.api.receiveGoodsIn(payload);
  }
}
