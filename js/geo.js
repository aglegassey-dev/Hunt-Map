// Geometry, units and solar helpers (no dependencies).

export function eachRing(g, fn) {
  (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]).forEach((p) => p.forEach(fn));
}

export function bboxOf(g) {
  let a = [180, 90, -180, -90];
  eachRing(g, (r) => r.forEach(([x, y]) => {
    a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)];
  }));
  return a;
}

export function contains(f, lon, lat) {
  const b = f.bbox || (f.bbox = bboxOf(f.geometry));
  if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) return false;
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  return polys.some((poly) => {
    let c = false;
    poly.forEach((ring) => {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
      }
    });
    return c;
  });
}

const kx = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const KY = 110540;

/** Nearest point on a feature's boundary → { d (m), lon, lat } */
export function nearestEdge(f, lon, lat) {
  const k = kx(lat);
  let best = { d: Infinity };
  eachRing(f.geometry, (r) => {
    for (let i = 1; i < r.length; i++) {
      const ax = (r[i - 1][0] - lon) * k, ay = (r[i - 1][1] - lat) * KY;
      const bx = (r[i][0] - lon) * k, by = (r[i][1] - lat) * KY;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
      if (d < best.d) best = { d, lon: lon + px / k, lat: lat + py / KY };
    }
  });
  return best;
}

export const distM = (lon1, lat1, lon2, lat2) =>
  Math.hypot((lon2 - lon1) * kx(lat1), (lat2 - lat1) * KY);

export const bearingDeg = (lon1, lat1, lon2, lat2) =>
  ((Math.atan2((lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180), lat2 - lat1) * 180) / Math.PI + 360) % 360;

export const cardinal = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

export const yd = (m) => (m < 1000 ? `${Math.round(m * 1.0936)} yd` : `${(m / 1609.34).toFixed(2)} mi`);
export const ft = (m) => `${Math.round(m * 3.2808)} ft`;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Web-Mercator (EPSG:3857) bbox of an XYZ tile. */
export function tileBBox3857(z, x, y) {
  const R = 6378137, o = Math.PI * R, s = (2 * o) / 2 ** z;
  return [x * s - o, o - (y + 1) * s, (x + 1) * s - o, o - y * s];
}

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/** Sunrise / sunset (NOAA approximation), returns Date objects. */
export function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const utcMid = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const day = Math.floor((utcMid - Date.UTC(date.getFullYear(), 0, 0)) / 864e5);
  const g = ((2 * Math.PI) / 365) * (day - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
  const at = (min) => new Date(utcMid + min * 60000);
  return { rise: at(720 - 4 * (lon + ha) - eqt), set: at(720 - 4 * (lon - ha) - eqt) };
}

export const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDate = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Lon/lat bounds of an XYZ tile → [west, south, east, north] */
export function tileBoundsLonLat(z, x, y) {
  const n = 2 ** z, lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}
