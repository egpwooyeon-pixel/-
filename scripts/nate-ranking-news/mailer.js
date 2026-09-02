const nodemailer = require("nodemailer");

function formatDateKST() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
}

async function sendRankingEmail({ items, to, from, sourceUrl }) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const dateStr = formatDateKST();

  const listHtml = items
    .map(
      (item) =>
        `<li><a href="${item.url}">${item.rank}. ${item.title}</a></li>`
    )
    .join("\n");

  const listText = items.map((item) => `${item.rank}. ${item.title} - ${item.url}`).join("\n");

  await transporter.sendMail({
    from,
    to,
    subject: `[Nate 랭킹뉴스] ${dateStr}`,
    text: `Nate 랭킹뉴스 (${dateStr})\n\n${listText}\n\n전체보기: ${sourceUrl}`,
    html: `
      <h2>Nate 랭킹뉴스 (${dateStr})</h2>
      <ol>${listHtml}</ol>
      <p><a href="${sourceUrl}">Nate 랭킹뉴스 전체보기</a></p>
    `,
  });
}

module.exports = { sendRankingEmail };
