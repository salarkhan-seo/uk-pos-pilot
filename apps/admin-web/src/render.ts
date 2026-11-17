/**
 * Framework-free rendering helpers.
 *
 * The view layer is plain string/template rendering (no React/Next
 * runtime dependency). Every console produces a view-model; these
 * helpers turn view-models into HTML strings for display. Rendering is
 * deliberately dumb — no business logic lives here — so the whole view
 * layer is testable in Node without a browser (D-AW-09).
 *
 * HONEST LIMIT: no browser rendering has been tested. These functions
 * produce HTML strings; mounting them in a real browser shell is a
 * follow-up, not something this build claims.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTable(headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderSection(title: string, innerHtml: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${innerHtml}</section>`;
}

/** Format integer-pence strings as £x.xx for display (display only — never for arithmetic). */
export function formatPence(pence: string): string {
  const value = BigInt(pence);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const pounds = abs / 100n;
  const pennies = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}£${pounds.toString()}.${pennies}`;
}

/** Masked voucher/gift-card display: only the last 4 are ever shown. */
export function formatMaskedCode(codeLast4: string): string {
  return `•••• ${codeLast4}`;
}
