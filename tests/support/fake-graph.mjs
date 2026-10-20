// An in-memory stand-in for the slice of Microsoft Graph that InfoCapture
// uses (OneDrive items, sharing links, Excel tables). Used by the unit tests
// through `fetchImpl` and by the Playwright tests through page.route().

const GRAPH = 'https://graph.microsoft.com/v1.0';

const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
const notFound = (what) => json(404, { error: { code: 'itemNotFound', message: `${what} not found` } });

function colIndex(letters) {
  return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
}

function parseAddress(address) {
  const m = address.replace(/^.*!/, '').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  return { c0: colIndex(m[1]), r0: Number(m[2]) - 1, c1: colIndex(m[3]), r1: Number(m[4]) - 1 };
}

export class FakeGraph {
  constructor() {
    this.items = new Map(); // id -> item
    this.workbooks = new Map(); // item id -> { sheets: Map(name -> cells[][]), tables: Map(name -> table) }
    this.requests = [];
    this.nextId = 1;
    this.driveId = 'drive-me';
    this.root = this.addItem({ name: 'root', folder: true, path: '' });
    this.failNext = null; // { match: RegExp, status } to inject one failure
  }

  addItem({ name, folder = false, path, parentId = null, driveId = this.driveId, content = null }) {
    const id = `item-${this.nextId++}`;
    const item = { id, name, folder, path, parentId, driveId, content, webUrl: `https://contoso.sharepoint.com/${encodeURI(path || name)}` };
    this.items.set(id, item);
    return item;
  }

  // A workbook somebody else shared (reached through a sharing link).
  addSharedWorkbook({ name = 'Team Leads.xlsx', link = 'https://contoso.sharepoint.com/:x:/s/sales/EaBcD' } = {}) {
    const folder = this.addItem({ name: 'Shared Documents', folder: true, path: 'sites/sales/Shared Documents', driveId: 'drive-sales' });
    const item = this.addItem({ name, path: `sites/sales/Shared Documents/${name}`, parentId: folder.id, driveId: 'drive-sales' });
    this.workbooks.set(item.id, { sheets: new Map([['Leads', []]]), tables: new Map() });
    this.sharingLinks ??= new Map();
    this.sharingLinks.set(link, item.id);
    return { item, link };
  }

  findByPath(path) {
    return [...this.items.values()].find((i) => i.driveId === this.driveId && i.path === path);
  }

  ensureFolders(path) {
    let parent = this.root;
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join('/');
      parent = this.findByPath(p) ?? this.addItem({ name: parts[i], folder: true, path: p, parentId: parent.id });
    }
    return parent;
  }

  itemJson(item) {
    return {
      id: item.id,
      name: item.name,
      webUrl: item.webUrl,
      ...(item.folder ? { folder: {} } : { file: {} }),
      parentReference: { driveId: item.driveId, id: item.parentId },
    };
  }

  table(name, itemId) {
    const wb = this.workbooks.get(itemId);
    return [...(wb?.tables.values() ?? [])].find((t) => t.name === name || t.id === name);
  }

  // Convenience for assertions: rows as objects keyed by header.
  rowsAsObjects(tableName = 'InfoCaptureLeads') {
    for (const wb of this.workbooks.values()) {
      const t = [...wb.tables.values()].find((x) => x.name === tableName);
      if (t) return t.rows.map((r) => Object.fromEntries(t.headers.map((h, i) => [h, r[i]])));
    }
    return [];
  }

  async fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url.startsWith('file:')) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const buf = await readFile(fileURLToPath(url));
      return new Response(buf, { status: 200 });
    }
    let body = init.body;
    if (body instanceof Blob) body = Buffer.from(await body.arrayBuffer());
    const res = await this.handle(init.method || 'GET', url, init.headers || {}, body);
    return new Response(res.body || null, { status: res.status, headers: res.headers });
  }

  async handle(method, url, headers, body) {
    this.requests.push({ method, url });
    if (this.failNext && this.failNext.match.test(`${method} ${url}`)) {
      const { status } = this.failNext;
      this.failNext = null;
      return json(status, { error: { code: 'injected', message: `Injected ${status}` } });
    }
    const auth = headers.Authorization || headers.authorization;
    if (!/^Bearer .+/.test(auth || '')) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'No token' } });
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    const data = body && !(body instanceof Uint8Array) && typeof body === 'string' ? JSON.parse(body) : body;
    let m;

    // GET /me/drive/root:/path   PUT /me/drive/root:/path:/content
    if ((m = path.match(/^\/me\/drive\/root:(.+?)(:\/content)?$/))) {
      const p = m[1].replace(/^\//, '');
      if (method === 'GET' && !m[2]) {
        const item = this.findByPath(p);
        return item ? json(200, this.itemJson(item)) : notFound(p);
      }
      if (method === 'PUT' && m[2]) {
        if (this.findByPath(p) && u.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail') {
          return json(409, { error: { code: 'nameAlreadyExists', message: 'exists' } });
        }
        const folderPath = p.split('/').slice(0, -1).join('/');
        const parent = this.ensureFolders(folderPath);
        const item = this.addItem({ name: p.split('/').pop(), path: p, parentId: parent.id, content: body });
        // The template has a blank "Leads" sheet and an "About" sheet.
        this.workbooks.set(item.id, { sheets: new Map([['Leads', []], ['About', [['InfoCapture leads']]]]), tables: new Map() });
        return json(201, this.itemJson(item));
      }
    }

    if ((m = path.match(/^\/shares\/(u![A-Za-z0-9_-]+)\/driveItem$/))) {
      const b64 = m[1].slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const link = Buffer.from(b64, 'base64').toString('utf8');
      const id = this.sharingLinks?.get(link);
      return id ? json(200, this.itemJson(this.items.get(id))) : notFound('share');
    }

    // Photo upload: PUT /drives/{d}/items/{parent}:/Card Photos/name.jpg:/content
    if ((m = path.match(/^\/drives\/([^/]+)\/items\/([^/:]+):\/(.+):\/content$/)) && method === 'PUT') {
      const parent = this.items.get(m[2]);
      if (!parent) return notFound('parent');
      const rel = m[3];
      const item = this.addItem({ name: rel.split('/').pop(), path: `${parent.path}/${rel}`, parentId: parent.id, driveId: m[1], content: body });
      item.contentType = headers['Content-Type'] || headers['content-type'];
      return json(201, this.itemJson(item));
    }

    if ((m = path.match(/^\/drives\/([^/]+)\/items\/([^/]+)\/workbook(\/.*)$/))) {
      const wb = this.workbooks.get(m[2]);
      if (!wb) return notFound('workbook');
      return this.workbook(m[2], wb, method, m[3], data);
    }
    return json(400, { error: { code: 'unsupported', message: `Fake Graph has no route for ${method} ${path}` } });
  }

  workbook(itemId, wb, method, sub, data) {
    let m;
    if ((m = sub.match(/^\/tables\/([^/]+)\/headerRowRange$/))) {
      const t = this.table(m[1], itemId);
      return t ? json(200, { values: [t.headers] }) : notFound('table');
    }
    if ((m = sub.match(/^\/tables\/([^/]+)\/columns\/([^/]+)$/))) {
      const t = this.table(m[1], itemId);
      if (!t) return notFound('table');
      const i = t.headers.indexOf(m[2]);
      if (i < 0) return notFound('column');
      return json(200, { name: m[2], values: [[m[2]], ...t.rows.map((r) => [r[i]])] });
    }
    if ((m = sub.match(/^\/tables\/([^/]+)\/rows$/)) && method === 'POST') {
      const t = this.table(m[1], itemId);
      if (!t) return notFound('table');
      for (const row of data.values) {
        if (row.length !== t.headers.length) return json(400, { error: { code: 'InvalidArgument', message: 'Row width does not match the table' } });
        t.rows.push([...row]);
      }
      return json(201, { index: t.rows.length - 1, values: data.values });
    }
    if ((m = sub.match(/^\/tables\/([^/]+)\/rows\/itemAt\(index=(\d+)\)$/))) {
      const t = this.table(m[1], itemId);
      const i = Number(m[2]);
      if (!t || i >= t.rows.length) return notFound('row');
      if (method === 'GET') return json(200, { index: i, values: [t.rows[i]] });
      if (method === 'PATCH') {
        if (data.values[0].length !== t.headers.length) return json(400, { error: { code: 'InvalidArgument', message: 'Row width does not match the table' } });
        t.rows[i] = [...data.values[0]];
        return json(200, { index: i, values: data.values });
      }
      if (method === 'DELETE') {
        t.rows.splice(i, 1);
        return json(204);
      }
    }
    if ((m = sub.match(/^\/tables\/([^/]+)$/))) {
      const t = this.table(m[1], itemId);
      if (!t) return notFound('table');
      if (method === 'PATCH') Object.assign(t, data);
      return json(200, { id: t.id, name: t.name });
    }
    if ((m = sub.match(/^\/worksheets\/([^/]+)\/usedRange\(valuesOnly=true\)$/))) {
      const cells = wb.sheets.get(m[1]);
      if (!cells) return notFound('worksheet');
      const hasTable = [...wb.tables.values()].some((t) => t.sheet === m[1]);
      const values = cells.length ? cells : [['']];
      return json(200, { values: hasTable ? [['x']] : values });
    }
    if (sub === '/worksheets/add' && method === 'POST') {
      wb.sheets.set(data.name, []);
      return json(201, { name: data.name });
    }
    if ((m = sub.match(/^\/worksheets\/([^/]+)\/range\(address='([A-Z0-9:]+)'\)$/))) {
      const cells = wb.sheets.get(m[1]);
      if (!cells) return notFound('worksheet');
      const a = parseAddress(m[2]);
      if (method === 'GET') {
        const values = [];
        for (let r = a.r0; r <= a.r1; r++) {
          values.push(Array.from({ length: a.c1 - a.c0 + 1 }, (_, c) => cells[r]?.[a.c0 + c] ?? ''));
        }
        return json(200, { values });
      }
      if (method === 'PATCH') {
        data.values.forEach((row, r) => {
          cells[a.r0 + r] ??= [];
          row.forEach((v, c) => { cells[a.r0 + r][a.c0 + c] = v; });
        });
        return json(200, { address: m[2] });
      }
    }
    if ((m = sub.match(/^\/worksheets\/([^/]+)\/tables\/add$/)) && method === 'POST') {
      const cells = wb.sheets.get(m[1]);
      const a = parseAddress(data.address);
      const grid = [];
      for (let r = a.r0; r <= a.r1; r++) grid.push(Array.from({ length: a.c1 - a.c0 + 1 }, (_, c) => cells[r]?.[a.c0 + c] ?? ''));
      const id = String(wb.tables.size + 1);
      const t = { id, name: `Table${id}`, sheet: m[1], headers: grid[0].map(String), rows: grid.slice(1) };
      wb.tables.set(id, t);
      for (let r = a.r0; r <= a.r1; r++) cells[r] = []; // the table owns these cells now
      return json(200, { id, name: t.name });
    }
    if ((m = sub.match(/^\/worksheets\/([^/]+)$/))) {
      return wb.sheets.has(m[1]) ? json(200, { name: m[1] }) : notFound('worksheet');
    }
    return json(400, { error: { code: 'unsupported', message: `Fake Graph has no workbook route for ${method} ${sub}` } });
  }
}

export { GRAPH };
