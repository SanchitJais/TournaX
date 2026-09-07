/**
 * Minimal PDF writer for leaderboard / schedule exports.
 *
 * PDF is a plain-text object format, and Helvetica is one of the 14 standard
 * fonts every reader ships, so a presentable multi-page table needs no font
 * embedding and no dependency -- just accurate glyph widths for layout.
 */

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Text width in points for a given font size. */
function widthOf(text, size, bold = false) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    total += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (total * size) / 1000;
}

/** Latin-1 only; anything else becomes '?' so the stream stays valid. */
function pdfString(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return out;
}

/** Shorten to fit `maxWidth`, appending an ellipsis when it does not. */
function fit(text, maxWidth, size, bold) {
  const str = String(text ?? '');
  if (widthOf(str, size, bold) <= maxWidth) return str;
  let out = str;
  while (out.length > 1 && widthOf(`${out}...`, size, bold) > maxWidth) out = out.slice(0, -1);
  return `${out.trim()}...`;
}

const PAGE = {
  portrait: { w: 595.28, h: 841.89 },
  landscape: { w: 841.89, h: 595.28 },
};

class Content {
  constructor() { this.ops = []; }
  rect(x, y, w, h, [r, g, b]) {
    this.ops.push(`${r} ${g} ${b} rg`, `${f(x)} ${f(y)} ${f(w)} ${f(h)} re f`);
  }
  line(x1, y1, x2, y2, [r, g, b], width = 0.5) {
    this.ops.push(`${r} ${g} ${b} RG`, `${f(width)} w`, `${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`);
  }
  text(x, y, str, { size = 9, bold = false, color = [0.1, 0.11, 0.13] } = {}) {
    const [r, g, b] = color;
    this.ops.push(
      'BT', `${r} ${g} ${b} rg`, `/${bold ? 'F2' : 'F1'} ${f(size)} Tf`,
      `1 0 0 1 ${f(x)} ${f(y)} Tm`, `(${pdfString(str)}) Tj`, 'ET',
    );
  }
  toString() { return this.ops.join('\n'); }
}

const f = (n) => (Math.round(n * 100) / 100).toString();

const INK = {
  head: [0.086, 0.098, 0.145],   // deep navy header band
  headText: [1, 1, 1],
  accent: [0.35, 0.85, 0.62],
  body: [0.12, 0.13, 0.16],
  muted: [0.45, 0.48, 0.54],
  zebra: [0.965, 0.969, 0.976],
  rule: [0.87, 0.89, 0.92],
  white: [1, 1, 1],
};

/**
 * Render a paginated table document.
 *
 * @param {object} opts
 * @param {string} opts.title        headline (tournament name)
 * @param {string} [opts.subtitle]   document kind, e.g. "Overall Leaderboard"
 * @param {string[]} [opts.meta]     small lines under the title
 * @param {Array<{label:string, key?:string, width?:number, align?:'left'|'right'|'center'}>} opts.columns
 * @param {Array<object|Array>} opts.rows
 * @param {'portrait'|'landscape'} [opts.orientation]
 * @returns {Buffer}
 */
export function renderTablePdf(opts) {
  const {
    title, subtitle = '', meta = [], columns, rows,
    orientation = columns.length > 7 ? 'landscape' : 'portrait',
    footerNote = '',
  } = opts;

  const { w: PW, h: PH } = PAGE[orientation];
  const M = 38;
  const tableWidth = PW - M * 2;
  const widths = resolveWidths(columns, rows, tableWidth);

  const HEADER_H = 74;
  const ROW_H = 19;
  const TH_H = 22;

  const pages = [];
  let content = null;
  let y = 0;
  let pageNo = 0;

  const startPage = () => {
    content = new Content();
    pages.push(content);
    pageNo++;
    // Title band
    content.rect(0, PH - HEADER_H, PW, HEADER_H, INK.head);
    content.rect(0, PH - HEADER_H, PW, 3, INK.accent);
    content.text(M, PH - 32, fit(title, tableWidth - 180, 16, true), {
      size: 16, bold: true, color: INK.headText,
    });
    if (subtitle) {
      content.text(M, PH - 49, fit(subtitle, tableWidth - 180, 9.5), {
        size: 9.5, color: [0.68, 0.72, 0.79],
      });
    }
    let mx = PH - 32;
    for (const line of meta.slice(0, 3)) {
      content.text(PW - M - widthOf(line, 8), mx, line, { size: 8, color: [0.62, 0.67, 0.75] });
      mx -= 11;
    }
    y = PH - HEADER_H - 26;
    drawHead();
  };

  const drawHead = () => {
    content.rect(M, y - 6, tableWidth, TH_H, [0.945, 0.953, 0.965]);
    let x = M;
    columns.forEach((col, i) => {
      const label = fit(col.label, widths[i] - 10, 8, true);
      content.text(alignX(x, widths[i], label, 8, col.align, true), y, label.toUpperCase(), {
        size: 8, bold: true, color: [0.29, 0.33, 0.4],
      });
      x += widths[i];
    });
    y -= TH_H;
    content.line(M, y + 10, M + tableWidth, y + 10, INK.rule, 0.8);
  };

  startPage();

  rows.forEach((row, index) => {
    if (y < M + 34) { startPage(); }
    if (index % 2 === 1) content.rect(M, y - 5, tableWidth, ROW_H, INK.zebra);

    let x = M;
    columns.forEach((col, i) => {
      const raw = Array.isArray(row) ? row[i] : (col.get ? col.get(row) : row[col.key]);
      const value = raw === null || raw === undefined ? '' : String(raw);
      const bold = Boolean(col.bold);
      const shown = fit(value, widths[i] - 10, 8.5, bold);
      content.text(alignX(x, widths[i], shown, 8.5, col.align, bold), y, shown, {
        size: 8.5, bold, color: col.muted ? INK.muted : INK.body,
      });
      x += widths[i];
    });
    y -= ROW_H;
    content.line(M, y + 12, M + tableWidth, y + 12, [0.93, 0.94, 0.96], 0.4);
  });

  if (!rows.length) {
    content.text(M + 4, y - 4, 'No records yet.', { size: 9, color: INK.muted });
  }

  // Footers, once the total page count is known.
  const stamp = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  pages.forEach((page, i) => {
    const left = footerNote || `Generated ${stamp}`;
    page.line(M, 30, PW - M, 30, INK.rule, 0.6);
    page.text(M, 19, left, { size: 7.5, color: INK.muted });
    const right = `Page ${i + 1} of ${pages.length}`;
    page.text(PW - M - widthOf(right, 7.5), 19, right, { size: 7.5, color: INK.muted });
  });

  return assemble(pages, PW, PH);
}

function alignX(x, width, text, size, align, bold) {
  if (align === 'right') return x + width - 5 - widthOf(text, size, bold);
  if (align === 'center') return x + (width - widthOf(text, size, bold)) / 2;
  return x + 5;
}

/** Size columns to their content, then scale to exactly fill the page width. */
function resolveWidths(columns, rows, total) {
  const natural = columns.map((col, i) => {
    let max = widthOf(col.label, 8, true) + 14;
    for (const row of rows.slice(0, 300)) {
      const raw = Array.isArray(row) ? row[i] : (col.get ? col.get(row) : row[col.key]);
      max = Math.max(max, widthOf(String(raw ?? ''), 8.5) + 14);
    }
    return Math.min(col.max || 260, Math.max(col.min || 34, max));
  });
  const sum = natural.reduce((a, b) => a + b, 0);
  const scale = total / sum;
  // Scaling down proportionally is fine; scaling up looks better spread evenly.
  if (scale < 1) return natural.map((w) => w * scale);
  const extra = (total - sum) / columns.length;
  return natural.map((w) => w + extra);
}

function assemble(pages, PW, PH) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pagesId = add(null); // placeholder, filled once children are known

  const pageIds = [];
  for (const page of pages) {
    const stream = page.toString();
    const streamId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(PW)} ${f(PH)}] `
      + `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> `
      + `/Contents ${streamId} 0 R >>`,
    ));
  }
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`
       + `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

export const PDF_MIME = 'application/pdf';
