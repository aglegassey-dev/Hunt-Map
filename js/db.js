// Minimal IndexedDB key-value store for waypoints and tracks (photos stored as Blobs).
const DB_NAME = 'huntmap', VERSION = 1, STORES = ['waypoints', 'tracks'];
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => STORES.forEach((s) => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), st = t.objectStore(store);
    const out = fn(st);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const db = {
  all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
  del: (s, id) => tx(s, 'readwrite', (st) => st.delete(id)),
};
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
