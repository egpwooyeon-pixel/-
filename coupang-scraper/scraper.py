#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
쿠팡(coupang.com) 검색 결과 크롤러 (requests + BeautifulSoup)

사용 전 반드시 읽어주세요
--------------------------------------------------------------------------
- 쿠팡의 robots.txt 및 이용약관은 자동화된 데이터 수집을 제한하고 있는 것으로
  보입니다. 이 스크립트는 "개인 학습 / 개인용 가격 확인" 목적의 저빈도 사용을
  전제로 작성되었습니다. 상업적 이용, 대량/고빈도 수집, 봇 탐지 우회(캡차 자동
  풀이, 프록시 로테이션을 통한 차단 회피 등)를 위한 용도로 개조하지 마세요.
- 쿠팡 페이지의 HTML 구조(class 이름 등)는 예고 없이 바뀔 수 있습니다. 이 코드의
  SELECTORS 값은 공개된 자료를 참고해 작성한 "시작점"이며, 실행 시점의 실제
  페이지와 다를 수 있습니다. 상품이 0건으로 나오면 --debug-html 옵션으로 저장한
  HTML을 브라우저 개발자도구로 열어 실제 class 이름을 확인하고 아래 SELECTORS를
  직접 수정하세요.
- 403/429 응답이나 보안 확인 페이지가 뜨면 이는 접근이 차단되었다는 뜻입니다.
  이 스크립트는 그런 상황에서 우회를 시도하지 않고 즉시 중단하도록 만들어져
  있습니다. 재시도 간격을 늘리거나, 잠시 후 다시 시도하거나, 사용을 중단하세요.
"""

import argparse
import csv
import json
import random
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.coupang.com"
SEARCH_PATH = "/np/search"

# 실제 데스크톱 브라우저와 동일한 헤더. 봇 탐지 우회용 위장이 아니라
# "User-Agent 미설정으로 인한 단순 차단"을 피하기 위한 최소한의 설정입니다.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
}

# 상품 하나에 해당하는 <li>와, 그 내부에서 필드를 찾을 선택자 모음.
# 공개된 튜토리얼/코드 사례를 참고해 구성한 "시작 값"이므로 실제 페이지와
# 다르면 브라우저 개발자도구(F12)로 직접 확인 후 수정해야 합니다.
SELECTORS = {
    "item_class_prefix": "search-product",  # <li class="search-product...">
    "name": {"tag": "div", "class_": "name"},
    "price": {"tag": "strong", "class_": "price-value"},
    "rating": {"tag": "em", "class_": "rating"},
    "rating_count": {"tag": "span", "class_": "rating-total-count"},
    "thumbnail": {"tag": "img", "class_": "search-product-wrap-img"},
}

BLOCK_SIGNS = ["access denied", "정상적인 접근이 아닙니다", "captcha", "보안문자", "차단"]


@dataclass
class Product:
    keyword: str
    page: int
    rank: int
    name: Optional[str]
    price: Optional[str]
    rating: Optional[str]
    rating_count: Optional[str]
    link: Optional[str]
    thumbnail: Optional[str]


def build_search_url(keyword: str, page: int) -> str:
    query = urllib.parse.urlencode({"q": keyword, "page": page, "channel": "user"})
    return f"{BASE_URL}{SEARCH_PATH}?{query}"


def looks_blocked(status_code: int, html: str) -> bool:
    if status_code in (403, 429):
        return True
    lowered = html.lower()
    return any(sign in lowered for sign in BLOCK_SIGNS)


def fetch_page(session: requests.Session, keyword: str, page: int, timeout: float) -> Optional[str]:
    url = build_search_url(keyword, page)
    try:
        resp = session.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
    except requests.RequestException as exc:
        print(f"[오류] 요청 실패: {exc}", file=sys.stderr)
        return None

    if looks_blocked(resp.status_code, resp.text):
        print(
            f"[중단] 접근이 차단된 것으로 보입니다 (status={resp.status_code}). "
            "우회를 시도하지 않고 종료합니다. 잠시 후 다시 시도하거나 요청 간격을 늘려보세요.",
            file=sys.stderr,
        )
        return None

    if resp.status_code != 200:
        print(f"[경고] 예상치 못한 응답 코드: {resp.status_code}", file=sys.stderr)
        return None

    return resp.text


def extract_text(node, spec) -> Optional[str]:
    found = node.find(spec["tag"], class_=spec["class_"])
    return found.get_text(strip=True) if found else None


def parse_products(html: str, keyword: str, page: int) -> list[Product]:
    soup = BeautifulSoup(html, "lxml")
    items = soup.find_all("li", class_=re.compile(rf"^{SELECTORS['item_class_prefix']}"))

    products = []
    for rank, item in enumerate(items, start=1):
        link_tag = item.find("a", href=True)
        link = link_tag["href"] if link_tag else None
        if link and link.startswith("/"):
            link = BASE_URL + link

        thumb_spec = SELECTORS["thumbnail"]
        thumb_tag = item.find(thumb_spec["tag"], class_=thumb_spec["class_"])
        thumbnail = thumb_tag.get("src") or thumb_tag.get("data-src") if thumb_tag else None

        products.append(
            Product(
                keyword=keyword,
                page=page,
                rank=rank,
                name=extract_text(item, SELECTORS["name"]),
                price=extract_text(item, SELECTORS["price"]),
                rating=extract_text(item, SELECTORS["rating"]),
                rating_count=extract_text(item, SELECTORS["rating_count"]),
                link=link,
                thumbnail=thumbnail,
            )
        )
    return products


def save_csv(products: list[Product], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(products[0]).keys()) if products else [
            "keyword", "page", "rank", "name", "price", "rating", "rating_count", "link", "thumbnail"
        ])
        writer.writeheader()
        for p in products:
            writer.writerow(asdict(p))


def save_json(products: list[Product], path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump([asdict(p) for p in products], f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="쿠팡 검색 결과 크롤러 (개인 학습용)")
    parser.add_argument("keyword", nargs="?", default="컴퓨터책상", help="검색 키워드 (기본값: 컴퓨터책상)")
    parser.add_argument("--pages", type=int, default=1, help="가져올 페이지 수 (최대 5, 기본 1)")
    parser.add_argument("--min-delay", type=float, default=2.0, help="페이지 간 최소 대기 시간(초)")
    parser.add_argument("--max-delay", type=float, default=4.0, help="페이지 간 최대 대기 시간(초)")
    parser.add_argument("--timeout", type=float, default=10.0, help="요청 타임아웃(초)")
    parser.add_argument("--output", default="output", help="결과 저장 폴더")
    parser.add_argument("--debug-html", action="store_true", help="가져온 원본 HTML을 파일로 저장 (선택자 점검용)")
    args = parser.parse_args()

    pages = max(1, min(args.pages, 5))
    if args.pages > 5:
        print("[안내] 과도한 수집을 막기 위해 페이지 수는 최대 5로 제한됩니다.")

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    all_products: list[Product] = []

    for page in range(1, pages + 1):
        print(f"[진행] '{args.keyword}' 검색 결과 {page}/{pages} 페이지 요청 중...")
        html = fetch_page(session, args.keyword, page, args.timeout)
        if html is None:
            break

        if args.debug_html:
            debug_path = out_dir / f"debug_page{page}.html"
            debug_path.write_text(html, encoding="utf-8")
            print(f"[디버그] 원본 HTML 저장: {debug_path}")

        products = parse_products(html, args.keyword, page)
        print(f"[결과] {page}페이지에서 상품 {len(products)}건 추출")
        all_products.extend(products)

        if page < pages:
            time.sleep(random.uniform(args.min_delay, args.max_delay))

    if not all_products:
        print(
            "[안내] 추출된 상품이 없습니다. --debug-html 옵션으로 저장된 HTML을 열어 "
            "실제 class 이름을 확인하고 스크립트 상단 SELECTORS 값을 수정해보세요."
        )
        return

    csv_path = out_dir / f"{args.keyword}_결과.csv"
    json_path = out_dir / f"{args.keyword}_결과.json"
    save_csv(all_products, csv_path)
    save_json(all_products, json_path)

    print(f"\n총 {len(all_products)}건 저장 완료")
    print(f"  - CSV : {csv_path}")
    print(f"  - JSON: {json_path}")


if __name__ == "__main__":
    main()
