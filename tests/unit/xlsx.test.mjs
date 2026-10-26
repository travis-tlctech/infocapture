import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, columnLetter, excelSerial, crc32 } from '../../app/js/xlsx.js';
import { teamWorkbook } from '../../app/js/exporters.js';
import { COLUMNS } from '../../app/js/fields.js';
import { unzip } from '../support/unzip.mjs';

test('column letters and CRC32', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('dates become Excel serial numbers in local time', () => {
  const d = new Date(2026, 9, 20, 14, 30); // local 2026-10-20 14:30
  assert.equal(Math.round(excelSerial(d) * 1440) / 1440, 46315 + 14.5 / 24);
  assert.equal(excelSerial('not a date'), null);
});

test('a workbook has one sheet with a table, typed cells and photo links', () => {
  const bytes = buildXlsx({
    sheetName: 'Leads',
    tableName: 'InfoCaptureLeads',
    columns: [{ header: 'When', kind: 'date' }, { header: 'Name' }, { header: 'Photo', kind: 'link' }],
    rows: [
      [new Date(2026, 9, 20, 9, 0), '=HYPERLINK("http://evil")', { url: 'https://x.example/a?token=1&b=2', text: 'View photo' }],
      ['', 'Zoë <b>&\u0007 😀 \uD83D', ''],
    ],
  });
  const files = unzip(bytes);
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/tables/table1.xml']);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  // A formula-looking value is plain text, never a formula.
  assert.ok(sheet.includes('<c r="B2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;)</t></is></c>'));
  assert.ok(!sheet.includes('<f>'));
  assert.match(sheet, /<c r="A2" s="2"><v>46315\.375/);
  assert.ok(sheet.includes('Zoë &lt;b&gt;&amp; 😀 </t>'), 'control characters and half emoji removed, whole emoji kept');
  assert.ok(sheet.includes('<hyperlink ref="C2" r:id="rId2"/>'));
  assert.ok(sheet.indexOf('<hyperlinks>') < sheet.indexOf('<tableParts'), 'element order Excel expects');
  assert.ok(files.get('xl/worksheets/_rels/sheet1.xml.rels').includes('Target="https://x.example/a?token=1&amp;b=2" TargetMode="External"'));
  const table = files.get('xl/tables/table1.xml');
  assert.ok(table.includes('ref="A1:C3"'));
  assert.ok(table.includes('<tableColumn id="3" name="Photo"/>'));
  assert.ok(files.get('xl/workbook.xml').includes('<sheet name="Leads" sheetId="1" r:id="rId1"/>'));
});

test('an empty workbook still has a valid table body row', () => {
  const files = unzip(buildXlsx({ columns: [{ header: 'A' }, { header: 'B' }], rows: [] }));
  assert.ok(files.get('xl/tables/table1.xml').includes('ref="A1:B2"'));
});

test('the team spreadsheet has every column, source labels and photo links', () => {
  const rec = {
    id: 'id-1', createdAt: '2026-10-20T15:04:00.000Z', updatedAt: '2026-10-20T15:10:00.000Z', firstName: 'Priya', lastName: 'Raman',
    tags: ['Hot lead', 'Send info'], source: 'card', cardPhotoPath: 'id-1.jpg', phone: '+1 646 555 0188',
  };
  const files = unzip(teamWorkbook([rec, { id: 'id-2', createdAt: '2026-10-20T16:00:00.000Z', firstName: 'Bo', source: 'manual', cardPhotoPath: '' }], new Map([['id-1.jpg', 'https://test.supabase.co/storage/v1/object/sign/card-photos/id-1.jpg?token=t']])));
  const sheet = files.get('xl/worksheets/sheet1.xml');
  for (const c of COLUMNS) assert.ok(sheet.includes(`>${c.header}</t>`), c.header);
  assert.ok(sheet.includes('>Hot lead, Send info</t>'));
  assert.ok(sheet.includes('>Card photo</t>') && sheet.includes('>Typed</t>'));
  assert.ok(sheet.includes('>+1 646 555 0188</t>'), 'phone numbers stay text, no apostrophe needed');
  assert.ok(sheet.includes('>View photo</t>'));
  assert.equal((files.get('xl/worksheets/_rels/sheet1.xml.rels').match(/TargetMode="External"/g) ?? []).length, 1);
  assert.ok(files.get('xl/tables/table1.xml').includes(`ref="A1:U3"`));
});
