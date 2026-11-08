#!/usr/bin/env python3
"""Build data.js for the Freeport hunting map.

Boundaries: Maine Conserved Lands (Maine GeoLibrary / ArcGIS), all parcels
held by Freeport Conservation Trust.
Hunting status: transcribed by hand from the Freeport Conservation Trust map
"Hunting on Freeport Conservation Trust Preserves" (see STATUS below).
Safety-zone points: Maine E911 address points within ~150 m of any preserve
where hunting is allowed (used to draw approximate 100-yard firearm buffers).

Run:  python3 scripts/build-data.py
"""
import json, math, urllib.parse, urllib.request, datetime, os

CL = ("https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/"
      "Maine_Conserved_Lands_All/FeatureServer/0/query")
E911 = ("https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/"
        "Maine_E911_Addresses_Feature/FeatureServer/0/query")
OUT = os.path.join(os.path.dirname(__file__), "..", "data.js")

# OBJECTID in Maine Conserved Lands -> status from the FCT hunting map.
#   no      = No Hunting (orange)
#   firearm = Firearm & Bow Hunting (green)
#   bow     = Bow Hunting ONLY (blue)
# Any FCT parcel not listed is shown as "unmapped" (not on the FCT hunting map).
STATUS = {
    # --- No hunting ---
    76541: "no",   # Simpson Woods Easement (middle Simpson parcel)
    18273: "no",   # Frost Gully Woods
    17471: "no",   # Jackman Woods
    17469: "no",   # Kelsey Brook
    9154:  "no",   # Mitchell Ledge Farm
    17472: "no",   # Windsor Crossing
    76545: "no",   # Wescott Woods
    76534: "no",   # Brimstone
    77409: "no",   # Wescott Waterfall (Ringrose Rd)
    77408: "no",   # Waterfall Connector (Ringrose Rd)
    18669: "no",   # Calderwood 2 (shore)
    18680: "no",   # Whippoorwill Woods (south of Brewer Woods)
    18687: "no",   # Tidebrook
    18281: "no",   # Highview 1 (east of Sayles Field)
    18280: "no",   # Highview 2
    76543: "no",   # Staples Cove 1
    76544: "no",   # Staples Cove 2
    10813: "no",   # Rachel's Cove
    # --- Firearm & bow ---
    76540: "firearm",  # Simpson Woods
    76542: "firearm",  # Harraseeket Ridge (Simpson Woods)
    18671: "firearm",  # Newfield
    18670: "firearm",  # Calderwood 1 (Calderwood - Inland)
    18672: "firearm",  # Field Estuary
    18679: "firearm",  # Brewer Woods
    76539: "firearm",  # Harvey Brook
    76536: "firearm",  # Walsh Preserve (Cousins River Marsh - Walsh)
    8835:  "firearm",  # Sayles Field
    77407: "firearm",  # River's Edge
    76549: "firearm",  # Powell Point 1
    76425: "firearm",  # Powell Point 2
    # --- Bow only ---
    7410: "bow",       # Bliss Woods
}

DISPLAY_NAME = {
    76540: "Simpson Woods", 76541: "Simpson Woods (easement)",
    76542: "Simpson Woods – Harraseeket Ridge", 18670: "Calderwood – Inland",
    18669: "Calderwood (shore)", 76536: "Walsh Preserve", 77407: "River's Edge",
    76549: "Powell Point", 76425: "Powell Point", 77409: "Ringrose Rd – Wescott Waterfall",
    77408: "Ringrose Rd – Waterfall Connector", 9154: "Mitchell Ledge Farm",
    18281: "Highview", 18280: "Highview", 76543: "Staples Cove", 76544: "Staples Cove",
}


def get(url, params):
    q = url + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(q, timeout=120) as r:
        return json.load(r)


def m_per_deg(lat):
    return 111320 * math.cos(math.radians(lat)), 110540


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def rings(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [r for p in polys for r in p]


def inside(lon, lat, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        c = False
        for ring in poly:  # even-odd across outer + holes
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                    c = not c
        if c:
            return True
    return False


def dist_m(lon, lat, geom):
    if inside(lon, lat, geom):
        return 0.0
    kx, ky = m_per_deg(lat)
    best = 1e12
    for ring in rings(geom):
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            best = min(best, seg_dist(lon * kx, lat * ky, x1 * kx, y1 * ky, x2 * kx, y2 * ky))
    return best


def main():
    fc = get(CL, {
        "where": "HOLD1_NAME LIKE '%Freeport Conservation Trust%' OR HOLD2_NAME LIKE '%Freeport Conservation Trust%'",
        "outFields": "OBJECTID,PROJECT,PARCEL_NAME,HOLD1_NAME,HOLD2_NAME,CONS1_TYPE,PUB_ACCESS,CALC_AC",
        "outSR": 4326, "geometryPrecision": 6, "f": "geojson",
    })
    feats = []
    for f in fc["features"]:
        p = f["properties"]; oid = p["OBJECTID"]
        if oid == 18276:  # a second "River's Edge" record far outside Freeport
            continue
        status = STATUS.get(oid, "unmapped")
        name = DISPLAY_NAME.get(oid) or p["PROJECT"] or p["PARCEL_NAME"] or "Unnamed"
        f["properties"] = {
            "id": oid, "name": name, "parcel": p["PARCEL_NAME"], "status": status,
            "acres": round(p["CALC_AC"] or 0, 1), "type": p["CONS1_TYPE"],
            "holder": p["HOLD1_NAME"], "holder2": p["HOLD2_NAME"], "access": p["PUB_ACCESS"],
        }
        feats.append(f)
    missing = set(STATUS) - {f["properties"]["id"] for f in feats}
    if missing:
        raise SystemExit(f"STATUS ids not found in source data: {missing}")

    # E911 address points near huntable parcels
    pts = {}
    for f in feats:
        if f["properties"]["status"] not in ("firearm", "bow"):
            continue
        xs = [c[0] for r in rings(f["geometry"]) for c in r]
        ys = [c[1] for r in rings(f["geometry"]) for c in r]
        pad = 0.003
        res = get(E911, {
            "where": "1=1", "geometry": f"{min(xs)-pad},{min(ys)-pad},{max(xs)+pad},{max(ys)+pad}",
            "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "OBJECTID,ADDRESS_NUMBER,ST_FULLNAME,TOWN,PLACE_TYPE", "f": "json",
        })
        for a in res.get("features", []):
            lon, lat = a["geometry"]["x"], a["geometry"]["y"]
            if dist_m(lon, lat, f["geometry"]) <= 150:
                at = a["attributes"]
                addr = f"{at.get('ADDRESS_NUMBER') or ''} {at.get('ST_FULLNAME') or ''}".strip()
                pts[at["OBJECTID"]] = [round(lon, 6), round(lat, 6), addr, at.get("TOWN") or ""]

    data = {
        "built": datetime.date.today().isoformat(),
        "parcels": {"type": "FeatureCollection", "features": feats},
        "addresses": list(pts.values()),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        fh.write("// Generated by scripts/build-data.py — do not edit by hand.\n")
        fh.write("window.HUNT_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n")
    counts = {}
    for f in feats:
        counts[f["properties"]["status"]] = counts.get(f["properties"]["status"], 0) + 1
    print(f"wrote {OUT}: {counts}, {len(pts)} address points")


if __name__ == "__main__":
    main()
