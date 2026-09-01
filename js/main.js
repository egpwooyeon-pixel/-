// 벨르피부성형외과 - main.js

document.addEventListener("DOMContentLoaded", () => {
  const header = document.getElementById("header");
  const hamburger = document.getElementById("hamburger");
  const mobileMenu = document.getElementById("mobileMenu");

  // Header background on scroll
  const onScroll = () => {
    if (window.scrollY > 20) {
      header.classList.add("is-scrolled");
    } else {
      header.classList.remove("is-scrolled");
    }
  };
  onScroll();
  window.addEventListener("scroll", onScroll);

  // Mobile menu toggle
  hamburger.addEventListener("click", () => {
    mobileMenu.classList.toggle("is-open");
    hamburger.classList.toggle("is-open");
  });
  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => mobileMenu.classList.remove("is-open"));
  });

  // Scroll reveal animation
  const revealTargets = document.querySelectorAll(
    ".card, .t-card, .doc-card, .booking-form, .location__info"
  );
  revealTargets.forEach((el) => el.classList.add("reveal"));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  revealTargets.forEach((el) => observer.observe(el));

  // Booking form submit (placeholder - connect to real backend, email service, or 카카오톡 채널 API)
  const bookingForm = document.getElementById("bookingForm");
  const formNote = document.getElementById("formNote");

  bookingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = bookingForm.name.value.trim();
    const phone = bookingForm.phone.value.trim();

    if (!name || !phone) {
      formNote.textContent = "이름과 연락처를 입력해주세요.";
      return;
    }

    // TODO: 실제 서비스 시에는 이 부분을 서버 API, 이메일 전송 서비스,
    // 또는 카카오톡 채널 상담 연동으로 교체해야 합니다.
    formNote.textContent = `${name}님, 상담 신청이 접수되었습니다. 빠른 시일 내 연락드리겠습니다.`;
    bookingForm.reset();
  });
});
