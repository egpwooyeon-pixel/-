import Link from "next/link";
import AdminTopbar from "../components/AdminTopbar";
import DeletePostButton from "../components/DeletePostButton";
import { prisma } from "@/lib/db";

export const metadata = { title: "글 관리 | 연세힐치과병원 관리자" };
export const dynamic = "force-dynamic";

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function AdminDashboardPage() {
  const posts = await prisma.post.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div className="admin-shell">
      <AdminTopbar />
      <main className="admin-main">
        <div className="admin-header-row">
          <h1>글 관리 ({posts.length})</h1>
          <Link href="/admin/posts/new" className="btn btn--primary">+ 새 글쓰기</Link>
        </div>

        {posts.length === 0 ? (
          <div className="admin-empty">
            <p>아직 작성한 글이 없습니다. 첫 글을 작성해보세요.</p>
          </div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>상태</th>
                <th>제목</th>
                <th>카테고리</th>
                <th>작성일</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td>
                    <span className={`status ${post.published ? "status--published" : "status--draft"}`}>
                      {post.published ? "발행됨" : "비공개"}
                    </span>
                  </td>
                  <td className="title">{post.title}</td>
                  <td>{post.category}</td>
                  <td>{formatDate(post.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <Link href={`/admin/posts/${post.id}/edit`}>수정</Link>
                      {post.published && (
                        <Link href={`/blog/${post.slug}`} target="_blank">보기</Link>
                      )}
                      <DeletePostButton postId={post.id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
