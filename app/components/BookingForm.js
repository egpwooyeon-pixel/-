"use client";

import { useState } from "react";

export default function BookingForm() {
  const [note, setNote] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();

    if (!name || !phone) {
      setNote("이름과 연락처를 입력해주세요.");
      return;
    }

    // TODO: 실제 서비스 시에는 이 부분을 서버 API, 이메일 전송 서비스,
    // 또는 카카오톡 채널 상담 연동으로 교체해야 합니다.
    setNote(`${name}님, 상담 신청이 접수되었습니다. 빠른 시일 내 연락드리겠습니다.`);
    form.reset();
  };

  return (
    <form className="booking-form" onSubmit={handleSubmit}>
      <h3>온라인 상담 신청</h3>
      <p className="booking-form__desc">
        이름과 연락처를 남겨주시면 담당 상담실장이<br />빠르게 연락드립니다.
      </p>

      <label>
        이름
        <input type="text" name="name" placeholder="이름을 입력해주세요" required />
      </label>
      <label>
        연락처
        <input type="tel" name="phone" placeholder="010-0000-0000" required />
      </label>
      <label>
        관심 진료과목
        <select name="topic" defaultValue="임플란트 (수면/전체/당일/재수술 등)">
          <option>임플란트 (수면/전체/당일/재수술 등)</option>
          <option>일반진료 (보존/보철/신경치료)</option>
          <option>치아성형</option>
          <option>사랑니발치</option>
          <option>기타 문의</option>
        </select>
      </label>
      <label>
        문의 내용
        <textarea name="message" rows={4} placeholder="궁금하신 점을 남겨주세요 (선택)" />
      </label>

      <label className="checkbox">
        <input type="checkbox" name="agree" required />
        개인정보 수집 및 이용에 동의합니다.
      </label>

      <button type="submit" className="btn btn--primary btn--block">상담 신청하기</button>
      <p className="booking-form__note">{note}</p>
    </form>
  );
}
