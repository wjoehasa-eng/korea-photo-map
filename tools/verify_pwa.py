#!/usr/bin/env python3
"""PWA 설치 지원 검증 — 로컬(프리픽스 서버) 또는 배포 URL.

    python3 tools/verify_pwa.py                       # 로컬: http://127.0.0.1:8812/korea-photo-map/
    KPM_BASE=https://wjoehasa-eng.github.io/korea-photo-map/ python3 tools/verify_pwa.py

확인 항목: 매니페스트·아이콘 응답, 매니페스트 필드, 서비스 워커 활성/제어,
크롬 설치 가능성(CDP), 오프라인 재실행(프리캐시), 기존 기능·콘솔 오류 0건.
"""
import http.server
import io
import json
import os
import re
import socketserver
import sys
import threading
import urllib.parse

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8812
PREFIX = "/korea-photo-map/"
results = []
PERSONAL_PATTERNS = [
    # 개인 식별 문자열은 공개 저장소에 두지 않는다. 필요하면 환경변수로 넘긴다.
    #   KPM_PERSONAL_PATTERNS='이름,아이디,전화끝자리' python3 tools/verify_pwa.py
    p.strip()
    for p in os.environ.get("KPM_PERSONAL_PATTERNS", "").split(",")
    if p.strip()
]
# 누구에게나 해당되는 '모양' 검사(휴대전화 번호·개인 메일 주소)
PERSONAL_REGEXES = [
    re.compile(r"01[016789][-\s]?\d{3,4}[-\s]?\d{4}"),
    re.compile(r"[\w.+-]+@(gmail|naver|daum|kakao|hanmail)\.(com|net)"),
]


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ((" · " + str(detail)) if detail != "" else ""))


class PrefixHandler(http.server.SimpleHTTPRequestHandler):
    """ROOT를 /korea-photo-map/ 아래에 있는 것처럼 서빙한다."""

    def translate_path(self, path):
        path = urllib.parse.urlsplit(path).path
        if path.startswith(PREFIX):
            path = "/" + path[len(PREFIX):]
        elif path == PREFIX.rstrip("/"):
            path = "/"
        else:
            self.send_error(404)
            return os.path.join(ROOT, "__none__")
        return super().translate_path(path)

    def log_message(self, *a):
        pass


def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), PrefixHandler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    base = os.environ.get("KPM_BASE")
    srv = None
    if base:
        url = base if base.endswith("/") else base + "/"
    else:
        srv = start_server()
        url = f"http://127.0.0.1:{PORT}{PREFIX}"
    print("검증 URL:", url, "\n")

    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])

        # ── 1. HTTP 응답: 매니페스트·아이콘 ─────────────────
        ctx0 = browser.new_context()
        req = ctx0.request
        for path, ctype in (
            ("manifest.webmanifest", "json"),
            ("icons/icon-192.png", "png"),
            ("icons/icon-512.png", "png"),
            ("icons/icon-maskable-512.png", "png"),
            ("sw.js", "js"),
        ):
            r = req.get(url + path)
            body = r.body()
            ok = r.status == 200
            if ok and ctype == "png":
                ok = body[:8] == b"\x89PNG\r\n\x1a\n"
            check(f"{path} HTTP 200", ok, f"{r.status}, {len(body)}B, {r.headers.get('content-type')}")

        manifest = req.get(url + "manifest.webmanifest").json()
        expect = {
            "name": "여행 사진 지도", "short_name": "여행지도",
            "id": "/korea-photo-map/", "start_url": "/korea-photo-map/", "scope": "/korea-photo-map/",
            "display": "standalone", "orientation": "any",
            "background_color": "#eef7fb", "theme_color": "#f38b67",
        }
        for k, v in expect.items():
            check(f"manifest {k} = {v}", manifest.get(k) == v, manifest.get(k))
        icons = manifest.get("icons") or []
        sizes = {(i.get("sizes"), i.get("purpose", "any")) for i in icons}
        check("manifest 아이콘 192(any) 포함", ("192x192", "any") in sizes, sizes)
        check("manifest 아이콘 512(any) 포함", ("512x512", "any") in sizes, sizes)
        check("manifest 아이콘 512(maskable) 포함", ("512x512", "maskable") in sizes, sizes)
        for i in icons:
            icon_url = urllib.parse.urljoin(url + "manifest.webmanifest", i["src"])
            r = req.get(icon_url)
            check(f"아이콘 응답 200 · {i['src']}", r.status == 200, r.status)

        # ── 2. 아이콘 픽셀 규격 ─────────────────────────────
        for name, size, check_maskable in (
            ("icon-192.png", 192, False),
            ("icon-512.png", 512, False),
            ("icon-maskable-512.png", 512, True),
        ):
            im = Image.open(io.BytesIO(req.get(url + "icons/" + name).body()))
            ok = im.size == (size, size) and im.mode in ("RGBA", "RGB")
            check(f"{name} 실제 {size}x{size} PNG", ok, f"{im.size} {im.mode}")
            if check_maskable:
                rgba = im.convert("RGBA")
                corners = [rgba.getpixel(p) for p in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1))]
                check("maskable 아이콘 가장자리 불투명(풀블리드)", all(c[3] == 255 for c in corners), corners)
                # 마스커블 안전 영역: 진한 아트워크(핀·지도 테두리)가 중앙 지름 80% 원 안에 있어야 한다.
                import math

                rgb = rgba.convert("RGB")
                w, h = rgb.size
                cx, cy = (w - 1) / 2, (h - 1) / 2
                far = 0.0
                for y in range(0, h, 2):
                    for x in range(0, w, 2):
                        r, g, b = rgb.getpixel((x, y))
                        if max(r, g, b) - min(r, g, b) > 60 or max(r, g, b) < 180:
                            far = max(far, math.hypot(x - cx, y - cy))
                check("maskable 아트워크가 안전 여백(중앙 80%) 안", far <= size * 0.40, round(far / size, 3))
        ctx0.close()

        # ── 3. 데스크톱: 메타·서비스 워커·설치 ───────────────
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
        page.goto(url, wait_until="networkidle")
        page.wait_for_selector("#map .region")

        head = page.evaluate("""() => ({
          manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
          theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
          apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
          swApi: 'serviceWorker' in navigator,
        })""")
        check("head: manifest 링크", head["manifest"] == "./manifest.webmanifest", head["manifest"])
        check("head: theme-color = #f38b67", head["theme"] == "#f38b67", head["theme"])
        check("head: apple-touch-icon", head["apple"] == "./icons/icon-192.png", head["apple"])

        sw = page.evaluate("""async () => {
          if (!('serviceWorker' in navigator)) return {supported: false};
          const reg = await navigator.serviceWorker.ready;
          return {supported: true, scope: reg.scope, active: !!reg.active,
                  state: reg.active && reg.active.state, script: reg.active && reg.active.scriptURL};
        }""")
        check("navigator.serviceWorker.ready 활성", sw.get("active") and sw.get("state") == "activated", sw)
        check("서비스 워커 범위 = /korea-photo-map/", sw.get("scope", "").endswith("/korea-photo-map/"), sw.get("scope"))
        check("서비스 워커 스크립트 = sw.js", (sw.get("script") or "").endswith("/korea-photo-map/sw.js"), sw.get("script"))

        controller = page.evaluate("() => !!navigator.serviceWorker.controller")
        if not controller:
            page.reload(wait_until="networkidle")
            page.wait_for_selector("#map .region")
            controller = page.evaluate("() => !!navigator.serviceWorker.controller")
        check("페이지가 서비스 워커에 제어됨", controller)

        caches_info = page.evaluate("""async () => {
          const keys = await caches.keys();
          const key = keys.find(k => k.startsWith('kpm-shell-'));
          if (!key) return {keys};
          const cache = await caches.open(key);
          const reqs = await cache.keys();
          return {keys, count: reqs.length, urls: reqs.map(r => new URL(r.url).pathname)};
        }""")
        need = ["/index.html", "/styles.css", "/js/app.js", "/data/regions.json", "/manifest.webmanifest",
                "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]
        cached_paths = " ".join(caches_info.get("urls") or [])
        missing = [n for n in need if n not in cached_paths]
        check("앱 셸 프리캐시 완료", not missing, missing or f"{caches_info.get('count')}개")

        # 크롬 설치 가능성 (CDP)
        try:
            cdp = ctx.new_cdp_session(page)
            cdp.send("Page.enable")
            errs = cdp.send("Page.getInstallabilityErrors").get("installabilityErrors", [])
            codes = [e.get("errorId") for e in errs]
            check("크롬 설치 가능성 오류 0건", len(codes) == 0, codes)
            man = cdp.send("Page.getAppManifest")
            check("크롬이 매니페스트 파싱", not man.get("errors"), man.get("errors"))
            check("크롬이 인식한 매니페스트 URL", (man.get("url") or "").endswith("/korea-photo-map/manifest.webmanifest"), man.get("url"))
        except Exception as exc:  # CDP 미지원 브라우저
            check("크롬 설치 가능성 확인(CDP)", False, str(exc)[:160])

        # ── 4. 오프라인 실행 ────────────────────────────────
        ctx.set_offline(True)
        try:
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#map .region", timeout=15000)
            n = page.eval_on_selector_all("#map .region", "els => els.length")
            check("오프라인에서 앱 셸 열림", n == 250, n)
        except Exception as exc:
            check("오프라인에서 앱 셸 열림", False, str(exc)[:160])
        finally:
            ctx.set_offline(False)

        page.reload(wait_until="networkidle")
        page.wait_for_selector("#map .region")
        page.wait_for_timeout(500)

        # ── 5. 기존 기능 회귀 ───────────────────────────────
        check("지도 250개 지역 렌더", page.eval_on_selector_all("#map .region", "els => els.length") == 250)
        page.click('path.region[aria-label^="고창군"]')
        page.wait_for_selector("#panel.open")
        check("지역 클릭 → 패널", "고창군" in page.inner_text("#panelTitle"), page.inner_text("#panelTitle"))
        page.click("#panelClose")
        page.wait_for_timeout(300)

        page.click("#btnSample")
        try:
            page.wait_for_function("() => Number(document.getElementById('visitedCount').textContent) > 10", timeout=90000)
            check("예시 채우기 동작", True, page.inner_text("#visitedCount"))
        except Exception as exc:
            check("예시 채우기 동작", False, str(exc)[:160])
        fill = page.evaluate("""() => {
          const p = document.querySelector('path.region[fill^="url("], pattern[id^="pat-"]');
          return {patterns: document.querySelectorAll('pattern[id^="pat-"]').length};
        }""")
        check("사진 패턴 생성", fill["patterns"] > 10, fill["patterns"])

        # 설치 메뉴: beforeinstallprompt가 없을 때 안내 문구
        page.evaluate("() => { document.getElementById('menuInstall').hidden = false; }")
        page.click("#btnMenu")
        page.click('button[data-act="install"]')
        page.wait_for_timeout(400)
        toast = page.inner_text("#toast") if page.is_visible("#toast") else ""
        check("설치 메뉴 안내 동작", "홈 화면에 추가" in toast or "앱 설치" in toast, toast)

        page.click("#btnMenu")
        page.click('button[data-act="clear-samples"]')
        page.wait_for_timeout(1500)
        check("예시 지우기", page.inner_text("#visitedCount") == "0", page.inner_text("#visitedCount"))

        page.screenshot(path=os.environ.get("KPM_SHOTS", os.path.join(ROOT, "shots")) + "/pwa-desktop.png")
        ctx.close()

        # ── 6. 모바일 390 ───────────────────────────────────
        m = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                is_mobile=True, has_touch=True)
        pm = m.new_page()
        pm.on("console", lambda msg: console_errors.append("mobile: " + msg.text) if msg.type == "error" else None)
        pm.on("pageerror", lambda e: console_errors.append("pageerror-mobile: " + str(e)))
        pm.goto(url, wait_until="networkidle")
        pm.wait_for_selector("#map .region")
        pm.wait_for_timeout(600)
        check("모바일 지도 렌더", pm.eval_on_selector_all("#map .region", "els => els.length") == 250)
        msw = pm.evaluate("""async () => {
          const reg = await navigator.serviceWorker.ready;
          return {active: !!reg.active, scope: reg.scope};
        }""")
        check("모바일 서비스 워커 활성", msw["active"], msw)
        os.makedirs(os.environ.get("KPM_SHOTS", os.path.join(ROOT, "shots")), exist_ok=True)
        pm.screenshot(path=os.path.join(os.environ.get("KPM_SHOTS", os.path.join(ROOT, "shots")), "pwa-mobile.png"))
        m.close()
        browser.close()

    if srv:
        srv.shutdown()

    # ── 7. 개인정보 0건 ─────────────────────────────────────
    hits = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in {".git", ".sources", "shots", "node_modules"}]
        for fn in filenames:
            if not fn.endswith((".html", ".js", ".css", ".json", ".webmanifest", ".md", ".py")):
                continue
            if fn == "verify_pwa.py":  # 검사 패턴을 담고 있는 검사기 자신은 제외
                continue
            path = os.path.join(dirpath, fn)
            try:
                text = open(path, encoding="utf-8").read()
            except UnicodeDecodeError:
                continue
            for pat in PERSONAL_PATTERNS:
                if pat in text:
                    hits.append(f"{os.path.relpath(path, ROOT)}: {pat}")
            for rx in PERSONAL_REGEXES:
                m = rx.search(text)
                if m:
                    hits.append(f"{os.path.relpath(path, ROOT)}: {m.group(0)[:12]}…")
    check("개인정보 문자열 0건", not hits, hits[:5])

    print("\n콘솔 오류:", console_errors if console_errors else "0건")
    check("JS 콘솔 오류 0건", len(console_errors) == 0, console_errors[:3])

    failed = [r for r in results if not r[1]]
    print(f"\n총 {len(results)}개 검사 · 통과 {len(results)-len(failed)} · 실패 {len(failed)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
