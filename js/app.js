import { createMap } from "./map.js";
import {
  openDB, listTrips, listPhotos, tripsForRegion, createTrip, addPhotosToTrip,
  updateTrip, deleteTrip, deletePhoto, clearSamples, processImage,
  exportBackup, importBackup, photoBlob, thumbBlob,
} from "./store.js";
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
  pendingFiles: [],       // {file, url}
  editTrip: null,
  lightbox: { list: [], index: 0, trip: null },
  busy: false,
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

async function photoURL(photoId, kind = "full") {
  if (!photoId) return null;
  let e = state.urls.get(photoId);
  if (e && e[kind]) return e[kind];
  const blob = kind === "full" ? await photoBlob(photoId) : await thumbBlob(photoId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  e = e || {};
  e[kind] = url;
  state.urls.set(photoId, e);
  return url;
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
  await openDB();
  const res = await fetch("data/regions.json");
  state.data = await res.json();

  state.map = createMap($("map"), state.data, {
    onPick: (code) => pickRegion(code),
    onHover: (code, pos) => showTooltip(code, pos),
  });

  renderChips();
  bindUI();
  await refreshAll({ animateMap: false });
  $("mapHint").classList.toggle("gone", state.visited.size > 0);
  if (!location.hash) setTimeout(() => $("mapHint").classList.add("gone"), 9000);
}

async function refreshAll({ animateMap = true } = {}) {
  state.trips = await listTrips();
  const photos = await listPhotos();
  state.photos = new Map(photos.map((p) => [p.id, p]));

  state.byRegion = new Map();
  for (const t of state.trips) {
    if (!state.byRegion.has(t.regionCode)) state.byRegion.set(t.regionCode, []);
    state.byRegion.get(t.regionCode).push(t);
  }

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
  const trips = state.byRegion.get(code) || [];
  for (let i = trips.length - 1; i >= 0; i--) {
    const t = trips[i];
    if (t.coverPhotoId) return t.coverPhotoId;
  }
  return null;
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
}
function closePanel() {
  $("panel").classList.remove("open");
  $("panel").setAttribute("aria-hidden", "true");
  document.body.classList.remove("panel-open");
  state.map.setSideInset(0);
  state.selected = null;
  state.map.setSelected(null);
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
        const u = await photoURL(pid, "full");
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
        const u = await photoURL(pid, "full");
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

  let coverBtn = $("lbCover");
  if (!coverBtn) {
    const bar = ensureLbActions();
    coverBtn = document.createElement("button");
    coverBtn.id = "lbCover";
    coverBtn.className = "btn soft";
    coverBtn.type = "button";
    bar.append(coverBtn);
    coverBtn.addEventListener("click", async () => {
      const { trip: t, list: l, index: i } = state.lightbox;
      if (!t) return;
      const updated = { ...t, coverPhotoId: l[i].pid };
      await updateTrip(updated);
      toast("대표 사진을 바꿨어요 ✨");
      for (const pid of t.photoIds || []) forgetURLs(pid);
      await refreshAll();
      renderLightbox();
    });
  }
  const isCover = trip && trip.coverPhotoId === cur.pid;
  coverBtn.textContent = isCover ? "✓ 대표 사진이에요" : "⭐ 대표 사진으로";
  coverBtn.disabled = !trip || isCover;

  let delBtn = $("lbDelete");
  if (!delBtn) {
    const bar = ensureLbActions();
    delBtn = document.createElement("button");
    delBtn.id = "lbDelete";
    delBtn.className = "btn ghost";
    delBtn.type = "button";
    delBtn.textContent = "🗑 이 사진 지우기";
    bar.append(delBtn);
    delBtn.addEventListener("click", async () => {
      const { trip: t, list: l, index: i } = state.lightbox;
      if (!t) return;
      const ok = await confirmAction("이 사진을 지울까요?", { ok: "지우기" });
      if (!ok) return;
      const pid = l[i].pid;
      const ids = (t.photoIds || []).filter((x) => x !== pid);
      await deletePhoto(pid);
      forgetURLs(pid);
      const updated = {
        ...t,
        photoIds: ids,
        coverPhotoId: t.coverPhotoId === pid ? ids[0] || null : t.coverPhotoId,
      };
      await updateTrip(updated);
      await refreshAll();
      if (!ids.length) return closeLightbox();
      const list = [];
      for (const id of ids) {
        const u = await photoURL(id, "full");
        if (u) list.push({ pid: id, u });
      }
      state.lightbox = { list, index: Math.min(i, list.length - 1), trip: updated };
      renderLightbox();
      toast("사진을 지웠어요");
    });
  }
  delBtn.hidden = !trip;
}
function ensureLbActions() {
  let bar = $("lbActions");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "lbActions";
    bar.className = "lb-actions";
    $("lightbox").append(bar);
  }
  return bar;
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lbImg").src = "";
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

    if (existing) {
      await addPhotosToTrip(existing, processed);
      toast("사진을 더했어요 📷");
    } else {
      await createTrip({
        regionCode: code, date,
        title: $("tripTitle").value.trim(),
        memo: $("tripMemo").value.trim(),
        photos: processed, coverIndex: 0,
      });
      toast("여행 기록을 남겼어요 ✨");
    }
    closeTripModal();
    state.selected = code;
    state.map.setSelected(code);
    openPanel();
    await refreshAll();
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
    if (act === "export") await doExport();
    if (act === "import") $("importInput").click();
    if (act === "clear-samples") {
      const n = await clearSamples();
      for (const p of [...state.urls.keys()]) forgetURLs(p);
      await refreshAll();
      toast(n ? `예시 ${n}개를 지웠어요` : "지울 예시가 없어요");
    }
    if (act === "about") $("aboutOverlay").hidden = false;
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
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox") || e.target.classList.contains("lb-figure")) closeLightbox();
  });

  // 정보
  $("aboutClose").addEventListener("click", () => ($("aboutOverlay").hidden = true));
  $("aboutOverlay").addEventListener("click", (e) => {
    if (e.target === $("aboutOverlay")) $("aboutOverlay").hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("lightbox").hidden) closeLightbox();
      else if (!$("tripOverlay").hidden) closeTripModal();
      else if (!$("aboutOverlay").hidden) $("aboutOverlay").hidden = true;
      else if (state.selected) closePanel();
    }
    if (!$("lightbox").hidden) {
      if (e.key === "ArrowLeft") stepLightbox(-1);
      if (e.key === "ArrowRight") stepLightbox(1);
    }
  });

  bindPanel();
}

init().catch((e) => {
  console.error(e);
  toast("앱을 불러오지 못했어요. 새로고침해 주세요");
});
