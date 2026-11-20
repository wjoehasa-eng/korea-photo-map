/* 여행 사진 지도 — 서비스 워커
 * 안드로이드 크롬 WebAPK 설치 조건(오프라인에서도 앱 셸 응답)을 채우고,
 * 지하철·산속처럼 신호가 약한 곳에서도 앱이 바로 열리게 한다.
 *
 * kpm-v3: 앱 코드·문서를 '네트워크 우선'으로 바꿨다.
 * (v2의 '캐시 먼저'는 index.html만 새로 받고 js/app.js는 옛 파일을 계속 돌려줘서
 *  ⋯ → ☁️ 구글 드라이브 연동 같은 새 기능이 설치형 앱에서 동작하지 않았다.)
 */
const VERSION = "kpm-v3";
const CACHE = `kpm-shell-${VERSION}`;
const CACHE_PREFIX = "kpm-shell-"; // 이 앱의 캐시만 지운다(github.io 한 origin에 다른 앱 캐시도 있다)
const NETWORK_TIMEOUT = 3000; // 이보다 느리면 캐시로 먼저 열고, 네트워크는 뒤에서 반영

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/map.js",
  "./js/store.js",
  "./js/cloud.js",
  "./js/sample.js",
  "./data/regions.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

// 온라인일 때 항상 새 파일을 먼저 받아야 하는 자원(코드·문서·데이터).
const NETWORK_FIRST = /\.(?:html|css|m?js|webmanifest|json)$/i;

const offline = (msg) =>
  new Response(msg || "오프라인이라 지금은 불러올 수 없어요.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

// ?v=3 같은 쿼리는 캐시 키에서 빼 둔다 — 오프라인 폴백이 버전과 무관하게 맞도록.
function cacheKeyFor(req) {
  const url = new URL(req.url);
  return url.origin + url.pathname;
}

function saveIn(cache, req, res) {
  if (!res || !res.ok || res.type !== "basic") return;
  cache.put(cacheKeyFor(req), res.clone()).catch(() => {});
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 캐시를 거치지 않고 새로 받아 담는다.
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // 이전 버전 캐시(kpm-v1, kpm-v2 …)는 전부 버린다.
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// ── 전략 ────────────────────────────────────────────────────
// 화면 이동: 네트워크 우선, 실패하면 캐시한 앱 셸.
async function handleNavigate(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      // 다음 오프라인 실행을 위해 앱 셸로도 담아 둔다.
      cache.put("./index.html", fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    return (
      (await cache.match("./index.html", { ignoreSearch: true })) ||
      (await cache.match("./", { ignoreSearch: true })) ||
      offline("오프라인이라 지금은 열 수 없어요.")
    );
  }
}

// 코드·문서: 네트워크 우선(캐시도 함께 갱신). 네트워크가 아주 느릴 때만 캐시로 먼저 연다.
async function networkFirst(req, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });

  const network = fetch(req)
    .then((res) => {
      saveIn(cache, req, res);
      return res;
    })
    .catch(() => null);

  if (event) event.waitUntil(network.catch(() => {}));

  if (!cached) return (await network) || offline();

  const winner = await Promise.race([
    network,
    new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT)),
  ]);
  return winner || cached;
}

// 이미지·아이콘 등: 캐시 먼저(즉시 표시) + 뒤에서 최신본 갱신.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) {
    fetch(req)
      .then((res) => saveIn(cache, req, res))
      .catch(() => {});
    return cached;
  }
  const fresh = await fetch(req).catch(() => null);
  if (fresh) saveIn(cache, req, fresh);
  return fresh || offline();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // 구글 폰트 등 외부 자원과 blob 등은 브라우저에 맡긴다.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req));
    return;
  }

  if (NETWORK_FIRST.test(url.pathname)) {
    event.respondWith(networkFirst(req, event));
    return;
  }

  event.respondWith(cacheFirst(req));
});
