require("dotenv").config();

const { getNateRankingNews, RANK_URL } = require("./scrape");
const { sendRankingEmail } = require("./mailer");

async function main() {
  const items = await getNateRankingNews();

  if (items.length === 0) {
    throw new Error(
      "Nate 랭킹뉴스 목록을 하나도 찾지 못했습니다. news.nate.com 페이지 구조가 바뀌었을 수 있으니 " +
        "scripts/nate-ranking-news/scrape.js의 CANDIDATE_SELECTORS를 확인/업데이트하세요."
    );
  }

  const { GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error(
      "GMAIL_USER / GMAIL_APP_PASSWORD 환경변수(GitHub Secrets)가 설정되어 있지 않습니다."
    );
  }

  const to = MAIL_TO || GMAIL_USER;

  await sendRankingEmail({ items, to, from: GMAIL_USER, sourceUrl: RANK_URL });
  console.log(`Nate 랭킹뉴스 ${items.length}건을 ${to}(으)로 전송했습니다.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
