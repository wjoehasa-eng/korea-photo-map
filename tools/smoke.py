#!/usr/bin/env python3
"""로컬 서버로 앱을 띄워 빠르게 확인하는 스모크 테스트 (개발용)."""
import http.server
import os
import socketserver
import threading
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765


def serve():
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=ROOT, **kw)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1280, "height": 860}, device_scale_factor=1)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
        page.wait_for_selector("#map .region")
        n = page.eval_on_selector_all("#map .region", "els => els.length")
        print("regions:", n)
        print("labels visible:", page.eval_on_selector_all(".region-label:not(.hidden)", "els => els.length"))
        print("progress:", page.inner_text("#progressBadge").replace("\n", " "))
        page.screenshot(path=os.path.join(ROOT, "..", "korea-photo-map-shots", "smoke-desktop.png"))
        print("errors:", errors)
        b.close()
    httpd.shutdown()


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "..", "korea-photo-map-shots"), exist_ok=True)
    main()
