import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExcelStore, buildRow, cellValue, safeText, encodeSharingUrl, columnLetter, photoFileName } from '../../app/js/excel.js';
import { COLUMNS } from '../../app/js/fields.js';
import { FakeGraph } from '../support/fake-graph.mjs';

const HEADERS = COLUMNS.map((c) => c.header);

function record(overrides = {}) {
  return {
    id: overrides.id ?? `rec-${Math.random().toString(16).slice(2)}`,
    createdAt: '2026-10-20T15:04:00.000Z',
    updatedAt: '2026-10-20T15:04:00.000Z',
    source: 'qr',
    event: 'Expo 2026',
    capturedBy: 'Travis',
    firstName: 'Ana',
    lastName: 'Silva',
    company: 'Acme',
    title: 'CTO',
    email: 'ana@acme.io',
    phone: '+1 555 0100',
    phoneAlt: '',
    website: '',
    linkedin: '',
    address: '',
    other: '',
    tags: ['Hot lead'],
    notes: 'Wants a demo',
    qrRaw: 'BEGIN:VCARD...',
    cardImageUrl: '',
    ...overrides,
  };
}

function makeStore(graph, location = '/InfoCapture/InfoCapture Leads.xlsx', cached = null) {
  return new ExcelStore({ getToken: async () => 'token', location, cached, fetchImpl: (u, i) => graph.fetch(u, i) });
}

test('first sync creates the workbook from the template, then the table with the first row', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  const rec = record();
  const res = await store.upsert(rec, { knownNew: true });
  assert.equal(res.createdTable, true);

  const file = graph.findByPath('InfoCapture/InfoCapture Leads.xlsx');
  assert.ok(file, 'workbook uploaded to the OneDrive path');
  assert.ok(file.content.length > 1000, 'template bytes uploaded');
  const rows = graph.rowsAsObjects();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ID, rec.id);
  assert.equal(rows[0]['First Name'], 'Ana');
  assert.equal(rows[0].Phone, "'+1 555 0100");
  assert.equal(rows[0].Tags, 'Hot lead');
  const table = [...graph.workbooks.get(file.id).tables.values()][0];
  assert.equal(table.name, 'InfoCaptureLeads');
  assert.equal(table.style, 'TableStyleMedium2');
  assert.deepEqual(table.headers, HEADERS);
});

test('new rows append without an ID lookup; edits update in place', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  const a = record({ id: 'a' });
  const b = record({ id: 'b', firstName: 'Ben' });
  await store.upsert(a, { knownNew: true });
  const fresh = makeStore(graph); // a new app session
  graph.requests = [];
  await fresh.upsert(b, { knownNew: true });
  assert.equal(graph.requests.filter((r) => r.url.includes('/columns/')).length, 0, 'fast path skips the ID column read');
  assert.deepEqual(graph.rowsAsObjects().map((r) => r['First Name']), ['Ana', 'Ben']);

  await fresh.upsert({ ...b, notes: 'Follow up Tuesday' });
  const rows = graph.rowsAsObjects();
  assert.equal(rows.length, 2, 'update did not add a row');
  assert.equal(rows[1].Notes, 'Follow up Tuesday');
});

test('a retried insert does not duplicate the row', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  const rec = record({ id: 'retry-me' });
  await store.upsert(rec, { knownNew: true });
  // The response was lost, so the app retries without knownNew.
  await makeStore(graph).upsert(rec, { knownNew: false });
  assert.equal(graph.rowsAsObjects().length, 1);
});

test('columns teammates add are kept on update, and reordered columns still line up', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  const rec = record({ id: 'keep' });
  await store.upsert(rec, { knownNew: true });
  const table = [...[...graph.workbooks.values()][0].tables.values()][0];
  // Someone moves "Notes" to the front and adds an "Owner" column.
  const notesIdx = table.headers.indexOf('Notes');
  const reorder = (row) => [row[notesIdx], ...row.filter((_, i) => i !== notesIdx), ''];
  table.headers = reorder(table.headers).slice(0, -1).concat('Owner');
  table.rows = table.rows.map((r) => { const x = reorder(r); x[x.length - 1] = 'Priya'; return x; });

  const store2 = makeStore(graph);
  await store2.upsert({ ...rec, notes: 'Updated note' });
  const [row] = graph.rowsAsObjects();
  assert.equal(row.Owner, 'Priya');
  assert.equal(row.Notes, 'Updated note');
  assert.equal(table.headers[0], 'Notes');

  await store2.upsert(record({ id: 'new-one', notes: 'n2' }), { knownNew: true });
  assert.equal(graph.rowsAsObjects()[1].Notes, 'n2');
  assert.equal(graph.rowsAsObjects()[1].Owner, '');
});

test('update finds the row again after rows above it were deleted', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  for (const id of ['r1', 'r2', 'r3']) await store.upsert(record({ id }), { knownNew: true });
  await store.loadRowIndex();
  const table = [...[...graph.workbooks.values()][0].tables.values()][0];
  table.rows.splice(0, 1); // a teammate deletes r1 in Excel
  await store.upsert(record({ id: 'r3', notes: 'moved' }));
  const rows = graph.rowsAsObjects();
  assert.deepEqual(rows.map((r) => r.ID), ['r2', 'r3']);
  assert.equal(rows[1].Notes, 'moved');
  assert.equal(rows[0].Notes, 'Wants a demo');
});

test('remove deletes only the matching row', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  for (const id of ['x1', 'x2', 'x3']) await store.upsert(record({ id }), { knownNew: true });
  assert.deepEqual(await store.remove('x2'), { action: 'deleted' });
  assert.deepEqual(graph.rowsAsObjects().map((r) => r.ID), ['x1', 'x3']);
  assert.deepEqual(await store.remove('x2'), { action: 'missing' });
  await store.remove('x3');
  assert.deepEqual(graph.rowsAsObjects().map((r) => r.ID), ['x1']);
});

test('shared workbook through a sharing link, photo saved next to it', async () => {
  const graph = new FakeGraph();
  const { item, link } = graph.addSharedWorkbook();
  const store = makeStore(graph, link);
  const rec = record({ id: 'shared-1', source: 'card' });
  const url = await store.uploadPhoto(rec, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
  assert.match(url, /Card%20Photos/);
  await store.upsert({ ...rec, cardImageUrl: url }, { knownNew: true });
  const photo = [...graph.items.values()].find((i) => i.path.includes('Card Photos'));
  assert.equal(photo.driveId, 'drive-sales');
  assert.equal(photo.parentId, item.parentId);
  assert.equal(photo.contentType, 'image/jpeg');
  assert.match(photo.name, /^2026-10-\d\d \d{4} Ana Silva Acme shared-1\.jpg$/);
  assert.match(graph.rowsAsObjects()[0]['Card Photo'], /^=HYPERLINK\("https:\/\/contoso/);
  assert.ok(graph.requests.some((r) => r.url.includes('/shares/u!')));
});

test('an existing workbook whose Leads sheet has data gets an InfoCapture sheet', async () => {
  const graph = new FakeGraph();
  const { link } = graph.addSharedWorkbook();
  const wb = [...graph.workbooks.values()][0];
  wb.sheets.set('Leads', [['Their own data']]);
  await makeStore(graph, link).upsert(record({ id: 'own' }), { knownNew: true });
  assert.ok(wb.sheets.has('InfoCapture'));
  assert.equal([...wb.tables.values()][0].sheet, 'InfoCapture');
  assert.deepEqual(wb.sheets.get('Leads'), [['Their own data']], 'existing data untouched');
});

test('check() reports workbook state without writing', async () => {
  const graph = new FakeGraph();
  const { link } = graph.addSharedWorkbook({ name: 'Booth.xlsx' });
  const before = await makeStore(graph, link).check();
  assert.deepEqual({ name: before.name, hasTable: before.hasTable, rows: before.rows }, { name: 'Booth.xlsx', hasTable: false, rows: 0 });
  await makeStore(graph, link).upsert(record(), { knownNew: true });
  const after = await makeStore(graph, link).check();
  assert.equal(after.rows, 1);
});

test('cached workbook ids skip the lookup', async () => {
  const graph = new FakeGraph();
  const first = makeStore(graph);
  await first.upsert(record(), { knownNew: true });
  graph.requests = [];
  await makeStore(graph, undefined, first.item).upsert(record(), { knownNew: true });
  assert.equal(graph.requests.some((r) => r.url.includes('/root:')), false);
});

test('throttling is retried', async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  await store.upsert(record(), { knownNew: true });
  graph.failNext = { match: /POST .*\/rows$/, status: 429 };
  await store.upsert(record(), { knownNew: true });
  assert.equal(graph.rowsAsObjects().length, 2);
});

test('cell values neutralise formulas and keep phone formatting', () => {
  assert.equal(safeText('=HYPERLINK("http://evil")'), `'=HYPERLINK("http://evil")`);
  assert.equal(safeText('+1 555'), "'+1 555");
  assert.equal(safeText('-call back'), "'-call back");
  assert.equal(safeText('@handle'), "'@handle");
  assert.equal(safeText('Normal text'), 'Normal text');
  const phone = COLUMNS.find((c) => c.key === 'phone');
  assert.equal(cellValue({ phone: '0044 20 7946 0000' }, phone), "'0044 20 7946 0000");
  assert.equal(cellValue({ phone: '' }, phone), '');
  const link = COLUMNS.find((c) => c.key === 'cardImageUrl');
  assert.equal(cellValue({ cardImageUrl: 'https://x/"a"' }, link), '=HYPERLINK("https://x/""a""","View photo")');
  const row = buildRow(record({ notes: '=1+1' }), HEADERS);
  assert.equal(row[HEADERS.indexOf('Notes')], "'=1+1");
  assert.match(row[0], /^2026-10-\d\d \d\d:\d\d$/);
});

test('helpers', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(21), 'U');
  assert.equal(columnLetter(28), 'AB');
  assert.equal(encodeSharingUrl('https://onedrive.live.com/redir?resid=1231244193912!12&authKey=1201919!12921!1'),
    'u!aHR0cHM6Ly9vbmVkcml2ZS5saXZlLmNvbS9yZWRpcj9yZXNpZD0xMjMxMjQ0MTkzOTEyITEyJmF1dGhLZXk9MTIwMTkxOSExMjkyMSEx');
  assert.equal(photoFileName({ id: 'abcdef123456', createdAt: '2026-10-20T15:04:00Z', firstName: 'A/B', lastName: 'C:D' }).includes('/'), false);
});
