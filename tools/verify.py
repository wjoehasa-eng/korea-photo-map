#!/usr/bin/env python3
"""앱 동작 검증 (데스크톱 1280 · 모바일 390).

로컬 http 서버로 앱을 띄우고 실제 사용자 흐름을 따라가며 확인한다.
결과 스크린샷은 work/korea-photo-map-shots/ 에 저장.
"""
import http.server
import json
import os
import socketserver
import sys
import threading

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.abspath(os.environ.get("KPM_SHOTS", os.path.join(ROOT, "shots")))
PORT = 8811

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ((" · " + str(detail)) if detail else ""))


def make_images():
    paths = []
    specs = [("테스트사진1", (250, 180, 120), "TRAVEL 1"), ("테스트사진2", (120, 170, 220), "TRAVEL 2")]
    os.makedirs("/tmp/kpm", exist_ok=True)
    for i, (name, color, label) in enumerate(specs):
        im = Image.new("RGB", (1600, 1200), color)
        d = ImageDraw.Draw(im)
        d.rectangle([80, 80, 1520, 1120], outline=(255, 255, 255), width=12)
        d.text((120, 560), label, fill=(255, 255, 255))
        p = f"/tmp/kpm/{name}.jpg"
        im.save(p, quality=90)
        paths.append(p)
    return paths


def start_server():
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=ROOT, **kw)
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    os.makedirs(SHOTS, exist_ok=True)
    imgs = make_images()
    srv = start_server()
    url = f"http://127.0.0.1:{PORT}/"
    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])

        # ── 데스크톱 ────────────────────────────────────────
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))

        page.goto(url, wait_until="networkidle")
        page.wait_for_selector("#map .region")
        page.wait_for_timeout(400)

        n_regions = page.eval_on_selector_all("#map .region", "els => els.length")
        check("지도에 시·군·구 250개 렌더", n_regions == 250, n_regions)
        check("지도 SVG 크기", page.eval_on_selector("#map", "e => e.getBoundingClientRect().width > 900"))

        # 제주·울릉도·독도 존재
        has = page.evaluate("""() => {
          const els = [...document.querySelectorAll('#map .region')];
          const names = els.map(e => e.getAttribute('aria-label'));
          return {
            jeju: names.filter(l => l.endsWith('제주')).length,
            ulleung: names.some(l => l.startsWith('울릉군')),
            west: names.some(l => l.includes('옹진')),
          };
        }""")
        check("제주 2개 지역 포함", has["jeju"] == 2, has)
        check("울릉군 포함", has["ulleung"], has)
        page.screenshot(path=f"{SHOTS}/01-desktop-initial.png")

        # 지역 클릭 → 패널
        page.click('path.region[aria-label^="고창군"]')
        page.wait_for_selector("#panel.open")
        page.wait_for_timeout(800)
        check("지역 클릭 시 패널 열림", page.is_visible("#panel"))
        title = page.inner_text("#panelTitle")
        check("패널 제목 = 고창군", "고창군" in title, title)
        zt = page.eval_on_selector("#world", "e => e.getAttribute('transform')")
        import re as _re2
        mm = _re2.search(r"scale\(([\d.]+)\)", zt or "")
        check("지역 선택 시 확대 이동", bool(mm) and float(mm.group(1)) > 1.4, zt)
        check("미방문 배지 표시", "미방문" in title)
        page.screenshot(path=f"{SHOTS}/02-desktop-panel-empty.png")

        # 여행 기록 추가
        page.click("#btnAddTrip")
        page.wait_for_selector("#tripOverlay:not([hidden])")
        page.fill("#tripDate", "2025-05-04")
        page.fill("#tripTitle", "고창 봄소풍")
        page.fill("#tripMemo", "바람이 좋았던 날. 다음엔 자전거도 타자.")
        page.set_input_files("#photoInput", imgs)
        page.wait_for_selector(".preview-item")
        n_prev = page.eval_on_selector_all(".preview-item", "els => els.length")
        check("사진 미리보기 2장", n_prev == 2, n_prev)
        page.screenshot(path=f"{SHOTS}/03-desktop-trip-form.png")
        page.click("#tripSave")
        page.wait_for_selector("#tripOverlay[hidden]", state="attached", timeout=15000)
        page.wait_for_timeout(1200)

        trips = page.eval_on_selector_all(".trip", "els => els.length")
        check("저장 후 여행 카드 표시", trips == 1, trips)
        visited = page.inner_text("#visitedCount")
        check("진행률 방문 수 1", visited == "1", visited)

        fill = page.evaluate("""() => {
          const p = document.querySelector('path.region[aria-label^="고창군"]');
          const pat = document.querySelector('pattern[id^="pat-"] image');
          return { fill: p.style.fill || p.getAttribute('fill'), computed: getComputedStyle(p).fill,
                   href: pat ? (pat.getAttribute('href')||'') : null,
                   slice: pat ? pat.getAttribute('preserveAspectRatio') : null };
        }""")
        check("행정구역 폴리곤이 사진 패턴으로 채워짐", bool(fill["fill"]) and "url(" in fill["fill"] and "pat-" in fill["fill"], fill["fill"])
        check("패턴 이미지가 blob URL", bool(fill["href"]) and fill["href"].startswith("blob:"), (fill["href"] or "")[:30])
        check("preserveAspectRatio=xMidYMid slice", fill["slice"] == "xMidYMid slice", fill["slice"])
        check("계산된 fill이 사진 패턴", "url(" in (fill["computed"] or ""), fill["computed"])

        # 실제 픽셀이 사진(주황)으로 칠해졌는지 확인
        page.wait_for_timeout(500)
        rbox = page.eval_on_selector('path.region[aria-label^="고창군"]',
            "e => { const r = e.getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height}; }")
        cx, cy = rbox["x"] + rbox["w"] / 2, rbox["y"] + rbox["h"] / 2
        crop = f"{SHOTS}/04b-region-crop.png"
        page.screenshot(path=crop, clip={"x": max(0, cx - 14), "y": max(0, cy - 14), "width": 28, "height": 28})
        px = list(Image.open(crop).convert("RGB").getdata())
        avg = tuple(sum(c[i] for c in px) // len(px) for i in range(3))
        check("폴리곤이 실제 사진 픽셀로 채워짐(주황)", avg[0] > 200 and avg[1] > 130 and avg[2] < 190, avg)
        page.screenshot(path=f"{SHOTS}/04-desktop-filled-region.png")

        # 라이트박스
        page.click(".trip .strip button")
        page.wait_for_selector("#lightbox:not([hidden])")
        check("사진 클릭 시 라이트박스", page.is_visible("#lbImg"))
        cap = page.inner_text("#lbCaption")
        check("라이트박스 캡션", "고창군" in cap, cap)
        page.wait_for_timeout(1200)
        page.screenshot(path=f"{SHOTS}/05-desktop-lightbox.png")

        # 사진 한 장 지우기
        page.click("#lbDelete")
        page.wait_for_selector("button[data-v='1']")
        page.click("button[data-v='1']")
        page.wait_for_timeout(1200)
        n_strip = page.eval_on_selector_all(".trip .strip button", "els => els.length")
        check("사진 한 장 삭제", n_strip == 1, n_strip)
        badge = page.inner_text("#panelTitle")
        check("남은 사진 수 반영", "1장" in badge, badge)
        if page.is_visible("#lightbox"):
            page.click("#lbClose")

        # 줌 / 이동 / 초기화
        before = page.eval_on_selector("#world", "e => e.getAttribute('transform')")
        page.click("#zoomIn")
        page.wait_for_timeout(250)
        after = page.eval_on_selector("#world", "e => e.getAttribute('transform')")
        check("확대 버튼 동작", before != after, f"{before} -> {after}")
        page.mouse.move(640, 430)
        page.mouse.wheel(0, -400)
        page.wait_for_timeout(200)
        after2 = page.eval_on_selector("#world", "e => e.getAttribute('transform')")
        check("휠 줌 동작", after2 != after)
        # 드래그 이동
        box = page.eval_on_selector("#map", "e => { const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
        page.mouse.move(box["x"] + box["w"] * 0.5, box["y"] + box["h"] * 0.5)
        page.mouse.down()
        page.mouse.move(box["x"] + box["w"] * 0.4, box["y"] + box["h"] * 0.42, steps=8)
        page.mouse.up()
        page.wait_for_timeout(200)
        after3 = page.eval_on_selector("#world", "e => e.getAttribute('transform')")
        check("드래그 팬 동작", after3 != after2)
        page.click("#zoomReset")
        page.wait_for_timeout(1000)
        reset_t = page.eval_on_selector("#world", "e => e.getAttribute('transform')")
        import re as _re
        m_scale = _re.search(r"scale\(([\d.]+)\)", reset_t or "")
        check("초기화 버튼", bool(m_scale) and abs(float(m_scale.group(1)) - 1) < 0.02, reset_t)

        # 검색
        page.fill("#searchInput", "강남")
        page.wait_for_selector(".search-item")
        first = page.inner_text(".search-item")
        check("검색 결과 표시", "강남구" in first, first)
        page.click(".search-item")
        page.wait_for_timeout(700)
        check("검색 결과 클릭 시 패널 이동", "강남구" in page.inner_text("#panelTitle"), page.inner_text("#panelTitle"))
        page.screenshot(path=f"{SHOTS}/06-desktop-search.png")
        page.fill("#searchInput", "")

        # 시·도 칩
        page.click('.chip[data-sido="경기"]')
        page.wait_for_timeout(700)
        dim = page.eval_on_selector_all(".region.dim", "els => els.length")
        check("시·도 칩 필터(다른 지역 흐리게)", dim > 150, dim)
        page.screenshot(path=f"{SHOTS}/07-desktop-sido-filter.png")
        try:
            page.click('.chip[data-sido=""]', timeout=5000)
        except Exception as exc:
            diag = page.evaluate('''() => {
              const c = document.querySelector('.chip[data-sido=""]');
              const r = c.getBoundingClientRect();
              const t = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
              const chips = document.querySelector('.chips');
              return {rect:[r.x,r.y,r.width,r.height], top: t ? t.outerHTML.slice(0,120) : null,
                      scroll:[chips.scrollLeft, chips.scrollTop], vw: innerWidth,
                      z: getComputedStyle(c).zIndex};
            }''')
            print("DIAG", diag)
            print("ERR", str(exc)[:300])
        page.wait_for_timeout(500)
        # 백업 내보내기
        page.click("#btnMenu")
        with page.expect_download() as dl:
            page.click('button[data-act="export"]')
        download = dl.value
        backup_path = f"{SHOTS}/backup.json"
        download.save_as(backup_path)
        size = os.path.getsize(backup_path)
        data = json.load(open(backup_path))
        check("백업 JSON 내려받기", size > 1000 and len(data["trips"]) == 1, f"{size}B, trips={len(data['trips'])}")

        # 예시 채우기
        page.click("#btnSample")
        page.wait_for_function("() => Number(document.getElementById('visitedCount').textContent) > 10", timeout=60000)
        page.wait_for_timeout(1500)
        visited_n = int(page.inner_text("#visitedCount"))
        check("예시 채우기 동작", visited_n > 10, visited_n)
        page.screenshot(path=f"{SHOTS}/08-desktop-sample-filled.png")
        patterns = page.eval_on_selector_all("pattern", "els => els.length")
        check("여러 지역 사진 패턴 생성", patterns > 10, patterns)

        # 새로고침 후 유지
        page.reload(wait_until="networkidle")
        page.wait_for_selector("#map .region")
        page.wait_for_timeout(1200)
        check("새로고침 후 데이터 유지(IndexedDB)", page.inner_text("#visitedCount") == str(visited_n),
              page.inner_text("#visitedCount"))

        # 예시 지우기
        page.click("#btnMenu")
        page.click('button[data-act="clear-samples"]')
        page.wait_for_timeout(1500)
        check("예시 지우기 후 1개만 남음", page.inner_text("#visitedCount") == "1", page.inner_text("#visitedCount"))

        page.screenshot(path=f"{SHOTS}/09-desktop-final.png")

        # ── 백업 불러오기(새 컨텍스트) ──────────────────────
        ctx2 = browser.new_context(viewport={"width": 1280, "height": 860})
        p2 = ctx2.new_page()
        p2.on("pageerror", lambda e: console_errors.append("pageerror2: " + str(e)))
        p2.goto(url, wait_until="networkidle")
        p2.wait_for_selector("#map .region")
        p2.click("#btnMenu")
        with p2.expect_file_chooser() as fc:
            p2.click('button[data-act="import"]')
        fc.value.set_files(backup_path)
        p2.wait_for_function("() => Number(document.getElementById('visitedCount').textContent) === 1", timeout=20000)
        check("백업 불러오기 동작", p2.inner_text("#visitedCount") == "1")
        p2.click('path.region[aria-label^="고창군"]')
        p2.wait_for_selector(".trip")
        check("불러온 기록 표시", "고창 봄소풍" in p2.inner_text("#panelBody"))
        p2.screenshot(path=f"{SHOTS}/10-desktop-imported.png")
        ctx2.close()

        # ── 모바일 390 ─────────────────────────────────────
        m = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                is_mobile=True, has_touch=True)
        pm = m.new_page()
        pm.on("console", lambda msg: console_errors.append("mobile: " + msg.text) if msg.type == "error" else None)
        pm.on("pageerror", lambda e: console_errors.append("pageerror-mobile: " + str(e)))
        pm.goto(url, wait_until="networkidle")
        pm.wait_for_selector("#map .region")
        pm.wait_for_timeout(600)
        check("모바일 지도 렌더", pm.eval_on_selector_all("#map .region", "els => els.length") == 250)
        overflow = pm.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
        check("모바일 가로 스크롤 없음", overflow)
        pm.screenshot(path=f"{SHOTS}/11-mobile-initial.png")

        # 모바일 줌 버튼 (패널 닫힌 상태)
        before_m = pm.eval_on_selector("#world", "e => e.getAttribute('transform')")
        pm.click("#zoomIn")
        pm.wait_for_timeout(300)
        after_m = pm.eval_on_selector("#world", "e => e.getAttribute('transform')")
        check("모바일 줌 버튼", before_m != after_m)
        pm.screenshot(path=f"{SHOTS}/15-mobile-zoomed.png")
        pm.click("#zoomReset")
        pm.wait_for_timeout(600)

        pm.click('path.region[aria-label^="고창군"]')
        pm.wait_for_selector("#panel.open")
        pm.wait_for_timeout(600)
        sheet = pm.eval_on_selector("#panel", "e => { const r = e.getBoundingClientRect(); return {top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom), w: Math.round(r.width)}; }")
        check("모바일 하단 시트", sheet["bottom"] <= 845 and sheet["h"] > 300 and sheet["w"] <= 391, sheet)
        pm.screenshot(path=f"{SHOTS}/12-mobile-sheet.png")

        pm.click("#btnAddTrip")
        pm.wait_for_selector("#tripOverlay:not([hidden])")
        pm.fill("#tripDate", "2025-06-01")
        pm.fill("#tripTitle", "모바일 테스트")
        pm.fill("#tripMemo", "손가락으로 남긴 기록")
        pm.set_input_files("#photoInput", imgs[:1])
        pm.wait_for_selector(".preview-item")
        pm.screenshot(path=f"{SHOTS}/13-mobile-form.png")
        pm.click("#tripSave")
        pm.wait_for_timeout(2500)
        check("모바일에서 사진 등록", pm.inner_text("#visitedCount") != "0", pm.inner_text("#visitedCount"))
        pm.screenshot(path=f"{SHOTS}/14-mobile-added.png")

        m.close()

        browser.close()

    srv.shutdown()
    print("\n콘솔 오류:", console_errors if console_errors else "0건")
    check("JS 콘솔 오류 0건", len(console_errors) == 0, console_errors[:3])

    failed = [r for r in results if not r[1]]
    print(f"\n총 {len(results)}개 검사 · 통과 {len(results)-len(failed)} · 실패 {len(failed)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
