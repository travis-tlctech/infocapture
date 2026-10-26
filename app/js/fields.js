// Contact fields shown in the form, in display order.
export const CONTACT_FIELDS = [
  { key: 'firstName', label: 'First name', autocomplete: 'given-name' },
  { key: 'lastName', label: 'Last name', autocomplete: 'family-name' },
  { key: 'company', label: 'Company', autocomplete: 'organization' },
  { key: 'title', label: 'Title', autocomplete: 'organization-title' },
  { key: 'email', label: 'Email', type: 'email', inputmode: 'email', autocomplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel' },
  { key: 'phoneAlt', label: 'Other phone', type: 'tel', inputmode: 'tel', more: true },
  { key: 'website', label: 'Website', type: 'url', inputmode: 'url', more: true },
  { key: 'linkedin', label: 'LinkedIn', type: 'url', inputmode: 'url', more: true },
  { key: 'address', label: 'Address', more: true },
  { key: 'other', label: 'Other info from card', more: true },
];

export const CONTACT_KEYS = CONTACT_FIELDS.map((f) => f.key);

// Columns of the team spreadsheet and the CSV export, most useful first.
// width is the Excel column width in characters.
export const COLUMNS = [
  { key: 'createdAt', header: 'Captured At', kind: 'date', width: 17 },
  { key: 'firstName', header: 'First Name', width: 14 },
  { key: 'lastName', header: 'Last Name', width: 16 },
  { key: 'company', header: 'Company', width: 24 },
  { key: 'title', header: 'Title', width: 24 },
  { key: 'email', header: 'Email', width: 30 },
  { key: 'phone', header: 'Phone', kind: 'phone', width: 17 },
  { key: 'tags', header: 'Tags', kind: 'list', width: 20 },
  { key: 'notes', header: 'Notes', width: 40 },
  { key: 'event', header: 'Event', width: 20 },
  { key: 'capturedBy', header: 'Captured By', width: 16 },
  { key: 'source', header: 'Source', kind: 'source', width: 11 },
  { key: 'phoneAlt', header: 'Other Phone', kind: 'phone', width: 17 },
  { key: 'website', header: 'Website', width: 24 },
  { key: 'linkedin', header: 'LinkedIn', width: 24 },
  { key: 'address', header: 'Address', width: 30 },
  { key: 'other', header: 'Other Info', width: 30 },
  { key: 'cardPhotoPath', header: 'Card Photo', kind: 'photo', width: 12 },
  { key: 'qrRaw', header: 'QR Data', width: 20 },
  { key: 'updatedAt', header: 'Updated At', kind: 'date', width: 17 },
  { key: 'id', header: 'ID', width: 38 },
];

export const SOURCE_LABELS = { qr: 'Badge QR', card: 'Card photo', manual: 'Typed' };

export function emptyContact() {
  return Object.fromEntries(CONTACT_KEYS.map((k) => [k, '']));
}

export function displayName(rec) {
  const name = [rec.firstName, rec.lastName].filter(Boolean).join(' ').trim();
  return name || rec.email || rec.company || '';
}

// Copies values from `incoming` into `target` only where `target` is blank,
// so automatic fills never overwrite something the user already typed.
export function fillBlanks(target, incoming) {
  const changed = [];
  for (const key of CONTACT_KEYS) {
    const value = (incoming?.[key] ?? '').toString().trim();
    if (value && !(target[key] ?? '').toString().trim()) {
      target[key] = value;
      changed.push(key);
    }
  }
  return changed;
}

// Applies a card reader reply to a stored record. The first person on the
// card fills blank fields; fields the reader was unsure of are remembered so
// the form can mark them for checking; anyone else on the card is kept so
// the form can offer to add them as separate contacts. Returns the keys
// that were filled.
export function applyReading(r, reading) {
  const contacts = reading?.contacts ?? (reading?.fields ? [{ fields: reading.fields, confidence: 1, unsure: [] }] : []);
  const [first, ...rest] = contacts;
  r.parseError = '';
  if (!first) {
    r.parseStatus = 'unreadable';
    r.parsedKeys = [];
    r.unsureKeys = [];
    return [];
  }
  const changed = fillBlanks(r, first.fields);
  r.parsedKeys = changed;
  r.unsureKeys = (first.unsure ?? []).filter((k) => changed.includes(k));
  r.readConfidence = Number(first.confidence ?? 1);
  r.extraContacts = rest.map((c) => ({ fields: c.fields ?? {}, unsure: c.unsure ?? [] }));
  r.parseStatus = 'done';
  return changed;
}

// Local time in a form Excel recognises as a date/time: 2026-10-20 14:05
export function excelDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
