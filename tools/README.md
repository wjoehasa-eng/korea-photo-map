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
- `make_icons.py` — 앱 아이콘 PNG를 다시 그립니다(파스텔 지도 + 핀 + 사진 카드).
  ```bash
  python3 tools/make_icons.py    # icons/icon-192.png · icon-512.png · icon-maskable-512.png
  ```
- `verify_pwa.py` — PWA 설치 지원을 검증합니다(매니페스트·아이콘 응답, 서비스 워커 활성/제어,
  크롬 설치 가능성 CDP, 오프라인 재실행, 기존 기능, 콘솔 오류, 개인정보 0건).
  ```bash
  python3 tools/verify_pwa.py                                                   # 로컬(프리픽스 서버)
  KPM_BASE=https://wjoehasa-eng.github.io/korea-photo-map/ python3 tools/verify_pwa.py   # 배포 URL
  ```
- `verify_cloud.py` — 구글 드라이브 연동을 가짜 Apps Script 서버로 검증합니다
  (연결 테스트·업로드·다른 기기 내려받기·일기/지도 대표 사진 분리·삭제·모바일 시트 제스처·뒤로가기·콘솔 오류).
  ```bash
  python3 tools/verify_cloud.py
  ```
