import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { FakeSupabase, TEST_URL, TEST_KEY } from '../support/fake-supabase.mjs';
import { unzip } from '../support/unzip.mjs';
import { FIXTURES } from './global-setup.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD',
  'access-control-expose-headers': 'content-range',
};
const cors = (req) => ({ ...CORS, 'access-control-allow-headers': req.headers()['access-control-request-headers'] || 'authorization, content-type' });

const SETTINGS = {
  supabaseUrl: TEST_URL,
  supabaseKey: TEST_KEY,
  cardReaderUrl: 'https://reader.test/',
  event: 'Expo 2026',
  capturedBy: 'Travis',
};
const EMAIL = 'travis@example.com';
const PASSWORD = 'correct horse';

const shot = (page, name) => page.screenshot({ path: join(FIXTURES, 'screens', `${name}.png`) });

// Wires a page to a fake Supabase and a fake card reader. signedIn seeds a
// session the way supabase-js stores one after a real sign-in.
async function setup(page, { settings = SETTINGS, signedIn = true, member = true, readerFields = {}, readerReply = null, readerDelay = 300 } = {}) {
  const fake = new FakeSupabase();
  const user = fake.addUser({ email: EMAIL, password: PASSWORD, member });
  const session = signedIn ? fake.createSession(user) : null;
  const reader = { calls: [] };
  const leaked = [];
  await page.addInitScript(({ settings, session }) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('infocapture.settings', JSON.stringify(settings));
      localStorage.setItem('infocapture.installHintDismissed', 'true');
      if (session) localStorage.setItem('infocapture.auth', JSON.stringify(session));
      sessionStorage.setItem('seeded', '1');
    }
  }, { settings, session });

  // The real config.js points at the live project; tests never touch it.
  await page.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: "export default { supabaseUrl: '', supabaseKey: '', cardReaderUrl: '' };" }));
  await page.route('https://*.supabase.co/**', (route) => {
    leaked.push(route.request().url());
    return route.abort();
  });
  await page.route(`${TEST_URL}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(req) });
    const res = fake.handle(req.method(), req.url(), req.headers(), req.postDataBuffer() ?? undefined);
    await route.fulfill({ status: res.status, headers: { ...res.headers, ...cors(req) }, body: res.body });
  });
  await page.route('https://reader.test/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(req) });
    const body = req.postDataJSON();
    reader.calls.push({ body, auth: req.headers().authorization });
    await new Promise((r) => setTimeout(r, readerDelay));
    let payload;
    if (readerReply) {
      payload = typeof readerReply === 'function' ? readerReply(body, reader.calls.length) : readerReply;
    } else {
      const fields = typeof readerFields === 'function' ? readerFields(body) : readerFields;
      payload = { ok: true, contacts: Object.keys(fields).length ? [{ fields, confidence: 0.95, unsure: [] }] : [], fields, unreadable: Object.keys(fields).length ? '' : 'nothing_found' };
    }
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  });
  return { fake, reader, session, user, leaked };
}

const syncPill = (page) => page.locator('.sync-pill');

test('scan a vCard badge, add notes and tags, and it lands in the team list', async ({ page }) => {
  const { fake, user, leaked } = await setup(page);
  await page.goto('./');
  await shot(page, '01-home-empty');
  await page.getByRole('button', { name: /Scan QR/ }).click();
  await expect(page.locator('#scan-video')).toBeVisible();

  await expect(page).toHaveURL(/#\/c\//, { timeout: 15000 });
  await expect(page.locator('[name=firstName]')).toHaveValue('Jordan');
  await expect(page.locator('[name=lastName]')).toHaveValue('Okafor');
  await expect(page.locator('[name=company]')).toHaveValue('Northwind Traders');
  await expect(page.locator('[name=title]')).toHaveValue('Director of Learning');
  await expect(page.locator('[name=email]')).toHaveValue('jordan.okafor@northwind.example');
  await expect(page.locator('[name=phone]')).toHaveValue('+1 312 555 0147');

  await page.locator('[name=notes]').fill('Runs onboarding for 400 staff. Send pricing.');
  await page.getByRole('button', { name: 'Hot lead' }).click();
  await page.getByRole('button', { name: 'Send info' }).click();
  await shot(page, '02-form-from-qr');
  await page.getByRole('button', { name: /Save contact/ }).click();

  await expect(page.locator('.item-name')).toHaveText('Jordan Okafor');
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  await shot(page, '03-home-synced');

  const [row] = fake.rows();
  expect(row.first_name).toBe('Jordan');
  expect(row.company).toBe('Northwind Traders');
  expect(row.notes).toBe('Runs onboarding for 400 staff. Send pricing.');
  expect(row.tags).toEqual(['Hot lead', 'Send info']);
  expect(row.event).toBe('Expo 2026');
  expect(row.captured_by).toBe('Travis');
  expect(row.source).toBe('qr');
  expect(row.phone).toBe('+1 312 555 0147');
  expect(row.qr_data).toContain('BEGIN:VCARD');
  expect(row.created_by).toBe(user.id);
  expect(fake.objects.size).toBe(0);
  expect(leaked).toEqual([]);

  // Scanning the same badge again warns about the duplicate.
  await page.getByRole('button', { name: /Scan QR/ }).click();
  await expect(page.locator('#dup')).toContainText('Already captured Jordan Okafor', { timeout: 15000 });
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('.item')).toHaveCount(1);
});

test('when the camera shows nothing until a tap (some iPhones), the scanner offers one', async ({ page }) => {
  await setup(page);
  // Refuse the first play() and show no picture until the person taps.
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    const width = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth');
    let refused = false;
    let tapped = false;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'scan-video') {
        if (!refused) {
          refused = true;
          return Promise.reject(new DOMException('Tap first', 'NotAllowedError'));
        }
        tapped = true;
      }
      return play.call(this);
    };
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      get() { return this.id === 'scan-video' && !tapped ? 0 : width.get.call(this); },
    });
  });
  await page.goto('./');
  await page.getByRole('button', { name: /Scan QR/ }).click();
  await page.getByRole('button', { name: 'Tap to start the camera' }).click();
  await expect(page).toHaveURL(/#\/c\//, { timeout: 15000 });
  await expect(page.locator('[name=firstName]')).toHaveValue('Jordan');
});

test('a card photo is read by the card reader without losing typed notes', async ({ page }) => {
  const { fake, reader, session } = await setup(page, {
    readerDelay: 1200,
    readerFields: { firstName: 'Priya', lastName: 'Raman', title: 'VP, People Operations', company: 'Contoso Health', email: 'priya.raman@contoso-health.example', phone: '+1 646 555 0188', phoneAlt: '+1 646 555 0100', website: '', linkedin: '', address: '', other: '' },
  });
  await page.goto('./');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Snap card/ }).click();
  await (await chooser).setFiles(join(FIXTURES, 'card.png'));

  await expect(page.locator('#parse-status')).toContainText('Reading card');
  await page.locator('[name=notes]').fill('Met at the keynote');
  await page.locator('[name=title]').fill('Chief People Officer'); // typed before the reader answers
  await expect(page.locator('#parse-status')).toContainText('Filled from the card', { timeout: 10000 });
  await expect(page.locator('[name=firstName]')).toHaveValue('Priya');
  await expect(page.locator('[name=title]')).toHaveValue('Chief People Officer');
  await expect(page.locator('details.more')).toHaveAttribute('open', '');
  await expect(page.locator('[name=phoneAlt]')).toHaveValue('+1 646 555 0100');
  await shot(page, '04-form-from-card');

  expect(reader.calls).toHaveLength(1);
  expect(reader.calls[0].body.action).toBe('card');
  expect(reader.calls[0].body.mediaType).toBe('image/jpeg');
  expect(reader.calls[0].body.image.length).toBeGreaterThan(5000);
  expect(reader.calls[0].auth).toBe(`Bearer ${session.access_token}`);

  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  const [row] = fake.rows();
  expect(row.title).toBe('Chief People Officer');
  expect(row.notes).toBe('Met at the keynote');
  expect(row.card_photo).toBe(`${row.id}.jpg`);
  const photo = fake.objects.get(row.card_photo);
  expect(photo.contentType).toBe('image/jpeg');
  expect(photo.size).toBeGreaterThan(5000);
});

test('a card with two people and unsure fields; an unreadable card stays calm', async ({ page }) => {
  const { fake } = await setup(page, {
    readerReply: (body, n) => n === 1
      ? {
        ok: true,
        unreadable: '',
        contacts: [
          { fields: { firstName: 'Priya', lastName: 'Raman', title: 'VP, People Operations', company: 'Contoso Health', email: 'priya.raman@contoso-health' }, confidence: 0.55, unsure: ['email'] },
          { fields: { firstName: 'Sam', lastName: 'Lee', title: 'Recruiter', company: 'Contoso Health', email: 'sam.lee@contoso-health.example' }, confidence: 0.9, unsure: [] },
        ],
      }
      : { ok: true, unreadable: 'declined', contacts: [], fields: {} },
  });
  await page.goto('./');
  let chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Snap card/ }).click();
  await (await chooser).setFiles(join(FIXTURES, 'card.png'));

  await expect(page.locator('[name=firstName]')).toHaveValue('Priya', { timeout: 10000 });
  await expect(page.locator('.field.unsure [name=email]')).toBeVisible();
  await expect(page.locator('.field.unsure .check-tag')).toHaveText('check');
  await expect(page.locator('#parse-status')).toContainText("wasn't sure");
  await expect(page.locator('#parse-status')).toContainText('This card also lists Sam Lee');
  await shot(page, '09-two-people-unsure');

  await page.locator('[name=email]').fill('priya.raman@contoso-health.example');
  await expect(page.locator('.field.unsure')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add as a contact' }).click();
  await expect(page.locator('[name=firstName]')).toHaveValue('Sam');
  await expect(page.locator('.card-photo img')).toBeVisible();
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  const rows = fake.rows();
  expect(rows.map((r) => r.first_name).sort()).toEqual(['Priya', 'Sam']);
  expect(rows.find((r) => r.first_name === 'Priya').email).toBe('priya.raman@contoso-health.example');
  expect(rows.every((r) => fake.objects.has(r.card_photo))).toBe(true);
  expect(fake.objects.size).toBe(2);

  chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Snap card/ }).click();
  await (await chooser).setFiles(join(FIXTURES, 'card.png'));
  await expect(page.locator('#parse-status')).toContainText("Couldn't read this card", { timeout: 10000 });
  await expect(page.locator('.reading.warn')).toHaveCount(0);
});

test('captures made offline sync when the phone reconnects, card read included', async ({ page, context }) => {
  const { fake, reader } = await setup(page, { readerFields: { firstName: 'Offline', lastName: 'Card', company: 'Later Inc' } });
  await page.goto('./');
  await context.setOffline(true);

  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.locator('[name=firstName]').fill('Maya');
  await page.locator('[name=lastName]').fill('Lopez');
  await page.locator('[name=email]').fill('maya@example.org');
  await page.getByRole('button', { name: /Save contact/ }).click();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Snap card/ }).click();
  await (await chooser).setFiles(join(FIXTURES, 'card.png'));
  await expect(page.locator('#parse-status')).toContainText('read when you are online');
  await page.getByRole('button', { name: /Save contact/ }).click();

  await expect(syncPill(page)).toContainText('2 offline');
  await shot(page, '05-home-offline');
  expect(fake.rows()).toHaveLength(0);

  await context.setOffline(false);
  await expect(syncPill(page)).toContainText('Synced', { timeout: 15000 });
  const rows = fake.rows();
  expect(rows.map((r) => r.first_name)).toEqual(['Maya', 'Offline']);
  expect(rows[1].company).toBe('Later Inc');
  expect(reader.calls).toHaveLength(1);
});

test('editing and deleting a synced contact updates the same row', async ({ page }) => {
  const { fake } = await setup(page);
  await page.goto('./');
  for (const name of ['Ann', 'Bo']) {
    await page.getByRole('button', { name: /Type it in/ }).click();
    await page.locator('[name=firstName]').fill(name);
    await page.getByRole('button', { name: /Save contact/ }).click();
    await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  }
  await page.locator('.item', { hasText: 'Ann' }).click();
  await page.locator('[name=notes]').fill('Edited after the show');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  await expect.poll(() => fake.rows().find((r) => r.first_name === 'Ann')?.notes).toBe('Edited after the show');
  expect(fake.rows()).toHaveLength(2);

  await page.locator('.item', { hasText: 'Ann' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete contact' }).click();
  await expect(page.locator('.item')).toHaveCount(1);
  await expect.poll(() => fake.rows().map((r) => r.first_name)).toEqual(['Bo']);
});

test('unrecognised QR text from a photo goes to the card reader', async ({ page }) => {
  const { fake, reader } = await setup(page, {
    readerFields: (body) => (body.action === 'text' ? { firstName: 'Wei', lastName: 'Chen', company: 'Fabrikam Inc', title: 'Operations Lead', email: 'wei.chen@fabrikam.example' } : {}),
  });
  await page.goto('./#/scan');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Scan from a photo/ }).click();
  await (await chooser).setFiles(join(FIXTURES, 'badge-delimited.png'));
  await expect(page.locator('[name=firstName]')).toHaveValue('Wei', { timeout: 10000 });
  await expect(page.locator('[name=company]')).toHaveValue('Fabrikam Inc');
  expect(reader.calls[0].body).toEqual({ action: 'text', text: 'Wei^Chen^Fabrikam Inc^Operations Lead^wei.chen@fabrikam.example' });
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  expect(fake.rows()[0].title).toBe('Operations Lead');
});

test('without a connection set up, captures stay on the phone and export to CSV', async ({ page }) => {
  await setup(page, { settings: { event: 'Local only' }, signedIn: false });
  await page.goto('./');
  await expect(page.locator('#banners')).toContainText('Not connected yet');
  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.locator('[name=firstName]').fill('Local');
  await page.locator('[name=company]').fill('Only Ltd');
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('1 on phone');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await shot(page, '06-settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export CSV/ }).click();
  const file = await download;
  const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(csv).toContain('Local,,Only Ltd');
  expect(csv).toContain('Local only');
});

test('setup links fill in the connection settings', async ({ page }) => {
  await setup(page, { settings: {}, signedIn: false });
  const data = Buffer.from(JSON.stringify({ v: 2, supabaseUrl: TEST_URL, supabaseKey: TEST_KEY, cardReaderUrl: 'https://reader.test/' })).toString('base64url');
  page.on('dialog', (d) => d.accept());
  await page.goto(`./#setup=${data}`);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator('[name=supabaseUrl]')).toHaveValue(TEST_URL);
  await expect(page.locator('[name=supabaseKey]')).toHaveValue(TEST_KEY);
  await expect(page.locator('[name=cardReaderUrl]')).toHaveValue('https://reader.test/');
  // Connected now, so the account card asks for a sign-in.
  await expect(page.locator('#sign-in-form [name=email]')).toBeVisible();
});

test('dark mode screenshots', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await setup(page);
  await page.goto('./');
  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.locator('[name=firstName]').fill('Dana');
  await page.locator('[name=lastName]').fill('Scully');
  await page.locator('[name=company]').fill('Hoover Group');
  await page.getByRole('button', { name: 'Follow up' }).click();
  await shot(page, '07-form-dark');
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  await shot(page, '08-home-dark');
});

test('sign in on the phone; a login that is not on the team is told so', async ({ page }) => {
  const { fake } = await setup(page, { signedIn: false });
  fake.addUser({ email: 'outsider@example.com', password: 'other pass', member: false });
  await page.goto('./');
  await expect(page.locator('#banners')).toContainText('Sign in so your contacts reach the team list');
  await page.locator('#banners').getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#sign-in-form [name=email]')).toBeFocused();

  await page.locator('[name=email]').fill(EMAIL);
  await page.locator('[name=password]').fill('wrong');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sign-in-result')).toContainText('That email and password did not match');
  await page.locator('[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#account')).toContainText(`Signed in as ${EMAIL}`);
  await expect(page.locator('#team-note')).toBeEmpty();
  await shot(page, '10-settings-signed-in');
  // The session supabase-js stored is picked up again after a reload.
  await page.reload();
  await expect(page.locator('#account')).toContainText(`Signed in as ${EMAIL}`);

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('#test-result')).toContainText('On the team. The team list has 0 contacts.');

  await page.goto('./#/');
  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.locator('[name=firstName]').fill('Signed');
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  expect(fake.rows().map((r) => r.first_name)).toEqual(['Signed']);

  // Signing out keeps captures; another login without team access is warned.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('[name=email]').fill('outsider@example.com');
  await page.locator('[name=password]').fill('other pass');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#team-note')).toContainText("isn't on the InfoCapture team yet");
  await page.goto('./#/');
  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.locator('[name=firstName]').fill('Blocked');
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(page.locator('#banners')).toContainText("isn't on the InfoCapture team yet", { timeout: 10000 });
  expect(fake.rows().map((r) => r.first_name)).toEqual(['Signed']);
});

test('a phone new to this login gets its contacts, event and name back', async ({ page }) => {
  // As on an iPhone where the app was added to the Home Screen after
  // capturing in Safari: the Home Screen app starts with nothing.
  const { fake, user } = await setup(page, { settings: { ...SETTINGS, event: '', capturedBy: '' } });
  const lead = (id, over) => ({
    id, captured_at: '2026-10-26T15:00:00.000Z', updated_at: '2026-10-26T15:00:00.000Z', synced_at: '2026-10-26T15:00:05.000Z',
    first_name: '', last_name: '', company: '', title: '', email: '', phone: '', tags: [], notes: '', event: 'Expo 2026', captured_by: 'Travis',
    source: 'card', other_phone: '', website: '', linkedin: '', address: '', other_info: '', card_photo: '', qr_data: '', ...over,
  });
  const MINE = '33333333-3333-4333-8333-333333333333';
  fake.leads.set(MINE, lead(MINE, { first_name: 'Dana', last_name: 'Reyes', company: 'Tailspin Toys', notes: 'Wants a demo', created_by: user.id, card_photo: `${MINE}.jpg` }));
  fake.objects.set(`${MINE}.jpg`, { contentType: 'image/jpeg', size: 9000 });
  const OLDER = '44444444-4444-4444-8444-444444444444';
  fake.leads.set(OLDER, lead(OLDER, { first_name: 'Lee', captured_at: '2026-10-25T15:00:00.000Z', event: 'Old Expo', source: 'qr', qr_data: 'https://example.com/badge/123', created_by: user.id }));
  fake.leads.set('55555555-5555-4555-8555-555555555555', lead('55555555-5555-4555-8555-555555555555', { first_name: 'Sam', captured_by: 'Colleague', created_by: '00000000-0000-4000-8000-999999999999' }));

  await page.goto('./');
  await expect(page.locator('#toast')).toContainText('Brought back 2 of your contacts from the team list', { timeout: 10000 });
  await expect(page.locator('.item-name')).toHaveText(['Dana Reyes', 'Lee']);
  await expect(page.locator('.event-chip')).toContainText('Expo 2026');
  await expect(syncPill(page)).toContainText('Synced');

  // The card photo comes from the team list; the QR link still works.
  await page.locator('.item', { hasText: 'Dana Reyes' }).click();
  await expect(page.locator('[name=notes]')).toHaveValue('Wants a demo');
  await expect(page.locator('#team-photo img')).toHaveAttribute('src', new RegExp(`/storage/v1/object/sign/card-photos/${MINE}\\.jpg\\?token=signed-3600`));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('.item', { hasText: 'Lee' }).click();
  await page.getByText('QR data').click();
  await expect(page.getByRole('link', { name: /Open link/ })).toHaveAttribute('href', 'https://example.com/badge/123');
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#settings-form [name=capturedBy]')).toHaveValue('Travis');
  await expect(page.locator('#settings-form [name=event]')).toHaveValue('Expo 2026');

  // Once per sign-in: removed contacts stay removed until the next one.
  const restores = () => fake.requests.filter((r) => r.search.includes('created_by=')).length;
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Remove synced contacts from this phone' }).click();
  await expect(page.locator('#toast')).toContainText('Removed 2 from this phone');
  await page.goto('./');
  await page.reload();
  await expect(page.locator('.empty')).toContainText('No contacts yet');
  expect(restores()).toBe(1);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('[name=email]').fill(EMAIL);
  await page.locator('[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Brought back 2 of your contacts', { timeout: 10000 });
  expect(restores()).toBe(2);
  await page.goto('./#/');
  await expect(page.locator('.item')).toHaveCount(2);
  expect(fake.rows()).toHaveLength(3);
});

test('the team spreadsheet has everyone\'s contacts with photo links', async ({ page }) => {
  const { fake } = await setup(page);
  // A colleague's contact, captured on another phone.
  fake.leads.set('22222222-2222-4222-8222-222222222222', {
    id: '22222222-2222-4222-8222-222222222222', captured_at: '2026-10-20T14:00:00.000Z', updated_at: '2026-10-20T14:00:00.000Z',
    first_name: 'Sam', last_name: 'Lee', company: 'Contoso Health', captured_by: 'Colleague', source: 'card', tags: ['Partner'],
    card_photo: '22222222-2222-4222-8222-222222222222.jpg', notes: '', email: '', title: '', phone: '', event: 'Expo 2026',
  });
  fake.objects.set('22222222-2222-4222-8222-222222222222.jpg', { contentType: 'image/jpeg', size: 9000 });
  await page.goto('./');
  await page.getByRole('button', { name: /Type it in/ }).click();
  await page.locator('[name=firstName]').fill('Mine');
  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download spreadsheet/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^InfoCapture leads \d{4}-\d{2}-\d{2}\.xlsx$/);
  const bytes = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c));
  const files = unzip(bytes);
  const sheet = files.get('xl/worksheets/sheet1.xml');
  expect(sheet).toContain('>Sam</t>');
  expect(sheet).toContain('>Colleague</t>');
  expect(sheet).toContain('>Mine</t>');
  expect(sheet).toContain('>View photo</t>');
  expect(files.get('xl/worksheets/_rels/sheet1.xml.rels')).toContain(`${TEST_URL}/storage/v1/object/sign/card-photos/22222222-2222-4222-8222-222222222222.jpg?token=signed-604800`);
  expect(files.get('xl/tables/table1.xml')).toContain('ref="A1:U3"');
  await expect(page.locator('#toast')).toContainText('Spreadsheet ready: 2 contacts');
});
