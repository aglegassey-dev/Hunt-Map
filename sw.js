// Freeport Hunt Map service worker: offline app shell + cache-first map tiles.
// Bump VERSION when shell files change so phones pick up the update.
const VERSION = 'v6';
const SHELL_CACHE = `hunt-shell-${VERSION}`;
const TILE_CACHE = 'hunt-tiles'; // must match TILE_CACHE in js/offline.js
const DATA_CACHE = 'hunt-data';
const SHELL = [
  './', './index.html', './app.css', './data.js', './manifest.webmanifest',
  './js/main.js', './js/layers.js', './js/geo.js', './js/db.js', './js/gpx.js', './js/offline.js', './js/weather.js',
  './js/sources.js', './js/terrain.js', './js/terrain-worker.js', './js/evt.js', './js/share.js',
  './vendor/lerc/LercDecode.es.js', './vendor/lerc/lerc-wasm.wasm', './vendor/qrcode/qrcode.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
];
const TILE_HOSTS = ['server.arcgisonline.com', 'basemap.nationalmap.gov', 'fwspublicservices.wim.usgs.gov'];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser/CDN HTTP cache so a new version never mixes in stale files
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hunt-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isTile = (u) => TILE_HOSTS.includes(u.hostname) || u.pathname.endsWith('/exportImage') || u.pathname.endsWith('/export');
const isLiveData = (u) => u.hostname === 'api.open-meteo.com' || (u.hostname === 'gis.maine.gov' && u.pathname.endsWith('/identify'));

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

// App files come from this version's cache (installed together, so they always match).
// Updates arrive as a new service worker version, which the page detects and reloads into.
async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const key = req.mode === 'navigate' ? './index.html' : req;
  const hit = await cache.match(key, { ignoreSearch: true });
  if (hit) return hit;
  try { return await fetch(req); } catch { return new Response('Offline', { status: 503 }); }
}
self.addEventListener('message', (e) => { if (e.data === 'version') e.source?.postMessage({ version: VERSION }); });

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin === self.location.origin && u.pathname.endsWith('/version.json')) return; // always straight to the network
  if (u.origin === self.location.origin) e.respondWith(shell(e.request));
  else if (isTile(u)) e.respondWith(cacheFirst(e.request, TILE_CACHE));
  else if (isLiveData(u)) e.respondWith(networkFirst(e.request, DATA_CACHE, 5000));
});
