/**
 * 쿠팡 판매자정보 캡처 — 구글 스프레드시트 연동용 Apps Script.
 *
 * 설치 방법은 이 폴더의 README.md를 참고하세요. 요약하면:
 * 1. 대상 스프레드시트에서 확장 프로그램 > Apps Script 열기
 * 2. 기존 코드를 모두 지우고 이 파일 내용을 붙여넣기
 * 3. 배포 > 새 배포 > 웹 앱으로 배포 (실행: 나 / 액세스: 전체)
 * 4. 배포 후 나오는 웹 앱 URL을 크롬 확장프로그램 팝업의
 *    "구글 시트 연동" 칸에 붙여넣기
 *
 * 중복 방지는 확장프로그램 쪽(로컬)에서도 하지만, "지금 동기화"를
 * 다시 누르거나 로컬 데이터를 지운 뒤 같은 상품을 또 캡처하거나,
 * 같은 시트를 여러 브라우저에서 같이 쓰는 경우엔 확장프로그램만으로는
 * 막을 수 없다. 그래서 마지막 방어선으로 이 시트에서도 한 번 더
 * "상품키(중복확인용)" 열을 기준으로 걸러낸다.
 */

// 스프레드시트 안의 "확장 프로그램 > Apps Script"로 만든 스크립트라면
// 비워두세요 — 이 스크립트가 들어있는 시트를 자동으로 씁니다.
// script.google.com에서 독립 프로젝트로 만든 경우에만, 시트 URL의
// https://docs.google.com/spreadsheets/d/이 부분/edit 을 여기에 붙여넣으세요.
var SPREADSHEET_ID = "";

var SHEET_NAME = "판매자정보";

var HEADERS = [
  "캡처일시",
  "검색키워드",
  "상호/대표자",
  "사업장 소재지",
  "e-mail",
  "연락처",
  "통신판매업 신고번호",
  "사업자번호",
  "구매안전서비스",
  "상품명(탭 제목)",
  "상품 URL",
  "상품키(중복확인용)",
];

var FIELD_ORDER = [
  "capturedAt",
  "keyword",
  "sellerName",
  "address",
  "email",
  "phone",
  "mailOrderNo",
  "bizRegNo",
  "safetyService",
  "productTitle",
  "pageUrl",
];

var KEY_COLUMN_INDEX = HEADERS.length; // 1-based, last column

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "empty_request" });
    }

    var body = JSON.parse(e.postData.contents);
    var records = Array.isArray(body.records)
      ? body.records
      : body.record
      ? [body.record]
      : [];

    if (records.length === 0) {
      return jsonResponse({ ok: false, error: "no_records" });
    }

    var sheet = getOrCreateSheet();
    ensureHeader(sheet);

    var existingKeys = readExistingKeys(sheet);
    var rows = [];
    var duplicates = 0;

    records.forEach(function (record) {
      var key = itemKeyOf(record);
      if (key && existingKeys[key]) {
        duplicates++;
        return;
      }
      if (key) existingKeys[key] = true; // also catches dupes within this same batch

      var row = FIELD_ORDER.map(function (field) {
        return record && record[field] != null ? record[field] : "";
      });
      row.push(key);
      rows.push(row);
    });

    if (rows.length > 0) {
      sheet
        .getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length)
        .setValues(rows);
    }

    return jsonResponse({ ok: true, added: rows.length, duplicates: duplicates });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return jsonResponse({
    ok: true,
    message: "쿠팡 판매자정보 캡처 Apps Script가 정상 동작 중입니다.",
  });
}

// The extension already computes and sends record.itemKey (see
// extractCapturedItemKey in shared.js). This is only a fallback for
// records captured before that field existed.
function itemKeyOf(record) {
  if (record && record.itemKey) return String(record.itemKey);
  var url = record && record.pageUrl;
  if (!url) return "";

  var vendorMatch = url.match(/[?&]vendorItemId=([^&]+)/);
  if (vendorMatch) return "v:" + vendorMatch[1];
  var itemMatch = url.match(/[?&]itemId=([^&]+)/);
  if (itemMatch) return "i:" + itemMatch[1];
  var productMatch = url.match(/\/vp\/products\/(\d+)/);
  if (productMatch) return "p:" + productMatch[1];
  return url;
}

function readExistingKeys(sheet) {
  var lastRow = sheet.getLastRow();
  var keys = {};
  if (lastRow < 2) return keys;

  var values = sheet.getRange(2, KEY_COLUMN_INDEX, lastRow - 1, 1).getValues();
  values.forEach(function (row) {
    var key = row[0];
    if (key) keys[String(key)] = true;
  });
  return keys;
}

function getOrCreateSheet() {
  var ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

// Writes the header row on a brand-new sheet. On a sheet from an
// older version of this script (fewer columns — e.g. before the
// "상품키" dedup column existed), it only fills in the missing
// trailing header cells rather than touching existing data, so
// re-pasting an updated Code.gs into an already-populated sheet
// upgrades it in place.
function ensureHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }
  var lastCol = sheet.getLastColumn();
  if (lastCol < HEADERS.length) {
    sheet
      .getRange(1, lastCol + 1, 1, HEADERS.length - lastCol)
      .setValues([HEADERS.slice(lastCol)]);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
