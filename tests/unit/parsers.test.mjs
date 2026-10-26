import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQr, splitName, worthAskingCardReader, encodeSetup, decodeSetup } from '../../app/js/parsers.js';

test('vCard 3.0 with folding, escapes, types and groups', () => {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:García;María José;;Dr.;',
    'FN:Dr. María José García',
    'ORG:Acme\\, Inc.;Research',
    'TITLE:VP of Product Engineering\\, ',
    ' EMEA',
    'EMAIL;TYPE=INTERNET:maria@example.com',
    'EMAIL;TYPE=INTERNET,PREF:mj@acme.example',
    'TEL;TYPE=WORK,VOICE:+34 91 555 0100',
    'TEL;TYPE=CELL:+34 600 123 456',
    'TEL;TYPE=FAX:+34 91 555 0199',
    'item1.URL:https://acme.example',
    'item2.URL:https://www.linkedin.com/in/mjgarcia',
    'ADR;TYPE=WORK:;;Calle Mayor 1;Madrid;;28013;Spain',
    'NOTE:Met at booth 42',
    'END:VCARD',
  ].join('\r\n');
  const r = parseQr(vcard);
  assert.equal(r.kind, 'vcard');
  assert.equal(r.structured, true);
  assert.deepEqual(
    { ...r.fields },
    {
      firstName: 'María José',
      lastName: 'García',
      company: 'Acme, Inc.',
      title: 'VP of Product Engineering, EMEA',
      email: 'mj@acme.example',
      phone: '+34 600 123 456',
      phoneAlt: '+34 91 555 0100',
      website: 'https://acme.example',
      linkedin: 'https://www.linkedin.com/in/mjgarcia',
      address: 'Calle Mayor 1, Madrid, 28013, Spain',
      other: 'Met at booth 42',
    },
  );
});

test('vCard 2.1 bare types, quoted-printable, FN only', () => {
  const vcard = 'BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ren=C3=A9e O\'Neil\nTEL;CELL:555-0101\nEMAIL;INTERNET:renee@example.org\nEND:VCARD';
  const r = parseQr(vcard);
  assert.equal(r.fields.firstName, 'Renée');
  assert.equal(r.fields.lastName, "O'Neil");
  assert.equal(r.fields.phone, '555-0101');
  assert.equal(r.fields.email, 'renee@example.org');
});

test('vCard 4.0 tel: URIs and social profile', () => {
  const vcard = 'BEGIN:VCARD\nVERSION:4.0\nN:Kim;Jun;;;\nTEL;VALUE=uri;TYPE="voice,cell":tel:+1-555-0102\nX-SOCIALPROFILE;TYPE=linkedin:https://linkedin.com/in/junkim\nEND:VCARD';
  const r = parseQr(vcard);
  assert.equal(r.fields.phone, '+1-555-0102');
  assert.equal(r.fields.linkedin, 'https://linkedin.com/in/junkim');
});

test('MECARD', () => {
  const r = parseQr('MECARD:N:Doe,John;TEL:+15550103;EMAIL:john\\;doe@example.com;ORG:Doe\\, Sons;URL:https://doe.example;NOTE:VIP;;');
  assert.equal(r.kind, 'mecard');
  assert.equal(r.fields.firstName, 'John');
  assert.equal(r.fields.lastName, 'Doe');
  assert.equal(r.fields.email, 'john;doe@example.com');
  assert.equal(r.fields.company, 'Doe, Sons');
  assert.equal(r.fields.website, 'https://doe.example');
  assert.equal(r.fields.other, 'VIP');
});

test('MECARD with full name and no comma', () => {
  const r = parseQr('MECARD:N:Jane Q Public;EMAIL:jane@example.com;;');
  assert.equal(r.fields.firstName, 'Jane Q');
  assert.equal(r.fields.lastName, 'Public');
});

test('BIZCARD', () => {
  const r = parseQr('BIZCARD:N:Sean;X:Owen;T:Engineer;C:Google;A:76 9th Ave, New York;B:+12125551212;M:+12125550000;E:sean@example.com;;');
  assert.equal(r.kind, 'bizcard');
  assert.deepEqual([r.fields.firstName, r.fields.lastName, r.fields.title, r.fields.company], ['Sean', 'Owen', 'Engineer', 'Google']);
  assert.equal(r.fields.phone, '+12125550000');
  assert.equal(r.fields.phoneAlt, '+12125551212');
});

test('JSON badge payloads, nested and with odd keys', () => {
  const r = parseQr(JSON.stringify({ badgeId: 'A123', attendee: { First_Name: 'Lee', 'Last Name': 'Wong', Organization: 'Initech', JobTitle: 'Buyer', Email: 'lee@initech.example', City: 'Austin', State: 'TX' } }));
  assert.equal(r.kind, 'json');
  assert.equal(r.structured, true);
  assert.equal(r.fields.firstName, 'Lee');
  assert.equal(r.fields.lastName, 'Wong');
  assert.equal(r.fields.company, 'Initech');
  assert.equal(r.fields.title, 'Buyer');
  assert.equal(r.fields.address, 'Austin, TX');
});

test('JSON with only a full name', () => {
  const r = parseQr('{"name":"Priya Natarajan","company":"Globex"}');
  assert.equal(r.fields.firstName, 'Priya');
  assert.equal(r.fields.lastName, 'Natarajan');
});

test('labelled text', () => {
  const r = parseQr('Name: Sam Taylor\nCompany: Umbrella Corp\nEmail: sam@umbrella.example\nPhone: (555) 010-0104');
  assert.equal(r.kind, 'labelled');
  assert.equal(r.fields.firstName, 'Sam');
  assert.equal(r.fields.company, 'Umbrella Corp');
  assert.equal(r.fields.phone, '(555) 010-0104');
});

test('links, mailto and tel', () => {
  assert.equal(parseQr('mailto:hi@example.com?subject=x').fields.email, 'hi@example.com');
  assert.equal(parseQr('tel:+15550105').fields.phone, '+15550105');
  const url = parseQr('https://events.example.com/lead/8f7a6');
  assert.equal(url.kind, 'url');
  assert.equal(url.url, 'https://events.example.com/lead/8f7a6');
  assert.equal(url.structured, false);
  assert.equal(parseQr('https://www.linkedin.com/in/someone').fields.linkedin, 'https://www.linkedin.com/in/someone');
});

test('unknown delimited text keeps what is unambiguous and asks the reader', () => {
  const raw = 'Alex^Rivera^Contoso^alex.rivera@contoso.example^+1 555 010 0106';
  const r = parseQr(raw);
  assert.equal(r.kind, 'text');
  assert.equal(r.structured, false);
  assert.equal(r.fields.email, 'alex.rivera@contoso.example');
  assert.equal(r.fields.phone, '+1 555 010 0106');
  assert.equal(worthAskingCardReader(r, raw), true);
});

test('bare badge IDs are not worth asking about', () => {
  for (const raw of ['1234567890', 'ATT-778812', 'https://x.example/abc']) {
    assert.equal(worthAskingCardReader(parseQr(raw), raw), false, raw);
  }
});

test('empty input', () => {
  const r = parseQr('   ');
  assert.equal(r.kind, 'text');
  assert.equal(r.structured, false);
});

test('splitName', () => {
  assert.deepEqual(splitName('Doe, Jane'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(splitName('Dr. Jane Doe'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(splitName('John Smith Jr.'), { firstName: 'John', lastName: 'Smith Jr.' });
  assert.deepEqual(splitName('John Smith, Jr.'), { firstName: 'John', lastName: 'Smith Jr.' });
  assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' });
});

test('setup links round-trip, ignore unknown keys and old Microsoft 365 links', () => {
  const encoded = encodeSetup({ supabaseUrl: 'https://abc.supabase.co', supabaseKey: 'sb_publishable_x', cardReaderUrl: 'https://r.example/', event: 'not shared', tenantId: 'old' });
  const decoded = decodeSetup(`https://app.example/#setup=${encoded}`);
  assert.deepEqual(decoded, { supabaseUrl: 'https://abc.supabase.co', supabaseKey: 'sb_publishable_x', cardReaderUrl: 'https://r.example/' });
  const v1 = Buffer.from(JSON.stringify({ v: 1, tenantId: 't-1', clientId: 'c-1' })).toString('base64url');
  assert.equal(decodeSetup(`#setup=${v1}`), null);
  assert.equal(decodeSetup('#/c/123'), null);
  assert.equal(decodeSetup('#setup=garbage!!'), null);
});
