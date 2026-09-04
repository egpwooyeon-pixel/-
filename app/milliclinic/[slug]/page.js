import Link from "next/link";
import { notFound } from "next/navigation";
import styles from "../milliclinic.module.css";
import MilliHeader from "../Header";
import MilliFooter from "../Footer";
import { POSTS, getPost } from "../posts";

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: `${post.title} | MILI CLINIC`,
    description: post.excerpt,
  };
}

export default async function MilliClinicPostPage({ params }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <div className={styles.page}>
      <MilliHeader />

      <main className={styles.postMain}>
        <div className={styles.container}>
          <Link href="/milliclinic" className={styles.postBack}>← 목록으로</Link>

          <span className={styles.postTag}>{post.tag}</span>
          <h1 className={styles.postTitle}>{post.title}</h1>
          <p className={styles.postMeta}>{post.meta}</p>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.image} alt="" className={styles.postImage} />

          <div className={styles.postBody}>
            {post.body.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </div>
      </main>

      <MilliFooter />
    </div>
  );
}
