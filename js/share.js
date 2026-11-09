// Sharing with hunting buddies: app link + QR code, and waypoints packed into a link that opens
// straight into their copy of the app (no server, no accounts: the data rides in the URL #hash).

export const APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');

const b64url = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** waypoints → compact link: #s=<z|j><base64url> */
export async function waypointsLink(wps) {
  const data = { v: 1, w: wps.map((w) => [w.name || '', w.type || 'note', +w.lat.toFixed(6), +w.lon.toFixed(6), w.notes || '']) };
  const raw = new TextEncoder().encode(JSON.stringify(data));
  let code = 'j' + b64url(raw);
  if (typeof CompressionStream !== 'undefined') {
    try { const z = 'z' + b64url(await pipe(raw, new CompressionStream('deflate-raw'))); if (z.length < code.length) code = z; } catch { /* plain */ }
  }
  return `${APP_URL}#s=${code}`;
}

/** Parse a shared link (or just its #hash) → [{name, type, lat, lon, notes}] or null */
export async function parseShared(text) {
  const m = String(text || '').match(/[#&]s=([zj][A-Za-z0-9_-]+)/);
  if (!m) return null;
  let bytes = unb64url(m[1].slice(1));
  if (m[1][0] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  const d = JSON.parse(new TextDecoder().decode(bytes));
  return (d.w || []).map(([name, type, lat, lon, notes]) => ({ name, type, lat: +lat, lon: +lon, notes }))
    .filter((w) => isFinite(w.lat) && isFinite(w.lon) && Math.abs(w.lat) <= 90 && Math.abs(w.lon) <= 180);
}

/** Native share sheet (text/messages/etc.) with clipboard fallback. Returns 'shared' | 'copied' | 'cancelled'. */
export async function shareUrl({ title, text, url }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  await copyText(url);
  return 'copied';
}
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return true;
  }
}

export function qrSvg(text) {
  const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
}
