// The team list store against FakeSupabase, through the real supabase-js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { SupabaseStore, toRow, fromRow, NOT_ON_TEAM, StoreError } from '../../app/js/store.js';
import { AuthRequiredError, NetworkError } from '../../app/js/auth.js';
import { FakeSupabase, TEST_URL, TEST_KEY } from '../support/fake-supabase.mjs';

async function signedIn({ member = true } = {}) {
  const fake = new FakeSupabase();
  fake.addUser({ email: 'travis@example.com', member });
  const client = createClient(TEST_URL, TEST_KEY, { global: { fetch: fake.fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: 'travis@example.com', password: 'correct horse' });
  assert.equal(error, null);
  return { fake, client, store: new SupabaseStore(client) };
}

const rec = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-10-20T15:04:00.000Z',
  updatedAt: '2026-10-20T15:04:00.000Z',
  firstName: 'Jordan', lastName: 'Okafor', company: 'Northwind', title: '', email: 'j@northwind.example', phone: '+1 312 555 0147',
  tags: ['Hot lead'], notes: 'Send pricing', event: 'Expo', capturedBy: 'Travis', source: 'qr', phoneAlt: '', website: '', linkedin: '',
  address: '', other: '', cardPhotoPath: '', qrRaw: 'BEGIN:VCARD', hasImage: false, parseStatus: 'none', syncStatus: 'pending',
  ...over,
});

test('rows map to database columns and back, with nothing extra', () => {
  const row = toRow(rec({ phoneAlt: undefined, other: null }));
  assert.equal(row.first_name, 'Jordan');
  assert.equal(row.other_phone, '');
  assert.equal(row.other_info, '');
  assert.deepEqual(row.tags, ['Hot lead']);
  assert.equal(row.captured_at, '2026-10-20T15:04:00.000Z');
  assert.ok(!('hasImage' in row) && !('syncStatus' in row) && !('parseStatus' in row), 'device-only fields stay on the device');
  const back = fromRow(row);
  assert.equal(back.firstName, 'Jordan');
  assert.equal(back.qrRaw, 'BEGIN:VCARD');
});

test('upsert inserts, then updates the same row; photos overwrite one file', async () => {
  const { fake, store } = await signedIn();
  await store.upsert(rec());
  await store.upsert(rec({ notes: 'Edited' }));
  assert.equal(fake.leads.size, 1);
  assert.equal(fake.rows()[0].notes, 'Edited');
  assert.equal(fake.rows()[0].created_by, fake.users.get('travis@example.com').id);

  const photo = new Blob([new Uint8Array(6000)], { type: 'image/jpeg' });
  const path = await store.uploadPhoto(rec(), photo);
  assert.equal(path, '11111111-1111-4111-8111-111111111111.jpg');
  await store.uploadPhoto(rec(), photo); // a retry replaces it
  assert.deepEqual(fake.objects.get(path), { contentType: 'image/jpeg', size: 6000, upsert: 'true' });
  const links = await store.signedUrls([path], 7 * 86400);
  assert.equal(links.get(path), `${TEST_URL}/storage/v1/object/sign/card-photos/${path}?token=signed-604800`);

  await store.remove(rec({ cardPhotoPath: path }));
  assert.equal(fake.leads.size, 0);
  assert.equal(fake.objects.size, 0);
});

test('listAll pages through everyone\'s contacts, oldest first', async () => {
  const { fake, store } = await signedIn();
  for (let i = 0; i < 2345; i++) {
    const id = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
    fake.leads.set(id, toRow(rec({ id, createdAt: new Date(Date.UTC(2026, 9, 20, 9, 0, i)).toISOString(), firstName: `P${i}` })));
  }
  const rows = await store.listAll();
  assert.equal(rows.length, 2345);
  assert.equal(rows[0].first_name, 'P0');
  assert.equal(rows.at(-1).first_name, 'P2344');
  assert.equal(fake.requests.filter((r) => r.path === '/rest/v1/leads').length, 3);
  assert.deepEqual(await store.check(), { member: true, rows: 2345 });
});

test('listAll with createdBy returns only the contacts that login captured', async () => {
  const { fake, client, store } = await signedIn();
  const { data } = await client.auth.getUser();
  fake.leads.set('a', { ...toRow(rec({ id: 'a', firstName: 'Mine' })), created_by: data.user.id });
  fake.leads.set('b', { ...toRow(rec({ id: 'b', firstName: 'Theirs' })), created_by: '00000000-0000-4000-8000-999999999999' });
  assert.deepEqual((await store.listAll({ createdBy: data.user.id })).map((r) => r.first_name), ['Mine']);
  assert.equal((await store.listAll()).length, 2);
  assert.equal(fake.requests.filter((r) => r.search.includes(`created_by=eq.${data.user.id}`)).length, 1);
});

test('a login that is not on the team gets a clear message, and sees nothing', async () => {
  const { fake, store } = await signedIn({ member: false });
  await assert.rejects(store.upsert(rec()), (err) => err instanceof StoreError && err.message === NOT_ON_TEAM);
  await assert.rejects(store.uploadPhoto(rec(), new Blob([new Uint8Array(10)])), (err) => err.message === NOT_ON_TEAM);
  assert.deepEqual(await store.check(), { member: false, rows: 0 });
  assert.equal(fake.leads.size, 0);
});

test('no connection and expired sign-ins map to the app\'s error types', async () => {
  const offline = createClient(TEST_URL, TEST_KEY, {
    global: { fetch: async () => { throw new TypeError('fetch failed'); } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await assert.rejects(new SupabaseStore(offline).upsert(rec()), NetworkError);
  await assert.rejects(new SupabaseStore(offline).uploadPhoto(rec(), new Blob([new Uint8Array(10)])), NetworkError);

  const fake = new FakeSupabase();
  const anon = createClient(TEST_URL, TEST_KEY, { global: { fetch: fake.fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  await assert.rejects(new SupabaseStore(anon).upsert(rec()), AuthRequiredError);
});
