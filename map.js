const TILE = 256;

function clampLat(lat) { return Math.max(-85.0511, Math.min(85.0511, lat)); }
function project(lat, lng, zoom) {
  const size = TILE * 2 ** zoom;
  const sine = Math.sin(clampLat(lat) * Math.PI / 180);
  return { x: (lng + 180) / 360 * size, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size };
}
function unproject(x, y, zoom) {
  const size = TILE * 2 ** zoom;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI, lng: ((x / size * 360 + 180) % 360 + 360) % 360 - 180 };
}

export class PhotoMap {
  constructor(element, { lat = 36, lng = 138, zoom = 5, onMarker = null } = {}) {
    this.element = element;
    this.center = { lat, lng };
    this.zoom = zoom;
    this.photos = [];
    this.onMarker = onMarker;
    this.tileLayer = document.createElement("div");
    this.markerLayer = document.createElement("div");
    this.element.append(this.tileLayer, this.markerLayer);
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
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(element);
    this.render();
  }

  setPhotos(photos) { this.photos = photos; this.renderMarkers(); }
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
    this.center = { lat: clampLat(lat), lng: ((lng + 180) % 360 + 360) % 360 - 180 };
    this.zoom = Math.max(2, Math.min(17, zoom));
    this.render();
  }
  setZoom(zoom) { this.setCenter(this.center.lat, this.center.lng, zoom); }

  pointerDown(event) {
    if (event.target.closest(".map-marker")) return;
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
    const point = project(this.center.lat, this.center.lng, this.zoom);
    const next = unproject(point.x - (event.clientX - old.x), Math.max(0, Math.min(TILE * 2 ** this.zoom, point.y - (event.clientY - old.y))), this.zoom);
    this.center = next;
    this.render();
  }
  pointerUp(event) { this.pointers.delete(event.pointerId); if (this.pointers.size < 2) this.pinchDistance = null; }

  render() {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    if (!width || !height) return;
    const size = TILE * 2 ** this.zoom;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    const minX = Math.floor((center.x - width / 2) / TILE);
    const maxX = Math.floor((center.x + width / 2) / TILE);
    const minY = Math.floor((center.y - height / 2) / TILE);
    const maxY = Math.floor((center.y + height / 2) / TILE);
    const existing = new Map([...this.tileLayer.children].map(tile => [tile.dataset.key, tile]));
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      if (y < 0 || y >= 2 ** this.zoom) continue;
      const wrappedX = ((x % 2 ** this.zoom) + 2 ** this.zoom) % 2 ** this.zoom;
      const key = `${this.zoom}/${x}/${y}`;
      let tile = existing.get(key);
      if (!tile) {
        tile = document.createElement("img");
        tile.className = "map-tile";
        tile.alt = "";
        tile.dataset.key = key;
        tile.src = `https://tile.openstreetmap.org/${this.zoom}/${wrappedX}/${y}.png`;
        tile.onerror = () => { tile.style.visibility = "hidden"; };
        this.tileLayer.append(tile);
      }
      tile.style.left = `${x * TILE - center.x + width / 2}px`;
      tile.style.top = `${y * TILE - center.y + height / 2}px`;
      existing.delete(key);
    }
    for (const tile of existing.values()) tile.remove();
    this.renderMarkers();
  }

  renderMarkers() {
    this.markerLayer.replaceChildren();
    if (!this.photos.length || !this.element.clientWidth) return;
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const size = TILE * 2 ** this.zoom;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    const groups = new Map();
    for (const photo of this.photos) {
      if (photo.lat == null || photo.lng == null) continue;
      const key = `${photo.lat.toFixed(3)},${photo.lng.toFixed(3)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(photo);
    }
    for (const group of groups.values()) {
      const photo = group[0];
      const point = project(photo.lat, photo.lng, this.zoom);
      let deltaX = point.x - center.x;
      if (deltaX > size / 2) deltaX -= size;
      if (deltaX < -size / 2) deltaX += size;
      const x = deltaX + width / 2;
      const y = point.y - center.y + height / 2;
      if (x < -70 || x > width + 70 || y < -10 || y > height + 70) continue;
      const button = document.createElement("button");
      button.className = "map-marker";
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
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
    }
  }
}
