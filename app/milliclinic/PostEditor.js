"use client";

import { useRef, useState } from "react";
import { marked } from "marked";

const TAG_OPTIONS = ["밀리클리닉", "오늘의 상담"];

function resizeImageToDataUrl(file, maxWidth = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export default function MilliPostEditor({ action, initialPost, errorMessage }) {
  const [content, setContent] = useState(initialPost?.content ?? "");
  const [image, setImage] = useState(initialPost?.image ?? "");
  const [preview, setPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const bodyImageInputRef = useRef(null);

  const insertAtCursor = (before, after = "") => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = content.slice(start, end);
    const next = content.slice(0, start) + before + selected + after + content.slice(end);
    setContent(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + before.length + selected.length + after.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  const handleImageChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 1200, 0.85);
      setImage(dataUrl);
    } finally {
      setUploading(false);
    }
  };

  const handleInsertBodyImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 1200, 0.8);
      insertAtCursor(`\n\n![이미지](${dataUrl})\n\n`);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  return (
    <form className="editor-form" action={action}>
      {errorMessage && <div className="editor-error">{errorMessage}</div>}

      <div className="row2">
        <label>
          제목
          <input type="text" name="title" defaultValue={initialPost?.title} placeholder="글 제목을 입력하세요" required />
        </label>
        <label>
          카드 태그
          <input
            type="text"
            name="tag"
            list="milli-tag-options"
            defaultValue={initialPost?.tag ?? "밀리클리닉"}
            placeholder="예: 밀리클리닉"
          />
          <datalist id="milli-tag-options">
            {TAG_OPTIONS.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
      </div>

      <div className="row2">
        <label>
          슬러그 (URL, 영문 소문자·숫자·하이픈)
          <input
            type="text"
            name="slug"
            defaultValue={initialPost?.slug}
            placeholder={initialPost ? initialPost.slug : "비워두면 제목에서 자동 생성"}
          />
        </label>
        <label>
          작성자
          <input type="text" name="author" defaultValue={initialPost?.author ?? "admin"} />
        </label>
      </div>

      <label>
        공개 여부
        <select name="published" defaultValue={initialPost?.published === false ? "off" : "on"}>
          <option value="on">발행 (공개)</option>
          <option value="off">비공개 (임시저장)</option>
        </select>
      </label>

      <label>
        카드 헤드라인 (썸네일 위 굵은 문구, 줄바꿈으로 두 줄까지)
        <textarea
          name="headline"
          rows={2}
          defaultValue={initialPost?.headline}
          placeholder={"정품 · 정량\n시술"}
        />
      </label>

      <label>
        요약 (목록 카드에 보여질 짧은 설명, 비워두면 제목 사용)
        <textarea name="excerpt" rows={2} defaultValue={initialPost?.excerpt} placeholder="목록 카드에 표시될 요약 문구" />
      </label>

      <label>
        대표 이미지 (카드 썸네일 · 상세페이지 대표 이미지)
        <div className="editor-toolbar">
          <button type="button" onClick={() => imageInputRef.current?.click()}>
            {uploading ? "처리중..." : "이미지 선택"}
          </button>
          {image && (
            <button type="button" onClick={() => setImage("")}>이미지 제거</button>
          )}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageChange}
          />
        </div>
        {image && (
          <div className="editor-thumb-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="대표 이미지 미리보기" />
          </div>
        )}
        <input type="hidden" name="image" value={image} />
      </label>

      <label>
        본문 (마크다운, 상세페이지에 표시됩니다)
        <div className="editor-toolbar">
          <button type="button" onClick={() => insertAtCursor("**", "**")}>굵게</button>
          <button type="button" onClick={() => insertAtCursor("*", "*")}>기울임</button>
          <button type="button" onClick={() => insertAtCursor("\n## ")}>소제목</button>
          <button type="button" onClick={() => insertAtCursor("[", "](https://)")}>링크</button>
          <button type="button" onClick={() => insertAtCursor("\n- ")}>목록</button>
          <button type="button" onClick={() => bodyImageInputRef.current?.click()}>
            {uploading ? "처리중..." : "본문에 이미지 삽입"}
          </button>
          <button type="button" onClick={() => setPreview((v) => !v)}>
            {preview ? "편집으로 돌아가기" : "미리보기"}
          </button>
          <input
            ref={bodyImageInputRef}
            type="file"
            accept="image/*"
            onChange={handleInsertBodyImage}
          />
        </div>

        {preview ? (
          <div
            className="post-body"
            style={{ border: "1px solid var(--color-line)", borderRadius: 10, padding: 20, minHeight: 260 }}
            dangerouslySetInnerHTML={{ __html: marked.parse(content || "*(내용 없음)*") }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            name="content"
            rows={16}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="마크다운으로 작성하세요. 예: **굵게**, ## 소제목, ![이미지](...)"
            required
          />
        )}
      </label>

      <div className="editor-actions">
        <button type="submit" className="btn btn--primary">저장하기</button>
      </div>
    </form>
  );
}
