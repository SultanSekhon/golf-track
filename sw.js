self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('fetch', () => {}); // keeps it simple for caching later
