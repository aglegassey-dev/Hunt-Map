// Raw-data tile URLs shared by the map (main thread), the terrain worker and the offline downloader.
// Keeping them in one place guarantees the exact same URLs are cached and later read offline.

export const DEM_BUF = 32;          // extra pixels fetched around each elevation tile (for seamless slope/TPI/contours)
export const DEM_TILE = 256;        // core size of an elevation tile
export const DEM_MAX_Z = 16;        // ~1.7 m/pixel in Maine; matches the 1 m LiDAR closely
export const EVT_MAX_Z = 14;        // LANDFIRE is 30 m; z14 (~7 m/px) is plenty

const R = 6378137, O = Math.PI * R;
function bboxBuffered(z, x, y, bufPx = 0) {
  const s = (2 * O) / 2 ** z, p = (s / DEM_TILE) * bufPx;
  return [x * s - O - p, O - (y + 1) * s - p, (x + 1) * s - O + p, O - y * s + p].map((v) => v.toFixed(2)).join(',');
}

/** Maine statewide 1 m LiDAR bare-earth DEM as compressed float elevations (LERC), with a pixel buffer. */
export function demUrl(z, x, y) {
  const n = DEM_TILE + 2 * DEM_BUF;
  const p = new URLSearchParams({
    bbox: bboxBuffered(z, x, y, DEM_BUF), bboxSR: 3857, imageSR: 3857, size: `${n},${n}`,
    format: 'lerc', compressionTolerance: '0.05', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  return `https://gis.maine.gov/image/rest/services/DEM/Maine_Elevation_DEM_Statewide/ImageServer/exportImage?${p}`;
}

/** LANDFIRE 2024 Existing Vegetation Type, raw class codes (LERC). */
export function evtUrl(z, x, y) {
  const p = new URLSearchParams({
    bbox: bboxBuffered(z, x, y), bboxSR: 3857, imageSR: 3857, size: '256,256',
    format: 'lerc', interpolation: 'RSP_NearestNeighbor', f: 'image',
  });
  return `https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/LF2024_EVT_CONUS/ImageServer/exportImage?${p}`;
}

export const lonLatToTileF = (lon, lat, z) => {
  const n = 2 ** z;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n };
};
