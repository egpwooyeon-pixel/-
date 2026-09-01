import Header from "./components/Header";
import Footer from "./components/Footer";
import Floating from "./components/Floating";
import HeroSlider from "./components/HeroSlider";
import Reveal from "./components/Reveal";
import BookingForm from "./components/BookingForm";

const ABOUT_CARDS = [
  {
    title: "대표원장 매일 진료",
    desc: (<>연중 대표원장이 직접<br />상담·진단·시술을 진행합니다.</>),
    icon: (
      <svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="2" /><path d="M15 25l6 6 12-14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    ),
  },
  {
    title: "3D-CT · 구강스캐너",
    desc: (<>정밀 진단 장비와 컴퓨터<br />시뮬레이션으로 안전한 계획 수립.</>),
    icon: (
      <svg viewBox="0 0 48 48" fill="none"><rect x="8" y="10" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="2" /><path d="M8 18h32" stroke="currentColor" strokeWidth="2" /><path d="M16 26h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
    ),
  },
  {
    title: "임플란트 전문",
    desc: (<>수면·전체·당일·재수술 등<br />세분화된 맞춤 임플란트 시스템.</>),
    icon: (
      <svg viewBox="0 0 48 48" fill="none"><path d="M24 4v6M24 38v6M4 24h6M38 24h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="24" cy="24" r="11" stroke="currentColor" strokeWidth="2" /></svg>
    ),
  },
  {
    title: "외국인환자 등록기관",
    desc: (<>KOR·ENG·JPN·MNG·VNM<br />다국어 진료 지원.</>),
    icon: (
      <svg viewBox="0 0 48 48" fill="none"><path d="M24 6c8 6 15 9 15 18 0 9-7 16-15 18-8-2-15-9-15-18 0-9 7-12 15-18z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
    ),
  },
];

const TREATMENTS = [
  { tag: "임플란트", title: "수면 · 전체 임플란트", desc: (<>두려움 없는 수면 임플란트와<br />전체 임플란트 정밀 시술</>) },
  { tag: "임플란트", title: "당일 · 재수술 임플란트", desc: (<>빠른 당일 임플란트와<br />실패 사례 재수술 클리닉</>) },
  { tag: "임플란트", title: "뼈이식 · 상악동거상술", desc: (<>골량이 부족한 경우를 위한<br />뼈이식 및 상악동거상술</>) },
  { tag: "임플란트", title: "건강보험 임플란트 · 틀니", desc: (<>만 65세 이상 대상<br />건강보험 임플란트 &amp; 틀니 안내</>) },
  { tag: "일반진료", title: "보존 · 보철 · 신경치료", desc: (<>충치 치료부터 크라운, 신경치료까지<br />기본 진료 전 과정</>) },
  { tag: "치아성형/사랑니", title: "치아성형 &amp; 사랑니발치", desc: (<>심미적인 치아 라인 교정과<br />안전한 사랑니 발치</>) },
];

const DOCTOR_LIST = [
  "연세대학교 치과대학 졸업",
  "통합치의학과 전문의",
  "대한통합치과학회 이사",
  "대한치과이식임플란트학회 이사",
  "오스템임플란트 마스터코스 디렉터",
  "ATC임플란트연구회(A.T.C) 코어멤버",
  "국내외 임플란트 실황수술 중계 연자",
  "유튜브 채널 '임플란트 요정현준' 운영",
];

const REVIEWS = [
  { text: `"수면 임플란트라 무섭지 않게 치료받았어요. 원장님이 꼼꼼하게 설명해주셔서 믿음이 갔습니다."`, meta: "임플란트 상담 후기 (샘플)" },
  { text: `"외국인 친구와 함께 방문했는데 영어 안내가 잘 되어 있어서 편하게 진료받을 수 있었어요."`, meta: "외국인 환자 진료 후기 (샘플)" },
  { text: `"3D-CT로 미리 시뮬레이션을 보여주셔서 시술 전에 결과를 예상할 수 있어 좋았습니다."`, meta: "정밀진단 후기 (샘플)" },
];

export default function HomePage() {
  return (
    <>
      <Header />
      <HeroSlider />

      <section className="about" id="about">
        <div className="container">
          <p className="section__eyebrow">ABOUT US</p>
          <h2 className="section__title">연세힐치과병원을 선택해야 하는 이유</h2>
          <p className="section__desc">
            강서구 우장산역 한자리에서 11년,<br className="only-desktop" />대표원장이 직접 진단부터 시술까지 책임집니다.
          </p>

          <div className="grid grid--4 about__grid">
            {ABOUT_CARDS.map((c) => (
              <Reveal key={c.title} className="card">
                <div className="card__icon">{c.icon}</div>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="treatments" id="treatments">
        <div className="container">
          <p className="section__eyebrow">TREATMENTS</p>
          <h2 className="section__title">진료과목 안내</h2>
          <p className="section__desc">
            임플란트부터 일반진료, 치아성형, 사랑니발치까지<br className="only-desktop" />한 곳에서 해결하세요.
          </p>

          <div className="grid grid--3 treatments__grid">
            {TREATMENTS.map((t) => (
              <Reveal key={t.title} className="t-card">
                <span className="t-card__tag">{t.tag}</span>
                <h3>{t.title}</h3>
                <p>{t.desc}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="doctors" id="doctors">
        <div className="container">
          <p className="section__eyebrow">MEDICAL TEAM</p>
          <h2 className="section__title">의료진 소개</h2>
          <p className="section__desc">
            임플란트 전문 대표원장이<br className="only-desktop" />직접 상담하고 진료합니다.
          </p>

          <Reveal className="doctor-card">
            <div className="doctor-card__photo" aria-hidden="true"></div>
            <div className="doctor-card__body">
              <h3>정현준 대표원장</h3>
              <p className="doctor-card__role">통합치의학과 전문의 · 임플란트 전문</p>
              <ul className="doctor-card__list">
                {DOCTOR_LIST.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="gallery" id="gallery">
        <div className="container">
          <p className="section__eyebrow">BEFORE &amp; AFTER / REVIEW</p>
          <h2 className="section__title">전후사진 &amp; 진료 후기</h2>
          <p className="section__desc">
            실제 후기 및 전후사진은 병원 상담 시<br className="only-desktop" />더 자세히 안내해드립니다. (샘플 레이아웃)
          </p>

          <div className="grid grid--3 review__grid">
            {REVIEWS.map((r) => (
              <Reveal key={r.meta} className="review-card">
                <div className="review-card__stars">★★★★★</div>
                <p>{r.text}</p>
                <span className="review-card__meta">{r.meta}</span>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="location" id="location">
        <div className="container">
          <p className="section__eyebrow">LOCATION &amp; BOOKING</p>
          <h2 className="section__title">오시는 길 &amp; 상담 예약</h2>

          <div className="location__grid">
            <Reveal className="location__info">
              <div className="map-placeholder">
                <span>지도 영역 (지도 API 연동 위치)</span>
              </div>

              <div className="info-block">
                <h4>주소</h4>
                <p>서울특별시 강서구 강서로 231, 우장산해링턴타워 1·2층 (지하철 5호선 우장산역 인근)</p>
              </div>
              <div className="info-block">
                <h4>진료시간</h4>
                <table className="hours">
                  <tbody>
                    <tr><th>월 · 금</th><td>10:00 - 19:00</td></tr>
                    <tr><th>화 · 수 · 목</th><td>10:00 - 21:00</td></tr>
                    <tr><th>토 · 일</th><td>09:00 - 14:00</td></tr>
                    <tr><th>공휴일</th><td>휴진</td></tr>
                  </tbody>
                </table>
                <p className="hours__note">※ 방문 전 전화로 진료시간 확인을 권장합니다.</p>
              </div>
              <div className="info-block">
                <h4>대표전화</h4>
                <p className="tel">02-2697-2875</p>
                <p>이메일 healdentalclinic@gmail.com</p>
              </div>
            </Reveal>

            <Reveal>
              <BookingForm />
            </Reveal>
          </div>
        </div>
      </section>

      <Footer />
      <Floating />
    </>
  );
}
