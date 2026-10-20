// Offline support: the app shell is cached so InfoCapture opens with no
// signal. The deploy workflow replaces __BUILD__ with the commit id, which
// makes phones pick up each new release.
const VERSION = '__BUILD__';
const CACHE = `infocapture-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'redirect.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'js/auth.js',
  'js/cardreader.js',
  'js/db.js',
  'js/excel.js',
  'js/exporters.js',
  'js/fields.js',
  'js/image.js',
  'js/parsers.js',
  'js/scanner.js',
  'js/settings.js',
  'js/sync.js',
  'vendor/jsQR.min.js',
  'vendor/msal-browser.min.js',
  'vendor/msal-redirect-bridge.min.js',
  'template/InfoCapture-Leads.xlsx',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('infocapture-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only our own static files. Microsoft sign-in, Graph and the card reader
  // always go to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // config.js: prefer the network so admins can change it without a release.
  if (url.pathname.endsWith('/config.js')) {
    event.respondWith(networkFirst(req));
    return;
  }
  // ignoreSearch: the sign-in redirect carries a one-time code in the URL;
  // it must never be written to the cache, only matched to the static page.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)).catch(() => caches.match('index.html')),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000))]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
  }
}
