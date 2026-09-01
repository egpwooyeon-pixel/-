// 연세힐치과병원 (HEAL DENTAL HOSPITAL) - main.js

document.addEventListener("DOMContentLoaded", () => {
  const hamburger = document.getElementById("hamburger");
  const mobileMenu = document.getElementById("mobileMenu");

  // Mobile menu toggle
  hamburger.addEventListener("click", () => {
    mobileMenu.classList.toggle("is-open");
    hamburger.classList.toggle("is-open");
  });
  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => mobileMenu.classList.remove("is-open"));
  });

  // Hero slider
  const slides = Array.from(document.querySelectorAll(".hero__slide"));
  const dotsWrap = document.getElementById("heroDots");
  let current = slides.findIndex((s) => s.classList.contains("is-active"));
  if (current < 0) current = 0;

  slides.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.setAttribute("aria-label", `${i + 1}번째 배너로 이동`);
    if (i === current) dot.classList.add("is-active");
    dot.addEventListener("click", () => goToSlide(i));
    dotsWrap.appendChild(dot);
  });

  function goToSlide(index) {
    slides[current].classList.remove("is-active");
    dotsWrap.children[current].classList.remove("is-active");
    current = index;
    slides[current].classList.add("is-active");
    dotsWrap.children[current].classList.add("is-active");
  }

  let sliderTimer = setInterval(() => {
    goToSlide((current + 1) % slides.length);
  }, 5000);

  dotsWrap.addEventListener("click", () => {
    clearInterval(sliderTimer);
    sliderTimer = setInterval(() => {
      goToSlide((current + 1) % slides.length);
    }, 5000);
  });

  // Scroll reveal animation
  const revealTargets = document.querySelectorAll(
    ".card, .t-card, .doctor-card, .review-card, .booking-form, .location__info"
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
