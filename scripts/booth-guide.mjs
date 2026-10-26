// Builds docs/booth-guide/InfoCapture-booth-guide.pdf (and a PNG preview)
// from docs/booth-guide/booth-guide.html with Playwright's Chromium, adding
// the QR code that opens the app.
//   npm run guide

import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const APP_URL = 'https://travis-tlctech.github.io/infocapture/';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'booth-guide');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(join(dir, 'booth-guide.html')).href);
  const qr = await QRCode.toString(APP_URL, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0F2557', light: '#FFFFFF' } });
  await page.evaluate((svg) => { document.getElementById('app-qr').innerHTML = svg; }, qr);
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect();
    const footer = document.querySelector('footer').getBoundingClientRect();
    return Math.ceil(main.bottom - footer.top);
  });
  if (overflow > -4) throw new Error(`The guide runs ${overflow + 4}px into the footer; shorten it to keep it on one page.`);
  await page.pdf({ path: join(dir, 'InfoCapture-booth-guide.pdf'), format: 'Letter', printBackground: true, preferCSSPageSize: true });
  await page.screenshot({ path: join(dir, 'preview.png') });
  console.log('Wrote InfoCapture-booth-guide.pdf and preview.png in docs/booth-guide');
} finally {
  await browser.close();
}
