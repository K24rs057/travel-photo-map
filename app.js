import { openDatabase, allPhotos, getPhoto, putPhoto, putMany, photoId } from "./db.js";
import { readPhotoExif } from "./exif.js";
import { makeBackup, readBackup } from "./archive.js";
import { PhotoMap, isInJapanBounds } from "./map.js";
import { reverseGeocode } from "./geocode.js";

const $ = id => document.getElementById(id);
const DEFAULT_TAGS = ["グルメ", "道の駅", "晩酌", "デザート"];
const MAX_TAGS_PER_PHOTO = 12;
let db;
let photos = [];
let visiblePhotos = [];
let activeTag = "";
let thumbUrls = [];
let detailUrl = null;
let activeId = null;
let stream = null;
let cameraLocation = null;
let cameraLocationPromise = null;
let cameraLocationRequestId = 0;
let mapLocationPromise = null;
let centerWhenLocated = false;
let mainMap;
let editMap;
let detailMap;
let toastTimer;
let placeBackfillPromise = null;
const placeAttempts = new Set();
const placeCache = new Map();

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 4000);
}

function localDay(dateString) {
  const date = new Date(dateString);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function prettyDate(dateString) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(dateString));
}
function isLocated(photo) { return photo.lat != null && photo.lng != null; }
function isMapped(photo) { return isLocated(photo) && isInJapanBounds(photo.lat, photo.lng); }
function placeCacheKey(photo) { return isMapped(photo) ? `${photo.lat.toFixed(3)},${photo.lng.toFixed(3)}` : null; }
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => typeof tag === "string" ? tag.trim() : "").filter(Boolean))].slice(0, MAX_TAGS_PER_PHOTO);
}
function availableTags() {
  return [...new Set([...DEFAULT_TAGS, ...photos.flatMap(photo => normalizeTags(photo.tags))])];
}

function placeText(photo) {
  if (!isLocated(photo)) return "撮影場所がありません。地図から指定できます。";
  if (!isMapped(photo)) return "撮影場所：日本国外";
  if (photo.prefecture && photo.municipality) return `撮影場所：${photo.prefecture} ${photo.municipality}`;
  if (photo.placeLookupStatus === "failed") return "撮影場所：場所名を取得できませんでした";
  return "撮影場所：場所名を取得中…";
}

async function persistPhotoRecord(photo) {
  const { thumbUrl, placeLookupFailed, ...record } = photo;
  await putPhoto(db, record);
}

async function enrichPhotoPlace(photo) {
  if (!isMapped(photo) || (photo.prefecture && photo.municipality) || placeAttempts.has(photo.id)) return false;
  placeAttempts.add(photo.id);
  const cacheKey = placeCacheKey(photo);
  try {
    const place = placeCache.get(cacheKey) || await reverseGeocode(photo.lat, photo.lng);
    placeCache.set(cacheKey, place);
    Object.assign(photo, place, { placeLookupStatus: "ready" });
    await persistPhotoRecord(photo);
    if (activeId === photo.id && $("photo-dialog").open) $("detail-location").textContent = placeText(photo);
    return true;
  } catch {
    photo.placeLookupStatus = "failed";
    await persistPhotoRecord(photo);
    if (activeId === photo.id && $("photo-dialog").open) $("detail-location").textContent = placeText(photo);
    return false;
  }
}

function backfillPlaces() {
  if (placeBackfillPromise || !navigator.onLine) return placeBackfillPromise;
  const pending = photos.filter(photo => isMapped(photo) && !photo.municipality && !placeAttempts.has(photo.id));
  if (!pending.length) return null;
  placeBackfillPromise = (async () => {
    for (const photo of pending) {
      await enrichPhotoPlace(photo);
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  })().catch(() => {}).finally(() => { placeBackfillPromise = null; });
  return placeBackfillPromise;
}

async function makeThumbnail(blob) {
  let image;
  let url;
  try {
    url = URL.createObjectURL(blob);
    image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 360 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.77));
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function refresh() {
  for (const url of thumbUrls) URL.revokeObjectURL(url);
  thumbUrls = [];
  photos = await allPhotos(db);
  for (const photo of photos) {
    photo.tags = normalizeTags(photo.tags);
    const key = placeCacheKey(photo);
    if (key && photo.prefecture && photo.municipality) {
      placeCache.set(key, { prefecture: photo.prefecture, municipality: photo.municipality, municipalityCode: photo.municipalityCode });
    }
  }
  const missing = photos.filter(photo => !photo.thumb);
  for (const photo of missing) {
    photo.thumb = await makeThumbnail(photo.blob);
    if (photo.thumb) await putPhoto(db, photo);
  }
  for (const photo of photos) {
    const url = URL.createObjectURL(photo.thumb || photo.blob);
    photo.thumbUrl = url;
    thumbUrls.push(url);
  }
  applyFilter();
  backfillPlaces();
  $("storage-note").textContent = `${photos.length}枚の写真をこの端末に保存中。機種変更の前にはバックアップを作ってください。`;
}

function applyFilter() {
  const from = $("date-from").value;
  const to = $("date-to").value;
  visiblePhotos = photos.filter(photo => {
    const day = localDay(photo.date);
    const dateMatches = (!from || day >= from) && (!to || day <= to);
    return dateMatches && (!activeTag || normalizeTags(photo.tags).includes(activeTag));
  });
  const located = visiblePhotos.filter(isMapped);
  mainMap.setPhotos(located);
  mainMap.fitPhotos(located);
  $("map-count").textContent = `${located.length}枚の写真を地図に表示`;
  $("album-count").textContent = `${visiblePhotos.length}枚の写真`;
  renderTagFilters();
  $("map-empty").hidden = located.length > 0 || Boolean(mainMap.currentLocation);
  $("album-empty").hidden = visiblePhotos.length > 0;
  const unlocated = visiblePhotos.filter(photo => !isLocated(photo)).length;
  const outsideJapan = visiblePhotos.filter(photo => isLocated(photo) && !isMapped(photo)).length;
  $("unlocated-notice").hidden = unlocated === 0 && outsideJapan === 0;
  $("unlocated-notice").textContent = [
    unlocated ? `${unlocated}枚は撮影場所がありません。写真を開いて場所を指定できます。` : "",
    outsideJapan ? `${outsideJapan}枚は日本国外で撮影されたため、日本地図には表示していません。` : "",
  ].filter(Boolean).join(" ");
  const grid = $("album-grid");
  grid.replaceChildren();
  for (const photo of visiblePhotos) {
    const button = document.createElement("button");
    button.className = "photo-thumb";
    button.setAttribute("aria-label", `${prettyDate(photo.date)}の写真を開く`);
    const image = document.createElement("img");
    image.src = photo.thumbUrl;
    image.alt = "";
    button.append(image);
    const tags = normalizeTags(photo.tags);
    if (tags.length) {
      const tagList = document.createElement("span");
      tagList.className = "photo-tags";
      tagList.textContent = tags.length > 1 ? `${tags[0]} ＋${tags.length - 1}` : tags[0];
      button.append(tagList);
    }
    if (!isMapped(photo)) {
      const label = document.createElement("span");
      label.className = "no-location";
      label.textContent = isLocated(photo) ? "日本国外" : "場所なし";
      button.append(label);
    }
    button.addEventListener("click", () => showPhoto(photo.id));
    grid.append(button);
  }
}

function renderTagFilters() {
  const tags = availableTags();
  if (activeTag && !tags.includes(activeTag)) activeTag = "";
  for (const id of ["map-tag-filters", "album-tag-filters"]) {
    const row = $(id);
    row.replaceChildren();
    for (const tag of ["", ...tags]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-filter";
      button.textContent = tag || "すべて";
      button.setAttribute("aria-pressed", String(tag === activeTag));
      button.addEventListener("click", () => {
        activeTag = tag;
        applyFilter();
      });
      row.append(button);
    }
  }
}

function renderDetailTags(photo) {
  const selected = new Set(normalizeTags(photo.tags));
  const choices = [...new Set([...DEFAULT_TAGS, ...availableTags(), ...selected])];
  const container = $("detail-tags");
  container.replaceChildren();
  for (const tag of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "detail-tag";
    button.textContent = tag;
    button.setAttribute("aria-pressed", String(selected.has(tag)));
    button.addEventListener("click", () => togglePhotoTag(photo.id, tag));
    container.append(button);
  }
}

async function togglePhotoTag(photoId, tag, forceAdd = false) {
  const photo = photos.find(item => item.id === photoId);
  if (!photo) return;
  const tags = normalizeTags(photo.tags);
  const exists = tags.includes(tag);
  if (!exists && tags.length >= MAX_TAGS_PER_PHOTO) return toast(`タグは${MAX_TAGS_PER_PHOTO}個までです`);
  photo.tags = exists && !forceAdd ? tags.filter(item => item !== tag) : [...new Set([...tags, tag])];
  await persistPhotoRecord(photo);
  applyFilter();
  const stillVisible = photos.some(item => item.id === photoId) && (!activeTag || photo.tags.includes(activeTag));
  if (!stillVisible) return closePhoto();
  renderDetailTags(photo);
  toast(exists && !forceAdd ? `「${tag}」を外しました` : `「${tag}」を追加しました`);
}

async function addCustomTag() {
  const input = $("custom-tag");
  const tag = input.value.trim();
  if (!tag) return;
  if (tag.length > 20) return toast("タグは20文字以内で入力してください");
  const photo = photos.find(item => item.id === activeId);
  if (!photo) return;
  if (normalizeTags(photo.tags).includes(tag)) {
    input.value = "";
    return toast("そのタグはすでについています");
  }
  await togglePhotoTag(photo.id, tag, true);
  input.value = "";
}

function showPage(name) {
  for (const page of document.querySelectorAll(".page")) page.classList.toggle("active", page.id === `${name}-page`);
  for (const button of document.querySelectorAll(".nav-button")) {
    const active = button.dataset.page === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  if (name === "map") requestAnimationFrame(() => mainMap.render());
}

function locationErrorMessage(error) {
  if (error?.code === 1) return "位置情報が許可されていません。Chromeのサイト設定で許可してから再試行してください。";
  if (error?.code === 3) return "現在地の取得に時間がかかっています。屋外などで再試行してください。";
  return "現在地を取得できませんでした。通信と端末の位置情報設定を確認してください。";
}

function currentLocation(timeout = 15000) {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({ location: null, error: { code: 0 } });
    navigator.geolocation.getCurrentPosition(
      position => resolve({ location: { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp }, error: null }),
      error => resolve({ location: null, error }),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

function requestMapLocation(center = false) {
  if (center && mainMap.currentLocation) mainMap.setCenter(mainMap.currentLocation.lat, mainMap.currentLocation.lng, 14);
  if (center) centerWhenLocated = true;
  if (mapLocationPromise) return mapLocationPromise;
  $("locate-me").disabled = true;
  $("location-status").textContent = "現在地を確認しています…";
  mapLocationPromise = currentLocation().then(({ location, error }) => {
    if (location) {
      if (isInJapanBounds(location.lat, location.lng)) {
        mainMap.setCurrentLocation(location);
        if (centerWhenLocated || !photos.some(isMapped)) mainMap.setCenter(location.lat, location.lng, 14);
        $("map-empty").hidden = true;
        $("location-status").textContent = "青いピンが現在地です。";
      } else {
        mainMap.setCurrentLocation(null);
        $("location-status").textContent = "現在地は日本国外のため、日本地図には表示していません。";
      }
    } else {
      $("location-status").textContent = locationErrorMessage(error);
    }
    return location;
  }).finally(() => {
    mapLocationPromise = null;
    centerWhenLocated = false;
    $("locate-me").disabled = false;
  });
  return mapLocationPromise;
}

function requestCameraLocation(retrying = false) {
  const requestId = ++cameraLocationRequestId;
  $("camera-location-status").textContent = retrying ? "撮影場所をもう一度確認しています…" : "撮影場所を確認しています…";
  $("retry-camera-location").hidden = true;
  cameraLocationPromise = currentLocation(retrying ? 12000 : 15000).then(({ location, error }) => {
    if (requestId !== cameraLocationRequestId) return cameraLocation;
    cameraLocation = location;
    if (location) {
      if (isInJapanBounds(location.lat, location.lng)) {
        mainMap.setCurrentLocation(location);
        if (!photos.some(isMapped)) mainMap.setCenter(location.lat, location.lng, 14);
        $("map-empty").hidden = true;
        $("location-status").textContent = "青いピンが現在地です。";
      } else {
        mainMap.setCurrentLocation(null);
        $("location-status").textContent = "現在地は日本国外のため、日本地図には表示していません。";
      }
      $("camera-location-status").textContent = `撮影場所を取得しました（およそ±${Math.round(location.accuracy)}m）`;
    } else {
      $("camera-location-status").textContent = locationErrorMessage(error);
      $("retry-camera-location").hidden = false;
    }
    return location;
  });
  return cameraLocationPromise;
}

async function saveFile(blob, { name = "写真", date = new Date().toISOString(), location = null, source = "camera" } = {}) {
  if (!blob || !blob.type.startsWith("image/")) throw new Error("写真ファイルを選んでください。");
  const thumb = await makeThumbnail(blob);
  const record = {
    id: photoId(), blob, thumb, name, date,
    lat: location?.lat ?? null, lng: location?.lng ?? null,
    accuracy: location?.accuracy ?? null, source,
    prefecture: null, municipality: null, municipalityCode: null,
    placeLookupStatus: location && isInJapanBounds(location.lat, location.lng) ? "pending" : location ? "outside" : "missing",
    tags: [],
  };
  await putPhoto(db, record);
  return record;
}

async function openCamera() {
  cameraLocation = null;
  requestCameraLocation();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("カメラを開けません");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("camera-video").srcObject = stream;
    $("camera-dialog").showModal();
  } catch {
    stopCamera();
    $("fallback-camera-input").click();
  }
}

function stopCamera() {
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  $("camera-video").srcObject = null;
  if ($("camera-dialog").open) $("camera-dialog").close();
}

async function takePhoto() {
  const video = $("camera-video");
  if (!video.videoWidth || !video.videoHeight) return toast("カメラの準備ができていません。");
  $("shutter").disabled = true;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
    let location = cameraLocation;
    if (!location || Date.now() - location.timestamp > 30000) {
      location = await cameraLocationPromise;
      if (!location || Date.now() - location.timestamp > 30000) location = await requestCameraLocation(true);
    }
    const photo = await saveFile(blob, { name: `撮影 ${prettyDate(new Date().toISOString())}`, location });
    stopCamera();
    await refresh();
    if (isMapped(photo)) mainMap.setCenter(photo.lat, photo.lng, 13);
    showPage(isMapped(photo) ? "map" : "album");
    if (!isMapped(photo)) showPhoto(photo.id);
    toast(isMapped(photo) ? "写真と撮影場所をピンで保存しました" : location ? "写真を保存しました。撮影場所は日本国外です" : "写真を保存しました。撮影場所を地図で指定してください");
  } catch (error) { toast(`保存できませんでした: ${error.message}`); }
  finally { $("shutter").disabled = false; }
}

async function importFiles(files, fromCamera = false) {
  if (!files.length) return;
  let saved = 0;
  const cameraPosition = fromCamera ? cameraLocation || await cameraLocationPromise : null;
  for (const file of files) {
    try {
      const exif = await readPhotoExif(file);
      const location = exif.lat != null && exif.lng != null ? { lat: exif.lat, lng: exif.lng } : cameraPosition;
      const date = exif.date || (file.lastModified ? new Date(file.lastModified) : new Date()).toISOString();
      await saveFile(file, { name: file.name, date, location, source: fromCamera ? "camera" : "import" });
      saved++;
    } catch (error) { toast(`${file.name}を保存できませんでした: ${error.message}`); }
  }
  await refresh();
  showPage("album");
  if (saved) toast(`${saved}枚の写真を保存しました`);
}

function showPhoto(id) {
  const photo = photos.find(item => item.id === id);
  if (!photo) return;
  activeId = id;
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = URL.createObjectURL(photo.blob);
  $("detail-image").src = detailUrl;
  $("detail-date").textContent = prettyDate(photo.date);
  $("detail-location").textContent = placeText(photo);
  $("custom-tag").value = "";
  renderDetailTags(photo);
  $("detail-map").hidden = !isMapped(photo);
  $("photo-dialog").showModal();
  if (isMapped(photo)) {
    if (!detailMap) detailMap = new PhotoMap($("detail-map"), { zoom: 13 });
    detailMap.setCenter(photo.lat, photo.lng, 13);
    detailMap.setPhotos([photo]);
    requestAnimationFrame(() => detailMap.render());
  }
}

function closePhoto() {
  $("photo-dialog").close();
  $("detail-image").removeAttribute("src");
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
}

function editLocation() {
  const photo = photos.find(item => item.id === activeId);
  if (!photo) return;
  closePhoto();
  $("location-dialog").showModal();
  if (!editMap) editMap = new PhotoMap($("edit-map"), { zoom: 12 });
  editMap.setCenter(isMapped(photo) ? photo.lat : mainMap.center.lat, isMapped(photo) ? photo.lng : mainMap.center.lng, isMapped(photo) ? 13 : mainMap.zoom);
  requestAnimationFrame(() => editMap.render());
}

async function saveLocation() {
  const photo = await getPhoto(db, activeId);
  if (!photo) return;
  photo.lat = editMap.center.lat;
  photo.lng = editMap.center.lng;
  photo.accuracy = null;
  photo.source = "manual";
  photo.prefecture = null;
  photo.municipality = null;
  photo.municipalityCode = null;
  photo.placeLookupStatus = "pending";
  placeAttempts.delete(photo.id);
  await putPhoto(db, photo);
  $("location-dialog").close();
  await refresh();
  mainMap.setCenter(photo.lat, photo.lng, 13);
  showPage("map");
  toast("撮影場所を保存しました");
}

async function exportBackup() {
  if (!photos.length) return toast("バックアップする写真がありません。");
  const button = $("backup-button");
  button.disabled = true;
  button.textContent = "作成中…";
  try {
    const archive = await makeBackup(photos);
    const url = URL.createObjectURL(archive);
    const link = document.createElement("a");
    link.href = url;
    link.download = `旅の地図-backup-${localDay(new Date().toISOString())}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("バックアップを保存しました");
  } catch (error) { toast(`バックアップを作れませんでした: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "バックアップを作る"; }
}

async function restoreBackup(file) {
  if (!file) return;
  const button = $("restore-button");
  button.disabled = true;
  button.textContent = "復元中…";
  try {
    const records = await readBackup(file);
    const existing = new Set(photos.map(photo => photo.id));
    const added = records.filter(record => !existing.has(record.id));
    await putMany(db, added);
    await refresh();
    showPage("album");
    toast(`${added.length}枚の写真を復元しました`);
  } catch (error) { toast(`復元できませんでした: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "ZIPファイルを選ぶ"; }
}

async function init() {
  try {
    db = await openDatabase();
    mainMap = new PhotoMap($("main-map"), { onMarker: showPhoto, lightweight: true });
    await refresh();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (error) {
    toast(`保存領域を開けませんでした: ${error.message}`);
    return;
  }
  for (const button of document.querySelectorAll(".nav-button")) button.addEventListener("click", () => showPage(button.dataset.page));
  $("take-photo").addEventListener("click", openCamera);
  $("shutter").addEventListener("click", takePhoto);
  $("camera-close").addEventListener("click", stopCamera);
  $("camera-fallback").addEventListener("click", () => { stopCamera(); $("fallback-camera-input").click(); });
  $("camera-dialog").addEventListener("close", stopCamera);
  $("import-button").addEventListener("click", () => $("import-input").click());
  $("import-input").addEventListener("change", async event => { await importFiles([...event.target.files]); event.target.value = ""; });
  $("fallback-camera-input").addEventListener("change", async event => { await importFiles([...event.target.files], true); event.target.value = ""; });
  $("filter-toggle").addEventListener("click", () => { const panel = $("filter-panel"); panel.hidden = !panel.hidden; $("filter-toggle").setAttribute("aria-expanded", String(!panel.hidden)); });
  $("date-from").addEventListener("change", applyFilter);
  $("date-to").addEventListener("change", applyFilter);
  $("filter-clear").addEventListener("click", () => { $("date-from").value = ""; $("date-to").value = ""; activeTag = ""; applyFilter(); });
  $("zoom-in").addEventListener("click", () => mainMap.setZoom(mainMap.zoom + 1));
  $("zoom-out").addEventListener("click", () => mainMap.setZoom(mainMap.zoom - 1));
  $("locate-me").addEventListener("click", () => requestMapLocation(true));
  $("retry-camera-location").addEventListener("click", () => requestCameraLocation(true));
  $("photo-close").addEventListener("click", closePhoto);
  $("photo-dialog").addEventListener("close", () => { if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; } });
  $("edit-location").addEventListener("click", editLocation);
  $("add-custom-tag").addEventListener("click", addCustomTag);
  $("custom-tag").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addCustomTag(); } });
  $("location-close").addEventListener("click", () => $("location-dialog").close());
  $("edit-zoom-in").addEventListener("click", () => editMap.setZoom(editMap.zoom + 1));
  $("edit-zoom-out").addEventListener("click", () => editMap.setZoom(editMap.zoom - 1));
  $("save-location").addEventListener("click", saveLocation);
  $("backup-button").addEventListener("click", exportBackup);
  $("restore-button").addEventListener("click", () => $("restore-input").click());
  $("restore-input").addEventListener("change", async event => { await restoreBackup(event.target.files[0]); event.target.value = ""; });
  function updateOnline() { $("map-offline").hidden = navigator.onLine; }
  window.addEventListener("online", () => { updateOnline(); placeAttempts.clear(); backfillPlaces(); });
  window.addEventListener("offline", updateOnline);
  updateOnline();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  requestMapLocation();
}

init();
