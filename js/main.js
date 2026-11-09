import { contains, nearestEdge, distM, bearingDeg, cardinal, yd, ft, esc, sunTimes, hm, fmtDate, bboxOf } from './geo.js';
import { BASES, OVERLAYS, PRESETS, GROUPS, FOREST_CATS, FEATURE_LEGEND, settings, setupPanes, makeLayer } from './layers.js';
import { pointInfo, contourStyle, planPrep, planScore } from './terrain.js';
import { APP_URL, waypointsLink, parseShared, shareUrl, copyText, qrSvg } from './share.js';
import { db, uid } from './db.js';
import { toGPX, parseGeoFile, shareOrDownload } from './gpx.js';
import { planDownload, download, recordArea, listAreas, removeAreaRecord, clearAll, storageText, planPreserves, PACK_LEVELS, PACK_ID } from './offline.js';
import { getWind, windArrow, getForecast, summarizeWind } from './weather.js';

const L = window.L;
const D = window.HUNT_DATA;
const SAFETY_M = 91.44; // 100 yards
const COLORS = { no: '#E8642C', firearm: '#5BC236', bow: '#5C8FE6', unmapped: '#9AA08F' };
const LABEL = { no: 'No hunting', firearm: 'Firearm & bow OK', bow: 'Bow hunting only', unmapped: 'Not on FCT hunting map' };
const RANK = { no: 3, unmapped: 2, bow: 1, firearm: 0 };
export const WP_TYPES = [
  ['stand', '🪜', 'Tree stand'], ['blind', '⛺', 'Ground blind'], ['camera', '📷', 'Trail camera'], ['scrape', '⭕', 'Scrape'],
  ['rub', '🪵', 'Rub'], ['bedding', '🛏️', 'Bedding'], ['food', '🌰', 'Food / oaks'], ['water', '💧', 'Water'],
  ['sighting', '🦌', 'Deer sighting'], ['trail', '🥾', 'Trail / crossing'], ['parking', '🅿️', 'Parking'], ['blood', '🩸', 'Blood trail'],
  ['harvest', '🏆', 'Harvest'], ['note', '📍', 'Note'],
];
const WP = Object.fromEntries(WP_TYPES.map(([id, e, n]) => [id, { e, n }]));
const typeOf = (t) => WP[t] || WP.note;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('huntmap.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('huntmap.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const toast = (t, ms = 3500) => { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), ms); };

// ===================================================================== state
let watchId = null, follow = false, meDot = null, meAcc = null, wakeLock = null, lastFix = null;
let spot = null;            // tapped spot {lat, lon, marker}
let navTarget = null, navLine = null;
let waypoints = [], wpMarkers = new Map(), editing = null;
let tracks = [], trackLayers = new Map(), recording = null, recLine = null;

// ===================================================================== map
const view = store.get('view', null);
const map = L.map('map', { zoomControl: false, maxZoom: 21 })
  .setView(view ? [view.lat, view.lon] : [43.85, -70.095], view ? view.z : 13);
map.on('moveend', () => { const c = map.getCenter(); store.set('view', { lat: c.lat, lon: c.lng, z: map.getZoom() }); });
L.control.scale({ imperial: true, metric: false, position: 'topleft' }).addTo(map);
setupPanes(map);
map.createPane('parcels').style.zIndex = 410;
map.createPane('safety').style.zIndex = 420;
map.createPane('tracks').style.zIndex = 430;

// ---- base & overlays
const baseLayers = Object.fromEntries(BASES.map((b) => [b.id, null]));
const overlayLayers = Object.fromEntries(OVERLAYS.map((o) => [o.id, null]));
const LEGACY_BASE = { esritopo: 'topo', street: 'topo' };
let base = store.get('base', 'hybrid'); base = LEGACY_BASE[base] || base; if (!(base in baseLayers)) base = 'hybrid';
let activeOverlays = new Set(store.get('overlays2', ['labels', 'streams']).filter((id) => id in overlayLayers));
Object.assign(settings, store.get('layerSettings', {}));
const opacityOf = (id) => store.get('op.' + id, OVERLAYS.find((o) => o.id === id).opacity);
function setBase(id) {
  if (baseLayers[base]) map.removeLayer(baseLayers[base]);
  base = id; baseLayers[id] ||= makeLayer(BASES.find((b) => b.id === id)); baseLayers[id].addTo(map);
  const dark = id === 'terrain' || id === 'topo';
  if (contourStyle.dark !== dark) { contourStyle.dark = dark; overlayLayers.contours?.redraw(); }
  store.set('base', id); renderLayerSheet();
}
function setOverlay(id, on) {
  if (!overlayLayers[id]) { overlayLayers[id] = makeLayer(OVERLAYS.find((o) => o.id === id)); overlayLayers[id].setOpacity(opacityOf(id)); }
  if (on) { activeOverlays.add(id); overlayLayers[id].addTo(map); } else { activeOverlays.delete(id); map.removeLayer(overlayLayers[id]); }
  store.set('overlays2', [...activeOverlays]); renderLayerSheet();
}
function saveSettings(redrawId) { store.set('layerSettings', settings); overlayLayers[redrawId]?.redraw(); }
function applyPreset(p) {
  setBase(p.base);
  OVERLAYS.forEach((o) => setOverlay(o.id, p.overlays.includes(o.id)));
  toast(`${p.icon} ${p.name}`);
}
contourStyle.dark = base === 'terrain' || base === 'topo';
setBase(base);
[...activeOverlays].forEach((id) => setOverlay(id, true));

// ---- parcels
const feats = D.parcels.features;
const popupHtml = (p) => `<b>${esc(p.name)}</b><br><span style="color:${COLORS[p.status]};font-weight:700">${LABEL[p.status]}</span>` +
  `<br>${p.acres} acres · ${esc(p.type || '')}` + (p.status === 'unmapped' ? `<br><small>State access note: ${esc(p.access || 'n/a')}</small>` : '');
const mkParcels = (status) => L.geoJSON({ type: 'FeatureCollection', features: feats.filter((f) => f.properties.status === status) }, {
  pane: 'parcels',
  style: () => status === 'unmapped'
    ? { color: COLORS.unmapped, weight: 1.5, dashArray: '5 5', fillOpacity: 0.06 }
    : { color: COLORS[status], weight: 2.5, fillOpacity: 0.22, fillColor: COLORS[status] },
  onEachFeature: (f, layer) => layer.on('click', (e) => { L.DomEvent.stop(e); showSpot(e.latlng, popupHtml(f.properties)); }),
});
const unmappedLayer = mkParcels('unmapped');
const huntLayer = L.layerGroup(['no', 'bow', 'firearm'].map(mkParcels));
const labelGroup = L.layerGroup();
{
  const byName = {};
  feats.filter((f) => f.properties.status !== 'unmapped').forEach((f) => {
    const n = f.properties.name.split(' (')[0].split(' – ')[0];
    if (!byName[n] || f.properties.acres > byName[n].properties.acres) byName[n] = f;
  });
  Object.entries(byName).forEach(([n, f]) => L.tooltip({ permanent: true, direction: 'center', className: 'plabel', interactive: false })
    .setLatLng(L.geoJSON(f).getBounds().getCenter()).setContent(esc(n)).addTo(labelGroup));
}
const safetyLayer = L.layerGroup(D.addresses.map(([lon, lat, addr]) => L.circle([lat, lon], {
  pane: 'safety', radius: SAFETY_M, color: '#F2C230', weight: 1.5, dashArray: '4 4', fillColor: '#F2C230', fillOpacity: 0.1, interactive: false,
}).bindTooltip(esc(addr || 'Address point'))));

const HUNT_TOGGLES = [
  ['zones', 'Hunting zones (FCT)', true, huntLayer],
  ['safety', '100-yd safety zones (approx.)', true, safetyLayer],
  ['unmapped', 'Other FCT land', true, unmappedLayer],
  ['labels', 'Preserve names', true, labelGroup],
];
const huntOn = Object.fromEntries(HUNT_TOGGLES.map(([k, , d]) => [k, store.get('show.' + k, d)]));
function setHunt(k, on) {
  huntOn[k] = on; store.set('show.' + k, on);
  const layer = HUNT_TOGGLES.find((t) => t[0] === k)[3];
  if (on) layer.addTo(map); else map.removeLayer(layer);
  updLabels(); renderLayerSheet();
}
HUNT_TOGGLES.forEach(([k]) => setHunt(k, huntOn[k]));
function updLabels() { map.getContainer().classList.toggle('hide-labels', map.getZoom() < 13); map.getContainer().classList.toggle('hide-wplabels', map.getZoom() < 15); }
map.on('zoomend', updLabels);

// ===================================================================== sheets
const openSheet = (id, modal = true) => {
  document.querySelectorAll('.sheet.open').forEach((s) => s.id !== id && s.classList.remove('open'));
  $(id).classList.add('open'); $('scrim').classList.toggle('open', modal);
};
const closeSheets = () => {
  document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('open')); $('scrim').classList.remove('open');
  if (editing) closeEditor(false);
};
$('scrim').onclick = closeSheets;
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheets(); });
$('btnLayers').onclick = () => { openSheet('sheetLayers'); renderLayerSheet(); };
$('btnList').onclick = () => { renderList(); openSheet('sheetList'); };
$('btnOffline').onclick = () => { renderOffline(); openSheet('sheetOffline'); };
$('btnInfo').onclick = () => openSheet('sheetInfo');
$('built').textContent = D.built;

function renderLayerSheet() {
  const el = $('layerBody'); if (!$('sheetLayers').classList.contains('open')) return;
  const extra = (o) => {
    if (!activeOverlays.has(o.id)) return '';
    let h = `<div class="ov-extra"><label class="slider"><span>Opacity</span><input type="range" min="0.15" max="1" step="0.05" value="${opacityOf(o.id)}" data-op="${o.id}"></label>`;
    if (o.legend) h += `<div class="legend-row">${o.legend.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>`;
    if (o.id === 'contours') h += `<div class="seg small" data-set="interval">${['auto', '2', '5', '10', '20'].map((v) =>
      `<button data-v="${v}" class="${String(settings.interval) === v ? 'sel' : ''}">${v === 'auto' ? 'Auto' : v + ' ft'}</button>`).join('')}</div>`;
    if (o.id === 'features') h += `<div class="cats">${FEATURE_LEGEND.map(([k, c, n, d]) =>
      `<button class="cat ${settings.features[k] ? 'on' : ''}" data-feat="${k}" title="${d}"><i style="background:${c}"></i>${n}</button>`).join('')}</div>` +
      '<p class="muted small">Detected from 1 m LiDAR at the current zoom. Zoom 15–17 works best.</p>';
    if (o.id === 'forest') h += `<div class="cats">${FOREST_CATS.map(([k, n, c, d]) =>
      `<button class="cat ${settings.cats.includes(k) ? 'on' : ''}" data-cat="${k}" title="${d}"><i style="background:${c}"></i>${n}</button>`).join('')}</div>` +
      '<p class="muted small">Tap any spot on the map to see its exact forest type. Model data at 30 m, so confirm oaks on foot.</p>';
    return h + '</div>';
  };
  el.innerHTML =
    `<div class="presets">${PRESETS.map((p) => `<button class="preset" data-preset="${p.id}"><span>${p.icon}</span>${p.name}</button>`).join('')}</div>` +
    `<h3>Base map</h3><div class="bases">${BASES.map((b) => `<button class="base ${b.id === base ? 'sel' : ''}" data-base="${b.id}"><i style="background:${b.swatch}"></i><b>${b.name}</b><small>${b.desc}</small></button>`).join('')}</div>` +
    GROUPS.map(([g, gname]) => `<h3>${gname}</h3>` + OVERLAYS.filter((o) => o.group === g).map((o) =>
      `<div class="ov ${activeOverlays.has(o.id) ? 'on' : ''}"><label class="ov-row"><span class="grow"><b>${o.name}</b><small>${o.desc}</small></span>` +
      `<input type="checkbox" class="switch" data-ov="${o.id}" ${activeOverlays.has(o.id) ? 'checked' : ''}></label>${extra(o)}</div>`).join('')).join('') +
    `<h3>Hunting</h3>${HUNT_TOGGLES.map(([k, n]) => `<div class="ov"><label class="ov-row"><span class="grow"><b>${n}</b></span><input type="checkbox" class="switch" data-hunt="${k}" ${huntOn[k] ? 'checked' : ''}></label></div>`).join('')}` +
    `<div class="ov"><label class="ov-row"><span class="grow"><b>Keep screen awake while following GPS</b></span><input type="checkbox" class="switch" id="optWake" ${store.get('wake', true) ? 'checked' : ''}></label></div>`;
}
$('layerBody').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.ov) setOverlay(t.dataset.ov, t.checked);
  else if (t.dataset.hunt) setHunt(t.dataset.hunt, t.checked);
  else if (t.id === 'optWake') { store.set('wake', t.checked); syncWake(); }
  else if (t.dataset.op) store.set('op.' + t.dataset.op, +t.value);
});
$('layerBody').addEventListener('input', (e) => { const t = e.target; if (t.dataset.op) overlayLayers[t.dataset.op]?.setOpacity(+t.value); });
$('layerBody').addEventListener('click', (e) => {
  const p = e.target.closest('[data-preset]'), b = e.target.closest('[data-base]'), iv = e.target.closest('[data-set=interval] [data-v]');
  const ft2 = e.target.closest('[data-feat]'), ct = e.target.closest('[data-cat]');
  if (p) applyPreset(PRESETS.find((x) => x.id === p.dataset.preset));
  else if (b) setBase(b.dataset.base);
  else if (iv) { settings.interval = iv.dataset.v; saveSettings('contours'); renderLayerSheet(); }
  else if (ft2) { settings.features[ft2.dataset.feat] = !settings.features[ft2.dataset.feat]; saveSettings('features'); renderLayerSheet(); }
  else if (ct) { const k = ct.dataset.cat; settings.cats = settings.cats.includes(k) ? settings.cats.filter((c) => c !== k) : [...settings.cats, k]; saveSettings('forest'); renderLayerSheet(); }
});

// ===================================================================== elevation / terrain / forest at a point
const infoCache = new Map();
async function spotInfo(lat, lon) {
  const k = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (infoCache.has(k)) return infoCache.get(k);
  const info = await pointInfo(lat, lon);
  if (info.elev == null && navigator.onLine) { // outside the processed tiles: ask the state server
    try {
      const p = new URLSearchParams({ geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: 'esriGeometryPoint', returnGeometry: 'false', returnCatalogItems: 'false', f: 'json' });
      const v = parseFloat((await (await fetch(`https://gis.maine.gov/image/rest/services/DEM/Maine_Elevation_DEM_Statewide/ImageServer/identify?${p}`)).json()).value);
      if (isFinite(v)) info.elev = v;
    } catch { /* offline */ }
  }
  infoCache.set(k, info); if (infoCache.size > 300) infoCache.delete(infoCache.keys().next().value);
  return info;
}
const elevation = async (lat, lon) => (await spotInfo(lat, lon)).elev ?? null;
function terrainText(i) {
  if (i.slope == null) return 'n/a';
  const parts = [`${Math.round(i.slope)}° slope`];
  if (i.aspect != null) parts.push(`faces ${cardinal(i.aspect)}`);
  if (i.feature) parts.push(`<b>${i.feature}</b>`);
  return parts.join(' · ');
}

// ===================================================================== status evaluation
function evaluate(lon, lat, acc) {
  const hits = feats.filter((f) => contains(f, lon, lat)).sort((a, b) => RANK[b.properties.status] - RANK[a.properties.status]);
  const here = hits.find((f) => f.properties.status !== 'unmapped') || hits[0] || null;
  const status = here ? here.properties.status : 'outside';
  const alerts = [], rows = [];
  if (here) {
    const e = nearestEdge(here, lon, lat);
    rows.push(['Preserve', `<b>${esc(here.properties.name)}</b>`]);
    rows.push(['Boundary', `${yd(e.d)} to edge (${cardinal(bearingDeg(lon, lat, e.lon, e.lat))})`]);
    if (acc != null && acc > e.d) alerts.push(['warn', `GPS accuracy (±${yd(acc)}) is larger than your distance to the boundary. You may be outside it.`]);
    if (status === 'unmapped') alerts.push(['warn', 'This FCT land is not on the hunting map. Check with FCT before hunting.']);
  }
  if (status !== 'firearm' && status !== 'bow') {
    let best = null;
    feats.forEach((f) => { if (f.properties.status === 'firearm' || f.properties.status === 'bow') {
      const e = nearestEdge(f, lon, lat); if (!best || e.d < best.e.d) best = { f, e };
    } });
    if (best) rows.push(['Nearest OK', `${esc(best.f.properties.name)}: ${yd(best.e.d)} ${cardinal(bearingDeg(lon, lat, best.e.lon, best.e.lat))}`]);
  }
  let near = null;
  D.addresses.forEach(([x, y, addr]) => { const d = distM(lon, lat, x, y); if (!near || d < near.d) near = { d, addr }; });
  if (near && near.d < 400) {
    if (near.d <= SAFETY_M) alerts.push(['stop', `Within ~100 yd of an address point (${esc(near.addr)}, ${yd(near.d)}). No firearm discharge without the owner's permission.`]);
    else if (acc != null && near.d <= SAFETY_M + acc) alerts.push(['warn', `GPS accuracy puts you possibly within 100 yd of ${esc(near.addr)}.`]);
  }
  const now = new Date();
  if (now.getDay() === 0) alerts.push(['stop', 'Today is Sunday. No hunting in Maine on Sundays.']);
  const st = sunTimes(now, lat, lon);
  if (isFinite(st.rise)) {
    const open = new Date(st.rise - 30 * 60000), close = new Date(+st.set + 30 * 60000), legal = now >= open && now <= close;
    rows.push(['Shoot hours', `${hm(open)} – ${hm(close)} ${legal ? '<b>(now legal)</b>' : '<b class="bad">(closed now)</b>'}`]);
  }
  rows.push(['Elevation', '<span class="elev">…</span>']);
  rows.push(['Terrain', '<span class="terr">…</span>']);
  rows.push(['Forest', '<span class="forest">…</span>']);
  if (acc != null) rows.push(['GPS', `±${yd(acc)}`]);
  return { status, rows, alerts };
}

let elevToken = 0, lastElevAt = { t: 0, lat: 0, lon: 0, m: {} };
function render(res, { title, extraHtml = '', lat, lon } = {}) {
  const card = $('card');
  card.className = 'card s-' + res.status + (store.get('cardCollapsed', false) ? ' collapsed' : '');
  $('cardTitle').textContent = title || (res.status === 'outside' ? 'Outside FCT preserves' : LABEL[res.status]);
  $('cardDot').style.background = COLORS[res.status] || COLORS.unmapped;
  $('cardBadge').textContent = res.alerts.length ? `⚠ ${res.alerts.length}` : '';
  $('cardAlerts').innerHTML = res.alerts.map(([k, t]) => `<div class="alert ${k}">${t}</div>`).join('');
  $('cardBody').innerHTML = res.rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('') +
    (res.status === 'outside' ? '<div class="muted">Private or other land: follow posting and landowner rules.</div>' : '') + extraHtml;
  if (lat != null) {
    const tok = ++elevToken;
    const fresh = distM(lon, lat, lastElevAt.lon, lastElevAt.lat) < 15 && Date.now() - lastElevAt.t < 60000;
    const setE = (i) => {
      if (tok !== elevToken) return;
      card.querySelectorAll('.elev').forEach((e) => (e.textContent = i.elev == null ? 'n/a' : ft(i.elev)));
      card.querySelectorAll('.terr').forEach((e) => (e.innerHTML = terrainText(i)));
      card.querySelectorAll('.forest').forEach((e) => (e.textContent = i.forest ? i.forest.replace(/^(Laurentian-Acadian|Northern Appalachian-Acadian|Eastern Cool Temperate|Northern & Central|Acadian) /, '') : 'n/a'));
    };
    if (fresh) setE(lastElevAt.m);
    else spotInfo(lat, lon).then((i) => { lastElevAt = { t: Date.now(), lat, lon, m: i }; setE(i); });
  }
  placeFab();
}
function placeFab() { $('fab').style.bottom = ($('card').offsetHeight + 18) + 'px'; }
window.addEventListener('resize', placeFab);
$('cardHead').onclick = () => { store.set('cardCollapsed', !store.get('cardCollapsed', false)); $('card').classList.toggle('collapsed'); placeFab(); };

function refreshCard() {
  if (spot) return;
  if (lastFix) render(evaluate(lastFix.lon, lastFix.lat, lastFix.acc), { lat: lastFix.lat, lon: lastFix.lon,
    extraHtml: navHtml() + recHtml() + '<div class="btnrow"><button class="btn small" id="shareMe">📤 Send my location</button></div>' });
}

// ===================================================================== tap / long-press
function showSpot(latlng, headerHtml = '') {
  clearSpot();
  const m = L.marker(latlng, { icon: L.divIcon({ className: 'spot-pin', html: '<div></div>', iconSize: [22, 22] }) }).addTo(map);
  spot = { lat: latlng.lat, lon: latlng.lng, marker: m };
  const res = evaluate(latlng.lng, latlng.lat, null);
  const fromMe = lastFix ? `<div class="row"><span class="k">From you</span><span>${yd(distM(lastFix.lon, lastFix.lat, latlng.lng, latlng.lat))} ${cardinal(bearingDeg(lastFix.lon, lastFix.lat, latlng.lng, latlng.lat))}</span></div>` : '';
  render(res, {
    title: 'Spot: ' + (res.status === 'outside' ? 'Outside FCT preserves' : LABEL[res.status]), lat: latlng.lat, lon: latlng.lng,
    extraHtml: fromMe + (headerHtml ? `<div class="spot-info">${headerHtml}</div>` : '') +
      '<div class="btnrow spotbtns"><button class="btn small primary" id="spotAdd">＋ Waypoint</button><button class="btn small" id="spotNav">Go</button><button class="btn small" id="spotShare">Share</button><button class="btn small x" id="spotClose" aria-label="Close">✕</button></div>',
  });
  $('spotShare').onclick = () => shareWaypoints([{ name: 'Spot', type: 'note', lat: spot.lat, lon: spot.lon, notes: '' }], 'Check out this spot');
  $('spotAdd').onclick = () => { const s = spot; clearSpot(); newWaypoint(s.lat, s.lon); };
  $('spotNav').onclick = () => { const s = spot; clearSpot(); startNav({ lat: s.lat, lon: s.lon, name: 'Dropped spot' }); };
  $('spotClose').onclick = () => { clearSpot(); idleCard(); };
}
function clearSpot() { if (spot) { map.removeLayer(spot.marker); spot = null; } }
function idleCard() {
  if (lastFix) return refreshCard();
  $('card').className = 'card s-idle' + (store.get('cardCollapsed', false) ? ' collapsed' : '');
  $('cardTitle').textContent = 'Tap ◎ to show your location'; $('cardBadge').textContent = ''; $('cardAlerts').innerHTML = '';
  $('cardBody').innerHTML = '<div class="muted">Tap the map to check a spot. Long-press to drop a waypoint.</div>' + navHtml();
  placeFab();
}
map.on('click', (e) => { if (editing || document.querySelector('.sheet.open')) { closeSheets(); return; } showSpot(e.latlng); });
map.on('contextmenu', (e) => { clearSpot(); newWaypoint(e.latlng.lat, e.latlng.lng); });

// ===================================================================== GPS
function setFollow(on) { follow = on; $('btnLocate').classList.toggle('on', on); syncWake(); }
async function syncWake() {
  const want = (follow || recording) && store.get('wake', true) && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); }
    if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* storage unavailable */ }
}
document.addEventListener('visibilitychange', syncWake);

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
  lastFix = { lat, lon, acc, t: pos.timestamp };
  const ll = [lat, lon];
  if (!meDot) {
    $('toast').style.display = 'none';
    meAcc = L.circle(ll, { radius: acc, color: '#2F8CFF', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    meDot = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2F8CFF', fillOpacity: 1, interactive: false }).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), 16));
  } else { meDot.setLatLng(ll); meAcc.setLatLng(ll).setRadius(acc); }
  if (follow) map.panTo(ll, { animate: true });
  if (recording) addTrackPoint(lat, lon, acc, pos.timestamp);
  updateNavLine();
  refreshCard();
  if (!refreshWind.fromGps) { refreshWind.fromGps = true; refreshWind(); }
}
function onErr(err) {
  const msg = { 1: 'Location permission denied. Enable it for this site in your phone settings.', 2: 'Location unavailable. Try moving to open sky.', 3: 'Location timed out. Still trying…' }[err.code] || err.message;
  toast(msg, 6000);
  if (err.code === 1) { setFollow(false); stopGps(); }
}
function startGps() {
  if (!('geolocation' in navigator)) { toast('This browser has no GPS/location support.'); return false; }
  if (!window.isSecureContext) { toast('GPS needs https. Open the app over https.', 6000); return false; }
  if (watchId == null) { watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }); toast('Finding your location…'); }
  return true;
}
function stopGps() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }
$('btnLocate').onclick = () => {
  clearSpot();
  if (watchId == null) { if (startGps()) setFollow(true); }
  else if (!follow) { setFollow(true); if (lastFix) map.setView([lastFix.lat, lastFix.lon], Math.max(map.getZoom(), 16)); refreshCard(); }
  else setFollow(false);
};
map.on('dragstart', () => follow && setFollow(false));
setInterval(refreshCard, 60000);

// ===================================================================== navigation
function navHtml() {
  if (!navTarget) return '';
  let txt = 'Waiting for GPS…';
  if (lastFix) {
    const d = distM(lastFix.lon, lastFix.lat, navTarget.lon, navTarget.lat), b = bearingDeg(lastFix.lon, lastFix.lat, navTarget.lon, navTarget.lat);
    txt = `<b>${yd(d)}</b> · ${Math.round(b)}° ${cardinal(b)}`;
  }
  return `<div class="nav"><span>➜ ${esc(navTarget.name)}: ${txt}</span><button class="btn small" id="navStop">End</button></div>`;
}
function startNav(t) {
  navTarget = t; closeSheets();
  if (watchId == null) startGps();
  updateNavLine(); refreshCard(); if (!lastFix) idleCard();
}
function stopNav() { navTarget = null; if (navLine) { map.removeLayer(navLine); navLine = null; } refreshCard(); if (!lastFix) idleCard(); }
function updateNavLine() {
  if (!navTarget || !lastFix) return;
  const pts = [[lastFix.lat, lastFix.lon], [navTarget.lat, navTarget.lon]];
  if (navLine) navLine.setLatLngs(pts); else navLine = L.polyline(pts, { pane: 'tracks', color: '#fff', weight: 3, dashArray: '8 8', interactive: false }).addTo(map);
}
document.addEventListener('click', (e) => { if (e.target.id === 'navStop') stopNav(); });

// ===================================================================== waypoints
const wpIcon = (w) => L.divIcon({ className: 'wp-icon', iconSize: [34, 34], iconAnchor: [17, 17],
  html: `<div class="wp"><span>${typeOf(w.type).e}</span></div><div class="wp-label">${esc(w.name)}</div>` });
function drawWaypoint(w) {
  let m = wpMarkers.get(w.id);
  if (!m) {
    m = L.marker([w.lat, w.lon], { icon: wpIcon(w), draggable: false, zIndexOffset: 500 }).addTo(map);
    m.on('click', (e) => { L.DomEvent.stop(e); openEditor(waypoints.find((x) => x.id === w.id)); });
    m.on('dragend', () => { if (editing) { const p = m.getLatLng(); editing.lat = p.lat; editing.lon = p.lng; editing.elev = null; updateEditorCoords(); } });
    wpMarkers.set(w.id, m);
  } else { m.setLatLng([w.lat, w.lon]).setIcon(wpIcon(w)); }
}
async function loadWaypoints() {
  waypoints = (await db.all('waypoints')).sort((a, b) => b.created - a.created);
  waypoints.forEach(drawWaypoint);
}
function newWaypoint(lat, lon) {
  const w = { id: uid(), lat, lon, type: store.get('lastType', 'stand'), name: '', notes: '', photos: [], created: Date.now(), elev: null, isNew: true };
  w.name = `${typeOf(w.type).n} ${waypoints.filter((x) => x.type === w.type).length + 1}`;
  openEditor(w);
}
$('btnAdd').onclick = () => {
  if (lastFix) newWaypoint(lastFix.lat, lastFix.lon);
  else { const c = map.getCenter(); newWaypoint(c.lat, c.lng); toast('No GPS fix. Waypoint placed at map center, so drag it into place.'); }
};

let editPhotos = [];
function openEditor(w) {
  if (editing && editing.id !== w.id) closeEditor(false);
  editing = { ...w };
  editPhotos = [...(w.photos || [])];
  if (w.isNew) drawWaypoint(editing);
  const m = wpMarkers.get(w.id); m.dragging?.enable();
  $('wpTypes').innerHTML = WP_TYPES.map(([id, e, n]) => `<button class="type ${id === editing.type ? 'sel' : ''}" data-type="${id}"><span>${e}</span>${n}</button>`).join('');
  $('wpName').value = editing.name; $('wpNotes').value = editing.notes || '';
  $('wpDelete').style.display = w.isNew ? 'none' : '';
  $('wpCreated').textContent = w.isNew ? '' : `Created ${fmtDate(w.created)}`;
  renderPhotos(); updateEditorCoords();
  openSheet('sheetWp', false);
  // keep the marker visible above the editor sheet
  const pt = map.project([w.lat, w.lon]).add([0, map.getSize().y * 0.28]);
  map.panTo(map.unproject(pt));
}
function updateEditorCoords() {
  const e = editing; if (!e) return;
  const dist = lastFix ? ` · ${yd(distM(lastFix.lon, lastFix.lat, e.lon, e.lat))} from you` : '';
  $('wpCoords').textContent = `${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}${e.elev != null ? ' · ' + ft(e.elev) : ''}${dist}`;
  if (e.elev == null) elevation(e.lat, e.lon).then((m) => { if (editing === e && m != null) { e.elev = m; updateEditorCoords(); } });
  const z = evaluate(e.lon, e.lat, null);
  $('wpZone').innerHTML = `<span class="dot" style="background:${COLORS[z.status] || COLORS.unmapped}"></span>${z.status === 'outside' ? 'Outside FCT preserves' : LABEL[z.status]}`;
}
function renderPhotos() {
  $('wpPhotos').innerHTML = editPhotos.map((b, i) => `<div class="ph"><img src="${URL.createObjectURL(b)}" alt=""><button data-delphoto="${i}">✕</button></div>`).join('');
}
$('wpTypes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]'); if (!b) return;
  const old = typeOf(editing.type).n, auto = new RegExp(`^${old.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\d+$`).test($('wpName').value);
  editing.type = b.dataset.type;
  if (auto || !$('wpName').value) $('wpName').value = `${typeOf(editing.type).n} ${waypoints.filter((x) => x.type === editing.type).length + 1}`;
  document.querySelectorAll('#wpTypes .type').forEach((t) => t.classList.toggle('sel', t === b));
  wpMarkers.get(editing.id)?.setIcon(wpIcon({ ...editing, name: $('wpName').value }));
});
$('wpPhotos').addEventListener('click', (e) => { const i = e.target.dataset.delphoto; if (i != null) { editPhotos.splice(+i, 1); renderPhotos(); } });
$('wpPhotoInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) editPhotos.push(await shrinkImage(f));
  e.target.value = ''; renderPhotos();
});
async function shrinkImage(file, max = 1600) {
  try {
    const img = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } catch { return file; }
}
$('wpSave').onclick = async () => {
  const w = { ...editing, name: $('wpName').value.trim() || typeOf(editing.type).n, notes: $('wpNotes').value.trim(), photos: editPhotos, updated: Date.now() };
  delete w.isNew;
  await db.put('waypoints', w);
  store.set('lastType', w.type);
  const i = waypoints.findIndex((x) => x.id === w.id);
  if (i >= 0) waypoints[i] = w; else waypoints.unshift(w);
  drawWaypoint(w);
  editing = null; wpMarkers.get(w.id).dragging?.disable();
  closeSheets(); toast('Waypoint saved');
};
$('wpShare').onclick = () => { const e = editing; shareWaypoints([{ ...e, name: $('wpName').value || typeOf(e.type).n, notes: $('wpNotes').value }], `${typeOf(e.type).e} ${$('wpName').value}`); };
$('wpNav').onclick = () => { const e = editing; $('wpSave').onclick().then(() => startNav({ lat: e.lat, lon: e.lon, name: $('wpName').value || 'Waypoint' })); };
$('wpDelete').onclick = async () => {
  if (!confirm(`Delete "${editing.name}"?`)) return;
  await db.del('waypoints', editing.id);
  waypoints = waypoints.filter((x) => x.id !== editing.id);
  map.removeLayer(wpMarkers.get(editing.id)); wpMarkers.delete(editing.id);
  editing = null; closeSheets(); toast('Waypoint deleted');
};
function closeEditor(save) {
  if (!editing) return;
  const e = editing; editing = null;
  const m = wpMarkers.get(e.id);
  if (e.isNew && !save) { if (m) map.removeLayer(m); wpMarkers.delete(e.id); return; }
  const orig = waypoints.find((x) => x.id === e.id);
  if (m && orig) { m.dragging?.disable(); m.setLatLng([orig.lat, orig.lon]).setIcon(wpIcon(orig)); }
}

// ===================================================================== tracks
const trackDist = (pts) => pts.reduce((s, p, i) => (i ? s + distM(pts[i - 1][1], pts[i - 1][0], p[1], p[0]) : 0), 0);
function drawTrack(t) {
  trackLayers.get(t.id)?.remove();
  const l = L.polyline(t.points.map((p) => [p[0], p[1]]), { pane: 'tracks', color: '#FF5BBD', weight: 3.5, opacity: 0.9 })
    .bindTooltip(`${esc(t.name)} · ${yd(trackDist(t.points))}`, { sticky: true }).addTo(map);
  trackLayers.set(t.id, l);
}
async function loadTracks() {
  tracks = (await db.all('tracks')).filter((t) => !t.active).sort((a, b) => b.created - a.created);
  tracks.forEach(drawTrack);
  const active = (await db.all('tracks')).find((t) => t.active);
  if (active && confirm(`Resume recording track "${active.name}"?`)) { recording = active; startRecording(true); }
  else if (active) { active.active = false; await db.put('tracks', active); tracks.unshift(active); drawTrack(active); }
}
function recHtml() {
  if (!recording) return '';
  const mins = Math.round((Date.now() - recording.created) / 60000);
  return `<div class="nav rec"><span>● Recording: ${yd(trackDist(recording.points))} · ${mins} min</span></div>`;
}
function startRecording(resume = false) {
  if (!startGps()) return;
  if (!resume) recording = { id: uid(), name: `Track ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm(new Date())}`, points: [], created: Date.now(), active: true };
  recLine = L.polyline(recording.points.map((p) => [p[0], p[1]]), { pane: 'tracks', color: '#FF2D8A', weight: 4 }).addTo(map);
  $('btnRec').classList.add('rec-on'); syncWake();
  toast(resume ? 'Track recording resumed' : 'Recording track. Keep the app open with the screen on for best results.', 5000);
  refreshCard();
}
let unsaved = 0;
function addTrackPoint(lat, lon, acc, t) {
  if (acc > 35) return;
  const last = recording.points[recording.points.length - 1];
  if (last && distM(last[1], last[0], lon, lat) < 5) return;
  recording.points.push([+lat.toFixed(6), +lon.toFixed(6), t]);
  recLine.addLatLng([lat, lon]);
  if (++unsaved >= 5) { unsaved = 0; db.put('tracks', recording); }
}
async function stopRecording() {
  const r = recording; recording = null; map.removeLayer(recLine); recLine = null;
  $('btnRec').classList.remove('rec-on'); syncWake();
  if (r.points.length < 2) { await db.del('tracks', r.id); toast('Track discarded (too short)'); refreshCard(); return; }
  const name = prompt('Name this track', r.name);
  r.name = (name || r.name).trim(); r.active = false;
  await db.put('tracks', r); tracks.unshift(r); drawTrack(r);
  toast(`Saved ${r.name} (${yd(trackDist(r.points))})`); refreshCard();
}
$('btnRec').onclick = () => (recording ? stopRecording() : startRecording());

// ===================================================================== list sheet
let listTab = 'wp';
function renderList() {
  const ref = lastFix ? { lat: lastFix.lat, lon: lastFix.lon, label: 'from you' } : { lat: map.getCenter().lat, lon: map.getCenter().lng, label: 'from map center' };
  $('tabWp').classList.toggle('sel', listTab === 'wp'); $('tabTrk').classList.toggle('sel', listTab === 'trk');
  if (listTab === 'wp') {
    const rows = waypoints.map((w) => ({ w, d: distM(ref.lon, ref.lat, w.lon, w.lat), b: bearingDeg(ref.lon, ref.lat, w.lon, w.lat) })).sort((a, b) => a.d - b.d);
    $('listBody').innerHTML = rows.length ? rows.map(({ w, d, b }) =>
      `<div class="li" data-wp="${w.id}"><span class="ico">${typeOf(w.type).e}</span><span class="grow"><b>${esc(w.name)}</b><small>${typeOf(w.type).n} · ${yd(d)} ${cardinal(b)} ${ref.label}${w.notes ? ' · ' + esc(w.notes.slice(0, 40)) : ''}</small></span>` +
      `<button class="btn small" data-navwp="${w.id}">Go</button></div>`).join('')
      : '<p class="muted">No waypoints yet. Long-press the map or tap ＋ to add one.</p>';
  } else {
    $('listBody').innerHTML = tracks.length ? tracks.map((t) =>
      `<div class="li" data-trk="${t.id}"><span class="ico">〰️</span><span class="grow"><b>${esc(t.name)}</b><small>${yd(trackDist(t.points))} · ${fmtDate(t.created)}</small></span>` +
      `<button class="btn small" data-deltrk="${t.id}">Delete</button></div>`).join('')
      : '<p class="muted">No tracks yet. Tap ● to record your walk in.</p>';
  }
}
$('tabWp').onclick = () => { listTab = 'wp'; renderList(); };
$('tabTrk').onclick = () => { listTab = 'trk'; renderList(); };
$('listBody').addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-navwp]'), del = e.target.closest('[data-deltrk]');
  if (nav) { const w = waypoints.find((x) => x.id === nav.dataset.navwp); startNav({ lat: w.lat, lon: w.lon, name: w.name }); return; }
  if (del) {
    const t = tracks.find((x) => x.id === del.dataset.deltrk);
    if (confirm(`Delete track "${t.name}"?`)) { await db.del('tracks', t.id); tracks = tracks.filter((x) => x !== t); trackLayers.get(t.id)?.remove(); trackLayers.delete(t.id); renderList(); }
    return;
  }
  const wp = e.target.closest('[data-wp]'), trk = e.target.closest('[data-trk]');
  if (wp) { const w = waypoints.find((x) => x.id === wp.dataset.wp); map.setView([w.lat, w.lon], Math.max(map.getZoom(), 16)); openEditor(w); }
  if (trk) { closeSheets(); map.fitBounds(trackLayers.get(trk.dataset.trk).getBounds(), { padding: [40, 40] }); }
});
$('btnExport').onclick = () => {
  if (!waypoints.length && !tracks.length) return toast('Nothing to export yet');
  shareOrDownload(`hunt-waypoints-${new Date().toISOString().slice(0, 10)}.gpx`, toGPX(waypoints, tracks));
};
$('btnImport').onclick = () => $('importInput').click();
$('btnShareAll').onclick = () => { if (!waypoints.length) return toast('No waypoints to share yet'); shareWaypoints(waypoints, `${waypoints.length} hunting spots`); };
$('btnPaste').onclick = async () => {
  let t = '';
  try { t = await navigator.clipboard.readText(); } catch { /* permission */ }
  if (!/[#&]s=/.test(t)) t = prompt('Paste the link your buddy sent you:') || '';
  handleShared(t, true);
};
$('importInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const { waypoints: ws, tracks: ts } = parseGeoFile(await f.text());
    const known = new Set(WP_TYPES.map((t) => t[0]));
    for (const w of ws) {
      const rec = { ...w, id: uid(), type: known.has(w.type) ? w.type : guessType(w.name + ' ' + w.type), photos: [] };
      await db.put('waypoints', rec); waypoints.unshift(rec); drawWaypoint(rec);
    }
    for (const t of ts) { const rec = { ...t, id: uid(), created: t.points[0]?.[2] || Date.now(), active: false }; await db.put('tracks', rec); tracks.unshift(rec); drawTrack(rec); }
    toast(`Imported ${ws.length} waypoints, ${ts.length} tracks`); renderList();
  } catch (err) { toast(err.message, 6000); }
});
function guessType(s) {
  s = s.toLowerCase();
  const rules = [['stand', /stand|ladder|climb/], ['blind', /blind/], ['camera', /cam/], ['scrape', /scrape/], ['rub', /rub/], ['bedding', /bed/],
    ['food', /oak|acorn|food|apple|mast|plot/], ['water', /water|creek|brook|spring|pond/], ['parking', /park|truck|car/], ['sighting', /deer|buck|doe|sight/],
    ['blood', /blood/], ['harvest', /harvest|kill|shot/], ['trail', /trail|cross|funnel/]];
  return (rules.find(([, r]) => r.test(s)) || ['note'])[0];
}

// ===================================================================== offline sheet
let dlAbort = null;

// ---- one-tap "All Freeport preserves" pack
let packLevel = store.get('packLevel', 'high'), packAbort = null, packPlanTimer = null, packPlan = null;
const packFeats = feats.filter((f) => f.properties.status !== 'unmapped');
const packDefs = () => [...BASES, ...OVERLAYS].filter((d) => PACK_LEVELS.high.caps[d.id] != null);
const packSelected = () => { const off = new Set(store.get('packOff', [])); return packDefs().filter((d) => !off.has(d.id)); };
function renderPack() {
  document.querySelectorAll('#packLevel button').forEach((b) => b.classList.toggle('sel', b.dataset.level === packLevel));
  const off = new Set(store.get('packOff', []));
  $('packLayers').innerHTML = packDefs().map((d) =>
    `<label class="opt compact"><input type="checkbox" data-pk="${d.id}" ${off.has(d.id) ? '' : 'checked'}><span><b>${d.name}</b></span></label>`).join('');
  const rec = listAreas().find((a) => a.id === PACK_ID);
  $('packStatus').textContent = rec ? `✓ Downloaded ${fmtDate(rec.date)}: ${PACK_LEVELS[rec.level]?.label.replace(' (recommended)', '') || ''}, ${rec.mb} MB${rec.failed ? `, ${rec.failed} tiles missing (tap Download again)` : ''}` : '';
  $('packStart').textContent = rec ? 'Update / resume download' : 'Download all preserves';
  schedulePackPlan();
}
function schedulePackPlan() {
  $('packEstimate').textContent = 'Calculating…'; $('packStart').disabled = true;
  clearTimeout(packPlanTimer);
  packPlanTimer = setTimeout(() => {
    packPlan = planPreserves(packSelected(), packFeats, packLevel);
    $('packEstimate').textContent = `${packPlan.urls.length.toLocaleString()} tiles · about ${packPlan.estMB >= 1024 ? (packPlan.estMB / 1024).toFixed(1) + ' GB' : packPlan.estMB + ' MB'}. ` +
      'Already-saved tiles are skipped, so you can pause and resume.';
    $('packStart').disabled = !packPlan.urls.length || !!packAbort;
  }, 30);
}
$('packLevel').addEventListener('click', (e) => { const b = e.target.closest('[data-level]'); if (!b || packAbort) return; packLevel = b.dataset.level; store.set('packLevel', packLevel); renderPack(); });
$('packLayers').addEventListener('change', () => {
  store.set('packOff', [...document.querySelectorAll('[data-pk]')].filter((i) => !i.checked).map((i) => i.dataset.pk));
  schedulePackPlan();
});
$('packStart').onclick = async () => {
  if (!packPlan) return;
  if (!navigator.onLine) return toast('No connection. Connect to Wi-Fi first.');
  const plan = packPlan, samples = [];
  packAbort = new AbortController();
  let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  $('packStart').style.display = 'none'; $('packCancel').style.display = ''; $('packProg').style.display = '';
  const r = await download(plan.urls, (d, t, f, bytes) => {
    $('packBar').style.width = `${(100 * d) / t}%`;
    const now = Date.now(); samples.push([now, d]); while (samples.length > 2 && now - samples[0][0] > 30000) samples.shift();
    const [t1, d1] = samples[0], rate = (d - d1) / Math.max(1, (now - t1) / 1000), eta = Math.max(1, Math.round((t - d) / Math.max(rate, 0.1) / 60));
    $('packProgTxt').textContent = `${d.toLocaleString()} / ${t.toLocaleString()} · ${(bytes / 1048576).toFixed(0)} MB · ~${eta} min left${f ? ` · ${f} failed` : ''}`;
  }, packAbort.signal).catch((err) => { toast(err.message, 6000); return null; });
  try { await lock?.release(); } catch { /* ignore */ }
  const paused = packAbort.signal.aborted; packAbort = null;
  $('packStart').style.display = ''; $('packCancel').style.display = 'none'; $('packProg').style.display = 'none'; $('packBar').style.width = '0';
  if (r && !paused) {
    const prev = listAreas().find((a) => a.id === PACK_ID);
    removeAreaRecord(PACK_ID);
    const bb = packFeats.reduce((a, f) => { const b = f.bbox; return [Math.min(a[0], b[1]), Math.min(a[1], b[0]), Math.max(a[2], b[3]), Math.max(a[3], b[2])]; }, [90, 180, -90, -180]);
    recordArea({ id: PACK_ID, name: 'All Freeport preserves', tiles: plan.urls.length, zMax: Math.max(...Object.values(PACK_LEVELS[packLevel].caps)),
      level: packLevel, mb: Math.round((r.bytes / 1048576) + (prev && r.bytes < 1048576 * 5 ? prev.mb : 0)), failed: r.failed, date: Date.now(), bounds: bb });
    toast(r.failed ? `Done, but ${r.failed} tiles failed. Tap Download again to retry them.` : 'All preserves saved for offline use ✓', 6000);
  } else if (paused) toast('Paused. Tap Download to resume. Saved tiles are kept.');
  renderOffline();
};
$('packCancel').onclick = () => packAbort?.abort();

function renderOffline() {
  renderPack();
  const b = map.getBounds();
  const w = distM(b.getWest(), b.getCenter().lat, b.getEast(), b.getCenter().lat), h = distM(b.getWest(), b.getSouth(), b.getWest(), b.getNorth());
  const sqmi = (w * h) / 2.59e6;
  const defaults = new Set([base, ...activeOverlays]);
  $('offArea').textContent = `Current view: about ${sqmi < 0.1 ? sqmi.toFixed(2) : sqmi.toFixed(1)} sq mi`;
  $('offLayers').innerHTML = [...BASES, ...OVERLAYS].map((d) =>
    `<label class="opt compact"><input type="checkbox" data-dl="${d.id}" ${defaults.has(d.id) ? 'checked' : ''}><span><b>${d.name}</b></span></label>`).join('');
  updateEstimate();
  const areas = listAreas();
  $('offAreas').innerHTML = areas.length ? areas.map((a) =>
    `<div class="li"><span class="ico">🗺️</span><span class="grow"><b>${esc(a.name)}</b><small>${a.tiles} tiles · z${a.zMax} · ${fmtDate(a.date)}</small></span>` +
    `<button class="btn small" data-showarea="${a.id}">Show</button><button class="btn small" data-delarea="${a.id}">✕</button></div>`).join('')
    : '<p class="muted">No saved areas yet.</p>';
  storageText().then((t) => ($('offStorage').textContent = t));
}
function selectedDlDefs() {
  const ids = [...document.querySelectorAll('[data-dl]:checked')].map((i) => i.dataset.dl);
  return [...BASES, ...OVERLAYS].filter((d) => ids.includes(d.id));
}
function updateEstimate() {
  const zMax = +$('offZoom').value, zMin = Math.max(10, map.getZoom() - 3);
  const n = planDownload(selectedDlDefs(), map.getBounds(), zMin, zMax).length;
  $('offEstimate').textContent = `${n.toLocaleString()} tiles (~${Math.max(1, Math.round(n * 0.025))} MB)` + (n > 8000 ? '. That\'s a lot, so zoom in or lower the detail.' : '');
  $('offStart').disabled = n === 0 || n > 15000;
  return { zMin, zMax, n };
}
$('offZoom').onchange = updateEstimate;
$('offLayers').addEventListener('change', updateEstimate);
$('offStart').onclick = async () => {
  const { zMin, zMax } = updateEstimate();
  const defs = selectedDlDefs(), bounds = map.getBounds(), urls = planDownload(defs, bounds, zMin, zMax);
  const name = $('offName').value.trim() || `Area ${new Date().toLocaleDateString()}`;
  dlAbort = new AbortController();
  $('offStart').style.display = 'none'; $('offCancel').style.display = ''; $('offProg').style.display = '';
  try {
    const r = await download(urls, (d, t, f) => { $('offBar').style.width = `${(100 * d) / t}%`; $('offProgTxt').textContent = `${d} / ${t}${f ? ` · ${f} failed` : ''}`; }, dlAbort.signal);
    if (!dlAbort.signal.aborted) {
      recordArea({ id: uid(), name, tiles: urls.length, zMax, date: Date.now(), layers: defs.map((d) => d.id),
        bounds: [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()] });
      toast(r.failed ? `Saved with ${r.failed} tiles missing. Try again with better signal.` : `"${name}" saved for offline use`, 5000);
    }
  } catch (err) { toast(err.message, 6000); }
  $('offStart').style.display = ''; $('offCancel').style.display = 'none'; $('offProg').style.display = 'none'; $('offBar').style.width = '0';
  renderOffline();
};
$('offCancel').onclick = () => dlAbort?.abort();
$('offClear').onclick = async () => { if (confirm('Delete ALL downloaded offline maps?')) { await clearAll(); renderOffline(); toast('Offline maps cleared'); } };
let areaRect = null;
$('offAreas').addEventListener('click', (e) => {
  const s = e.target.closest('[data-showarea]'), d = e.target.closest('[data-delarea]');
  const a = listAreas().find((x) => x.id === (s || d)?.dataset[s ? 'showarea' : 'delarea']); if (!a) return;
  if (s) {
    closeSheets(); areaRect?.remove();
    areaRect = L.rectangle([[a.bounds[0], a.bounds[1]], [a.bounds[2], a.bounds[3]]], { color: '#fff', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
    map.fitBounds(areaRect.getBounds()); setTimeout(() => areaRect?.remove(), 8000);
  } else { removeAreaRecord(a.id); renderOffline(); toast('Removed from list (tiles stay cached until "Clear all")'); }
});

// ===================================================================== wind chip + morning hunt plan
async function refreshWind() {
  const p = lastFix || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  try {
    const w = await getWind(p.lat, p.lon);
    $('windChip').innerHTML = `${windArrow(w.dir)} ${w.card} ${Math.round(w.speed)}<small>mph</small><span class="wtemp"> · ${Math.round(w.temp)}°</span>`;
    $('windChip').style.display = '';
  } catch { $('windChip').innerHTML = '🎯 <small>Plan</small>'; $('windChip').style.display = ''; }
}
$('windChip').onclick = () => { openSheet('sheetWind'); renderPlan(); };
refreshWind(); setInterval(refreshWind, 15 * 60000);

const huntParcels = feats.filter((f) => f.properties.status === 'firearm' || f.properties.status === 'bow');
const planCenter = (() => { const b = huntParcels.reduce((a, f) => { const x = f.bbox || bboxOf(f.geometry); return [Math.min(a[0], x[0]), Math.min(a[1], x[1]), Math.max(a[2], x[2]), Math.max(a[3], x[3])]; }, [180, 90, -180, -90]); return { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 }; })();
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
let planDay = 0, planOverride = null, planPrepared = null, planHeat = null, planPins = null, planWindNow = null, lastPlan = null;

function dayStart(offset) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d; }
function morningWindow(offset) {
  const d = dayStart(offset), st = sunTimes(new Date(d.getTime() + 12 * 3600e3), planCenter.lat, planCenter.lon);
  return { legal: new Date(st.rise - 30 * 60000), rise: st.rise, end: new Date(+st.rise + 3 * 3600e3), date: d };
}
async function renderPlan() {
  // day chips (Sundays flagged: no hunting in Maine)
  $('planDays').innerHTML = [...Array(7)].map((_, i) => {
    const d = dayStart(i), sun = d.getDay() === 0;
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short' });
    return `<button class="chip ${i === planDay ? 'sel' : ''}" data-day="${i}">${label}<small>${sun ? 'Sun · no hunting' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</small></button>`;
  }).join('');
  $('planCompass').innerHTML = DIRS.map((c, i) => `<button data-dir="${i * 45}" class="${planOverride && planOverride.dir === i * 45 ? 'sel' : ''}">${windArrow(i * 45, 18)}<b>${c}</b></button>`).join('');
  document.querySelectorAll('#planSpeed button').forEach((b) => b.classList.toggle('sel', !!planOverride && +b.dataset.mph === planOverride.mph));
  const win = morningWindow(planDay);
  const sunday = win.date.getDay() === 0;
  let hours = [], sum = null, err = '';
  try {
    const fc = await getForecast(planCenter.lat, planCenter.lon);
    hours = fc.filter((h) => +h.time >= +win.legal - 3600e3 && +h.time <= +win.end);
    sum = summarizeWind(hours.filter((h) => +h.time >= +win.legal - 1800e3));
  } catch { err = navigator.onLine ? 'Forecast unavailable right now.' : 'No signal: forecast unavailable. Pick the wind below.'; }
  planWindNow = planOverride || (sum ? { dir: sum.dir, mph: sum.mph } : null);
  const thermalNote = 'At first light, cool air drains <b>downhill</b> and carries your scent down slopes and into creek bottoms. As the sun warms the ground (about 1–2 h after sunrise) it flips and rises. Wind over ~8 mph overrides thermals.';
  $('planWind').innerHTML = `<div class="plan-sum">
      ${sunday ? '<div class="alert stop" style="margin:0">Sunday: no hunting in Maine.</div>' : ''}
      <div class="meta">Legal light <b>${hm(win.legal)}</b> · sunrise <b>${hm(win.rise)}</b> · plan window to ${hm(win.end)}</div>
      ${sum ? `<div class="big">${windArrow(sum.dir, 42)}<div><b>${sum.card} ${Math.round(sum.lo)}–${Math.round(sum.hi)} mph</b>
        <small>${sum.steady ? 'Steady direction' : `Shifting up to ${Math.round(sum.spread)}°: pick spots that work for both`} · gusts ${Math.round(sum.gust)} mph</small></div></div>` : `<div class="meta">${err}</div>`}
      ${planOverride ? `<div class="meta">Planning for your chosen wind: <b>${cardinal(planOverride.dir)} ~${planOverride.mph} mph</b> <a href="#" id="planClear">use forecast</a></div>` : ''}
      ${hours.length ? `<div class="hours">${hours.map((h) => `<div><small>${h.time.toLocaleTimeString([], { hour: 'numeric' })}</small>${windArrow(h.dir, 22)}<b>${cardinal(h.dir)}</b><small>${Math.round(h.speed)} mph</small><small>${Math.round(h.temp)}°${h.pop >= 30 ? ` · ${h.pop}%💧` : ''}</small></div>`).join('')}</div>` : ''}
      <div class="meta">${thermalNote}</div>
    </div>`;
  const clr = $('planClear'); if (clr) clr.onclick = (e) => { e.preventDefault(); planOverride = null; renderPlan(); };
  $('planGo').disabled = !planWindNow;
  $('planGo').textContent = planWindNow ? `🎯 Find best blind spots for a ${cardinal(planWindNow.dir)} wind` : '🎯 Pick a wind below first';
}
$('planDays').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (b) { planDay = +b.dataset.day; renderPlan(); } });
$('planCompass').addEventListener('click', (e) => { const b = e.target.closest('[data-dir]'); if (b) { planOverride = { dir: +b.dataset.dir, mph: planOverride?.mph ?? 7 }; renderPlan(); } });
$('planSpeed').addEventListener('click', (e) => { const b = e.target.closest('[data-mph]'); if (b) { planOverride = { dir: planOverride?.dir ?? planWindNow?.dir ?? 315, mph: +b.dataset.mph }; renderPlan(); } });

$('planGo').onclick = async () => {
  if (!planWindNow) return;
  $('planGo').disabled = true; $('planProg').style.display = ''; $('planResults').innerHTML = '';
  const prog = (f, t) => { $('planBar').style.width = `${Math.round(f * 100)}%`; $('planProgTxt').textContent = t; };
  try {
    if (!planPrepared) {
      prog(0, 'Reading LiDAR terrain and forest data…');
      const parcels = huntParcels.map((f) => ({ name: f.properties.name, status: f.properties.status, geometry: f.geometry, bbox: f.bbox || bboxOf(f.geometry) }));
      planPrepared = await planPrep(parcels, D.addresses, (f) => prog(f * 0.95, `Analyzing terrain… ${Math.round(f * 100)}%`));
      if (planPrepared.missing > planPrepared.tiles * 0.3) toast('Some terrain is missing offline. Download all preserves for full results.', 6000);
    }
    prog(0.97, 'Scoring spots for the wind…');
    const res = await planScore({ dir: planWindNow.dir, mph: planWindNow.mph }, 0.6);
    lastPlan = { ...res, wind: planWindNow };
    showPlanResults(res);
  } catch (e) { toast('Could not plan: ' + e.message, 6000); planPrepared = null; }
  $('planProg').style.display = 'none'; $('planGo').disabled = false;
};

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }
function showPlanResults({ spots, heat }) {
  drawHeat(heat); drawPins(spots);
  if (spots.length) map.fitBounds(L.latLngBounds(spots.map((sp) => [sp.lat, sp.lon])).pad(0.25), { maxZoom: 16, paddingBottomRight: [0, 120] });
  if (!spots.length) { $('planResults').innerHTML = '<p class="muted">No strong spots for this wind. Try another day or wind direction.</p>'; return; }
  $('planResults').innerHTML = `<h3>Best blind spots: ${cardinal(lastPlan.wind.dir)} wind</h3>` + spots.map((sp, i) => `
    <div class="spot">
      <div class="spot-top"><span class="spot-rank">${i + 1}</span><span class="grow"><b>${esc(sp.parcel)}${sp.status === 'bow' ? ' · bow only' : ''}</b>
        <small><span class="stars">${stars(sp.rating)}</span> · ${ft(sp.elev)}${lastFix ? ` · ${yd(distM(lastFix.lon, lastFix.lat, sp.lon, sp.lat))} from you` : ''}</small></span></div>
      <div class="how"><span>Face <b>${sp.face}</b></span><span>Walk in from the <b>${sp.approach}</b></span></div>
      <ul>${sp.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}${sp.warn.map((w) => `<li class="w">${esc(w)}</li>`).join('')}</ul>
      <div class="btnrow"><button class="btn small" data-pshow="${i}">Show</button><button class="btn small" data-pgo="${i}">Go</button><button class="btn small primary" data-psave="${i}">Save as blind</button></div>
    </div>`).join('') +
    '<label class="ov-row"><span class="grow"><b>Show heat map</b><small>Brighter = better for this wind</small></span><input type="checkbox" class="switch" id="planHeatToggle" checked></label>';
  $('planHeatToggle').onchange = (e) => { if (planHeat) (e.target.checked ? planHeat.addTo(map) : map.removeLayer(planHeat)); };
}
$('planResults').addEventListener('click', async (e) => {
  const sh = e.target.closest('[data-pshow]'), go = e.target.closest('[data-pgo]'), sv = e.target.closest('[data-psave]');
  const sp = lastPlan?.spots[+(sh || go || sv)?.dataset[sh ? 'pshow' : go ? 'pgo' : 'psave']];
  if (!sp) return;
  if (sh) { closeSheets(); map.setView([sp.lat, sp.lon], 17); showSpot(L.latLng(sp.lat, sp.lon)); }
  if (go) startNav({ lat: sp.lat, lon: sp.lon, name: `Blind: ${sp.parcel}` });
  if (sv) {
    const rec = { id: uid(), lat: sp.lat, lon: sp.lon, type: 'blind', name: `Blind ${cardinal(lastPlan.wind.dir)} wind · ${sp.parcel}`.slice(0, 60),
      notes: `${cardinal(lastPlan.wind.dir)} wind. Face ${sp.face}, walk in from the ${sp.approach}.\n` + sp.reasons.join('\n') + (sp.warn.length ? '\n⚠ ' + sp.warn.join('\n⚠ ') : ''),
      photos: [], created: Date.now(), elev: sp.elev };
    await db.put('waypoints', rec); waypoints.unshift(rec); drawWaypoint(rec); toast('Saved as a blind waypoint');
  }
});

function drawPins(spots) {
  planPins?.remove();
  planPins = L.layerGroup(spots.map((sp, i) => L.marker([sp.lat, sp.lon], { zIndexOffset: 800,
    icon: L.divIcon({ className: 'blind-pin', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div>${i + 1}</div>` }) })
    .on('click', (e) => { L.DomEvent.stop(e); openSheet('sheetWind'); document.querySelectorAll('.spot')[i]?.scrollIntoView({ behavior: 'smooth' }); }))).addTo(map);
}
function drawHeat(heat) {
  planHeat?.remove(); planHeat = null;
  const n = heat.length / 3; if (!n) return;
  // group cells by parcel-sized clusters: one image per 128-cell block keeps Mercator distortion negligible
  const blocks = new Map();
  for (let i = 0; i < n; i++) {
    const X = heat[i * 3], Y = heat[i * 3 + 1], v = heat[i * 3 + 2], k = `${X >> 7}/${Y >> 7}`;
    let b = blocks.get(k); if (!b) blocks.set(k, (b = []));
    b.push(X, Y, v);
  }
  const layers = [];
  const toLL = (X, Y) => { const nn = 2 ** 22; return [(Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / nn))) * 180) / Math.PI, (X / nn) * 360 - 180]; };
  for (const [k, b] of blocks) {
    const [bx, by] = k.split('/').map(Number), X0 = bx << 7, Y0 = by << 7;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d'), img = ctx.createImageData(128, 128);
    for (let i = 0; i < b.length; i += 3) {
      const v = b[i + 2]; if (v < 0.35) continue;
      const t = (v - 0.35) / 0.65, o = ((b[i + 1] - Y0) * 128 + (b[i] - X0)) * 4;
      img.data[o] = 255; img.data[o + 1] = Math.round(220 - 170 * t); img.data[o + 2] = Math.round(60 - 40 * t); img.data[o + 3] = Math.round(70 + 150 * t);
    }
    ctx.putImageData(img, 0, 0);
    layers.push(L.imageOverlay(c.toDataURL(), [toLL(X0, Y0 + 128), toLL(X0 + 128, Y0)], { pane: 'terrain', opacity: 0.85, interactive: false, className: 'heat-img' }));
  }
  planHeat = L.layerGroup(layers).addTo(map);
}

// ===================================================================== sharing
async function shareWaypoints(list, title) {
  const url = await waypointsLink(list);
  const names = list.slice(0, 3).map((w) => `${typeOf(w.type).e} ${w.name}`).join(', ') + (list.length > 3 ? ` +${list.length - 3} more` : '');
  const r = await shareUrl({ title: title || 'Hunt Map spots', text: `${names}: open in Freeport Hunt Map`, url });
  if (r === 'copied') toast('Link copied. Paste it in a text to your buddy.');
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#shareMe') && lastFix) shareWaypoints([{ name: `My location ${hm(new Date())}`, type: 'note', lat: lastFix.lat, lon: lastFix.lon, notes: `GPS ±${yd(lastFix.acc)}` }], 'My location');
});
let incoming = null;
async function handleShared(text, fromPaste = false) {
  let list = null;
  try { list = await parseShared(text); } catch { /* bad link */ }
  if (!list || !list.length) { if (fromPaste) toast("That doesn't look like a Hunt Map share link"); return; }
  incoming = list;
  const ref = lastFix || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  $('importBody').innerHTML = list.map((w) => `<div class="li"><span class="ico">${typeOf(w.type).e}</span><span class="grow"><b>${esc(w.name)}</b>` +
    `<small>${typeOf(w.type).n} · ${yd(distM(ref.lon, ref.lat, w.lon, w.lat))} ${cardinal(bearingDeg(ref.lon, ref.lat, w.lon, w.lat))}${w.notes ? ' · ' + esc(w.notes) : ''}</small></span></div>`).join('');
  $('importTitle').textContent = list.length === 1 ? 'A buddy shared a spot' : `A buddy shared ${list.length} spots`;
  $('importNav').style.display = list.length === 1 ? '' : 'none';
  $('importSafari').style.display = !isStandalone && /iphone|ipad|ipod/i.test(navigator.userAgent) ? '' : 'none';
  const b = L.latLngBounds(list.map((w) => [w.lat, w.lon]));
  map.fitBounds(b.pad(0.4), { maxZoom: 16 });
  openSheet('sheetImport');
  history.replaceState(null, '', location.pathname + location.search);
}
$('importSave').onclick = async () => {
  for (const w of incoming) {
    const rec = { id: uid(), lat: w.lat, lon: w.lon, type: WP[w.type] ? w.type : 'note', name: w.name || 'Shared spot', notes: w.notes || '', photos: [], created: Date.now(), elev: null };
    await db.put('waypoints', rec); waypoints.unshift(rec); drawWaypoint(rec);
  }
  toast(`Saved ${incoming.length} waypoint${incoming.length > 1 ? 's' : ''}`); closeSheets();
};
$('importNav').onclick = () => { const w = incoming[0]; startNav({ lat: w.lat, lon: w.lon, name: w.name }); };
$('importCopy').onclick = async () => { await copyText(await waypointsLink(incoming)); toast('Copied. In the Hunt Map app: My spots → Paste link.'); };
window.addEventListener('hashchange', () => handleShared(location.hash));

// share the app itself
function renderShareApp() {
  $('shareQr').innerHTML = qrSvg(APP_URL);
  $('shareUrl').textContent = APP_URL.replace(/^https:\/\//, '');
}
$('btnShareApp').onclick = () => { renderShareApp(); openSheet('sheetShare'); };
$('shareNative').onclick = async () => { if ((await shareUrl({ title: 'Freeport Hunt Map', text: 'Hunting map for Freeport: legal zones, LiDAR terrain, waypoints, offline GPS', url: APP_URL })) === 'copied') toast('Link copied'); };
$('shareCopy').onclick = async () => { await copyText(APP_URL); toast('Link copied'); };
$('shareSpots').onclick = () => { if (!waypoints.length) return toast('No waypoints yet'); shareWaypoints(waypoints, `${waypoints.length} hunting spots`); };

// ===================================================================== install / offline / SW
let deferredInstall = null;
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('installBox').style.display = ''; });
$('btnInstall').onclick = async () => {
  if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBox').style.display = 'none'; }
};
if (!isStandalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) { $('iosInstall').style.display = ''; $('installBox').style.display = ''; $('btnInstall').style.display = 'none'; }
const netBanner = () => $('offlineBanner').style.display = navigator.onLine ? 'none' : '';
window.addEventListener('online', netBanner); window.addEventListener('offline', netBanner); netBanner();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (!store.get('seenInfo2', false)) { openSheet('sheetInfo'); store.set('seenInfo2', true); }

// ===================================================================== go
updLabels(); idleCard();
loadWaypoints().then(() => { if (/[#&]s=/.test(location.hash)) handleShared(location.hash); })
  .catch((e) => toast('Could not load waypoints: ' + e.message));
loadTracks().catch(() => {});
window.__hunt = { map, evaluate };
