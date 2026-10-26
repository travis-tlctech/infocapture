// Offline support: the app shell is cached so InfoCapture opens with no
// signal. The deploy workflow stamps VERSION with the commit id, which makes
// phones pick up each new release.
const VERSION = '__BUILD__';
const CACHE = `infocapture-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'js/auth.js',
  'js/cardreader.js',
  'js/db.js',
  'js/exporters.js',
  'js/fields.js',
  'js/image.js',
  'js/parsers.js',
  'js/scanner.js',
  'js/settings.js',
  'js/store.js',
  'js/sync.js',
  'js/xlsx.js',
  'vendor/jsQR.min.js',
  'vendor/supabase.min.js',
  'icons/favicon-64.png',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'icons/tlc-trng-horizontal-navy.png',
  'icons/tlc-trng-horizontal-gray-white.png',
  'fonts/montserrat-latin.woff2',
  'fonts/montserrat-latin-ext.woff2',
  'fonts/open-sans-latin.woff2',
  'fonts/open-sans-latin-ext.woff2',
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
  // Only our own static files. Supabase and the card reader always go to the
  // network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // config.js: prefer the network so admins can change it without a release.
  if (url.pathname.endsWith('/config.js')) {
    event.respondWith(networkFirst(req));
    return;
  }
  // ignoreSearch: a link with a query string still opens the cached page.
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
