import { createMap } from "./map.js";
import {
  openDB, listTrips, listPhotos, tripsForRegion, createTrip, addPhotosToTrip,
  updateTrip, deleteTrip, deletePhoto, clearSamples, processImage,
  exportBackup, importBackup, photoBlob, thumbBlob, setPhotoBlob,
  listRegionCovers, setRegionCoverRecord,
} from "./store.js";
import * as cloud from "./cloud.js";
import { SAMPLE_SPOTS, renderSamplePhoto, sampleDate } from "./sample.js";

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  map: null,
  trips: [],
  photos: new Map(),      // id -> photo record
  byRegion: new Map(),    // code -> trips[]
  visited: new Set(),
  selected: null,
  activeSido: null,
  urls: new Map(),        // photoId -> {full, thumb}
  regionCovers: new Map(), // regionCode -> {coverPhotoId, regionName}  (지도 대표 사진)
  pendingFiles: [],       // {file, url}
  editTrip: null,
  lightbox: { list: [], index: 0, trip: null },
  busy: false,
  syncing: false,
};

// ── 작은 유틸 ────────────────────────────────────────────────
const isDesktop = () => window.matchMedia("(min-width: 901px)").matches;
const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y}. ${Number(m)}. ${Number(d)}.`;
};
const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function confirmAction(message, { ok = "확인", cancel = "취소" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="modal small" role="dialog" aria-modal="true">
        <div class="modal-body" style="padding:24px 20px 8px;font-size:14px;line-height:1.7">${escapeHtml(message)}</div>
        <div class="modal-foot">
          <button class="btn ghost" data-v="0" type="button">${escapeHtml(cancel)}</button>
          <button class="btn primary" data-v="1" type="button">${escapeHtml(ok)}</button>
        </div>
      </div>`;
    document.body.append(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); return; }
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      overlay.remove();
      resolve(b.dataset.v === "1");
    });
    overlay.querySelector("button[data-v='1']").focus();
  });
}

// ── 열린 창(시트·모달·라이트박스)과 뒤로가기 ──────────────
// 안드로이드 PWA에서 뒤로가기를 누르면 앱이 꺼지지 않고 열린 창부터 닫힌다.
const layers = [];
let suppressPop = false;

const LAYER_CLOSERS = {
  sheet: () => closePanel(),
  trip: () => closeTripModal(),
  lightbox: () => closeLightbox(),
  cloud: () => closeCloudModal(),
  about: () => closeAbout(),
};

function layerOpen(name) {
  if (!name || layers.includes(name)) return;
  layers.push(name);
  try {
    history.pushState({ kpmLayer: layers.length }, "");
  } catch (e) {
    /* history를 못 쓰는 환경이면 그냥 넘어간다 */
  }
}

function layerClose(name) {
  const i = layers.indexOf(name);
  if (i < 0) return;
  layers.splice(i, 1);
  if (!suppressPop && history.state && history.state.kpmLayer) {
    suppressPop = true;
    try {
      history.back();
    } catch (e) {
      suppressPop = false;
    }
  }
}

window.addEventListener("popstate", () => {
  if (suppressPop) {
    suppressPop = false;
    return;
  }
  const top = layers[layers.length - 1];
  if (!top) return; // 열린 창이 없으면 앱을 닫는 기본 동작
  layers.pop();
  const close = LAYER_CLOSERS[top];
  if (close) close();
});

function openAbout() {
  $("aboutOverlay").hidden = false;
  layerOpen("about");
}

function closeAbout() {
  $("aboutOverlay").hidden = true;
  layerClose("about");
}

async function photoURL(photoId, kind = "full", { wait = false } = {}) {
  if (!photoId) return null;
  const cached = state.urls.get(photoId);
  if (cached && cached[kind]) return cached[kind];

  let blob = kind === "full" ? await photoBlob(photoId) : await thumbBlob(photoId);
  const rec = state.photos.get(photoId);

  if (!blob && rec && rec.driveFileId && cloud.enabled()) {
    if (kind === "thumb") {
      try {
        blob = await cloud.downloadPhotoBlob(rec, "thumb");
        if (blob) await setPhotoBlob(photoId, blob, "thumb");
      } catch (e) {
        console.warn("드라이브 사진을 받지 못했어요", e);
      }
    } else if (!wait) {
      // 원본은 뒤에서 받아 두고, 화면에는 썸네일을 먼저 보여 준다.
      const thumb = await photoURL(photoId, "thumb");
      fetchFullPhoto(photoId, rec);
      return thumb;
    } else {
      try {
        blob = await cloud.downloadPhotoBlob(rec, "full");
        if (blob) await setPhotoBlob(photoId, blob, "full");
      } catch (e) {
        console.warn("드라이브 사진을 받지 못했어요", e);
      }
    }
  }

  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  const entry = state.urls.get(photoId) || {};
  entry[kind] = url;
  state.urls.set(photoId, entry);
  return url;
}

// 지도·패널은 썸네일로 먼저 그려 두고, 원본이 도착하면 조용히 갈아 끼운다.
const pendingFull = new Set();
function fetchFullPhoto(photoId, rec) {
  if (pendingFull.has(photoId)) return;
  pendingFull.add(photoId);
  cloud
    .downloadPhotoBlob(rec, "full")
    .then(async (blob) => {
      if (!blob) return;
      await setPhotoBlob(photoId, blob, "full");
      const code = rec.regionCode;
      if (code && coverPhotoFor(code) === photoId) {
        const url = await photoURL(photoId, "full");
        if (url) state.map.setPhoto(code, url);
      }
    })
    .catch(() => {})
    .finally(() => pendingFull.delete(photoId));
}

function forgetURLs(photoId) {
  const e = state.urls.get(photoId);
  if (e) {
    for (const u of Object.values(e)) URL.revokeObjectURL(u);
    state.urls.delete(photoId);
  }
}

// ── 초기 로드 ────────────────────────────────────────────────
async function init() {
  registerServiceWorker();
  await openDB();
  const res = await fetch("data/regions.json");
  state.data = await res.json();

  state.map = createMap($("map"), state.data, {
    onPick: (code) => pickRegion(code),
    onHover: (code, pos) => showTooltip(code, pos),
  });

  renderChips();
  bindUI();
  cloud.setRegionNameResolver((code) => state.map.regionByCode.get(code)?.name || "");
  await refreshAll({ animateMap: false });
  $("mapHint").classList.toggle("gone", state.visited.size > 0);
  if (!location.hash) setTimeout(() => $("mapHint").classList.add("gone"), 9000);
  if (cloud.enabled()) setTimeout(() => cloudSyncNow({ quiet: true }), 500);
}

async function refreshAll({ animateMap = true } = {}) {
  state.trips = await listTrips();
  const photos = await listPhotos();
  state.photos = new Map(photos.map((p) => [p.id, p]));

  const covers = await listRegionCovers();
  state.regionCovers = new Map(covers.map((r) => [r.regionCode, r]));

  state.byRegion = new Map();
  for (const t of state.trips) {
    if (!state.byRegion.has(t.regionCode)) state.byRegion.set(t.regionCode, []);
    state.byRegion.get(t.regionCode).push(t);
  }
  await materializeRegionCovers();

  const nextVisited = new Set();
  for (const [code, trips] of state.byRegion) {
    if (trips.length) nextVisited.add(code);
  }
  const added = [...nextVisited].filter((c) => !state.visited.has(c));
  const removed = [...state.visited].filter((c) => !nextVisited.has(c));
  state.visited = nextVisited;

  // 지도 사진 채우기
  const codes = new Set([...added, ...removed, ...nextVisited]);
  for (const code of codes) {
    const cover = coverPhotoFor(code);
    if (cover) {
      const url = await photoURL(cover, "full");
      if (url) state.map.setPhoto(code, url);
    } else {
      state.map.clearPhoto(code);
    }
  }
  state.map.setVisitedSet(state.visited);

  updateProgress();
  updateChips();
  $("mapHint").classList.toggle("gone", state.visited.size > 0);
  if (state.selected) renderPanel();
  updateSearchResults($("searchInput").value);
}

function coverPhotoFor(code) {
  const rec = state.regionCovers.get(code);
  if (rec?.coverPhotoId && state.photos.has(rec.coverPhotoId)) return rec.coverPhotoId;
  return legacyCoverFor(code);
}

// 지난 버전처럼 '가장 최근 일기의 대표 사진'을 지도 사진으로 쓰는 예전 규칙(초기 데이터·사진 삭제 대비).
function legacyCoverFor(code) {
  const trips = state.byRegion.get(code) || [];
  for (let i = trips.length - 1; i >= 0; i--) {
    const t = trips[i];
    if (t.coverPhotoId && state.photos.has(t.coverPhotoId)) return t.coverPhotoId;
    const ids = t.photoIds || [];
    for (let j = ids.length - 1; j >= 0; j--) {
      if (state.photos.has(ids[j])) return ids[j];
    }
  }
  return null;
}

function regionNameOf(code) {
  return state.map?.regionByCode.get(code)?.name || "";
}

// 지도 대표 사진이 아직 없는 지역은 지금 보이던 사진으로 한 번 정해 둔다.
// 그래야 나중에 새 여행을 남겨도 지도 사진이 최신 사진으로 바뀌지 않는다.
async function materializeRegionCovers() {
  for (const [code, trips] of state.byRegion) {
    const cur = state.regionCovers.get(code);
    if (cur?.coverPhotoId && state.photos.has(cur.coverPhotoId)) continue;
    if (trips.every((t) => t.sample)) continue;
    const pid = legacyCoverFor(code);
    if (!pid) continue;
    const rec = await setRegionCoverRecord(code, pid, { regionName: regionNameOf(code) });
    state.regionCovers.set(code, rec);
  }
}

// 사진을 지운 뒤 지도 대표 사진이 사라진 사진을 가리키면 다시 골라 준다.
async function repairRegionCover(code) {
  if (!code) return;
  const cur = state.regionCovers.get(code);
  if (cur?.coverPhotoId && state.photos.has(cur.coverPhotoId)) return;
  const pid = legacyCoverFor(code) || "";
  if ((cur?.coverPhotoId || "") === pid && cur) return;
  const rec = await setRegionCoverRecord(code, pid, { regionName: regionNameOf(code) });
  state.regionCovers.set(code, rec);
  if (cloud.enabled()) cloud.setRegionCoverRemote(code, pid, regionNameOf(code)).catch(() => {});
}

function updateProgress() {
  const total = state.data.regions.length;
  const n = state.visited.size;
  const pct = Math.round((n / total) * 1000) / 10;
  $("visitedCount").textContent = n;
  $("progressPct").textContent = `${pct}%`;
  $("progressFill").style.width = `${(n / total) * 100}%`;
}

// ── 시·도 칩 ────────────────────────────────────────────────
function renderChips() {
  const wrap = $("sidoChips");
  wrap.innerHTML = "";
  const all = document.createElement("button");
  all.className = "chip active";
  all.type = "button";
  all.dataset.sido = "";
  all.textContent = "전체";
  wrap.append(all);

  for (const sido of state.data.sidoOrder) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.dataset.sido = sido;
    b.innerHTML = `${sido}<span class="c-count"></span>`;
    wrap.append(b);
  }
  wrap.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    selectSido(chip.dataset.sido || null);
  });
}

function updateChips() {
  const counts = {};
  for (const code of state.visited) {
    const r = state.map.regionByCode.get(code);
    if (r) counts[r.sido] = (counts[r.sido] || 0) + 1;
  }
  for (const chip of $("sidoChips").querySelectorAll(".chip")) {
    const sido = chip.dataset.sido;
    const span = chip.querySelector(".c-count");
    if (span) span.textContent = counts[sido] ? ` ${counts[sido]}` : "";
    chip.classList.toggle("active", (sido || null) === state.activeSido);
  }
}

function selectSido(sido) {
  state.activeSido = sido;
  if (!sido) {
    state.map.setDim(null);
    state.map.reset();
  } else {
    state.map.setDim(new Set(state.data.regions.filter((r) => r.sido === sido).map((r) => r.code)));
    state.map.focusSido(sido);
  }
  updateChips();
}

// ── 지역 선택 · 패널 ─────────────────────────────────────────
async function pickRegion(code) {
  if (!state.map.regionByCode.has(code)) return;
  state.selected = code;
  state.lastPickAt = Date.now();
  state.map.setSelected(code);
  openPanel();
  await renderPanel();
}

function openPanel() {
  $("panel").classList.add("open");
  $("panel").setAttribute("aria-hidden", "false");
  document.body.classList.add("panel-open");
  state.map.setSideInset(isDesktop() ? 424 : 0);
  if (state.selected) state.map.focusRegion(state.selected);
  layerOpen("sheet");
}
function closePanel() {
  $("panel").classList.remove("open");
  $("panel").setAttribute("aria-hidden", "true");
  document.body.classList.remove("panel-open");
  $("panel").style.transform = "";
  state.map.setSideInset(0);
  state.selected = null;
  state.map.setSelected(null);
  layerClose("sheet");
}

async function renderPanel() {
  const code = state.selected;
  if (!code) return;
  const region = state.map.regionByCode.get(code);
  const trips = (state.byRegion.get(code) || []).slice().reverse();
  const photoCount = trips.reduce((n, t) => n + (t.photoIds?.length || 0), 0);
  const visited = trips.length > 0;

  $("panelTitle").innerHTML = `${escapeHtml(region.name)}
    <span class="visit-badge ${visited ? "" : "none"}">${visited ? `📸 ${photoCount}장` : "미방문"}</span>`;
  $("panelSub").textContent = region.sidoFull || region.sido;

  const body = $("panelBody");
  if (!trips.length) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="empty-emoji">🧺</span>
        <p>아직 이 지역에 남긴 사진이 없어요.<br><b>첫 여행 기록</b>을 남겨 볼까요?</p>
      </div>`;
    return;
  }

  const cards = [];
  for (const t of trips) {
    const cover = t.coverPhotoId ? await photoURL(t.coverPhotoId, "thumb") : null;
    const strip = [];
    for (const pid of t.photoIds || []) {
      const u = await photoURL(pid, "thumb");
      if (u) strip.push({ pid, u });
    }
    const thumbs = strip.map(({ pid, u }) =>
      `<button type="button" data-photo="${pid}" class="${pid === t.coverPhotoId ? "is-cover" : ""}" aria-label="사진 크게 보기">
         <img src="${u}" alt="" loading="lazy" />
       </button>`).join("");

    cards.push(`
      <article class="trip" data-trip="${t.id}">
        <div class="trip-photo ${cover ? "" : "no-photo"}" ${cover ? `data-cover="${t.coverPhotoId}"` : ""}>
          ${cover ? `<img src="${cover}" alt="${escapeHtml(region.name)} 여행 사진" loading="lazy" />` : "<span>📷</span>"}
          ${t.coverPhotoId ? '<span class="cover-tag">대표 사진</span>' : ""}
          ${t.sample ? '<span class="sample-tag">예시</span>' : ""}
        </div>
        <div class="trip-meta">
          <div class="trip-date">${fmtDate(t.date)}</div>
          <h3 class="trip-title">${escapeHtml(t.title || "여행 기록")}</h3>
          ${t.memo ? `<p class="trip-memo">${escapeHtml(t.memo)}</p>` : ""}
          <div class="strip">${thumbs}</div>
          <div class="trip-actions">
            <button class="mini" type="button" data-act="add-photo" data-trip="${t.id}">＋ 사진</button>
            <button class="mini danger" type="button" data-act="delete-trip" data-trip="${t.id}">삭제</button>
          </div>
        </div>
      </article>`);
  }

  body.innerHTML = cards.join("") + `<p class="panel-tip">사진을 누르면 크게 볼 수 있고, 거기서 대표 사진을 바꿀 수 있어요.</p>`;
}

// 패널 이벤트 (위임)
function bindPanel() {
  const body = $("panelBody");
  body.addEventListener("click", async (e) => {
    const tripBtn = e.target.closest("button[data-act]");
    if (tripBtn) {
      const trip = state.trips.find((t) => t.id === tripBtn.dataset.trip);
      if (!trip) return;
      if (tripBtn.dataset.act === "delete-trip") {
        const ok = await confirmAction(`이 여행 기록과 사진 ${trip.photoIds?.length || 0}장을 지울까요?`, { ok: "지우기" });
        if (!ok) return;
        for (const pid of trip.photoIds || []) forgetURLs(pid);
        await deleteTrip(trip);
        if (cloud.enabled() && !trip.sample) {
          cloud.deleteTripRemote(trip.id).catch((e) => {
            console.warn("드라이브 기록을 지우지 못했어요", e);
            cloud.addTombstone("trip", trip.id);
          });
        }
        toast("기록을 지웠어요");
        await refreshAll();
        return;
      }
      if (tripBtn.dataset.act === "add-photo") {
        openTripModal(trip.regionCode, { existing: trip });
        return;
      }
    }

    const photoBtn = e.target.closest("button[data-photo]");
    if (photoBtn) {
      const tripEl = photoBtn.closest("article[data-trip]");
      const trip = state.trips.find((t) => t.id === tripEl?.dataset.trip);
      if (!trip) return;
      const list = [];
      for (const pid of trip.photoIds || []) {
        const u = await photoURL(pid, "full", { wait: true });
        if (u) list.push({ pid, u });
      }
      openLightbox(list, Math.max(0, list.findIndex((x) => x.pid === photoBtn.dataset.photo)), trip);
      return;
    }

    const coverImg = e.target.closest("[data-cover]");
    if (coverImg) {
      const tripEl = coverImg.closest("article[data-trip]");
      const trip = state.trips.find((t) => t.id === tripEl?.dataset.trip);
      if (!trip) return;
      const list = [];
      for (const pid of trip.photoIds || []) {
        const u = await photoURL(pid, "full", { wait: true });
        if (u) list.push({ pid, u });
      }
      openLightbox(list, Math.max(0, list.findIndex((x) => x.pid === trip.coverPhotoId)), trip);
    }
  });
}

// ── 라이트박스 ──────────────────────────────────────────────
function openLightbox(list, index, trip) {
  if (!list.length) return;
  state.lightbox = { list, index, trip };
  renderLightbox();
  $("lightbox").hidden = false;
  layerOpen("lightbox");
}
function renderLightbox() {
  const { list, index, trip } = state.lightbox;
  const cur = list[index];
  if (!cur) return closeLightbox();
  $("lbImg").src = cur.u;
  const region = trip ? state.map.regionByCode.get(trip.regionCode) : null;
  $("lbCaption").textContent = trip
    ? `${region?.name || ""} · ${fmtDate(trip.date)} ${trip.title ? "· " + trip.title : ""} (${index + 1}/${list.length})`
    : "";
  $("lbPrev").style.visibility = list.length > 1 ? "visible" : "hidden";
  $("lbNext").style.visibility = list.length > 1 ? "visible" : "hidden";

  // 두 대표 사진을 따로 보여 준다: 지도에 칠하는 사진 / 이 일기의 사진
  const isTripCover = !!trip && trip.coverPhotoId === cur.pid;
  const isMapCover = !!trip && state.regionCovers.get(trip.regionCode)?.coverPhotoId === cur.pid;

  const mapBtn = $("lbMapCover");
  mapBtn.textContent = isMapCover ? "✓ 지도 대표" : "🗺️ 지도 대표";
  mapBtn.title = isMapCover ? "이 사진이 지도에 칠해져 있어요" : "지도에 칠할 대표 사진으로 정하기";
  mapBtn.disabled = !trip || isMapCover;

  const tripBtn = $("lbCover");
  tripBtn.textContent = isTripCover ? "✓ 일기 대표" : "📖 일기 대표";
  tripBtn.title = isTripCover ? "이 일기의 대표 사진이에요" : "이 일기의 대표 사진으로 정하기";
  tripBtn.disabled = !trip || isTripCover;

  $("lbMapCover").hidden = !trip;
  $("lbCover").hidden = !trip;
  $("lbDelete").hidden = !trip;
}

// 일기(여행 기록)의 대표 사진 바꾸기
async function setTripCoverFromLightbox() {
  const { trip: t, list: l, index: i } = state.lightbox;
  if (!t) return;
  const updated = { ...t, coverPhotoId: l[i].pid };
  await updateTrip(updated);
  state.lightbox = { ...state.lightbox, trip: updated };
  if (cloud.enabled()) {
    cloud.setCoverRemote(updated.id, updated.coverPhotoId).catch((e) => console.warn("일기 대표 사진을 알리지 못했어요", e));
  }
  toast("이 일기의 대표 사진을 바꿨어요 📖");
  await refreshAll();
  renderLightbox();
}

// 지역의 지도 대표 사진 바꾸기 (지난 여행 사진을 지도에 고정할 수 있다)
async function setMapCoverFromLightbox() {
  const { trip: t, list: l, index: i } = state.lightbox;
  if (!t) return;
  const code = t.regionCode;
  const pid = l[i].pid;
  const rec = await setRegionCoverRecord(code, pid, { regionName: regionNameOf(code) });
  state.regionCovers.set(code, rec);
  if (cloud.enabled()) {
    cloud.setRegionCoverRemote(code, pid, regionNameOf(code)).catch((e) => console.warn("지도 대표 사진을 알리지 못했어요", e));
  }
  toast("이 사진을 지도 대표 사진으로 정했어요 🗺️");
  await refreshAll();
  renderLightbox();
}

async function deletePhotoFromLightbox() {
  const { trip: t, list: l, index: i } = state.lightbox;
  if (!t) return;
  const ok = await confirmAction("이 사진을 지울까요?", { ok: "지우기" });
  if (!ok) return;
  const pid = l[i].pid;
  const ids = (t.photoIds || []).filter((x) => x !== pid);
  await deletePhoto(pid);
  forgetURLs(pid);
  if (cloud.enabled()) {
    cloud.deletePhotoRemote(pid).catch((e) => {
      console.warn("드라이브 사진을 지우지 못했어요", e);
      cloud.addTombstone("photo", pid);
    });
  }
  const updated = {
    ...t,
    photoIds: ids,
    coverPhotoId: t.coverPhotoId === pid ? ids[0] || null : t.coverPhotoId,
  };
  await updateTrip(updated);
  await refreshAll();
  await repairRegionCover(t.regionCode);
  if (!ids.length) return closeLightbox();
  const list = [];
  for (const id of ids) {
    const u = await photoURL(id, "full", { wait: true });
    if (u) list.push({ pid: id, u });
  }
  state.lightbox = { list, index: Math.min(i, list.length - 1), trip: updated };
  renderLightbox();
  toast("사진을 지웠어요");
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lbImg").src = "";
  layerClose("lightbox");
}
function stepLightbox(dir) {
  const { list, index } = state.lightbox;
  if (!list.length) return;
  state.lightbox.index = (index + dir + list.length) % list.length;
  renderLightbox();
}

// ── 여행 기록 모달 ──────────────────────────────────────────
function resetPending() {
  for (const p of state.pendingFiles) URL.revokeObjectURL(p.url);
  state.pendingFiles = [];
}

function openTripModal(code, { existing = null } = {}) {
  const region = state.map.regionByCode.get(code);
  state.editTrip = existing;
  state.modalRegion = code;
  resetPending();
  $("tripModalTitle").textContent = existing ? "사진 추가" : "여행 기록 추가";
  $("tripModalSub").textContent = `${region.sidoFull || region.sido} ${region.name}`;
  $("tripDate").value = existing?.date || new Date().toISOString().slice(0, 10);
  $("tripTitle").value = existing?.title || "";
  $("tripMemo").value = existing?.memo || "";
  $("photoHint").textContent = existing ? "(추가로 넣을 사진)" : "(여러 장 선택 가능)";
  $("tripTitle").closest(".field-row").style.display = existing ? "none" : "";
  $("tripMemoField").style.display = existing ? "none" : "";
  renderPreviews();
  $("tripOverlay").hidden = false;
  layerOpen("trip");
  setTimeout(() => (existing ? $("dropzone") : $("tripTitle")).focus?.(), 60);
}

function addPendingFiles(files) {
  const accepted = [...files].filter((f) => f.type.startsWith("image/"));
  if (!accepted.length) {
    toast("이미지 파일만 넣을 수 있어요");
    return;
  }
  for (const f of accepted) {
    state.pendingFiles.push({ file: f, url: URL.createObjectURL(f) });
  }
  renderPreviews();
}

function renderPreviews() {
  const grid = $("previewGrid");
  grid.innerHTML = state.pendingFiles.map((p, i) => `
    <div class="preview-item ${i === 0 ? "is-cover" : ""}" data-idx="${i}" title="대표 사진으로 지정">
      <img src="${p.url}" alt="" />
      <span class="pick">${i === 0 ? "대표" : "선택"}</span>
      <button class="rm" type="button" data-rm="${i}" aria-label="빼기">×</button>
    </div>`).join("");
}

async function saveTrip() {
  if (state.busy) return;
  const code = state.modalRegion;
  const date = $("tripDate").value;
  if (!date) return toast("날짜를 골라 주세요");

  const existing = state.editTrip;
  const files = state.pendingFiles.map((p) => p.file);
  if (existing && !files.length) return toast("넣을 사진을 골라 주세요");
  if (!existing && !files.length && !$("tripTitle").value.trim() && !$("tripMemo").value.trim()) {
    return toast("사진이나 제목을 하나는 남겨 주세요");
  }

  state.busy = true;
  const saveBtn = $("tripSave");
  const label = saveBtn.textContent;
  saveBtn.disabled = true;
  try {
    const processed = [];
    for (let i = 0; i < files.length; i++) {
      saveBtn.textContent = files.length > 1 ? `저장 중… (${i + 1}/${files.length})` : "저장 중…";
      try {
        processed.push(await processImage(files[i]));
      } catch (err) {
        console.warn("이미지 처리 실패", files[i].name, err);
        toast(`${files[i].name || "사진"}은(는) 읽을 수 없어 건너뛰었어요`);
      }
    }

    let tripId = null;
    if (existing) {
      const updated = await addPhotosToTrip(existing, processed);
      tripId = updated.id;
      toast("사진을 더했어요 📷");
    } else {
      const created = await createTrip({
        regionCode: code, date,
        title: $("tripTitle").value.trim(),
        memo: $("tripMemo").value.trim(),
        photos: processed, coverIndex: 0,
      });
      tripId = created.id;
      toast("여행 기록을 남겼어요 ✨");
    }
    closeTripModal();
    state.selected = code;
    state.map.setSelected(code);
    openPanel();
    await refreshAll();
    if (tripId) pushTripQuiet(tripId);
  } finally {
    state.busy = false;
    saveBtn.disabled = false;
    saveBtn.textContent = label;
  }
}

function closeTripModal() {
  $("tripOverlay").hidden = true;
  resetPending();
  $("tripForm").reset?.();
  state.editTrip = null;
  layerClose("trip");
}

// ── 검색 ────────────────────────────────────────────────────
function searchRegions(q) {
  const query = q.trim().replace(/\s/g, "");
  if (!query) return [];
  const out = [];
  for (const r of state.data.regions) {
    const hay = (r.name + r.sido + (r.nameEn || "")).replace(/\s/g, "").toLowerCase();
    if (hay.includes(query.toLowerCase())) {
      let score = r.name.startsWith(query) ? 0 : r.name.includes(query) ? 1 : 2;
      out.push({ r, score });
    }
  }
  return out.sort((a, b) => a.score - b.score || b.r.area - a.r.area).slice(0, 8).map((x) => x.r);
}

function chooseSearch(code) {
  if (!code) return;
  $("searchResults").hidden = true;
  const region = state.map.regionByCode.get(code);
  $("searchInput").value = region ? region.name : "";
  state.activeSido = null;
  state.map.setDim(null);
  updateChips();
  $("searchInput").blur();
  pickRegion(code);
}

function updateSearchResults(q) {  const box = $("searchResults");
  const list = searchRegions(q);
  $("searchClear").hidden = !q;
  if (!q.trim()) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="search-empty">‘${escapeHtml(q)}’ 지역을 못 찾았어요</div>`;
    box.hidden = false;
    return;
  }
  box.innerHTML = list.map((r) => `
    <button class="search-item" type="button" data-code="${r.code}" role="option">
      <span>${escapeHtml(r.name)}</span><small>${escapeHtml(r.sido)}</small>
      ${state.visited.has(r.code) ? '<span class="dot-visited">📸</span>' : ""}
    </button>`).join("");
  box.hidden = false;
}

// ── 지도 툴팁 ───────────────────────────────────────────────
function showTooltip(code, pos) {
  const tip = $("tooltip");
  if (!code || !pos) {
    tip.hidden = true;
    return;
  }
  const r = state.map.regionByCode.get(code);
  const visited = state.visited.has(code);
  tip.innerHTML = `${escapeHtml(r.name)}<small>${escapeHtml(r.sidoFull || r.sido)} · ${visited ? '<span class="tt-visited">📸 다녀온 곳</span>' : "아직 안 가 봤어요"}</small>`;
  const rect = $("mapWrap").getBoundingClientRect();
  tip.style.left = `${pos.x - rect.left}px`;
  tip.style.top = `${pos.y - rect.top}px`;
  tip.hidden = false;
}

// ── 예시 데이터 ─────────────────────────────────────────────
async function seedSamples() {
  if (state.trips.some((t) => t.sample)) {
    toast("이미 예시 데이터가 있어요. 먼저 지워 주세요 🧹");
    return;
  }
  const btn = $("btnSample");
  btn.disabled = true;
  const label = btn.innerHTML;
  const spots = [];
  for (const s of SAMPLE_SPOTS) {
    const r = state.data.regions.find((x) => x.name === s.name && x.sido === s.sido);
    if (r) spots.push({ ...s, code: r.code });
  }
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    btn.textContent = `그리는 중… ${i + 1}/${spots.length}`;
    const photos = [await renderSamplePhoto(s.code, s.theme, 0)];
    if (i % 3 === 0) photos.push(await renderSamplePhoto(s.code, s.theme, 1));
    await createTrip({
      regionCode: s.code, date: sampleDate(i), title: s.title, memo: s.memo,
      photos, coverIndex: 0, sample: true,
    });
  }
  btn.innerHTML = label;
  btn.disabled = false;
  await refreshAll();
  $("mapHint").classList.add("gone");
  toast("예시로 20곳을 채웠어요 · 지우려면 ⋯");
}

// ── 백업 ────────────────────────────────────────────────────
async function doExport() {
  const data = await exportBackup();
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  a.href = url;
  a.download = `여행사진지도-백업-${stamp}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`백업 파일을 내려받았어요 (기록 ${data.trips.length}개)`);
}

async function doImport(file) {
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const n = await importBackup(json);
    await refreshAll();
    toast(n ? `${n}개 기록을 불러왔어요` : "새로 불러올 기록이 없어요");
  } catch (e) {
    console.error(e);
    toast("백업 파일을 읽지 못했어요");
  }
}

// ── 구글 드라이브 연동 ────────────────────────────────────
function setCloudStatus(msg, kind) {
  const box = $("cloudStatus");
  if (!msg) {
    box.hidden = true;
    box.textContent = "";
    box.className = "cloud-status";
    return;
  }
  box.hidden = false;
  box.className = `cloud-status${kind ? " " + kind : ""}`;
  box.textContent = msg;
}

function timeText(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openCloudModal() {
  $("cloudUrl").value = cloud.getUrl();
  setCloudStatus("", null);
  const last = cloud.lastSync();
  if (last && last.at) {
    setCloudStatus(
      `마지막 동기화 ${timeText(last.at)} · 올림 기록 ${last.pushedTrips}·사진 ${last.pushedPhotos} / 받음 기록 ${last.pulledTrips}·사진 ${last.pulledPhotos}`,
      "ok"
    );
  }
  $("cloudOverlay").hidden = false;
  layerOpen("cloud");
  setTimeout(() => $("cloudUrl").focus(), 60);
}

function closeCloudModal() {
  $("cloudOverlay").hidden = true;
  layerClose("cloud");
}

function applyCloudUrl() {
  const v = $("cloudUrl").value.trim();
  if (!v) {
    cloud.setUrl("");
    return "";
  }
  if (!/^https?:\/\//i.test(v)) {
    setCloudStatus("https://script.google.com/macros/s/…/exec 주소를 붙여넣어 주세요", "err");
    return null;
  }
  cloud.setUrl(v);
  return v;
}

async function cloudTest() {
  const url = applyCloudUrl();
  if (!url) return;
  const btn = $("cloudTest");
  btn.disabled = true;
  setCloudStatus("연결을 확인하는 중…", null);
  try {
    const p = await cloud.ping();
    const lines = [
      "연결됐어요 ☁️",
      `‘${p.title || "여행 사진 지도 데이터"}’ · 기록 ${p.trips || 0}개 · 사진 ${p.photos || 0}장`,
    ];
    if (!p.photoFolder) lines.push("⚠️ 사진 폴더를 찾지 못했어요 · Code.gs의 PHOTO_FOLDER_ID를 확인해 주세요");
    setCloudStatus(lines.join("\n"), "ok");
    return p;
  } catch (e) {
    setCloudStatus(e.message || "연결하지 못했어요", "err");
    return null;
  } finally {
    btn.disabled = false;
  }
}

async function cloudSyncNow({ quiet = false } = {}) {
  const url = quiet ? cloud.getUrl() : applyCloudUrl();
  if (!url) {
    if (!quiet) setCloudStatus("주소를 먼저 붙여넣고 저장해 주세요", null);
    return null;
  }
  if (state.syncing) {
    if (!quiet) setCloudStatus("이미 동기화 중이에요…", null);
    return null;
  }

  state.syncing = true;
  const syncBtn = $("cloudSync");
  syncBtn.disabled = true;
  const status = (m) => { if (!quiet) setCloudStatus(m, null); };
  try {
    const r = await cloud.syncAll({ onStatus: status });
    const changed = r.pushedTrips + r.pushedPhotos + r.pulledTrips + r.pulledPhotos;
    if (changed) {
      for (const id of [...state.urls.keys()]) forgetURLs(id);
      await refreshAll();
    }
    if (!quiet) {
      setCloudStatus(
        changed
          ? `동기화했어요 ☁️\n올림 기록 ${r.pushedTrips} · 사진 ${r.pushedPhotos} / 받음 기록 ${r.pulledTrips} · 사진 ${r.pulledPhotos}`
          : "이미 드라이브와 같은 상태예요 ✓",
        "ok"
      );
    } else if (r.pulledTrips + r.pulledPhotos > 0) {
      toast(`드라이브에서 ${r.pulledTrips}개 기록 · 사진 ${r.pulledPhotos}장을 받았어요 ☁️`, 3200);
    }
    return r;
  } catch (e) {
    console.warn("드라이브 동기화 실패", e);
    if (!quiet) setCloudStatus(e.message || "동기화하지 못했어요", "err");
    else toast("드라이브 동기화에 실패했어요 · ⋯ 메뉴에서 확인해 주세요", 3600);
    return null;
  } finally {
    state.syncing = false;
    syncBtn.disabled = false;
  }
}

async function cloudPushAll() {
  const url = applyCloudUrl();
  if (!url) return;
  const trips = state.trips.filter((t) => !t.sample);
  const photoCount = trips.reduce((n, t) => n + (t.photoIds?.length || 0), 0);
  if (!trips.length) {
    setCloudStatus("올릴 기록이 아직 없어요", null);
    return;
  }
  const ok = await confirmAction(
    `이 기기의 기록 ${trips.length}개 · 사진 ${photoCount}장을 드라이브로 올릴까요? 처음 한 번은 사진 수만큼 시간이 걸려요.`,
    { ok: "올리기" }
  );
  if (!ok) return;
  const btn = $("cloudPushAll");
  btn.disabled = true;
  try {
    const r = await cloudSyncNow();
    if (r) toast("이 기기의 기록을 드라이브에 올렸어요 ☁️", 3000);
  } finally {
    btn.disabled = false;
  }
}

// 기록·사진을 바꾼 직후 조용히 드라이브에 밀어 넣는다(실패해도 앱은 계속).
async function pushTripQuiet(tripId) {
  if (!cloud.enabled()) return;
  try {
    const r = await cloud.pushTrip(tripId);
    if (r && r.uploaded) toast(`드라이브에도 사진 ${r.uploaded}장을 올렸어요 ☁️`, 3000);
  } catch (e) {
    console.warn("드라이브에 올리지 못했어요", e);
    toast("드라이브 저장은 다음 동기화 때 다시 시도할게요", 3200);
  }
}

function bindCloud() {
  $("cloudClose").addEventListener("click", closeCloudModal);
  $("cloudOverlay").addEventListener("click", (e) => {
    if (e.target === $("cloudOverlay")) closeCloudModal();
  });
  $("cloudTest").addEventListener("click", cloudTest);
  $("cloudSaveBtn").addEventListener("click", () => {
    const url = applyCloudUrl();
    if (url === null) return;
    if (url) {
      setCloudStatus("주소를 저장했어요 ✓ 이 기기 브라우저에만 들어 있어요", "ok");
      toast("드라이브 주소를 저장했어요 ☁️");
    } else {
      setCloudStatus("주소를 비웠어요 · 이제 이 기기에만 저장돼요", null);
      toast("드라이브 연동을 꺼어요");
    }
  });
  $("cloudSync").addEventListener("click", () => cloudSyncNow());
  $("cloudPushAll").addEventListener("click", cloudPushAll);
}

// ── 모바일 하단 시트: 손잡이·헤더를 아래로 끌어 닫기 ──────
function isMobileSheet() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function bindSheetGesture() {
  const panel = $("panel");
  const handle = panel.querySelector(".sheet-handle");
  const head = panel.querySelector(".panel-head");
  if (!handle && !head) return;

  let startY = null;
  let dy = 0;
  let dragging = false;

  const start = (e) => {
    if (!isMobileSheet() || !panel.classList.contains("open")) return;
    if (!e.touches || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    dy = 0;
    dragging = true;
    panel.style.transition = "none";
  };

  const move = (e) => {
    if (!dragging || startY === null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dy = Math.max(0, y - startY);
    if (dy > 4) {
      if (e.cancelable) e.preventDefault();
      panel.style.transform = `translateY(${dy}px)`;
    }
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = "";
    panel.style.transform = "";
    const shouldClose = dy > 90;
    startY = null;
    dy = 0;
    if (shouldClose) closePanel();
  };

  for (const el of [handle, head].filter(Boolean)) {
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }
}

// ── 설치(홈 화면에 추가) & 서비스 워커 ──────────────────────
const install = {
  prompt: null,
  standalone: () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    navigator.standalone === true,
};

function syncInstallMenuItem() {
  const btn = $("menuInstall");
  if (!btn) return;
  btn.hidden = !install.prompt || install.standalone();
}

function bindInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    install.prompt = e;
    syncInstallMenuItem();
  });
  window.addEventListener("appinstalled", () => {
    install.prompt = null;
    syncInstallMenuItem();
    toast("홈 화면에 추가했어요 · 이제 앱처럼 열려요 🎉");
  });
  syncInstallMenuItem();
}

async function doInstall() {
  if (!install.prompt) {
    toast("브라우저 오른쪽 위 ⋮ 메뉴에서 ‘앱 설치’나 ‘홈 화면에 추가’를 눌러 주세요");
    return;
  }
  const ev = install.prompt;
  install.prompt = null;
  syncInstallMenuItem();
  try {
    ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "accepted") toast("설치를 시작했어요 · 홈 화면을 확인해 보세요");
    else toast("설치를 취소했어요 · ⋯ 메뉴에서 다시 할 수 있어요");
  } catch (e) {
    console.warn(e);
    toast("설치 창을 열지 못했어요 · 브라우저 ⋮ 메뉴에서 ‘홈 화면에 추가’를 눌러 주세요");
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return; // https·localhost에서만 동작
  navigator.serviceWorker
    .register("./sw.js")
    .catch((e) => console.warn("서비스 워커를 등록하지 못했어요", e));
}

// ── UI 바인딩 ───────────────────────────────────────────────
function bindUI() {
  $("zoomIn").addEventListener("click", () => state.map.zoomStep(1.5));
  $("zoomOut").addEventListener("click", () => state.map.zoomStep(1 / 1.5));
  $("zoomReset").addEventListener("click", () => {
    state.map.reset();
    state.activeSido = null;
    state.map.setDim(null);
    updateChips();
  });

  $("panelClose").addEventListener("click", closePanel);
  $("btnAddTrip").addEventListener("click", () => {
    if (state.selected) openTripModal(state.selected);
  });

  // 검색
  const input = $("searchInput");
  input.addEventListener("input", () => updateSearchResults(input.value));
  input.addEventListener("focus", () => updateSearchResults(input.value));
  input.addEventListener("keydown", (e) => {
    const items = [...$("searchResults").querySelectorAll(".search-item")];
    const active = $("searchResults").querySelector(".search-item.active");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const i = active ? items.indexOf(active) : -1;
      const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items.forEach((x) => x.classList.remove("active"));
      items[next].classList.add("active");
      items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const target = active || items[0];
      if (target) {
        e.preventDefault();
        chooseSearch(target.dataset.code);
      }
    } else if (e.key === "Escape") {
      $("searchResults").hidden = true;
      input.blur();
    }
  });
  $("searchResults").addEventListener("click", (e) => {
    const item = e.target.closest(".search-item");
    if (item) chooseSearch(item.dataset.code);
  });
  $("searchClear").addEventListener("click", () => {
    input.value = "";
    updateSearchResults("");
    input.focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) $("searchResults").hidden = true;
  });

  // 메뉴
  const menu = $("menu");
  $("btnMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    $("btnMenu").setAttribute("aria-expanded", String(open));
  });
  menu.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    menu.hidden = true;
    $("btnMenu").setAttribute("aria-expanded", "false");
    const act = b.dataset.act;
    if (act === "cloud") openCloudModal();
    if (act === "export") await doExport();
    if (act === "import") $("importInput").click();
    if (act === "clear-samples") {
      const n = await clearSamples();
      for (const p of [...state.urls.keys()]) forgetURLs(p);
      await refreshAll();
      toast(n ? `예시 ${n}개를 지웠어요` : "지울 예시가 없어요");
    }
    if (act === "install") await doInstall();
    if (act === "about") openAbout();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap")) {
      menu.hidden = true;
      $("btnMenu").setAttribute("aria-expanded", "false");
    }
  });

  $("importInput").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) doImport(f);
    e.target.value = "";
  });

  $("btnSample").addEventListener("click", seedSamples);

  // 모달
  $("tripClose").addEventListener("click", closeTripModal);
  $("tripCancel").addEventListener("click", closeTripModal);
  $("tripOverlay").addEventListener("click", (e) => {
    if (e.target === $("tripOverlay")) closeTripModal();
  });
  $("tripSave").addEventListener("click", saveTrip);

  const dropzone = $("dropzone");
  $("photoInput").addEventListener("change", (e) => {
    addPendingFiles(e.target.files || []);
    e.target.value = "";
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
    addPendingFiles(e.dataTransfer.files || []);
  });

  $("previewGrid").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      const i = Number(rm.dataset.rm);
      URL.revokeObjectURL(state.pendingFiles[i].url);
      state.pendingFiles.splice(i, 1);
      renderPreviews();
      return;
    }
    const item = e.target.closest(".preview-item");
    if (item) {
      const i = Number(item.dataset.idx);
      const [moved] = state.pendingFiles.splice(i, 1);
      state.pendingFiles.unshift(moved);
      renderPreviews();
    }
  });

  // 라이트박스
  $("lbClose").addEventListener("click", closeLightbox);
  $("lbPrev").addEventListener("click", () => stepLightbox(-1));
  $("lbNext").addEventListener("click", () => stepLightbox(1));
  $("lbMapCover").addEventListener("click", setMapCoverFromLightbox);
  $("lbCover").addEventListener("click", setTripCoverFromLightbox);
  $("lbDelete").addEventListener("click", deletePhotoFromLightbox);
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox") || e.target.classList.contains("lb-figure")) closeLightbox();
  });

  // 정보
  $("aboutClose").addEventListener("click", () => closeAbout());
  $("aboutOverlay").addEventListener("click", (e) => {
    if (e.target === $("aboutOverlay")) closeAbout();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("lightbox").hidden) closeLightbox();
      else if (!$("tripOverlay").hidden) closeTripModal();
      else if (!$("cloudOverlay").hidden) closeCloudModal();
      else if (!$("aboutOverlay").hidden) closeAbout();
      else if (state.selected) closePanel();
    }
    if (!$("lightbox").hidden) {
      if (e.key === "ArrowLeft") stepLightbox(-1);
      if (e.key === "ArrowRight") stepLightbox(1);
    }
  });

  bindInstall();
  bindPanel();
  bindCloud();
  bindSheetGesture();

  // 모바일에서 시트 바깥(지도·여백)을 누르면 하단 시트를 닫는다.
  // (지역을 골라 새로 연 직후에는 닫지 않는다 — 지도는 좌표로 지역을 찾기 때문에 target이 svg다)
  document.addEventListener("click", (e) => {
    if (!state.selected || !isMobileSheet()) return;
    if (Date.now() - (state.lastPickAt || 0) < 400) return;
    if (e.target.closest("#panel, .overlay, .lightbox, .menu-wrap, .topbar, .toolbar, .search-wrap")) return;
    if (e.target.closest("path.region")) return;
    closePanel();
  });
}

init().catch((e) => {
  console.error(e);
  toast("앱을 불러오지 못했어요. 새로고침해 주세요");
});
