"use client";

import { useState } from "react";
import Link from "next/link";

const IMPLANT_SUBMENU = [
  "수면 임플란트",
  "당일 임플란트",
  "진단(컴퓨터분석) 임플란트",
  "임플란트 재수술",
  "전신질환 환자는?",
  "건강보험 임플란트",
  "앞니 임플란트",
  "임플란트 틀니",
  "뼈이식 임플란트",
  "틀니",
  "상악동거상술",
  "건강보험 틀니",
];

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <div className="topbar">
        <div className="container topbar__inner">
          <p className="topbar__badge">외국인 환자 유치 등록기관 선정</p>
          <div className="topbar__right">
            <div className="lang">
              <button type="button" className="lang__item is-active">KOR</button>
              <button type="button" className="lang__item">ENG</button>
              <button type="button" className="lang__item">JPN</button>
              <button type="button" className="lang__item">MNG</button>
              <button type="button" className="lang__item">VNM</button>
            </div>
            <Link href="/#gallery" className="topbar__link">전후사진</Link>
            <Link href="/blog" className="topbar__link">병원소식</Link>
          </div>
        </div>
      </div>

      <header className="header" id="header">
        <div className="container header__inner">
          <Link href="/" className="logo">
            <span className="logo__mark" aria-hidden="true">
              <svg viewBox="0 0 48 24" fill="none">
                <path d="M2 4c6 16 14 18 22 18s16-2 22-18" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </span>
            <span className="logo__text">연세힐치과병원<em>HEAL DENTAL HOSPITAL</em></span>
          </Link>

          <nav className="nav">
            <Link href="/#about">연세힐치과</Link>
            <div className="nav__drop">
              <Link href="/#treatments">임플란트</Link>
              <div className="nav__submenu">
                {IMPLANT_SUBMENU.map((item) => (
                  <Link key={item} href="/#treatments">{item}</Link>
                ))}
              </div>
            </div>
            <Link href="/#treatments">일반진료</Link>
            <Link href="/#treatments">치아성형</Link>
            <Link href="/#treatments">사랑니발치</Link>
            <Link href="/blog">블로그</Link>
            <Link href="/#gallery">전후사진/후기</Link>
            <Link href="/#location">상담/예약</Link>
          </nav>

          <button
            className="hamburger"
            aria-label="메뉴 열기"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span></span><span></span><span></span>
          </button>
        </div>
      </header>

      <div className={`mobile-menu ${menuOpen ? "is-open" : ""}`}>
        <Link href="/#about" onClick={() => setMenuOpen(false)}>연세힐치과</Link>
        <Link href="/#treatments" onClick={() => setMenuOpen(false)}>임플란트</Link>
        <Link href="/#treatments" onClick={() => setMenuOpen(false)}>일반진료</Link>
        <Link href="/#treatments" onClick={() => setMenuOpen(false)}>치아성형</Link>
        <Link href="/#treatments" onClick={() => setMenuOpen(false)}>사랑니발치</Link>
        <Link href="/blog" onClick={() => setMenuOpen(false)}>블로그</Link>
        <Link href="/#gallery" onClick={() => setMenuOpen(false)}>전후사진/후기</Link>
        <Link href="/#location" onClick={() => setMenuOpen(false)}>상담/예약</Link>
      </div>
    </>
  );
}
