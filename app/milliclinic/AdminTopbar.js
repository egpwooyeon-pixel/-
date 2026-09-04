import Link from "next/link";
import { logoutMilliAction } from "@/lib/milliActions";

export default function MilliAdminTopbar() {
  return (
    <div className="admin-topbar">
      <div className="container">
        <Link href="/milliclinic/admin" className="admin-topbar__brand">
          밀리클리닉 <span>관리자</span>
        </Link>
        <nav>
          <Link href="/milliclinic" target="_blank">홈페이지 보기 ↗</Link>
          <Link href="/milliclinic/admin/posts/new">새 글쓰기</Link>
          <form action={logoutMilliAction}>
            <button type="submit">로그아웃</button>
          </form>
        </nav>
      </div>
    </div>
  );
}
