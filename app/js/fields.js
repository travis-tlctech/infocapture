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

// Spreadsheet / CSV columns, most useful first. The header text is how the
// app finds each column in Excel, so columns can be reordered (or extra
// columns added) in the workbook without breaking sync.
export const COLUMNS = [
  { key: 'createdAt', header: 'Captured At', kind: 'date' },
  { key: 'firstName', header: 'First Name' },
  { key: 'lastName', header: 'Last Name' },
  { key: 'company', header: 'Company' },
  { key: 'title', header: 'Title' },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone', kind: 'phone' },
  { key: 'tags', header: 'Tags', kind: 'list' },
  { key: 'notes', header: 'Notes' },
  { key: 'event', header: 'Event' },
  { key: 'capturedBy', header: 'Captured By' },
  { key: 'source', header: 'Source' },
  { key: 'phoneAlt', header: 'Other Phone', kind: 'phone' },
  { key: 'website', header: 'Website' },
  { key: 'linkedin', header: 'LinkedIn' },
  { key: 'address', header: 'Address' },
  { key: 'other', header: 'Other Info' },
  { key: 'cardImageUrl', header: 'Card Photo', kind: 'link' },
  { key: 'qrRaw', header: 'QR Data' },
  { key: 'updatedAt', header: 'Updated At', kind: 'date' },
  { key: 'id', header: 'ID' },
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

// Local time in a form Excel recognises as a date/time: 2026-10-20 14:05
export function excelDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
