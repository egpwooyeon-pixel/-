"use client";

import { useEffect, useRef, useState } from "react";

const SLIDES = [
  {
    eyebrow: "강서구 임플란트 명가 · 11년",
    title: (<>한자리에서 11년,<br />연세힐치과병원</>),
    desc: "대표원장이 매일 직접 진단하는 임플란트 전문 치과",
  },
  {
    eyebrow: "외국인 환자 유치 등록기관",
    title: (<>KOR · ENG · JPN<br />MNG · VNM 다국어 진료</>),
    desc: "외국인 환자도 안심하고 찾는 강서구 치과",
  },
  {
    eyebrow: "정밀 진단 시스템",
    title: (<>3D-CT &amp; 구강스캐너<br />컴퓨터 시뮬레이션 진단</>),
    desc: "눈으로 확인하고 결정하는 투명한 임플란트 상담",
  },
];

export default function HeroSlider() {
  const [current, setCurrent] = useState(0);
  const timerRef = useRef(null);

  const goTo = (index) => setCurrent(index);

  const restartTimer = () => {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCurrent((c) => (c + 1) % SLIDES.length);
    }, 5000);
  };

  useEffect(() => {
    restartTimer();
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <section className="hero" id="home">
      <div className="hero__slides">
        {SLIDES.map((slide, i) => (
          <div key={i} className={`hero__slide ${i === current ? "is-active" : ""}`}>
            <p className="hero__eyebrow">{slide.eyebrow}</p>
            <h1 className="hero__title">{slide.title}</h1>
            <p className="hero__desc">{slide.desc}</p>
          </div>
        ))}
      </div>

      <div className="hero__btns">
        <a href="#location" className="btn btn--primary">상담 예약하기</a>
        <a href="#treatments" className="btn btn--outline">진료과목 보기</a>
      </div>

      <div className="hero__dots">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            type="button"
            className={i === current ? "is-active" : ""}
            aria-label={`${i + 1}번째 배너로 이동`}
            onClick={() => {
              goTo(i);
              restartTimer();
            }}
          />
        ))}
      </div>
    </section>
  );
}
