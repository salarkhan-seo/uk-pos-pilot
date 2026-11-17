/**
 * Receipt formatters for the Build-04 Objective 3 E2E suite
 * (Arch-01 §3.2–§3.3, Arch-04 §3).
 *
 * These are TEST-SUPPORT formatters, not production code: no receipt
 * formatter exists in apps/api (the ESC/POS printer adapter and the
 * customer display adapter both live in the register app — Worker 1).
 * They render from the real ReceiptView the API returns
 * (SalesService.getReceipt: per-rate VAT lines + the "This is not a
 * VAT invoice" notice) so the E2E suite can prove the two formatting
 * contracts against real receipt data:
 *
 *   - ESC/POS till receipt: itemised per-rate VAT table
 *     (Net / VAT / Gross per rate) + "This is not a VAT invoice".
 *   - Customer display: the SAME sale, but a SINGLE tax total —
 *     never the per-rate VAT breakdown (Arch-01 §3.3).
 *
 * If a formatter belongs in the register app (Worker 1) it stays
 * there; this file exists only so the formatting RULES can be proven
 * at the API level from real receipt data.
 */
import type { ReceiptView } from '../../../src/modules/sales/sales.service';

/** £10.00 style rendering of integer pence (D-13: money is integer pence, never float). */
export function formatPence(pence: bigint): string {
  const sign = pence < 0n ? '-' : '';
  const abs = pence < 0n ? -pence : pence;
  return `${sign}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** The single tax total for the whole receipt (sum of the per-rate VAT amounts). */
export function totalVatPence(view: ReceiptView): bigint {
  return view.lines.reduce((sum, line) => sum + line.vatPence, 0n);
}

/**
 * ESC/POS till receipt text (what the Star TSP143IV / Epson TM-m30III
 * adapter prints): one Net/VAT/Gross row per VAT rate, the grand
 * total, and the VAT-invoice notice from the receipt itself.
 */
export function formatEscPosReceipt(
  view: ReceiptView,
  options: { storeName?: string; registerName?: string } = {},
): string {
  const out: string[] = [];
  out.push(options.storeName ?? 'UK POS PILOT');
  if (options.registerName !== undefined) {
    out.push(`Register: ${options.registerName}`);
  }
  out.push(`Receipt #${view.receiptNumber.toString()}`);
  out.push('--------------------------------');
  out.push('VAT breakdown:');
  for (const line of view.lines) {
    out.push(
      `VAT ${line.taxRatePercent}%  Net ${formatPence(line.netPence)}  ` +
        `VAT ${formatPence(line.vatPence)}  Gross ${formatPence(line.grossPence)}`,
    );
  }
  out.push('--------------------------------');
  out.push(`TOTAL: ${formatPence(view.totalPence)}`);
  out.push(view.vatInvoiceNotice);
  return out.join('\n');
}

/**
 * Customer display text: the same sale with a SINGLE tax total.
 * Per-rate VAT rows are never shown on the customer display
 * (Arch-01 §3.3).
 */
export function formatCustomerDisplay(view: ReceiptView): string {
  const out: string[] = [];
  out.push(`TOTAL: ${formatPence(view.totalPence)}`);
  out.push(`Tax: ${formatPence(totalVatPence(view))}`);
  return out.join('\n');
}
