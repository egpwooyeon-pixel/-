import { notFound } from "next/navigation";
import MilliAdminTopbar from "../../../../AdminTopbar";
import MilliPostEditor from "../../../../PostEditor";
import { prisma } from "@/lib/db";
import { updateMilliPostAction } from "@/lib/milliActions";

export const metadata = { title: "글 수정 | 밀리클리닉 관리자" };

const ERROR_MESSAGES = {
  1: "제목과 본문을 모두 입력해주세요.",
};

export default async function EditMilliPostPage({ params, searchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const errorMessage = sp?.error ? ERROR_MESSAGES[sp.error] ?? null : null;

  const post = await prisma.milliPost.findUnique({ where: { id: Number(id) } });
  if (!post) notFound();

  return (
    <div className="admin-shell">
      <MilliAdminTopbar />
      <main className="admin-main">
        <h1>글 수정</h1>
        <MilliPostEditor
          action={updateMilliPostAction.bind(null, post.id)}
          initialPost={post}
          errorMessage={errorMessage}
        />
      </main>
    </div>
  );
}
