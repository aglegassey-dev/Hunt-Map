// Terrain + forest worker: decodes raw 1 m LiDAR elevation (LERC) and LANDFIRE vegetation codes,
// then renders shaded relief, slope, contours, terrain features (benches / ridges / draws) and
// forest types on the phone. Also answers point queries (elevation, slope, aspect, forest type).
import { load, decode } from '../vendor/lerc/LercDecode.es.js';
import { demUrl, evtUrl, DEM_BUF, DEM_TILE, DEM_MAX_Z, EVT_MAX_Z, lonLatToTileF } from './sources.js';
import { EVT } from './evt.js';

const ready = load({ locateFile: (f) => new URL(`../vendor/lerc/${f}`, import.meta.url).href });
const W = DEM_TILE + 2 * DEM_BUF;
const M_TO_FT = 3.28084;
const MAX_FALLBACK = 5;

// ------------------------------------------------------------------ caches (LRU)
class LRU {
  constructor(n) { this.n = n; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { this.m.set(k, v); if (this.m.size > this.n) this.m.delete(this.m.keys().next().value); }
  delete(k) { this.m.delete(k); }
}
const demCache = new LRU(48), evtCache = new LRU(48);

class NetErr extends Error {}
async function fetchLerc(url) {
  let r;
  try { r = await fetch(url, { mode: 'cors' }); } catch { throw new NetErr('offline'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await ready;
  return decode(await r.arrayBuffer());
}

// ------------------------------------------------------------------ elevation grids
function blur3(src, valid) {
  // separable 1-2-1 binomial blur, run twice ≈ gaussian σ≈1 px (removes LiDAR micro-noise)
  let a = src, tmp = new Float32Array(W * W);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, l = x ? i - 1 : i, r = x < W - 1 ? i + 1 : i;
      tmp[i] = (a[l] + 2 * a[i] + a[r]) * 0.25;
    }
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, u = y ? i - W : i, d = y < W - 1 ? i + W : i;
      out[i] = valid[i] ? (tmp[u] + 2 * tmp[i] + tmp[d]) * 0.25 : src[i];
    }
    a = out;
  }
  return a;
}

function buildGrid(z, x, y, dec) {
  const raw = dec.pixels[0], mask = dec.mask;
  const valid = new Uint8Array(W * W);
  let sum = 0, cnt = 0;
  for (let i = 0; i < W * W; i++) {
    const ok = (!mask || mask[i]) && raw[i] > -100 && raw[i] < 3000;
    valid[i] = ok ? 1 : 0; if (ok) { sum += raw[i]; cnt++; }
  }
  if (!cnt) return { z, x, y, empty: true };
  const fill = sum / cnt, e0 = new Float32Array(W * W);
  for (let i = 0; i < W * W; i++) e0[i] = valid[i] ? raw[i] : fill;
  const n = 2 ** z, latC = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  const cell = ((2 * Math.PI * 6378137) / n / DEM_TILE) * Math.cos((latC * Math.PI) / 180); // ground metres per pixel
  return { z, x, y, e: blur3(e0, valid), valid, cell, d: {} };
}

async function getGrid(z, x, y) {
  const k = `${z}/${x}/${y}`;
  let p = demCache.get(k);
  if (!p) {
    p = fetchLerc(demUrl(z, x, y)).then((dec) => buildGrid(z, x, y, dec));
    p.catch(() => demCache.delete(k));
    demCache.set(k, p);
  }
  return p;
}

/** Best available grid for a display tile: z capped at DEM_MAX_Z, falling back to parents when offline. */
async function gridFor(z, x, y) {
  let d = Math.max(0, z - DEM_MAX_Z);
  for (let tries = 0; tries <= MAX_FALLBACK; tries++, d++) {
    const gz = z - d; if (gz < 0) break;
    try { const g = await getGrid(gz, x >> d, y >> d); return { g, d }; } catch (e) { if (!(e instanceof NetErr)) throw e; }
  }
  throw new NetErr('no terrain data offline');
}

// ---- derived rasters (computed once per grid, lazily)
function derive(g, key) {
  if (g.d[key]) return g.d[key];
  const { e, cell } = g;
  if (key === 'grad') {
    const sl = new Float32Array(W * W), dx = new Float32Array(W * W), dy = new Float32Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const xm = x ? x - 1 : x, xp = x < W - 1 ? x + 1 : x, ym = y ? y - 1 : y, yp = y < W - 1 ? y + 1 : y;
      const a = e[ym * W + xm], b = e[ym * W + x], c = e[ym * W + xp], dd = e[y * W + xm], f = e[y * W + xp], gg = e[yp * W + xm], h = e[yp * W + x], ii = e[yp * W + xp];
      const gx = ((c + 2 * f + ii) - (a + 2 * dd + gg)) / (8 * cell); // east-positive
      const gy = ((gg + 2 * h + ii) - (a + 2 * b + c)) / (8 * cell); // south-positive
      const i = y * W + x; dx[i] = gx; dy[i] = gy;
      sl[i] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }
    return (g.d.grad = { sl, dx, dy });
  }
  if (key === 'shade') {
    const { dx, dy } = derive(g, 'grad'), out = new Uint8ClampedArray(W * W);
    const ex = g.z >= 15 ? 2.2 : 3; // vertical exaggeration: coastal Maine relief is subtle
    const lights = [[315, 0.45], [270, 0.2], [0, 0.2], [225, 0.15]].map(([az, w]) => {
      const a = (az * Math.PI) / 180, alt = (40 * Math.PI) / 180;
      return [Math.sin(a) * Math.cos(alt), Math.cos(a) * Math.cos(alt), Math.sin(alt), w];
    });
    for (let i = 0; i < W * W; i++) {
      const nx = -dx[i] * ex, ny = dy[i] * ex, len = Math.hypot(nx, ny, 1);
      let s = 0;
      for (const [lx, ly, lz, w] of lights) s += w * Math.max(0, (nx * lx + ny * ly + lz) / len);
      out[i] = Math.round(255 * Math.min(1, s / 0.766)); // normalise so flat ground ≈ 255·sin(40°)/0.766
    }
    return (g.d.shade = out);
  }
  if (key === 'feat') {
    // Thresholds tuned on Freeport LiDAR: ridges/draws ≈ top/bottom 6–10 % of local relief (TPI at ~35 m),
    // benches = gentle ground (<10°) inside steep surroundings (mean >12° within ~40 m), de-speckled.
    const { sl } = derive(g, 'grad');
    const rT = Math.max(3, Math.min(DEM_BUF, Math.round(35 / cell))), rS = Math.max(2, Math.min(DEM_BUF, Math.round(40 / cell)));
    const meanE = boxMean(e, rT), meanS = boxMean(sl, rS);
    const T = (0.7 + 0.012 * rT * cell) * 2.2; // ≈2.4 m at 35 m radius
    const bench = new Float32Array(W * W);
    for (let i = 0; i < W * W; i++) { const tpi = e[i] - meanE[i]; if (sl[i] < 10 && meanS[i] > 12 && Math.abs(tpi) < T) bench[i] = 1; }
    const benchC = boxMean(bench, 2);
    const out = new Uint8Array(W * W); // 0 none, 1 bench, 2 ridge/spur, 3 draw
    for (let i = 0; i < W * W; i++) {
      const tpi = e[i] - meanE[i];
      if (benchC[i] > 0.5) out[i] = 1;
      else if (tpi > T) out[i] = 2;
      else if (tpi < -T) out[i] = 3;
    }
    return (g.d.feat = out);
  }
  throw new Error(key);
}

function boxMean(a, r) {
  const S = new Float64Array((W + 1) * (W + 1));
  for (let y = 0; y < W; y++) { let row = 0; for (let x = 0; x < W; x++) { row += a[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
  const out = new Float32Array(W * W);
  for (let y = 0; y < W; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(W, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      out[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// ---- display-tile → grid coordinate mapping
function mapper(x, y, d, S) {
  const span = DEM_TILE / 2 ** d, ox = (x - ((x >> d) << d)) * span, oy = (y - ((y >> d) << d)) * span, k = span / S;
  return { gx: (i) => DEM_BUF + ox + (i + 0.5) * k - 0.5, gy: (j) => DEM_BUF + oy + (j + 0.5) * k - 0.5, k };
}
function bilinear(a, fx, fy) {
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(W - 2, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0)), i = y0 * W + x0;
  return (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + W] * (1 - tx) + a[i + W + 1] * tx) * ty;
}
const nearest = (a, fx, fy) => a[Math.max(0, Math.min(W - 1, Math.round(fy))) * W + Math.max(0, Math.min(W - 1, Math.round(fx)))];

// ------------------------------------------------------------------ renderers
const SLOPE_COLORS = [[8, 15, [255, 235, 59, 150]], [15, 25, [255, 152, 0, 170]], [25, 35, [229, 57, 53, 185]], [35, 90, [142, 36, 170, 200]]];
const FEAT_COLORS = { 1: [0, 235, 160, 225], 2: [255, 160, 40, 140], 3: [30, 144, 255, 150] };

function renderRaster(layer, g, d, x, y, S, opts) {
  const px = new Uint8ClampedArray(S * S * 4), m = mapper(x, y, d, S);
  const shade = layer === 'relief' || layer === 'shade' ? derive(g, 'shade') : null;
  const sl = layer === 'slope' ? derive(g, 'grad').sl : null;
  const ft = layer === 'features' ? derive(g, 'feat') : null;
  const fs = opts.features || { bench: true, ridge: true, draw: true };
  for (let j = 0; j < S; j++) {
    const fy = m.gy(j);
    for (let i = 0; i < S; i++) {
      const fx = m.gx(i), o = (j * S + i) * 4;
      if (!nearest(g.valid, fx, fy)) continue;
      if (layer === 'relief') {
        const h = bilinear(shade, fx, fy);
        px[o] = 58 + h * 0.76; px[o + 1] = 56 + h * 0.76; px[o + 2] = 48 + h * 0.72; px[o + 3] = 255;
      } else if (layer === 'shade') {
        const h = bilinear(shade, fx, fy); // darken slopes away from light; lighten lit faces a touch
        if (h < 196) { px[o] = 18; px[o + 1] = 22; px[o + 2] = 14; px[o + 3] = Math.min(220, (196 - h) * 1.35); }
        else { px[o] = 255; px[o + 1] = 252; px[o + 2] = 235; px[o + 3] = Math.min(70, (h - 196) * 1.2); }
      } else if (layer === 'slope') {
        const s = bilinear(sl, fx, fy);
        for (const [a, b, c] of SLOPE_COLORS) if (s >= a && s < b) { px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3]; break; }
      } else if (layer === 'features') {
        const v = nearest(ft, fx, fy);
        if ((v === 1 && fs.bench) || (v === 2 && fs.ridge) || (v === 3 && fs.draw)) { const c = FEAT_COLORS[v]; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3]; }
      }
    }
  }
  return { pixels: px };
}

const AUTO_INTERVAL = { 12: 50, 13: 40, 14: 20, 15: 10, 16: 10, 17: 5, 18: 5 };
function renderContours(g, d, x, y, S, z, opts) {
  const interval = opts.interval && opts.interval !== 'auto' ? +opts.interval : (AUTO_INTERVAL[z] || (z > 18 ? 2 : 50));
  const idxEvery = interval >= 20 ? 5 : interval === 10 ? 5 : interval === 5 ? 4 : 5; // index lines: 100/50/20/10 ft
  const N = Math.min(256, S / 2), step = S / N, m = mapper(x, y, d, N);
  const vals = new Float32Array((N + 1) * (N + 1)), ok = new Uint8Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const fx = m.gx(i - 0.5), fy = m.gy(j - 0.5), q = j * (N + 1) + i;
    vals[q] = bilinear(g.e, fx, fy) * M_TO_FT; ok[q] = nearest(g.valid, fx, fy);
  }
  const segs = [], idx = [], byLevel = new Map();
  const interp = (a, b, lv) => (lv - a) / (b - a || 1e-9);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const q = j * (N + 1) + i;
    if (!(ok[q] && ok[q + 1] && ok[q + N + 1] && ok[q + N + 2])) continue;
    const tl = vals[q], tr = vals[q + 1], br = vals[q + N + 2], bl = vals[q + N + 1];
    const lo = Math.min(tl, tr, br, bl), hi = Math.max(tl, tr, br, bl);
    for (let lv = Math.ceil(lo / interval) * interval; lv <= hi; lv += interval) {
      if (lv === lo) continue;
      const c = (tl > lv ? 8 : 0) | (tr > lv ? 4 : 0) | (br > lv ? 2 : 0) | (bl > lv ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const X = i * step, Y = j * step;
      const T = [X + interp(tl, tr, lv) * step, Y], Rr = [X + step, Y + interp(tr, br, lv) * step];
      const B = [X + interp(bl, br, lv) * step, Y + step], Lf = [X, Y + interp(tl, bl, lv) * step];
      let pairs;
      switch (c) {
        case 1: case 14: pairs = [[Lf, B]]; break;
        case 2: case 13: pairs = [[B, Rr]]; break;
        case 3: case 12: pairs = [[Lf, Rr]]; break;
        case 4: case 11: pairs = [[T, Rr]]; break;
        case 6: case 9: pairs = [[T, B]]; break;
        case 7: case 8: pairs = [[Lf, T]]; break;
        case 5: case 10: {
          const center = (tl + tr + br + bl) / 4 > lv;
          pairs = (c === 5) === center ? [[Lf, T], [B, Rr]] : [[Lf, B], [T, Rr]];
          break;
        }
        default: pairs = [];
      }
      const isIdx = Math.round(lv / interval) % idxEvery === 0 ? 1 : 0;
      for (const [p1, p2] of pairs) {
        segs.push(p1[0], p1[1], p2[0], p2[1]); idx.push(isIdx);
        if (isIdx) { let a = byLevel.get(lv); if (!a) byLevel.set(lv, (a = [])); a.push(p1[0], p1[1], p2[0], p2[1]); }
      }
    }
  }
  // labels: up to 3 per tile on index lines, near the middle, spaced apart
  const labels = [], margin = S * 0.14;
  const cands = [];
  for (const [lv, a] of byLevel) {
    let best = null;
    for (let k = 0; k < a.length; k += 4) {
      const mx = (a[k] + a[k + 2]) / 2, my = (a[k + 1] + a[k + 3]) / 2;
      if (mx < margin || my < margin || mx > S - margin || my > S - margin) continue;
      const dc = Math.hypot(mx - S / 2, my - S / 2);
      if (!best || dc < best.dc) best = { dc, mx, my, ang: Math.atan2(a[k + 3] - a[k + 1], a[k + 2] - a[k]) };
    }
    if (best) cands.push({ ...best, text: `${Math.round(lv)}` });
  }
  cands.sort((p, q) => p.dc - q.dc);
  for (const c of cands) {
    if (labels.length >= 3) break;
    if (labels.some((l) => Math.hypot(l.x - c.mx, l.y - c.my) < S * 0.28)) continue;
    let ang = c.ang; if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
    labels.push({ x: c.mx, y: c.my, ang, text: c.text });
  }
  return { segs: new Float32Array(segs), idx: new Uint8Array(idx), labels, interval };
}

// ---- forest types (LANDFIRE)
const CAT_COLORS = {
  oak: [215, 38, 30, 175], pineoak: [242, 140, 40, 165], hardwood: [246, 211, 45, 150], mixed: [155, 203, 91, 120],
  conifer: [31, 107, 58, 150], wetforest: [43, 181, 176, 150], wetopen: [127, 211, 240, 140], field: [232, 215, 160, 150], shrub: [176, 124, 198, 165],
};
async function getEvt(z, x, y) {
  const k = `${z}/${x}/${y}`;
  let p = evtCache.get(k);
  if (!p) { p = fetchLerc(evtUrl(z, x, y)).then((dec) => ({ codes: dec.pixels[0], mask: dec.mask, w: dec.width })); p.catch(() => evtCache.delete(k)); evtCache.set(k, p); }
  return p;
}
async function evtFor(z, x, y) {
  let d = Math.max(0, z - EVT_MAX_Z);
  for (let t = 0; t <= MAX_FALLBACK; t++, d++) {
    try { return { t: await getEvt(z - d, x >> d, y >> d), d }; } catch (e) { if (!(e instanceof NetErr)) throw e; }
  }
  throw new NetErr('no forest data offline');
}
async function renderForest(z, x, y, S, opts) {
  const { t, d } = await evtFor(z, x, y);
  const on = new Set(opts.cats || Object.keys(CAT_COLORS));
  const span = t.w / 2 ** d, ox = (x - ((x >> d) << d)) * span, oy = (y - ((y >> d) << d)) * span, k = span / S;
  const px = new Uint8ClampedArray(S * S * 4);
  for (let j = 0; j < S; j++) {
    const sy = Math.min(t.w - 1, Math.floor(oy + (j + 0.5) * k));
    for (let i = 0; i < S; i++) {
      const sx = Math.min(t.w - 1, Math.floor(ox + (i + 0.5) * k)), q = sy * t.w + sx;
      if (t.mask && !t.mask[q]) continue;
      const e = EVT[t.codes[q]]; if (!e || !on.has(e[0])) continue;
      const c = CAT_COLORS[e[0]], o = (j * S + i) * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
    }
  }
  return { pixels: px };
}

// ------------------------------------------------------------------ point query
async function pointInfo(lat, lon) {
  const out = {};
  try {
    const f = lonLatToTileF(lon, lat, DEM_MAX_Z);
    const { g, d } = await gridFor(DEM_MAX_Z, Math.floor(f.x), Math.floor(f.y));
    if (!g.empty) {
      const s = 2 ** d, fx = DEM_BUF + (f.x / s - g.x) * DEM_TILE - 0.5, fy = DEM_BUF + (f.y / s - g.y) * DEM_TILE - 0.5;
      if (nearest(g.valid, fx, fy)) {
        const gr = derive(g, 'grad');
        out.elev = bilinear(g.e, fx, fy);
        out.slope = bilinear(gr.sl, fx, fy);
        const gx = bilinear(gr.dx, fx, fy), gy = bilinear(gr.dy, fx, fy);
        if (out.slope > 2) out.aspect = ((Math.atan2(-gx, gy) * 180) / Math.PI + 360) % 360; // direction the slope faces
        const ft = derive(g, 'feat')[Math.round(fy) * W + Math.round(fx)];
        out.feature = ['', 'Bench', 'Ridge / spur', 'Draw / drainage'][ft];
      }
    }
  } catch { /* no terrain here/offline */ }
  try {
    const f = lonLatToTileF(lon, lat, EVT_MAX_Z), { t } = await evtFor(EVT_MAX_Z, Math.floor(f.x), Math.floor(f.y));
    const sx = Math.floor((f.x - Math.floor(f.x)) * t.w), sy = Math.floor((f.y - Math.floor(f.y)) * t.w);
    const e = EVT[t.codes[sy * t.w + sx]]; if (e) { out.forestCat = e[0]; out.forest = e[1]; }
  } catch { /* offline */ }
  return out;
}

// ------------------------------------------------------------------ messages
self.onmessage = async ({ data: m }) => {
  try {
    let res, transfer = [];
    if (m.kind === 'render') {
      if (m.layer === 'forest') res = await renderForest(m.z, m.x, m.y, m.S, m.opts || {});
      else {
        const { g, d } = await gridFor(m.z, m.x, m.y);
        if (g.empty) res = { empty: true };
        else if (m.layer === 'contours') res = renderContours(g, d, m.x, m.y, m.S, m.z, m.opts || {});
        else res = renderRaster(m.layer, g, d, m.x, m.y, m.S, m.opts || {});
      }
      if (res.pixels) transfer = [res.pixels.buffer];
      if (res.segs) transfer = [res.segs.buffer, res.idx.buffer];
    } else if (m.kind === 'point') res = await pointInfo(m.lat, m.lon);
    self.postMessage({ id: m.id, ok: true, res }, transfer);
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, err: String(e.message || e), offline: e instanceof NetErr });
  }
};
