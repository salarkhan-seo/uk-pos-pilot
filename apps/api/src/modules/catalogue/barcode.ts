import { BadRequestException } from '@nestjs/common';

/**
 * Embedded barcode parser (Build-02, Objective 3) — PURE functions, no I/O.
 *
 * In-store variable-measure barcodes embed either a price or a weight in
 * the code itself (Arch-01 §2.2). The tenant's barcode_rules row selects
 * ONE mode account-wide (price_embedded OR weight_embedded); a code is
 * never silently reinterpreted in the other mode — the service layer
 * rejects a requested mode that differs from the tenant's active mode.
 *
 * Layouts (digits are 1-indexed):
 *   EAN-13 (13 digits): digits 1–2 = in-store prefix, must be 20–29;
 *     digits 3–7 = 5-digit SKU/PLU; digits 8–12 = 5-digit embedded value
 *     (price in pence in price mode, weight in grams in weight mode);
 *     digit 13 = check digit.
 *   UPC-A (12 digits): digit 1 must be '2'; digits 2–6 = SKU; digits 7–11
 *     = embedded value; digit 12 = check digit.
 *
 * Check digits:
 *   EAN-13: sum over the first 12 digits of (odd positions ×1 +
 *     even positions ×3); check = (10 − sum % 10) % 10.
 *   UPC-A: sum over the first 11 digits of (odd positions ×3 +
 *     even positions ×1); check = (10 − sum % 10) % 10.
 */

export type BarcodeMode = 'price_embedded' | 'weight_embedded';

export interface ParsedBarcode {
  /** 5-digit SKU/PLU as printed (leading zeros preserved). */
  sku: string;
  /** Embedded price in pence — present only in price_embedded mode. */
  pricePence?: bigint;
  /** Embedded weight in grams — present only in weight_embedded mode. */
  weightGrams?: bigint;
}

function fail(reason: string): never {
  throw new BadRequestException(`Invalid barcode: ${reason}`);
}

function digitsOnly(code: string): void {
  if (!/^[0-9]+$/.test(code)) {
    fail('barcode must contain digits only');
  }
}

function ean13CheckDigit(firstTwelve: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(firstTwelve[i]);
    // Positions are 1-indexed: odd positions ×1, even positions ×3.
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function upcCheckDigit(firstEleven: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) {
    const digit = Number(firstEleven[i]);
    // Positions are 1-indexed: odd positions ×3, even positions ×1.
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

function embeddedValue(code: string, start: number): bigint {
  // 5-digit embedded value; leading zeros are significant in the code
  // but the value itself is a plain integer (pence or grams).
  return BigInt(code.slice(start, start + 5));
}

function toParsed(sku: string, value: bigint, mode: BarcodeMode): ParsedBarcode {
  return mode === 'price_embedded' ? { sku, pricePence: value } : { sku, weightGrams: value };
}

/**
 * Parse an in-store variable-measure barcode in the given mode.
 * Throws BadRequestException on wrong length, non-digits, wrong prefix,
 * or a check-digit mismatch — with the reason in the message.
 */
export function parseBarcode(code: string, mode: BarcodeMode): ParsedBarcode {
  digitsOnly(code);
  if (code.length === 13) {
    const prefix = Number(code.slice(0, 2));
    if (prefix < 20 || prefix > 29) {
      fail('EAN-13 in-store prefix must be 20–29');
    }
    const body = code.slice(0, 12);
    const expected = ean13CheckDigit(body);
    const actual = Number(code[12]);
    if (actual !== expected) {
      fail('EAN-13 check digit mismatch');
    }
    return toParsed(code.slice(2, 7), embeddedValue(code, 7), mode);
  }
  if (code.length === 12) {
    if (code[0] !== '2') {
      fail("UPC-A in-store prefix must be '2'");
    }
    const body = code.slice(0, 11);
    const expected = upcCheckDigit(body);
    const actual = Number(code[11]);
    if (actual !== expected) {
      fail('UPC-A check digit mismatch');
    }
    return toParsed(code.slice(1, 6), embeddedValue(code, 6), mode);
  }
  fail('barcode must be 12 digits (UPC-A) or 13 digits (EAN-13)');
}
