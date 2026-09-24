const DB_NAME = "travel-photo-map";
const STORE = "photos";
const FAMILY_STORE = "family";

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("date", "date");
      }
      if (event.oldVersion < 2) {
        const family = db.createObjectStore(FAMILY_STORE, { keyPath: "id" });
        family.createIndex("date", "date");
      }
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

export async function allFamilyPhotos(db) {
  const tx = db.transaction(FAMILY_STORE, "readonly");
  const records = await requestPromise(tx.objectStore(FAMILY_STORE).getAll());
  return records.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export async function putManyFamily(db, records) {
  if (!records.length) return;
  const tx = db.transaction(FAMILY_STORE, "readwrite");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    for (const record of records) tx.objectStore(FAMILY_STORE).put(record);
  });
}

export async function deleteFamilyPhotos(db, ids) {
  if (!ids.length) return;
  const tx = db.transaction(FAMILY_STORE, "readwrite");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    for (const id of ids) tx.objectStore(FAMILY_STORE).delete(id);
  });
}
