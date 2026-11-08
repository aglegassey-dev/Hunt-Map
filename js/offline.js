// Offline map downloads. Tiles go into the "hunt-tiles" Cache Storage bucket, which the
// service worker serves cache-first, so downloaded areas work with no signal.
import { tileUrlsFor } from './layers.js';
import { lonLatToTile, tileBoundsLonLat, bboxOf, contains, nearestEdge } from './geo.js';

export const TILE_CACHE = 'hunt-tiles';
const AREAS_KEY = 'huntmap.offlineAreas';

export const listAreas = () => { try { return JSON.parse(localStorage.getItem(AREAS_KEY)) || []; } catch { return []; } };
const saveAreas = (a) => { try { localStorage.setItem(AREAS_KEY, JSON.stringify(a)); } catch { /* storage unavailable */ } };

// ---------------------------------------------------------------- preserves pack
// Per-layer max zoom for the one-tap "all preserves" download. Each layer goes as deep as its source
// is actually sharp (LiDAR is 1 m, so z17/18 at 512 px already shows every bench and gully).
export const PACK_LEVELS = {
  high: { label: 'High detail (recommended)', caps: { hybrid: 18, leafoff: 18, terrain: 17, slope: 17, contours: 17, streams: 16, hardwood: 15, topo: 16, oak: 13 }, labels: 17 },
  max: { label: 'Maximum detail', caps: { hybrid: 19, leafoff: 18, terrain: 18, slope: 18, contours: 17, streams: 16, hardwood: 16, topo: 16, oak: 13 }, labels: 18 },
};
// rough average KB per tile, for the size estimate
const KB = { hybrid: 24, leafoff: 70, terrain: 45, slope: 22, contours: 10, streams: 4, hardwood: 3, topo: 22, oak: 2, labels: 4 };
export const PACK_ID = 'preserves-pack';
export const PACK_BUFFER_M = 275; // ~300 yd around each preserve

/** Tiles (z/x/y) at zoom z that come within bufferM of any feature. */
function tilesNear(feats, z, bufferM) {
  const out = new Set();
  for (const f of feats) {
    const b = f.bbox || (f.bbox = bboxOf(f.geometry));
    const padLon = bufferM / (111320 * Math.cos((b[1] * Math.PI) / 180)), padLat = bufferM / 110540;
    const a = lonLatToTile(b[0] - padLon, b[3] + padLat, z), c = lonLatToTile(b[2] + padLon, b[1] - padLat, z);
    for (let x = a.x; x <= c.x; x++) for (let y = a.y; y <= c.y; y++) {
      const k = `${x}/${y}`; if (out.has(k)) continue;
      const [w, s2, e, nn] = tileBoundsLonLat(z, x, y), cl = (w + e) / 2, ct = (s2 + nn) / 2;
      const half = Math.hypot((e - w) * 111320 * Math.cos((ct * Math.PI) / 180), (nn - s2) * 110540) / 2;
      if (contains(f, cl, ct) || nearestEdge(f, cl, ct).d <= bufferM + half) out.add(k);
    }
  }
  return [...out].map((k) => k.split('/').map(Number));
}

/** Plan the preserves pack → { urls, estMB, perLayer: {id: count} } */
export function planPreserves(defs, feats, level, bufferM = PACK_BUFFER_M) {
  const L = PACK_LEVELS[level], urls = new Set(), perLayer = {}, tileCache = {}, order = [];
  let kb = 0;
  const tilesAt = (z) => (tileCache[z] ||= tilesNear(feats, z, bufferM));
  for (const d of defs) {
    const cap = L.caps[d.id]; if (cap == null) continue;
    perLayer[d.id] = 0;
    for (const s of d.sources) {
      const isLabel = s.pane === 'labels';
      const top = Math.min(s.maxNative, isLabel ? L.labels : cap);
      for (let z = Math.max(10, d.minZoom || 0); z <= top; z++) {
        for (const [x, y] of tilesAt(z)) {
          const u = s.url(z, x, y);
          if (!urls.has(u)) { urls.add(u); order.push([z, u]); perLayer[d.id]++; kb += isLabel ? KB.labels : (KB[d.id] || 20); }
        }
      }
    }
  }
  // coarse zooms of every layer first, so a paused download is already useful everywhere
  order.sort((a, b) => a[0] - b[0]);
  return { urls: order.map((o) => o[1]), estMB: Math.round(kb / 1024), perLayer };
}

export function planDownload(defs, bounds, zMin, zMax) {
  const urls = new Set();
  defs.forEach((d) => tileUrlsFor(d, bounds, zMin, zMax, lonLatToTile).forEach((u) => urls.add(u)));
  return [...urls];
}

/** Download URLs into the tile cache. onProgress(done, total, failed). Returns {done, failed}. */
export async function download(urls, onProgress, signal) {
  if (!('caches' in window)) throw new Error('Offline storage is not supported in this browser');
  try { await navigator.storage?.persist?.(); } catch { /* storage unavailable */ }
  const cache = await caches.open(TILE_CACHE);
  let i = 0, done = 0, failed = 0, bytes = 0;
  const worker = async () => {
    while (i < urls.length && !signal?.aborted) {
      const url = urls[i++];
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok && !signal?.aborted; attempt++) {
        try {
          if (attempt) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1))); // 1.5s, 3s, 6s back-off
          if (await cache.match(url)) { ok = true; break; }
          const r = await fetch(url, { mode: 'cors', signal });
          if (r.ok) { bytes += +(r.headers.get('content-length') || 0); await cache.put(url, r); ok = true; }
          else if (r.status === 404) ok = true; // blank tile (e.g. no streams here)
        } catch { /* network/CORS hiccup or rate limit: retry */ }
      }
      if (signal?.aborted) break;
      if (!ok) failed++;
      done++;
      onProgress?.(done, urls.length, failed, bytes);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed, bytes };
}

export function recordArea(area) { const a = listAreas(); a.unshift(area); saveAreas(a); }
export function removeAreaRecord(id) { saveAreas(listAreas().filter((a) => a.id !== id)); }

export async function clearAll() {
  if ('caches' in window) await caches.delete(TILE_CACHE);
  saveAreas([]);
}

export async function storageText() {
  try {
    const e = await navigator.storage.estimate();
    return `${(e.usage / 1048576).toFixed(0)} MB used of ~${(e.quota / 1073741824).toFixed(1)} GB available`;
  } catch { return ''; }
}
