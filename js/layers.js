// Base maps and terrain / forest overlays. Every layer is defined by URL functions
// (z, x, y) so the same URLs are used for live browsing and offline downloads.
import { tileBBox3857 } from './geo.js';

const L = window.L;
export const IMG_SIZE = window.devicePixelRatio > 1 ? 512 : 256;

const esri = (svc) => (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/${z}/${y}/${x}`;
const usgs = (svc) => (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/${svc}/MapServer/tile/${z}/${y}/${x}`;
const osm = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

const bboxParam = (z, x, y) => tileBBox3857(z, x, y).map((v) => v.toFixed(2)).join(',');
// ArcGIS ImageServer exportImage for one tile
const imageServer = (svc, extra) => (z, x, y) => {
  const p = new URLSearchParams({
    bbox: bboxParam(z, x, y), bboxSR: 3857, imageSR: 3857, size: `${IMG_SIZE},${IMG_SIZE}`, f: 'image', ...extra,
  });
  return `https://gis.maine.gov/image/rest/services/${svc}/ImageServer/exportImage?${p}`;
};
const MAINE_DEM = 'DEM/Maine_Elevation_DEM_Statewide';

export const SLOPE_CLASSES = [
  [10, 15, '#FFEB3B', '10–15°'], [15, 25, '#FF9800', '15–25°'], [25, 35, '#E53935', '25–35°'], [35, 90, '#8E24AA', '35°+'],
];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const slopeRule = JSON.stringify({
  rasterFunction: 'Colormap',
  rasterFunctionArguments: {
    Colormap: SLOPE_CLASSES.map((c, i) => [i + 1, ...hex(c[2])]),
    Raster: {
      rasterFunction: 'Remap',
      rasterFunctionArguments: {
        InputRanges: SLOPE_CLASSES.flatMap((c) => [c[0], c[1]]), OutputValues: SLOPE_CLASSES.map((_, i) => i + 1),
        NoDataRanges: [0, SLOPE_CLASSES[0][0]],
        Raster: { rasterFunction: 'Slope', rasterFunctionArguments: { ZFactor: 1 } },
      },
    },
  },
});
const hillshadeRule = JSON.stringify({ rasterFunction: 'Hillshade', rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 1.5 } });
// USGS contours (10/20 ft intervals from 3DEP LiDAR at large scales, labeled)
const usgsContours = (z, x, y) => {
  const p = new URLSearchParams({
    bbox: bboxParam(z, x, y), bboxSR: 3857, imageSR: 3857, size: `${IMG_SIZE},${IMG_SIZE}`, dpi: Math.round((96 * IMG_SIZE) / 256),
    format: 'png32', transparent: 'true', f: 'image',
  });
  return `https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer/export?${p}`;
};

const nlcd = (z, x, y) => {
  const p = new URLSearchParams({
    service: 'WMS', version: '1.1.1', request: 'GetMap', layers: 'NLCD_2021_Land_Cover_L48', styles: '',
    srs: 'EPSG:3857', bbox: bboxParam(z, x, y), width: 256, height: 256, format: 'image/png', transparent: 'true',
  });
  return `https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms?${p}`;
};
const fiaHardwoods = (z, x, y) => {
  const p = new URLSearchParams({
    bbox: bboxParam(z, x, y), bboxSR: 3857, imageSR: 3857, size: '256,256', format: 'png32', transparent: 'true', f: 'image',
  });
  return `https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_FIA_ForestAtlas_Hardwoods_109/ImageServer/exportImage?${p}`;
};

// ---- pixel recolor functions (RGBA Uint8ClampedArray, in place) ----
const NLCD = { 11: [70, 107, 159], 12: [209, 222, 248], 21: [222, 197, 197], 22: [217, 146, 130], 23: [235, 0, 0], 24: [171, 0, 0],
  31: [179, 172, 159], 41: [104, 171, 95], 42: [28, 95, 44], 43: [181, 201, 142], 52: [204, 184, 121], 71: [223, 223, 194],
  81: [220, 217, 57], 82: [171, 108, 40], 90: [184, 217, 235], 95: [108, 159, 184] };
const NLCD_E = Object.entries(NLCD);
const HARDWOOD_OUT = { 41: [255, 140, 0, 150], 43: [255, 224, 0, 105] };
function recolorNlcd(d) {
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) { d[i + 3] = 0; continue; }
    let best = null, bd = 1e9;
    for (const [k, c] of NLCD_E) {
      const dd = (d[i] - c[0]) ** 2 + (d[i + 1] - c[1]) ** 2 + (d[i + 2] - c[2]) ** 2;
      if (dd < bd) { bd = dd; best = k; }
    }
    const o = bd < 900 ? HARDWOOD_OUT[best] : null;
    if (o) { d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o[3]; } else d[i + 3] = 0;
  }
}
const OAK = [[[237, 27, 47], [200, 20, 30, 165]], [[247, 148, 30], [255, 110, 0, 165]], [[255, 242, 0], [255, 236, 80, 85]]];
function recolorOak(d) {
  for (let i = 0; i < d.length; i += 4) {
    let out = null;
    if (d[i + 3] > 128) for (const [c, o] of OAK) {
      if (Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) < 30) { out = o; break; }
    }
    if (out) { d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3]; } else d[i + 3] = 0;
  }
}
function recolorContour(d) {
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const lum = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    if (lum > 200) { d[i] = 20; d[i + 1] = 28; d[i + 2] = 12; d[i + 3] *= 0.75; } // label halo → dark
    else { d[i] = 255; d[i + 1] = 206; d[i + 2] = 140; d[i + 3] = Math.min(255, d[i + 3] * 1.15); } // lines & text → tan
  }
}

// ---- Leaflet layer class ----
// Every layer draws tiles onto a canvas. If a tile can't be fetched because there's no signal and it
// isn't downloaded, it falls back to the nearest downloaded parent tile (up to 6 zooms up) and
// sharpens/upscales that quadrant. Zooming in past the downloaded detail never shows blank map offline.
const MAX_FALLBACK = 6;
const SmartLayer = L.GridLayer.extend({
  createTile(c, done) {
    const canvas = document.createElement('canvas');
    this._load(c, 0, canvas, done);
    return canvas;
  },
  _load(c, d, canvas, done) {
    const scale = 2 ** d, z = c.z - d, px = Math.floor(c.x / scale), py = Math.floor(c.y / scale);
    fetch(this.options.urlFn(z, px, py), { mode: 'cors' })
      .then((r) => { if (!r.ok) { const e = new Error(r.status); e.http = true; throw e; } return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((img) => {
        const sw = img.width / scale, sh = img.height / scale;
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: !!this.options.recolor });
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (c.x - px * scale) * sw, (c.y - py * scale) * sh, sw, sh, 0, 0, canvas.width, canvas.height);
        if (this.options.recolor) {
          const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
          this.options.recolor(id.data); ctx.putImageData(id, 0, 0);
        }
        done(null, canvas);
      })
      .catch((e) => {
        // Network failure (offline & not cached) → try the parent tile. HTTP errors (e.g. 404 blank tile) don't retry.
        if (!e.http && d < MAX_FALLBACK && z - 1 >= 0) this._load(c, d + 1, canvas, done);
        else done(e, canvas);
      });
  },
});

/**
 * Layer catalogue. sources: [{ url, maxNative, recolor?, pane?, opacity? }]
 */
export const BASES = [
  { id: 'hybrid', name: 'Satellite', desc: 'Esri imagery with roads and place names',
    sources: [{ url: esri('World_Imagery'), maxNative: 19 }, { url: esri('Reference/World_Transportation'), maxNative: 19, pane: 'labels' },
      { url: esri('Reference/World_Boundaries_and_Places'), maxNative: 19, pane: 'labels' }],
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  { id: 'leafoff', name: 'Leaf-off aerial', desc: 'Maine spring aerial photos. Hardwoods look gray/brown, conifers dark green.',
    sources: [{ url: imageServer('Regional/orthoRegional', { format: 'jpg' }), maxNative: 20 },
      { url: esri('Reference/World_Transportation'), maxNative: 19, pane: 'labels' }],
    attribution: 'Orthoimagery: Maine GeoLibrary' },
  { id: 'topo', name: 'USGS Topo', desc: 'Contours, streams, trails',
    sources: [{ url: usgs('USGSTopo'), maxNative: 16 }], attribution: 'USGS The National Map' },
  { id: 'esritopo', name: 'Topo (detailed)', desc: 'Esri World Topographic',
    sources: [{ url: esri('World_Topo_Map'), maxNative: 18 }], attribution: '© Esri & contributors' },
  { id: 'terrain', name: 'LiDAR terrain', desc: '1 m bare-earth hillshade: ravines, benches, ridges',
    sources: [{ url: imageServer(MAINE_DEM, { format: 'jpg', renderingRule: hillshadeRule }), maxNative: 18 },
      { url: usgs('USGSHydroCached'), maxNative: 16, pane: 'lines' },
      { url: esri('Reference/World_Transportation'), maxNative: 19, pane: 'labels' }],
    attribution: 'LiDAR DEM: Maine GeoLibrary · USGS' },
  { id: 'street', name: 'Street map', desc: 'OpenStreetMap',
    sources: [{ url: osm, maxNative: 19 }], attribution: '© OpenStreetMap contributors' },
];

export const OVERLAYS = [
  { id: 'hillshade', name: 'LiDAR hillshade', desc: '1 m bare-earth relief blended over the map',
    sources: [{ url: imageServer(MAINE_DEM, { format: 'jpg', renderingRule: hillshadeRule }), maxNative: 18, pane: 'hillshade', opacity: 0.85 }],
    attribution: 'LiDAR: Maine GeoLibrary' },
  { id: 'slope', name: 'Slope angle', desc: 'Steepness from 1 m LiDAR',
    sources: [{ url: imageServer(MAINE_DEM, { format: 'png32', transparent: 'true', renderingRule: slopeRule }), maxNative: 18, pane: 'terrain', opacity: 0.55 }],
    legend: SLOPE_CLASSES.map((c) => [c[2], c[3]]), attribution: 'LiDAR: Maine GeoLibrary' },
  { id: 'contours', name: 'Contour lines', desc: 'USGS elevation contours with labels (zoom in for detail)', minZoom: 13,
    sources: [{ url: usgsContours, maxNative: 17, pane: 'lines', recolor: recolorContour }],
    attribution: 'Contours: USGS The National Map' },
  { id: 'streams', name: 'Streams & water', desc: 'USGS National Hydrography',
    sources: [{ url: usgs('USGSHydroCached'), maxNative: 16, pane: 'lines' }], attribution: 'USGS NHD' },
  { id: 'hardwood', name: 'Hardwood forest', desc: 'NLCD 2021 (30 m): deciduous and mixed forest',
    sources: [{ url: nlcd, maxNative: 16, pane: 'terrain', recolor: recolorNlcd }],
    legend: [['rgba(255,140,0,.75)', 'Deciduous (hardwood)'], ['rgba(255,224,0,.6)', 'Mixed hardwood/conifer']], attribution: 'MRLC NLCD' },
  { id: 'oak', name: 'Oak forest groups', desc: 'USFS Forest Atlas (250 m, regional trend only)',
    sources: [{ url: fiaHardwoods, maxNative: 13, pane: 'terrain', recolor: recolorOak }],
    legend: [['rgba(200,20,30,.75)', 'Oak / pine'], ['rgba(255,110,0,.75)', 'Oak / hickory'], ['rgba(255,236,80,.5)', 'Maple / beech / birch (beechnuts)']],
    attribution: 'USDA Forest Service FIA' },
];

export const PRESETS = [
  { id: 'scout', name: 'Terrain scout', base: 'terrain', overlays: ['slope', 'contours'] },
  { id: 'scoutsat', name: 'Terrain on satellite', base: 'hybrid', overlays: ['hillshade', 'slope', 'streams'] },
  { id: 'food', name: 'Food / hardwoods', base: 'leafoff', overlays: ['hardwood', 'streams'] },
  { id: 'plain', name: 'Plain satellite', base: 'hybrid', overlays: [] },
];

export function setupPanes(map) {
  const mk = (name, z, style = {}) => { map.createPane(name); Object.assign(map.getPane(name).style, { zIndex: z, pointerEvents: 'none', ...style }); };
  mk('hillshade', 250, { mixBlendMode: 'multiply', filter: 'contrast(1.9) brightness(1.12)' });
  mk('terrain', 300);
  mk('lines', 350);
  mk('labels', 380);
}

export function makeLayer(def) {
  const layers = def.sources.map((s, i) => {
    const opts = {
      urlFn: s.url, maxNativeZoom: s.maxNative, maxZoom: 21, minZoom: def.minZoom || 0, opacity: s.opacity ?? 1,
      pane: s.pane || 'tilePane', attribution: i === 0 ? def.attribution : undefined, recolor: s.recolor,
      updateWhenIdle: false, keepBuffer: 3,
    };
    return new SmartLayer(opts);
  });
  return L.layerGroup(layers);
}

/** All tile URLs a layer needs for the given bounds and zoom range (respects maxNative). */
export function tileUrlsFor(def, bounds, zMin, zMax, lonLatToTile) {
  const urls = new Set();
  for (const s of def.sources) {
    const top = Math.min(zMax, s.maxNative);
    for (let z = Math.max(zMin, def.minZoom || 0); z <= top; z++) {
      const a = lonLatToTile(bounds.getWest(), bounds.getNorth(), z), b = lonLatToTile(bounds.getEast(), bounds.getSouth(), z);
      for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) urls.add(s.url(z, x, y));
    }
  }
  return [...urls];
}
