const TILE = 256;
const TILE_DETAIL_OFFSET = 2;
const FALLBACK_DETAIL_OFFSET = 3;
const TILE_BUFFER = 160;
const PAN_COMMIT_DISTANCE = 160;
const TILE_CACHE_LIMIT = 48;

function clampLat(lat) { return Math.max(-85.0511, Math.min(85.0511, lat)); }
export function project(lat, lng, zoom) {
  const size = TILE * 2 ** zoom;
  const sine = Math.sin(clampLat(lat) * Math.PI / 180);
  return { x: (lng + 180) / 360 * size, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size };
}
export function unproject(x, y, zoom) {
  const size = TILE * 2 ** zoom;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI, lng: ((x / size * 360) % 360 + 360) % 360 - 180 };
}

export function tileDetail(zoom, detailOffset = TILE_DETAIL_OFFSET) {
  const sourceZoom = Math.max(0, zoom - detailOffset);
  return { sourceZoom, span: TILE * 2 ** (zoom - sourceZoom) };
}

export class PhotoMap {
  constructor(element, { lat = 36, lng = 138, zoom = 5, onMarker = null } = {}) {
    this.element = element;
    this.center = { lat, lng };
    this.zoom = zoom;
    this.photos = [];
    this.currentLocation = null;
    this.onMarker = onMarker;
    this.panLayer = document.createElement("div");
    this.panLayer.className = "map-pan-layer";
    this.tileLayer = document.createElement("div");
    this.tileLayer.className = "map-tile-layer";
    this.fallbackTileLayer = document.createElement("div");
    this.fallbackTileLayer.className = "map-tile-batch map-tile-fallback";
    this.detailTileLayer = document.createElement("div");
    this.detailTileLayer.className = "map-tile-batch map-tile-detail";
    this.tileLayer.append(this.fallbackTileLayer, this.detailTileLayer);
    this.markerLayer = document.createElement("div");
    this.markerLayer.className = "map-marker-layer";
    this.currentMarker = document.createElement("div");
    this.currentMarker.className = "current-location-marker";
    this.currentMarker.setAttribute("role", "img");
    this.currentMarker.setAttribute("aria-label", "現在地");
    this.currentMarker.hidden = true;
    this.panLayer.append(this.tileLayer, this.markerLayer, this.currentMarker);
    this.element.append(this.panLayer);
    this.tileElements = new Map();
    this.fallbackTileElements = new Map();
    this.markerViews = [];
    this.projectedZoom = null;
    this.renderFrame = 0;
    this.panFrame = 0;
    this.pan = { x: 0, y: 0 };
    const attribution = document.createElement("div");
    attribution.className = "map-attribution";
    attribution.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
    this.element.append(attribution);
    this.pointers = new Map();
    this.element.addEventListener("pointerdown", event => this.pointerDown(event));
    this.element.addEventListener("pointermove", event => this.pointerMove(event));
    this.element.addEventListener("pointerup", event => this.pointerUp(event));
    this.element.addEventListener("pointercancel", event => this.pointerUp(event));
    this.element.addEventListener("wheel", event => {
      event.preventDefault();
      this.setZoom(this.zoom + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    this.observer = new ResizeObserver(() => this.requestRender());
    this.observer.observe(element);
    this.render();
  }

  requestRender() {
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.render();
    });
  }

  setPhotos(photos) {
    this.photos = photos;
    this.rebuildMarkers();
    this.requestRender();
  }

  setCurrentLocation(location) {
    this.currentLocation = location;
    this.currentMarker.hidden = !location;
    this.requestRender();
  }
  fitPhotos(photos) {
    const located = photos.filter(photo => photo.lat != null && photo.lng != null);
    if (!located.length) return;
    const reference = project(located[0].lat, located[0].lng, 0).x;
    const points = located.map(photo => {
      const point = project(photo.lat, photo.lng, 0);
      while (point.x - reference > 128) point.x -= 256;
      while (point.x - reference < -128) point.x += 256;
      return point;
    });
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = this.element.clientWidth || Math.min(window.innerWidth, 850);
    const height = this.element.clientHeight || 500;
    let zoom = 2;
    for (let candidate = 13; candidate >= 2; candidate--) {
      if ((maxX - minX) * 2 ** candidate <= width - 110 && (maxY - minY) * 2 ** candidate <= height - 120) {
        zoom = candidate;
        break;
      }
    }
    const center = unproject((minX + maxX) / 2, (minY + maxY) / 2, 0);
    this.setCenter(center.lat, center.lng, zoom);
  }
  setCenter(lat, lng, zoom = this.zoom) {
    this.commitPan();
    this.center = { lat: clampLat(lat), lng: ((lng + 180) % 360 + 360) % 360 - 180 };
    this.zoom = Math.max(2, Math.min(17, zoom));
    this.render();
  }
  setZoom(zoom) { this.setCenter(this.center.lat, this.center.lng, zoom); }

  pointerDown(event) {
    if (event.target.closest(".map-marker")) return;
    if (this.pointers.size === 1) this.commitPan();
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.element.setPointerCapture(event.pointerId);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }
  pointerMove(event) {
    const old = this.pointers.get(event.pointerId);
    if (!old) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDistance && distance > this.pinchDistance * 1.5) { this.setZoom(this.zoom + 1); this.pinchDistance = distance; }
      if (this.pinchDistance && distance < this.pinchDistance / 1.5) { this.setZoom(this.zoom - 1); this.pinchDistance = distance; }
      return;
    }
    this.pan.x += event.clientX - old.x;
    this.pan.y += event.clientY - old.y;
    if (!this.panFrame) {
      this.panFrame = requestAnimationFrame(() => {
        this.panFrame = 0;
        this.panLayer.style.transform = `translate3d(${this.pan.x}px,${this.pan.y}px,0)`;
      });
    }
    if (Math.max(Math.abs(this.pan.x), Math.abs(this.pan.y)) >= PAN_COMMIT_DISTANCE) this.commitPan();
  }
  pointerUp(event) {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = null;
    if (!this.pointers.size) this.commitPan();
  }

  commitPan() {
    if (!this.pan.x && !this.pan.y) return;
    if (this.panFrame) cancelAnimationFrame(this.panFrame);
    this.panFrame = 0;
    const size = TILE * 2 ** this.zoom;
    const point = project(this.center.lat, this.center.lng, this.zoom);
    this.center = unproject(
      point.x - this.pan.x,
      Math.max(0, Math.min(size, point.y - this.pan.y)),
      this.zoom,
    );
    this.pan = { x: 0, y: 0 };
    this.panLayer.style.transform = "translate3d(0,0,0)";
    this.render();
  }

  render() {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    if (!width || !height) return;
    const size = TILE * 2 ** this.zoom;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    const detail = tileDetail(this.zoom);
    const fallback = tileDetail(this.zoom, FALLBACK_DETAIL_OFFSET);
    this.renderTileSet(this.fallbackTileLayer, this.fallbackTileElements, fallback, center, width, height);
    this.renderTileSet(this.detailTileLayer, this.tileElements, detail, center, width, height);
    this.positionMarkers(center, size, width, height);
  }

  renderTileSet(layer, elements, { sourceZoom, span }, center, width, height) {
    const sourceCount = 2 ** sourceZoom;
    const minX = Math.floor((center.x - width / 2 - TILE_BUFFER) / span);
    const maxX = Math.floor((center.x + width / 2 + TILE_BUFFER) / span);
    const minY = Math.floor((center.y - height / 2 - TILE_BUFFER) / span);
    const maxY = Math.floor((center.y + height / 2 + TILE_BUFFER) / span);
    const needed = new Set();
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      if (y < 0 || y >= sourceCount) continue;
      const wrappedX = ((x % sourceCount) + sourceCount) % sourceCount;
      const key = `${sourceZoom}/${x}/${y}`;
      needed.add(key);
      let entry = elements.get(key);
      if (!entry) {
        const tile = document.createElement("img");
        tile.className = "map-tile";
        tile.alt = "";
        tile.style.width = `${span}px`;
        tile.style.height = `${span}px`;
        tile.style.visibility = "hidden";
        const url = `https://tile.openstreetmap.org/${sourceZoom}/${wrappedX}/${y}.png`;
        entry = { tile, x, y, span, lastUsed: performance.now(), retryTimer: 0 };
        elements.set(key, entry);
        layer.append(tile);
        this.loadTile(entry, url, elements, key);
      }
      entry.lastUsed = performance.now();
      entry.span = span;
      entry.tile.hidden = false;
      entry.tile.style.width = `${span}px`;
      entry.tile.style.height = `${span}px`;
      entry.tile.style.transform = `translate3d(${x * span - center.x + width / 2}px,${y * span - center.y + height / 2}px,0)`;
    }
    for (const [key, entry] of elements) {
      if (!needed.has(key)) entry.tile.hidden = true;
    }
    this.trimTileCache(elements, needed);
  }

  loadTile(entry, url, elements, key, attempt = 0) {
    const { tile } = entry;
    tile.onload = () => {
      clearTimeout(entry.retryTimer);
      tile.style.visibility = "visible";
    };
    tile.onerror = () => {
      tile.style.visibility = "hidden";
      if (attempt >= 2 || elements.get(key) !== entry) return;
      entry.retryTimer = setTimeout(() => {
        if (elements.get(key) !== entry) return;
        this.loadTile(entry, url, elements, key, attempt + 1);
      }, 500 * 2 ** attempt);
    };
    tile.src = attempt ? `${url}?retry=${attempt}-${Date.now()}` : url;
  }

  trimTileCache(elements, needed) {
    if (elements.size <= TILE_CACHE_LIMIT) return;
    const removable = [...elements.entries()]
      .filter(([key]) => !needed.has(key))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (elements.size > TILE_CACHE_LIMIT && removable.length) {
      const [key, entry] = removable.shift();
      clearTimeout(entry.retryTimer);
      entry.tile.remove();
      elements.delete(key);
    }
  }

  rebuildMarkers() {
    this.markerLayer.replaceChildren();
    this.markerViews = [];
    this.projectedZoom = null;
    const groups = new Map();
    for (const photo of this.photos) {
      if (photo.lat == null || photo.lng == null) continue;
      const key = `${photo.lat.toFixed(3)},${photo.lng.toFixed(3)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(photo);
    }
    for (const group of groups.values()) {
      const photo = group[0];
      const button = document.createElement("button");
      button.className = "map-marker";
      button.setAttribute("aria-label", group.length === 1 ? "撮影した写真を開く" : `写真${group.length}枚を開く`);
      const image = document.createElement("img");
      image.src = photo.thumbUrl;
      image.alt = "";
      button.append(image);
      if (group.length > 1) {
        const count = document.createElement("span");
        count.className = "map-marker-count";
        count.textContent = String(group.length);
        button.append(count);
      }
      button.addEventListener("click", () => this.onMarker?.(photo.id));
      this.markerLayer.append(button);
      this.markerViews.push({ button, lat: photo.lat, lng: photo.lng, point: null });
    }
  }

  positionMarkers(center, size, width, height) {
    if (this.projectedZoom !== this.zoom) {
      for (const marker of this.markerViews) marker.point = project(marker.lat, marker.lng, this.zoom);
      this.projectedZoom = this.zoom;
    }
    for (const marker of this.markerViews) {
      let deltaX = marker.point.x - center.x;
      if (deltaX > size / 2) deltaX -= size;
      if (deltaX < -size / 2) deltaX += size;
      const x = deltaX + width / 2;
      const y = marker.point.y - center.y + height / 2;
      const visible = x >= -70 && x <= width + 70 && y >= -10 && y <= height + 70;
      marker.button.hidden = !visible;
      if (visible) marker.button.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,calc(-100% - 12px))`;
    }
    if (this.currentLocation) {
      const point = project(this.currentLocation.lat, this.currentLocation.lng, this.zoom);
      let deltaX = point.x - center.x;
      if (deltaX > size / 2) deltaX -= size;
      if (deltaX < -size / 2) deltaX += size;
      const x = deltaX + width / 2;
      const y = point.y - center.y + height / 2;
      this.currentMarker.hidden = x < -25 || x > width + 25 || y < -25 || y > height + 25;
      if (!this.currentMarker.hidden) this.currentMarker.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`;
    }
  }
}
