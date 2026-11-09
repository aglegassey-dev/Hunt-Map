// Layer catalogue: 4 base maps + grouped overlays. Imagery layers are fetched tiles; terrain and
// forest layers are computed on the phone from raw LiDAR elevation and LANDFIRE codes (terrain.js).
// Every layer is defined by URL functions (z, x, y) shared with the offline downloader.
import { tileBBox3857 } from './geo.js';
import { demUrl, evtUrl, DEM_MAX_Z, EVT_MAX_Z } from './sources.js';
import { TerrainLayer } from './terrain.js';

const L = window.L;
export const IMG_SIZE = window.devicePixelRatio > 1 ? 512 : 256;

const esri = (svc) => (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/${z}/${y}/${x}`;
const usgs = (svc) => (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/${svc}/MapServer/tile/${z}/${y}/${x}`;
const bboxParam = (z, x, y) => tileBBox3857(z, x, y).map((v) => v.toFixed(2)).join(',');
const maineOrtho = (z, x, y) => `https://gis.maine.gov/image/rest/services/Regional/orthoRegional/ImageServer/exportImage?${new URLSearchParams({
  bbox: bboxParam(z, x, y), bboxSR: 3857, imageSR: 3857, size: `${IMG_SIZE},${IMG_SIZE}`, format: 'jpg', f: 'image' })}`;
const wetlands = (z, x, y) => `https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/export?${new URLSearchParams({
  bbox: bboxParam(z, x, y), bboxSR: 3857, imageSR: 3857, size: `${IMG_SIZE},${IMG_SIZE}`, dpi: Math.round((96 * IMG_SIZE) / 256),
  format: 'png32', transparent: 'true', f: 'image' })}`;

// ---- user-adjustable settings for computed layers (main.js persists and mutates these)
export const FOREST_CATS = [
  ['oak', 'Oak', 'rgba(215,38,30,.85)', 'Northern oak forest: acorns'],
  ['pineoak', 'Pine-oak', 'rgba(242,140,40,.85)', 'Pine with oak mixed in'],
  ['hardwood', 'Hardwoods', 'rgba(246,211,45,.85)', 'Beech, maple, birch: beechnuts, browse'],
  ['mixed', 'Mixed', 'rgba(155,203,91,.8)', 'Pine-hemlock-hardwood'],
  ['conifer', 'Conifer', 'rgba(31,107,58,.9)', 'Pine, hemlock, spruce: thermal cover'],
  ['wetforest', 'Swamp forest', 'rgba(43,181,176,.85)', 'Wooded swamps: bedding'],
  ['wetopen', 'Marsh / wet meadow', 'rgba(127,211,240,.85)', 'Open wetland'],
  ['field', 'Fields', 'rgba(232,215,160,.9)', 'Hay, pasture, meadow: feeding edges'],
  ['shrub', 'Young growth', 'rgba(176,124,198,.85)', 'Shrubland, cut-overs: browse + cover'],
];
export const settings = {
  interval: 'auto',
  features: { bench: true, ridge: true, draw: true },
  cats: ['oak', 'pineoak', 'hardwood', 'wetforest', 'field', 'shrub'],
};

export const SLOPE_LEGEND = [['#FFEB3B', '8–15°'], ['#FF9800', '15–25°'], ['#E53935', '25–35°'], ['#8E24AA', '35°+']];
export const FEATURE_LEGEND = [
  ['bench', '#00E6A0', 'Benches', 'Flat shelves on hillsides: classic bedding'],
  ['ridge', '#FFA028', 'Ridges / spurs', 'High ground, travel routes along tops'],
  ['draw', '#1E90FF', 'Draws / drainages', 'Low ground, creek bottoms, funnels'],
];

const dem = (layer, extra = {}) => ({ kind: 'terrain', layer, url: demUrl, maxNative: DEM_MAX_Z, ...extra });

export const BASES = [
  { id: 'hybrid', name: 'Satellite', desc: 'Esri high-res imagery', swatch: 'linear-gradient(135deg,#3d5a2a,#7d8f55 60%,#a59d78)',
    sources: [{ url: esri('World_Imagery'), maxNative: 19 }], attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  { id: 'leafoff', name: 'Leaf-off', desc: 'Maine spring aerials: hardwoods gray, conifers green', swatch: 'linear-gradient(135deg,#7a705e,#2f4a2c 55%,#8b7f69)',
    sources: [{ url: maineOrtho, maxNative: 20 }], attribution: 'Orthoimagery: Maine GeoLibrary' },
  { id: 'topo', name: 'Topo', desc: 'USGS topographic map', swatch: 'linear-gradient(135deg,#eef0dc,#cfe0b5 50%,#b9d6e8)',
    sources: [{ url: usgs('USGSTopo'), maxNative: 16 }], attribution: 'USGS The National Map' },
  { id: 'terrain', name: 'LiDAR terrain', desc: '1 m bare-earth shaded relief', swatch: 'linear-gradient(135deg,#f2efe6,#9c9888 55%,#d9d5c8)',
    sources: [dem('relief')], attribution: 'LiDAR: Maine GeoLibrary' },
];

export const GROUPS = [
  ['terrain', 'Terrain (1 m LiDAR)'], ['water', 'Water & cover'], ['food', 'Food & forest'], ['map', 'Map'],
];

export const OVERLAYS = [
  { id: 'shade', group: 'terrain', name: 'Shaded relief', desc: 'Blends LiDAR relief over any base map', opacity: 0.8,
    sources: [dem('shade', { pane: 'hillshade' })], minZoom: 11, attribution: 'LiDAR: Maine GeoLibrary' },
  { id: 'contours', group: 'terrain', name: 'Contours', desc: 'Auto 2–50 ft by zoom, labeled index lines', opacity: 1,
    sources: [dem('contours', { pane: 'lines' })], minZoom: 12, attribution: 'LiDAR: Maine GeoLibrary' },
  { id: 'slope', group: 'terrain', name: 'Slope angle', desc: 'Steepness: find steep banks and pinch points', opacity: 0.7,
    sources: [dem('slope', { pane: 'terrain' })], minZoom: 12, legend: SLOPE_LEGEND, attribution: 'LiDAR: Maine GeoLibrary' },
  { id: 'features', group: 'terrain', name: 'Terrain features', desc: 'Auto-detected benches, ridges and draws', opacity: 0.85,
    sources: [dem('features', { pane: 'terrain' })], minZoom: 14, attribution: 'LiDAR: Maine GeoLibrary' },
  { id: 'streams', group: 'water', name: 'Streams & water', desc: 'USGS National Hydrography', opacity: 1,
    sources: [{ url: usgs('USGSHydroCached'), maxNative: 16, pane: 'lines' }], attribution: 'USGS NHD' },
  { id: 'wetlands', group: 'water', name: 'Wetlands', desc: 'USFWS wetlands: swamps, thickets, bedding cover', opacity: 0.6,
    sources: [{ url: wetlands, maxNative: 16, pane: 'terrain' }], minZoom: 12, attribution: 'USFWS National Wetlands Inventory' },
  { id: 'forest', group: 'food', name: 'Forest types', desc: 'LANDFIRE 2024 (30 m): pick what to show', opacity: 0.85,
    sources: [{ kind: 'terrain', layer: 'forest', url: evtUrl, maxNative: EVT_MAX_Z, pane: 'terrain' }], minZoom: 11, attribution: 'LANDFIRE 2024 EVT' },
  { id: 'labels', group: 'map', name: 'Roads & place names', desc: 'Esri reference labels', opacity: 1,
    sources: [{ url: esri('Reference/World_Transportation'), maxNative: 19, pane: 'labels' },
      { url: esri('Reference/World_Boundaries_and_Places'), maxNative: 19, pane: 'labels' }], attribution: '© Esri' },
];

export const PRESETS = [
  { id: 'scout', name: 'Terrain scout', icon: '⛰️', base: 'terrain', overlays: ['contours', 'features', 'streams', 'labels'] },
  { id: 'stand', name: 'Stand finder', icon: '🪜', base: 'hybrid', overlays: ['shade', 'slope', 'contours', 'streams', 'labels'] },
  { id: 'food', name: 'Food & cover', icon: '🌰', base: 'leafoff', overlays: ['forest', 'wetlands', 'streams', 'labels'] },
  { id: 'clean', name: 'Clean satellite', icon: '🛰️', base: 'hybrid', overlays: ['labels'] },
];

export function setupPanes(map) {
  const mk = (name, z) => { map.createPane(name); Object.assign(map.getPane(name).style, { zIndex: z, pointerEvents: 'none' }); };
  mk('hillshade', 250); mk('terrain', 300); mk('lines', 350); mk('labels', 380);
}

// ---- fetched-tile layer with offline parent fallback (zooming past downloaded detail never goes blank)
const MAX_FALLBACK = 6;
const SmartLayer = L.GridLayer.extend({
  createTile(c, done) { const canvas = document.createElement('canvas'); this._load(c, 0, canvas, done); return canvas; },
  _load(c, d, canvas, done) {
    const scale = 2 ** d, z = c.z - d, px = Math.floor(c.x / scale), py = Math.floor(c.y / scale);
    fetch(this.options.urlFn(z, px, py), { mode: 'cors' })
      .then((r) => { if (!r.ok) { const e = new Error(r.status); e.http = true; throw e; } return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((img) => {
        const sw = img.width / scale, sh = img.height / scale;
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (c.x - px * scale) * sw, (c.y - py * scale) * sh, sw, sh, 0, 0, canvas.width, canvas.height);
        done(null, canvas);
      })
      .catch((e) => {
        if (!e.http && d < MAX_FALLBACK && z - 1 >= 0) this._load(c, d + 1, canvas, done);
        else done(e, canvas);
      });
  },
});

const optsFor = (layer) => () => {
  if (layer === 'contours') return { interval: settings.interval };
  if (layer === 'features') return { features: settings.features };
  if (layer === 'forest') return { cats: settings.cats };
  return {};
};

export function makeLayer(def) {
  const layers = def.sources.map((s, i) => {
    const common = { maxZoom: 21, minZoom: def.minZoom || 0, pane: s.pane || 'tilePane', attribution: i === 0 ? def.attribution : undefined,
      updateWhenIdle: false, keepBuffer: 2 };
    if (s.kind === 'terrain') return new TerrainLayer({ ...common, layer: s.layer, getOpts: optsFor(s.layer) });
    return new SmartLayer({ ...common, urlFn: s.url, maxNativeZoom: s.maxNative });
  });
  const g = L.layerGroup(layers);
  g.setOpacity = (o) => layers.forEach((l) => l.setOpacity(o));
  g.redraw = () => layers.forEach((l) => l.redraw());
  return g;
}

/** All tile URLs a layer needs for the given bounds and zoom range (respects maxNative). */
export function tileUrlsFor(def, bounds, zMin, zMax, lonLatToTile) {
  const urls = new Set();
  for (const s of def.sources) {
    const top = Math.min(zMax, s.maxNative);
    for (let z = Math.max(Math.min(zMin, top), Math.min(def.minZoom || 0, top)); z <= top; z++) {
      const a = lonLatToTile(bounds.getWest(), bounds.getNorth(), z), b = lonLatToTile(bounds.getEast(), bounds.getSouth(), z);
      for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) urls.add(s.url(z, x, y));
    }
  }
  return [...urls];
}
