import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import Header from "../../components/Header";
import Footer from "../../components/Footer";
import Floating from "../../components/Floating";
import { prisma } from "@/lib/db";

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = await prisma.post.findUnique({ where: { slug } });
  if (!post) return {};
  return {
    title: `${post.title} | 연세힐치과병원`,
    description: post.excerpt,
  };
}

export default async function BlogPostPage({ params }) {
  const { slug } = await params;
  const post = await prisma.post.findUnique({ where: { slug } });

  if (!post || !post.published) {
    notFound();
  }

  const html = marked.parse(post.content || "");

  return (
    <>
      <Header />
      <article className="post-page">
        <div className="container">
          <div className="post-header">
            <span className="post-header__cat">{post.category}</span>
            <h1>{post.title}</h1>
            <p className="post-header__meta">{post.author} · {formatDate(post.createdAt)}</p>
          </div>

          {post.thumbnail && (
            <div className="post-thumb">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={post.thumbnail} alt={post.title} />
            </div>
          )}

          <div className="post-body" dangerouslySetInnerHTML={{ __html: html }} />

          <div className="post-back">
            <Link href="/blog">← 블로그 목록으로</Link>
          </div>
        </div>
      </article>
      <Footer />
      <Floating />
    </>
  );
}
