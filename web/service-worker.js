/* Cache the versioned static shell only. API traffic is never cached or intercepted. */
const CACHE = 'colibri-shell-v2';
const SHELL = [
  './',
  './index.html',
  './app.js?v=2',
  './helpers.js?v=1',
  './styles.css?v=1',
  './manifest.webmanifest?v=1',
  './icons/icon.svg?v=1',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html', { ignoreSearch: true })));
    return;
  }
  if (!['script', 'style', 'image', 'font', 'manifest'].includes(request.destination)) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(request).then(response => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
