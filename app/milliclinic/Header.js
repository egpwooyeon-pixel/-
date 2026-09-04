import Link from "next/link";
import styles from "./milliclinic.module.css";

export default function MilliHeader() {
  return (
    <nav className={styles.nav}>
      <div className={`${styles.container} ${styles.navInner}`}>
        <Link href="/milliclinic" className={styles.logo} aria-label="밀리클리닉">
          <svg viewBox="0 0 34 34" aria-hidden="true">
            <rect width="34" height="34" rx="4" fill="#2b2a4d" />
            <text x="17" y="15.5" textAnchor="middle" fontFamily="'IBM Plex Sans KR','Pretendard',sans-serif" fontSize="6.6" fontWeight="700" letterSpacing="1.6" fill="#fff">M I L I</text>
            <text x="17" y="24" textAnchor="middle" fontFamily="'IBM Plex Sans KR','Pretendard',sans-serif" fontSize="5.6" fontWeight="600" letterSpacing="1" fill="#fff">CLINIC</text>
          </svg>
        </Link>
        <div className={styles.navLinks}>
          <a href="https://dosan.miliclinic.co.kr/" target="_blank" rel="noopener noreferrer">홈페이지</a>
          <a href="https://blog.naver.com/dosan_miliclinic" target="_blank" rel="noopener noreferrer">블로그</a>
          <a href="#">카카오톡</a>
          <a
            href="https://map.naver.com/p/search/%EB%B0%80%EB%A6%AC%EB%8F%84%EC%82%B0%EA%B3%B5%EC%9B%90/place/1635689178"
            target="_blank"
            rel="noopener noreferrer"
          >
            문의하기
          </a>
        </div>
      </div>
    </nav>
  );
}
