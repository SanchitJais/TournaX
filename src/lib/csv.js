/** RFC-4180 CSV parse / stringify. No dependencies. */

/** Parse CSV text into an array of row-arrays. Handles quotes, escapes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Parse into objects keyed by a normalised header row. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map(normaliseHeader);
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

export const normaliseHeader = (h) =>
  String(h || '').trim().toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '');

const escapeCell = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows: array of arrays, or array of objects when `headers` is supplied. */
export function toCsv(rows, headers) {
  const lines = [];
  if (headers) {
    lines.push(headers.map((h) => escapeCell(h.label ?? h)).join(','));
    for (const row of rows) {
      lines.push(headers.map((h) => escapeCell(typeof h === 'string' ? row[h] : h.get ? h.get(row) : row[h.key])).join(','));
    }
  } else {
    for (const row of rows) lines.push(row.map(escapeCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
