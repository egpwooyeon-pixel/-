import styles from "./milliclinic.module.css";

export const metadata = {
  title: "도산공원 필러 잘하는 밀리클리닉 | MILI CLINIC",
  description:
    "도산공원 밀리클리닉 - 엠페이스·스컬트라·레디어스·필러·스킨부스터 피부과. 원장 직접 상담, 정품·정량 시술.",
};

const POSTS = [
  {
    tag: "밀리클리닉",
    title: "도산공원 스킨부스터 잘 하는 곳 추천 (2026) | 개인 맞춤 안티에이징",
    meta: "admin / 2026-08-25",
    excerpt:
      "개인 맞춤형 안티에이징을 원한다면, 밀리클리닉의 스킨부스터 솔루션을 살펴보세요. #도산공원스킨부스터 #개인맞춤안티에이징 밀리클리닉 피부 노화는 개인의 생활 습관, 유전적 요인, 환경적 요소에 따라 다르게 […]",
    thumbTag: "밀리클리닉",
    headline: "정품 · 정량\n시술",
    brand: "M I L I",
    gradient: "linear-gradient(150deg, #2b2420 0%, #171310 100%)",
  },
  {
    tag: "밀리클리닉",
    title: "도산공원 엠페이스 피부과 추천 | 피부 상태 정밀 분석",
    meta: "admin / 2026-08-25",
    excerpt:
      "피부 상태에 맞춰 언제 받아야 할지 정확히 진단하는 체계로 #피부상태분석 #도산공원피부과 #엠페이스 밀리클리닉 원장의 처방은 정확한 진단에서부터 시작됩니다. 최근 […]",
    thumbTag: "밀리클리닉",
    headline: "근육층부터 끌어올리는\n리프팅 엠페이스",
    brand: "M I L I  C L I N I C",
    gradient: "linear-gradient(150deg, #e9d3d6 0%, #cfa9b4 60%, #a9798b 100%)",
  },
  {
    tag: "밀리클리닉",
    title: "도산공원 필러 잘 하는 밀리클리닉 추천 | 원장 직접 상담",
    meta: "admin / 2026-08-25",
    excerpt:
      "원장 직접 상담으로 안전한 시술 받기 #도산공원필러 #밀리클리닉 #원장직접상담 강남 지역에서 필러 시술을 고려한다면 원장의 직접 상담이 […]",
    thumbTag: "밀리클리닉",
    headline: "필러",
    brand: "M I L I  C L I N I C",
    gradient: "linear-gradient(150deg, #cfc3ea 0%, #8f7bc4 60%, #4b3a8f 100%)",
  },
  {
    tag: "밀리클리닉",
    title: "도산공원 레디어스 잘하는 곳 추천 | 프라이빗 진료 환경",
    meta: "admin / 2026-08-25",
    excerpt:
      "프라이빗한 진료 환경에서 받는 전문 레디어스 관리 #프라이빗진료 #밀리클리닉 강남 지역에서 레디어스 시술을 고려한다면 프라이빗한 진료 환경이 갖춰진 의료기관을 […]",
    thumbTag: "밀리클리닉",
    headline: "볼륨과 탄력을\n동시에 레디어스",
    brand: "M I L I  C L I N I C",
    gradient: "linear-gradient(150deg, #f0d9e4 0%, #d9a7c3 60%, #b876a0 100%)",
  },
  {
    tag: "밀리클리닉",
    title: "도산공원 스컬트라 잘 하는 곳 추천 | 복합 시술 설계 능력",
    meta: "admin / 2026-08-25",
    excerpt:
      "복합 시술 설계로 자연스러운 볼륨을 개선 #도산공원스컬트라 #복합시술 밀리클리닉은 단순 주입이 아닌 개인별 노화 패턴과 얼굴 구조를 고려한 […]",
    thumbTag: "밀리클리닉",
    headline: "피부 속\n콜라겐 리모델링",
    brand: "M I L I  C L I N I C",
    gradient: "linear-gradient(150deg, #c9b9e8 0%, #9d84cf 55%, #5a4aa8 100%)",
  },
  {
    tag: "밀리클리닉",
    title: "밀리클리닉 엠페이스 | 도산공원 피부과 추천",
    meta: "admin / 2026-08-25",
    excerpt:
      "도산공원 피부과에서 만나는 차세대 리프팅 솔루션 #밀리클리닉 #엠페이스 #도산공원피부과 도산공원 인근 의원은 이 […]",
    thumbTag: "오늘의 상담",
    headline: "진료 상담실",
    brand: "M I L I  C L I N I C",
    gradient: "linear-gradient(150deg, #dfe3e8 0%, #b9c2cc 55%, #8b96a3 100%)",
  },
];

export default function MilliClinicPage() {
  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <div className={`${styles.container} ${styles.navInner}`}>
          <a href="#" className={styles.logo} aria-label="밀리클리닉">
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <circle cx="16" cy="16" r="14.6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M9.5 21V11.2L16 17.6l6.5-6.4V21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className={styles.logoWord}>밀리클리닉</span>
          </a>
          <div className={styles.navLinks}>
            <a href="#">홈페이지</a>
            <a href="#">블로그</a>
            <a href="#">카카오톡</a>
            <a href="#">문의하기</a>
          </div>
        </div>
      </nav>

      <header className={styles.hero}>
        <div className={styles.container}>
          <h1 className={styles.title}>도산공원 필러 잘하는 밀리클리닉</h1>
          <p className={styles.subtitle}>
            도산공원 엠페이스·스컬트라·레디어스·필러·스킨부스터 피부과
          </p>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.container}>
          <div className={styles.grid}>
            {POSTS.map((post) => (
              <article className={styles.card} key={post.title}>
                <a href="#" className={styles.thumb} style={{ background: post.gradient }}>
                  <span className={styles.thumbTag}>{post.thumbTag}</span>
                  <p className={styles.thumbHeadline}>
                    {post.headline.split("\n").map((line, i) => (
                      <span key={i}>
                        {line}
                        {i < post.headline.split("\n").length - 1 && <br />}
                      </span>
                    ))}
                  </p>
                  <span className={styles.thumbBrand}>{post.brand}</span>
                </a>

                <span className={styles.cardTag}>{post.tag}</span>
                <a href="#" className={styles.cardTitle}>{post.title}</a>
                <p className={styles.cardMeta}>{post.meta}</p>
                <p className={styles.cardExcerpt}>{post.excerpt}</p>
              </article>
            ))}
          </div>

          <div className={styles.pagination}>
            <span className={styles.pageActive}>1</span>
            <a href="#">2</a>
            <span>...</span>
            <a href="#">5</a>
            <a href="#" className={styles.pageNext}>다음 →</a>
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerInner}`}>
          <div>
            <p className={styles.footerBrand}>MILI CLINIC 밀리클리닉</p>
            <p className={styles.footerAddr}>서울특별시 강남구 도산대로45길 17, 3층(신사동) · 대표전화 02-6367-1212</p>
          </div>
          <p className={styles.footerCopy}>&copy; 2026 MILI CLINIC. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
