/**
 * 여행 사진 지도 — 구글 드라이브/시트 백엔드 (Google Apps Script)
 * ───────────────────────────────────────────────────────────────
 * 여행 기록은 스프레드시트에, 사진 파일은 드라이브 폴더에 보관하고
 * 앱(https://wjoehasa-eng.github.io/korea-photo-map/)이 웹앱 주소로 불러갑니다.
 *
 * 시트 구성
 * - 여행기록: 여행 한 건 = 한 줄 (id, regionCode, ..., coverPhotoId = 그 일기의 대표 사진)
 * - 사진: 사진 한 장 = 한 줄 (driveFileId, isCover, order …)
 * - 지역: 지역마다 지도에 칠할 대표 사진 한 장 (regionCode, coverPhotoId = 지도 대표 사진)
 * - 설정: 메타 정보
 *
 * [설치 순서]
 * 1. 드라이브에 만든 '[비공개] 여행 사진 지도 데이터' 스프레드시트와
 *    '사진' 폴더의 ID를 아래 SPREADSHEET_ID / PHOTO_FOLDER_ID 에 넣습니다.
 *    (주소에 있는 /d/<ID>/ , /folders/<ID> 부분이 ID 입니다)
 * 2. 오른쪽 위 [배포] → [새 배포] → 유형 '웹 앱'
 *    - 설명: 여행 사진 지도
 *    - 다음 사용자로 실행: 나
 *    - 액세스 권한: 모든 사용자
 * 3. 배포 후 나오는 웹 앱 URL(…/exec)을 앱의 ⋯ → ☁️ 구글 드라이브 연동에 붙여넣습니다.
 *
 * [보안]
 * - 이 스크립트는 비공개 시트와 폴더에만 접근하고, 파일을 외부에 공개하지 않습니다.
 * - 앱은 사진을 '주소를 아는 사람'만 열 수 있는 웹앱을 통해 받아 갑니다.
 *   따라서 웹앱 주소는 비밀번호처럼 다루고, 공개 저장소·SNS에 올리지 마세요.
 * - 파일 이름은 사진마다 고유한 photoId 로 저장됩니다(사진 원본 파일명은 시트의 fileName 열에 남습니다).
 */

/* ── 설정 ───────────────────────────────────────────────── */

var SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID';
var PHOTO_FOLDER_ID = 'YOUR_PHOTO_FOLDER_ID';

/* ── 시트 정의 ──────────────────────────────────────────── */

var SH_TRIPS = '여행기록';
var SH_PHOTOS = '사진';
var SH_REGIONS = '지역';
var SH_META = '설정';

var H_TRIPS = ['id', 'regionCode', 'regionName', 'date', 'title', 'memo', 'coverPhotoId', 'createdAt'];
var H_PHOTOS = ['photoId', 'tripId', 'regionCode', 'driveFileId', 'fileName', 'mimeType', 'isCover', 'order', 'createdAt'];
var H_REGIONS = ['regionCode', 'regionName', 'coverPhotoId', 'updatedAt'];

var APP_VERSION = 2;
var TZ = 'Asia/Seoul';

/* ── 진입점 ─────────────────────────────────────────────── */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var req = {};
  for (var k in p) {
    if (Object.prototype.hasOwnProperty.call(p, k)) req[k] = p[k];
  }
  if (!req.action) req.action = 'ping';
  return handle_(req);
}

function doPost(e) {
  var req = {};
  try {
    var body = (e && e.postData && e.postData.contents) || '{}';
    req = JSON.parse(body);
    if (!req || typeof req !== 'object') req = {};
  } catch (err) {
    return json_({ ok: false, error: '요청 본문(JSON)을 읽지 못했습니다.' });
  }
  var p = (e && e.parameter) || {};
  if (!req.action && p.action) req.action = p.action;
  if (!req.id && p.id) req.id = p.id;
  return handle_(req);
}

function handle_(req) {
  var action = String((req && req.action) || 'ping');
  try {
    if (action === 'ping') return json_(ping_());
    if (action === 'list') return json_(list_());
    if (action === 'photo') return json_(photo_(req));

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (action === 'saveTrip') return json_(saveTrip_(req));
      if (action === 'uploadPhoto') return json_(uploadPhoto_(req));
      if (action === 'setCover' || action === 'setTripCover') return json_(setCover_(req));
      if (action === 'setRegionCover') return json_(setRegionCover_(req));
      if (action === 'deletePhoto') return json_(deletePhoto_(req));
      if (action === 'deleteTrip') return json_(deleteTrip_(req));
    } finally {
      lock.releaseLock();
    }
    throw new Error('알 수 없는 action 입니다: ' + action);
  } catch (err) {
    return json_({ ok: false, error: errText_(err) });
  }
}

/* ── 연결 확인 · 목록 ───────────────────────────────────── */

function ping_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var trips = readTable_(SH_TRIPS, H_TRIPS).rows.length;
  var photos = readTable_(SH_PHOTOS, H_PHOTOS).rows.length;
  var regions = readTable_(SH_REGIONS, H_REGIONS).rows.length;
  var folder = false;
  try {
    folder = !!DriveApp.getFolderById(PHOTO_FOLDER_ID);
  } catch (e) {
    folder = false;
  }
  return {
    ok: true,
    app: 'korea-photo-map',
    version: APP_VERSION,
    title: ss.getName(),
    trips: trips,
    photos: photos,
    regions: regions,
    photoFolder: folder,
    time: new Date().toISOString(),
  };
}

function list_() {
  var trips = readTable_(SH_TRIPS, H_TRIPS).rows.map(toTrip_);
  var photos = readTable_(SH_PHOTOS, H_PHOTOS).rows.map(toPhoto_);
  var regions = readTable_(SH_REGIONS, H_REGIONS).rows.map(toRegion_);
  return {
    ok: true,
    app: 'korea-photo-map',
    version: APP_VERSION,
    trips: trips,
    photos: photos,
    regions: regions,
    time: new Date().toISOString(),
  };
}

/* ── 사진 이미지 ────────────────────────────────────────── */

/**
 * action=photo & id=<driveFileId> & [pid=<photoId> & size=thumb]
 * 드라이브 파일을 공개하지 않고, base64 data URL 로 돌려줍니다.
 */
function photo_(req) {
  var id = String(req.id || req.driveFileId || '');
  var pid = String(req.pid || req.photoId || '');
  var wantThumb = String(req.size || '') === 'thumb';
  var blob = null;

  if (wantThumb && pid) {
    blob = blobByName_(pid + '_thumb.jpg');
  }
  if (!blob && id) {
    blob = blobById_(id);
  }
  if (!blob && pid) {
    blob = blobByName_(pid + '.jpg');
  }
  if (!blob) throw new Error('사진을 찾지 못했습니다.');

  var mime = blob.getMimeType() || 'image/jpeg';
  return {
    ok: true,
    mimeType: mime,
    dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes()),
  };
}

function blobById_(fileId) {
  try {
    return DriveApp.getFileById(fileId).getBlob();
  } catch (e) {
    return null;
  }
}

function blobByName_(name) {
  try {
    var it = DriveApp.getFolderById(PHOTO_FOLDER_ID).getFilesByName(name);
    if (it.hasNext()) return it.next().getBlob();
  } catch (e) {
    return null;
  }
  return null;
}

/* ── 여행 기록 저장 ─────────────────────────────────────── */

/** action=saveTrip — trip.id 가 있으면 그 행을 고치고, 없으면 새로 만듭니다. */
function saveTrip_(req) {
  ensureSheets_();
  var t = (req && req.trip) || req || {};
  var table = readTable_(SH_TRIPS, H_TRIPS);

  var id = String(t.id || '');
  if (!id) id = newId_('trip');

  var old = null;
  for (var i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i].id) === id) {
      old = table.rows[i];
      break;
    }
  }

  var row = [
    id,
    str_(t.regionCode, old && old.regionCode),
    str_(t.regionName, old && old.regionName),
    dateStr_(t.date !== undefined ? t.date : old && old.date),
    str_(t.title, old && old.title),
    str_(t.memo, old && old.memo),
    str_(t.coverPhotoId, old && old.coverPhotoId),
    str_(t.createdAt, (old && old.createdAt) || new Date().toISOString()),
  ];

  if (old) table.sheet.getRange(old._row, 1, 1, H_TRIPS.length).setValues([row]);
  else table.sheet.appendRow(row);

  touchMeta_();
  return { ok: true, trip: toTrip_({ _row: old ? old._row : 0, id: row[0], regionCode: row[1], regionName: row[2], date: row[3], title: row[4], memo: row[5], coverPhotoId: row[6], createdAt: row[7] }) };
}

/* ── 사진 업로드 ────────────────────────────────────────── */

/**
 * action=uploadPhoto
 * { tripId, photoId, regionCode, fileName, mimeType, isCover, order, data(데이터URL/base64), thumb(선택) }
 * 사진 폴더에 photoId.jpg 로 저장하고 '사진' 시트에 한 행을 더합니다.
 */
function uploadPhoto_(req) {
  ensureSheets_();
  var tripId = String(req.tripId || '');
  if (!tripId) throw new Error('tripId 가 없습니다.');

  var raw = String(req.data || '');
  if (!raw) throw new Error('사진 데이터(data)가 없습니다.');

  var photoId = String(req.photoId || '') || newId_('ph');
  var main = splitDataUrl_(raw, req.mimeType || 'image/jpeg');
  var ext = extFor_(main.mime);
  var folder = DriveApp.getFolderById(PHOTO_FOLDER_ID);

  var mainFile = putFile_(folder, photoId + '.' + ext, main.base64, main.mime);

  var hasThumb = false;
  var thumbRaw = String(req.thumb || '');
  if (thumbRaw) {
    var thumb = splitDataUrl_(thumbRaw, 'image/jpeg');
    putFile_(folder, photoId + '_thumb.jpg', thumb.base64, thumb.mime);
    hasThumb = true;
  }

  var regionCode = String(req.regionCode || '');
  if (!regionCode) {
    var trips = readTable_(SH_TRIPS, H_TRIPS).rows;
    for (var i = 0; i < trips.length; i++) {
      if (String(trips[i].id) === tripId) {
        regionCode = String(trips[i].regionCode || '');
        break;
      }
    }
  }

  var table = readTable_(SH_PHOTOS, H_PHOTOS);
  var old = null;
  for (var j = 0; j < table.rows.length; j++) {
    if (String(table.rows[j].photoId) === photoId) {
      old = table.rows[j];
      break;
    }
  }

  var row = [
    photoId,
    tripId,
    regionCode,
    mainFile.getId(),
    str_(req.fileName, (old && old.fileName) || (photoId + '.' + ext)),
    main.mime,
    req.isCover ? 'TRUE' : 'FALSE',
    Number(req.order || (old && old.order) || 0),
    new Date().toISOString(),
  ];

  if (old) table.sheet.getRange(old._row, 1, 1, H_PHOTOS.length).setValues([row]);
  else table.sheet.appendRow(row);

  if (req.isCover) setCoverFlags_(tripId, photoId);
  ensureRegionCover_(regionCode, photoId);
  touchMeta_();

  return {
    ok: true,
    photo: toPhoto_({ _row: old ? old._row : 0, photoId: row[0], tripId: row[1], regionCode: row[2], driveFileId: row[3], fileName: row[4], mimeType: row[5], isCover: row[6], order: row[7], createdAt: row[8] }),
    thumb: hasThumb,
  };
}

/* ── 대표 사진 · 삭제 ───────────────────────────────────── */

/** action=setCover { tripId, photoId } */
function setCover_(req) {
  var tripId = String(req.tripId || '');
  var photoId = String(req.photoId || '');
  if (!tripId) throw new Error('tripId 가 없습니다.');

  var trips = readTable_(SH_TRIPS, H_TRIPS);
  var found = false;
  for (var i = 0; i < trips.rows.length; i++) {
    if (String(trips.rows[i].id) === tripId) {
      trips.sheet.getRange(trips.rows[i]._row, 7, 1, 1).setValue(photoId); // coverPhotoId
      found = true;
      break;
    }
  }
  if (!found) throw new Error('여행 기록을 찾지 못했습니다.');

  setCoverFlags_(tripId, photoId);
  touchMeta_();
  return { ok: true, tripId: tripId, coverPhotoId: photoId };
}

function setCoverFlags_(tripId, coverPhotoId) {
  var photos = readTable_(SH_PHOTOS, H_PHOTOS);
  for (var i = 0; i < photos.rows.length; i++) {
    var r = photos.rows[i];
    if (String(r.tripId) !== tripId) continue;
    var isCover = String(r.photoId) === String(coverPhotoId);
    if (bool_(r.isCover) !== isCover) photos.sheet.getRange(r._row, 7, 1, 1).setValue(isCover ? 'TRUE' : 'FALSE');
  }
}

/**
 * action=setRegionCover { regionCode, photoId, regionName }
 * 지도에 칠할 대표 사진(지역 메타)을 정합니다. 일기(여행 기록)의 대표 사진과는 별개입니다.
 */
function setRegionCover_(req) {
  ensureSheets_();
  var code = String(req.regionCode || '');
  var photoId = String(req.photoId || '');
  if (!code) throw new Error('regionCode 가 없습니다.');

  var regions = readTable_(SH_REGIONS, H_REGIONS);
  var row = null;
  for (var i = 0; i < regions.rows.length; i++) {
    if (String(regions.rows[i].regionCode) === code) {
      row = regions.rows[i];
      break;
    }
  }

  var name = String(req.regionName || (row && row.regionName) || '');
  var now = new Date().toISOString();
  var values = [code, name, photoId, now];
  if (row) regions.sheet.getRange(row._row, 1, 1, H_REGIONS.length).setValues([values]);
  else regions.sheet.appendRow(values);

  touchMeta_();
  return { ok: true, region: { regionCode: code, regionName: name, coverPhotoId: photoId, updatedAt: now } };
}

/** 지역에 지도 대표 사진이 아직 없고 이 지역의 첫 사진이면 자동으로 정한다(덮어쓰지 않음). */
function ensureRegionCover_(regionCode, photoId) {
  if (!regionCode) return;
  try {
    ensureSheets_();
    var regions = readTable_(SH_REGIONS, H_REGIONS);
    var row = null;
    for (var i = 0; i < regions.rows.length; i++) {
      if (String(regions.rows[i].regionCode) === String(regionCode)) {
        row = regions.rows[i];
        break;
      }
    }
    if (row && String(row.coverPhotoId)) return;

    var others = readTable_(SH_PHOTOS, H_PHOTOS).rows.filter(function (x) {
      return String(x.regionCode) === String(regionCode) && String(x.photoId) !== String(photoId);
    });
    if (others.length) return;

    var name = String((row && row.regionName) || '');
    var now = new Date().toISOString();
    if (row) regions.sheet.getRange(row._row, 1, 1, H_REGIONS.length).setValues([[regionCode, name, photoId, now]]);
    else regions.sheet.appendRow([regionCode, name, photoId, now]);
  } catch (e) {
    // 지도 대표 사진은 없어도 업로드는 계속한다.
  }
}

/** 사진이 지워진 뒤 지역의 지도 대표 사진이 사라진 사진을 가리키면 다시 골라 준다. */
function refreshRegionCover_(regionCode) {
  if (!regionCode) return;
  var regions = readTable_(SH_REGIONS, H_REGIONS);
  var row = null;
  for (var i = 0; i < regions.rows.length; i++) {
    if (String(regions.rows[i].regionCode) === String(regionCode)) {
      row = regions.rows[i];
      break;
    }
  }
  if (!row) return;

  var photos = readTable_(SH_PHOTOS, H_PHOTOS).rows.filter(function (x) {
    return String(x.regionCode) === String(regionCode);
  });
  var cover = String(row.coverPhotoId || '');
  for (var j = 0; j < photos.length; j++) {
    if (String(photos[j].photoId) === cover) return;
  }
  var next = photos.length ? String(photos[0].photoId) : '';
  regions.sheet.getRange(row._row, 3, 1, 1).setValue(next);
}

/** action=deletePhoto { photoId } — 시트 행을 지우고 드라이브 사진은 휴지통으로 보냅니다. */
function deletePhoto_(req) {
  var photoId = String(req.photoId || req.id || '');
  if (!photoId) throw new Error('photoId 가 없습니다.');

  var table = readTable_(SH_PHOTOS, H_PHOTOS);
  var row = null;
  for (var i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i].photoId) === photoId) {
      row = table.rows[i];
      break;
    }
  }
  if (row) {
    trash_(row.driveFileId);
    trashByName_(photoId + '_thumb.jpg');
    table.sheet.deleteRow(row._row);
    refreshRegionCover_(String(row.regionCode || ''));
  }

  // 대표 사진이었다면 다음 사진으로 넘깁니다.
  if (row && String(row.tripId)) {
    var tripId = String(row.tripId);
    var left = readTable_(SH_PHOTOS, H_PHOTOS).rows.filter(function (x) {
      return String(x.tripId) === tripId;
    });
    var trips = readTable_(SH_TRIPS, H_TRIPS);
    for (var j = 0; j < trips.rows.length; j++) {
      var tr = trips.rows[j];
      if (String(tr.id) !== tripId) continue;
      if (String(tr.coverPhotoId) === photoId) {
        var next = left.length ? String(left[0].photoId) : '';
        trips.sheet.getRange(tr._row, 7, 1, 1).setValue(next);
        if (next) setCoverFlags_(tripId, next);
      }
      break;
    }
  }

  touchMeta_();
  return { ok: true, deleted: !!row };
}

/** action=deleteTrip { tripId } — 여행 한 건과 그 사진들을 함께 지웁니다. */
function deleteTrip_(req) {
  var tripId = String(req.tripId || req.id || '');
  if (!tripId) throw new Error('tripId 가 없습니다.');

  var photos = readTable_(SH_PHOTOS, H_PHOTOS);
  var mine = photos.rows.filter(function (r) {
    return String(r.tripId) === tripId;
  });
  mine.sort(function (a, b) {
    return b._row - a._row;
  });
  for (var i = 0; i < mine.length; i++) {
    trash_(mine[i].driveFileId);
    trashByName_(String(mine[i].photoId) + '_thumb.jpg');
    photos.sheet.deleteRow(mine[i]._row);
  }

  var trips = readTable_(SH_TRIPS, H_TRIPS);
  var deleted = false;
  for (var j = trips.rows.length - 1; j >= 0; j--) {
    if (String(trips.rows[j].id) === tripId) {
      trips.sheet.deleteRow(trips.rows[j]._row);
      deleted = true;
    }
  }

  var codes = {};
  for (var k = 0; k < mine.length; k++) codes[String(mine[k].regionCode || '')] = true;
  for (var code in codes) {
    if (code) refreshRegionCover_(code);
  }

  touchMeta_();
  return { ok: true, deleted: deleted, deletedPhotos: mine.length };
}

/* ── 시트 읽기/쓰기 도우미 ──────────────────────────────── */

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function sheet_(name, headers) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('스프레드시트에 "' + name + '" 탭이 없습니다.');
  return sh;
}

function readTable_(name, headers) {
  var sh = sheet_(name, headers);
  var last = sh.getLastRow();
  if (last < 1) return { sheet: sh, headers: headers, rows: [] };
  var width = Math.max(headers.length, 1);
  var values = sh.getRange(1, 1, last, width).getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    var empty = true;
    var o = { _row: i + 1 };
    for (var c = 0; c < headers.length; c++) {
      o[headers[c]] = v[c];
      if (v[c] !== '' && v[c] !== null && v[c] !== undefined) empty = false;
    }
    if (!empty) rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function ensureSheets_() {
  var ss = ss_();
  var defs = [
    { name: SH_TRIPS, headers: H_TRIPS },
    { name: SH_PHOTOS, headers: H_PHOTOS },
    { name: SH_REGIONS, headers: H_REGIONS },
    { name: SH_META, headers: ['key', 'value'] },
  ];
  for (var i = 0; i < defs.length; i++) {
    var sh = ss.getSheetByName(defs[i].name);
    if (!sh) sh = ss.insertSheet(defs[i].name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, defs[i].headers.length).setValues([defs[i].headers]);
    }
  }
}

function touchMeta_() {
  try {
    var sh = sheet_(SH_META, ['key', 'value']);
    var values = sh.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === 'lastWriteAt') {
        rowIdx = i + 1;
        break;
      }
    }
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    if (rowIdx > 0) sh.getRange(rowIdx, 2, 1, 1).setValue(stamp);
    else sh.appendRow(['lastWriteAt', stamp]);
  } catch (e) {
    // 설정 탭이 없더라도 저장 자체는 계속합니다.
  }
}

/* ── 파일 도우미 ────────────────────────────────────────── */

function putFile_(folder, name, base64, mime) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) {
    try {
      it.next().setTrashed(true);
    } catch (e) {}
  }
  return folder.createFile(Utilities.newBlob(Utilities.base64Decode(base64), mime, name));
}

function trash_(fileId) {
  if (!fileId) return;
  try {
    DriveApp.getFileById(String(fileId)).setTrashed(true);
  } catch (e) {}
}

function trashByName_(name) {
  try {
    var it = DriveApp.getFolderById(PHOTO_FOLDER_ID).getFilesByName(name);
    while (it.hasNext()) it.next().setTrashed(true);
  } catch (e) {}
}

/* ── 값 변환 ────────────────────────────────────────────── */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errText_(err) {
  return String((err && err.message) || err || '알 수 없는 오류');
}

function newId_(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function str_(v, fallback) {
  if (v === undefined || v === null) return fallback === undefined || fallback === null ? '' : String(fallback);
  return String(v);
}

function bool_(v) {
  if (v === true) return true;
  var s = String(v === undefined || v === null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'Y' || s === 'YES';
}

function dateStr_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

function isoStr_(v) {
  if (v === undefined || v === null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v);
}

function toTrip_(r) {
  return {
    id: str_(r.id),
    regionCode: str_(r.regionCode),
    regionName: str_(r.regionName),
    date: dateStr_(r.date),
    title: str_(r.title),
    memo: str_(r.memo),
    coverPhotoId: str_(r.coverPhotoId),
    createdAt: isoStr_(r.createdAt),
  };
}

function toPhoto_(r) {
  return {
    photoId: str_(r.photoId),
    tripId: str_(r.tripId),
    regionCode: str_(r.regionCode),
    driveFileId: str_(r.driveFileId),
    fileName: str_(r.fileName),
    mimeType: str_(r.mimeType) || 'image/jpeg',
    isCover: bool_(r.isCover),
    order: Number(r.order) || 0,
    createdAt: isoStr_(r.createdAt),
  };
}

function toRegion_(r) {
  return {
    regionCode: str_(r.regionCode),
    regionName: str_(r.regionName),
    coverPhotoId: str_(r.coverPhotoId),
    updatedAt: isoStr_(r.updatedAt),
  };
}

function splitDataUrl_(raw, fallbackMime) {
  var m = String(raw).match(/^data:([^;]+);base64,(.*)$/);
  if (m) return { mime: m[1] || fallbackMime, base64: m[2] };
  return { mime: fallbackMime || 'image/jpeg', base64: String(raw) };
}

function extFor_(mime) {
  var m = String(mime || '').toLowerCase();
  if (m.indexOf('png') >= 0) return 'png';
  if (m.indexOf('webp') >= 0) return 'webp';
  if (m.indexOf('gif') >= 0) return 'gif';
  return 'jpg';
}
