// GPX export and GPX/KML import (onX, Garmin, Gaia and most GPS apps speak these).
const x = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function toGPX(waypoints, tracks) {
  const wpts = waypoints.map((w) =>
    `  <wpt lat="${w.lat}" lon="${w.lon}">${w.elev != null ? `<ele>${w.elev.toFixed(1)}</ele>` : ''}` +
    `<time>${new Date(w.created).toISOString()}</time><name>${x(w.name)}</name>` +
    `${w.notes ? `<desc>${x(w.notes)}</desc>` : ''}<sym>${x(w.type)}</sym><type>${x(w.type)}</type></wpt>`).join('\n');
  const trks = tracks.map((t) =>
    `  <trk><name>${x(t.name)}</name><trkseg>\n` +
    t.points.map(([lat, lon, time]) => `    <trkpt lat="${lat}" lon="${lon}"><time>${new Date(time).toISOString()}</time></trkpt>`).join('\n') +
    `\n  </trkseg></trk>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Freeport Hunt Map" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n${trks}\n</gpx>\n`;
}

const txt = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';

/** Parse GPX or KML text → { waypoints: [{lat, lon, name, notes, type, elev, created}], tracks: [{name, points}] } */
export function parseGeoFile(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read file (not valid GPX/KML)');
  const waypoints = [], tracks = [];
  if (doc.getElementsByTagName('gpx').length) {
    for (const w of doc.getElementsByTagName('wpt')) {
      const t = txt(w, 'time');
      waypoints.push({ lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), name: txt(w, 'name') || 'Waypoint',
        notes: txt(w, 'desc') || txt(w, 'cmt'), type: txt(w, 'type') || txt(w, 'sym'),
        elev: txt(w, 'ele') ? +txt(w, 'ele') : null, created: t ? Date.parse(t) : Date.now() });
    }
    for (const t of doc.getElementsByTagName('trk')) {
      const pts = [...t.getElementsByTagName('trkpt')].map((p) => [+p.getAttribute('lat'), +p.getAttribute('lon'), Date.parse(txt(p, 'time')) || Date.now()]);
      if (pts.length > 1) tracks.push({ name: txt(t, 'name') || 'Track', points: pts });
    }
  } else {
    for (const pm of doc.getElementsByTagName('Placemark')) {
      const name = txt(pm, 'name') || 'Waypoint', notes = txt(pm, 'description');
      const pt = pm.getElementsByTagName('Point')[0], ls = pm.getElementsByTagName('LineString')[0];
      if (pt) {
        const [lon, lat, ele] = txt(pt, 'coordinates').split(',').map(Number);
        waypoints.push({ lat, lon, name, notes, type: '', elev: isFinite(ele) && ele ? ele : null, created: Date.now() });
      } else if (ls) {
        const pts = txt(ls, 'coordinates').split(/\s+/).filter(Boolean).map((c) => { const [lon, lat] = c.split(',').map(Number); return [lat, lon, Date.now()]; });
        if (pts.length > 1) tracks.push({ name, points: pts });
      }
    }
  }
  return { waypoints: waypoints.filter((w) => isFinite(w.lat) && isFinite(w.lon)), tracks };
}

export async function shareOrDownload(filename, text, mime = 'application/gpx+xml') {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
