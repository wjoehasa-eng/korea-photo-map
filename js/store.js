// IndexedDB 저장소 · 사진 압축 · 백업
const DB_NAME = "korea-photo-map";
const DB_VERSION = 2;
const STORES = { trips: "trips", photos: "photos", regions: "regions" };

let dbPromise = null;

function req(target) {
  return new Promise((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error);
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORES.trips)) {
        const s = db.createObjectStore(STORES.trips, { keyPath: "id" });
        s.createIndex("regionCode", "regionCode");
      }
      if (!db.objectStoreNames.contains(STORES.photos)) {
        const s = db.createObjectStore(STORES.photos, { keyPath: "id" });
        s.createIndex("tripId", "tripId");
      }
      if (!db.objectStoreNames.contains(STORES.regions)) {
        db.createObjectStore(STORES.regions, { keyPath: "regionCode" });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function store(name, mode = "readonly") {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

async function txDone(name, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const s = t.objectStore(name);
    let result;
    try {
      result = fn(s);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ── 사진 처리 ────────────────────────────────────────────────
async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) { /* fall through */ }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지를 읽을 수 없어요")); };
    img.src = url;
  });
}

async function renderJpeg(bitmap, maxSize, quality) {
  const sw = bitmap.width || bitmap.naturalWidth;
  const sh = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  return { blob, w, h };
}

export async function processImage(file, { max = 1500, thumbMax = 520 } = {}) {
  const bitmap = await loadBitmap(file);
  const main = await renderJpeg(bitmap, max, 0.84);
  const thumb = await renderJpeg(bitmap, thumbMax, 0.72);
  if (bitmap.close) bitmap.close();
  return { blob: main.blob, w: main.w, h: main.h, thumb: thumb.blob };
}

// ── 읽기 ────────────────────────────────────────────────────
export async function listTrips() {
  const s = await store(STORES.trips);
  const all = await req(s.getAll());
  return all.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
}

export async function listPhotos() {
  const s = await store(STORES.photos);
  return await req(s.getAll());
}

export async function tripsForRegion(code) {
  const s = await store(STORES.trips);
  const trips = await req(s.index("regionCode").getAll(code));
  return trips.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));
}

export async function photoBlob(photoId) {
  if (!photoId) return null;
  const s = await store(STORES.photos);
  const p = await req(s.get(photoId));
  return p?.blob || null;
}

export async function thumbBlob(photoId) {
  if (!photoId) return null;
  const s = await store(STORES.photos);
  const p = await req(s.get(photoId));
  return p?.thumb || p?.blob || null;
}

export async function getTripRecord(tripId) {
  if (!tripId) return null;
  const s = await store(STORES.trips);
  return (await req(s.get(tripId))) || null;
}

export async function getPhotoRecord(photoId) {
  if (!photoId) return null;
  const s = await store(STORES.photos);
  return (await req(s.get(photoId))) || null;
}

// 드라이브에서 받아 온 사진을 기기 캐시에 넣는다.
export async function setPhotoBlob(photoId, blob, kind = "full") {
  if (!photoId || !blob) return null;
  const s = await store(STORES.photos);
  const p = await req(s.get(photoId));
  if (!p) return null;
  const next = kind === "thumb" ? { ...p, thumb: blob } : { ...p, blob };
  await txDone(STORES.photos, "readwrite", (st) => st.put(next));
  return next;
}

// 사진 레코드에 드라이브 파일 ID를 붙인다(올린 뒤 · 목록 동기화 때).
export async function setPhotoDrive(photoId, driveFileId, extra = {}) {
  if (!photoId || !driveFileId) return null;
  const s = await store(STORES.photos);
  const p = await req(s.get(photoId));
  if (!p) return null;
  const next = { ...p, ...extra, driveFileId };
  await txDone(STORES.photos, "readwrite", (st) => st.put(next));
  return next;
}

// 동기화로 만든 원격 기록을 그대로 저장한다(없으면 추가, 있으면 갱신).
export async function putTripRecord(trip) {
  if (!trip?.id) return null;
  await txDone(STORES.trips, "readwrite", (s) => s.put(trip));
  return trip;
}

export async function putPhotoRecord(photo) {
  if (!photo?.id) return null;
  await txDone(STORES.photos, "readwrite", (s) => s.put(photo));
  return photo;
}

// ── 지역 메타(지도의 대표 사진) ───────────────────────
// 일기(여행 기록)의 대표 사진과 별개로, 지도에 칠할 대표 사진을 지역마다 하나 둔다.
export async function listRegionCovers() {
  const s = await store(STORES.regions);
  return await req(s.getAll());
}

export async function getRegionCover(code) {
  if (!code) return null;
  const s = await store(STORES.regions);
  const r = await req(s.get(code));
  return r?.coverPhotoId || null;
}

export async function setRegionCoverRecord(code, photoId, { regionName = "" } = {}) {
  if (!code) return null;
  const rec = { regionCode: code, regionName, coverPhotoId: photoId || "", updatedAt: Date.now() };
  await txDone(STORES.regions, "readwrite", (s) => s.put(rec));
  return rec;
}

export async function putRegionRecord(rec) {
  if (!rec?.regionCode) return null;
  await txDone(STORES.regions, "readwrite", (s) => s.put(rec));
  return rec;
}

// ── 쓰기 ────────────────────────────────────────────────────
export async function createTrip({ regionCode, date, title, memo, photos = [], coverIndex = 0, sample = false }) {
  const id = uid("trip");
  const now = Date.now();
  const photoRecs = photos.map((p, i) => ({
    id: uid("ph"),
    tripId: id,
    regionCode,
    blob: p.blob,
    thumb: p.thumb,
    w: p.w,
    h: p.h,
    order: i,
    sample,
    createdAt: now + i,
  }));
  const cover = photoRecs[Math.min(coverIndex, photoRecs.length - 1)]?.id || null;
  const trip = {
    id, regionCode, date, title: title || "", memo: memo || "",
    photoIds: photoRecs.map((p) => p.id),
    coverPhotoId: cover,
    sample,
    createdAt: now,
  };
  await txDone(STORES.trips, "readwrite", (s) => {
    s.put(trip);
  });
  if (photoRecs.length) {
    await txDone(STORES.photos, "readwrite", (s) => {
      for (const p of photoRecs) s.put(p);
    });
  }
  return trip;
}

export async function addPhotosToTrip(trip, processed) {
  const now = Date.now();
  const recs = processed.map((p, i) => ({
    id: uid("ph"), tripId: trip.id, regionCode: trip.regionCode,
    blob: p.blob, thumb: p.thumb, w: p.w, h: p.h,
    order: (trip.photoIds?.length || 0) + i, sample: !!trip.sample, createdAt: now + i,
  }));
  await txDone(STORES.photos, "readwrite", (s) => {
    for (const p of recs) s.put(p);
  });
  const updated = {
    ...trip,
    photoIds: [...(trip.photoIds || []), ...recs.map((r) => r.id)],
    coverPhotoId: trip.coverPhotoId || recs[0]?.id || null,
  };
  await txDone(STORES.trips, "readwrite", (s) => s.put(updated));
  return updated;
}

export async function updateTrip(trip) {
  await txDone(STORES.trips, "readwrite", (s) => s.put(trip));
  return trip;
}

export async function deletePhoto(photoId) {
  await txDone(STORES.photos, "readwrite", (s) => s.delete(photoId));
}

export async function deleteTrip(trip) {
  await txDone(STORES.trips, "readwrite", (s) => s.delete(trip.id));
  await txDone(STORES.photos, "readwrite", (s) => {
    for (const id of trip.photoIds || []) s.delete(id);
  });
}

export async function clearSamples() {
  const trips = await listTrips();
  const samples = trips.filter((t) => t.sample);
  for (const t of samples) await deleteTrip(t);
  return samples.length;
}

export async function isEmpty() {
  const trips = await listTrips();
  return trips.length === 0;
}

// ── 백업 ────────────────────────────────────────────────────
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return await res.blob();
}

export async function exportBackup() {
  const trips = await listTrips();
  const photos = await listPhotos();
  const byId = new Map(photos.map((p) => [p.id, p]));
  const out = { app: "korea-photo-map", version: 1, exportedAt: new Date().toISOString(), trips: [] };
  for (const t of trips) {
    const ps = [];
    for (const pid of t.photoIds || []) {
      const p = byId.get(pid);
      if (!p) continue;
      ps.push({ id: p.id, data: await blobToDataURL(p.blob), w: p.w, h: p.h });
    }
    out.trips.push({ ...t, photos: ps });
  }
  return out;
}

export async function importBackup(json, { merge = true } = {}) {
  if (!json || json.app !== "korea-photo-map" || !Array.isArray(json.trips)) {
    throw new Error("이 앱의 백업 파일이 아니에요");
  }
  const existing = await listTrips();
  const seen = new Set(existing.map((t) => `${t.regionCode}|${t.date}|${t.title}|${t.createdAt}`));
  let added = 0;
  for (const t of json.trips) {
    const key = `${t.regionCode}|${t.date}|${t.title}|${t.createdAt ?? ""}`;
    if (merge && seen.has(key)) continue;
    const photos = [];
    for (const p of t.photos || []) {
      const blob = await dataURLToBlob(p.data);
      const thumbSmall = await dataURLToBlob(p.data);
      photos.push({ blob, thumb: thumbSmall, w: p.w, h: p.h, oldId: p.id });
    }
    const trip = await createTrip({
      regionCode: t.regionCode, date: t.date, title: t.title, memo: t.memo,
      photos, coverIndex: 0, sample: !!t.sample,
    });
    seen.add(key);
    // 대표 사진 복원
    const oldCoverIdx = (t.photoIds || []).indexOf(t.coverPhotoId);
    if (oldCoverIdx > 0 && trip.photoIds[oldCoverIdx]) {
      await updateTrip({ ...trip, coverPhotoId: trip.photoIds[oldCoverIdx] });
    }
    added++;
  }
  return added;
}
