// Follow-up after the event, set on the lead board (Asana S3.1 and S3.2):
// the fields, how they map to the database, and the board's filters and
// metrics. The capture app never sends these fields.

export const POTENTIALS = ['High', 'Medium', 'Low'];

// Several can be ticked at once. Each metric counts its own status only, so
// the person ticks every status that applies (Travis's call, S3.1).
export const STATUSES = [
  'Initial Email Sent',
  'Second Email Sent',
  'Email Conversation Started',
  'Call Booked',
  'Signed up for Newsletter',
  'Moved to BD Pipeline',
  'Not Interested/No Response',
];

export const METRICS = [
  { key: 'conversation', label: 'Lead to conversation', status: 'Email Conversation Started' },
  { key: 'call', label: 'Lead to call booked', status: 'Call Booked' },
  { key: 'pipeline', label: 'Moved to BD pipeline', status: 'Moved to BD Pipeline' },
  { key: 'dead', label: 'Dead leads', status: 'Not Interested/No Response' },
];

// Record key -> database column.
export const FOLLOW_UP_COLUMNS = {
  potential: 'potential',
  followUpStatus: 'follow_up_status',
  followUpBy: 'follow_up_by',
};

export function followUpFromRow(row) {
  return {
    potential: row.potential ?? '',
    followUpStatus: Array.isArray(row.follow_up_status) ? row.follow_up_status : [],
    followUpBy: row.follow_up_by ?? '',
  };
}

// Only the fields in `patch`, so two people editing different fields of the
// same lead do not undo each other.
export function followUpToRow(patch) {
  const row = {};
  for (const [key, col] of Object.entries(FOLLOW_UP_COLUMNS)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (key === 'followUpStatus') row[col] = (v ?? []).filter((s) => STATUSES.includes(s));
    else if (key === 'potential') row[col] = POTENTIALS.includes(v) ? v : '';
    else row[col] = v || null; // follow_up_by is a user ID or null
  }
  return row;
}

// Initial Contact: the team member who captured the person first. Captures
// of the same person (the same email, or the same badge code) share it, and
// each lists the others. people: user ID -> name; a lead's createdBy is the
// login that captured it, capturedBy the name typed on that phone.
export function withInitialContact(leads, people = new Map()) {
  const who = (l) => people.get(l.createdBy) || l.capturedBy || '';
  const key = (l) => (l.email ?? '').trim().toLowerCase() || (l.qrRaw ? `qr:${l.qrRaw}` : '');
  const groups = new Map();
  for (const l of leads) {
    const k = key(l);
    if (k) groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const g of groups.values()) g.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return leads.map((l) => {
    const same = groups.get(key(l)) ?? [l];
    return {
      ...l,
      capturedByName: who(l),
      initialContact: who(same[0]),
      otherCaptures: same.filter((x) => x !== l).map((x) => ({ id: x.id, who: who(x), at: x.createdAt })),
    };
  });
}

// The leads matching the board's filters. f: { event, initial, person,
// potential, status, q }; '' means any, and '-' means not set. initial is
// an Initial Contact name (see withInitialContact).
export function filterLeads(leads, f = {}) {
  const q = (f.q ?? '').trim().toLowerCase();
  return leads.filter((l) => {
    if (f.event && l.event !== f.event) return false;
    if (f.initial && l.initialContact !== f.initial) return false;
    if (f.person === '-' ? l.followUpBy : f.person && l.followUpBy !== f.person) return false;
    if (f.potential === '-' ? l.potential : f.potential && l.potential !== f.potential) return false;
    if (f.status === '-' ? l.followUpStatus.length : f.status && !l.followUpStatus.includes(f.status)) return false;
    if (q && ![l.firstName, l.lastName, l.company, l.title, l.email, l.notes, l.event, l.initialContact, ...(l.tags ?? [])].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}

// The tiles: leads per event, and each metric as a count and a share of the
// leads given.
export function metrics(leads) {
  const perEvent = new Map();
  for (const l of leads) perEvent.set(l.event || 'No event', (perEvent.get(l.event || 'No event') ?? 0) + 1);
  const total = leads.length;
  return {
    total,
    perEvent: [...perEvent].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    tiles: METRICS.map((m) => {
      const count = leads.filter((l) => l.followUpStatus.includes(m.status)).length;
      return { ...m, count, pct: total ? Math.round((count / total) * 100) : 0 };
    }),
  };
}
