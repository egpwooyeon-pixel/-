import MilliAdminTopbar from "../../../AdminTopbar";
import MilliPostEditor from "../../../PostEditor";
import { createMilliPostAction } from "@/lib/milliActions";

export const metadata = { title: "새 글쓰기 | 밀리클리닉 관리자" };

const ERROR_MESSAGES = {
  1: "제목과 본문을 모두 입력해주세요.",
  slug: "슬러그는 영문 소문자, 숫자, 하이픈(-)만 사용할 수 있습니다.",
  "slug-taken": "이미 사용 중인 슬러그입니다. 다른 슬러그를 입력해주세요.",
};

export default async function NewMilliPostPage({ searchParams }) {
  const sp = await searchParams;
  const errorMessage = sp?.error ? ERROR_MESSAGES[sp.error] ?? null : null;

  return (
    <div className="admin-shell">
      <MilliAdminTopbar />
      <main className="admin-main">
        <h1>새 글쓰기</h1>
        <MilliPostEditor action={createMilliPostAction} errorMessage={errorMessage} />
      </main>
    </div>
  );
}
