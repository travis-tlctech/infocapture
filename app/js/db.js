// Local-first storage. Every capture lands in IndexedDB on the phone first,
// so nothing is lost when the conference Wi-Fi is not working. Card photos
// are kept in a separate store so listing records stays fast.

const DB_NAME = 'infocapture';
const DB_VERSION = 1;
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getRecord(id) {
  return run('records', 'readonly', (s) => s.get(id));
}

export function putRecord(record) {
  return run('records', 'readwrite', (s) => s.put(record));
}

export async function listRecords() {
  const all = (await run('records', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function deleteRecord(id) {
  await run('records', 'readwrite', (s) => s.delete(id));
  await run('images', 'readwrite', (s) => s.delete(id));
}

export function putImage(id, blob) {
  return run('images', 'readwrite', (s) => s.put(blob, id));
}

export function getImage(id) {
  return run('images', 'readonly', (s) => s.get(id));
}

export function deleteImage(id) {
  return run('images', 'readwrite', (s) => s.delete(id));
}

// Read-modify-write of one record. `fn` gets the latest stored copy, so
// edits made in the form while a sync is running are never clobbered.
export async function updateRecord(id, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    let updated;
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result) return;
      updated = fn(req.result) ?? req.result;
      store.put(updated);
    };
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
  });
}

// Asks the browser not to evict our data under storage pressure. Safari can
// otherwise clear storage for sites that are not added to the home screen.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}
