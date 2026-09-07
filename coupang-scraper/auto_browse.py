#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
"검색 -> 상품 하나씩 클릭 -> 판매자 정보 확인 -> 기록" 이라는 사람의 반복작업을
실제 브라우저(Chromium)를 띄워 그대로 자동화하는 스크립트.

⚠️ 반드시 "로컬 PC"에서 실행하세요
--------------------------------------------------------------------------
클라우드 실행 환경(샌드박스)에서는 coupang.com 접속 자체가 네트워크 정책으로
차단되어 있어 동작하지 않습니다. 사람이 쓰는 것과 같은 인터넷 회선/브라우저로
접속해야 하므로 본인 PC에서 실행해야 합니다.

사전 준비
--------------------------------------------------------------------------
    pip install -r requirements.txt
    pip install playwright
    playwright install chromium

동작 방식
--------------------------------------------------------------------------
1. 실제 브라우저 창을 띄워(기본값: 화면에 보이는 창) 쿠팡 검색 결과 페이지로 이동
2. 상위 N개 상품 링크를 순서대로 모음
3. 링크를 하나씩 방문 -> "배송/교환/반품 안내" 탭을 자동 클릭 -> 판매자 정보 추출
4. 사람이 페이지를 읽는 정도의 대기시간(기본 3~6초)을 두고 다음 상품으로 이동
5. 매 건마다 CSV/JSON에 즉시 저장 (중간에 창을 닫거나 오류가 나도 그때까지 결과는
   남습니다)
6. 같은 키워드로 다시 실행하면, 이미 처리한 상품은 건너뛰고 이어서 진행합니다
   ("계속 반복" 요청에 대응 — 매번 처음부터 다시 돌 필요가 없습니다)
7. --sheet-id를 주면 끝난 뒤(또는 --sheet-every 건마다) 구글 스프레드시트에도 업로드

이 스크립트가 하지 않는 것
--------------------------------------------------------------------------
- 캡차 자동 풀이, 로그인 우회, 탐지 회피용 위장 등은 넣지 않았습니다. 보안 확인
  페이지/캡차가 뜨면 자동으로 멈추고, 그때까지 모은 결과만 저장합니다.
- 페이지 수는 최대 100개로 강제 제한됩니다.
"""

import argparse
import csv
import json
import random
import sys
import time
from pathlib import Path

from scraper import build_search_url, parse_products, BASE_URL, BLOCK_SIGNS
from seller_info_scraper import parse_seller_info, MAX_LIMIT

FIELDNAMES = [
    "rank", "product_name", "product_link", "company_owner", "address",
    "email", "phone", "mail_order_license_no", "business_reg_no",
]

SELLER_TAB_TEXT = "배송/교환/반품"  # 판매자 정보가 들어있는 탭 이름 (부분 일치로 클릭 시도)


def human_delay(a: float, b: float) -> None:
    time.sleep(random.uniform(a, b))


def looks_blocked_text(html: str) -> bool:
    lowered = html.lower()
    return any(sign in lowered for sign in BLOCK_SIGNS)


def load_existing_rows(csv_path: Path) -> list[dict]:
    if not csv_path.exists():
        return []
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def save_rows(rows: list[dict], csv_path: Path, json_path: Path) -> None:
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k, "") for k in FIELDNAMES})
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def collect_links(page, keyword: str, limit: int, min_delay: float, max_delay: float) -> list[tuple]:
    links = []
    listing_page = 1
    while len(links) < limit and listing_page <= 10:
        url = build_search_url(keyword, listing_page)
        print(f"[검색] {listing_page}페이지: {url}")
        page.goto(url, timeout=20000, wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        html = page.content()
        if looks_blocked_text(html):
            print("[중단] 검색 단계에서 차단이 감지되었습니다.")
            break
        products = parse_products(html, keyword, listing_page)
        if not products:
            break
        for prod in products:
            if prod.link and prod.link not in [l for _, l in links]:
                links.append((prod.name, prod.link))
            if len(links) >= limit:
                break
        listing_page += 1
        if len(links) < limit:
            human_delay(min_delay, max_delay)
    return links[:limit]


def click_seller_tab_if_present(page) -> None:
    try:
        tab = page.get_by_text(SELLER_TAB_TEXT, exact=False).first
        if tab.count() > 0:
            tab.click(timeout=3000)
            page.wait_for_timeout(800)
    except Exception:
        pass  # 탭이 없거나 이미 열려 있으면 그냥 진행


def run(keyword: str, limit: int, headless: bool, min_delay: float, max_delay: float,
        output_dir: str, sheet_id: str | None, worksheet: str, creds: str) -> None:
    from playwright.sync_api import sync_playwright

    limit = max(1, min(limit, MAX_LIMIT))
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / f"{keyword}_판매자정보.csv"
    json_path = out_dir / f"{keyword}_판매자정보.json"

    existing_rows = load_existing_rows(csv_path)
    visited_links = {r["product_link"] for r in existing_rows}
    if existing_rows:
        print(f"[이어하기] 기존에 처리된 {len(existing_rows)}건은 건너뛰고 이어서 진행합니다.")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, slow_mo=0 if headless else 50)
        context = browser.new_context(locale="ko-KR", viewport={"width": 1440, "height": 900})
        page = context.new_page()

        links = collect_links(page, keyword, limit, min_delay, max_delay)
        if not links:
            print("[안내] 검색 결과에서 상품 링크를 찾지 못했습니다.")
            browser.close()
            return

        todo = [(name, link) for name, link in links if link not in visited_links]
        print(f"[안내] 총 {len(links)}개 중 이번에 새로 방문할 상품: {len(todo)}개")

        rows = existing_rows
        for i, (name, link) in enumerate(todo, start=1):
            rank = len(rows) + 1
            print(f"[진행] {i}/{len(todo)} (누적순위 {rank}): {name or link}")
            try:
                page.goto(link, timeout=20000, wait_until="domcontentloaded")
                page.wait_for_timeout(1200)
                click_seller_tab_if_present(page)
                html = page.content()
            except Exception as exc:
                print(f"  [건너뜀] 페이지 로드 실패: {exc}")
                continue

            if looks_blocked_text(html):
                print("[중단] 상세페이지에서 차단이 감지되어 지금까지 결과만 저장하고 종료합니다.")
                break

            info = parse_seller_info(html)
            if not any(info.values()):
                print("  [경고] 판매자 정보를 찾지 못했습니다 (페이지 구조가 다를 수 있음).")

            rows.append({
                "rank": rank,
                "product_name": name or "",
                "product_link": link,
                "company_owner": info["company_owner"] or "",
                "address": info["address"] or "",
                "email": info["email"] or "",
                "phone": info["phone"] or "",
                "mail_order_license_no": info["mail_order_license_no"] or "",
                "business_reg_no": info["business_reg_no"] or "",
            })

            save_rows(rows, csv_path, json_path)  # 매 건마다 즉시 저장

            if i < len(todo):
                human_delay(min_delay, max_delay)

        browser.close()

    print(f"\n총 {len(rows)}건 저장됨 (이번 실행에서 {len(rows) - len(existing_rows)}건 추가)")
    print(f"  - CSV : {csv_path}")
    print(f"  - JSON: {json_path}")

    if sheet_id and rows:
        from sheets_uploader import upload_rows
        print(f"\n[진행] 구글 스프레드시트 업로드 중...")
        try:
            upload_rows(sheet_id, worksheet, creds, rows)
            print("[완료] 업로드 성공")
        except Exception as exc:  # noqa: BLE001
            print(f"[오류] 업로드 실패: {exc}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="브라우저로 직접 검색+클릭하는 것을 자동화 (로컬 PC 전용)")
    parser.add_argument("keyword", nargs="?", default="컴퓨터책상")
    parser.add_argument("--limit", type=int, default=10, help=f"수집할 상품 개수 (최대 {MAX_LIMIT}, 기본 10)")
    parser.add_argument("--headless", action="store_true", help="브라우저 창을 띄우지 않고 백그라운드로 실행")
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=6.0)
    parser.add_argument("--output", default="output")
    parser.add_argument("--sheet-id", help="구글 스프레드시트 ID (선택)")
    parser.add_argument("--worksheet", default="시트1")
    parser.add_argument("--creds", default="service_account.json")
    args = parser.parse_args()

    if args.limit > MAX_LIMIT:
        print(f"[안내] --limit은 최대 {MAX_LIMIT}으로 제한됩니다.")

    run(
        keyword=args.keyword,
        limit=args.limit,
        headless=args.headless,
        min_delay=args.min_delay,
        max_delay=args.max_delay,
        output_dir=args.output,
        sheet_id=args.sheet_id,
        worksheet=args.worksheet,
        creds=args.creds,
    )


if __name__ == "__main__":
    main()
