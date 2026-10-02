// Network first, falling back to the cache when offline. Keeps the game
// playable without a connection after the first visit.
const CACHE = 'enclosure-v1';
const CORE = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/engine.js', 'js/geometry.js', 'js/board.js', 'js/play.js', 'js/ai.js', 'js/ai-client.js',
  'js/worker.js', 'js/chart.js', 'js/sound.js', 'js/store.js', 'js/learn.js', 'js/lessons.js', 'js/diagrams.js',
  'js/demo.js', 'js/online.js', 'js/image.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
