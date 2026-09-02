# Nate 랭킹뉴스 매일 메일 발송

`news.nate.com` 랭킹뉴스 탭을 매일 아침 9시(KST)에 수집해서 이메일로 보내는 스크립트.
실제 실행은 이 저장소를 pull한 뒤 [.github/workflows/nate-ranking-news.yml](../../.github/workflows/nate-ranking-news.yml)의
GitHub Actions 스케줄이 담당한다. (Claude Code 세션 안의 크론은 세션이 끝나면 사라지므로
"매일" 요구사항에는 GitHub Actions처럼 저장소 밖에서 도는 스케줄러가 필요하다.)

## 동작 방식

1. `scrape.js` — `https://news.nate.com/rank/interest?sc=all&period=day`를 가져와 랭킹 기사
   목록(순위/제목/링크)을 파싱한다. 사이트 구조가 바뀌어도 최대한 버티도록 후보 CSS 셀렉터
   여러 개를 순서대로 시도한다(`CANDIDATE_SELECTORS`).
2. `mailer.js` — Gmail SMTP(nodemailer)로 순위 목록을 HTML 메일로 발송한다.
3. `index.js` — 위 둘을 연결하는 실행 진입점. 기사를 하나도 못 찾으면 빈 메일을 보내는 대신
   에러로 종료해서 GitHub Actions가 실패로 표시하도록 한다.

## 필요한 GitHub Secrets

저장소 Settings → Secrets and variables → Actions에서 등록:

| Secret 이름 | 설명 |
| --- | --- |
| `GMAIL_USER` | 발신용 Gmail 주소 |
| `GMAIL_APP_PASSWORD` | 위 계정의 [앱 비밀번호](https://myaccount.google.com/apppasswords) (일반 로그인 비밀번호 아님, 2단계 인증 필요) |
| `MAIL_TO` | 수신 이메일 주소 (생략 시 `GMAIL_USER`로 발송) |

## 로컬에서 테스트

```bash
cp .env.example .env   # GMAIL_USER / GMAIL_APP_PASSWORD / MAIL_TO 채우기
npm run news:nate
```

## 알려진 한계

- 이 스크립트는 Claude Code 세션(샌드박스) 안에서는 조직 egress 정책으로
  `news.nate.com` 접속이 차단되어 있어 실제 페이지로 검증하지 못한 상태로 작성됐다. GitHub
  Actions 러너에서 처음 돌릴 때 기사를 못 찾으면(워크플로우가 실패로 표시됨) `scrape.js`의
  `CANDIDATE_SELECTORS`를 실제 페이지 구조에 맞게 수정해야 한다.
- Nate가 로그인/캡차 등으로 크롤링을 막을 경우 별도 대응이 필요할 수 있다.
