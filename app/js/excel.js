// Writes contacts to an Excel table through Microsoft Graph.
//
// The workbook is either a path in the signed-in person's OneDrive (created
// from template/InfoCapture-Leads.xlsx on first use) or a sharing link to a
// workbook in SharePoint/OneDrive that a team shares. Rows are matched by
// the "ID" column, so edits update the same row and retries never add
// duplicates. Columns are matched by header text, so people can reorder
// columns or add their own (for example "Owner" or "Status") and the app
// leaves those cells alone.

import { COLUMNS, excelDate } from './fields.js';
import { NetworkError } from './auth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const TABLE_NAME = 'InfoCaptureLeads';
export const SHEET_NAME = 'Leads';
const ALT_SHEET_NAME = 'InfoCapture';
const PHOTO_FOLDER = 'Card Photos';
const ID_HEADER = COLUMNS.find((c) => c.key === 'id').header;
const TEMPLATE_URL = new URL('../template/InfoCapture-Leads.xlsx', import.meta.url);

export class GraphError extends Error {
  constructor(status, code, message) {
    super(message || `Microsoft Graph error ${status}`);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

export class ExcelStore {
  // getToken: async () => Graph access token
  // location: OneDrive path ("/Folder/File.xlsx") or a sharing URL
  // cached: ids remembered from an earlier run ({ location, driveId, itemId, parentId })
  constructor({ getToken, location, cached = null, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.getToken = getToken;
    this.location = location.trim();
    this.fetch = fetchImpl;
    this.item = cached?.location === this.location ? cached : null;
    this.table = null; // { name, headers: [] }
    this.rowIndex = null; // Map id -> zero-based data row index
  }

  // ---------- low level ----------

  async request(method, path, { body, headers = {}, raw = false, attempt = 0 } = {}) {
    const token = await this.getToken();
    const url = path.startsWith('http') ? path : GRAPH + path;
    const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
    if (body !== undefined) {
      if (body instanceof Blob) {
        init.body = body;
        init.headers['Content-Type'] ||= body.type || 'application/octet-stream';
      } else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    let res;
    try {
      res = await this.fetch(url, init);
    } catch {
      throw new NetworkError('Could not reach Microsoft 365.');
    }
    // Graph asks clients to retry throttled and transient Excel errors.
    if ([429, 502, 503, 504].includes(res.status) && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2 ** attempt, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, path, { body, headers, raw, attempt: attempt + 1 });
    }
    if (!res.ok) {
      let code = '';
      let message = '';
      try {
        const data = await res.json();
        code = data?.error?.code ?? '';
        message = data?.error?.message ?? '';
      } catch {
        // non-JSON error body
      }
      throw new GraphError(res.status, code, message || `${method} ${path.split('?')[0]} failed (${res.status})`);
    }
    if (raw || res.status === 204) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  workbookPath(suffix = '') {
    return `/drives/${this.item.driveId}/items/${this.item.itemId}/workbook${suffix}`;
  }

  // ---------- workbook and table ----------

  async resolveWorkbook() {
    if (this.item) return this.item;
    let driveItem;
    if (/^https?:\/\//i.test(this.location)) {
      driveItem = await this.request('GET', `/shares/${encodeSharingUrl(this.location)}/driveItem`, {
        headers: { Prefer: 'redeemSharingLink' },
      });
    } else {
      const path = normalisePath(this.location);
      try {
        driveItem = await this.request('GET', `/me/drive/root:${encodePath(path)}`);
      } catch (err) {
        if (!(err instanceof GraphError) || err.status !== 404) throw err;
        driveItem = await this.createFromTemplate(path);
      }
    }
    if (!driveItem?.file) throw new GraphError(400, 'notAFile', 'The workbook setting points to a folder, not an Excel file.');
    this.item = {
      location: this.location,
      driveId: driveItem.parentReference?.driveId,
      itemId: driveItem.id,
      parentId: driveItem.parentReference?.id,
      name: driveItem.name,
      webUrl: driveItem.webUrl,
    };
    return this.item;
  }

  async createFromTemplate(path) {
    const res = await this.fetch(TEMPLATE_URL);
    if (!res.ok) throw new Error('Could not load the workbook template.');
    const blob = new Blob([await res.arrayBuffer()], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // Uploading to a path creates any missing folders. "fail" means a file
    // created by a teammate at the same moment is never overwritten.
    return this.request('PUT', `/me/drive/root:${encodePath(path)}:/content?@microsoft.graph.conflictBehavior=fail`, { body: blob });
  }

  // Finds the InfoCapture table. Returns null when it does not exist yet; it
  // is created together with the first row (see insertRow).
  async loadTable() {
    if (this.table) return this.table;
    await this.resolveWorkbook();
    let table;
    try {
      table = await this.request('GET', this.workbookPath(`/tables/${TABLE_NAME}?$select=name`));
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) return null;
      throw err;
    }
    const header = await this.request('GET', this.workbookPath(`/tables/${table.name}/headerRowRange?$select=values`));
    this.table = { name: table.name, headers: (header.values?.[0] ?? []).map((h) => String(h).trim()) };
    return this.table;
  }

  async loadRowIndex() {
    const table = await this.loadTable();
    this.rowIndex = new Map();
    if (!table) return this.rowIndex;
    if (!table.headers.includes(ID_HEADER)) {
      throw new GraphError(400, 'missingIdColumn', `The ${TABLE_NAME} table needs an "${ID_HEADER}" column.`);
    }
    const col = await this.request('GET', this.workbookPath(`/tables/${table.name}/columns/${encodeURIComponent(ID_HEADER)}?$select=values`));
    (col.values ?? []).slice(1).forEach(([id], i) => {
      if (id) this.rowIndex.set(String(id), i);
    });
    return this.rowIndex;
  }

  // ---------- rows ----------

  // Adds or updates the record's row. `knownNew` skips the ID lookup for a
  // record that has never been sent before (the common, fast path).
  async upsert(record, { knownNew = false } = {}) {
    let table = await this.loadTable();
    if (!table) return this.createTableWithRow(record);
    if (!knownNew || this.rowIndex) {
      const index = this.rowIndex ?? (await this.loadRowIndex());
      if (index.has(record.id)) return this.updateRow(record, index.get(record.id));
    }
    const res = await this.request('POST', this.workbookPath(`/tables/${table.name}/rows`), {
      body: { values: [buildRow(record, table.headers)] },
    });
    if (this.rowIndex && Number.isInteger(res.index)) this.rowIndex.set(record.id, res.index);
    return { action: 'added', index: res.index };
  }

  async updateRow(record, index, retried = false) {
    const table = this.table;
    const rowPath = this.workbookPath(`/tables/${table.name}/rows/itemAt(index=${index})`);
    let existing = [];
    try {
      const current = await this.request('GET', `${rowPath}?$select=values`);
      existing = current.values?.[0] ?? [];
    } catch (err) {
      // The remembered position is past the end of a table that shrank.
      if (!(err instanceof GraphError) || ![400, 404].includes(err.status)) throw err;
    }
    const idCol = table.headers.indexOf(ID_HEADER);
    if (String(existing[idCol] ?? '') !== record.id) {
      // Someone deleted or sorted rows since we looked; find it again once.
      if (retried) throw new GraphError(409, 'rowMoved', 'The row moved while updating. Try syncing again.');
      const fresh = await this.loadRowIndex();
      if (!fresh.has(record.id)) return this.upsert(record, { knownNew: true });
      return this.updateRow(record, fresh.get(record.id), true);
    }
    await this.request('PATCH', rowPath, { body: { values: [buildRow(record, table.headers, existing)] } });
    return { action: 'updated', index };
  }

  async createTableWithRow(record) {
    const sheet = await this.pickEmptySheet();
    const headers = COLUMNS.map((c) => c.header);
    const address = `A1:${columnLetter(headers.length)}2`;
    const rangePath = this.workbookPath(`/worksheets/${sheet}/range(address='${address}')`);
    // A teammate's first sync may have created the table a moment ago.
    const target = await this.request('GET', `${rangePath}?$select=values`);
    if ((target.values ?? []).flat().some((v) => v !== '' && v !== null)) {
      this.table = null;
      if (await this.loadTable()) return this.upsert(record);
      throw new GraphError(409, 'sheetNotEmpty', `The "${sheet}" sheet is not empty. Clear it or remove it, then sync again.`);
    }
    await this.request('PATCH', rangePath, { body: { values: [headers, buildRow(record, headers)] } });
    const created = await this.request('POST', this.workbookPath(`/worksheets/${sheet}/tables/add`), {
      body: { address: `${sheet}!${address}`, hasHeaders: true },
    });
    await this.request('PATCH', this.workbookPath(`/tables/${created.id ?? created.name}`), {
      body: { name: TABLE_NAME, style: 'TableStyleMedium2' },
    });
    this.table = { name: TABLE_NAME, headers };
    this.rowIndex = new Map([[record.id, 0]]);
    return { action: 'added', index: 0, createdTable: true };
  }

  // The table goes on the "Leads" sheet (blank in the template). In someone's
  // existing workbook where "Leads" already holds data, it goes on a new
  // "InfoCapture" sheet instead.
  async pickEmptySheet() {
    for (const name of [SHEET_NAME, ALT_SHEET_NAME]) {
      let used;
      try {
        used = await this.request('GET', this.workbookPath(`/worksheets/${name}/usedRange(valuesOnly=true)?$select=values`));
      } catch (err) {
        if (!(err instanceof GraphError) || err.status !== 404) throw err;
        await this.request('POST', this.workbookPath('/worksheets/add'), { body: { name } });
        return name;
      }
      if (!(used.values ?? []).flat().some((v) => v !== '' && v !== null)) return name;
    }
    throw new GraphError(409, 'noEmptySheet', `Add a blank sheet named "${SHEET_NAME}" to the workbook, then sync again.`);
  }

  async remove(id) {
    const index = await this.loadRowIndex();
    if (!index.has(id)) return { action: 'missing' };
    const rowPath = this.workbookPath(`/tables/${this.table.name}/rows/itemAt(index=${index.get(id)})`);
    const current = await this.request('GET', `${rowPath}?$select=values`);
    const idCol = this.table.headers.indexOf(ID_HEADER);
    if (String(current.values?.[0]?.[idCol] ?? '') !== id) {
      this.rowIndex = null;
      throw new GraphError(409, 'rowMoved', 'The row moved while deleting. Try syncing again.');
    }
    await this.request('DELETE', rowPath);
    this.rowIndex = null; // indexes after the deleted row have shifted
    return { action: 'deleted' };
  }

  // ---------- card photos ----------

  async uploadPhoto(record, blob) {
    await this.resolveWorkbook();
    const name = photoFileName(record);
    const path = `/drives/${this.item.driveId}/items/${this.item.parentId}:/${encodeURIComponent(PHOTO_FOLDER)}/${encodeURIComponent(name)}:/content`;
    const item = await this.request('PUT', path, { body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg' } });
    return item.webUrl;
  }

  // Checks the connection end to end without writing anything.
  async check() {
    const item = await this.resolveWorkbook();
    const table = await this.loadTable();
    let rows = 0;
    if (table) rows = (await this.loadRowIndex()).size;
    return { name: item.name, webUrl: item.webUrl, hasTable: Boolean(table), rows };
  }
}

// ---------- row building ----------

// Builds one table row in header order. Cells for columns the app does not
// own keep their current value (`existing`) so teammates' extra columns
// survive edits.
export function buildRow(record, headers, existing = []) {
  const byHeader = new Map(COLUMNS.map((c) => [c.header, c]));
  return headers.map((header, i) => {
    const col = byHeader.get(header);
    if (!col) return existing[i] ?? '';
    return cellValue(record, col);
  });
}

export function cellValue(record, col) {
  const value = record[col.key];
  switch (col.kind) {
    case 'date':
      return excelDate(value);
    case 'list':
      return safeText((value ?? []).join(', '));
    case 'phone':
      // Keep "+1 555..." and leading zeros as typed instead of numbers.
      return value ? `'${value}` : '';
    case 'link':
      return value ? `=HYPERLINK("${String(value).replace(/"/g, '""')}","View photo")` : '';
    default:
      return safeText(value ?? '');
  }
}

// Text that starts with = + - @ would be treated as a formula by Excel.
// A leading apostrophe stores it as plain text (and is not displayed).
export function safeText(value) {
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// ---------- helpers ----------

export function encodeSharingUrl(url) {
  const bytes = new TextEncoder().encode(url);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return 'u!' + btoa(bin).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

function normalisePath(p) {
  let path = p.replace(/\\/g, '/').trim();
  if (!path.startsWith('/')) path = '/' + path;
  if (!/\.xlsx$/i.test(path)) path += '.xlsx';
  return path;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function photoFileName(record) {
  const d = new Date(record.createdAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
  const who = [record.firstName, record.lastName, record.company].filter(Boolean).join(' ');
  const base = `${stamp} ${who} ${record.id.slice(0, 8)}`
    .replace(/["*:<>?/\\|#%]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base}.jpg`;
}
