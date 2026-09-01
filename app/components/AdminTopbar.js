import Link from "next/link";
import { logoutAction } from "@/lib/actions";

export default function AdminTopbar() {
  return (
    <div className="admin-topbar">
      <div className="container">
        <Link href="/admin" className="admin-topbar__brand">
          연세힐치과 <span>관리자</span>
        </Link>
        <nav>
          <Link href="/blog" target="_blank">블로그 보기 ↗</Link>
          <Link href="/admin/posts/new">새 글쓰기</Link>
          <form action={logoutAction}>
            <button type="submit">로그아웃</button>
          </form>
        </nav>
      </div>
    </div>
  );
}
