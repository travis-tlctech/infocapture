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
