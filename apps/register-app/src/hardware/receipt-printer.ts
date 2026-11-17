/**
 * ESC/POS receipt printer adapter (Build-04, Objective 1; Arch-01 §3.2).
 *
 * Formatter for the Star TSP143IV / Epson TM-m30III: itemised lines,
 * promotion names, per-rate VAT breakdown [Net, VAT, Gross], and the
 * explicit marking "This is not a VAT invoice" (a till receipt is NOT
 * a VAT invoice). The RJ12 cash-drawer kick is the standard ESC/POS
 * pulse command: ESC p m t1 t2 (0x1B 0x70 0x00 0x19 0xFA — drawer 0,
 * 25ms on, 250ms off).
 *
 * The formatter is pure (string in, string out) so it is testable
 * without a printer; the simulated adapter captures what would be
 * sent to the device.
 */
import { formatPounds } from '@uk-pos/shared-kernel';

export interface ReceiptLineInput {
  name: string;
  quantity: bigint;
  unitPricePence: bigint;
  lineTotalPence: bigint;
  /** Promotion names applied to this line, when any. */
  promotions?: string[];
}

export interface ReceiptVatLineInput {
  taxRateKind: string;
  taxRatePercent: string;
  netPence: bigint;
  vatPence: bigint;
  grossPence: bigint;
}

export interface ReceiptInput {
  shopName: string;
  receiptNumber: string;
  issuedAt: Date;
  lines: ReceiptLineInput[];
  totalPence: bigint;
  vatLines: ReceiptVatLineInput[];
  /** Cash tendered / change, when the sale was cash. */
  cashTenderedPence?: bigint | null;
  cashChangePence?: bigint | null;
}

export const VAT_INVOICE_NOTICE = 'This is not a VAT invoice';

/** ESC p m t1 t2 — pulse drawer 0, 25ms on / 250ms off. */
export const DRAWER_KICK_BYTES: readonly number[] = [0x1b, 0x70, 0x00, 0x19, 0xfa];

/** Pure ESC/POS text formatter (printable text; control bytes are the caller's concern). */
export function formatReceipt(input: ReceiptInput): string {
  const out: string[] = [];
  out.push(input.shopName);
  out.push(`Receipt #${input.receiptNumber}  ${input.issuedAt.toISOString()}`);
  out.push('--------------------------------');
  for (const line of input.lines) {
    out.push(
      `${line.quantity.toString()} x ${line.name} @ ${formatPounds(line.unitPricePence)}  ${formatPounds(line.lineTotalPence)}`,
    );
    for (const promotion of line.promotions ?? []) {
      out.push(`  Promotion: ${promotion}`);
    }
  }
  out.push('--------------------------------');
  out.push(`TOTAL  ${formatPounds(input.totalPence)}`);
  if (input.cashTenderedPence !== undefined && input.cashTenderedPence !== null) {
    out.push(`Cash tendered  ${formatPounds(input.cashTenderedPence)}`);
  }
  if (input.cashChangePence !== undefined && input.cashChangePence !== null) {
    out.push(`Change  ${formatPounds(input.cashChangePence)}`);
  }
  out.push('VAT breakdown:');
  out.push('Rate      Net      VAT      Gross');
  for (const vat of input.vatLines) {
    out.push(
      `${vat.taxRateKind} ${vat.taxRatePercent}%  ${formatPounds(vat.netPence)}  ${formatPounds(vat.vatPence)}  ${formatPounds(vat.grossPence)}`,
    );
  }
  out.push(VAT_INVOICE_NOTICE);
  return out.join('\n');
}

export interface EscPosReceiptPrinterAdapter {
  /** Print the formatted receipt; returns the bytes/text sent to the device. */
  printReceipt(formatted: string): Promise<string>;
  /** Send the RJ12 drawer-kick pulse; returns the command bytes sent. */
  kickDrawer(): Promise<number[]>;
}

/** Simulated printer — captures output, sends nothing to hardware. */
export class SimulatedReceiptPrinterAdapter implements EscPosReceiptPrinterAdapter {
  readonly printed: string[] = [];
  readonly drawerKicks: number[][] = [];

  async printReceipt(formatted: string): Promise<string> {
    this.printed.push(formatted);
    return formatted;
  }

  async kickDrawer(): Promise<number[]> {
    const bytes = [...DRAWER_KICK_BYTES];
    this.drawerKicks.push(bytes);
    return bytes;
  }
}
