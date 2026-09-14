const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, size, crc) {
  const bytes = encoder.encode(name);
  const data = new Uint8Array(30 + bytes.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, bytes.length, true);
  data.set(bytes, 30);
  return data;
}

function centralHeader(name, size, crc, offset) {
  const bytes = encoder.encode(name);
  const data = new Uint8Array(46 + bytes.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, bytes.length, true);
  view.setUint32(42, offset, true);
  data.set(bytes, 46);
  return data;
}

export async function makeBackup(photos) {
  const manifest = {
    app: "travel-photo-map",
    version: 1,
    exportedAt: new Date().toISOString(),
    photos: photos.map(({ id, date, lat, lng, accuracy, source, name, blob }) => ({
      id, date, lat, lng, accuracy, source, name, type: blob.type,
      file: `photos/${id}`,
    })),
  };
  const files = [{ name: "manifest.json", blob: new Blob([JSON.stringify(manifest)], { type: "application/json" }) },
    ...photos.map(photo => ({ name: `photos/${photo.id}`, blob: photo.blob }))];
  if (files.length > 65535) throw new Error("写真の枚数が多すぎます。分けてバックアップしてください。");
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const size = file.blob.size;
    if (size > 0xffffffff || offset + size > 0xffffffff) throw new Error("バックアップが4GBを超えます。");
    const crc = crc32(new Uint8Array(await file.blob.arrayBuffer()));
    const header = localHeader(file.name, size, crc);
    parts.push(header, file.blob);
    directory.push(centralHeader(file.name, size, crc, offset));
    offset += header.length + size;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

export async function readBackup(file) {
  if (file.size > 0xffffffff) throw new Error("4GBを超えるバックアップには対応していません。");
  const files = new Map();
  let pos = 0;
  while (pos + 30 <= file.size) {
    const header = new DataView(await file.slice(pos, pos + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) break;
    const method = header.getUint16(8, true);
    const crc = header.getUint32(14, true);
    const size = header.getUint32(18, true);
    const compressedSize = header.getUint32(22, true);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = pos + 30 + nameLength + extraLength;
    if (method !== 0 || compressedSize !== size || start + size > file.size || files.size > 10000) throw new Error("対応していないバックアップ形式です。");
    const name = decoder.decode(await file.slice(pos + 30, pos + 30 + nameLength).arrayBuffer());
    const content = file.slice(start, start + size);
    if (crc32(new Uint8Array(await content.arrayBuffer())) !== crc || files.has(name)) throw new Error("バックアップが破損しています。");
    files.set(name, content);
    pos = start + size;
  }
  if (!files.has("manifest.json")) throw new Error("このアプリのバックアップではありません。");
  let manifest;
  try { manifest = JSON.parse(await files.get("manifest.json").text()); }
  catch { throw new Error("バックアップの管理情報を読めません。"); }
  if (manifest.app !== "travel-photo-map" || manifest.version !== 1 || !Array.isArray(manifest.photos)) throw new Error("対応していないバックアップです。");
  if (manifest.photos.length > 10000) throw new Error("写真の枚数が多すぎます。");
  const records = [];
  for (const item of manifest.photos) {
    if (typeof item.id !== "string" || !/^[0-9a-f-]{36}$/i.test(item.id) || item.file !== `photos/${item.id}` || !files.has(item.file) ||
        typeof item.date !== "string" || Number.isNaN(Date.parse(item.date)) ||
        (item.lat != null && (typeof item.lat !== "number" || Math.abs(item.lat) > 90)) ||
        (item.lng != null && (typeof item.lng !== "number" || Math.abs(item.lng) > 180)) ||
        typeof item.type !== "string" || !item.type.startsWith("image/")) throw new Error("バックアップの写真情報が正しくありません。");
    records.push({
      id: item.id, date: item.date, lat: item.lat ?? null, lng: item.lng ?? null,
      accuracy: item.accuracy ?? null, source: item.source || "restore", name: item.name || "写真",
      blob: new Blob([files.get(item.file)], { type: item.type }),
    });
  }
  return records;
}
