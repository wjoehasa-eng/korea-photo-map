// 구글 드라이브(Apps Script 웹앱) 연동 · 동기화
// ─────────────────────────────────────────────────────────────
// - 웹앱 주소는 이 브라우저(localStorage)에만 저장한다. 공개 저장소에는 절대 넣지 않는다.
// - 주소가 없으면 앱은 지금처럼 100% 로컬(IndexedDB)로 동작한다.
// - 주소가 있으면 앱을 켤 때 시트와 맞추고, 기기 저장소는 오프라인·속도용 캐시로 함께 쓴다.
import {
  listTrips, listPhotos, putTripRecord, putPhotoRecord, setPhotoDrive, setPhotoBlob,
  listRegionCovers, setRegionCoverRecord, putRegionRecord, getRegionCover,
} from "./store.js?v=3";

const URL_KEY = "kpm.cloud.url";
const TOMB_KEY = "kpm.cloud.tombstones";
const LAST_KEY = "kpm.cloud.lastSync";
const TIMEOUT_MS = 90000;

let regionNameFor = () => "";
export function setRegionNameResolver(fn) {
  regionNameFor = typeof fn === "function" ? fn : () => "";
}

function lsGet(key, fallback = "") {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    /* 저장 공간이 막혀 있어도 앱은 계속 돈다 */
  }
}

// ── 주소 설정 ────────────────────────────────────────────────
export function getUrl() {
  return (lsGet(URL_KEY) || "").trim();
}

export function setUrl(url) {
  const t = String(url || "").trim();
  lsSet(URL_KEY, t || null);
}

export function enabled() {
  return /^https?:\/\//i.test(getUrl());
}

export function lastSync() {
  try {
    return JSON.parse(lsGet(LAST_KEY, "null"));
  } catch {
    return null;
  }
}

function rememberSync(summary) {
  lsSet(LAST_KEY, JSON.stringify(summary));
}

// ── 서버 호출 ────────────────────────────────────────────────
async function call(payload, { timeout = TIMEOUT_MS } = {}) {
  const url = getUrl();
  if (!url) throw new Error("구글 드라이브 주소가 없어요");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      // text/plain 이라야 브라우저가 사전 확인(프리플라이트) 없이 바로 보낸다.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: ctrl.signal,
    });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    throw new Error(aborted ? "응답이 너무 늦어요 (시간 초과)" : "인터넷 연결을 확인해 주세요");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("응답을 읽지 못했어요 · 배포 주소(…/exec)와 액세스 권한(모든 사용자)을 확인해 주세요");
  }
  if (data && data.ok === false) throw new Error(data.error || "시트 쪽에서 거부했어요");
  return data;
}

export async function ping() {
  return await call({ action: "ping" }, { timeout: 20000 });
}

// ── 목록 ────────────────────────────────────────────────────
function ts(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

function normTrip(t) {
  return {
    id: String(t?.id || ""),
    regionCode: String(t?.regionCode || ""),
    regionName: String(t?.regionName || ""),
    date: String(t?.date || ""),
    title: String(t?.title || ""),
    memo: String(t?.memo || ""),
    coverPhotoId: String(t?.coverPhotoId || ""),
    createdAt: String(t?.createdAt || ""),
  };
}

function normPhoto(p) {
  return {
    photoId: String(p?.photoId || ""),
    tripId: String(p?.tripId || ""),
    regionCode: String(p?.regionCode || ""),
    driveFileId: String(p?.driveFileId || ""),
    fileName: String(p?.fileName || ""),
    mimeType: String(p?.mimeType || "image/jpeg"),
    isCover: !!p?.isCover,
    order: Number(p?.order) || 0,
    createdAt: String(p?.createdAt || ""),
  };
}

export async function fetchList() {
  const d = await call({ action: "list" });
  return {
    trips: (d.trips || []).map(normTrip).filter((t) => t.id),
    photos: (d.photos || []).map(normPhoto).filter((p) => p.photoId),
    regions: (d.regions || []).map(normRegion).filter((r) => r.regionCode),
  };
}

function normRegion(r) {
  return {
    regionCode: String(r?.regionCode || ""),
    regionName: String(r?.regionName || ""),
    coverPhotoId: String(r?.coverPhotoId || ""),
    updatedAt: String(r?.updatedAt || ""),
  };
}

// ── 사진 내려받기 ───────────────────────────────────────────
export async function downloadPhotoBlob(photo, kind = "full") {
  if (!photo) return null;
  const d = await call({
    action: "photo",
    id: photo.driveFileId || "",
    pid: photo.id || photo.photoId || "",
    size: kind === "thumb" ? "thumb" : "full",
  }, { timeout: 60000 });
  if (!d.dataUrl) return null;
  const r = await fetch(d.dataUrl);
  return await r.blob();
}

// ── 올리기 ──────────────────────────────────────────────────
function isoOf(ms) {
  if (!ms) return new Date().toISOString();
  const n = typeof ms === "number" ? ms : Date.parse(String(ms));
  return new Date(Number.isFinite(n) && n > 0 ? n : Date.now()).toISOString();
}

function fileNameFor(trip, order, regionCode) {
  const name = (trip && trip.regionName) || regionNameFor(regionCode) || regionCode || "여행";
  const date = (trip && trip.date) || "";
  const n = String((Number(order) || 0) + 1).padStart(2, "0");
  return `${name}_${date}_${n}.jpg`.replace(/\s+/g, "");
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("사진을 읽지 못했어요"));
    fr.readAsDataURL(blob);
  });
}

export async function saveTripRemote(trip, regionName) {
  const d = await call({
    action: "saveTrip",
    trip: {
      id: trip.id,
      regionCode: trip.regionCode,
      regionName: regionName || trip.regionName || regionNameFor(trip.regionCode),
      date: trip.date || "",
      title: trip.title || "",
      memo: trip.memo || "",
      coverPhotoId: trip.coverPhotoId || "",
      createdAt: isoOf(trip.createdAt),
    },
  });
  return d.trip;
}

export async function uploadPhotoRemote({ tripId, regionCode, photoId, fileName, mimeType, isCover, order, blob, thumb }) {
  if (!blob) throw new Error("올릴 사진이 없어요");
  const data = await blobToDataURL(blob);
  const thumbData = thumb ? await blobToDataURL(thumb) : "";
  const d = await call({
    action: "uploadPhoto",
    tripId,
    regionCode,
    photoId,
    fileName: fileName || "",
    mimeType: mimeType || blob.type || "image/jpeg",
    isCover: !!isCover,
    order: Number(order) || 0,
    data,
    thumb: thumbData,
  });
  return d.photo;
}

export async function setCoverRemote(tripId, photoId) {
  return await call({ action: "setTripCover", tripId, photoId });
}

// 지도 대표 사진(지역 메타)을 바꾼다. 일기 대표 사진과는 별개다.
export async function setRegionCoverRemote(regionCode, photoId, regionName) {
  if (!regionCode) return null;
  return await call({ action: "setRegionCover", regionCode, photoId: photoId || "", regionName: regionName || "" });
}

export async function deletePhotoRemote(photoId) {
  return await call({ action: "deletePhoto", photoId });
}

export async function deleteTripRemote(tripId) {
  return await call({ action: "deleteTrip", tripId });
}

// ── 한 건 밀어 올리기(앱에서 기록·사진을 바꾼 직후) ────────
export async function pushTrip(tripId, { onStatus } = {}) {
  if (!enabled()) return { skipped: true };
  const trip = (await listTrips()).find((t) => t.id === tripId);
  if (!trip || trip.sample) return { skipped: true };

  await saveTripRemote(trip);

  const photos = (await listPhotos())
    .filter((p) => p.tripId === tripId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  let uploaded = 0;
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (p.driveFileId || !p.blob) continue;
    onStatus?.(`사진 올리는 중… ${i + 1}/${photos.length}`);
    const info = await uploadPhotoRemote({
      tripId,
      regionCode: p.regionCode || trip.regionCode,
      photoId: p.id,
      fileName: fileNameFor(trip, p.order, p.regionCode || trip.regionCode),
      mimeType: p.blob.type || "image/jpeg",
      isCover: p.id === trip.coverPhotoId,
      order: p.order || 0,
      blob: p.blob,
      thumb: p.thumb || null,
    });
    if (info && info.driveFileId) await setPhotoDrive(p.id, info.driveFileId);
    uploaded++;
  }

  if (trip.coverPhotoId) await setCoverRemote(trip.id, trip.coverPhotoId);

  // 이 지역의 지도 대표 사진도 함께 맞춰 둔다.
  const regionCover = await getRegionCover(trip.regionCode);
  if (regionCover) {
    await setRegionCoverRemote(trip.regionCode, regionCover, trip.regionName || regionNameFor(trip.regionCode));
  }
  return { ok: true, tripId, uploaded, photos: photos.length };
}

// ── 지운 것 기억해 두기(오프라인이었다가 다음 동기화에 반영) ─
function readTombs() {
  try {
    const o = JSON.parse(lsGet(TOMB_KEY, "{}"));
    return {
      trips: Array.isArray(o.trips) ? o.trips : [],
      photos: Array.isArray(o.photos) ? o.photos : [],
    };
  } catch {
    return { trips: [], photos: [] };
  }
}

function writeTombs(t) {
  lsSet(TOMB_KEY, JSON.stringify({ trips: t.trips || [], photos: t.photos || [] }));
}

export function addTombstone(kind, id) {
  if (!id) return;
  const t = readTombs();
  const key = kind === "trip" ? "trips" : "photos";
  if (!t[key].includes(id)) t[key].push(id);
  writeTombs(t);
}

// ── 전체 맞추기 ─────────────────────────────────────────────
export async function syncAll({ onStatus } = {}) {
  const empty = { ok: true, disabled: true, pushedTrips: 0, pushedPhotos: 0, pulledTrips: 0, pulledPhotos: 0 };
  if (!enabled()) return empty;

  // 1) 오프라인 때 지운 것부터 서버에 반영
  const tombs = readTombs();
  if (tombs.trips.length || tombs.photos.length) {
    const leftTrips = [];
    const leftPhotos = [];
    onStatus?.("지운 항목을 정리하는 중…");
    for (const id of tombs.trips) {
      try { await deleteTripRemote(id); } catch { leftTrips.push(id); }
    }
    for (const id of tombs.photos) {
      try { await deletePhotoRemote(id); } catch { leftPhotos.push(id); }
    }
    writeTombs({ trips: leftTrips, photos: leftPhotos });
  }

  onStatus?.("드라이브 목록을 받는 중…");
  let remote = await fetchList();

  const remoteTripIds = new Set(remote.trips.map((t) => t.id));
  const remotePhotoIds = new Set(remote.photos.map((p) => p.photoId));

  let localTrips = await listTrips();
  let localPhotos = await listPhotos();
  const tripById = new Map(localTrips.map((t) => [t.id, t]));

  // 2) 이 기기에만 있는 여행 기록 올리기
  let pushedTrips = 0;
  for (const t of localTrips) {
    if (t.sample || remoteTripIds.has(t.id)) continue;
    onStatus?.(`기록 올리는 중… ${[t.date, t.title].filter(Boolean).join(" ")}`.trim());
    await saveTripRemote(t);
    remoteTripIds.add(t.id);
    pushedTrips++;
  }

  // 3) 이 기기에만 있는 사진 올리기
  const toPush = localPhotos.filter(
    (p) => !p.remote && !p.driveFileId && p.blob && remoteTripIds.has(p.tripId) && !remotePhotoIds.has(p.id)
  );
  let pushedPhotos = 0;
  for (let i = 0; i < toPush.length; i++) {
    const p = toPush[i];
    const trip = tripById.get(p.tripId);
    onStatus?.(`사진 올리는 중… ${i + 1}/${toPush.length}`);
    const info = await uploadPhotoRemote({
      tripId: p.tripId,
      regionCode: p.regionCode || trip?.regionCode || "",
      photoId: p.id,
      fileName: fileNameFor(trip, p.order, p.regionCode || trip?.regionCode || ""),
      mimeType: p.blob.type || "image/jpeg",
      isCover: !!trip && trip.coverPhotoId === p.id,
      order: p.order || 0,
      blob: p.blob,
      thumb: p.thumb || null,
    });
    if (info && info.driveFileId) await setPhotoDrive(p.id, info.driveFileId);
    pushedPhotos++;
  }

  // 4) 대표 사진이 어긋나 있으면 시트에도 맞춘다
  for (const t of localTrips) {
    if (t.sample || !t.coverPhotoId) continue;
    const rt = remote.trips.find((x) => x.id === t.id);
    if (!rt || rt.coverPhotoId === t.coverPhotoId) continue;
    try {
      await setCoverRemote(t.id, t.coverPhotoId);
      rt.coverPhotoId = t.coverPhotoId;
    } catch {
      /* 다음 동기화에 다시 */
    }
  }

  // 5) 드라이브에만 있는 기록·사진 받기
  //    (지도 대표 사진 = 지역 메타도 이때 함께 맞춘다)
  const localRegions = await listRegionCovers();
  let pushedRegions = 0;
  for (const lr of localRegions) {
    if (!lr.coverPhotoId) continue;
    const rr = (remote.regions || []).find((x) => x.regionCode === lr.regionCode);
    if (rr && rr.coverPhotoId === lr.coverPhotoId) continue;
    try {
      await setRegionCoverRemote(lr.regionCode, lr.coverPhotoId, lr.regionName || regionNameFor(lr.regionCode));
      pushedRegions++;
    } catch {
      /* 다음 동기화에 */
    }
  }

  let pulledRegions = 0;
  for (const rr of remote.regions || []) {
    if (!rr.coverPhotoId) continue;
    const lr = localRegions.find((x) => x.regionCode === rr.regionCode);
    if (!lr) {
      await putRegionRecord({
        regionCode: rr.regionCode,
        regionName: rr.regionName,
        coverPhotoId: rr.coverPhotoId,
        updatedAt: ts(rr.updatedAt) || Date.now(),
      });
      pulledRegions++;
    } else if (!lr.coverPhotoId) {
      await setRegionCoverRecord(rr.regionCode, rr.coverPhotoId, { regionName: rr.regionName || lr.regionName || "" });
      pulledRegions++;
    }
  }
  if (pushedTrips || pushedPhotos) {
    onStatus?.("시트 목록을 다시 확인하는 중…");
    remote = await fetchList();
  }

  const photosByTrip = new Map();
  for (const p of remote.photos) {
    if (!photosByTrip.has(p.tripId)) photosByTrip.set(p.tripId, []);
    photosByTrip.get(p.tripId).push(p);
  }
  for (const list of photosByTrip.values()) {
    list.sort((a, b) => (a.order || 0) - (b.order || 0) || (ts(a.createdAt) - ts(b.createdAt)));
  }

  localTrips = await listTrips();
  localPhotos = await listPhotos();
  const haveTripIds = new Set(localTrips.map((t) => t.id));
  const havePhotoIds = new Set(localPhotos.map((p) => p.id));

  let pulledTrips = 0;
  let pulledPhotos = 0;

  for (const rt of remote.trips) {
    if (haveTripIds.has(rt.id)) continue;
    const list = photosByTrip.get(rt.id) || [];
    const photoIds = list.map((p) => p.photoId);
    const cover = rt.coverPhotoId || list.find((p) => p.isCover)?.photoId || photoIds[0] || null;
    await putTripRecord({
      id: rt.id,
      regionCode: rt.regionCode,
      regionName: rt.regionName,
      date: rt.date,
      title: rt.title,
      memo: rt.memo,
      photoIds,
      coverPhotoId: cover,
      sample: false,
      remote: true,
      createdAt: ts(rt.createdAt) || Date.now(),
    });
    for (const p of list) {
      await putPhotoRecord({
        id: p.photoId,
        tripId: rt.id,
        regionCode: rt.regionCode,
        driveFileId: p.driveFileId,
        fileName: p.fileName,
        mimeType: p.mimeType,
        order: p.order,
        remote: true,
        blob: null,
        thumb: null,
        createdAt: ts(p.createdAt) || Date.now(),
      });
      pulledPhotos++;
    }
    pulledTrips++;
  }

  // 이미 있는 기록에 다른 기기에서 더해진 사진 붙이기
  for (const lt of localTrips) {
    const list = photosByTrip.get(lt.id);
    if (!list || !list.length) continue;
    const have = new Set(lt.photoIds || []);
    const missing = list.filter((p) => !have.has(p.photoId));
    if (!missing.length) continue;
    for (const p of missing) {
      if (havePhotoIds.has(p.photoId)) continue;
      await putPhotoRecord({
        id: p.photoId,
        tripId: lt.id,
        regionCode: lt.regionCode,
        driveFileId: p.driveFileId,
        fileName: p.fileName,
        mimeType: p.mimeType,
        order: p.order,
        remote: true,
        blob: null,
        thumb: null,
        createdAt: ts(p.createdAt) || Date.now(),
      });
      pulledPhotos++;
    }
    await putTripRecord({
      ...lt,
      photoIds: [...(lt.photoIds || []), ...missing.map((p) => p.photoId)],
      coverPhotoId: lt.coverPhotoId || missing[0].photoId,
    });
  }

  // 6) 로컬 사진에 비어 있는 드라이브 파일 ID 채우기
  const remotePhotoById = new Map(remote.photos.map((p) => [p.photoId, p]));
  for (const lp of localPhotos) {
    if (lp.driveFileId) continue;
    const rp = remotePhotoById.get(lp.id);
    if (rp && rp.driveFileId) {
      await setPhotoDrive(lp.id, rp.driveFileId, {
        fileName: rp.fileName || lp.fileName,
        mimeType: rp.mimeType || lp.mimeType,
      });
    }
  }

  const summary = {
    ok: true,
    pushedTrips,
    pushedPhotos,
    pulledTrips,
    pulledPhotos,
    pushedRegions,
    pulledRegions,
    at: Date.now(),
  };
  rememberSync(summary);
  return summary;
}

// 드라이브에서 받은 사진을 기기 캐시에 담아 두기
export async function cachePhoto(photoId, blob, kind) {
  return await setPhotoBlob(photoId, blob, kind);
}
