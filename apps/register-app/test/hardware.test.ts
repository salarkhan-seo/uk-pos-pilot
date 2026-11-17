/**
 * Hardware adapter tests (Build-04, Objective 1).
 * All adapters are simulated — no live hardware, no network.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedStripeTerminalAdapter } from '../src/hardware/stripe-terminal';
import {
  DRAWER_KICK_BYTES,
  SimulatedReceiptPrinterAdapter,
  VAT_INVOICE_NOTICE,
  formatReceipt,
} from '../src/hardware/receipt-printer';
import { SimulatedCustomerDisplayAdapter, formatCustomerDisplay } from '../src/hardware/customer-display';
import { mixedBasketBreakdown } from '@uk-pos/shared-kernel';

describe('StripeTerminalHardwareAdapter (simulated)', () => {
  it('blocks card input until the reader is ready, then allows it', async () => {
    const reader = new SimulatedStripeTerminalAdapter();
    expect(() => reader.requireReadyForCard()).toThrow('Card reader is disconnected');
    expect(reader.status().status).toBe('disconnected');

    const telemetry = await reader.connect('S700', 'wifi');
    expect(telemetry.status).toBe('ready');
    expect(telemetry.firmwareVersion).toBe('2.14.0');
    expect(() => reader.requireReadyForCard()).not.toThrow();

    const wisePad = new SimulatedStripeTerminalAdapter();
    const wisePadTelemetry = await wisePad.connect('WisePad 3', 'bluetooth');
    expect(wisePadTelemetry.batteryPercent).toBe(87);
    expect(wisePadTelemetry.firmwareVersion).toBe('1.9.3');
  });

  it('reports an error state and keeps card input blocked', async () => {
    const reader = new SimulatedStripeTerminalAdapter();
    await reader.connect('S700', 'wifi');
    reader.simulateError('Reader disconnected mid-sale');
    expect(reader.status().status).toBe('error');
    expect(reader.status().lastError).toContain('disconnected mid-sale');
    expect(() => reader.requireReadyForCard()).toThrow('Card reader is error');
  });
});

describe('EscPosReceiptPrinterAdapter (simulated)', () => {
  it('formats a receipt with itemised lines, promotion names, per-rate VAT and the VAT notice', () => {
    // Mixed basket: £12.00 standard (VAT £2.00, net £10.00) + £10.50 reduced (VAT £0.50, net £10.00).
    const breakdown = mixedBasketBreakdown([
      { totalPence: 1200n, rateKind: 'standard' },
      { totalPence: 1050n, rateKind: 'reduced' },
    ]);
    const text = formatReceipt({
      shopName: 'Acme Retail Ltd',
      receiptNumber: '42',
      issuedAt: new Date('2026-11-13T12:00:00.000Z'),
      lines: [
        { name: 'Widget', quantity: 1n, unitPricePence: 1200n, lineTotalPence: 1200n, promotions: ['10% off widgets'] },
        { name: 'Gadget', quantity: 1n, unitPricePence: 1050n, lineTotalPence: 1050n },
      ],
      totalPence: 2250n,
      vatLines: breakdown.lines.map((line) => ({
        taxRateKind: line.rateKind,
        taxRatePercent: line.rateKind === 'standard' ? '20.00' : '5.00',
        netPence: line.netPence,
        vatPence: line.vatPence,
        grossPence: line.grossPence,
      })),
      cashTenderedPence: 2500n,
      cashChangePence: 250n,
    });
    expect(text).toContain('1 x Widget @ £12.00  £12.00');
    expect(text).toContain('Promotion: 10% off widgets');
    expect(text).toContain('TOTAL  £22.50');
    expect(text).toContain('Cash tendered  £25.00');
    expect(text).toContain('Change  £2.50');
    expect(text).toContain('VAT breakdown:');
    expect(text).toContain('standard 20.00%  £10.00  £2.00  £12.00');
    expect(text).toContain('reduced 5.00%  £10.00  £0.50  £10.50');
    expect(text).toContain(VAT_INVOICE_NOTICE);
    expect(VAT_INVOICE_NOTICE).toBe('This is not a VAT invoice');
  });

  it('sends the RJ12 drawer-kick pulse bytes on kickDrawer', async () => {
    const printer = new SimulatedReceiptPrinterAdapter();
    const bytes = await printer.kickDrawer();
    expect(bytes).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(bytes).toEqual([...DRAWER_KICK_BYTES]);
    await printer.printReceipt('test');
    expect(printer.printed).toHaveLength(1);
    expect(printer.drawerKicks).toHaveLength(1);
  });
});

describe('CustomerDisplayAdapter (simulated)', () => {
  it('shows line items, discounts and a SINGLE tax total — never per-rate VAT', () => {
    const text = formatCustomerDisplay({
      lines: [
        { name: 'Widget', quantity: 1n, lineTotalPence: 1200n, discountPence: 120n },
        { name: 'Gadget', quantity: 1n, lineTotalPence: 1050n },
      ],
      taxTotalPence: 250n,
      totalPence: 2250n,
    });
    expect(text).toContain('1 x Widget  £12.00');
    expect(text).toContain('Discount  -£1.20');
    expect(text).toContain('Tax  £2.50');
    expect(text).toContain('TOTAL  £22.50');
    // Per-rate VAT must never appear on the customer display (Arch-01 §3.3).
    expect(text).not.toContain('standard');
    expect(text).not.toContain('reduced');
    expect(text).not.toContain('20.00%');
    expect(text).not.toContain('VAT breakdown');
  });

  it('captures what would be shown on the display', async () => {
    const display = new SimulatedCustomerDisplayAdapter();
    await display.showSale(formatCustomerDisplay({ lines: [], taxTotalPence: 0n, totalPence: 0n }));
    expect(display.shown).toHaveLength(1);
    await display.clear();
    expect(display.shown).toHaveLength(2);
  });
});
