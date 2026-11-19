# Apps Script 백엔드 (선택 · 구글 드라이브 연동)

여행 기록을 스프레드시트에, 사진을 드라이브 폴더에 보관하고 싶을 때만 쓰는 부품입니다.
**넣지 않아도 앱은 지금처럼 이 기기(IndexedDB)에만 저장하며 그대로 동작합니다.**

## 준비물

- 구글 드라이브에 비공개 폴더 `[비공개] 여행 사진 지도` (그 안에 `사진` 폴더)
- 그 안의 스프레드시트 `[비공개] 여행 사진 지도 데이터`
  - `여행기록` : `id | regionCode | regionName | date | title | memo | coverPhotoId | createdAt`
  - `사진` : `photoId | tripId | regionCode | driveFileId | fileName | mimeType | isCover | order | createdAt`
  - `지역` : `regionCode | regionName | coverPhotoId | updatedAt` — 지역의 **지도 대표 사진**
  - `설정` : `key | value` (자동 기록용)
- 스프레드시트 ID, `사진` 폴더 ID

> 이 저장소의 `Code.gs`에는 ID 자리표시자(`YOUR_SPREADSHEET_ID`, `YOUR_PHOTO_FOLDER_ID`)만 있습니다.
> 실제 ID가 채워진 파일은 공개 저장소 밖에만 두고, 절대 커밋하지 마세요.

## 설치

1. <https://script.google.com/> → **새 프로젝트**
2. `Code.gs` 내용을 통째로 붙여넣고, 맨 위 두 줄을 실제 ID로 바꿉니다.
3. **배포 → 새 배포 → 유형: 웹 앱**
   - 설명: `여행 사진 지도`
   - 다음 사용자로 실행: **나**
   - 액세스 권한: **모든 사용자**
4. 나온 웹 앱 주소(`…/exec`)를 앱의 `⋯` → **☁️ 구글 드라이브 연동**에 붙여넣고 **연결 테스트** → **이 기기 기록·사진 모두 올리기**.

## API (앱이 부르는 것)

| action | 설명 |
| --- | --- |
| `ping` | 연결 확인(시트 이름, 기록·사진·지역 수, 사진 폴더 접근 여부) |
| `list` | `여행기록` + `사진` + `지역` 메타데이터 전체 |
| `photo` `id=driveFileId` `pid=photoId` `size=thumb` | 사진을 base64 data URL 로 반환(파일을 공개하지 않음) |
| `saveTrip` | 여행 기록 추가/수정 (id 기준 upsert) |
| `uploadPhoto` | base64 이미지 → `사진` 폴더 저장 + `사진` 시트 행 추가 |
| `setTripCover` | **일기(여행 기록)** 의 대표 사진 |
| `setRegionCover` | **지도** 에 칠할 지역 대표 사진 |
| `deletePhoto` / `deleteTrip` | 시트 행 삭제 + 드라이브 파일 휴지통 이동 |

## 동작 규칙

- 사진 파일은 `<photoId>.jpg`, 썸네일은 `<photoId>_thumb.jpg` 이름으로 저장합니다.
  사람이 읽을 원래 이름은 `사진` 시트의 `fileName` 열에 남습니다.
- 지역의 **지도 대표 사진**은 그 지역의 첫 사진일 때만 자동으로 정해지고,
  이후 새 여행을 남겨도 덮어쓰지 않습니다(사용자가 `🗺️ 지도 대표`로 직접 바꿀 수 있음).
- 사진·기록을 지워 지도 대표 사진이 사라지면 같은 지역의 남은 사진으로 다시 잡습니다.

## 보안

- 스크립트는 비공개 시트와 폴더에만 접근하고, 파일 공유 설정을 바꾸지 않습니다.
- 사진은 웹앱 주소를 아는 사람만 열 수 있는 통로로 내려갑니다. **웹앱 주소는 비밀번호처럼** 다루세요.
  (앱은 주소를 기기 브라우저에만 저장하고, 공개 저장소·SNS에는 절대 올리지 않습니다.)
