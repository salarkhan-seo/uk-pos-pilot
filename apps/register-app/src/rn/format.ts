/**
 * Shared RN formatting helpers (Build-07, Objective 2).
 *
 * Money is always integer pence (bigint) in this codebase; the RN
 * screens format it as £x.xx. This is the single place that
 * conversion lives so the screens never reimplement it.
 */
export function formatPence(pence: bigint): string {
  const negative = pence < 0n;
  const abs = negative ? -pence : pence;
  const pounds = abs / 100n;
  const remainder = abs % 100n;
  return `${negative ? '-' : ''}£${pounds.toString()}.${remainder.toString().padStart(2, '0')}`;
}

/** Parse a till-typed amount ("12.34" or "1234" pence) to bigint pence. Returns null when unparseable. */
export function parsePenceInput(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === '') {
    return null;
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const pounds = BigInt(match[1] as string);
  const pence = match[2] === undefined ? 0n : BigInt((match[2] as string).padEnd(2, '0'));
  return pounds * 100n + pence;
}
