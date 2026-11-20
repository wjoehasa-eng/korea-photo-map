#!/usr/bin/env python3
"""서비스 워커 업데이트(kpm-v2 → kpm-v3) 검증 — 옛 캐시가 남아 새 기능이 안 뜨던 문제.

    python3 tools/verify_sw_update.py

하는 일
1. 옛 배포본(kpm-v2 · '캐시 먼저' 전략 · 연동 핸들러 없는 app.js)을 같은 주소에 띄우고
   설치형 앱처럼 서비스 워커가 제어하는 상태를 만든다.
2. 곧바로 새 배포본(이 저장소의 현재 파일)으로 바꾼다 — 사용자가 앱을 새로 여는 상황.
3. 다음을 확인한다.
   - 새 캐시(kpm-shell-kpm-v3)가 생기고 옛 캐시(kpm-v2)는 지워짐
   - 이 앱과 무관한 캐시(다른 github.io 앱)는 건드리지 않음
   - index.html이 ?v=3로 새 app.js를 불러와 ⋯ → ☁️ 구글 드라이브 연동이 즉시 열림
   - 주소 입력 → 연결 테스트까지 동작(가짜 Apps Script 응답)
   - 오프라인에서도 앱 셸이 열림(네트워크 우선으로 바꾼 뒤의 회귀 확인)
   - JS 콘솔 오류 0건
"""
import http.server
import json
import os
import re
import shutil
import socketserver
import sys
import threading
import time
import urllib.parse

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, ".tmp", "sw-update")
PORT = 8814
PREFIX = "/korea-photo-map/"
MOCK_URL = "https://script.google.com/macros/s/MOCK_DEPLOY_TEST/exec"

results = []
console_errors = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ((" · " + str(detail)) if detail != "" else ""))


# ── 옛 배포본(kpm-v2) 재현물 ────────────────────────────────
LEGACY_SW = """/* kpm-v2 옛 서비스 워커 — '캐시 먼저'라 index.html만 새로 받고 js는 옛 파일이 남았다. */
const VERSION = "kpm-v2";
const CACHE = `kpm-shell-${VERSION}`;
const SHELL = [
  "./", "./index.html", "./styles.css", "./js/app.js", "./js/map.js", "./js/store.js",
  "./js/cloud.js", "./js/sample.js", "./data/regions.json", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(req);
  })());
});
"""

# 옛 빌드의 app.js: 연동 핸들러가 없어 ⋯ → 구글 드라이브 연동이 아무 반응도 없다.
LEGACY_APP = """/* kpm-v2 옛 빌드 — 구글 드라이브 연동 없음 */
window.KPM_LEGACY = true;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
document.addEventListener("DOMContentLoaded", () => {
  const menu = document.getElementById("menu");
  const btn = document.getElementById("btnMenu");
  if (!menu || !btn) return;
  btn.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  // ⋯ 메뉴는 열리지만 '구글 드라이브 연동' 항목에는 핸들러가 없다 — 눌러도 아무 반응 없음(kpm-v2).
  menu.addEventListener("click", () => { menu.hidden = true; });
});
console.log("kpm legacy build");
"""

OVERRIDES = {}  # pathname(상대) -> 실제 파일 경로


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        rel = urllib.parse.urlsplit(path).path
        if rel.startswith(PREFIX):
            rel = rel[len(PREFIX):]
        elif rel == PREFIX.rstrip("/"):
            rel = ""
        else:
            self.send_error(404)
            return os.path.join(TMP, "__missing__")
        rel = rel or "index.html"
        if rel in OVERRIDES:
            return OVERRIDES[rel]
        return os.path.join(ROOT, rel)

    def end_headers(self):
        # 검증 환경에서는 HTTP 캐시(If-Modified-Since 304)가 업데이트 판정을 흐리지 않게 한다.
        if self.path.split("?")[0].endswith((".js", ".html", ".css", ".json", ".webmanifest", "/")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def build_legacy_site():
    if os.path.isdir(TMP):
        shutil.rmtree(TMP)
    os.makedirs(TMP, exist_ok=True)
    sw = os.path.join(TMP, "sw-v2.js")
    app = os.path.join(TMP, "app-v2.js")
    html = os.path.join(TMP, "index-v2.html")
    open(sw, "w", encoding="utf-8").write(LEGACY_SW)
    open(app, "w", encoding="utf-8").write(LEGACY_APP)
    src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    old = src.replace("?v=3", "")
    if old == src:
        print("경고: index.html에 ?v=3 표시가 없습니다(옛 배포본 재현이 어긋날 수 있음)")
    open(html, "w", encoding="utf-8").write(old)
    # 옛 배포본 파일의 수정 시각을 과거로 돌려 둔다 — 새 배포본으로 바꿨을 때 304가 나오지 않도록.
    past = time.time() - 7200
    for f in (sw, app, html):
        os.utime(f, (past, past))
    return {"sw.js": sw, "js/app.js": app, "index.html": html, "": html}


def caches_summary(page):
    return page.evaluate("""async () => {
      const keys = await caches.keys();
      const out = {keys, urls: []};
      for (const k of keys) {
        const c = await caches.open(k);
        const reqs = await c.keys();
        out.urls.push(...reqs.map(r => new URL(r.url).pathname));
      }
      return out;
    }""")


def open_cloud_modal(page):
    page.click("#btnMenu")
    page.wait_for_selector('#menu button[data-act="cloud"]', state="visible", timeout=5000)
    page.click('#menu button[data-act="cloud"]')
    page.wait_for_selector("#cloudOverlay:not([hidden])", timeout=5000)


def mock_script_google(mock):
    def handler(route, request):
        if request.method != "POST":
            route.fulfill(status=200, headers={"content-type": "application/json"}, body=json.dumps({"ok": True}))
            return
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        mock["calls"].append(body)
        if body.get("action") == "ping":
            payload = {"ok": True, "app": "korea-photo-map", "version": 2, "trips": 0, "photos": 0,
                       "title": "[비공개] 여행 사진 지도 데이터", "photoFolder": True}
        else:
            payload = {"ok": True, "trips": [], "photos": [], "regions": []}
        route.fulfill(status=200, headers={"content-type": "application/json",
                                          "access-control-allow-origin": "*"},
                      body=json.dumps(payload))

    return handler


def main():
    url = f"http://127.0.0.1:{PORT}{PREFIX}"
    legacy = build_legacy_site()
    srv = start_server()
    print("검증 URL:", url, "\n")

    mock = {"calls": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
        # 검증 환경은 외부 인터넷이 막혀 있어 구글 폰트는 빈 CSS로 대신한다(앱 동작과 무관).
        ctx.route("https://fonts.googleapis.com/**",
                  lambda route, req: route.fulfill(status=200, content_type="text/css", body=""))
        ctx.route("https://fonts.gstatic.com/**",
                  lambda route, req: route.fulfill(status=200, content_type="font/woff2", body=""))

        # ── 1. 옛 배포본: kpm-v2 설치·제어 ──────────────────
        OVERRIDES.clear()
        OVERRIDES.update(legacy)
        page.goto(url, wait_until="domcontentloaded")
        sw = page.evaluate("""async () => {
          const reg = await navigator.serviceWorker.ready;
          for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) {
            await new Promise(r => setTimeout(r, 100));
          }
          return {active: !!reg.active, controlled: !!navigator.serviceWorker.controller};
        }""")
        check("옛 배포본: 서비스 워커 활성·제어", sw.get("active") and sw.get("controlled"), sw)
        cache_a = caches_summary(page)
        check("옛 배포본: kpm-shell-kpm-v2 캐시 생성", "kpm-shell-kpm-v2" in cache_a["keys"], cache_a["keys"])
        check("옛 배포본: 옛 app.js가 실행됨", page.evaluate("() => !!window.KPM_LEGACY"))
        page.click("#btnMenu")
        page.wait_for_timeout(300)
        page.click('#menu button[data-act="cloud"]')
        page.wait_for_timeout(600)
        check("옛 배포본 재현: 연동 버튼이 아무 반응 없음(문제 상황)",
              page.get_attribute("#cloudOverlay", "hidden") is not None)

        # 이 앱과 무관한 캐시(같은 origin의 다른 github.io 앱)를 심어 둔다.
        page.evaluate("""async () => {
          const c = await caches.open('other-app-shell-v1');
          await c.put('/other-app/index.html', new Response('ok', {type: 'basic'}));
        }""")

        # ── 2. 새 배포본으로 교체(사용자가 앱을 다시 여는 상황) ──
        OVERRIDES.clear()
        nav = {"n": 0}
        page.on("framenavigated", lambda f: nav.__setitem__("n", nav["n"] + 1) if f == page.main_frame else None)

        # 브라우저는 스스로(길면 24시간 안에) 새 sw.js를 확인하고, 새 빌드는 켤 때마다 reg.update()를 부른다.
        page.evaluate("() => navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => null)")

        state = {}
        deadline = time.time() + 45
        while time.time() < deadline:
            state = page.evaluate("""async () => {
              const reg = await navigator.serviceWorker.getRegistration();
              const keys = await caches.keys();
              let entries = 0;
              for (const k of keys) entries += (await (await caches.open(k)).keys()).length;
              return {keys, entries, state: reg && reg.active && reg.active.state};
            }""")
            if ("kpm-shell-kpm-v3" in state["keys"] and "kpm-shell-kpm-v2" not in state["keys"]
                    and state.get("state") == "activated"):
                break
            page.wait_for_timeout(400)
        check("새 워커(kpm-v3) 활성화", state.get("state") == "activated" and "kpm-shell-kpm-v3" in state.get("keys", []),
              state.get("state"))
        check("옛 캐시 kpm-v2 삭제", "kpm-shell-kpm-v2" not in state.get("keys", []), state.get("keys"))
        check("다른 앱 캐시는 보존(other-app-shell-v1)", "other-app-shell-v1" in state.get("keys", []), state.get("keys"))
        shell_count = page.evaluate("""async () => {
          const c = await caches.open('kpm-shell-kpm-v3');
          return (await c.keys()).length;
        }""")
        check("새 캐시에 앱 셸 13개 담김", shell_count == 13, shell_count)

        # 사용자가 앱을 다시 여는 상황
        page.reload(wait_until="domcontentloaded")

        def new_build_loaded():
            try:
                return page.evaluate(
                    "() => document.querySelectorAll('#map .region').length === 250"
                    " && !!document.querySelector('link[rel=stylesheet][href*=\"v=3\"]')"
                )
            except Exception:
                return False

        ok = False
        deadline = time.time() + 40
        while time.time() < deadline:
            if new_build_loaded():
                ok = True
                break
            page.wait_for_timeout(400)
        check("새 배포본: 사용자가 아무것도 지우지 않아도 새 app.js 실행", ok)
        check("새 배포본: 옛 빌드 흔적 없음", not page.evaluate("() => !!window.KPM_LEGACY"))
        page.wait_for_timeout(2500)
        check("새로고침이 반복되지 않음(무한 리로드 없음)", nav["n"] <= 3, nav["n"])

        sw2 = page.evaluate("""async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          const res = await fetch('./sw.js', {cache: 'no-store'});
          const text = await res.text();
          return {scope: reg && reg.scope, controlled: !!navigator.serviceWorker.controller,
                  version: (text.match(/VERSION = "([^"]+)"/) || [])[1],
                  script: reg && reg.active && reg.active.scriptURL};
        }""")
        check("서비스 워커 VERSION = kpm-v3", sw2.get("version") == "kpm-v3", sw2.get("version"))
        check("페이지가 워커에 제어됨", sw2.get("controlled"), sw2)

        # ── 3. ⋯ → 구글 드라이브 연동 즉시 동작 ─────────────
        page.route("https://script.google.com/**", mock_script_google(mock))
        t0 = time.time()
        open_cloud_modal(page)
        elapsed = round((time.time() - t0) * 1000)
        check("⋯ → ☁️ 구글 드라이브 연동: 창이 바로 열림", page.is_visible("#cloudOverlay"), f"{elapsed}ms")
        check("연동 창 제목", "구글 드라이브 연동" in page.inner_text("#cloudTitle"), page.inner_text("#cloudTitle"))

        page.fill("#cloudUrl", MOCK_URL)
        page.click("#cloudTest")
        try:
            page.wait_for_function(
                "() => { const el = document.getElementById('cloudStatus');"
                " return el && !el.hidden && (el.className.includes('ok') || el.className.includes('err')); }",
                timeout=20000,
            )
            status = page.inner_text("#cloudStatus")
        except Exception:
            status = "(응답 없음)"
        check("주소 입력 → 연결 테스트 성공", "연결됐어요" in status, status)
        check("연결 테스트가 서버로 ping을 보냄", any(c.get("action") == "ping" for c in mock["calls"]),
              [c.get("action") for c in mock["calls"]])

        page.click("#cloudClose")
        page.wait_for_selector("#cloudOverlay[hidden]", state="attached")

        # ── 4. 네트워크 우선으로 바꾼 뒤에도 오프라인 실행 ──
        ctx.set_offline(True)
        try:
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#map .region", timeout=20000)
            n = page.eval_on_selector_all("#map .region", "els => els.length")
            check("오프라인에서 앱 셸 열림", n == 250, n)
            page.click("#btnMenu")
            page.click('#menu button[data-act="cloud"]')
            page.wait_for_selector("#cloudOverlay:not([hidden])", timeout=5000)
            check("오프라인에서도 연동 창 열림", page.is_visible("#cloudOverlay"))
        except Exception as exc:
            check("오프라인에서 앱 셸 열림", False, str(exc)[:160])
        finally:
            ctx.set_offline(False)

        # ── 5. 온라인 복귀 후 기존 기능 ─────────────────────
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#map .region")
        page.wait_for_timeout(500)
        check("온라인 복귀 후 지도 250개", page.eval_on_selector_all("#map .region", "els => els.length") == 250)
        page.click('path.region[aria-label^="고창군"]')
        page.wait_for_selector("#panel.open")
        check("지역 클릭 → 패널", "고창군" in page.inner_text("#panelTitle"), page.inner_text("#panelTitle"))
        page.click("#panelClose")

        # 네트워크 우선이 실제로 새 파일을 받아오는지: 파일을 바꾸면 새로고침 한 번에 반영된다.
        probe = os.path.join(TMP, "styles-probe.css")
        css = open(os.path.join(ROOT, "styles.css"), encoding="utf-8").read()
        open(probe, "w", encoding="utf-8").write(css + "\n:root { --kpm-probe: changed; }\n")
        OVERRIDES["styles.css"] = probe
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        changed = page.evaluate(
            "() => getComputedStyle(document.documentElement).getPropertyValue('--kpm-probe').trim() === 'changed'")
        check("파일이 바뀌면 새로고침 한 번에 새 내용 반영(네트워크 우선)", changed)
        OVERRIDES.clear()

        os.makedirs(os.path.join(ROOT, "shots"), exist_ok=True)
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_selector("#map .region")
        page.click("#btnMenu")
        page.click('#menu button[data-act="cloud"]')
        page.wait_for_selector("#cloudOverlay:not([hidden])")
        page.screenshot(path=os.path.join(ROOT, "shots", "30-cloud-from-menu.png"))
        ctx.close()
        browser.close()

    srv.shutdown()

    check("JS 콘솔 오류 0건", len(console_errors) == 0, console_errors[:3])

    failed = [r for r in results if not r[1]]
    print(f"\n총 {len(results)}개 검사 · 통과 {len(results) - len(failed)} · 실패 {len(failed)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
