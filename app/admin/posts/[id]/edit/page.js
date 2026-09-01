import { notFound } from "next/navigation";
import AdminTopbar from "../../../../components/AdminTopbar";
import PostEditor from "../../../../components/PostEditor";
import { prisma } from "@/lib/db";
import { updatePostAction } from "@/lib/actions";

export const metadata = { title: "글 수정 | 연세힐치과병원 관리자" };

export default async function EditPostPage({ params, searchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const hasError = sp?.error === "1";

  const post = await prisma.post.findUnique({ where: { id: Number(id) } });
  if (!post) notFound();

  return (
    <div className="admin-shell">
      <AdminTopbar />
      <main className="admin-main">
        <h1>글 수정</h1>
        <PostEditor
          action={updatePostAction.bind(null, post.id)}
          initialPost={post}
          errorMessage={hasError ? "제목과 본문을 모두 입력해주세요." : null}
        />
      </main>
    </div>
  );
}
