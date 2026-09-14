const DB_NAME = "travel-photo-map";
const STORE = "photos";

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("date", "date");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function allPhotos(db) {
  const tx = db.transaction(STORE, "readonly");
  const records = await requestPromise(tx.objectStore(STORE).getAll());
  return records.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getPhoto(db, id) {
  return requestPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
}

export async function putPhoto(db, record) {
  const tx = db.transaction(STORE, "readwrite");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(record);
  });
}

export async function putMany(db, records) {
  const tx = db.transaction(STORE, "readwrite");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    for (const record of records) tx.objectStore(STORE).put(record);
  });
}

export function photoId() {
  return crypto.randomUUID();
}
