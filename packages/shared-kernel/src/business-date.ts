/**
 * Europe/London business-date resolver (Arch-01 §2.1, package §9 invariant:
 * business date is Europe/London).
 *
 * The business date of a moment is the calendar date in London at that
 * moment — NOT the UTC date. This matters around midnight: 23:30 UTC on a
 * summer evening is already 00:30 BST the next day in London, so the sale
 * belongs to the next business date. Intl.DateTimeFormat with
 * timeZone 'Europe/London' handles BST/GMT transitions (including the
 * 01:00 UTC spring-forward and autumn-back days) without hand-rolled
 * offset tables.
 */

/** Formatter pinned to Europe/London, emitting ISO YYYY-MM-DD. */
const LONDON_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Business date (YYYY-MM-DD, Europe/London) for a Date.
 * Accepts a Date or an ISO-8601 timestamp string.
 */
export function businessDate(input: Date | string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`businessDate: invalid date: ${String(input)}`);
  }
  return LONDON_DATE_FORMATTER.format(date);
}

/**
 * Business date for a timestamptz value as stored in PostgreSQL
 * (ISO-8601 with offset, e.g. '2026-06-14T23:30:00Z').
 */
export function businessDateFromTimestamp(timestamp: string): string {
  return businessDate(timestamp);
}

/** True when two moments fall on the same London business date. */
export function isSameBusinessDate(a: Date | string, b: Date | string): boolean {
  return businessDate(a) === businessDate(b);
}
