import { openDatabase, allPhotos, getPhoto, putPhoto, putMany, photoId } from "./db.js";
import { readPhotoExif } from "./exif.js";
import { makeBackup, readBackup } from "./archive.js";
import { PhotoMap } from "./map.js";

const $ = id => document.getElementById(id);
let db;
let photos = [];
let visiblePhotos = [];
let thumbUrls = [];
let detailUrl = null;
let activeId = null;
let stream = null;
let cameraLocation = null;
let cameraLocationPromise = null;
let mainMap;
let editMap;
let detailMap;
let toastTimer;

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
  $("storage-note").textContent = `${photos.length}枚の写真をこの端末に保存中。機種変更の前にはバックアップを作ってください。`;
}

function applyFilter() {
  const from = $("date-from").value;
  const to = $("date-to").value;
  visiblePhotos = photos.filter(photo => {
    const day = localDay(photo.date);
    return (!from || day >= from) && (!to || day <= to);
  });
  const located = visiblePhotos.filter(isLocated);
  mainMap.setPhotos(located);
  mainMap.fitPhotos(located);
  $("map-count").textContent = `${located.length}枚の写真を地図に表示`;
  $("album-count").textContent = `${visiblePhotos.length}枚の写真`;
  $("map-empty").hidden = located.length > 0;
  $("album-empty").hidden = visiblePhotos.length > 0;
  const unlocated = visiblePhotos.length - located.length;
  $("unlocated-notice").hidden = unlocated === 0;
  $("unlocated-notice").textContent = `${unlocated}枚は撮影場所がありません。写真一覧から写真を開き、場所を指定できます。`;
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
    if (!isLocated(photo)) {
      const label = document.createElement("span");
      label.className = "no-location";
      label.textContent = "場所なし";
      button.append(label);
    }
    button.addEventListener("click", () => showPhoto(photo.id));
    grid.append(button);
  }
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

function currentLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 15000 },
    );
  });
}

async function saveFile(blob, { name = "写真", date = new Date().toISOString(), location = null, source = "camera" } = {}) {
  if (!blob || !blob.type.startsWith("image/")) throw new Error("写真ファイルを選んでください。");
  const thumb = await makeThumbnail(blob);
  const record = {
    id: photoId(), blob, thumb, name, date,
    lat: location?.lat ?? null, lng: location?.lng ?? null,
    accuracy: location?.accuracy ?? null, source,
  };
  await putPhoto(db, record);
  return record;
}

async function openCamera() {
  cameraLocation = null;
  $("camera-location-status").textContent = "現在地を確認しています…";
  cameraLocationPromise = currentLocation().then(location => {
    cameraLocation = location;
    $("camera-location-status").textContent = location ? "撮影場所も一緒に保存します" : "現在地を取得できません。写真は保存できます";
    return location;
  });
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
    const location = cameraLocation || await cameraLocationPromise;
    const photo = await saveFile(blob, { name: `撮影 ${prettyDate(new Date().toISOString())}`, location });
    stopCamera();
    await refresh();
    if (isLocated(photo)) mainMap.setCenter(photo.lat, photo.lng, 13);
    showPage("map");
    toast(location ? "写真と撮影場所を保存しました" : "写真を保存しました。場所はあとから指定できます");
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
  $("detail-location").textContent = isLocated(photo)
    ? `撮影場所: ${photo.lat >= 0 ? "北緯" : "南緯"} ${Math.abs(photo.lat).toFixed(5)}° / ${photo.lng >= 0 ? "東経" : "西経"} ${Math.abs(photo.lng).toFixed(5)}°${photo.accuracy ? `（およそ±${Math.round(photo.accuracy)}m）` : ""}`
    : "撮影場所がありません。地図から指定できます。";
  $("detail-map").hidden = !isLocated(photo);
  $("photo-dialog").showModal();
  if (isLocated(photo)) {
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
  editMap.setCenter(photo.lat ?? mainMap.center.lat, photo.lng ?? mainMap.center.lng, isLocated(photo) ? 13 : mainMap.zoom);
  requestAnimationFrame(() => editMap.render());
}

async function saveLocation() {
  const photo = await getPhoto(db, activeId);
  if (!photo) return;
  photo.lat = editMap.center.lat;
  photo.lng = editMap.center.lng;
  photo.accuracy = null;
  photo.source = "manual";
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
    mainMap = new PhotoMap($("main-map"), { onMarker: showPhoto });
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
  $("filter-clear").addEventListener("click", () => { $("date-from").value = ""; $("date-to").value = ""; applyFilter(); });
  $("zoom-in").addEventListener("click", () => mainMap.setZoom(mainMap.zoom + 1));
  $("zoom-out").addEventListener("click", () => mainMap.setZoom(mainMap.zoom - 1));
  $("photo-close").addEventListener("click", closePhoto);
  $("photo-dialog").addEventListener("close", () => { if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; } });
  $("edit-location").addEventListener("click", editLocation);
  $("location-close").addEventListener("click", () => $("location-dialog").close());
  $("edit-zoom-in").addEventListener("click", () => editMap.setZoom(editMap.zoom + 1));
  $("edit-zoom-out").addEventListener("click", () => editMap.setZoom(editMap.zoom - 1));
  $("save-location").addEventListener("click", saveLocation);
  $("backup-button").addEventListener("click", exportBackup);
  $("restore-button").addEventListener("click", () => $("restore-input").click());
  $("restore-input").addEventListener("change", async event => { await restoreBackup(event.target.files[0]); event.target.value = ""; });
  function updateOnline() { $("map-offline").hidden = navigator.onLine; }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init();
