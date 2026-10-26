// Writes an Excel workbook (.xlsx) holding one sheet with one Excel table,
// with no library: an .xlsx file is a zip of small XML parts, and an
// uncompressed zip is simple to build. Every cell is typed (text, date or
// link), so nothing in a cell can run as a formula.

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_CELL = 32767;

const xml = (s) =>
  String(s)
    // characters XML 1.0 cannot hold at all
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    // half of an emoji (a lone surrogate); whole pairs are kept
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function columnLetter(n) {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Excel stores date-times as days since 1899-12-30, in local time.
export function excelSerial(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return 25569 + (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000;
}

const STYLE = { text: 0, header: 1, date: 2, link: 3 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// columns: [{ header, width?, kind?: 'text' | 'date' | 'link' }]
// rows: arrays in column order. A date is a Date or ISO string; a link is
// { url, text }. Empty values leave the cell blank.
export function buildXlsx({ columns, rows, sheetName = 'Sheet1', tableName = 'Table1' }) {
  const last = columnLetter(columns.length - 1);
  const lastRow = Math.max(rows.length, 1) + 1; // a table needs one body row, even if empty
  const ref = `A1:${last}${lastRow}`;
  const links = [];

  const inline = (r, text, style = STYLE.text) => `<c r="${r}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(String(text).slice(0, MAX_CELL))}</t></is></c>`;
  const header = `<row r="1">${columns.map((c, i) => inline(`${columnLetter(i)}1`, c.header, STYLE.header)).join('')}</row>`;
  const body = rows
    .map((values, ri) => {
      const n = ri + 2;
      const cells = columns.map((c, ci) => {
        const r = `${columnLetter(ci)}${n}`;
        const v = values[ci];
        if (v == null || v === '') return '';
        if (c.kind === 'date') {
          const serial = excelSerial(v);
          return serial == null ? '' : `<c r="${r}" s="${STYLE.date}"><v>${serial}</v></c>`;
        }
        if (c.kind === 'link') {
          if (!v.url) return '';
          links.push({ ref: r, url: v.url });
          return inline(r, v.text || v.url, STYLE.link);
        }
        return inline(r, v);
      });
      return `<row r="${n}">${cells.join('')}</row>`;
    })
    .join('');

  const cols = `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`).join('')}</cols>`;
  const hyperlinks = links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 2}"/>`).join('')}</hyperlinks>` : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}" xmlns:r="${REL}"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${header}${body}</sheetData>${hyperlinks}<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`;
  const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>${links.map((l, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/hyperlink" Target="${xml(l.url)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const table = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="${NS}" id="1" name="${xml(tableName)}" displayName="${xml(tableName)}" ref="${ref}" totalsRowShown="0"><autoFilter ref="${ref}"/><tableColumns count="${columns.length}">${columns.map((c, i) => `<tableColumn id="${i + 1}" name="${xml(c.header)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`;

  return zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/worksheets/_rels/sheet1.xml.rels', sheetRels],
    ['xl/tables/table1.xml', table],
  ]);
}

// ---------- zip (stored, no compression) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries, date = new Date()) {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const files = entries.map(([name, content]) => {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    return { name: enc.encode(name), data, crc: crc32(data) };
  });
  const size = files.reduce((n, f) => n + 30 + f.name.length + f.data.length + 46 + f.name.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const bytes = (b) => { out.set(b, p); p += b.length; };

  const offsets = [];
  for (const f of files) {
    offsets.push(p);
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
    u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.name.length); u16(0);
    bytes(f.name); bytes(f.data);
  }
  const central = p;
  files.forEach((f, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
    u32(f.crc); u32(f.data.length); u32(f.data.length); u16(f.name.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(offsets[i]); bytes(f.name);
  });
  const centralSize = p - central;
  u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length); u32(centralSize); u32(central); u16(0);
  return out;
}
