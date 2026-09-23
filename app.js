import { openDatabase, allPhotos, getPhoto, putPhoto, putMany, photoId } from "./db.js";
import { readPhotoExif } from "./exif.js";
import { makeBackup, readBackup } from "./archive.js";

const $ = id => document.getElementById(id);
const DEFAULT_TAGS = ["グルメ", "道の駅", "晩酌", "デザート"];
const MAX_TAGS_PER_PHOTO = 12;
const MAX_CUSTOM_TAGS = 40;
const CUSTOM_TAGS_KEY = "travel-photo-map:custom-tags";
let db;
let photos = [];
let visiblePhotos = [];
let activeTag = "";
let thumbUrls = [];
let detailUrl = null;
let activeId = null;
let stream = null;
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
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map(tag => typeof tag === "string" ? tag.trim() : "").filter(Boolean))].slice(0, MAX_TAGS_PER_PHOTO);
}
function loadCustomTags() {
  try {
    const stored = JSON.parse(localStorage.getItem(CUSTOM_TAGS_KEY) || "[]");
    return normalizeTags(stored).slice(0, MAX_CUSTOM_TAGS);
  } catch {
    return [];
  }
}
function saveCustomTags(tags) {
  try { localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags)); } catch {}
}
let customTags = loadCustomTags();
function availableTags() {
  return [...new Set([...DEFAULT_TAGS, ...customTags, ...photos.flatMap(photo => normalizeTags(photo.tags))])];
}
function createTag(rawName) {
  const tag = (rawName || "").trim();
  if (!tag) return;
  if (tag.length > 20) return toast("タグは20文字以内で入力してください");
  if (availableTags().includes(tag)) return toast("そのタグはすでにあります");
  if (customTags.length >= MAX_CUSTOM_TAGS) return toast(`タグは${MAX_CUSTOM_TAGS}個までです`);
  customTags = [...customTags, tag];
  saveCustomTags(customTags);
  activeTag = tag;
  applyFilter();
  toast(`「${tag}」を追加しました`);
}

async function persistPhotoRecord(photo) {
  const { thumbUrl, ...record } = photo;
  await putPhoto(db, record);
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
  for (const photo of photos) photo.tags = normalizeTags(photo.tags);
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
    const dateMatches = (!from || day >= from) && (!to || day <= to);
    return dateMatches && (!activeTag || normalizeTags(photo.tags).includes(activeTag));
  });
  $("photos-count").textContent = visiblePhotos.length ? `${visiblePhotos.length}枚の写真` : "写真を撮って残しましょう";
  renderTagFilters();
  $("photos-empty").hidden = visiblePhotos.length > 0;
  const grid = $("photos-grid");
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
    button.addEventListener("click", () => showPhoto(photo.id));
    grid.append(button);
  }
}

function renderTagFilters() {
  const tags = availableTags();
  if (activeTag && !tags.includes(activeTag)) activeTag = "";
  const row = $("photos-tag-filters");
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
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "tag-filter tag-filter-add";
  addButton.textContent = "＋ タグを追加";
  addButton.setAttribute("aria-label", "新しいタグを追加");
  addButton.addEventListener("click", () => createTag(prompt("新しいタグの名前を入力してください")));
  row.append(addButton);
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
}

async function saveFile(blob, { name = "写真", date = new Date().toISOString(), source = "camera" } = {}) {
  if (!blob || !blob.type.startsWith("image/")) throw new Error("写真ファイルを選んでください。");
  const thumb = await makeThumbnail(blob);
  const record = { id: photoId(), blob, thumb, name, date, source, tags: [] };
  await putPhoto(db, record);
  return record;
}

async function openCamera() {
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
    const photo = await saveFile(blob, { name: `撮影 ${prettyDate(new Date().toISOString())}` });
    stopCamera();
    await refresh();
    showPage("photos");
    showPhoto(photo.id);
    toast("写真を保存しました");
  } catch (error) { toast(`保存できませんでした: ${error.message}`); }
  finally { $("shutter").disabled = false; }
}

async function importFiles(files) {
  if (!files.length) return;
  let saved = 0;
  for (const file of files) {
    try {
      const exif = await readPhotoExif(file);
      const date = exif.date || (file.lastModified ? new Date(file.lastModified) : new Date()).toISOString();
      await saveFile(file, { name: file.name, date, source: "import" });
      saved++;
    } catch (error) { toast(`${file.name}を保存できませんでした: ${error.message}`); }
  }
  await refresh();
  showPage("photos");
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
  $("custom-tag").value = "";
  renderDetailTags(photo);
  $("photo-dialog").showModal();
}

function closePhoto() {
  $("photo-dialog").close();
  $("detail-image").removeAttribute("src");
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
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
    showPage("photos");
    toast(`${added.length}枚の写真を復元しました`);
  } catch (error) { toast(`復元できませんでした: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "ZIPファイルを選ぶ"; }
}

async function init() {
  try {
    db = await openDatabase();
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
  $("fallback-camera-input").addEventListener("change", async event => { await importFiles([...event.target.files]); event.target.value = ""; });
  $("filter-toggle").addEventListener("click", () => { const panel = $("filter-panel"); panel.hidden = !panel.hidden; $("filter-toggle").setAttribute("aria-expanded", String(!panel.hidden)); });
  $("date-from").addEventListener("change", applyFilter);
  $("date-to").addEventListener("change", applyFilter);
  $("filter-clear").addEventListener("click", () => { $("date-from").value = ""; $("date-to").value = ""; activeTag = ""; applyFilter(); });
  $("photo-close").addEventListener("click", closePhoto);
  $("photo-dialog").addEventListener("close", () => { if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; } });
  $("add-custom-tag").addEventListener("click", addCustomTag);
  $("custom-tag").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addCustomTag(); } });
  $("backup-button").addEventListener("click", exportBackup);
  $("restore-button").addEventListener("click", () => $("restore-input").click());
  $("restore-input").addEventListener("change", async event => { await restoreBackup(event.target.files[0]); event.target.value = ""; });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(registration => {
      registration.update().catch(() => {});
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") registration.update().catch(() => {}); });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
}

init();
