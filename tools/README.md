# 개발용 스크립트

- `build_map_data.py` — 통계청(KOSTAT) 2018 시·군·구 TopoJSON을 앱용 SVG path JSON으로 변환합니다.
  ```bash
  curl -sSL -o topo2018.json https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-topo.json
  python3 tools/build_map_data.py    # data/regions.json 생성
  ```
- `verify.py` — Playwright로 로컬 서버를 띄워 데스크톱(1280)·모바일(390) 흐름을 검증합니다.
  ```bash
  pip install playwright pillow && playwright install chromium
  KPM_SHOTS=./shots python3 tools/verify.py
  ```
