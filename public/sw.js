// Marginalia service worker: offline app shell + cached parser libraries.
// The app shell is served network-first with the cache only as an offline fallback. It used to be
// cache-first, which froze installed phones on whatever app.js they first downloaded: EPUB parser
// fixes never reached them until the cache version changed, and even then only after a reload.
const VERSION = 'marginalia-v4';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './pdf-extract.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
// Same-origin files that must revalidate on every load (navigation requests match by mode).
const NETWORK_FIRST_PATHS = new Set(['/', '/index.html', '/style.css', '/app.js', '/pdf-extract.js']);
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // Never cache dynamic backend summaries or TTS calls

  if (url.origin === self.location.origin) {
    const isNavigation = req.mode === 'navigate';
    if (isNavigation || NETWORK_FIRST_PATHS.has(url.pathname)) {
      const cacheKey = isNavigation ? './index.html' : req;
      e.respondWith(
        fetch(req)
          .then((r) => {
            const copy = r.clone();
            caches.open(VERSION).then((c) => c.put(cacheKey, copy));
            return r;
          })
          .catch(() => caches.match(cacheKey))
      );
      return;
    }
    // Icons and anything else same-origin are immutable enough to stay cache-first.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req)
          .then((r) => { 
            if (r.ok || r.type === 'opaque') c.put(req, r.clone()); 
            return r; 
          })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});