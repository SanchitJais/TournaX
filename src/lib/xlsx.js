/**
 * Minimal XLSX reader/writer.
 *
 * An .xlsx file is a ZIP of XML parts, so with node:zlib we can read and write
 * real Excel workbooks without pulling in a dependency. We write cells as
 * inline strings / numbers, which Excel, LibreOffice and Google Sheets all
 * open natively, and read both shared-string and inline-string workbooks.
 */
import zlib from 'node:zlib';

// ------------------------------------------------------------------- CRC32 --
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// --------------------------------------------------------------- ZIP write --
function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x2821, 12);     // mod date (2000-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------- ZIP read --
function unzip(buffer) {
  // Locate the end-of-central-directory record (scan back over the comment).
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (missing ZIP directory)');

  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // The local header's extra field can differ from the central one.
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const body = buffer.subarray(start, start + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ----------------------------------------------------------------- XML bits --
/**
 * XML 1.0 forbids most control characters outright -- leaving one in makes
 * Excel reject the whole workbook, so drop them before escaping.
 */
function stripControl(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    out += ch;
  }
  return out;
}

const esc = (s) => stripControl(String(s ?? ""))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const unesc = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

function colName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const colIndex = (ref) => {
  const letters = (/^[A-Z]+/.exec(ref) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// --------------------------------------------------------------- write API --
/**
 * sheets: [{ name, headers:[string], rows:[[value]] }]
 * Header row is bold + filled via a single named style.
 */
export function buildXlsx(sheets) {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }];

  const sheetXml = list.map((sheet) => {
    const allRows = sheet.headers?.length ? [sheet.headers, ...sheet.rows] : sheet.rows;
    const widths = computeWidths(allRows);
    const body = allRows.map((cells, r) => {
      const isHeader = Boolean(sheet.headers?.length) && r === 0;
      const cellXml = cells.map((value, c) => {
        const ref = `${colName(c)}${r + 1}`;
        const style = isHeader ? ' s="1"' : '';
        if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`;
        if (typeof value === 'number' && Number.isFinite(value)) {
          return `<c r="${ref}"${style}><v>${value}</v></c>`;
        }
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cellXml}</row>`;
    }).join('');

    const cols = widths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const freeze = sheet.headers?.length
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
  });

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes(list.length) },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbookXml(list) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(list.length) },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
  ];
  return zipFiles(entries);
}

function computeWidths(rows) {
  const widths = [];
  for (const row of rows.slice(0, 200)) {
    row.forEach((value, i) => {
      const len = String(value ?? '').length + 3;
      widths[i] = Math.min(46, Math.max(widths[i] || 9, len));
    });
  }
  return widths.length ? widths : [12];
}

const contentTypes = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
  Array.from({ length: n }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
}</Types>`;

const workbookXml = (sheets) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
  sheets.map((s, i) => `<sheet name="${esc(safeSheetName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
}</sheets></workbook>`;

const workbookRels = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const stylesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`;

/** Excel rejects these characters and names over 31 chars. */
function safeSheetName(name, index) {
  const cleaned = String(name || `Sheet${index + 1}`).replace(/[\\/*?:[\]]/g, ' ').trim();
  return cleaned.slice(0, 31) || `Sheet${index + 1}`;
}

// ---------------------------------------------------------------- read API --
/** Returns the first worksheet as an array of row-arrays. */
export function readXlsx(buffer) {
  const files = unzip(buffer);
  const sharedRaw = files.get('xl/sharedStrings.xml');
  const shared = sharedRaw ? parseSharedStrings(sharedRaw.toString('utf8')) : [];

  const sheetName = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort()[0];
  if (!sheetName) throw new Error('Workbook contains no worksheets');

  return parseSheet(files.get(sheetName).toString('utf8'), shared);
}

/** Read the first sheet into objects keyed by its normalised header row. */
export function readXlsxObjects(buffer, normalise) {
  const rows = readXlsx(buffer);
  if (!rows.length) return [];
  const headers = rows[0].map(normalise);
  return rows.slice(1)
    .filter((cells) => cells.some((c) => String(c ?? '').trim() !== ''))
    .map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = String(cells[i] ?? '').trim(); });
      return obj;
    });
}

function parseSharedStrings(xml) {
  const out = [];
  for (const [, item] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // A string can be split across several <t> runs (rich text).
    const parts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1]));
    out.push(parts.join(''));
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const [, attrs, content] of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number((/r="(\d+)"/.exec(attrs) || [])[1]);
    const cells = [];
    for (const [, cAttrs, cContent] of content.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = (/r="([A-Z]+\d+)"/.exec(cAttrs) || [])[1];
      const type = (/t="([^"]+)"/.exec(cAttrs) || [])[1];
      const idx = ref ? colIndex(ref) : cells.length;
      let value = '';
      if (cContent) {
        if (type === 'inlineStr') {
          value = [...cContent.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');
        } else {
          const v = (/<v>([\s\S]*?)<\/v>/.exec(cContent) || [])[1];
          value = type === 's' ? (shared[Number(v)] ?? '') : unesc(v ?? '');
        }
      }
      cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    if (Number.isFinite(rowNum)) rows[rowNum - 1] = cells;
    else rows.push(cells);
  }
  return rows.filter(Boolean).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
