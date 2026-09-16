import { MUNICIPALITIES } from "./municipalities.js";

const ENDPOINT = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";

export function placeFromResponse(payload) {
  const code = String(payload?.results?.muniCd || "").padStart(5, "0");
  const place = MUNICIPALITIES[code];
  if (!place) throw new Error("市区町村を特定できませんでした");
  return { prefecture: place[0], municipality: place[1], municipalityCode: code };
}

export async function reverseGeocode(lat, lng, fetcher = fetch) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`住所情報を取得できませんでした (${response.status})`);
    return placeFromResponse(await response.json());
  } finally {
    clearTimeout(timer);
  }
}
