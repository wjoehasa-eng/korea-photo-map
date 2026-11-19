/* 여행 사진 지도 — 서비스 워커
 * 안드로이드 크롬 WebAPK 설치 조건(오프라인에서도 앱 셸 응답)을 채우고,
 * 지하철·산속처럼 신호가 약한 곳에서도 앱이 바로 열리게 한다.
 */
const VERSION = "kpm-v2";
const CACHE = `kpm-shell-${VERSION}`;

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
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

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

  // 화면 이동: 새 파일을 먼저 받고, 실패하면 캐시한 앱 셸로 연다.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          return (
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            new Response("오프라인이라 지금은 열 수 없어요.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          );
        }
      })()
    );
    return;
  }

  // 그 밖의 같은 사이트 자원: 캐시 먼저(즉시 표시) + 뒤에서 최신본 갱신.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;
      return new Response("오프라인이라 지금은 불러올 수 없어요.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    })()
  );
});
