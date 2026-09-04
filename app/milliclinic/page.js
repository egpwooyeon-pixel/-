import Link from "next/link";
import styles from "./milliclinic.module.css";
import MilliHeader from "./Header";
import MilliFooter from "./Footer";
import { POSTS } from "./posts";

export const metadata = {
  title: "도산공원 스컬트라 잘하는 밀리클리닉 | MILI CLINIC",
  description:
    "도산공원 밀리클리닉 - 울쎄라·써마지·튠페이스·스컬트라·핏컬트라 피부과. 원장 1:1 상담, 정품·정량 시술.",
};

export default function MilliClinicPage() {
  return (
    <div className={styles.page}>
      <MilliHeader />

      <header className={styles.hero}>
        <div className={styles.container}>
          <h1 className={styles.title}>도산공원 스컬트라 잘하는 밀리클리닉</h1>
          <p className={styles.subtitle}>
            도산공원 울쎄라·써마지·튠페이스·스컬트라·핏컬트라 피부과
          </p>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.container}>
          <div className={styles.grid}>
            {POSTS.map((post) => (
              <article className={styles.card} key={post.slug}>
                <Link href={`/milliclinic/${post.slug}`} className={styles.thumb}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={post.image} alt="" className={styles.thumbImg} />
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
                </Link>

                <span className={styles.cardTag}>{post.tag}</span>
                <Link href={`/milliclinic/${post.slug}`} className={styles.cardTitle}>
                  {post.title}
                </Link>
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

      <MilliFooter />
    </div>
  );
}
