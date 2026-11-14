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
const CACHE_NAME = 'newidra-shell-v5';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-circle.png',
  '/icons/icon-512-circle.png',
  '/icons/badge-96.png',
  '/icons/logo-mark.png',
  '/logo-vertical.png',
  '/logo-horizontal.png',
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

// ── Push notifications ──────────────────────────────────────────
// The server (a cron-triggered check) sends a JSON payload like
// { title, body, url }. This just has to show it — no app logic lives
// here, so it works even if the app itself isn't open.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Newidra', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Newidra';

  // iOS/iPadOS Safari's web push never actually renders the `icon` image —
  // it only ever shows the installed app's own home-screen icon (which is
  // already correct, that's the small logo you see in the corner). But it
  // still reserves a big empty square in the notification layout for the
  // icon it's ignoring, so setting `icon` on iOS produced a blank white box
  // sitting next to the real logo — "two logos", one of them empty. Chrome/
  // Android, by contrast, genuinely uses `icon` to show a full-color
  // thumbnail, so it should stay set there. Detecting iOS here and leaving
  // `icon` out entirely (rather than pointing it at a real file) collapses
  // the notification back down to the one real logo on iPhones/iPads, while
  // Android keeps its full-color thumbnail exactly as before.
  const ua = (self.navigator && self.navigator.userAgent) || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (self.navigator && self.navigator.platform === 'MacIntel' && self.navigator.maxTouchPoints > 1);

  const options = {
    body: data.body || '',
    // Android's status bar / notification-shade icon (and the app-icon
    // badge dot) is NOT rendered as-is — Android masks it using only its
    // alpha channel and fills the visible shape solid white. icon-192.png
    // is fully opaque with no transparency, so that mask covered the whole
    // square, which is why it showed as a plain white block instead of the
    // logo. badge-96.png is a white silhouette of the same logo on a
    // transparent background, generated specifically for this purpose —
    // Android composites it correctly instead of flattening it to a block.
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
    // Re-alert (sound/vibrate) even if a notification with the same tag is
    // already showing, and keep the icon-bearing entry visible until the
    // user actively swipes it away or taps it — this is what keeps the
    // launcher icon's badge dot present until it's cleared from the shade.
    renotify: !!data.tag,
    requireInteraction: !!data.urgent,
  };
  // Urgent alerts vibrate harder and stay until the manager taps them.
  if (data.urgent) options.vibrate = [400, 150, 400, 150, 400];
  // Full-color logo — shown as the larger image inside the notification
  // body. Only set on platforms that actually render it (see note above).
  if (!isIOS) options.icon = '/icons/icon-192.png';

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // The app is already open. A real navigation would reload the page
          // and sign the person out (the session lives in memory), so the
          // open page is told which screen to show instead.
          const view = new URL(url, self.location.origin).searchParams.get('view');
          if (view) client.postMessage({ type: 'open-view', view });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Other sites (photo storage, CDNs) go straight to the network. Passing them
  // through here cached every signed photo link and turned failures into errors.
  if (url.origin !== self.location.origin) return;
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
