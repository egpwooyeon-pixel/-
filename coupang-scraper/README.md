# 쿠팡 검색 결과 크롤러 (개인 학습용)

`requests` + `BeautifulSoup`으로 쿠팡(coupang.com) 검색 결과 페이지에서
상품명·가격·평점·리뷰수·링크를 추출해 CSV/JSON으로 저장하는 스크립트입니다
(`scraper.py`). 추가로 검색 상위 N개 상품의 **상세페이지까지 들어가 판매자
정보(상호/대표자, 주소, 이메일, 연락처, 사업자번호 등)를 모아 구글
스프레드시트에 업로드**하는 스크립트도 포함되어 있습니다:

- `auto_browse.py` — 실제 브라우저(Chromium)를 띄워 사람이 검색하고 하나씩
  클릭해서 확인하는 과정을 그대로 자동화. 이어하기(resume) 지원. **권장.**
- `seller_info_scraper.py` — requests 기반의 더 가벼운 대안 (이어하기 미지원)
- `sheets_uploader.py` — 위 두 스크립트가 모은 데이터를 구글 스프레드시트에
  업로드하는 공용 모듈 (단독 CLI로도 사용 가능)

## 먼저 읽어주세요 (중요)

- 쿠팡의 robots.txt와 이용약관은 자동화된 데이터 수집을 제한하고 있는 것으로
  보입니다. 이 도구는 **개인 학습 / 개인용 확인** 목적의 저빈도 사용을 전제로
  만들었습니다. 대량/고빈도 수집, 차단 우회(캡차 자동 풀이, 프록시 로테이션
  등) 목적으로 개조해서 쓰지 마세요.
- `seller_info_scraper.py`는 상품 상세페이지를 **여러 건 순차 방문**하므로
  `scraper.py` 단독 사용보다 요청 수가 훨씬 많습니다. 처음에는 반드시
  `--limit 5`~`10` 정도로 작게 테스트한 뒤 늘리세요. `--limit`은 코드에서
  최대 100으로 강제 제한됩니다.
- 판매자 정보(상호/대표자/주소/이메일/전화/사업자번호)는 전자상거래법상
  **공개 고지 의무**가 있는 정보라 수집 자체는 비공개 개인정보 탈취와는
  다릅니다. 하지만 이 연락처로 **사전 동의 없이 광고성 메시지(영업 제안 등)를
  보내는 것**은 정보통신망법 제50조(영리목적 광고성 정보 전송 제한) 등 별도
  규제 대상이 될 수 있습니다 — 스크래핑의 적법성과는 별개 문제이니, 실제
  영업 연락 전에는 법률 검토를 권장합니다.
- 403/429 응답이나 보안 확인 페이지가 뜨면 스크립트가 즉시 중단됩니다. 이는
  정상 동작이며, 이 시점에서 우회를 시도하지 말고 잠시 후 다시 시도하거나
  사용을 멈추세요.
- 쿠팡 페이지의 HTML 구조(class 이름)는 예고 없이 바뀔 수 있습니다.
  `scraper.py` 상단의 `SELECTORS` 값은 공개된 자료를 참고한 시작점이며, 실제
  실행 시점의 페이지와 다를 수 있습니다. 상품이 0건으로 나오면 아래
  "선택자가 안 맞을 때" 항목을 참고하세요. `seller_info_scraper.py`의 판매자
  정보 추출은 class 이름이 아니라 화면에 보이는 라벨 텍스트("상호/대표자",
  "사업장 소재지" 등)를 기준으로 찾으므로 상대적으로 더 안정적이지만, 판매자
  정보 표 자체가 JavaScript로 늦게 렌더링되는 페이지라면 `--engine playwright`
  옵션이 필요할 수 있습니다.
- 지속적으로 안정적인 데이터가 필요하다면 [쿠팡파트너스 오픈 API](https://developers.coupangcorp.com)
  (상품검색 API) 사용을 더 권장합니다. 다만 파트너스 API는 상품 검색용이며
  판매자 사업자정보까지는 제공하지 않는 것으로 보이므로(미검증), 판매자
  정보가 꼭 필요하다면 이 스크립트가 유일한 방법에 가깝습니다.

## 설치

```bash
cd coupang-scraper
pip install -r requirements.txt
```

## 사용법

```bash
# 기본값: "컴퓨터책상" 검색, 1페이지만
python3 scraper.py

# 키워드 지정
python3 scraper.py "컴퓨터책상"

# 여러 페이지 (최대 5페이지로 제한됨), 요청 간격 3~6초
python3 scraper.py "컴퓨터책상" --pages 3 --min-delay 3 --max-delay 6

# 선택자가 안 맞아서 결과가 0건일 때 원본 HTML을 저장해서 점검
python3 scraper.py "컴퓨터책상" --debug-html
```

결과는 `output/` 폴더에 `<키워드>_결과.csv`, `<키워드>_결과.json`으로 저장됩니다.

## 선택자가 안 맞을 때

1. `--debug-html` 옵션으로 실행해 `output/debug_page1.html`을 확인합니다.
2. 해당 HTML 파일을 브라우저로 열거나, 실제 쿠팡 검색 결과 페이지를 F12
   개발자도구로 열어 상품 하나가 어떤 태그/class로 감싸져 있는지 확인합니다.
3. `scraper.py` 상단의 `SELECTORS` 딕셔너리 값(`item_class_prefix`, `name`,
   `price`, `rating`, `rating_count`, `thumbnail`)을 실제 class 이름에 맞게
   수정합니다.

## 판매자 정보 수집 + 구글 스프레드시트 업로드

두 가지 방식이 있습니다. 실제 브라우저를 띄워 "사람이 검색하고 클릭하는 것"을
그대로 흉내 내는 **`auto_browse.py`**를 우선 권장합니다.

### 방식 A (권장): 실제 브라우저 자동화 — `auto_browse.py`

```bash
pip install playwright
playwright install chromium

# 1) 소규모로 먼저 테스트 (상위 5개, 브라우저 창이 뜨는 걸 직접 볼 수 있음)
python3 auto_browse.py "컴퓨터책상" --limit 5

# 2) 문제 없으면 개수를 늘려 실행 (최대 100)
python3 auto_browse.py "컴퓨터책상" --limit 100

# 창 없이 백그라운드로 돌리고 싶으면
python3 auto_browse.py "컴퓨터책상" --limit 100 --headless
```

- 검색 → 상위 N개 링크 수집 → 상세페이지 방문 → "배송/교환/반품 안내" 탭 자동
  클릭 → 판매자 정보 추출까지 한 번에 처리합니다.
- **이어하기(resume) 지원**: 같은 키워드로 다시 실행하면 이미 처리된 상품은
  건너뛰고 새 상품만 이어서 처리합니다. 중간에 창을 닫거나 오류가 나도, 그때까지
  처리한 결과는 매 건마다 CSV/JSON에 즉시 저장되어 있으므로 처음부터 다시
  돌릴 필요가 없습니다. "계속 반복 실행" 용도에 맞춰져 있습니다.
- 브라우저 창이 화면에 보이는 채로 동작하므로(기본값), 실제로 잘 진행되고
  있는지 눈으로 확인하면서 쓸 수 있습니다.

### 방식 B: requests 기반 (빠르지만 JS 렌더링 페이지엔 약함) — `seller_info_scraper.py`

```bash
# 1) 소규모로 먼저 테스트 (상위 5개만)
python3 seller_info_scraper.py "컴퓨터책상" --limit 5

# 2) 문제 없으면 개수를 늘려 실행 (최대 100)
python3 seller_info_scraper.py "컴퓨터책상" --limit 100 --min-delay 3 --max-delay 6

# 3) 판매자정보가 비어 있으면 브라우저 렌더링 방식으로 재시도
#    (사전에: pip install playwright && playwright install chromium)
python3 seller_info_scraper.py "컴퓨터책상" --limit 10 --engine playwright
```

이 방식은 "이어하기(resume)" 기능이 없어 매번 처음부터 다시 수집합니다.

결과는 항상 `output/<키워드>_판매자정보.csv` / `.json`으로 먼저 저장됩니다
(구글 시트 업로드가 실패해도 데이터가 유실되지 않도록).

### 구글 스프레드시트 연동 설정 (최초 1회)

1. [Google Cloud Console](https://console.cloud.google.com)에서 프로젝트 생성
2. "API 및 서비스 > 라이브러리"에서 **Google Sheets API**, **Google Drive API** 활성화
3. "IAM 및 관리자 > 서비스 계정"에서 서비스 계정 생성
4. 생성한 서비스 계정 → "키" 탭 → "키 추가" → JSON → 다운로드한 파일을
   `coupang-scraper/service_account.json`으로 저장 (경로는 `--creds`로 변경 가능)
5. 업로드할 구글 스프레드시트를 열어 **공유** 버튼으로 서비스 계정 이메일
   (JSON 파일 안 `client_email` 값, `...@...iam.gserviceaccount.com` 형태)을
   **편집자**로 추가
6. 스프레드시트 URL `https://docs.google.com/spreadsheets/d/<이 부분>/edit`에서
   `<이 부분>`이 스프레드시트 ID입니다.

설정 후에는 크롤링과 동시에 업로드:

```bash
python3 auto_browse.py "컴퓨터책상" --limit 20 \
    --sheet-id "1AbCDEFghijklmnopqrstuvwxyz0123456789" \
    --worksheet "시트1" \
    --creds service_account.json

# 또는 seller_info_scraper.py도 동일한 옵션을 지원합니다
python3 seller_info_scraper.py "컴퓨터책상" --limit 20 \
    --sheet-id "1AbCDEFghijklmnopqrstuvwxyz0123456789" \
    --worksheet "시트1" \
    --creds service_account.json
```

이미 저장된 CSV만 따로 업로드하려면:

```bash
python3 sheets_uploader.py --csv "output/컴퓨터책상_판매자정보.csv" \
    --sheet-id "스프레드시트ID" --worksheet "시트1" --creds service_account.json
```

`service_account.json`은 비밀키이므로 절대 git 저장소에 커밋하거나 공유하지
마세요 (`.gitignore`에 이미 등록되어 있습니다).

## 이 코드가 하지 않는 것

- 캡차 자동 풀이, IP/프록시 로테이션, 브라우저 핑거프린트 위조 등 봇 탐지를
  적극적으로 우회하는 기능은 포함하지 않습니다. 차단이 감지되면 재시도 없이
  중단합니다.
- 페이지 수는 코드에서 최대 5로 강제 제한되어 있습니다(대량 수집 방지).

## 참고: 실행 환경 관련

이 스크립트들은 클라우드 실행 환경(샌드박스)에서는 네트워크 정책상
`coupang.com`으로의 외부 접속이 차단되어 있어 그 환경에서는 직접 실행/검증할
수 없었습니다(코드 로직 자체는 로컬 mock 데이터로 검증했습니다). **반드시
본인 PC(또는 접속이 허용된 환경)에서 실행해 주세요.** 특히 `auto_browse.py`는
실제 브라우저 창을 띄우는 방식이라 GUI가 있는 로컬 환경이 필요합니다
(`--headless` 옵션을 쓰면 창 없이도 실행 가능).
