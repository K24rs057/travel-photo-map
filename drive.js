const CLIENT_ID_KEY = "travel-photo-map:drive-client-id";
const FOLDER_ID_KEY = "travel-photo-map:drive-folder-id";
const FOLDER_NAME = "旅の思い出";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

let gsiLoadPromise = null;
let tokenClient = null;
let accessToken = null;
let accessTokenExpiry = 0;

export function getClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || "";
}
export function setClientId(clientId) {
  localStorage.setItem(CLIENT_ID_KEY, clientId.trim());
  tokenClient = null;
}
export function isConfigured() {
  return Boolean(getClientId());
}

function loadGsiScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiLoadPromise) return gsiLoadPromise;
  gsiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Googleのログイン部品を読み込めませんでした。通信を確認してください。"));
    document.head.append(script);
  });
  return gsiLoadPromise;
}

async function ensureTokenClient() {
  const clientId = getClientId();
  if (!clientId) throw new Error("Googleドライブのクライアント ID が設定されていません。");
  await loadGsiScript();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    });
  }
  return tokenClient;
}

export function isSignedIn() {
  return Boolean(accessToken) && Date.now() < accessTokenExpiry;
}

export async function signIn() {
  const client = await ensureTokenClient();
  return new Promise((resolve, reject) => {
    client.callback = response => {
      if (response.error) return reject(new Error("Googleへのログインに失敗しました。"));
      accessToken = response.access_token;
      accessTokenExpiry = Date.now() + (Number(response.expires_in) || 3000) * 1000;
      resolve(accessToken);
    };
    client.requestAccessToken({ prompt: isSignedIn() ? "" : "consent" });
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  accessTokenExpiry = 0;
}

async function getToken() {
  if (isSignedIn()) return accessToken;
  return signIn();
}

async function driveFetch(url, options = {}) {
  const token = await getToken();
  const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Googleドライブとの通信に失敗しました (${response.status})`);
  return response;
}

export async function ensureFolder() {
  const cached = localStorage.getItem(FOLDER_ID_KEY);
  if (cached) return cached;
  const query = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchResponse = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive`);
  const searchResult = await searchResponse.json();
  if (searchResult.files?.length) {
    localStorage.setItem(FOLDER_ID_KEY, searchResult.files[0].id);
    return searchResult.files[0].id;
  }
  const createResponse = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  const created = await createResponse.json();
  localStorage.setItem(FOLDER_ID_KEY, created.id);
  return created.id;
}

function sanitizeFileNamePart(text) {
  return text.replace(/[\\/:*?"<>|]/g, "-").trim();
}

function buildPhotoFileName(photo) {
  const day = photo.date ? photo.date.slice(0, 10) : "";
  const tags = Array.isArray(photo.tags) ? photo.tags.filter(Boolean) : [];
  const parts = [day, ...tags].map(sanitizeFileNamePart).filter(Boolean);
  return `${parts.length ? parts.join("_") : photo.id}.jpg`;
}

export async function uploadPhoto(folderId, photo) {
  const tags = Array.isArray(photo.tags) ? photo.tags.filter(Boolean) : [];
  const metadata = {
    name: buildPhotoFileName(photo),
    parents: [folderId],
    description: tags.length ? `タグ: ${tags.join(", ")}` : "",
  };
  const boundary = `travelphotomap-${photo.id}`;
  const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const closingPart = `\r\n--${boundary}--`;
  const body = new Blob([metadataPart, `--${boundary}\r\nContent-Type: ${photo.blob.type}\r\n\r\n`, photo.blob, closingPart]);
  const response = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const result = await response.json();
  return result.id;
}

export async function updatePhotoMetadata(photo) {
  const tags = Array.isArray(photo.tags) ? photo.tags.filter(Boolean) : [];
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${photo.driveId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: buildPhotoFileName(photo), description: tags.length ? `タグ: ${tags.join(", ")}` : "" }),
  });
}

export async function listShares(folderId) {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=permissions(id,emailAddress,role)`);
  const result = await response.json();
  return (result.permissions || []).filter(permission => permission.role !== "owner" && permission.emailAddress);
}

export async function shareFolder(folderId, email) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?sendNotificationEmail=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "user", role: "reader", emailAddress: email }),
  });
}

export async function removeShare(folderId, permissionId) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${permissionId}`, { method: "DELETE" });
}

export function folderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
