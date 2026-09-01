import Link from "next/link";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div className="footer__brand">
          <p className="logo logo--light">연세힐치과병원 <em>HEAL DENTAL HOSPITAL</em></p>
          <p>서울특별시 강서구 강서로 231, 우장산해링턴타워 1·2층</p>
          <p>대표전화 02-2697-2875 · 이메일 healdentalclinic@gmail.com · 대표원장 정현준</p>
          <p className="footer__caution">
            ※ 의료광고 심의 대상 여부를 확인하세요. 시술 부작용 및 진료 관련 사항은 반드시 전문의와 상담하세요.
          </p>
        </div>
        <div className="footer__links">
          <Link href="/#home">홈</Link>
          <Link href="/#about">병원소개</Link>
          <Link href="/#treatments">진료과목</Link>
          <Link href="/blog">블로그</Link>
          <Link href="/#location">오시는길</Link>
        </div>
      </div>
      <div className="footer__bottom">
        <p>&copy; 2026 HEAL Dental Hospital. All rights reserved.</p>
      </div>
    </footer>
  );
}
