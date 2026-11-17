/**
 * E2E — ESC/POS receipt vs customer display formatting
 * (Build-04, Objective 3; Arch-01 §3.2–§3.3).
 *
 * A mixed-VAT basket (£10.00 standard-rated, £10.00 reduced-rated,
 * £10.00 zero-rated) is sold through the real sales service and the
 * receipt is read back via SalesService.getReceipt. The formatting
 * rules are then proven with the test-support formatters in
 * support/receipt-format.ts (no formatter exists in apps/api — the
 * ESC/POS printer adapter and the customer display adapter live in
 * the register app, Worker 1):
 *
 *   - ESC/POS till receipt: per-rate VAT table (Net / VAT / Gross
 *     per rate) + "This is not a VAT invoice".
 *   - Customer display: the SAME sale with a SINGLE tax total — never
 *     the per-rate breakdown (Arch-01 §3.3).
 *
 * Expected VAT (D-13, tax-inclusive, round half-up per line):
 *   standard 20% on £10.00 gross -> VAT £1.67, net £8.33
 *   reduced   5% on £10.00 gross -> VAT £0.48, net £9.52
 *   zero      0% on £10.00 gross -> VAT £0.00, net £10.00
 *   total £30.00, total VAT £2.15.
 */
import { describe, expect, it } from 'vitest';
import {
  formatCustomerDisplay,
  formatEscPosReceipt,
  formatPence,
  totalVatPence,
} from './support/receipt-format';
import {
  completeCashOrder,
  makeServices,
  managerActor,
  seedVariant,
  setStock,
  withDb,
} from './support/e2e-helpers';

describe('E2E — ESC/POS receipt vs customer display', () => {
  it('receipt: per-rate VAT lines are exact; ESC/POS shows the per-rate table + notice; display shows one tax total only', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const standard = await seedVariant(db, tenant, {
        taxRateId: tenant.taxRates.standard,
        pricePence: 1000n,
      });
      const reduced = await seedVariant(db, tenant, {
        taxRateId: tenant.taxRates.reduced,
        pricePence: 1000n,
      });
      const zero = await seedVariant(db, tenant, {
        taxRateId: tenant.taxRates.zero,
        pricePence: 1000n,
      });
      for (const variant of [standard, reduced, zero]) {
        await setStock(db, tenant, variant.variantId, { quantity: 5n });
      }

      const { order } = await sales.createOrder(actor, {
        locationId: tenant.locationId,
        lines: [
          { variantId: standard.variantId, quantity: 1n },
          { variantId: reduced.variantId, quantity: 1n },
          { variantId: zero.variantId, quantity: 1n },
        ],
      });
      expect(order.total_pence).toBe(3000n);
      await sales.addTender(actor, {
        orderId: order.id,
        tenderType: 'cash',
        amountPence: order.total_pence,
      });
      await sales.completeOrder(actor, order.id);

      const receipt = await sales.getReceipt(actor, order.id);
      expect(receipt.totalPence).toBe(3000n);
      expect(receipt.vatInvoiceNotice).toBe('This is not a VAT invoice');
      const byKind = new Map(receipt.lines.map((line) => [line.taxRateKind, line]));
      const standardLine = byKind.get('standard');
      expect(standardLine?.grossPence).toBe(1000n);
      expect(standardLine?.vatPence).toBe(167n);
      expect(standardLine?.netPence).toBe(833n);
      const reducedLine = byKind.get('reduced');
      expect(reducedLine?.grossPence).toBe(1000n);
      expect(reducedLine?.vatPence).toBe(48n);
      expect(reducedLine?.netPence).toBe(952n);
      const zeroLine = byKind.get('zero');
      expect(zeroLine?.grossPence).toBe(1000n);
      expect(zeroLine?.vatPence).toBe(0n);
      expect(zeroLine?.netPence).toBe(1000n);
      // The lines reconcile: gross = net + VAT per line, and the
      // lines sum to the receipt total.
      for (const line of receipt.lines) {
        expect(line.netPence + line.vatPence).toBe(line.grossPence);
      }
      expect(receipt.lines.reduce((sum, line) => sum + line.grossPence, 0n)).toBe(3000n);
      expect(totalVatPence(receipt)).toBe(215n);

      // ESC/POS: per-rate table + notice.
      const escpos = formatEscPosReceipt(receipt, { registerName: 'TILL-01' });
      expect(escpos).toContain('VAT 20.00%  Net £8.33  VAT £1.67  Gross £10.00');
      expect(escpos).toContain('VAT 5.00%  Net £9.52  VAT £0.48  Gross £10.00');
      expect(escpos).toContain('VAT 0.00%  Net £10.00  VAT £0.00  Gross £10.00');
      expect(escpos).toContain('TOTAL: £30.00');
      expect(escpos).toContain('This is not a VAT invoice');

      // Customer display: one tax total, no per-rate rows, no notice.
      const display = formatCustomerDisplay(receipt);
      expect(display).toContain('TOTAL: £30.00');
      expect(display).toContain('Tax: £2.15');
      expect(display).not.toContain('20.00%');
      expect(display).not.toContain('5.00%');
      expect(display).not.toContain('Net £');
      expect(display).not.toContain('This is not a VAT invoice');
    });
  });

  it('receipt: a single-rate cash sale still carries the notice and a one-row VAT table', async () => {
    await withDb(async ({ db, tenant }) => {
      const actor = managerActor(tenant);
      const { sales } = makeServices(db);
      const variant = await seedVariant(db, tenant);
      await setStock(db, tenant, variant.variantId, { quantity: 5n });
      const { order } = await completeCashOrder(tenant, sales, variant.variantId);
      const receipt = await sales.getReceipt(actor, order.id);
      expect(receipt.lines).toHaveLength(1);
      expect(receipt.lines[0]?.vatPence).toBe(167n);
      expect(formatPence(receipt.totalPence)).toBe('£10.00');
      const escpos = formatEscPosReceipt(receipt);
      expect(escpos).toContain('VAT 20.00%');
      expect(escpos).toContain('This is not a VAT invoice');
      expect(formatCustomerDisplay(receipt)).toBe('TOTAL: £10.00\nTax: £1.67');
    });
  });
});
