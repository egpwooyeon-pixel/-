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

function withLineBreaks(text) {
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <span key={i}>
      {line}
      {i < lines.length - 1 && <br />}
    </span>
  ));
}

// A line "[SECTION NAME]" renders as a section header bar; a line with
// " — " (label — price) renders as a two-column price row. Used for
// notice/price-list style posts; plain paragraphs render as before.
function PriceLine({ line }) {
  const l = line.trim();
  if (!l) return null;
  const section = /^\[(.+)\]$/.exec(l);
  if (section) return <div className={styles.priceSection}>{section[1]}</div>;
  const dash = l.lastIndexOf(" — ");
  if (dash !== -1) {
    const label = l.slice(0, dash).trim();
    const price = l.slice(dash + 3).trim();
    return (
      <div className={styles.priceRow}>
        <span>{label}</span>
        <strong>{price}</strong>
      </div>
    );
  }
  return <p className={styles.priceNote}>{l}</p>;
}

function BodyParagraph({ paragraph }) {
  const trimmed = paragraph.trim();
  if (trimmed.startsWith("![")) {
    const split = trimmed.indexOf("](");
    if (split !== -1 && trimmed.endsWith(")")) {
      const alt = trimmed.slice(2, split);
      const src = trimmed.slice(split + 2, -1);
      if (/^(data:image\/|https?:\/\/)/.test(src)) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={src} alt={alt} />;
      }
    }
  }

  const lines = paragraph.split("\n");
  if (lines.some((l) => /^\[.+\]$/.test(l.trim()) || l.includes(" — "))) {
    return (
      <div className={styles.priceBlock}>
        {lines.map((l, i) => <PriceLine key={i} line={l} />)}
      </div>
    );
  }

  return <p>{withLineBreaks(paragraph)}</p>;
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

          {post.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.image} alt="" className={styles.postImage} />
          )}

          <div className={styles.postBody}>
            {post.body.map((paragraph, i) => (
              <BodyParagraph key={i} paragraph={paragraph} />
            ))}
          </div>
        </div>
      </main>

      <MilliFooter />
    </div>
  );
}
