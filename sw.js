const CACHE = "travel-photo-map-v7";
const BASE = new URL("./", self.location.href);
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./db.js", "./exif.js", "./archive.js", "./map.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"].map(path => new URL(path, BASE).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(async () => await caches.match(event.request) || Response.error()));
});
