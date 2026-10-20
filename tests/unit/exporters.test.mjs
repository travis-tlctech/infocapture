import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toVCard } from '../../app/js/exporters.js';
import { parseQr } from '../../app/js/parsers.js';
import { fillBlanks } from '../../app/js/fields.js';

const rec = {
  id: 'id-1',
  createdAt: '2026-10-20T15:04:00.000Z',
  firstName: 'Zoë',
  lastName: "O'Brien",
  company: 'Acme, Inc.',
  title: 'Head of "Growth"',
  email: 'zoe@acme.example',
  phone: '+1 555 0100',
  notes: 'Line one\nLine two',
  tags: ['Hot lead', 'Follow up'],
  qrRaw: '=cmd|calc',
  event: 'Expo',
};

test('CSV escapes quotes, commas, newlines and formula injection', () => {
  const csv = toCsv([rec]);
  assert.ok(csv.startsWith('﻿Captured At,First Name,Last Name,Company'));
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes('"Acme, Inc."'));
  assert.ok(line.includes('"Head of ""Growth"""'));
  assert.ok(csv.includes('"Line one\nLine two"'));
  assert.ok(line.includes(`'+1 555 0100`));
  assert.ok(csv.includes(`'=cmd|calc`));
  assert.ok(line.includes('"Hot lead, Follow up"'));
});

test('vCard export round-trips through the QR parser', () => {
  const card = toVCard([rec]);
  assert.match(card, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  const back = parseQr(card);
  assert.equal(back.fields.firstName, 'Zoë');
  assert.equal(back.fields.lastName, "O'Brien");
  assert.equal(back.fields.company, 'Acme, Inc.');
  assert.equal(back.fields.phone, '+1 555 0100');
  assert.match(back.fields.other, /Met at Expo/);
});

test('fillBlanks never overwrites typed values', () => {
  const target = { firstName: 'Typed', lastName: '', email: '' };
  const changed = fillBlanks(target, { firstName: 'Card', lastName: 'Reader', email: '  ', company: 'Acme' });
  assert.equal(target.firstName, 'Typed');
  assert.equal(target.lastName, 'Reader');
  assert.equal(target.email, '');
  assert.equal(target.company, 'Acme');
  assert.deepEqual(changed.sort(), ['company', 'lastName']);
});

test('applyReading fills blanks, keeps unsure fields it filled, and holds extra people', async () => {
  const { applyReading } = await import('../../app/js/fields.js');
  const r = { firstName: '', lastName: '', title: 'Typed title', email: '' };
  const changed = applyReading(r, {
    contacts: [
      { fields: { firstName: 'Priya', lastName: 'Raman', title: 'VP', email: 'p@x.example' }, confidence: 0.5, unsure: ['title', 'email'] },
      { fields: { firstName: 'Sam', lastName: 'Lee' }, confidence: 0.9, unsure: [] },
    ],
  });
  assert.deepEqual(changed.sort(), ['email', 'firstName', 'lastName']);
  assert.equal(r.title, 'Typed title');
  assert.deepEqual(r.unsureKeys, ['email'], 'title was typed, so it is not flagged');
  assert.equal(r.readConfidence, 0.5);
  assert.equal(r.extraContacts.length, 1);
  assert.equal(r.extraContacts[0].fields.firstName, 'Sam');
  assert.equal(r.parseStatus, 'done');

  const empty = {};
  assert.deepEqual(applyReading(empty, { contacts: [], unreadable: 'declined' }), []);
  assert.equal(empty.parseStatus, 'unreadable');

  const old = { firstName: '' };
  applyReading(old, { fields: { firstName: 'Legacy' } });
  assert.equal(old.firstName, 'Legacy', 'a plain { fields } reply still works');
});
