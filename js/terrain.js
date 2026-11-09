// Main-thread side of the terrain/forest worker: a Leaflet layer that asks the worker to render
// each tile, and a point-query helper (elevation, slope, aspect, forest type) that works offline.
const L = window.L;
const worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id); if (!p) return;
  if (data.progress != null) { p.onProgress?.(data.progress); return; }
  pending.delete(data.id);
  data.ok ? p.resolve(data.res) : p.reject(Object.assign(new Error(data.err), { offline: data.offline }));
};
const ask = (msg, transfer, onProgress) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ ...msg, id }, transfer || []);
});

/** Morning blind planner: prepare the terrain/forest raster for the huntable parcels, then score for a wind. */
export const planPrep = (parcels, addresses, onProgress) => ask({ kind: 'planPrep', parcels, addresses }, [], onProgress);
export const planScore = (wind, thermal) => ask({ kind: 'planScore', wind, thermal });

export const pointInfo = (lat, lon) => ask({ kind: 'point', lat, lon }).catch(() => ({}));

const TILE_PX = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1))) * 256;

/** Contour styling depends on the base map (light lines on imagery, brown on terrain/topo). */
export const contourStyle = { dark: false };

export const TerrainLayer = L.GridLayer.extend({
  options: { layer: 'relief', getOpts: () => ({}) },
  createTile(c, done) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE_PX;
    // forest classes are 30 m cells: render small and let the canvas smooth the edges when scaling up
    const S = this.options.layer === 'forest' ? 64 : TILE_PX;
    ask({ kind: 'render', layer: this.options.layer, z: c.z, x: c.x, y: c.y, S, opts: this.options.getOpts() })
      .then((res) => {
        const ctx = canvas.getContext('2d');
        if (res.pixels && S !== TILE_PX) {
          const small = document.createElement('canvas'); small.width = small.height = S;
          small.getContext('2d').putImageData(new ImageData(res.pixels, S, S), 0, 0);
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(small, 0, 0, TILE_PX, TILE_PX);
        } else if (res.pixels) ctx.putImageData(new ImageData(res.pixels, TILE_PX, TILE_PX), 0, 0);
        else if (res.segs) drawContours(ctx, res);
        done(null, canvas);
      })
      .catch((e) => done(e, canvas));
    return canvas;
  },
});

function drawContours(ctx, { segs, idx, labels }) {
  const k = TILE_PX / 256, dark = contourStyle.dark;
  const line = dark ? 'rgba(122,72,30,0.85)' : 'rgba(255,214,150,0.85)';
  const halo = dark ? 'rgba(255,255,255,0.85)' : 'rgba(20,24,12,0.85)';
  ctx.lineCap = 'round';
  for (const isIdx of [0, 1]) {
    ctx.beginPath();
    for (let s = 0; s < idx.length; s++) {
      if (idx[s] !== isIdx) continue;
      ctx.moveTo(segs[s * 4], segs[s * 4 + 1]); ctx.lineTo(segs[s * 4 + 2], segs[s * 4 + 3]);
    }
    ctx.strokeStyle = line; ctx.lineWidth = (isIdx ? 1.7 : 0.75) * k; ctx.stroke();
  }
  ctx.font = `600 ${11 * k}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const l of labels) {
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.ang);
    ctx.lineWidth = 3.5 * k; ctx.strokeStyle = halo; ctx.strokeText(l.text, 0, 0);
    ctx.fillStyle = dark ? 'rgb(110,60,20)' : 'rgb(255,222,165)'; ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
}
