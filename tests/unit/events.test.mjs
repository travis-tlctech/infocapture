// The team's event list and the automatic pick by date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamEvents, localDay, runningOn, pickerEvents, autoEvent, dateRange } from '../../app/js/events.js';

const EVENTS = teamEvents([
  { name: 'IAEM 2026', start: '2026-11-06', end: '2026-11-09', place: 'Long Beach, CA' },
  { name: 'NPPERS 2026', start: '2026-11-02', end: '2026-11-06', place: 'Corpus Christi, TX' },
  { name: 'Bad dates', start: '2026-11-09', end: '2026-11-01' },
  { name: '', start: '2026-11-01' },
  { name: 'One day', start: '2026-12-01' },
]);

test('config.js lists the first two events', () => {
  assert.deepEqual(teamEvents().map((e) => e.name), ['NPPERS 2026', 'IAEM 2026']);
});

test('only valid events are kept, in date order; a one-day event needs only a start', () => {
  assert.deepEqual(EVENTS.map((e) => e.name), ['NPPERS 2026', 'IAEM 2026', 'One day']);
  assert.equal(EVENTS[2].end, '2026-12-01');
  assert.deepEqual(teamEvents(undefined), teamEvents());
  assert.deepEqual(teamEvents('nonsense'), []);
});

test('localDay is the phone\'s own date', () => {
  assert.equal(localDay(new Date(2026, 10, 2, 23, 59)), '2026-11-02');
});

test('the event on today is picked when none is set', () => {
  assert.equal(autoEvent('', EVENTS, '2026-11-02'), 'NPPERS 2026');
  assert.equal(autoEvent('', EVENTS, '2026-11-08'), 'IAEM 2026');
  assert.equal(autoEvent('', EVENTS, '2026-10-30'), null); // nothing on yet
  assert.equal(autoEvent('', EVENTS, '2026-11-06'), null); // two on the same day: the person picks
});

test('a listed event that has ended gives way to the next; anything else stays', () => {
  assert.equal(autoEvent('NPPERS 2026', EVENTS, '2026-11-07'), 'IAEM 2026');
  assert.equal(autoEvent('NPPERS 2026', EVENTS, '2026-11-05'), null); // still on
  assert.equal(autoEvent('NPPERS 2026', EVENTS, '2026-11-06'), null); // its last day
  assert.equal(autoEvent('IAEM 2026', EVENTS, '2026-11-08'), null); // already set
  assert.equal(autoEvent('Board dinner', EVENTS, '2026-11-03'), null); // typed in by hand
  assert.equal(autoEvent('IAEM 2026', EVENTS, '2026-11-20'), null); // nothing on
});

test('the picker offers events that are on, coming up, or ended in the last two weeks', () => {
  assert.deepEqual(runningOn(EVENTS, '2026-11-06').map((e) => e.name), ['NPPERS 2026', 'IAEM 2026']);
  assert.deepEqual(pickerEvents(EVENTS, '2026-11-20').map((e) => e.name), ['NPPERS 2026', 'IAEM 2026', 'One day']);
  assert.deepEqual(pickerEvents(EVENTS, '2026-11-21').map((e) => e.name), ['IAEM 2026', 'One day']);
});

test('dates read naturally', () => {
  assert.match(dateRange(EVENTS[0]), /Nov 2\D+6, 2026/);
  assert.match(dateRange(EVENTS[2]), /Dec 1, 2026/);
});
