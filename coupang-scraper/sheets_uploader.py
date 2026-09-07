#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
구글 스프레드시트 업로드 헬퍼 (gspread + 서비스 계정 방식)

사전 준비 (최초 1회, README.md에 스크린샷 없는 텍스트 절차 있음)
--------------------------------------------------------------------------
1. https://console.cloud.google.com 에서 프로젝트 생성
2. "Google Sheets API"와 "Google Drive API" 활성화
3. IAM과 관리자 > 서비스 계정 > 서비스 계정 만들기
4. 만든 서비스 계정의 "키" 탭에서 JSON 키 생성 → 다운로드한 파일을
   coupang-scraper/service_account.json 으로 저장 (경로는 --creds로 변경 가능)
5. 업로드할 구글 스프레드시트를 열어 "공유"에서 서비스 계정 이메일
   (json 파일 안의 client_email 값, ...@...iam.gserviceaccount.com)을
   "편집자"로 추가
6. 스프레드시트 URL의 .../d/<이 부분>/edit 이 스프레드시트 ID입니다.

단독 사용 예:
    python3 sheets_uploader.py --csv "output/컴퓨터책상_판매자정보.csv" \
        --sheet-id "스프레드시트ID" --worksheet "시트1" --creds service_account.json
"""

import argparse
import csv as csv_module
import sys
from pathlib import Path


def _get_client(creds_path: str):
    import gspread
    from google.oauth2.service_account import Credentials

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = Credentials.from_service_account_file(creds_path, scopes=scopes)
    return gspread.authorize(creds)


def upload_rows(sheet_id: str, worksheet_name: str, creds_path: str, rows: list[dict]) -> None:
    """rows: dict의 리스트 (모두 같은 key 구조라고 가정). 헤더가 없으면 추가하고,
    있으면 그 아래에 이어서 append 한다."""
    if not rows:
        return

    client = _get_client(creds_path)
    spreadsheet = client.open_by_key(sheet_id)

    try:
        worksheet = spreadsheet.worksheet(worksheet_name)
    except Exception:  # noqa: BLE001 - gspread.WorksheetNotFound
        worksheet = spreadsheet.add_worksheet(title=worksheet_name, rows=1000, cols=max(10, len(rows[0])))

    header = list(rows[0].keys())
    existing = worksheet.get_all_values()
    if not existing:
        worksheet.append_row(header, value_input_option="RAW")

    values = [[str(row.get(col, "") or "") for col in header] for row in rows]
    worksheet.append_rows(values, value_input_option="RAW")


def upload_csv(csv_path: str, sheet_id: str, worksheet_name: str, creds_path: str) -> int:
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv_module.DictReader(f))
    upload_rows(sheet_id, worksheet_name, creds_path, rows)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="CSV 파일을 구글 스프레드시트에 업로드")
    parser.add_argument("--csv", required=True, help="업로드할 CSV 파일 경로")
    parser.add_argument("--sheet-id", required=True, help="구글 스프레드시트 ID")
    parser.add_argument("--worksheet", default="시트1", help="워크시트(탭) 이름")
    parser.add_argument("--creds", default="service_account.json", help="구글 서비스 계정 JSON 키 경로")
    args = parser.parse_args()

    if not Path(args.csv).exists():
        print(f"[오류] CSV 파일을 찾을 수 없습니다: {args.csv}", file=sys.stderr)
        sys.exit(1)
    if not Path(args.creds).exists():
        print(f"[오류] 서비스 계정 키 파일을 찾을 수 없습니다: {args.creds}", file=sys.stderr)
        print("README.md의 '구글 스프레드시트 연동' 절차를 먼저 진행해주세요.", file=sys.stderr)
        sys.exit(1)

    count = upload_csv(args.csv, args.sheet_id, args.worksheet, args.creds)
    print(f"[완료] {count}행 업로드 완료 (sheet-id={args.sheet_id}, worksheet={args.worksheet})")


if __name__ == "__main__":
    main()
