// Exports: the team spreadsheet (everyone's contacts, as .xlsx), and CSV and
// vCard files of what is stored on this device.

import { COLUMNS, SOURCE_LABELS, excelDate, displayName } from './fields.js';
import { buildXlsx } from './xlsx.js';

// records: contacts from the team list; photoLinks: card photo path -> link.
export function teamWorkbook(records, photoLinks = new Map()) {
  const rows = records.map((rec) =>
    COLUMNS.map((c) => {
      const v = rec[c.key];
      if (c.kind === 'list') return (v ?? []).join(', ');
      if (c.kind === 'source') return SOURCE_LABELS[v] ?? v ?? '';
      if (c.kind === 'photo') return v && photoLinks.get(v) ? { url: photoLinks.get(v), text: 'View photo' } : '';
      return v ?? '';
    }),
  );
  const columns = COLUMNS.map((c) => ({ header: c.header, width: c.width, kind: c.kind === 'photo' ? 'link' : c.kind === 'date' ? 'date' : 'text' }));
  return buildXlsx({ columns, rows, sheetName: 'Leads', tableName: 'InfoCaptureLeads' });
}

export function toCsv(records) {
  const lines = [COLUMNS.map((c) => csvCell(c.header)).join(',')];
  for (const rec of records) {
    lines.push(
      COLUMNS.map((c) => {
        const v = rec[c.key];
        if (c.kind === 'date') return csvCell(excelDate(v));
        if (c.kind === 'list') return csvCell((v ?? []).join(', '));
        return csvCell(v ?? '');
      }).join(','),
    );
  }
  // BOM so Excel opens accented names correctly.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function csvCell(value) {
  let s = String(value);
  // Spreadsheet apps run cells starting with = + - @ as formulas; QR codes
  // are untrusted input, so neutralise them.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toVCard(records) {
  return records.map(vcard).join('');
}

function vcard(r) {
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`N:${esc(r.lastName)};${esc(r.firstName)};;;`);
  lines.push(`FN:${esc(displayName(r) || 'Unknown')}`);
  if (r.company) lines.push(`ORG:${esc(r.company)}`);
  if (r.title) lines.push(`TITLE:${esc(r.title)}`);
  if (r.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${esc(r.email)}`);
  if (r.phone) lines.push(`TEL;TYPE=CELL:${esc(r.phone)}`);
  if (r.phoneAlt) lines.push(`TEL;TYPE=WORK:${esc(r.phoneAlt)}`);
  if (r.website) lines.push(`URL:${esc(r.website)}`);
  if (r.linkedin) lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${esc(r.linkedin)}`);
  if (r.address) lines.push(`ADR;TYPE=WORK:;;${esc(r.address)};;;;`);
  const note = [r.event && `Met at ${r.event}`, r.notes, (r.tags ?? []).length && `Tags: ${r.tags.join(', ')}`]
    .filter(Boolean)
    .join('\n');
  if (note) lines.push(`NOTE:${esc(note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

// Shares the file through the phone's share sheet when possible (mail,
// AirDrop, Teams), otherwise downloads it.
export async function shareOrDownload(filename, content, type) {
  const blob = new Blob([content], { type });
  const file = new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
