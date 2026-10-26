// Turns the text inside a badge QR code into contact fields.
//
// Handles vCard (2.1/3.0/4.0), MECARD, BIZCARD, JSON payloads, labelled
// text ("Name: Jane Doe"), mailto:/tel: links and plain URLs. Anything else
// is returned as kind "text" so the caller can ask the card reader (Claude)
// to make sense of it, or show it raw.

import { emptyContact } from './fields.js';

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;
const NAME_SUFFIXES = /^(jr\.?|sr\.?|ii|iii|iv|phd|ph\.d\.|md|m\.d\.|mba|esq\.?|cpa|pe|pmp)$/i;
const NAME_PREFIXES = /^(mr|mrs|ms|miss|dr|prof)\.?$/i;

const KEY_MAP = {
  firstName: ['firstname', 'first', 'givenname', 'fname', 'given', 'forename'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'lname', 'family'],
  fullName: ['name', 'fullname', 'displayname', 'attendeename', 'contactname', 'badgename'],
  company: ['company', 'companyname', 'organization', 'organisation', 'org', 'employer', 'account', 'business'],
  title: ['title', 'jobtitle', 'position', 'role', 'designation', 'jobrole'],
  email: ['email', 'emailaddress', 'mail', 'workemail', 'businessemail'],
  phone: ['phone', 'mobile', 'cell', 'phonenumber', 'mobilephone', 'mobilenumber', 'cellphone', 'telephone', 'tel', 'workphone', 'businessphone'],
  website: ['website', 'url', 'web', 'site', 'companywebsite', 'homepage'],
  linkedin: ['linkedin', 'linkedinurl', 'linkedinprofile'],
  address: ['address', 'fulladdress', 'mailingaddress', 'streetaddress'],
  city: ['city', 'town'],
  region: ['state', 'province', 'region'],
  country: ['country'],
};
const KEY_LOOKUP = new Map(Object.entries(KEY_MAP).flatMap(([field, keys]) => keys.map((k) => [k, field])));

export function parseQr(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '').trim();
  const fields = emptyContact();
  const result = { kind: 'text', structured: false, fields, url: '' };
  if (!text) return result;

  if (/^BEGIN:VCARD/i.test(text)) return finish(result, 'vcard', parseVCard(text));
  if (/^MECARD:/i.test(text)) return finish(result, 'mecard', parseMeCard(text));
  if (/^BIZCARD:/i.test(text)) return finish(result, 'bizcard', parseBizCard(text));

  if (text.startsWith('{')) {
    try {
      const mapped = mapKeyValues(flatten(JSON.parse(text)));
      if (mapped) return finish(result, 'json', mapped);
    } catch {
      // not JSON after all; fall through to text handling
    }
  }

  if (/^mailto:/i.test(text)) {
    fields.email = decodeURIComponent(text.slice(7).split('?')[0]).trim();
    result.kind = 'email';
    return result;
  }
  if (/^tel:/i.test(text)) {
    fields.phone = decodeURIComponent(text.slice(4)).trim();
    result.kind = 'phone';
    return result;
  }
  if (/^https?:\/\/\S+$/i.test(text)) {
    result.kind = 'url';
    result.url = text;
    if (/linkedin\.com\/(in|pub)\//i.test(text)) fields.linkedin = text;
    return result;
  }

  const labelled = parseLabelledLines(text);
  if (labelled) return finish(result, 'labelled', labelled);

  // Unknown layout: pull out whatever is unambiguous.
  fields.email = text.match(EMAIL_RE)?.[0] ?? '';
  const url = text.match(URL_RE)?.[0] ?? '';
  if (/linkedin\.com/i.test(url)) fields.linkedin = url;
  else if (url && !url.includes('@')) fields.website = url;
  const phone = text.replace(EMAIL_RE, ' ').replace(URL_RE, ' ').match(PHONE_RE)?.[0];
  if (phone && phone.replace(/\D/g, '').length >= 7) fields.phone = phone.trim();
  return result;
}

// True when the QR text looks like it holds contact details we could not
// place (for example "Jane^Doe^Acme"), so the card reader is worth asking.
// Bare badge IDs and links are not worth a round trip.
export function worthAskingCardReader(result, raw) {
  if (result.kind !== 'text') return false;
  const text = String(raw ?? '');
  return /[A-Za-z]{2,}/.test(text) && /[\s,;|^\t]/.test(text.trim());
}

function finish(result, kind, fields) {
  Object.assign(result.fields, fields);
  result.kind = kind;
  const f = result.fields;
  result.structured = Boolean(f.firstName || f.lastName || f.email);
  return result;
}

// ---------- vCard ----------

function parseVCard(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const f = {};
  const phones = [];
  const emails = [];
  const urls = [];
  const notes = [];
  let fullName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = indexOfOutsideQuotes(line, ':');
    if (colon < 0) continue;
    const head = line.slice(0, colon).split(';');
    let value = line.slice(colon + 1);
    let name = head[0].trim().toUpperCase();
    name = name.slice(name.lastIndexOf('.') + 1); // drop "item1." groups
    const params = head.slice(1).map((p) => p.trim().toUpperCase());
    const types = params.flatMap((p) => {
      const [k, v] = p.includes('=') ? p.split('=', 2) : ['TYPE', p];
      return k === 'TYPE' ? v.replace(/"/g, '').split(',') : [];
    });
    if (params.some((p) => p.includes('QUOTED-PRINTABLE'))) {
      while (value.endsWith('=') && i + 1 < lines.length) value = value.slice(0, -1) + lines[++i];
      value = decodeQuotedPrintable(value);
    }

    switch (name) {
      case 'N': {
        const [last = '', first = ''] = splitUnescaped(value, ';').map(unescapeVCard);
        f.lastName = last.trim();
        f.firstName = first.trim();
        break;
      }
      case 'FN':
        fullName = unescapeVCard(value).trim();
        break;
      case 'ORG':
        f.company = unescapeVCard(splitUnescaped(value, ';')[0]).trim();
        break;
      case 'TITLE':
        f.title ||= unescapeVCard(value).trim();
        break;
      case 'ROLE':
        f.role = unescapeVCard(value).trim();
        break;
      case 'EMAIL':
        emails.push({ value: unescapeVCard(value).replace(/^mailto:/i, '').trim(), pref: types.includes('PREF') });
        break;
      case 'TEL':
        phones.push({ value: unescapeVCard(value).replace(/^tel:/i, '').trim(), types });
        break;
      case 'URL':
        urls.push(unescapeVCard(value).trim());
        break;
      case 'X-SOCIALPROFILE':
      case 'X-LINKEDIN':
        if (name === 'X-LINKEDIN' || types.includes('LINKEDIN') || /linkedin/i.test(value)) {
          f.linkedin ||= unescapeVCard(value).trim();
        }
        break;
      case 'ADR':
        f.address ||= splitUnescaped(value, ';')
          .map((part) => unescapeVCard(part).replace(/\n+/g, ', ').trim())
          .filter(Boolean)
          .join(', ');
        break;
      case 'LABEL':
        f.label = unescapeVCard(value).replace(/\n+/g, ', ').trim();
        break;
      case 'NOTE':
        notes.push(unescapeVCard(value).trim());
        break;
      default:
        break;
    }
  }

  if (!f.firstName && !f.lastName && fullName) Object.assign(f, splitName(fullName));
  if (!f.title && f.role) f.title = f.role;
  if (!f.address && f.label) f.address = f.label;
  delete f.role;
  delete f.label;

  const email = emails.find((e) => e.pref) ?? emails[0];
  if (email) f.email = email.value;
  Object.assign(f, pickPhones(phones));
  f.linkedin ||= urls.find((u) => /linkedin\.com/i.test(u)) ?? '';
  f.website = urls.find((u) => !/linkedin\.com/i.test(u)) ?? '';
  f.other = notes.filter(Boolean).join('; ');
  return f;
}

function pickPhones(phones) {
  const usable = phones.filter((p) => p.value);
  const notFax = usable.filter((p) => !p.types.includes('FAX'));
  const pool = notFax.length ? notFax : usable;
  const mobile = pool.find((p) => p.types.some((t) => ['CELL', 'MOBILE', 'IPHONE'].includes(t)));
  const first = mobile ?? pool[0];
  const second = pool.find((p) => p !== first);
  return { phone: first?.value ?? '', phoneAlt: second?.value ?? '' };
}

function decodeQuotedPrintable(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(value[i]));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function unescapeVCard(s) {
  return s.replace(/\\([nN,;:\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// ---------- MECARD / BIZCARD ----------

function parseMeCard(text) {
  const f = {};
  const tels = [];
  const notes = [];
  for (const [key, rawValue] of keyValueParts(text.replace(/^MECARD:/i, ''))) {
    const value = unescapeMeCard(rawValue).trim();
    if (!value) continue;
    switch (key) {
      case 'N': {
        const [last = '', first = ''] = splitUnescaped(rawValue, ',').map((s) => unescapeMeCard(s).trim());
        f.lastName = last;
        f.firstName = first;
        break;
      }
      case 'TEL':
        tels.push(value);
        break;
      case 'EMAIL':
        f.email ||= value;
        break;
      case 'URL':
        if (/linkedin\.com/i.test(value)) f.linkedin ||= value;
        else f.website ||= value;
        break;
      case 'ADR':
        f.address = splitUnescaped(rawValue, ',').map((s) => unescapeMeCard(s).trim()).filter(Boolean).join(', ');
        break;
      case 'ORG':
        f.company = value;
        break;
      case 'TITLE':
        f.title = value;
        break;
      case 'NOTE':
        notes.push(value);
        break;
      default:
        break;
    }
  }
  // MECARD puts the whole name in N without a comma more often than not.
  if (f.lastName && !f.firstName && f.lastName.includes(' ')) Object.assign(f, splitName(f.lastName));
  f.phone = tels[0] ?? '';
  f.phoneAlt = tels[1] ?? '';
  f.other = notes.join('; ');
  return f;
}

function parseBizCard(text) {
  const f = {};
  const phones = [];
  for (const [key, rawValue] of keyValueParts(text.replace(/^BIZCARD:/i, ''))) {
    const value = unescapeMeCard(rawValue).trim();
    if (!value) continue;
    switch (key) {
      case 'N': f.firstName = value; break;
      case 'X': f.lastName = value; break;
      case 'T': f.title = value; break;
      case 'C': f.company = value; break;
      case 'A': f.address = value; break;
      case 'E': f.email = value; break;
      case 'M': phones.unshift(value); break;
      case 'B': phones.push(value); break;
      default: break;
    }
  }
  f.phone = phones[0] ?? '';
  f.phoneAlt = phones[1] ?? '';
  return f;
}

function keyValueParts(body) {
  const out = [];
  for (const part of splitUnescaped(body, ';')) {
    const idx = part.indexOf(':');
    if (idx > 0) out.push([part.slice(0, idx).trim().toUpperCase(), part.slice(idx + 1)]);
  }
  return out;
}

function unescapeMeCard(s) {
  return s.replace(/\\([\\;:,"])/g, '$1');
}

// ---------- JSON and labelled text ----------

function flatten(value, out = [], depth = 0) {
  if (value && typeof value === 'object' && depth < 4) {
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') flatten(v, out, depth + 1);
      else if (typeof v === 'string' || typeof v === 'number') out.push([k, String(v)]);
    }
  }
  return out;
}

function mapKeyValues(pairs) {
  const f = {};
  for (const [key, value] of pairs) {
    const field = KEY_LOOKUP.get(key.toLowerCase().replace(/[^a-z]/g, ''));
    if (field && value.trim() && !f[field]) f[field] = value.trim();
  }
  if (f.fullName && !f.firstName && !f.lastName) Object.assign(f, splitName(f.fullName));
  if (!f.address) {
    const place = [f.city, f.region, f.country].filter(Boolean).join(', ');
    if (place) f.address = place;
  }
  delete f.fullName;
  delete f.city;
  delete f.region;
  delete f.country;
  if (f.website && /linkedin\.com/i.test(f.website) && !f.linkedin) {
    f.linkedin = f.website;
    f.website = '';
  }
  return Object.values(f).some(Boolean) ? f : null;
}

function parseLabelledLines(text) {
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z .\-_]{0,30}?)\s*:\s*(.+)$/);
    if (m) pairs.push([m[1], m[2]]);
  }
  if (pairs.length < 2) return null;
  const mapped = mapKeyValues(pairs);
  return mapped && (mapped.firstName || mapped.lastName || mapped.email) ? mapped : null;
}

// ---------- helpers ----------

export function splitName(full) {
  const clean = String(full).replace(/\s+/g, ' ').trim();
  if (!clean) return { firstName: '', lastName: '' };
  if (clean.includes(',')) {
    const [last, ...rest] = clean.split(',');
    const first = rest.join(',').trim();
    if (first && !NAME_SUFFIXES.test(first)) return { firstName: first, lastName: last.trim() };
  }
  const words = clean.split(' ');
  while (words.length > 1 && NAME_PREFIXES.test(words[0])) words.shift();
  if (words.length === 1) return { firstName: words[0], lastName: '' };
  let lastIdx = words.length - 1;
  if (lastIdx > 1 && NAME_SUFFIXES.test(words[lastIdx].replace(/,$/, ''))) lastIdx -= 1;
  return {
    firstName: words.slice(0, lastIdx).join(' '),
    lastName: words.slice(lastIdx).join(' ').replace(/,(?=\s)/, ''),
  };
}

function splitUnescaped(s, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function indexOfOutsideQuotes(s, ch) {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (s[i] === ch && !quoted) return i;
  }
  return -1;
}

// ---------- team setup links ----------

const SETUP_KEYS = ['supabaseUrl', 'supabaseKey', 'cardReaderUrl'];
const SETUP_VERSION = 2; // version 1 links carried Microsoft 365 settings

// Setup links look like https://<app>/#setup=<base64url JSON>. They carry no
// secrets: only the URLs and the publishable key every teammate's app needs.
// Each person still signs in with their own login.
export function encodeSetup(settings) {
  const data = { v: SETUP_VERSION };
  for (const k of SETUP_KEYS) if (settings[k]) data[k] = settings[k];
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSetup(text) {
  const m = String(text ?? '').match(/[#&?]setup=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (data?.v !== SETUP_VERSION) return null;
    const out = {};
    for (const k of SETUP_KEYS) if (typeof data[k] === 'string') out[k] = data[k].trim();
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
