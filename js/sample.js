// 예시 미리보기용 그림 생성 — 실제 사진·개인정보 없이 캔버스 벡터 아트만 사용
export const SAMPLE_SPOTS = [
  { sido: "서울", name: "종로구", theme: "city", title: "도심 산책", memo: "골목 끝에서 만난 오래된 책방." },
  { sido: "부산", name: "해운대구", theme: "sea", title: "바다 보러 부산", memo: "파도 소리만 들리는 오후." },
  { sido: "대구", name: "중구", theme: "city", title: "골목 투어", memo: "커피 한 잔에 천천히 걷기." },
  { sido: "인천", name: "강화군", theme: "field", title: "주말 드라이브", memo: "바람이 좋아서 창문을 열었다." },
  { sido: "광주", name: "동구", theme: "city", title: "맛있는 하루", memo: "시장 구경하고 국수 한 그릇." },
  { sido: "대전", name: "유성구", theme: "spring", title: "봄 소풍", memo: "돗자리 펴고 누운 하늘." },
  { sido: "울산", name: "울주군", theme: "mountain", title: "등산 다녀왔어요", memo: "정상에서 마신 물이 제일 맛있었다." },
  { sido: "경기", name: "가평군", theme: "lake", title: "자연휴양림", memo: "물소리 들으며 하루 묵기." },
  { sido: "강원", name: "속초시", theme: "sea", title: "겨울 바다", memo: "모래 위에 남은 발자국." },
  { sido: "강원", name: "평창군", theme: "snow", title: "눈꽃 여행", memo: "하얀 산길을 천천히." },
  { sido: "충북", name: "단양군", theme: "river", title: "강 따라", memo: "구름이 물 위에 놀고 있었다." },
  { sido: "충남", name: "태안군", theme: "sunset", title: "노을 맛집", memo: "해가 지는 걸 끝까지 봤다." },
  { sido: "전북", name: "고창군", theme: "field", title: "고창 여행", memo: "고인돌 옆에서 먹은 도시락." },
  { sido: "전남", name: "순천시", theme: "spring", title: "갈대밭 산책", memo: "바람 소리가 참 좋았다." },
  { sido: "전남", name: "여수시", theme: "night", title: "밤바다", memo: "불빛이 물 위에서 흔들린다." },
  { sido: "경북", name: "경주시", theme: "autumn", title: "가을 경주", memo: "한옥 지붕에 내려앉은 단풍." },
  { sido: "경남", name: "거제시", theme: "sea", title: "섬마을", memo: "배 타고 들어간 작은 마을." },
  { sido: "제주", name: "서귀포시", theme: "field", title: "제주 한 달", memo: "귤밭 옆 길을 걸었다." },
  { sido: "제주", name: "제주시", theme: "sunset", title: "제주 노을", memo: "돌담 너머로 진 빛." },
  { sido: "세종", name: "세종특별자치시", theme: "spring", title: "호수 산책", memo: "자전거 타고 한 바퀴." },
];

const PALETTES = {
  spring: { sky: ["#cfe9fb", "#ffeef2"], sun: "#fff2bd", far: "#b9d9d0", mid: "#96c8bb", near: "#a9d9b4", tree: "#6faf8b", accent: "#ffd3de" },
  sea: { sky: ["#cbe9f7", "#eef9f6"], sun: "#fff4c9", far: "#a9d8dd", mid: "#7cc4cf", near: "#69b6c4", tree: "#79b79a", accent: "#fdf1d8" },
  autumn: { sky: ["#ffe7cf", "#ffd7c9"], sun: "#ffd694", far: "#eabb8a", mid: "#d79a63", near: "#c08350", tree: "#c2703f", accent: "#ffcf9a" },
  sunset: { sky: ["#f9cbc2", "#cfbce4"], sun: "#ffd49b", far: "#b6a0c8", mid: "#9880b3", near: "#7f6a9c", tree: "#6d5c8a", accent: "#ffd9b8" },
  snow: { sky: ["#e3eef8", "#f8fcff"], sun: "#ffffff", far: "#cfdeec", mid: "#b7cadd", near: "#cddcea", tree: "#93aec4", accent: "#ffffff" },
  night: { sky: ["#3f3c68", "#7a6398"], sun: "#fff0c2", far: "#585179", mid: "#4a4468", near: "#3c3858", tree: "#2f2c49", accent: "#ffe6a8" },
  mountain: { sky: ["#d6ecf8", "#f2f7f1"], sun: "#fff3c4", far: "#b4cfcb", mid: "#8fb8b1", near: "#7aa79e", tree: "#5f8f7c", accent: "#eaf4ea" },
  field: { sky: ["#e4f2fb", "#fff4e2"], sun: "#ffe8a8", far: "#c9dcb0", mid: "#b3ce95", near: "#d8d09a", tree: "#8aa86c", accent: "#fff0cf" },
  lake: { sky: ["#d8eef9", "#eefaf5"], sun: "#fff0bd", far: "#a9cfd2", mid: "#89bcc2", near: "#9dcbb6", tree: "#6ba48f", accent: "#e6f6f7" },
  river: { sky: ["#d9eef8", "#f0f8ef"], sun: "#fff1c0", far: "#b3d2cd", mid: "#93bfb7", near: "#a8cfb4", tree: "#74a98c", accent: "#e9f6f4" },
  city: { sky: ["#dbeaf6", "#fff0e6"], sun: "#ffe3a3", far: "#c1cbdd", mid: "#a7b4cb", near: "#c9c0b4", tree: "#8fae94", accent: "#ffe2cf" },
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cloud(ctx, x, y, s, alpha = 0.85) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, 20 * s, 0, Math.PI * 2);
  ctx.arc(x + 24 * s, y - 8 * s, 26 * s, 0, Math.PI * 2);
  ctx.arc(x + 54 * s, y + 2 * s, 19 * s, 0, Math.PI * 2);
  ctx.arc(x + 28 * s, y + 12 * s, 22 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function hill(ctx, cx, baseY, w, h, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, baseY);
  ctx.bezierCurveTo(cx - w * 0.28, baseY - h * 1.05, cx + w * 0.24, baseY - h * 1.05, cx + w / 2, baseY);
  ctx.lineTo(cx + w / 2, baseY + h);
  ctx.lineTo(cx - w / 2, baseY + h);
  ctx.closePath();
  ctx.fill();
}

function tree(ctx, x, y, s, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - 34 * s);
  ctx.lineTo(x + 13 * s, y);
  ctx.lineTo(x - 13 * s, y);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - 52 * s);
  ctx.lineTo(x + 10 * s, y - 18 * s);
  ctx.lineTo(x - 10 * s, y - 18 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x - 2 * s, y, 4 * s, 7 * s);
}

function birds(ctx, rnd, color, w, h) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const x = 80 + rnd() * (w - 200);
    const y = 70 + rnd() * (h * 0.28);
    const s = 5 + rnd() * 5;
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.quadraticCurveTo(x - s / 2, y - s * 0.7, x, y);
    ctx.quadraticCurveTo(x + s / 2, y - s * 0.7, x + s, y);
    ctx.stroke();
  }
}

function drawScene(canvas, theme, seed) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  const rnd = mulberry32(seed);
  const p = PALETTES[theme] || PALETTES.spring;

  // 하늘
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(1, p.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const isNight = theme === "night";
  if (isNight) {
    for (let i = 0; i < 70; i++) {
      ctx.globalAlpha = 0.3 + rnd() * 0.7;
      ctx.fillStyle = "#fff6d8";
      const r = rnd() * 1.6 + 0.6;
      ctx.beginPath();
      ctx.arc(rnd() * W, rnd() * H * 0.55, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 해 / 달
  const sunX = W * (0.62 + rnd() * 0.2);
  const sunY = H * (0.2 + rnd() * 0.08);
  const sunR = H * (isNight ? 0.06 : 0.075);
  const glow = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 4.2);
  glow.addColorStop(0, hexA(p.sun, 0.55));
  glow.addColorStop(1, hexA(p.sun, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR * 4.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.sun;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
  ctx.fill();

  // 구름
  cloud(ctx, W * 0.1 + rnd() * 40, H * 0.16, 1.0, isNight ? 0.18 : 0.9);
  cloud(ctx, W * 0.62 + rnd() * 60, H * 0.1 + rnd() * 20, 0.7, isNight ? 0.14 : 0.75);
  if (rnd() > 0.4) cloud(ctx, W * 0.4, H * 0.24, 0.55, isNight ? 0.12 : 0.6);

  birds(ctx, rnd, isNight ? "rgba(255,240,200,.5)" : "rgba(90,100,110,.45)", W, H);

  // 먼 산
  const horizon = H * (0.62 + rnd() * 0.05);
  hill(ctx, W * 0.2, horizon, W * 0.75, H * 0.26, p.far);
  hill(ctx, W * 0.72, horizon + 6, W * 0.8, H * 0.3, p.far);
  hill(ctx, W * 0.45, horizon + 10, W * 0.6, H * 0.2, p.mid);

  // 물 / 들판
  if (theme === "sea" || theme === "lake" || theme === "river" || theme === "night") {
    const seaY = horizon + 4;
    const sea = ctx.createLinearGradient(0, seaY, 0, H);
    sea.addColorStop(0, hexA(p.mid, 1));
    sea.addColorStop(1, hexA(p.near, 1));
    ctx.fillStyle = sea;
    ctx.fillRect(0, seaY, W, H - seaY);
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const y = seaY + 14 + i * ((H - seaY - 20) / 14);
      const x = 30 + rnd() * (W - 160);
      const len = 40 + rnd() * 90;
      ctx.globalAlpha = 0.25 + rnd() * 0.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len / 2, y - 3, x + len, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 앞쪽 언덕
  const fgY = H * 0.82;
  hill(ctx, W * 0.18, fgY, W * 0.9, H * 0.3, p.near);
  hill(ctx, W * 0.85, fgY + 10, W * 0.7, H * 0.26, p.near);

  // 나무들
  const treeCount = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < treeCount; i++) {
    const x = 40 + rnd() * (W - 80);
    const y = fgY + 10 + rnd() * (H - fgY - 40);
    tree(ctx, x, y, 0.7 + rnd() * 0.7, p.tree);
  }

  // 작은 집
  if (theme === "field" || theme === "city" || theme === "spring") {
    const hx = W * (0.2 + rnd() * 0.2), hy = fgY + 30;
    ctx.fillStyle = "#fffaf0";
    ctx.fillRect(hx, hy, 62, 44);
    ctx.fillStyle = hexA(p.accent, 1);
    ctx.beginPath();
    ctx.moveTo(hx - 10, hy);
    ctx.lineTo(hx + 31, hy - 30);
    ctx.lineTo(hx + 72, hy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#c8956c";
    ctx.fillRect(hx + 24, hy + 18, 14, 26);
  }

  // 반짝임
  for (let i = 0; i < 10; i++) {
    ctx.globalAlpha = 0.12 + rnd() * 0.2;
    ctx.fillStyle = "#ffffff";
    const r = 2 + rnd() * 5;
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H * 0.5, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 비네트
  const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(90,70,50,0.14)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function toBlob(canvas, q = 0.85) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
}

export async function renderSamplePhoto(code, theme, index = 0) {
  const main = document.createElement("canvas");
  main.width = 1200;
  main.height = 900;
  drawScene(main, theme, hash(code + ":" + index));
  const blob = await toBlob(main, 0.86);

  const thumb = document.createElement("canvas");
  thumb.width = 520;
  thumb.height = 390;
  const tctx = thumb.getContext("2d");
  tctx.drawImage(main, 0, 0, 520, 390);
  const thumbBlob = await toBlob(thumb, 0.72);

  return { blob, thumb: thumbBlob, w: main.width, h: main.height };
}

export function sampleDate(index) {
  // 최근 1년 사이의 그럴듯한 날짜
  const base = new Date();
  base.setDate(base.getDate() - (18 + index * 17));
  return base.toISOString().slice(0, 10);
}
