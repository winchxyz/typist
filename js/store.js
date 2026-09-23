// Local persistence. Settings in localStorage; the working photo (for "Continue with last photo"
// after the tab is unloaded) in IndexedDB. Everything stays on this device, and every call
// tolerates private mode / blocked storage by degrading to "nothing saved".

const KEY = 'typist:v1';
const DB = 'typist';
const STORE = 'session';

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

let saveTimer = 0;
export function saveSettings(obj, delay = 400) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch { /* quota / private mode */ }
  }, delay);
}

export function clearSettings() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** { blob, name, crop, savedAt } */
export async function savePhoto(record) {
  try { await tx('readwrite', s => s.put(record, 'photo')); return true; } catch { return false; }
}

export async function loadPhoto() {
  try { return (await tx('readonly', s => s.get('photo'))) || null; } catch { return null; }
}

export async function forgetPhoto() {
  try { await tx('readwrite', s => s.delete('photo')); return true; } catch { return false; }
}
