// The team's events, listed in config.js, for the event picker. On an
// event's dates the app picks it by itself unless the person chose another.

import defaults from '../config.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHOW_ENDED_DAYS = 14; // ended events stay in the picker this long

// [{ name, start, end, place }], valid entries only, in date order.
export function teamEvents(list = defaults.events) {
  return (Array.isArray(list) ? list : [])
    .map((e) => ({ name: String(e?.name ?? '').trim(), start: String(e?.start ?? ''), end: String(e?.end || e?.start || ''), place: String(e?.place ?? '').trim() }))
    .filter((e) => e.name && DAY.test(e.start) && DAY.test(e.end) && e.start <= e.end)
    .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
}

// The phone's own date, as YYYY-MM-DD.
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n));
};

export const runningOn = (events, day) => events.filter((e) => e.start <= day && day <= e.end);

// The events worth offering: on now, coming up, or ended in the last two weeks.
export const pickerEvents = (events, day) => events.filter((e) => e.end >= addDays(day, -SHOW_ENDED_DAYS));

// The event the phone should switch to by itself, or null. Only when no
// event is set, or the one set is a listed event that has ended, and exactly
// one listed event is on today. An event typed in by hand is never replaced,
// and on a day two events overlap the person picks.
export function autoEvent(current, events, day) {
  const now = runningOn(events, day);
  if (now.length !== 1 || now[0].name === current) return null;
  const listed = events.find((e) => e.name === current);
  if (current && !(listed && listed.end < day)) return null;
  return now[0].name;
}

// "Nov 2 – 6, 2026" in the phone's language.
export function dateRange(e) {
  const at = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const fmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });
  return e.start === e.end ? fmt.format(at(e.start)) : fmt.formatRange(at(e.start), at(e.end));
}
