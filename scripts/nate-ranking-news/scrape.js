const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const RANK_URL = "https://news.nate.com/rank/interest?sc=all&period=day";

// Nate 랭킹뉴스 페이지 구조는 예고 없이 바뀔 수 있으므로 여러 후보 셀렉터를
// 순서대로 시도한다. 하나라도 결과를 찾으면 그 셀렉터를 채택한다.
const CANDIDATE_SELECTORS = [
  "ul.mlt01 li",
  "div.rankNewsList li",
  "ol.rank_list li",
  "div.commentRankNews li",
  "div.ranking_list li",
];

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Nate 랭킹뉴스 페이지 요청 실패: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "";
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  const charset = (charsetMatch ? charsetMatch[1] : "utf-8").trim().toLowerCase();

  if (charset.includes("euc-kr") || charset.includes("ks_c_5601")) {
    return iconv.decode(buffer, "euc-kr");
  }
  return buffer.toString("utf-8");
}

function parseRanking(html, limit = 20) {
  const $ = cheerio.load(html);
  const items = [];

  for (const selector of CANDIDATE_SELECTORS) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const linkEl = $el.find("a").first();
      const title =
        linkEl.text().trim() || $el.find(".tit, .subject").first().text().trim();
      let href = linkEl.attr("href");

      if (title && href) {
        if (href.startsWith("/")) href = `https://news.nate.com${href}`;
        items.push({ rank: items.length + 1, title, url: href });
      }
    });

    if (items.length > 0) break;
  }

  return items.slice(0, limit);
}

async function getNateRankingNews(limit = 20) {
  const html = await fetchHtml(RANK_URL);
  return parseRanking(html, limit);
}

module.exports = { getNateRankingNews, parseRanking, fetchHtml, RANK_URL };
