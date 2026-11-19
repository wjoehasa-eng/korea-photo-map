// 지도 렌더링 · 확대/축소 · 이동 · 검색 포커스
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_K = 1;
const MAX_K = 9;

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function pathBBox(d) {
  const nums = d.replace(/[MZ]/g, " ").trim().split(/\s+/).map(Number);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < nums.length; i += 2) {
    const x = nums[i], y = nums[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function createMap(svg, data, opts = {}) {
  const { onPick, onHover, onViewChange } = opts;
  const vb = data.viewBox;
  svg.setAttribute("viewBox", vb.join(" "));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const defs = el("defs");
  const world = el("g", { id: "world" });
  const gRegions = el("g", { id: "regions" });
  const gLabels = el("g", { id: "labels", "pointer-events": "none" });
  world.append(gRegions, gLabels);
  svg.append(defs, world);

  const regionByCode = new Map();
  const nodeByCode = new Map();
  const labelByCode = new Map();
  const bboxByCode = new Map();
  const patternByCode = new Map();
  const visited = new Set();
  let selected = null;

  // 지역 폴리곤
  for (const r of data.regions) {
    const bbox = pathBBox(r.path);
    bboxByCode.set(r.code, bbox);
    const p = el("path", {
      d: r.path,
      class: "region",
      "data-code": r.code,
      tabindex: "0",
      role: "button",
      "aria-label": `${r.name}${r.sido ? " " + r.sido : ""}`,
    });
    gRegions.append(p);
    nodeByCode.set(r.code, p);
    regionByCode.set(r.code, r);

    const label = el("text", {
      x: r.cx, y: r.cy, class: "region-label hidden",
      "text-anchor": "middle", "dominant-baseline": "middle",
    });
    label.textContent = r.name;
    label.dataset.area = r.area;
    gLabels.append(label);
    labelByCode.set(r.code, label);
  }

  // ── 뷰 상태 ──────────────────────────────────────────────
  const view = { k: MIN_K, tx: 0, ty: 0 };
  const vbW = vb[2], vbH = vb[3];

  function applyTransform(changed = true) {
    world.setAttribute("transform", `translate(${view.tx.toFixed(2)} ${view.ty.toFixed(2)}) scale(${view.k.toFixed(4)})`);
    if (changed) {
      updateLabels();
      if (onViewChange) onViewChange({ ...view });
    }
  }

  function clampView() {
    view.k = Math.max(MIN_K, Math.min(MAX_K, view.k));
    const k = view.k;
    // 확대 시 지도가 화면을 벗어나지 않도록
    const minTx = Math.min(0, vbW - vbW * k);
    const minTy = Math.min(0, vbH - vbH * k);
    view.tx = Math.max(minTx, Math.min(0, view.tx));
    view.ty = Math.max(minTy, Math.min(0, view.ty));
  }

  function svgPoint(clientX, clientY) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function zoomAt(clientX, clientY, factor, animate = false) {
    const p = svgPoint(clientX, clientY);
    const k0 = view.k;
    const k1 = Math.max(MIN_K, Math.min(MAX_K, k0 * factor));
    if (Math.abs(k1 - k0) < 1e-4) return;
    const wx = (p.x - view.tx) / k0;
    const wy = (p.y - view.ty) / k0;
    view.k = k1;
    view.tx = p.x - wx * k1;
    view.ty = p.y - wy * k1;
    clampView();
    if (animate) smoothTo(view.tx, view.ty, view.k);
    else applyTransform();
  }

  let animId = 0;
  function smoothTo(tx, ty, k, dur = 420) {
    const start = { ...view };
    const t0 = performance.now();
    const id = ++animId;
    function step(now) {
      if (id !== animId) return;
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      view.k = start.k + (k - start.k) * e;
      view.tx = start.tx + (tx - start.tx) * e;
      view.ty = start.ty + (ty - start.ty) * e;
      applyTransform();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function unitPerPx() {
    const rect = svg.getBoundingClientRect();
    return Math.max(vbW / rect.width, vbH / rect.height);
  }

  // 패널이 열려 가려지는 영역(px)만큼 포커스를 왼쪽으로 치우치게
  let sideInset = 0;
  function setSideInset(px) {
    sideInset = Math.max(0, px || 0);
  }

  function flyToBox(box, pad = 1.25, maxK = 5.5) {
    const bw = Math.max(box.w, 1e-3), bh = Math.max(box.h, 1e-3);
    let k = Math.min(vbW / (bw * pad), vbH / (bh * pad));
    k = Math.max(MIN_K, Math.min(maxK, k));
    const cx = box.x + bw / 2, cy = box.y + bh / 2;
    const inset = sideInset * unitPerPx();
    let tx = (vbW - inset) / 2 - cx * k;
    let ty = vbH / 2 - cy * k;
    const minTx = Math.min(0, vbW - vbW * k);
    const minTy = Math.min(0, vbH - vbH * k);
    tx = Math.max(minTx, Math.min(0, tx));
    ty = Math.max(minTy, Math.min(0, ty));
    smoothTo(tx, ty, k);
  }

  function reset() {
    smoothTo(0, 0, MIN_K);
  }

  function focusRegion(code, pad = 3.2) {
    const b = bboxByCode.get(code);
    if (!b) return;
    const fitK = Math.max(vbW / (Math.max(b.w, 1) * 3.6), vbH / (Math.max(b.h, 1) * 3.6));
    const target = Math.max(1.6, Math.min(5.2, fitK));
    const k = Math.max(view.k, target);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const inset = sideInset * unitPerPx();
    let tx = (vbW - inset) / 2 - cx * k;
    let ty = vbH / 2 - cy * k;
    const minTx = Math.min(0, vbW - vbW * k);
    const minTy = Math.min(0, vbH - vbH * k);
    tx = Math.max(minTx, Math.min(0, tx));
    ty = Math.max(minTy, Math.min(0, ty));
    smoothTo(tx, ty, k);
  }

  function focusSido(sido) {
    const box = data.sidoBoxes[sido];
    if (!box) return reset();
    flyToBox({ x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] }, 1.18, 4.2);
  }

  // ── 라벨 표시 ────────────────────────────────────────────
  function updateLabels() {
    const k = view.k;
    const rect = svg.getBoundingClientRect();
    const fit = Math.min(rect.width / vbW, rect.height / vbH) || 1;
    const threshold = rect.width < 620 ? 900 : 1100;
    const placed = [];

    // 큰 지역부터 자리를 잡고, 겹치는 작은 지역 라벨은 숨긴다
    const ordered = [...labelByCode.entries()].sort(
      (a, b) => Number(b[1].dataset.area || 0) - Number(a[1].dataset.area || 0)
    );
    for (const [code, label] of ordered) {
      const area = Number(label.dataset.area || 0);
      const isSelected = code === selected;
      const wanted = area * k * k > threshold || isSelected;
      let show = wanted;
      let box = null;

      if (wanted) {
        // 화면에서 읽기 좋은 크기(px)로 유지
        const px = 9.5 + Math.min(3.5, Math.sqrt(area) / 30);
        const units = px / (fit * k);
        label.style.fontSize = `${units.toFixed(2)}px`;
        const name = label.textContent || "";
        const w = units * (name.length * 1.12 + 1.4);
        const h = units * 1.5;
        const cx = Number(label.getAttribute("x"));
        const cy = Number(label.getAttribute("y"));
        box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
        if (!isSelected) {
          show = !placed.some((p) => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1));
        }
      }

      label.classList.toggle("hidden", !show);
      label.classList.toggle("on-photo", visited.has(code));
      if (show && box) placed.push(box);
    }
  }

  // ── 사진 채우기 ──────────────────────────────────────────
  function setPhoto(code, url) {
    const b = bboxByCode.get(code);
    if (!b) return;
    let pat = patternByCode.get(code);
    if (!pat) {
      // patternTransform으로 타일을 지역 bbox에 맞춘다 (x/y 오프셋을 쓰면 브라우저마다 어긋남)
      pat = el("pattern", {
        id: `pat-${code}`,
        patternUnits: "userSpaceOnUse",
        x: 0, y: 0,
        width: Math.max(b.w, 0.5), height: Math.max(b.h, 0.5),
        patternTransform: `translate(${b.x} ${b.y})`,
      });
      const img = el("image", {
        x: 0, y: 0, width: Math.max(b.w, 0.5), height: Math.max(b.h, 0.5),
        preserveAspectRatio: "xMidYMid slice",
      });
      pat.append(img);
      defs.append(pat);
      patternByCode.set(code, pat);
    }
    pat.querySelector("image").setAttribute("href", url);
    pat.querySelector("image").setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
    const node = nodeByCode.get(code);
    node.style.fill = `url(#pat-${code})`;
    node.classList.add("visited");
  }

  function clearPhoto(code) {
    const node = nodeByCode.get(code);
    if (!node) return;
    node.style.fill = "";
    node.removeAttribute("fill");
    node.classList.remove("visited");
    const pat = patternByCode.get(code);
    if (pat) {
      pat.remove();
      patternByCode.delete(code);
    }
  }

  function setVisitedSet(codes) {
    visited.clear();
    for (const c of codes) visited.add(c);
    for (const [code, node] of nodeByCode) {
      if (!visited.has(code)) node.classList.remove("visited");
    }
    updateLabels();
  }

  function setSelected(code) {
    if (selected && nodeByCode.get(selected)) nodeByCode.get(selected).classList.remove("selected");
    selected = code;
    if (code && nodeByCode.get(code)) nodeByCode.get(code).classList.add("selected");
    updateLabels();
  }

  function setDim(set) {
    for (const [code, node] of nodeByCode) {
      node.classList.toggle("dim", !!set && !set.has(code));
    }
  }

  // ── 포인터 상호작용 ──────────────────────────────────────
  const pointers = new Map();
  let dragMoved = false;
  let downTarget = null;
  let pinchStart = 0;
  let pinchK = 1;
  let lastMid = null;

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture?.(e.pointerId);
    dragMoved = false;
    downTarget = e.target.closest?.(".region") || null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchK = view.k;
      lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    svg.classList.add("panning");
  });

  svg.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) { handleHover(e); return; }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinchStart > 0) {
        const targetK = Math.max(MIN_K, Math.min(MAX_K, pinchK * (dist / pinchStart)));
        const p = svgPoint(mid.x, mid.y);
        const k0 = view.k;
        const wx = (p.x - view.tx) / k0, wy = (p.y - view.ty) / k0;
        view.k = targetK;
        view.tx = p.x - wx * targetK + (mid.x - lastMid.x) * 0;
        view.ty = p.y - wy * targetK;
        clampView();
        applyTransform();
        dragMoved = true;
        lastMid = mid;
      }
      return;
    }

    if (Math.abs(dx) + Math.abs(dy) > 0) {
      if (!dragMoved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) dragMoved = true;
      // 화면 픽셀 -> SVG 사용자 단위 (viewBox 비율 고려)
      const rect = svg.getBoundingClientRect();
      const unit = Math.max(vbW / rect.width, vbH / rect.height);
      view.tx += dx * unit;
      view.ty += dy * unit;
      clampView();
      applyTransform();
    }
    handleHover(e);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    svg.classList.remove("panning");
    if (pointers.size < 2) { pinchStart = 0; }
    if (!dragMoved && downTarget) {
      const code = downTarget.getAttribute("data-code");
      if (code && onPick) onPick(code);
    }
    if (pointers.size === 0) downTarget = null;
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0018);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  svg.addEventListener("dblclick", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, 1.8, true);
  });

  svg.addEventListener("keydown", (e) => {
    const code = e.target?.getAttribute?.("data-code");
    if ((e.key === "Enter" || e.key === " ") && code) {
      e.preventDefault();
      onPick?.(code);
    }
  });

  // ── 호버 ────────────────────────────────────────────────
  let hoverTimer = 0;
  function handleHover(e) {
    if (dragMoved) return;
    const region = e.target.closest?.(".region");
    if (!region) return onHover?.(null, null);
    const code = region.getAttribute("data-code");
    onHover?.(code, { x: e.clientX, y: e.clientY });
  }
  svg.addEventListener("pointerleave", () => onHover?.(null, null));

  updateLabels();
  const rect0 = svg.getBoundingClientRect();
  if (rect0.width && rect0.width < 620) {
    // 모바일: 처음부터 나라가 화면에 꽉 차게 조금 당겨 본다
    view.k = 1.35;
    view.tx = (vbW - vbW * view.k) / 2;
    view.ty = (vbH - vbH * view.k) / 2;
    clampView();
  }
  applyTransform(false);

  window.addEventListener("resize", () => {
    applyTransform(false);
    updateLabels();
  });

  return {
    view,
    regionByCode,
    bboxByCode,
    setPhoto,
    clearPhoto,
    setVisitedSet,
    setSelected,
    setDim,
    focusRegion,
    focusSido,
    setSideInset,
    reset,
    zoomAt,
    zoomStep(factor) {
      const rect = svg.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    },
    get visited() { return visited; },
  };
}
