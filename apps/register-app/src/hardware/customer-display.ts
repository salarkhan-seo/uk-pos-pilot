/**
 * Customer display adapter (Build-04, Objective 1; Arch-01 §3.3).
 *
 * The customer-facing display shows line items, discounts and a
 * SINGLE tax total — NEVER a per-rate VAT breakdown. Per-rate VAT is
 * receipt-only; showing it on the customer display is explicitly
 * forbidden by Arch-01 §3.3.
 */
import { formatPounds } from '@uk-pos/shared-kernel';

export interface CustomerDisplayLineInput {
  name: string;
  quantity: bigint;
  lineTotalPence: bigint;
  /** Discount applied to this line (promotion + manual), when any. */
  discountPence?: bigint;
}

export interface CustomerDisplayInput {
  lines: CustomerDisplayLineInput[];
  /** Single tax total for the whole basket (never per-rate). */
  taxTotalPence: bigint;
  totalPence: bigint;
}

/** Pure formatter: line items, discounts, single tax total, total. */
export function formatCustomerDisplay(input: CustomerDisplayInput): string {
  const out: string[] = [];
  for (const line of input.lines) {
    out.push(`${line.quantity.toString()} x ${line.name}  ${formatPounds(line.lineTotalPence)}`);
    if (line.discountPence !== undefined && line.discountPence > 0n) {
      out.push(`  Discount  -${formatPounds(line.discountPence)}`);
    }
  }
  out.push(`Tax  ${formatPounds(input.taxTotalPence)}`);
  out.push(`TOTAL  ${formatPounds(input.totalPence)}`);
  return out.join('\n');
}

export interface CustomerDisplayAdapter {
  showSale(formatted: string): Promise<string>;
  clear(): Promise<void>;
}

/** Simulated customer display — captures output, drives no hardware. */
export class SimulatedCustomerDisplayAdapter implements CustomerDisplayAdapter {
  readonly shown: string[] = [];

  async showSale(formatted: string): Promise<string> {
    this.shown.push(formatted);
    return formatted;
  }

  async clear(): Promise<void> {
    this.shown.push('');
  }
}
