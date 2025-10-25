const CACHE = 'golf-track-cache';
const ASSETS = [
  './',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // network-first for API? but app shell cache-first
  if(req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then(cached => {
      if(cached) return cached;
      return fetch(req).then(resp => {
        return caches.open(CACHE).then(cache => {
          // cache new GET responses (options: limit size)
          if(req.url.startsWith(self.location.origin)) cache.put(req, resp.clone());
          return resp;
        });
      }).catch(()=> caches.match('/index.html'));
    })
  );
});
