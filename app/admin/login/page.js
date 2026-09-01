import { loginAction } from "@/lib/actions";

export const metadata = { title: "관리자 로그인 | 연세힐치과병원" };

export default async function AdminLoginPage({ searchParams }) {
  const sp = await searchParams;
  const hasError = sp?.error === "1";

  return (
    <div className="admin-login">
      <div className="admin-login__card">
        <h1>관리자 로그인</h1>
        <p className="sub">연세힐치과병원 블로그 관리자 페이지</p>

        {hasError && <div className="admin-login__error">비밀번호가 올바르지 않습니다.</div>}

        <form action={loginAction}>
          <label>
            관리자 비밀번호
            <input type="password" name="password" placeholder="비밀번호 입력" required autoFocus />
          </label>
          <button type="submit" className="btn btn--primary btn--block">로그인</button>
        </form>
      </div>
    </div>
  );
}
