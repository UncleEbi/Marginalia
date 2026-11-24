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
  './tts-worker.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
// Same-origin files that must revalidate on every load (navigation requests match by mode).
const NETWORK_FIRST_PATHS = new Set(['/', '/index.html', '/style.css', '/app.js', '/pdf-extract.js', '/tts-worker.js']);
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

// Share target handoff store in IndexedDB
function saveShareHandoff(data) {
  return new Promise((resolve) => {
    try {
      const openReq = indexedDB.open('MarginaliaShareHandoff', 1);
      openReq.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('handoff')) {
          db.createObjectStore('handoff');
        }
      };
      openReq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('handoff', 'readwrite');
        tx.objectStore('handoff').put(data, 'latest');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); resolve(false); };
      };
      openReq.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Intercept PWA Share Target POST
  if (req.method === 'POST' && (url.pathname === '/share-target' || url.pathname.endsWith('/share-target'))) {
    e.respondWith((async () => {
      try {
        const formData = await req.formData();
        const title = formData.get('title') || '';
        const text = formData.get('text') || '';
        const sharedUrl = formData.get('url') || '';
        const file = formData.get('document');

        let fileData = null;
        if (file && typeof file === 'object' && file.name) {
          const buffer = await file.arrayBuffer();
          fileData = {
            name: file.name,
            type: file.type || 'application/octet-stream',
            buffer
          };
        }

        const handoff = {
          title: typeof title === 'string' ? title : '',
          text: typeof text === 'string' ? text : '',
          url: typeof sharedUrl === 'string' ? sharedUrl : '',
          file: fileData,
          timestamp: Date.now()
        };

        await saveShareHandoff(handoff);
      } catch (err) {
        console.error('Share target handoff error:', err);
      }
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;
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