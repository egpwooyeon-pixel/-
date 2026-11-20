function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

async function loadSettings() {
  const { blogApiKey, blogModel, blogStoreName, blogStoreArea, blogStoreCategory, blogSignatureMenu } =
    await chrome.storage.local.get([
      "blogApiKey",
      "blogModel",
      "blogStoreName",
      "blogStoreArea",
      "blogStoreCategory",
      "blogSignatureMenu",
    ]);
  document.getElementById("apiKeyInput").value = blogApiKey || "";
  document.getElementById("modelSelect").value = blogModel || "gemini-3.8-flash";
  document.getElementById("storeNameInput").value = blogStoreName || "";
  document.getElementById("storeAreaInput").value = blogStoreArea || "";
  document.getElementById("storeCategoryInput").value = blogStoreCategory || "";
  document.getElementById("signatureMenuInput").value = blogSignatureMenu || "";
}

async function saveApiKey() {
  await chrome.storage.local.set({
    blogApiKey: document.getElementById("apiKeyInput").value.trim(),
    blogModel: document.getElementById("modelSelect").value,
  });
  setStatus("API 설정을 저장했습니다.");
}

// Populated by handleLoadCollected with the raw collected review
// objects (photoUrls included) — the textarea only ever holds
// flattened one-line-per-review text, which has nowhere to carry
// photo data, so photo placement reads from this instead.
let lastLoadedReviews = [];

async function handleLoadCollected() {
  const { placeReviews } = await chrome.storage.local.get("placeReviews");
  const reviews = Array.isArray(placeReviews) ? placeReviews : [];
  const statusEl = document.getElementById("loadCollectedStatus");
  if (reviews.length === 0) {
    statusEl.textContent = "수집된 플레이스 리뷰가 없습니다 — 먼저 확장프로그램 팝업에서 리뷰 수집을 실행하세요.";
    return;
  }
  lastLoadedReviews = reviews;
  // Each review's body may itself contain line breaks (from the
  // page's own <br> tags) — flatten those to spaces so the one-
  // review-per-line convention the textarea/parseReviewsInput rely on
  // still holds after this prefill.
  const lines = reviews
    .filter((r) => r.body && r.body.trim())
    .map((r) => {
      const flatBody = r.body.replace(/\s*\n\s*/g, " ").trim();
      const ratingPart = r.rating ? `[${r.rating}점] ` : "";
      const tagPart = r.keywordTags ? ` (키워드: ${r.keywordTags})` : "";
      return `${ratingPart}${flatBody}${tagPart}`;
    });
  document.getElementById("reviewsInput").value = lines.join("\n");
  const photoCount = reviews.reduce((sum, r) => sum + (Array.isArray(r.photoUrls) ? r.photoUrls.length : 0), 0);
  statusEl.textContent = `${lines.length}건을 불러왔습니다 (사진 ${photoCount}장 포함) — 필요하면 직접 수정/삭제 후 생성하세요.`;
}

function sanitizeForFilename(s) {
  return (s || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

// Picks `targetCount` photos spread across as many different reviews
// as possible (round 0 = one photo from each review, round 1 = a
// second photo from each review that still has one, and so on) rather
// than just taking the first N in storage order, which could end up
// being every photo from a single long review. Reviews with longer
// bodies go first within each round since they give the AI more to
// ground a caption in.
function selectPhotoSlots(reviews, targetCount) {
  const byReview = [];
  reviews.forEach((r, reviewIndex) => {
    const urls = Array.isArray(r.photoUrls) ? r.photoUrls : [];
    if (urls.length === 0) return;
    byReview.push({
      reviewIndex,
      nickname: r.nickname,
      body: r.body,
      rating: r.rating,
      keywordTags: r.keywordTags,
      placeName: r.placeName,
      urls,
    });
  });
  byReview.sort((a, b) => (b.body || "").length - (a.body || "").length);

  const selected = [];
  let round = 0;
  while (selected.length < targetCount) {
    let addedThisRound = false;
    for (const group of byReview) {
      if (group.urls[round]) {
        selected.push({
          url: group.urls[round],
          reviewIndex: group.reviewIndex,
          photoIndex: round,
          nickname: group.nickname,
          body: group.body,
          rating: group.rating,
          keywordTags: group.keywordTags,
          placeName: group.placeName,
        });
        addedThisRound = true;
        if (selected.length >= targetCount) break;
      }
    }
    if (!addedThisRound) break;
    round++;
  }
  return selected;
}

function photoSlotExt(slot) {
  const extMatch = slot.url.match(/\.(jpg|jpeg|png|webp|gif)(?:[?&]|$)/i);
  return extMatch ? extMatch[1].toLowerCase() : "jpg";
}

// Matches startPlacePhotoDownload's naming in background.js, so a file
// a user already has from "리뷰 사진 전체 다운로드" and one that comes
// out of the ZIP below share the same basename.
function photoSlotBasename(slot) {
  return `${String(slot.reviewIndex + 1).padStart(3, "0")}_${sanitizeForFilename(slot.nickname) || "익명"}_${
    slot.photoIndex + 1
  }.${photoSlotExt(slot)}`;
}

function photoSlotFilename(slot) {
  const folder = sanitizeForFilename(slot.placeName) || "플레이스";
  return `네이버플레이스사진/${folder}/${photoSlotBasename(slot)}`;
}

function parseReviewsInput() {
  const raw = document.getElementById("reviewsInput").value || "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function renderChips(containerId, items, className) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!items || items.length === 0) {
    container.innerHTML = '<span style="color:#9ca3af;font-size:12px;">없음</span>';
    return;
  }
  items.forEach((text) => {
    const span = document.createElement("span");
    span.className = `chip ${className}`;
    span.textContent = text;
    container.appendChild(span);
  });
}

// Holds the most recent generation result so renderPreview() can pull
// photoSlots/photoCaptions back out after the user edits draftOutput
// by hand (the textarea only ever holds plain text with [사진 삽입: N]
// markers — it has nowhere to carry which photo each N refers to).
let lastResult = null;

function renderTitles(titles) {
  const container = document.getElementById("titlesList");
  container.innerHTML = "";
  if (!titles || titles.length === 0) {
    container.innerHTML = '<span style="color:#9ca3af;font-size:12px;">없음</span>';
    return;
  }
  titles.forEach((title) => {
    const row = document.createElement("div");
    row.className = "title-option";
    const span = document.createElement("span");
    span.textContent = title;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "복사";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(title);
        setStatus("제목을 복사했습니다.");
      } catch (err) {
        setStatus("복사에 실패했습니다 — 직접 선택해서 복사하세요.", true);
      }
    });
    row.appendChild(span);
    row.appendChild(btn);
    container.appendChild(row);
  });
}

async function handleCopyHashtags() {
  const hashtags = (lastResult && lastResult.hashtags) || [];
  if (hashtags.length === 0) {
    setStatus("해시태그가 없습니다.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(hashtags.join(" "));
    setStatus("해시태그를 복사했습니다.");
  } catch (err) {
    setStatus("복사에 실패했습니다 — 직접 선택해서 복사하세요.", true);
  }
}

function renderResult(result) {
  lastResult = result;
  document.getElementById("resultCard").classList.remove("hidden");
  renderTitles(result.titles);
  renderChips("requiredKeywords", result.requiredKeywords, "required");
  renderChips("goodKeywords", result.goodKeywords, "good");
  renderChips("signatureMenuOut", result.signatureMenu, "menu");
  renderChips("hashtagsOut", result.hashtags, "hashtag");
  document.getElementById("draftOutput").value = result.draft || "";

  const photoSection = document.getElementById("photoGuideSection");
  const photoSlots = Array.isArray(result.photoSlots) ? result.photoSlots : [];
  if (photoSlots.length > 0) {
    photoSection.classList.remove("hidden");
    const list = document.getElementById("photoGuideList");
    list.innerHTML = "";
    photoSlots.forEach((slot, i) => {
      const caption = (result.photoCaptions && result.photoCaptions[i]) || "";
      const row = document.createElement("div");
      row.className = "photo-guide-item";
      row.innerHTML = `
        <span class="num">#${i + 1}</span>
        <img src="${slot.url}" alt="사진 ${i + 1}" loading="lazy" />
        <div>
          <div class="caption">${caption ? caption.replace(/</g, "&lt;") : "(설명 없음)"}</div>
          <div class="meta">${photoSlotFilename(slot).replace(/</g, "&lt;")}</div>
        </div>
      `;
      list.appendChild(row);
    });
  } else {
    photoSection.classList.add("hidden");
  }

  if (result.parseFailed) {
    setStatus("AI 응답을 정해진 형식으로 해석하지 못해 원문 그대로 표시합니다 — 키워드 분류는 비어 있습니다.", true);
  }

  renderPreview();
}

// Rebuilds the "블로그용 미리보기" block from whatever is currently in
// draftOutput (so manual edits are reflected) plus the photo slots/
// captions from the last generation. "[사진 삽입: N]" markers become a
// real <figure><img>+caption> in place — this is what makes the
// preview copy-paste as text-and-images together into a rich text
// editor like Naver Blog's, rather than just plain text with bracket
// placeholders.
function buildPreviewNode(draftText, photoSlots, photoCaptions, hashtags) {
  const container = document.createElement("div");
  const markerPattern = /\[사진\s*삽입\s*:\s*(\d+)\]/g;

  const appendTextBlock = (text) => {
    text.split(/\n+/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const p = document.createElement("p");
      p.textContent = trimmed;
      container.appendChild(p);
    });
  };

  let lastIndex = 0;
  let match;
  while ((match = markerPattern.exec(draftText))) {
    appendTextBlock(draftText.slice(lastIndex, match.index));
    const num = parseInt(match[1], 10);
    const slot = photoSlots[num - 1];
    if (slot) {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = slot.url;
      img.alt = `사진 ${num}`;
      figure.appendChild(img);
      const caption = photoCaptions[num - 1];
      if (caption) {
        const figcaption = document.createElement("figcaption");
        figcaption.textContent = caption;
        figure.appendChild(figcaption);
      }
      container.appendChild(figure);
    }
    lastIndex = markerPattern.lastIndex;
  }
  appendTextBlock(draftText.slice(lastIndex));

  if (hashtags && hashtags.length > 0) {
    const p = document.createElement("p");
    p.style.color = "#5b21b6";
    p.textContent = hashtags.join(" ");
    container.appendChild(p);
  }

  return container;
}

function renderPreview() {
  const draftText = document.getElementById("draftOutput").value || "";
  if (!draftText.trim()) {
    document.getElementById("previewCard").classList.add("hidden");
    return;
  }
  const photoSlots = lastResult && Array.isArray(lastResult.photoSlots) ? lastResult.photoSlots : [];
  const photoCaptions = lastResult && Array.isArray(lastResult.photoCaptions) ? lastResult.photoCaptions : [];
  const hashtags = lastResult && Array.isArray(lastResult.hashtags) ? lastResult.hashtags : [];
  const node = buildPreviewNode(draftText, photoSlots, photoCaptions, hashtags);
  const container = document.getElementById("blogPreview");
  container.innerHTML = "";
  container.appendChild(node);
  document.getElementById("previewCard").classList.remove("hidden");
}

function handleSelectPreview() {
  const el = document.getElementById("blogPreview");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  setStatus("전체 선택했습니다 — 이제 Ctrl+C(맥: Cmd+C)로 복사한 뒤 블로그 글쓰기 화면에 Ctrl+V로 붙여넣으세요.");
}

async function handleGenerate() {
  const storeName = document.getElementById("storeNameInput").value.trim();
  const storeArea = document.getElementById("storeAreaInput").value.trim();
  const storeCategory = document.getElementById("storeCategoryInput").value.trim();
  const signatureMenuHint = document.getElementById("signatureMenuInput").value.trim();
  const apiKey = document.getElementById("apiKeyInput").value.trim();
  const model = document.getElementById("modelSelect").value;
  const reviews = parseReviewsInput();

  if (!apiKey) {
    setStatus("먼저 Gemini API 키를 입력하고 저장하세요.", true);
    return;
  }
  if (!storeName) {
    setStatus("상호명을 입력하세요.", true);
    return;
  }
  if (reviews.length === 0) {
    setStatus("리뷰를 한 줄에 하나씩 붙여넣으세요.", true);
    return;
  }

  let photoSlots = [];
  if (document.getElementById("includePhotosCheckbox").checked) {
    const targetCount = Math.max(1, parseInt(document.getElementById("photoCountInput").value, 10) || 15);
    if (lastLoadedReviews.length === 0) {
      setStatus('사진을 쓰려면 먼저 "수집한 플레이스 리뷰 불러오기"로 리뷰를 불러오세요 (직접 붙여넣은 텍스트에는 사진 정보가 없습니다).', true);
      return;
    }
    photoSlots = selectPhotoSlots(lastLoadedReviews, targetCount);
    if (photoSlots.length === 0) {
      setStatus("불러온 리뷰에 사진이 없습니다. 체크를 해제하고 다시 시도하세요.", true);
      return;
    }
  }

  await chrome.storage.local.set({
    blogApiKey: apiKey,
    blogModel: model,
    blogStoreName: storeName,
    blogStoreArea: storeArea,
    blogStoreCategory: storeCategory,
    blogSignatureMenu: signatureMenuHint,
  });

  const generateBtn = document.getElementById("generateBtn");
  generateBtn.disabled = true;
  setStatus(
    photoSlots.length > 0
      ? `AI가 리뷰 ${reviews.length}건 + 사진 ${photoSlots.length}장을 분석해 원고를 만드는 중입니다...`
      : `AI가 리뷰 ${reviews.length}건을 분석해 원고를 만드는 중입니다...`
  );

  const response = await chrome.runtime.sendMessage({
    type: "GENERATE_BLOG_DRAFT",
    storeName,
    storeArea,
    storeCategory,
    signatureMenuHint,
    reviews,
    apiKey,
    model,
    photoSlots,
  });

  generateBtn.disabled = false;

  if (!response || !response.ok) {
    const reason = response && response.reason;
    if (reason === "already_running") {
      setStatus("이미 생성 중입니다. 잠시 후 다시 시도하세요.", true);
    } else if (reason === "no_api_key") {
      setStatus("API 키가 필요합니다.", true);
    } else if (reason === "no_reviews") {
      setStatus("리뷰를 입력하세요.", true);
    } else {
      setStatus(`생성 실패: ${(response && response.error) || "알 수 없는 오류"}`, true);
    }
    return;
  }

  setStatus("완료되었습니다. 발행 전 내용을 꼭 직접 검토하세요.");
  renderResult(response.result);
}

async function handleCopyDraft() {
  const text = document.getElementById("draftOutput").value;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("클립보드에 복사했습니다.");
  } catch (err) {
    setStatus("클립보드 복사에 실패했습니다 — 직접 선택해서 복사하세요.", true);
  }
}

// Builds one zip containing 블로그원고.txt (the draft, with each
// "[사진 삽입: N]" marker rewritten in place to name the exact photo
// file it refers to — so reading the txt next to the extracted photos
// is enough, no separate guide needed) plus every referenced photo
// under that same filename. Runs entirely in this tab (not the
// background service worker) since, unlike the earlier per-photo
// downloader, there's nothing here that needs to survive the popup
// closing — this page stays open for as long as the zip takes to
// build.
async function handleDownloadZip() {
  const draftText = document.getElementById("draftOutput").value || "";
  if (!draftText.trim()) {
    setStatus("먼저 원고를 생성하세요.", true);
    return;
  }

  const photoSlots = lastResult && Array.isArray(lastResult.photoSlots) ? lastResult.photoSlots : [];
  const photoCaptions = lastResult && Array.isArray(lastResult.photoCaptions) ? lastResult.photoCaptions : [];
  const titles = lastResult && Array.isArray(lastResult.titles) ? lastResult.titles : [];
  const hashtags = lastResult && Array.isArray(lastResult.hashtags) ? lastResult.hashtags : [];
  const storeName = document.getElementById("storeNameInput").value.trim();
  const statusEl = document.getElementById("downloadZipStatus");
  const btn = document.getElementById("downloadZipBtn");

  btn.disabled = true;
  statusEl.textContent = photoSlots.length > 0 ? `사진 ${photoSlots.length}장 내려받는 중...` : "압축 파일 만드는 중...";

  try {
    const zip = new JSZip();

    const bodyWithPhotoNames = draftText.replace(/\[사진\s*삽입\s*:\s*(\d+)\]/g, (whole, numStr) => {
      const num = parseInt(numStr, 10);
      const slot = photoSlots[num - 1];
      if (!slot) return whole;
      const caption = photoCaptions[num - 1];
      return `[사진: ${photoSlotBasename(slot)}${caption ? ` — ${caption}` : ""}]`;
    });

    const titleBlock = titles.length > 0 ? `[제목 추천]\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n` : "";
    const hashtagBlock = hashtags.length > 0 ? `\n\n${hashtags.join(" ")}` : "";
    const txtBody = `${titleBlock}${bodyWithPhotoNames}${hashtagBlock}`;
    zip.file("블로그원고.txt", "﻿" + txtBody);

    let failed = 0;
    for (let i = 0; i < photoSlots.length; i++) {
      const slot = photoSlots[i];
      try {
        const res = await fetch(slot.url);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        zip.file(photoSlotBasename(slot), blob);
      } catch (err) {
        failed++;
      }
      statusEl.textContent = `사진 내려받는 중... (${i + 1} / ${photoSlots.length}${failed ? `, 실패 ${failed}` : ""})`;
    }

    statusEl.textContent = "압축 파일 만드는 중...";
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const dateStr = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const zipFilename = `${sanitizeForFilename(storeName) || "블로그원고"}_${dateStr}.zip`;

    await chrome.downloads.download({ url, filename: zipFilename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    statusEl.textContent =
      failed > 0
        ? `ZIP 다운로드를 시작했습니다 (사진 ${photoSlots.length - failed}/${photoSlots.length}장 포함, ${failed}장은 가져오지 못했습니다).`
        : photoSlots.length > 0
        ? `ZIP 다운로드를 시작했습니다 (사진 ${photoSlots.length}장 포함).`
        : "ZIP 다운로드를 시작했습니다 (원고 텍스트만 포함 — 사진 옵션을 쓰지 않았습니다).";
  } catch (err) {
    statusEl.textContent = `ZIP 생성 실패: ${(err && err.message) || "알 수 없는 오류"}`;
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  document.getElementById("saveApiKeyBtn").addEventListener("click", saveApiKey);
  document.getElementById("loadCollectedBtn").addEventListener("click", handleLoadCollected);
  document.getElementById("generateBtn").addEventListener("click", handleGenerate);
  document.getElementById("copyDraftBtn").addEventListener("click", handleCopyDraft);
  document.getElementById("downloadZipBtn").addEventListener("click", handleDownloadZip);
  document.getElementById("copyHashtagsBtn").addEventListener("click", handleCopyHashtags);
  document.getElementById("includePhotosCheckbox").addEventListener("change", (e) => {
    document.getElementById("photoCountRow").style.display = e.target.checked ? "flex" : "none";
  });
  document.getElementById("refreshPreviewBtn").addEventListener("click", renderPreview);
  document.getElementById("selectPreviewBtn").addEventListener("click", handleSelectPreview);
});
