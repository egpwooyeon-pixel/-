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

async function handleLoadCollected() {
  const { placeReviews } = await chrome.storage.local.get("placeReviews");
  const reviews = Array.isArray(placeReviews) ? placeReviews : [];
  const statusEl = document.getElementById("loadCollectedStatus");
  if (reviews.length === 0) {
    statusEl.textContent = "수집된 플레이스 리뷰가 없습니다 — 먼저 확장프로그램 팝업에서 리뷰 수집을 실행하세요.";
    return;
  }
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
  statusEl.textContent = `${lines.length}건을 불러왔습니다 — 필요하면 직접 수정/삭제 후 생성하세요.`;
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
  setStatus(`AI가 리뷰 ${reviews.length}건을 분석해 원고를 만드는 중입니다...`);

  const response = await chrome.runtime.sendMessage({
    type: "GENERATE_BLOG_DRAFT",
    storeName,
    storeArea,
    storeCategory,
    signatureMenuHint,
    reviews,
    apiKey,
    model,
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
});
