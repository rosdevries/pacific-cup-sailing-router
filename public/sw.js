// Service worker — offline-first PWA for Pacific Passage
// Bump SHELL_V on each deploy that changes the app shell.
const SHELL_V = '1';
const SHELL   = `shell-${SHELL_V}`;
const FC_C    = 'forecast-v1';

const SHELL_ASSETS = [
  '/',
  '/app.js',
  '/worker.js',
  '/islands.json',
  '/data/boats.json',
  '/data/corridor-landmask.png',
  '/src/geo.js',
  '/src/forecast.js',
  '/src/landmask.js',
  '/src/orrParse.js',
  '/src/routing.js',
  '/src/polar.js',
  '/src/waves.js',
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-16.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== FC_C).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;  // fonts, CDN libs — browser default

  if (url.pathname === '/api/forecast') {
    e.respondWith(networkFirst(e.request));
    return;
  }
  e.respondWith(cacheFirst(e.request));
});

// Forecast: try network, serve cache on failure (offline).
async function networkFirst(req) {
  const cache = await caches.open(FC_C);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503, headers: { 'content-type': 'application/json' }
    });
  }
}

// App shell: serve from cache immediately, fall through to network on miss.
async function cacheFirst(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    if (req.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw new Error(`offline: ${req.url}`);
  }
}
