import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { FakeGraph } from '../support/fake-graph.mjs';
import { FIXTURES } from './global-setup.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, prefer',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
};

const SETTINGS = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  cardReaderUrl: 'https://reader.test/',
  workbook: '/InfoCapture/InfoCapture Leads.xlsx',
  event: 'Expo 2026',
  capturedBy: 'Travis',
};

const shot = (page, name) => page.screenshot({ path: join(FIXTURES, 'screens', `${name}.png`) });

// Wires a page to the fake Graph and a fake card reader, with a signed-in
// stand-in for MSAL.
async function setup(page, { settings = SETTINGS, signedIn = true, readerFields = {}, readerDelay = 300 } = {}) {
  const graph = new FakeGraph();
  const reader = { calls: [] };
  await page.addInitScript(({ settings, signedIn }) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('infocapture.settings', JSON.stringify(settings));
      localStorage.setItem('infocapture.installHintDismissed', 'true');
      sessionStorage.setItem('seeded', '1');
    }
    if (signedIn) {
      window.__INFOCAPTURE_TEST_AUTH__ = {
        account: { name: 'Travis Test', username: 'travis@contoso.example' },
        getToken: async (scopes) => `token-for-${scopes.join('+')}`,
      };
    }
  }, { settings, signedIn });

  await page.route('https://graph.microsoft.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const isJson = (req.headers()['content-type'] || '').includes('json');
    const body = isJson ? req.postData() : req.postDataBuffer();
    const res = await graph.handle(req.method(), req.url(), req.headers(), body ?? undefined);
    await route.fulfill({ status: res.status, headers: { ...res.headers, ...CORS }, body: res.body });
  });
  await page.route('https://reader.test/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = req.postDataJSON();
    reader.calls.push({ body, auth: req.headers().authorization });
    await new Promise((r) => setTimeout(r, readerDelay));
    const fields = typeof readerFields === 'function' ? readerFields(body) : readerFields;
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, fields }) });
  });
  return { graph, reader };
}

const syncPill = (page) => page.locator('.sync-pill');

test('scan a vCard badge, add notes and tags, and it lands in Excel', async ({ page }) => {
  const { graph } = await setup(page);
  await page.goto('./');
  await shot(page, '01-home-empty');
  await page.getByRole('button', { name: /Scan badge QR/ }).click();
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

  const [row] = graph.rowsAsObjects();
  expect(row['First Name']).toBe('Jordan');
  expect(row.Company).toBe('Northwind Traders');
  expect(row.Notes).toBe('Runs onboarding for 400 staff. Send pricing.');
  expect(row.Tags).toBe('Hot lead, Send info');
  expect(row.Event).toBe('Expo 2026');
  expect(row['Captured By']).toBe('Travis');
  expect(row.Source).toBe('qr');
  expect(row.Phone).toBe("'+1 312 555 0147");
  expect(row['QR Data']).toContain('BEGIN:VCARD');
  expect(graph.requests.every((r) => r.method !== 'GET' || !r.url.includes('/content'))).toBe(true);

  // Scanning the same badge again warns about the duplicate.
  await page.getByRole('button', { name: /Scan badge QR/ }).click();
  await expect(page.locator('#dup')).toContainText('Already captured Jordan Okafor', { timeout: 15000 });
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('.item')).toHaveCount(1);
});

test('a card photo is read by the card reader without losing typed notes', async ({ page }) => {
  const { graph, reader } = await setup(page, {
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
  expect(reader.calls[0].auth).toBe(`Bearer token-for-api://${SETTINGS.clientId}/access_as_user`);

  await page.getByRole('button', { name: /Save contact/ }).click();
  await expect(syncPill(page)).toContainText('Synced', { timeout: 10000 });
  const [row] = graph.rowsAsObjects();
  expect(row.Title).toBe('Chief People Officer');
  expect(row.Notes).toBe('Met at the keynote');
  expect(row['Card Photo']).toMatch(/^=HYPERLINK\("https:\/\/contoso\.sharepoint\.com\/InfoCapture\/Card%20Photos\//);
  const photo = [...graph.items.values()].find((i) => i.path.startsWith('InfoCapture/Card Photos/'));
  expect(photo.name).toMatch(/Priya Raman Contoso Health/);
  expect(photo.contentType).toBe('image/jpeg');
});

test('captures made offline sync when the phone reconnects, card read included', async ({ page, context }) => {
  const { graph, reader } = await setup(page, { readerFields: { firstName: 'Offline', lastName: 'Card', company: 'Later Inc' } });
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
  expect(graph.rowsAsObjects()).toHaveLength(0);

  await context.setOffline(false);
  await expect(syncPill(page)).toContainText('Synced', { timeout: 15000 });
  const rows = graph.rowsAsObjects();
  expect(rows.map((r) => r['First Name'])).toEqual(['Maya', 'Offline']);
  expect(rows[1].Company).toBe('Later Inc');
  expect(reader.calls).toHaveLength(1);
});

test('editing and deleting a synced contact updates the same Excel row', async ({ page }) => {
  const { graph } = await setup(page);
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
  await expect.poll(() => graph.rowsAsObjects().find((r) => r['First Name'] === 'Ann')?.Notes).toBe('Edited after the show');
  expect(graph.rowsAsObjects()).toHaveLength(2);

  await page.locator('.item', { hasText: 'Ann' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete contact' }).click();
  await expect(page.locator('.item')).toHaveCount(1);
  await expect.poll(() => graph.rowsAsObjects().map((r) => r['First Name'])).toEqual(['Bo']);
});

test('unrecognised QR text from a photo goes to the card reader', async ({ page }) => {
  const { graph, reader } = await setup(page, {
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
  expect(graph.rowsAsObjects()[0].Title).toBe('Operations Lead');
});

test('without Microsoft 365 set up, captures stay on the phone and export to CSV', async ({ page }) => {
  await setup(page, { settings: { event: 'Local only' }, signedIn: false });
  await page.goto('./');
  await expect(page.locator('#banners')).toContainText('Not connected to Microsoft 365');
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
  const data = Buffer.from(JSON.stringify({ v: 1, tenantId: SETTINGS.tenantId, clientId: SETTINGS.clientId, workbook: 'https://contoso.sharepoint.com/:x:/s/sales/EaBcD' })).toString('base64url');
  page.on('dialog', (d) => d.accept());
  await page.goto(`./#setup=${data}`);
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator('[name=tenantId]')).toHaveValue(SETTINGS.tenantId);
  await expect(page.locator('[name=workbook]')).toHaveValue('https://contoso.sharepoint.com/:x:/s/sales/EaBcD');
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
