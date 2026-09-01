import AdminTopbar from "../../../components/AdminTopbar";
import PostEditor from "../../../components/PostEditor";
import { createPostAction } from "@/lib/actions";

export const metadata = { title: "새 글쓰기 | 연세힐치과병원 관리자" };

export default async function NewPostPage({ searchParams }) {
  const sp = await searchParams;
  const hasError = sp?.error === "1";

  return (
    <div className="admin-shell">
      <AdminTopbar />
      <main className="admin-main">
        <h1>새 글쓰기</h1>
        <PostEditor
          action={createPostAction}
          errorMessage={hasError ? "제목과 본문을 모두 입력해주세요." : null}
        />
      </main>
    </div>
  );
}
