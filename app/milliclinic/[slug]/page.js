import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import styles from "../milliclinic.module.css";
import MilliHeader from "../Header";
import MilliFooter from "../Footer";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = await prisma.milliPost.findUnique({ where: { slug } });
  if (!post) return {};
  return {
    title: `${post.title} | MILI CLINIC`,
    description: post.excerpt,
  };
}

export default async function MilliClinicPostPage({ params }) {
  const { slug } = await params;
  const post = await prisma.milliPost.findUnique({ where: { slug } });
  if (!post || !post.published) notFound();

  return (
    <div className={styles.page}>
      <MilliHeader />

      <main className={styles.postMain}>
        <div className={styles.container}>
          <Link href="/milliclinic" className={styles.postBack}>← 목록으로</Link>

          <span className={styles.postTag}>{post.tag}</span>
          <h1 className={styles.postTitle}>{post.title}</h1>
          <p className={styles.postMeta}>{post.author} / {formatDate(post.createdAt)}</p>

          {post.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.image} alt="" className={styles.postImage} />
          )}

          <div
            className={styles.postBody}
            dangerouslySetInnerHTML={{ __html: marked.parse(post.content) }}
          />
        </div>
      </main>

      <MilliFooter />
    </div>
  );
}
