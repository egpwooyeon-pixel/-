export default function Floating() {
  return (
    <div className="floating">
      <a href="tel:0226972875" className="floating__btn floating__btn--kakao" aria-label="카톡상담">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 4h16v12H7l-3 3V4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
        <span>카톡상담</span>
      </a>
      <a href="tel:0226972875" className="floating__btn floating__btn--call" aria-label="전화상담">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.9 21 3 13.1 3 3.9c0-.6.4-1 1-1H7.4c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z" fill="currentColor" /></svg>
        <span>전화상담</span>
      </a>
    </div>
  );
}
