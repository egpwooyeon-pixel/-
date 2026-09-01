import Link from "next/link";
import Header from "../components/Header";
import Footer from "../components/Footer";
import Floating from "../components/Floating";
import { prisma } from "@/lib/db";

const PAGE_SIZE = 6;

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const metadata = {
  title: "블로그 | 연세힐치과병원",
  description: "연세힐치과병원의 치료 후기, 임플란트 정보, 병원 소식을 확인하세요.",
};

export default async function BlogListPage({ searchParams }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp?.page ?? "1", 10) || 1);

  const [posts, total] = await Promise.all([
    prisma.post.findMany({
      where: { published: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.post.count({ where: { published: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <Header />
      <div className="blog-page">
        <div className="container">
          <div className="blog-header">
            <h1>강서구 임플란트 잘하는 연세힐치과병원</h1>
            <p>임플란트 · 일반진료 · 치아성형 정보와 병원 소식을 전해드립니다</p>
          </div>

          {posts.length === 0 ? (
            <div className="blog-empty">
              <p>아직 등록된 글이 없습니다.</p>
            </div>
          ) : (
            <div className="blog-grid">
              {posts.map((post) => (
                <article key={post.id} className="blog-card">
                  <Link href={`/blog/${post.slug}`} className="blog-card__thumb">
                    {post.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.thumbnail} alt={post.title} />
                    ) : (
                      <span className="blog-card__thumb-fallback">HEAL DENTAL</span>
                    )}
                  </Link>
                  <span className="blog-card__cat">{post.category}</span>
                  <Link href={`/blog/${post.slug}`} className="blog-card__title">
                    {post.title}
                  </Link>
                  <p className="blog-card__meta">{post.author} / {formatDate(post.createdAt)}</p>
                  <p className="blog-card__excerpt">{post.excerpt}</p>
                </article>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="pagination">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/blog?page=${p}`}
                  className={p === page ? "is-active" : ""}
                >
                  {p}
                </Link>
              ))}
              {page < totalPages && (
                <Link href={`/blog?page=${page + 1}`} className="next">다음 →</Link>
              )}
            </div>
          )}
        </div>
      </div>
      <Footer />
      <Floating />
    </>
  );
}
