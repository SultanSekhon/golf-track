const CACHE = 'golf-track-cache-v2';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './live-stats-app.js',
  './manifest.json',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        return caches.open(CACHE).then((cache) => {
          if (req.url.startsWith(self.location.origin)) cache.put(req, resp.clone());
          return resp;
        });
      }).catch(() => caches.match('./index.html'));
    })
  );
});
