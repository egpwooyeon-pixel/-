import Link from "next/link";
import styles from "./milliclinic.module.css";
import MilliHeader from "./Header";
import MilliFooter from "./Footer";
import { prisma } from "@/lib/db";

export const metadata = {
  title: "도산공원 스컬트라 잘하는 밀리클리닉 | MILI CLINIC",
  description:
    "도산공원 밀리클리닉 - 울쎄라·써마지·튠페이스·스컬트라·핏컬트라 피부과. 원장 1:1 상담, 정품·정량 시술.",
};

export const dynamic = "force-dynamic";

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function MilliClinicPage() {
  const posts = await prisma.milliPost.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
  });

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
          {posts.length === 0 ? (
            <div className={styles.empty}>아직 등록된 글이 없습니다.</div>
          ) : (
            <div className={styles.grid}>
              {posts.map((post) => (
                <article className={styles.card} key={post.slug}>
                  <Link href={`/milliclinic/${post.slug}`} className={styles.thumb}>
                    {post.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.image} alt="" className={styles.thumbImg} />
                    )}
                    <span className={styles.thumbTag}>{post.tag}</span>
                    {post.headline && (
                      <p className={styles.thumbHeadline}>
                        {post.headline.split("\n").map((line, i, arr) => (
                          <span key={i}>
                            {line}
                            {i < arr.length - 1 && <br />}
                          </span>
                        ))}
                      </p>
                    )}
                    <span className={styles.thumbBrand}>M I L I  C L I N I C</span>
                  </Link>

                  <span className={styles.cardTag}>{post.tag}</span>
                  <Link href={`/milliclinic/${post.slug}`} className={styles.cardTitle}>
                    {post.title}
                  </Link>
                  <p className={styles.cardMeta}>{post.author} / {formatDate(post.createdAt)}</p>
                  <p className={styles.cardExcerpt}>{post.excerpt}</p>
                </article>
              ))}
            </div>
          )}

          <div className={styles.pagination}>
            <span className={styles.pageActive}>1</span>
          </div>
        </div>
      </main>

      <MilliFooter />
    </div>
  );
}
