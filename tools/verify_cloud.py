#!/usr/bin/env python3
"""구글 드라이브 연동 + 모바일 하단 시트 검증 — 가짜 Apps Script 웹앱으로 왕복을 흉내 낸다.

    python3 tools/verify_cloud.py

확인 항목
1. 연동 주소가 없을 때: 지금까지처럼 100% 로컬로 동작(회귀)
2. 연결 테스트(ping) · 로컬 기록·사진 올리기 · 다른 기기에서 내려받기
3. 일기 대표 사진과 지도 대표 사진의 분리 저장(setTripCover / setRegionCover)
4. 새 여행을 남겨도 기존 지도 대표 사진이 덮어써지지 않음
5. 사진·기록 삭제가 시트에도 반영
6. 모바일(390px): 시트 스와이프 닫기 · ✕ 닫기(44px) · 지도 탭 닫기 · 뒤로가기로 창 닫기
7. JS 콘솔 오류 0건
"""
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.parse

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")
PORT = 8813
PREFIX = "/korea-photo-map/"
MOCK_URL = "https://script.google.com/macros/s/MOCK_DEPLOY_TEST/exec"

results = []
console_errors = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ((" · " + str(detail)) if detail != "" else ""))


# ── 가짜 Apps Script 서버 ──────────────────────────────────
class MockSheet:
    def __init__(self):
        self.trips = []
        self.photos = []
        self.regions = []
        self.blobs = {}
        self.calls = []
        self.seq = 0

    # 대표 사진 도우미 -------------------------------------------------
    def set_trip_cover(self, trip_id, photo_id):
        for t in self.trips:
            if t["id"] == trip_id:
                t["coverPhotoId"] = photo_id
        for p in self.photos:
            if p["tripId"] == trip_id:
                p["isCover"] = p["photoId"] == photo_id

    def set_region_cover(self, code, photo_id, name=""):
        row = next((r for r in self.regions if r["regionCode"] == code), None)
        stamp = "2026-11-19T21:40:00.000Z"
        if row:
            row["coverPhotoId"] = photo_id
            if name:
                row["regionName"] = name
            row["updatedAt"] = stamp
        else:
            self.regions.append({
                "regionCode": code, "regionName": name,
                "coverPhotoId": photo_id, "updatedAt": stamp,
            })

    def refresh_region_cover(self, code):
        row = next((r for r in self.regions if r["regionCode"] == code), None)
        if not row:
            return
        rest = [p for p in self.photos if p["regionCode"] == code]
        if any(p["photoId"] == row["coverPhotoId"] for p in rest):
            return
        row["coverPhotoId"] = rest[0]["photoId"] if rest else ""

    # 요청 처리 -------------------------------------------------------
    def handle(self, body):
        action = body.get("action", "ping")
        self.calls.append(action)

        if action == "ping":
            return {
                "ok": True, "app": "korea-photo-map", "version": 2,
                "title": "[비공개] 여행 사진 지도 데이터",
                "trips": len(self.trips), "photos": len(self.photos),
                "regions": len(self.regions), "photoFolder": True,
            }

        if action == "list":
            return {"ok": True, "trips": self.trips, "photos": self.photos, "regions": self.regions}

        if action == "photo":
            pid = body.get("pid") or ""
            size = body.get("size") or "full"
            item = self.blobs.get(pid) or {}
            data = item.get("thumb") if size == "thumb" else item.get("full")
            data = data or item.get("full")
            if not data:
                return {"ok": False, "error": "사진을 찾지 못했습니다."}
            return {"ok": True, "mimeType": "image/jpeg", "dataUrl": "data:image/jpeg;base64," + data}

        if action == "saveTrip":
            t = dict(body.get("trip") or {})
            cur = next((x for x in self.trips if x["id"] == t.get("id")), None)
            if cur is not None:
                cur.update(t)
                trip = cur
            else:
                self.trips.append(t)
                trip = t
            return {"ok": True, "trip": trip}

        if action == "uploadPhoto":
            pid = body.get("photoId") or ""
            data = body.get("data") or ""
            thumb = body.get("thumb") or ""
            raw = data.split(",", 1)[-1] if data.startswith("data:") else data
            traw = thumb.split(",", 1)[-1] if thumb.startswith("data:") else thumb
            self.blobs[pid] = {"full": raw, "thumb": traw or raw}
            self.seq += 1
            rec = {
                "photoId": pid,
                "tripId": body.get("tripId") or "",
                "regionCode": body.get("regionCode") or "",
                "driveFileId": "drive_%03d" % self.seq,
                "fileName": body.get("fileName") or "",
                "mimeType": body.get("mimeType") or "image/jpeg",
                "isCover": bool(body.get("isCover")),
                "order": int(body.get("order") or 0),
                "createdAt": "2026-11-19T21:30:00.000Z",
            }
            cur = next((x for x in self.photos if x["photoId"] == pid), None)
            if cur is not None:
                cur.update(rec)
            else:
                self.photos.append(rec)
            if rec["isCover"]:
                self.set_trip_cover(rec["tripId"], pid)
            # 지역의 첫 사진이면 지도 대표로 (덮어쓰지 않음)
            others = [p for p in self.photos if p["regionCode"] == rec["regionCode"] and p["photoId"] != pid]
            row = next((r for r in self.regions if r["regionCode"] == rec["regionCode"]), None)
            if not others and (not row or not row.get("coverPhotoId")):
                self.set_region_cover(rec["regionCode"], pid, body.get("regionName") or "")
            return {"ok": True, "photo": rec, "thumb": bool(traw)}

        if action in ("setCover", "setTripCover"):
            self.set_trip_cover(body.get("tripId") or "", body.get("photoId") or "")
            return {"ok": True}

        if action == "setRegionCover":
            self.set_region_cover(body.get("regionCode") or "", body.get("photoId") or "", body.get("regionName") or "")
            return {"ok": True}

        if action == "deletePhoto":
            pid = body.get("photoId") or ""
            self.photos = [p for p in self.photos if p["photoId"] != pid]
            self.blobs.pop(pid, None)
            for t in self.trips:
                if t.get("coverPhotoId") == pid:
                    rest = [p for p in self.photos if p["tripId"] == t["id"]]
                    t["coverPhotoId"] = rest[0]["photoId"] if rest else ""
            return {"ok": True, "deleted": True}

        if action == "deleteTrip":
            tid = body.get("tripId") or ""
            mine = [p for p in self.photos if p["tripId"] == tid]
            for p in mine:
                self.blobs.pop(p["photoId"], None)
            self.photos = [p for p in self.photos if p["tripId"] != tid]
            self.trips = [t for t in self.trips if t["id"] != tid]
            for code in {p["regionCode"] for p in mine}:
                self.refresh_region_cover(code)
            return {"ok": True, "deleted": True, "deletedPhotos": len(mine)}

        return {"ok": False, "error": "알 수 없는 action 입니다: " + action}


MOCK = MockSheet()


def make_route(mock):
    def handler(route, request):
        if request.method != "POST":
            route.fulfill(
                status=200,
                headers={"content-type": "application/json", "access-control-allow-origin": "*"},
                body=json.dumps({"ok": True, "app": "korea-photo-map"}),
            )
            return
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        try:
            out = mock.handle(body)
        except Exception as exc:  # pragma: no cover
            out = {"ok": False, "error": "mock 오류: %s" % exc}
        route.fulfill(
            status=200,
            headers={"content-type": "application/json", "access-control-allow-origin": "*"},
            body=json.dumps(out),
        )

    return handler


# ── 로컬 프리픽스 서버 ─────────────────────────────────────
class PrefixHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = urllib.parse.urlsplit(path).path
        if path.startswith(PREFIX):
            path = "/" + path[len(PREFIX):]
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


# ── 도우미 ────────────────────────────────────────────────
def make_image(path, color, size=(900, 640)):
    img = Image.new("RGB", size, color)
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, size[0] - 40, size[1] - 40], outline=(255, 255, 255), width=8)
    d.ellipse([size[0] // 3, size[1] // 4, size[0] * 2 // 3, size[1] * 3 // 4], fill=(255, 255, 255))
    img.save(path, "JPEG", quality=88)
    return path


def wait_until(page, fn, timeout=25.0, interval=0.25, label=""):
    """Playwright 이벤트(가짜 서버 응답)를 처리하려면 대기 중에도 페이지를 한 번씩 만져 준다."""
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        page.wait_for_timeout(int(interval * 1000))
    print("   (시간 초과) " + label)
    return False


def new_page(browser, viewport=(1280, 900), touch=False, cloud_url=None):
    ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, has_touch=touch,
                              is_mobile=touch)
    page = ctx.new_page()
    page.route("https://script.google.com/**", make_route(MOCK))
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append("pageerror: " + str(e)))
    if cloud_url:
        page.add_init_script("localStorage.setItem('kpm.cloud.url', %s);" % json.dumps(cloud_url))
    return ctx, page


def open_cloud_modal(page):
    page.click("#btnMenu")
    page.wait_for_selector('#menu button[data-act="cloud"]', state="visible")
    page.click('#menu button[data-act="cloud"]')
    page.wait_for_selector("#cloudOverlay:not([hidden])")


def add_trip(page, region_label, date, title, memo, images, via="panel"):
    page.click('path.region[aria-label^="%s"]' % region_label)
    page.wait_for_selector("#panel.open")
    page.wait_for_timeout(500)
    page.click("#btnAddTrip")
    page.wait_for_selector("#tripOverlay:not([hidden])")
    page.fill("#tripDate", date)
    page.fill("#tripTitle", title)
    page.fill("#tripMemo", memo)
    page.set_input_files("#photoInput", images)
    page.wait_for_selector(".preview-item")
    page.click("#tripSave")
    page.wait_for_selector("#tripOverlay[hidden]", state="attached", timeout=25000)
    page.wait_for_timeout(900)


def open_lightbox_photo(page, n=1):
    page.wait_for_selector(".trip .strip button")
    page.click(".trip .strip button:nth-child(%d)" % n)
    page.wait_for_selector("#lightbox:not([hidden])")
    page.wait_for_timeout(700)


def close_lightbox(page):
    if page.is_visible("#lightbox"):
        page.click("#lbClose")
        page.wait_for_selector("#lightbox[hidden]", state="attached")


def region_row(code):
    return next((r for r in MOCK.regions if r["regionCode"] == code), None)


def trip_cover(trip_index=0):
    return MOCK.trips[trip_index]["coverPhotoId"] if len(MOCK.trips) > trip_index else None


# ── 데스크톱: 연동·동기화·대표 사진 분리 ───────────────────
def desktop_flow(browser, img1, img2):
    ctx, page = new_page(browser)
    page.goto("http://127.0.0.1:%d%s" % (PORT, PREFIX), wait_until="networkidle")
    page.wait_for_selector("#map .region")
    page.wait_for_timeout(400)
    check("연동 전 서버 호출 없음", len(MOCK.calls) == 0, MOCK.calls)

    add_trip(page, "고창군", "2026-05-04", "고창 봄소풍", "바람이 좋았던 날", [img1])
    check("로컬 모드: 기록 추가", page.eval_on_selector_all(".trip", "els => els.length") == 1)
    filled = page.evaluate(
        "() => { const p = document.querySelector('pattern[id^=\"pat-\"] image'); return p ? p.getAttribute('href') || '' : ''; }"
    )
    check("로컬 모드: 지도 사진 채움", filled.startswith("blob:"), filled[:20])
    page.screenshot(path=os.path.join(SHOTS, "20-cloud-local-mode.png"))

    # 연결 테스트
    open_cloud_modal(page)
    page.fill("#cloudUrl", MOCK_URL)
    page.click("#cloudTest")
    wait_until(page, lambda: "연결됐어요" in page.inner_text("#cloudStatus"), 20, label="ping 응답")
    check("연결 테스트 성공", "연결됐어요" in page.inner_text("#cloudStatus"),
          page.inner_text("#cloudStatus").replace("\n", " / "))
    page.screenshot(path=os.path.join(SHOTS, "21-cloud-connected.png"))

    # 지금 동기화
    page.wait_for_timeout(400)
    page.click("#cloudSync")
    wait_until(page, lambda: len(MOCK.trips) >= 1 and len(MOCK.photos) >= 1, 35, label="업로드")
    check("기록 1건 시트로 올림", len(MOCK.trips) == 1, len(MOCK.trips))
    check("사진 1장 드라이브로 올림", len(MOCK.photos) == 1, len(MOCK.photos))
    if MOCK.trips:
        t = MOCK.trips[0]
        check("올린 기록 내용", t.get("regionName") == "고창군" and t.get("date") == "2026-05-04",
              "%s / %s" % (t.get("regionName"), t.get("date")))
    if MOCK.photos:
        p0 = MOCK.photos[0]
        check("사진 파일 이름", str(p0.get("fileName", "")).startswith("고창군_2026-05-04"), p0.get("fileName"))
        check("사진 썸네일도 함께 올림", bool(MOCK.blobs.get(p0["photoId"], {}).get("thumb")))
    row = region_row(MOCK.trips[0]["regionCode"]) if MOCK.trips else None
    check("첫 사진이 지도 대표로 기록됨", bool(row) and row["coverPhotoId"] == (MOCK.photos[0]["photoId"] if MOCK.photos else ""),
          row)
    wait_until(page, lambda: "동기화" in page.inner_text("#cloudStatus"), 15, label="동기화 완료 표시")
    page.click("#cloudClose")
    page.wait_for_selector("#cloudOverlay[hidden]", state="attached")
    page.screenshot(path=os.path.join(SHOTS, "22-cloud-synced.png"))

    # 사진 추가 → 자동 업로드
    page.click('.trip button[data-act="add-photo"]')
    page.wait_for_selector("#tripOverlay:not([hidden])")
    page.set_input_files("#photoInput", [img2])
    page.wait_for_selector(".preview-item")
    page.click("#tripSave")
    page.wait_for_selector("#tripOverlay[hidden]", state="attached", timeout=25000)
    wait_until(page, lambda: len(MOCK.photos) == 2, 30, label="사진 추가 업로드")
    check("사진을 더하면 바로 올라감", len(MOCK.photos) == 2, len(MOCK.photos))
    first_photo = MOCK.photos[0]["photoId"]
    check("사진을 더해도 지도 대표는 그대로", (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId") == first_photo,
          region_row(MOCK.trips[0]["regionCode"]))

    # 일기 대표 사진 바꾸기 (사진 2)
    open_lightbox_photo(page, 2)
    page.click("#lbCover")
    ok = wait_until(page, lambda: trip_cover() == MOCK.photos[1]["photoId"], 20, label="setTripCover")
    check("일기 대표 사진 변경 → setTripCover", ok and "setTripCover" in MOCK.calls, trip_cover())
    check("일기 대표를 바꿔도 지도 대표는 그대로",
          (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId") == first_photo,
          (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId"))
    close_lightbox(page)

    # 지도 대표 사진 바꾸기 (사진 2 → 지도)
    open_lightbox_photo(page, 2)
    page.click("#lbMapCover")
    ok = wait_until(page, lambda: (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId") == MOCK.photos[1]["photoId"],
                    20, label="setRegionCover")
    check("지도 대표 사진 변경 → setRegionCover", ok and "setRegionCover" in MOCK.calls,
          (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId"))
    check("지도 대표를 바꿔도 일기 대표는 그대로", trip_cover() == MOCK.photos[1]["photoId"], trip_cover())
    page.wait_for_timeout(600)
    check("라이트박스에 지도 대표 표시", "지도 대표" in page.inner_text("#lbMapCover"), page.inner_text("#lbMapCover"))
    close_lightbox(page)

    # 새 여행을 추가해도 기존 지도 대표가 덮이지 않는지
    map_cover_before = (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId")
    page.click('path.region[aria-label^="고창군"]')
    page.wait_for_selector("#panel.open")
    page.click("#btnAddTrip")
    page.wait_for_selector("#tripOverlay:not([hidden])")
    page.fill("#tripDate", "2026-09-14")
    page.fill("#tripTitle", "가을 고창")
    page.set_input_files("#photoInput", [img1])
    page.wait_for_selector(".preview-item")
    page.click("#tripSave")
    page.wait_for_selector("#tripOverlay[hidden]", state="attached", timeout=25000)
    wait_until(page, lambda: len(MOCK.trips) == 2 and len(MOCK.photos) == 3, 30, label="두 번째 기록 업로드")
    check("같은 지역에 새 여행을 남겨도 지도 대표 유지",
          (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId") == map_cover_before,
          "%s -> %s" % (map_cover_before, (region_row(MOCK.trips[0]["regionCode"]) or {}).get("coverPhotoId")))

    # 사진 삭제
    page.click('.trip button[data-act="add-photo"]')  # 패널: 가장 최근 카드의 사진 버튼
    page.wait_for_selector("#tripOverlay:not([hidden])")
    page.click("#tripCancel")
    before = len(MOCK.photos)
    open_lightbox_photo(page, 1)
    page.click("#lbDelete")
    page.wait_for_selector("button[data-v='1']")
    page.click("button[data-v='1']")
    ok = wait_until(page, lambda: len(MOCK.photos) == before - 1, 20, label="deletePhoto")
    check("사진 삭제가 드라이브에도 반영", ok and "deletePhoto" in MOCK.calls, len(MOCK.photos))
    close_lightbox(page)

    # 다른 기기에서 내려받기
    ctx_b, page_b = new_page(browser, cloud_url=MOCK_URL)
    page_b.goto("http://127.0.0.1:%d%s" % (PORT, PREFIX), wait_until="networkidle")
    page_b.wait_for_selector("#map .region")
    page_b.wait_for_timeout(600)
    wait_until(page_b, lambda: page_b.inner_text("#visitedCount") == "1", 35, label="다른 기기에서 내려받기")
    check("새 기기에서 방문 지역 복원", page_b.inner_text("#visitedCount") == "1", page_b.inner_text("#visitedCount"))
    photos_meta = page_b.evaluate("""async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('korea-photo-map'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const all = await new Promise((res, rej) => { const t = db.transaction('photos').objectStore('photos').getAll(); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
      return all.map(p => ({ drive: !!p.driveFileId, hasBlob: !!p.blob, remote: !!p.remote }));
    }""")
    check("사진 레코드에 driveFileId", all(x["drive"] for x in photos_meta) if photos_meta else False,
          [x["drive"] for x in photos_meta])
    page_b.click('path.region[aria-label^="고창군"]')
    page_b.wait_for_selector("#panel.open")
    page_b.wait_for_timeout(1600)
    cards = page_b.eval_on_selector_all(".trip", "els => els.length")
    check("새 기기에서 기록 카드 표시", cards == 2, cards)
    imgs = page_b.evaluate("() => [...document.querySelectorAll('.trip img')].map(i => i.src.slice(0, 5))")
    check("드라이브 사진이 화면에 표시(blob)", len(imgs) >= 2 and all(s == "blob:" for s in imgs), imgs)
    page_b.screenshot(path=os.path.join(SHOTS, "23-cloud-other-device.png"))

    # 기록 삭제
    page_b.click('.trip button[data-act="delete-trip"]')
    page_b.wait_for_selector("button[data-v='1']")
    page_b.click("button[data-v='1']")
    ok = wait_until(page_b, lambda: len(MOCK.trips) == 1, 20, label="deleteTrip")
    check("기록 삭제가 시트·드라이브에 반영", ok and "deleteTrip" in MOCK.calls, len(MOCK.trips))
    ctx_b.close()

    # 연동 끄기 → 로컬 모드 복귀
    open_cloud_modal(page)
    page.fill("#cloudUrl", "")
    page.click("#cloudSaveBtn")
    wait_until(page, lambda: "비웠" in page.inner_text("#cloudStatus"), 10, label="주소 비우기")
    page.click("#cloudClose")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#map .region")
    page.wait_for_timeout(800)
    check("주소를 비우면 연동 꺼짐", page.evaluate("() => localStorage.getItem('kpm.cloud.url')") in (None, ""))
    check("연동 꺼도 기기 기록은 그대로", page.inner_text("#visitedCount") == "1", page.inner_text("#visitedCount"))
    ctx.close()


# ── 모바일: 하단 시트 제스처·뒤로가기 ─────────────────────
def mobile_flow(browser, img1, img2):
    ctx, page = new_page(browser, viewport=(390, 844), touch=True, cloud_url=None)
    page.goto("http://127.0.0.1:%d%s" % (PORT, PREFIX), wait_until="networkidle")
    page.wait_for_selector("#map .region")
    page.wait_for_timeout(500)

    # 시트 열기
    page.tap('path.region[aria-label^="강릉시"]')
    page.wait_for_selector("#panel.open")
    page.wait_for_timeout(600)
    check("모바일: 지역을 누르면 하단 시트 열림", page.is_visible("#panel"))
    page.screenshot(path=os.path.join(SHOTS, "24-mobile-sheet.png"))

    # ✕ 버튼 터치 영역
    box = page.eval_on_selector("#panelClose", "e => { const r = e.getBoundingClientRect(); return {w: r.width, h: r.height}; }")
    check("모바일: ✕ 버튼이 44px 이상", box["w"] >= 44 and box["h"] >= 44, box)

    # 손잡이를 아래로 스와이프
    swiped = page.evaluate("""() => {
      const el = document.querySelector('.sheet-handle');
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const mk = (type, y) => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
        const ev = new TouchEvent(type, {
          bubbles: true, cancelable: true,
          touches: type === 'touchend' ? [] : [t],
          targetTouches: type === 'touchend' ? [] : [t],
          changedTouches: [t],
        });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      mk('touchstart', y0);
      for (let d = 10; d <= 160; d += 20) mk('touchmove', y0 + d);
      mk('touchend', y0 + 160);
      return true;
    }""")
    page.wait_for_timeout(600)
    check("모바일: 손잡이를 아래로 끌면 시트가 닫힘", page.get_attribute("#panel", "aria-hidden") == "true",
          page.get_attribute("#panel", "aria-hidden"))

    # ✕ 버튼으로 닫기
    page.tap('path.region[aria-label^="강릉시"]')
    page.wait_for_selector("#panel.open")
    page.wait_for_timeout(500)
    page.tap("#panelClose")
    page.wait_for_timeout(500)
    check("모바일: ✕ 버튼으로 시트 닫힘", page.get_attribute("#panel", "aria-hidden") == "true")

    # 지도(백드롭) 탭으로 닫기
    page.tap('path.region[aria-label^="강릉시"]')
    page.wait_for_selector("#panel.open")
    page.wait_for_timeout(500)
    page.wait_for_timeout(400)
    page.touchscreen.tap(4, 4)
    page.wait_for_timeout(700)
    check("모바일: 시트 바깥(지도)을 탭하면 시트 닫힘", page.get_attribute("#panel", "aria-hidden") == "true",
          page.get_attribute("#panel", "aria-hidden"))

    # 뒤로가기 → 시트 먼저 닫히고 앱은 유지
    page.tap('path.region[aria-label^="강릉시"]')
    page.wait_for_selector("#panel.open")
    page.wait_for_timeout(400)
    before_url = page.url
    page.go_back()
    page.wait_for_timeout(700)
    check("모바일: 뒤로가기로 시트 닫힘", page.get_attribute("#panel", "aria-hidden") == "true",
          page.get_attribute("#panel", "aria-hidden"))
    check("모바일: 뒤로가기 후에도 앱 화면 유지", page.url.split("#")[0].rstrip("/") == before_url.split("#")[0].rstrip("/"),
          page.url)

    # 뒤로가기 → 여행 기록 모달 먼저 닫힘
    page.tap('path.region[aria-label^="강릉시"]')
    page.wait_for_selector("#panel.open")
    page.wait_for_timeout(400)
    page.tap("#btnAddTrip")
    page.wait_for_selector("#tripOverlay:not([hidden])")
    page.go_back()
    page.wait_for_timeout(700)
    check("모바일: 뒤로가기로 여행 기록 창 닫힘", page.get_attribute("#tripOverlay", "hidden") is not None,
          page.get_attribute("#tripOverlay", "hidden"))
    check("모바일: 창을 닫아도 시트는 남아 있음", page.get_attribute("#panel", "aria-hidden") == "false",
          page.get_attribute("#panel", "aria-hidden"))
    page.screenshot(path=os.path.join(SHOTS, "25-mobile-back.png"))

    # 모바일에서도 지도 대표 / 일기 대표를 따로 지정할 수 있는지
    page.tap("#btnAddTrip")
    page.wait_for_selector("#tripOverlay:not([hidden])")
    page.fill("#tripDate", "2026-07-11")
    page.fill("#tripTitle", "강릉 여름")
    page.set_input_files("#photoInput", [img1, img2])
    page.wait_for_selector(".preview-item")
    page.tap("#tripSave")
    page.wait_for_selector("#tripOverlay[hidden]", state="attached", timeout=20000)
    page.wait_for_timeout(800)

    page.tap(".trip .strip button:nth-child(1)")
    page.wait_for_selector("#lightbox:not([hidden])")
    page.wait_for_timeout(700)
    sizes = page.evaluate("""() => ['lbMapCover','lbCover'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { id, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
    })""")
    check("모바일: 라이트박스에 지도/일기 대표 버튼", all(s["visible"] and s["h"] >= 32 for s in sizes), sizes)

    page.tap("#lbNext")
    page.wait_for_timeout(500)
    page.tap("#lbMapCover")
    wait_until(page, lambda: "지도 대표" in page.inner_text("#lbMapCover") and "✓" in page.inner_text("#lbMapCover"), 10, label="모바일 지도 대표")
    page.wait_for_timeout(600)
    check("모바일: 지도 대표 지정", "✓ 지도 대표" in page.inner_text("#lbMapCover"), page.inner_text("#lbMapCover"))
    check("모바일: 지도 대표를 바꿔도 일기 대표는 그대로",
          "일기 대표" in page.inner_text("#lbCover") and "✓" not in page.inner_text("#lbCover"), page.inner_text("#lbCover"))

    page.tap("#lbCover")
    page.wait_for_timeout(900)
    check("모바일: 일기 대표 지정", "✓ 일기 대표" in page.inner_text("#lbCover"), page.inner_text("#lbCover"))
    page.screenshot(path=os.path.join(SHOTS, "27-mobile-lightbox-covers.png"))
    ctx.close()


def main():
    os.makedirs(SHOTS, exist_ok=True)
    img_dir = os.path.join(ROOT, ".tmp")
    os.makedirs(img_dir, exist_ok=True)
    img1 = make_image(os.path.join(img_dir, "cloud-test-1.jpg"), (238, 140, 92))
    img2 = make_image(os.path.join(img_dir, "cloud-test-2.jpg"), (92, 150, 200))

    start_server()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        try:
            desktop_flow(browser, img1, img2)
            mobile_flow(browser, img1, img2)
        finally:
            browser.close()

    check("JS 콘솔 오류 0건", len(console_errors) == 0, console_errors[:5])

    failed = [r for r in results if not r[1]]
    print("\n%d/%d 통과" % (len(results) - len(failed), len(results)))
    if failed:
        for name, _, detail in failed:
            print("  실패: %s · %s" % (name, detail))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
