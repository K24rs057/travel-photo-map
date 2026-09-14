// Minimal JPEG EXIF reader: GPS position and original capture time only.
function readString(view, offset, length) {
  if (offset < 0 || offset + length > view.byteLength) return "";
  let result = "";
  for (let i = 0; i < length; i++) result += String.fromCharCode(view.getUint8(offset + i));
  return result;
}

function readExif(view, tiff, limit) {
  if (tiff + 8 > limit) return {};
  const endian = readString(view, tiff, 2);
  if (endian !== "II" && endian !== "MM") return {};
  const little = endian === "II";
  const u16 = offset => offset + 2 <= limit ? view.getUint16(offset, little) : 0;
  const u32 = offset => offset + 4 <= limit ? view.getUint32(offset, little) : 0;
  if (u16(tiff + 2) !== 42) return {};
  const value = (entry, type, count) => {
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
    const size = (sizes[type] || 0) * count;
    if (!size || size > 4096) return null;
    const pos = size <= 4 ? entry + 8 : tiff + u32(entry + 8);
    if (pos < tiff || pos + size > limit) return null;
    if (type === 2) return readString(view, pos, count).replace(/\0.*$/, "");
    if (type === 3) return Array.from({ length: count }, (_, i) => u16(pos + i * 2));
    if (type === 4) return Array.from({ length: count }, (_, i) => u32(pos + i * 4));
    if (type === 5) return Array.from({ length: count }, (_, i) => {
      const denominator = u32(pos + i * 8 + 4);
      return denominator ? u32(pos + i * 8) / denominator : 0;
    });
    return null;
  };
  const directory = offset => {
    const pos = tiff + offset;
    if (pos < tiff || pos + 2 > limit) return {};
    const count = Math.min(u16(pos), 128);
    if (pos + 2 + count * 12 > limit) return {};
    const tags = {};
    for (let i = 0; i < count; i++) {
      const entry = pos + 2 + i * 12;
      tags[u16(entry)] = value(entry, u16(entry + 2), u32(entry + 4));
    }
    return tags;
  };
  const root = directory(u32(tiff + 4));
  const exif = root[0x8769]?.[0] ? directory(root[0x8769][0]) : {};
  const gps = root[0x8825]?.[0] ? directory(root[0x8825][0]) : {};
  const coord = (parts, ref) => {
    if (!Array.isArray(parts) || parts.length < 3 || typeof ref !== "string") return null;
    const n = parts[0] + parts[1] / 60 + parts[2] / 3600;
    return Number.isFinite(n) ? n * (ref === "S" || ref === "W" ? -1 : 1) : null;
  };
  const lat = coord(gps[2], gps[1]);
  const lng = coord(gps[4], gps[3]);
  let date = null;
  const rawDate = exif[0x9003] || root[0x0132];
  if (typeof rawDate === "string" && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(rawDate)) {
    const parsed = new Date(rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString();
  }
  return { lat: lat !== null && Math.abs(lat) <= 90 ? lat : null, lng: lng !== null && Math.abs(lng) <= 180 ? lng : null, date };
}

export async function readPhotoExif(blob) {
  if (!/^image\/jpe?g$/i.test(blob.type)) return {};
  const buffer = await blob.slice(0, 256 * 1024).arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};
  let pos = 2;
  while (pos + 4 <= view.byteLength) {
    if (view.getUint8(pos) !== 0xff) break;
    const marker = view.getUint8(pos + 1);
    const length = view.getUint16(pos + 2);
    if (length < 2 || pos + 2 + length > view.byteLength) break;
    if (marker === 0xe1 && readString(view, pos + 4, 6) === "Exif\0\0") {
      return readExif(view, pos + 10, pos + 2 + length);
    }
    pos += 2 + length;
  }
  return {};
}
