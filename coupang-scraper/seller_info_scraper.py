#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
쿠팡 검색 결과 1~N위 상품의 "판매자 정보"를 모아 CSV/JSON(+ 선택적으로 구글
스프레드시트)에 저장하는 스크립트.

동작 순서
--------------------------------------------------------------------------
1. 키워드로 검색 결과 페이지를 순회하며 상위 N개 상품의 상세페이지 링크를 모음
2. 상품 상세페이지를 하나씩 방문해 "판매자 정보" 표(상호/대표자, 사업장 소재지,
   e-mail, 연락처, 통신판매업 신고번호, 사업자번호)를 추출
3. 결과를 CSV/JSON으로 저장하고, --sheet-id가 주어지면 구글 스프레드시트에도 업로드

사용 전 반드시 읽어주세요
--------------------------------------------------------------------------
- scraper.py와 동일하게, 이 스크립트도 쿠팡 이용약관/robots.txt상 회색지대에
  있습니다. 여기서는 상품 상세페이지를 "여러 건" 순차 방문하므로 scraper.py
  단독 사용보다 요청 수가 훨씬 많습니다. 반드시 --limit 5~10 정도의 소규모로
  먼저 테스트한 뒤 늘려가세요. --limit은 기본적으로 최대 100으로 제한됩니다.
- 여기서 수집하는 판매자 정보(상호/대표자/주소/이메일/전화번호/사업자번호)는
  전자상거래법상 공개 고지 의무가 있는 정보이지만, 수집한 연락처로 사전 동의
  없이 광고성 메시지(예: 마케팅/영업 제안)를 보내는 것은 정보통신망법
  제50조(영리목적 광고성 정보 전송 제한) 등 별도 규제 대상이 될 수 있습니다.
  이는 스크래핑 자체의 적법성과는 별개 문제이므로, 실제 영업 연락 전에는
  법률 검토를 권장합니다.
- 판매자 정보 표가 JavaScript로 뒤늦게 렌더링되는 페이지라면 requests만으로는
  빈 값이 나올 수 있습니다. 이 경우 --engine playwright 옵션을 사용하세요
  (사전에 `pip install playwright` 및 `playwright install chromium` 필요).
"""

import argparse
import csv
import json
import random
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

from scraper import (
    DEFAULT_HEADERS,
    fetch_page,
    parse_products,
    looks_blocked,
)

MAX_LIMIT = 100


@dataclass
class SellerInfo:
    rank: int
    product_name: Optional[str]
    product_link: str
    company_owner: Optional[str]
    address: Optional[str]
    email: Optional[str]
    phone: Optional[str]
    mail_order_license_no: Optional[str]
    business_reg_no: Optional[str]


def collect_top_links(session: requests.Session, keyword: str, limit: int, timeout: float,
                       min_delay: float, max_delay: float, max_listing_pages: int = 10):
    """검색 결과를 페이지 단위로 순회하며 (상품명, 링크) 상위 limit개를 모은다."""
    results = []
    page = 1
    while len(results) < limit and page <= max_listing_pages:
        print(f"[검색] '{keyword}' 검색결과 {page}페이지 조회 중... (누적 {len(results)}/{limit}건)")
        html = fetch_page(session, keyword, page, timeout)
        if html is None:
            break
        products = parse_products(html, keyword, page)
        if not products:
            break
        for p in products:
            if p.link:
                results.append((p.name, p.link))
            if len(results) >= limit:
                break
        page += 1
        if len(results) < limit:
            time.sleep(random.uniform(min_delay, max_delay))
    return results[:limit]


def _label_value_pairs(soup: BeautifulSoup):
    """페이지 내 모든 <table>에서 (라벨, 값) 쌍을 뽑아 dict로 반환.
    쿠팡 상품상세 "배송/교환/반품 안내" 탭의 판매자 정보 표는
    <th>상호/대표자</th><td>...</td><th>사업장 소재지</th><td>...</td> 같은
    구조로 알려져 있어, class 이름 대신 눈에 보이는 라벨 텍스트로 값을 찾는다.
    """
    label_value = {}
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            cells = row.find_all(["th", "td"])
            texts = [c.get_text(" ", strip=True) for c in cells]
            it = iter(texts)
            for label in it:
                value = next(it, None)
                if label and value and label not in label_value:
                    label_value[label] = value
    return label_value


def parse_seller_info(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    label_value = _label_value_pairs(soup)

    def find(*keywords):
        for label, value in label_value.items():
            if all(kw in label for kw in keywords):
                return value
        return None

    return {
        "company_owner": find("상호") or find("상호명"),
        "address": find("사업장", "소재지") or find("소재지"),
        "email": find("e-mail") or find("email") or find("이메일"),
        "phone": find("연락처") or find("전화"),
        "mail_order_license_no": find("통신판매업"),
        "business_reg_no": find("사업자번호") or find("사업자등록번호"),
    }


def fetch_detail_requests(session: requests.Session, url: str, timeout: float) -> Optional[str]:
    try:
        resp = session.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
    except requests.RequestException as exc:
        print(f"[오류] 상세페이지 요청 실패: {exc}", file=sys.stderr)
        return None
    if looks_blocked(resp.status_code, resp.text):
        print(f"[중단] 상세페이지 접근이 차단된 것으로 보입니다 (status={resp.status_code}).", file=sys.stderr)
        return "__BLOCKED__"
    if resp.status_code != 200:
        print(f"[경고] 상세페이지 응답 코드 이상: {resp.status_code} ({url})", file=sys.stderr)
        return None
    return resp.text


class PlaywrightFetcher:
    """옵션: 판매자 정보가 JS로 늦게 렌더링될 때 사용하는 브라우저 렌더링 방식.
    브라우저 인스턴스를 한 번만 띄우고 재사용한다."""

    def __init__(self):
        from playwright.sync_api import sync_playwright  # 지연 임포트: 미설치 시 requests 모드만 써도 되게

        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch(headless=True)
        self.context = self.browser.new_context(
            user_agent=DEFAULT_HEADERS["User-Agent"], locale="ko-KR"
        )

    def fetch(self, url: str, timeout: float) -> Optional[str]:
        page = self.context.new_page()
        try:
            page.goto(url, timeout=timeout * 1000)
            page.wait_for_timeout(1500)  # 지연 렌더링 대기
            return page.content()
        except Exception as exc:  # noqa: BLE001
            print(f"[오류] playwright 요청 실패: {exc}", file=sys.stderr)
            return None
        finally:
            page.close()

    def close(self):
        self.browser.close()
        self._pw.stop()


def save_csv(rows: list[SellerInfo], path: Path) -> None:
    fieldnames = list(asdict(rows[0]).keys()) if rows else [
        "rank", "product_name", "product_link", "company_owner", "address",
        "email", "phone", "mail_order_license_no", "business_reg_no",
    ]
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(asdict(r))


def save_json(rows: list[SellerInfo], path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump([asdict(r) for r in rows], f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="쿠팡 검색 상위 N개 상품의 판매자 정보 수집 (개인 학습용)")
    parser.add_argument("keyword", nargs="?", default="컴퓨터책상", help="검색 키워드")
    parser.add_argument("--limit", type=int, default=10, help=f"수집할 상품 개수 (최대 {MAX_LIMIT}, 기본 10 — 처음엔 작게 시작하세요)")
    parser.add_argument("--engine", choices=["requests", "playwright"], default="requests",
                         help="requests: 빠르지만 JS 렌더링 필요한 페이지는 값이 빌 수 있음 / playwright: 느리지만 실제 브라우저로 렌더링")
    parser.add_argument("--min-delay", type=float, default=3.0, help="상세페이지 간 최소 대기 시간(초)")
    parser.add_argument("--max-delay", type=float, default=6.0, help="상세페이지 간 최대 대기 시간(초)")
    parser.add_argument("--timeout", type=float, default=15.0, help="요청 타임아웃(초)")
    parser.add_argument("--output", default="output", help="결과 저장 폴더")
    parser.add_argument("--debug-html", action="store_true", help="상세페이지 원본 HTML 저장 (판매자정보 못 찾을 때 점검용)")
    # 구글 스프레드시트 업로드(선택)
    parser.add_argument("--sheet-id", help="업로드할 구글 스프레드시트 ID (미지정 시 CSV/JSON만 저장)")
    parser.add_argument("--worksheet", default="시트1", help="업로드할 워크시트(탭) 이름")
    parser.add_argument("--creds", default="service_account.json", help="구글 서비스 계정 JSON 키 경로")
    args = parser.parse_args()

    limit = max(1, min(args.limit, MAX_LIMIT))
    if args.limit > MAX_LIMIT:
        print(f"[안내] 과도한 수집을 막기 위해 --limit은 최대 {MAX_LIMIT}으로 제한됩니다.")

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    pw_fetcher = PlaywrightFetcher() if args.engine == "playwright" else None

    try:
        links = collect_top_links(session, args.keyword, limit, args.timeout, args.min_delay, args.max_delay)
        if not links:
            print("[안내] 검색 결과에서 상품 링크를 찾지 못했습니다. scraper.py로 먼저 검색 결과 파싱이 되는지 확인해보세요.")
            return

        print(f"\n[안내] 상세페이지 {len(links)}건을 순회합니다. "
              f"(요청 간 {args.min_delay}~{args.max_delay}초 대기, 예상 소요 시간 약 "
              f"{int(len(links) * (args.min_delay + args.max_delay) / 2 / 60)}분 이상)\n")

        collected: list[SellerInfo] = []
        for idx, (name, link) in enumerate(links, start=1):
            print(f"[진행] {idx}/{len(links)} 상세페이지 조회: {name or link}")

            if pw_fetcher:
                html = pw_fetcher.fetch(link, args.timeout)
            else:
                html = fetch_detail_requests(session, link, args.timeout)

            if html == "__BLOCKED__":
                print("[중단] 차단이 감지되어 더 이상 진행하지 않고, 지금까지 모은 결과만 저장합니다.")
                break
            if html is None:
                print("[건너뜀] 이 상품은 조회에 실패해 건너뜁니다.")
                continue

            if args.debug_html:
                debug_path = out_dir / f"debug_detail_{idx}.html"
                debug_path.write_text(html, encoding="utf-8")

            info = parse_seller_info(html)
            if not any(info.values()):
                print("  [경고] 판매자 정보를 찾지 못했습니다. "
                      "--debug-html로 저장한 HTML을 확인하거나 --engine playwright를 시도해보세요.")

            collected.append(
                SellerInfo(
                    rank=idx,
                    product_name=name,
                    product_link=link,
                    company_owner=info["company_owner"],
                    address=info["address"],
                    email=info["email"],
                    phone=info["phone"],
                    mail_order_license_no=info["mail_order_license_no"],
                    business_reg_no=info["business_reg_no"],
                )
            )

            if idx < len(links):
                time.sleep(random.uniform(args.min_delay, args.max_delay))
    finally:
        if pw_fetcher:
            pw_fetcher.close()

    if not collected:
        print("[안내] 수집된 판매자 정보가 없습니다.")
        return

    csv_path = out_dir / f"{args.keyword}_판매자정보.csv"
    json_path = out_dir / f"{args.keyword}_판매자정보.json"
    save_csv(collected, csv_path)
    save_json(collected, json_path)
    print(f"\n총 {len(collected)}건 저장 완료")
    print(f"  - CSV : {csv_path}")
    print(f"  - JSON: {json_path}")

    if args.sheet_id:
        from sheets_uploader import upload_rows

        print(f"\n[진행] 구글 스프레드시트 업로드 중... (sheet-id={args.sheet_id}, worksheet={args.worksheet})")
        try:
            upload_rows(args.sheet_id, args.worksheet, args.creds, [asdict(r) for r in collected])
            print("[완료] 구글 스프레드시트 업로드 성공")
        except Exception as exc:  # noqa: BLE001
            print(f"[오류] 구글 스프레드시트 업로드 실패: {exc}", file=sys.stderr)
            print("CSV/JSON은 정상 저장되었으니, sheets_uploader.py를 단독 실행해 다시 업로드할 수 있습니다.")


if __name__ == "__main__":
    main()
