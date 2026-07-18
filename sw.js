// ─────────────────────────────────────────────────────────────
// Service worker — makes the app installable and lets the app shell
// (the HTML/CSS/JS itself) load even with no connection, so a worker on
// a job site with a bad signal can still open the app and use the
// offline clock-in queue.
//
// API calls (/api/*) are NEVER cached or intercepted here — they always
// go straight to the network. Handling a failed API call (queueing a
// clock-in/out for later) is the main app's job, not the service
// worker's — this file only makes sure the PAGE ITSELF is available
// offline.
// ─────────────────────────────────────────────────────────────
const CACHE_NAME = 'newidra-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't fail install over one missing asset
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return; // always network, never cached
  if (request.method !== 'GET') return;

  // Network-first: always try to get the freshest app shell when online,
  // fall back to whatever's cached (or the root page) when offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  );
});
