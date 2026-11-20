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

function photoSlotFilename(slot) {
  const folder = sanitizeForFilename(slot.placeName) || "플레이스";
  const extMatch = slot.url.match(/\.(jpg|jpeg|png|webp|gif)(?:[?&]|$)/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
  return `네이버플레이스사진/${folder}/${String(slot.reviewIndex + 1).padStart(3, "0")}_${
    sanitizeForFilename(slot.nickname) || "익명"
  }_${slot.photoIndex + 1}.${ext}`;
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

function renderResult(result) {
  document.getElementById("resultCard").classList.remove("hidden");
  renderChips("requiredKeywords", result.requiredKeywords, "required");
  renderChips("goodKeywords", result.goodKeywords, "good");
  renderChips("signatureMenuOut", result.signatureMenu, "menu");
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

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  document.getElementById("saveApiKeyBtn").addEventListener("click", saveApiKey);
  document.getElementById("loadCollectedBtn").addEventListener("click", handleLoadCollected);
  document.getElementById("generateBtn").addEventListener("click", handleGenerate);
  document.getElementById("copyDraftBtn").addEventListener("click", handleCopyDraft);
  document.getElementById("includePhotosCheckbox").addEventListener("change", (e) => {
    document.getElementById("photoCountRow").style.display = e.target.checked ? "flex" : "none";
  });
});
