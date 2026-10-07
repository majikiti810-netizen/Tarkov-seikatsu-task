/* Service Worker — daily-tasks-demo
 * Scope: directory of this file (./). Keep all assets relative.
 * Bump CACHE_VERSION on every release so clients drop stale caches.
 */
const CACHE_VERSION = 'v7-2026-10-07-chat-multi-daily';
const CACHE = 'daily-tasks-demo-' + CACHE_VERSION;

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './parser.js',
  './app.js',
  './data/adapter.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './se/check.mp3',
  './se/deliver.mp3',
  './se/complete.mp3',
  './se/start.mp3',
  './se/fail.mp3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isNavigate(req) {
  return req.mode === 'navigate' ||
    (req.method === 'GET' && req.headers.get('accept') && req.headers.get('accept').includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML: network-first, fallback to cache (offline)
  if (isNavigate(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match(req)))
    );
    return;
  }

  // Same-origin assets: cache-first, then network + update
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// Placeholder for future Web Push (Supabase/FCM/VAPID)
self.addEventListener('push', (event) => {
  let data = { title: 'デイリー任務', body: '通知' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (_) {
    try { data.body = event.data.text(); } catch (__) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'デイリー任務', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: data.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
