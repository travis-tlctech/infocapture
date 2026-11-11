// Follow-up fields, the board's filters and metrics, and the store's
// follow-up calls against FakeSupabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { followUpFromRow, followUpToRow, withInitialContact, filterLeads, metrics, STATUSES } from '../../app/js/followup.js';
import { SupabaseStore, toRow, NEEDS_DB_UPDATE } from '../../app/js/store.js';
import { editableSnapshot, mergeTeamEdits } from '../../app/js/fields.js';
import { FakeSupabase, TEST_URL, TEST_KEY } from '../support/fake-supabase.mjs';

const lead = (over) => ({ firstName: '', lastName: '', company: '', title: '', email: '', notes: '', event: 'NPPERS 2026', tags: [], potential: '', followUpStatus: [], followUpBy: '', ...over });

test('rows map to follow-up fields and back; only the fields given are sent', () => {
  assert.deepEqual(followUpFromRow({}), { potential: '', followUpStatus: [], followUpBy: '' });
  assert.deepEqual(followUpFromRow({ potential: 'High', follow_up_status: ['Call Booked'], follow_up_by: 'u1' }),
    { potential: 'High', followUpStatus: ['Call Booked'], followUpBy: 'u1' });
  assert.deepEqual(followUpToRow({ potential: 'High' }), { potential: 'High' });
  assert.deepEqual(followUpToRow({ potential: 'Huge', followUpStatus: ['Call Booked', 'Made up'], followUpBy: '' }),
    { potential: '', follow_up_status: ['Call Booked'], follow_up_by: null });
});

test('Initial Contact is the team member who captured the person first', () => {
  const people = new Map([['u-t', 'Travis Cryan'], ['u-r', 'Rick Christ']]);
  const out = withInitialContact([
    lead({ id: 'b', email: 'Ana@Contoso.example', createdBy: 'u-t', capturedBy: 'Travis', createdAt: '2026-11-04T10:00:00Z' }),
    lead({ id: 'a', email: 'ana@contoso.example ', createdBy: 'u-r', capturedBy: 'Rick', createdAt: '2026-11-03T10:00:00Z' }),
    lead({ id: 'c', qrRaw: 'BADGE-7', createdBy: 'gone', capturedBy: 'Sam', createdAt: '2026-11-05T09:00:00Z' }),
    lead({ id: 'd', qrRaw: 'BADGE-7', createdBy: 'u-t', createdAt: '2026-11-05T11:00:00Z' }),
    lead({ id: 'e', firstName: 'No email', createdBy: 'u-t', createdAt: '2026-11-05T12:00:00Z' }),
  ], people);
  const by = Object.fromEntries(out.map((l) => [l.id, l]));
  assert.equal(by.b.initialContact, 'Rick Christ'); // Rick met Ana a day earlier
  assert.equal(by.b.capturedByName, 'Travis Cryan');
  assert.deepEqual(by.b.otherCaptures.map((c) => [c.id, c.who]), [['a', 'Rick Christ']]);
  assert.equal(by.a.initialContact, 'Rick Christ');
  assert.equal(by.d.initialContact, 'Sam'); // a login no longer on the team: the name typed on that phone
  assert.equal(by.e.initialContact, 'Travis Cryan');
  assert.deepEqual(by.e.otherCaptures, []);
});

test('the board filters by event, person, potential, status and text; "-" means not set', () => {
  const leads = [
    lead({ firstName: 'Ana', potential: 'High', followUpBy: 'u1', followUpStatus: ['Call Booked'] }),
    lead({ firstName: 'Bo', event: 'IAEM 2026', tags: ['Partner'] }),
    lead({ firstName: 'Cy', company: 'Contoso', followUpStatus: ['Not Interested/No Response'] }),
  ];
  const names = (f) => filterLeads(leads, f).map((l) => l.firstName);
  assert.deepEqual(names({}), ['Ana', 'Bo', 'Cy']);
  assert.deepEqual(names({ event: 'IAEM 2026' }), ['Bo']);
  assert.deepEqual(filterLeads(leads.map((l, i) => ({ ...l, initialContact: i ? 'Rick Christ' : 'Travis Cryan' })), { initial: 'Rick Christ' }).map((l) => l.firstName), ['Bo', 'Cy']);
  assert.deepEqual(names({ person: 'u1' }), ['Ana']);
  assert.deepEqual(names({ person: '-' }), ['Bo', 'Cy']);
  assert.deepEqual(names({ potential: 'High' }), ['Ana']);
  assert.deepEqual(names({ potential: '-' }), ['Bo', 'Cy']);
  assert.deepEqual(names({ status: 'Call Booked' }), ['Ana']);
  assert.deepEqual(names({ status: '-' }), ['Bo']);
  assert.deepEqual(names({ q: 'contoso' }), ['Cy']);
  assert.deepEqual(names({ q: 'partner' }), ['Bo']);
});

test('metrics count each status on its own, as a share of the leads shown', () => {
  const m = metrics([
    lead({ followUpStatus: ['Email Conversation Started', 'Call Booked'] }),
    lead({ followUpStatus: ['Call Booked'] }), // booked straight from the resources: no conversation counted
    lead({ followUpStatus: ['Not Interested/No Response'] }),
    lead({ event: 'IAEM 2026' }),
    lead({ event: '' }),
  ]);
  assert.equal(m.total, 5);
  assert.deepEqual(m.perEvent, [['NPPERS 2026', 3], ['IAEM 2026', 1], ['No event', 1]]);
  assert.deepEqual(m.tiles.map((t) => [t.key, t.count, t.pct]), [['conversation', 1, 20], ['call', 2, 40], ['pipeline', 0, 0], ['dead', 1, 20]]);
  assert.deepEqual(metrics([]).tiles.map((t) => t.pct), [0, 0, 0, 0]);
  assert.equal(STATUSES.length, 7);
});

async function signedIn() {
  const fake = new FakeSupabase();
  fake.addUser({ email: 'travis@example.com', teamName: 'Travis Cryan' });
  fake.addUser({ email: 'rick@example.com' });
  fake.addUser({ email: 'outsider@example.com', member: false });
  const client = createClient(TEST_URL, TEST_KEY, { global: { fetch: fake.fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  await client.auth.signInWithPassword({ email: 'travis@example.com', password: 'correct horse' });
  return { fake, store: new SupabaseStore(client) };
}

test('the store saves follow-up fields only, lists the team, and says when the database needs updating', async () => {
  const { fake, store } = await signedIn();
  const id = '11111111-1111-4111-8111-111111111111';
  fake.leads.set(id, { ...toRow({ id, createdAt: '2026-11-03T15:00:00.000Z', firstName: 'Ana', notes: 'met at booth' }), created_by: 'x' });
  await store.updateFollowUp(id, { potential: 'High', followUpStatus: ['Initial Email Sent'] });
  assert.equal(fake.leads.get(id).potential, 'High');
  assert.deepEqual(fake.leads.get(id).follow_up_status, ['Initial Email Sent']);
  assert.equal(fake.leads.get(id).notes, 'met at booth');
  await assert.rejects(store.updateFollowUp('22222222-2222-4222-8222-222222222222', { potential: 'Low' }), /no longer in the team list/);

  const team = await store.teamList();
  assert.deepEqual([...team.values()], ['rick@example.com', 'Travis Cryan']);

  fake.followUpColumns = false;
  await assert.rejects(store.updateFollowUp(id, { potential: 'Low' }), (err) => err.message === NEEDS_DB_UPDATE);
  await assert.rejects(store.teamList(), (err) => err.message === NEEDS_DB_UPDATE);
});

test('a phone keeps lead board edits and its own changes since it last synced', () => {
  const sent = { firstName: 'Ana', lastName: 'Diaz', company: 'Contoso', email: 'ana@contso.example', notes: 'Met at booth', tags: ['Hot lead'], event: 'NPPERS 2026' };
  const snapshot = editableSnapshot(sent);
  assert.deepEqual(snapshot.tags, ['Hot lead']);
  assert.equal(snapshot.phone, '');
  // The board fixed the email and added a tag; the phone then added to the notes.
  const team = { ...sent, email: 'ana@contoso.example', tags: ['Hot lead', 'Partner'], notes: 'Met at booth' };
  const local = { ...sent, notes: 'Met at booth. Call Tuesday.' };
  const taken = mergeTeamEdits(local, team, snapshot);
  assert.deepEqual(taken, ['email', 'tags']);
  assert.equal(local.email, 'ana@contoso.example');
  assert.deepEqual(local.tags, ['Hot lead', 'Partner']);
  assert.equal(local.notes, 'Met at booth. Call Tuesday.'); // both changed notes: the phone's latest wins
  assert.deepEqual(mergeTeamEdits({ ...sent }, { ...sent }, snapshot), []);
});

test('the store reads one contact and saves only the details changed, moving updated_at on', async () => {
  const { fake, store } = await signedIn();
  const id = '33333333-3333-4333-8333-333333333333';
  fake.leads.set(id, { ...toRow({ id, createdAt: '2026-11-03T15:00:00.000Z', updatedAt: '2026-11-03T15:00:00.000Z', firstName: 'Ana', email: 'ana@contso.example', notes: 'booth' }), potential: 'High' });
  fake.leads.set('other', toRow({ id: 'other', firstName: 'Bo' }));
  assert.equal((await store.get(id)).first_name, 'Ana');
  assert.equal(await store.get('44444444-4444-4444-8444-444444444444'), null);
  const at = await store.updateContact(id, { email: 'ana@contoso.example', tags: ['Partner'] });
  const row = fake.leads.get(id);
  assert.equal(row.email, 'ana@contoso.example');
  assert.deepEqual(row.tags, ['Partner']);
  assert.equal(row.notes, 'booth');
  assert.equal(row.potential, 'High');
  assert.equal(row.updated_at, at);
  assert.ok(Date.parse(at) > Date.parse('2026-11-03T15:00:00.000Z'));
  await assert.rejects(store.updateContact('44444444-4444-4444-8444-444444444444', { email: 'x' }), /no longer in the team list/);
});
