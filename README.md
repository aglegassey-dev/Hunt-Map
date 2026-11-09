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
- **Base maps:** Satellite (Esri), Leaf-off aerial (Maine GeoLibrary: hardwoods gray, conifers green),
  USGS Topo, and LiDAR terrain.
- **Terrain computed on the phone from raw 1 m LiDAR** (Maine statewide DEM, decoded in a Web Worker):
  - shaded relief (base map or blended over any base)
  - contours that auto-adjust 2–50 ft by zoom, with labeled index lines
  - slope angle (8–15°, 15–25°, 25–35°, 35°+)
  - **terrain features:** auto-detected benches, ridges/spurs and draws/drainages
- **Food & cover:** LANDFIRE 2024 forest types (oak, pine-oak, northern hardwoods, mixed, conifer, swamp forest,
  marsh, fields, young growth), each toggleable, plus USFWS wetlands and USGS streams.
- **Tap any spot:** legal status, elevation, slope, the direction it faces, terrain feature and forest type.
  Works offline.
- **Presets:** Terrain scout · Stand finder · Food & cover · Clean satellite. Every overlay has an opacity slider.
- **Waypoints:** long-press or ＋ to add one (stand, blind, camera, scrape, rub, bedding, oaks, water, …)
  with notes and photos. Drag to move, and tap **Go** to navigate with live distance and bearing.
- **Tracks:** ● records your walk.
- **Share with buddies:** a QR code or link to the app. Text any waypoint, a tapped spot, your current location,
  or all your waypoints as a link. It opens in their app and offers to save. There's no server: the data is
  inside the link. GPX/KML import and export work with onX, Garmin and Gaia.
- **Offline maps:** one tap on **Download all preserves** saves every layer for every preserve plus ~300 yd
  around it. You can pause and resume. When you zoom past the saved detail offline, the map sharpens the
  nearest saved tile instead of going blank.
- **Wind:** current conditions and hourly forecast with scent-direction arrows (Open-Meteo).

Waypoints, photos and tracks are stored on the device (IndexedDB). Export a GPX as a backup.

## Deploy

**Live app:** https://aglegassey-dev.github.io/Hunt-Map/

Every push to `main` is published to GitHub Pages by `.github/workflows/pages.yml` (free, HTTPS,
no server). Installed copies update the next time they're opened with signal. Remember to bump
`VERSION` in `sw.js` when app files change. Any other static HTTPS host also works (`netlify.toml` included).

Local test: `python3 -m http.server 8000` in this folder, then open http://localhost:8000.

## Code layout

| File | Purpose |
| --- | --- |
| `index.html`, `app.css` | UI shell and styles |
| `js/main.js` | App wiring: map, zones, GPS, waypoints, tracks, sheets |
| `js/layers.js` | Layer catalogue: base maps, grouped overlays, presets, user layer settings |
| `js/terrain.js`, `js/terrain-worker.js` | On-device LiDAR terrain (relief, contours, slope, features), LANDFIRE forest rendering, point queries |
| `js/sources.js` | Raw data tile URLs (LiDAR LERC, LANDFIRE LERC) shared by map, worker and downloader |
| `js/evt.js` | Generated LANDFIRE code → forest category/name table |
| `js/share.js` | Share links (waypoints packed into the URL hash), QR code, native share |
| `js/offline.js` | Offline downloads into Cache Storage (`hunt-tiles`): preserves pack (`PACK_LEVELS` sets per-layer max zoom) and on-screen areas |
| `js/geo.js`, `js/db.js`, `js/gpx.js`, `js/weather.js` | Geometry/sun math, IndexedDB, GPX/KML, wind |
| `sw.js` | Service worker: offline app shell + cache-first tiles. **Bump `VERSION` when shell files change.** |
| `data.js` | Generated zone data (do not edit by hand) |
| `vendor/` | Leaflet 1.9.4, LERC decoder 4.3.0 (Apache-2.0), qrcode-generator 1.4.4 (MIT) |

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
