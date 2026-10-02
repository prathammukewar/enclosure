// Network first, falling back to the cache when offline. Keeps the game
// playable without a connection after the first visit. Requests revalidate
// with the server so a new version shows up on the next visit.
const CACHE = 'enclosure-v5';
const CORE = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/ai-client.js', 'js/ai.js', 'js/analysis.js', 'js/app.js', 'js/board.js', 'js/book.js',
  'js/bookdata.js', 'js/chart.js', 'js/colors.js', 'js/config.js', 'js/corr.js', 'js/demo.js',
  'js/diagrams.js', 'js/engine.js', 'js/errors.js', 'js/export.js', 'js/geometry.js', 'js/guide.js',
  'js/guidecontent.js', 'js/image.js', 'js/learn.js', 'js/lessons.js', 'js/online.js', 'js/play.js',
  'js/profile.js', 'js/puzzledata.js', 'js/puzzles.js', 'js/report.js', 'js/solver-client.js',
  'js/solver-worker.js', 'js/solver.js', 'js/sound.js', 'js/store.js', 'js/tournament.js', 'js/worker.js',
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
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
