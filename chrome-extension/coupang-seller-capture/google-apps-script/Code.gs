/**
 * 쿠팡 판매자정보 캡처 — 구글 스프레드시트 연동용 Apps Script.
 *
 * 설치 방법은 이 폴더의 README.md를 참고하세요. 요약하면:
 * 1. 대상 스프레드시트에서 확장 프로그램 > Apps Script 열기
 * 2. 기존 코드를 모두 지우고 이 파일 내용을 붙여넣기
 * 3. 배포 > 새 배포 > 웹 앱으로 배포 (실행: 나 / 액세스: 전체)
 * 4. 배포 후 나오는 웹 앱 URL을 크롬 확장프로그램 팝업의
 *    "구글 시트 연동" 칸에 붙여넣기
 */

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

    var rows = records.map(function (record) {
      return FIELD_ORDER.map(function (key) {
        return record && record[key] != null ? record[key] : "";
      });
    });

    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, FIELD_ORDER.length)
      .setValues(rows);

    return jsonResponse({ ok: true, added: rows.length });
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

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
