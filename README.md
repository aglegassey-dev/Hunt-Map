# Freeport Hunt Map

A standalone hunting map app for Freeport, Maine: legal hunting zones on Freeport Conservation Trust land,
onX-style terrain and food layers, waypoints, tracks and live GPS. It works offline.

It's a static installable web app (PWA): no build step, no server, no accounts. Open it on your phone and
**Add to Home Screen** (iPhone: Safari → Share → Add to Home Screen; Android: Chrome → Install app).

## Features

- **Legal zones:** FCT preserves colored by hunting status (firearm & bow / bow only / no hunting). Live GPS
  status shows the distance to the boundary and warns when GPS accuracy is larger than that distance. Also
  includes about 100-yard firearm safety circles around E911 address points, a Sunday warning and calculated
  legal shooting hours.
- **Terrain:** 1 m LiDAR terrain base and hillshade (Maine GeoLibrary), slope-angle shading
  (10–15°, 15–25°, 25–35°, 35°+), USGS contours with labels, USGS streams.
- **Food / hardwoods:** Maine leaf-off aerial imagery (hardwoods look gray/brown, conifers dark green),
  NLCD 2021 hardwood forest (30 m), USFS oak forest groups (250 m).
- **Presets:** Terrain scout · Terrain on satellite · Food / hardwoods · Plain satellite.
- **Waypoints:** long-press or ＋ to add one (stand, blind, camera, scrape, rub, bedding, oaks, water, …)
  with notes and photos. Drag to move, and tap **Go** to navigate with live distance and bearing.
- **Tracks:** ● records your walk.
- **GPX/KML import and GPX export:** compatible with onX, Garmin and Gaia.
- **Offline maps:** one tap on **Download all preserves** saves every layer for every preserve on the
  FCT hunting map plus ~300 yd around it. *High detail* is ~11k tiles / ~360 MB; *Maximum* is ~26k
  tiles / ~680 MB. You can pause and resume, and already-saved tiles are skipped. You can also download
  any area on screen. When you zoom past the saved detail with no signal, the map sharpens the nearest
  saved tile instead of going blank. Zones, waypoints and GPS work with no signal.
- **Wind:** current conditions and hourly forecast with scent-direction arrows (Open-Meteo).

Waypoints, photos and tracks are stored on the device (IndexedDB). Export a GPX as a backup.

## Deploy

Any static host with HTTPS works (GPS requires HTTPS). On Netlify, create a new site from this repo
with **Base directory** `huntmap` and no build command. `netlify.toml` sets the headers.

Local test: `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

## Code layout

| File | Purpose |
| --- | --- |
| `index.html`, `app.css` | UI shell and styles |
| `js/main.js` | App wiring: map, zones, GPS, waypoints, tracks, sheets |
| `js/layers.js` | Base maps and terrain/forest overlays (URL functions shared with offline download) |
| `js/offline.js` | Offline downloads into Cache Storage (`hunt-tiles`): preserves pack (`PACK_LEVELS` sets per-layer max zoom) and on-screen areas |
| `js/geo.js`, `js/db.js`, `js/gpx.js`, `js/weather.js` | Geometry/sun math, IndexedDB, GPX/KML, wind |
| `sw.js` | Service worker: offline app shell + cache-first tiles. **Bump `VERSION` when shell files change.** |
| `data.js` | Generated zone data (do not edit by hand) |
| `vendor/leaflet` | Leaflet 1.9.4 |

## Updating zone data

Hunting status for each parcel is set in `STATUS` in `scripts/build-data.py` (transcribed from FCT's
"Hunting on Freeport Conservation Trust Preserves" map). Boundaries and address points are downloaded
from Maine GeoLibrary:

```bash
python3 scripts/build-data.py   # writes data.js
```

## Disclaimer

This is a guide, not legal advice. Boundaries and GPS can be off by tens of feet. Posted signs, FCT rules
(207-865-3985) and Maine IF&W regulations take priority.
