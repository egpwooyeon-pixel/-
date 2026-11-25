function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

async function loadSettings() {
  const { blogApiKey, blogModel, blogStoreName, blogStoreArea, blogStoreCategory, blogSignatureMenu, blogCustomInstructions } =
    await chrome.storage.local.get([
      "blogApiKey",
      "blogModel",
      "blogStoreName",
      "blogStoreArea",
      "blogStoreCategory",
      "blogSignatureMenu",
      "blogCustomInstructions",
    ]);
  document.getElementById("apiKeyInput").value = blogApiKey || "";
  document.getElementById("modelSelect").value = blogModel || "gemini-3.8-flash";
  document.getElementById("storeNameInput").value = blogStoreName || "";
  document.getElementById("storeAreaInput").value = blogStoreArea || "";
  document.getElementById("storeCategoryInput").value = blogStoreCategory || "";
  document.getElementById("signatureMenuInput").value = blogSignatureMenu || "";
  document.getElementById("customInstructionsInput").value = blogCustomInstructions || "";
}

// Very rough keyword extraction for soft-filtering which reviews'
// photos get used by a free-text instruction like "흰색 제품 사진만
// 써줘". No NLP available here, so this just strips common Korean
// particles/request-verb endings off whitespace-split tokens and
// keeps whatever's left that's 2+ characters — good enough to catch
// the color/option-style keywords this is mainly meant for (Smart
// Store reviews commonly carry "색상: 화이트" etc. in their option
// field), not a general-purpose parser.
const INSTRUCTION_STOPWORDS = new Set([
  "제품",
  "사진",
  "리뷰",
  "글",
  "원고",
  "내용",
  "그리고",
  "그냥",
  "좀",
  "것",
  "거",
]);
function extractInstructionKeywords(text) {
  return (text || "")
    .split(/[\s,./!?()\[\]~]+/)
    .map((tok) =>
      tok
        .replace(/^(그리고|그냥|좀|꼭|무조건)/g, "")
        .replace(/(만|도|은|는|이|가|을|를|으로|로|써줘|해줘|넣어줘|빼줘|제외해줘|포함해줘|해주세요|써주세요)+$/g, "")
        .trim()
    )
    .filter((tok) => tok.length >= 2 && !INSTRUCTION_STOPWORDS.has(tok));
}

// Soft-filters reviews whose option/body/keywordTags text contains
// any keyword pulled from the free-text instruction. Falls back to
// the full, unfiltered list when the instruction yields no usable
// keywords or matches nothing — a non-matching instruction (e.g. "20대
// 말투로 써줘", which is about tone, not photo content) shouldn't zero
// out every photo.
function filterReviewsByInstructions(reviews, instructions) {
  const keywords = extractInstructionKeywords(instructions);
  if (keywords.length === 0) return reviews;
  const matches = reviews.filter((r) => {
    const haystack = `${r.option || ""} ${r.body || ""} ${r.keywordTags || ""}`;
    return keywords.some((kw) => haystack.includes(kw));
  });
  return matches.length > 0 ? matches : reviews;
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

  // Every collected review carries the place name read from
  // document.title at collection time — auto-fill it so switching to
  // a newly-loaded place's reviews doesn't leave a stale or empty
  // storeName behind. Area/category aren't collected at all yet (the
  // scraper never reads the place's info tab), so those fields are
  // left for the user to fill in by hand.
  const placeNameReview = reviews.find((r) => r.placeName);
  if (placeNameReview) document.getElementById("storeNameInput").value = placeNameReview.placeName;

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

// Naver 스토어 리뷰(naverReviews, "네이버 스토어 리뷰 수집" 기능이 모은 것)는
// 플레이스 리뷰와 필드 이름이 다르다 — nickname 대신 reviewerId, placeName/
// keywordTags는 아예 없음 — 그래서 selectPhotoSlots/buildThreadsPostPlan 등
// 플레이스 리뷰 모양을 기대하는 나머지 코드가 그대로 쓸 수 있게 여기서
// 같은 모양으로 맞춰(normalize) lastLoadedReviews에 넣는다. 상호명은 이
// 리뷰에 상품명이 안 들어있어서 자동으로는 못 채운다 — 직접 입력해야 한다.
async function handleLoadNaverStoreReviews() {
  const { naverReviews } = await chrome.storage.local.get("naverReviews");
  const reviews = Array.isArray(naverReviews) ? naverReviews : [];
  const statusEl = document.getElementById("loadCollectedStatus");
  if (reviews.length === 0) {
    statusEl.textContent = "수집된 스마트스토어 리뷰가 없습니다 — 먼저 확장프로그램 팝업에서 리뷰 수집을 실행하세요.";
    return;
  }

  const normalized = reviews.map((r) => ({
    nickname: r.reviewerId || "",
    body: r.body || "",
    rating: r.rating || "",
    keywordTags: "",
    option: r.option || "",
    placeName: "",
    photoUrls: Array.isArray(r.photoUrls) ? r.photoUrls : [],
  }));
  lastLoadedReviews = normalized;

  const lines = normalized
    .filter((r) => r.body && r.body.trim())
    .map((r) => {
      const flatBody = r.body.replace(/\s*\n\s*/g, " ").trim();
      const ratingPart = r.rating ? `[${r.rating}점] ` : "";
      return `${ratingPart}${flatBody}`;
    });
  document.getElementById("reviewsInput").value = lines.join("\n");
  const photoCount = normalized.reduce((sum, r) => sum + r.photoUrls.length, 0);
  statusEl.textContent = `${lines.length}건을 불러왔습니다 (사진 ${photoCount}장 포함) — 상품명(상호명)은 자동으로 못 채우니 직접 입력하세요. 필요하면 리뷰도 직접 수정/삭제 후 생성하세요.`;
}

// Mirrors handleLoadNaverStoreReviews above for the Google review pool
// (collected via the popup's "구글 리뷰 수집"). option/keywordTags
// have no equivalent on Google reviews, so they're left blank — the
// "원고 요청사항" photo keyword filter just won't narrow anything for
// this source (falls back to the full pool, same as any other
// non-matching instruction).
async function handleLoadGoogleReviews() {
  const { googleReviews } = await chrome.storage.local.get("googleReviews");
  const reviews = Array.isArray(googleReviews) ? googleReviews : [];
  const statusEl = document.getElementById("loadCollectedStatus");
  if (reviews.length === 0) {
    statusEl.textContent = "수집된 구글 리뷰가 없습니다 — 먼저 확장프로그램 팝업에서 리뷰 수집을 실행하세요.";
    return;
  }

  const normalized = reviews.map((r) => ({
    nickname: r.nickname || "",
    body: r.body || "",
    rating: r.rating || "",
    keywordTags: "",
    option: "",
    placeName: "",
    photoUrls: Array.isArray(r.photoUrls) ? r.photoUrls : [],
  }));
  lastLoadedReviews = normalized;

  const lines = normalized
    .filter((r) => r.body && r.body.trim())
    .map((r) => {
      const flatBody = r.body.replace(/\s*\n\s*/g, " ").trim();
      const ratingPart = r.rating ? `[${r.rating}점] ` : "";
      return `${ratingPart}${flatBody}`;
    });
  document.getElementById("reviewsInput").value = lines.join("\n");
  const photoCount = normalized.reduce((sum, r) => sum + r.photoUrls.length, 0);
  statusEl.textContent = `${lines.length}건을 불러왔습니다 (사진 ${photoCount}장 포함) — 상호명은 자동으로 못 채우니 직접 입력하세요. 필요하면 리뷰도 직접 수정/삭제 후 생성하세요.`;
}

function sanitizeForFilename(s) {
  return (s || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

// Splits `arr` into up to `n` contiguous, roughly-equal chunks —
// used to divide the loaded reviews (and, separately, the loaded
// review objects for photo selection) across multiple draft requests.
// Returns fewer than `n` chunks if `arr` is too short to split that
// many ways (never returns an empty chunk).
function chunkArray(arr, n) {
  const chunks = [];
  const size = Math.ceil(arr.length / n);
  if (size <= 0) return chunks;
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Picks somewhere between `minCount` and `maxCount` photos, preferring
// a SINGLE reviewer's own photos over mixing people together. If the
// richest reviewer already has at least `minCount` photos, this uses
// only that person's photos (capped at `maxCount`) — it does NOT pad
// out to `maxCount` by pulling in someone else's photos just to hit a
// round number. Only when even the richest reviewer falls short of
// `minCount` does it add the next-richest reviewer's photos too, just
// enough to clear `minCount`. An earlier version forced exactly one
// fixed count by round-robining across many reviewers for variety,
// which in practice made a blog post's photo set look like a
// patchwork of different people's separate visits (different coffee
// cups, different seating, different lighting from photo to photo)
// instead of one person's one visit — confirmed by the user comparing
// actual output, and the min/max range (rather than one fixed number)
// was requested right after fixing that, specifically so a reviewer
// with say 9 photos doesn't still get diluted with someone else's just
// to reach a fixed target of 15.
function selectPhotoSlots(reviews, minCount, maxCount) {
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
  if (byReview.length === 0) return [];
  byReview.sort((a, b) => b.urls.length - a.urls.length);

  const targetCount = byReview[0].urls.length >= minCount ? Math.min(byReview[0].urls.length, maxCount) : minCount;

  const selected = [];
  for (const group of byReview) {
    for (let i = 0; i < group.urls.length && selected.length < targetCount; i++) {
      selected.push({
        url: group.urls[i],
        reviewIndex: group.reviewIndex,
        photoIndex: i,
        nickname: group.nickname,
        body: group.body,
        rating: group.rating,
        keywordTags: group.keywordTags,
        placeName: group.placeName,
      });
    }
    if (selected.length >= targetCount) break;
  }
  return selected;
}

// Filenames here are just "사진1.jpg", "사진2.jpg"... by slot position —
// matching the "[사진 삽입: N]" marker number directly, so there's no
// separate lookup needed between the draft text and the files. This is
// deliberately NOT the same naming scheme startPlacePhotoDownload (in
// background.js, the standalone "리뷰 사진 전체 다운로드" button) uses —
// that one downloads every photo from every collected review and needs
// the reviewer/index info to avoid collisions; this only ever covers
// the small set of slots actually selected for one blog post, and the
// photos here are re-encoded (see processPhotoBlob below), not the
// original files, so reusing that naming would be misleading anyway.
function simplePhotoFilename(index) {
  return `사진${index + 1}.jpg`;
}

// Every blog photo is resized/cropped to the same square and run
// through a mild auto-enhance filter — requested after the first
// version shipped the review photos exactly as uploaded, which come
// in wildly different sizes/aspect ratios and vary a lot in exposure
// since they're casual phone shots from different visitors. Built on
// Canvas 2D (createImageBitmap + ctx.filter), which only works on
// image bytes already fetched as a Blob — never on an <img src> tag
// pointed at the remote URL, since drawing a cross-origin <img> taints
// the canvas and blocks reading it back out; a fetched Blob carries no
// such restriction regardless of origin.
const BLOG_PHOTO_SIZE = 1080;
const BLOG_PHOTO_FILTER = "contrast(1.08) saturate(1.15) brightness(1.04)";

async function processPhotoBlob(rawBlob, targetSize) {
  const bitmap = await createImageBitmap(rawBlob);
  const canvas = document.createElement("canvas");
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext("2d");
  // "Cover" crop: scale so the shorter side fills targetSize, then
  // center-crop the overflow on the longer side — keeps portrait and
  // landscape phone photos all coming out the same square size
  // instead of stretching or letterboxing either kind.
  const scale = Math.max(targetSize / bitmap.width, targetSize / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  ctx.filter = BLOG_PHOTO_FILTER;
  ctx.drawImage(bitmap, (targetSize - drawWidth) / 2, (targetSize - drawHeight) / 2, drawWidth, drawHeight);
  bitmap.close();
  return await new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob 실패"))), "image/jpeg", 0.88)
  );
}

// Mutates `processedArr` in place (index i -> { blob, url } or null on
// failure), keyed by position in `photoSlots`. Takes the array as a
// parameter rather than touching a module-level variable because each
// draft card now keeps its own processed-photo cache (scope.processedPhotos)
// — with multiple drafts generated in one run, a single shared cache
// would mix up photos between unrelated posts.
async function ensureProcessedPhotos(processedArr, photoSlots, onProgress) {
  for (let i = 0; i < photoSlots.length; i++) {
    if (processedArr[i]) continue;
    try {
      const res = await fetch(photoSlots[i].url);
      if (!res.ok) throw new Error(String(res.status));
      const rawBlob = await res.blob();
      const outBlob = await processPhotoBlob(rawBlob, BLOG_PHOTO_SIZE);
      processedArr[i] = { blob: outBlob, url: URL.createObjectURL(outBlob) };
    } catch (err) {
      processedArr[i] = null;
    }
    if (onProgress) onProgress(i + 1, photoSlots.length);
  }
  return processedArr;
}

function parseReviewsInput() {
  const raw = document.getElementById("reviewsInput").value || "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function renderChips(container, items, className) {
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

function renderTitles(container, titles) {
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

// Builds one draft's two cards (결과 + 블로그용 미리보기) as a detached
// DOM subtree, appends it to #resultsContainer, and returns a `scope`
// object every render/handler below takes as its first argument —
// scope.el is the subtree (so all lookups are container.querySelector,
// never a page-wide id — multiple drafts would otherwise collide on
// the same id), and scope.result/scope.processedPhotos hold this one
// draft's own state.
function createDraftCard(num, total) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="card">
      <h2>원고 #${num}${total > 1 ? ` / ${total}` : ""}</h2>
      <div class="error-line file-hint" style="color:#dc2626;"></div>
      <div class="keyword-group">
        <div class="label">제목 추천 (검색 많이 되는 키워드 조합)</div>
        <div class="titlesList"></div>
      </div>
      <div class="keyword-group">
        <div class="label">필수 키워드</div>
        <div class="requiredKeywords"></div>
      </div>
      <div class="keyword-group">
        <div class="label">좋은 키워드</div>
        <div class="goodKeywords"></div>
      </div>
      <div class="keyword-group">
        <div class="label">시그니처 메뉴</div>
        <div class="signatureMenuOut"></div>
      </div>
      <label style="margin-top:8px;">블로그 원고 (수정 가능, 본문 중 "[사진 삽입: N]"은 아래 사진 배치 가이드의 N번 사진을 끼워 넣을 자리입니다)</label>
      <textarea class="draftOutput" rows="14"></textarea>
      <div class="row2" style="margin-bottom:0;">
        <button type="button" class="copyDraftBtn">클립보드에 복사</button>
        <button type="button" class="downloadZipBtn">원고+사진 ZIP 다운로드</button>
      </div>
      <div class="downloadZipStatus file-hint" style="margin-top:4px;"></div>
      <div class="keyword-group" style="margin-top:16px;">
        <div class="label">해시태그</div>
        <div class="hashtagsOut"></div>
        <button type="button" class="copyHashtagsBtn" style="margin-top:6px;">해시태그 전체 복사</button>
      </div>
      <div class="photoGuideSection hidden" style="margin-top:16px;">
        <label>사진 배치 가이드</label>
        <div class="file-hint">
          본문의 "[사진 삽입: N]" 자리에 아래 N번 사진이 들어갑니다. 아래 미리보기/ZIP의 사진은 원본 그대로가 아니라 1080×1080 정사각형으로 맞추고 살짝 보정(밝기·대비·채도)한 버전이며, 파일명도 "사진1.jpg", "사진2.jpg"처럼 간단하게 바뀝니다.
        </div>
        <div class="photoGuideList"></div>
      </div>
    </div>
    <div class="card hidden previewCard">
      <h2>원고 #${num} 블로그용 미리보기 (복사해서 붙여넣기)</h2>
      <div class="file-hint">
        아래 내용을 "전체 선택" 버튼으로 선택하고 Ctrl+C(맥: Cmd+C)로 복사한 뒤, 네이버 블로그 글쓰기 화면에 붙여넣으면(Ctrl+V) 텍스트와 사진이 함께 들어갑니다. 완전 자동 발행은 아니지만 사진을 하나씩 끌어넣을 필요가 없어집니다. 붙여넣은 뒤 줄바꿈·사진 크기 등은 블로그 에디터에서 한 번 더 다듬어주세요.
      </div>
      <div class="row2" style="margin-bottom:10px;">
        <button type="button" class="refreshPreviewBtn">미리보기 새로고침 (원고 수정 후 다시 반영)</button>
        <button type="button" class="selectPreviewBtn primaryBtn">전체 선택하기</button>
      </div>
      <div class="blogPreview blog-preview" contenteditable="true"></div>
    </div>
  `;
  document.getElementById("resultsContainer").appendChild(wrapper);

  const scope = { el: wrapper, num, total, result: null, processedPhotos: [] };

  wrapper.querySelector(".copyDraftBtn").addEventListener("click", () => handleCopyDraft(scope));
  wrapper.querySelector(".downloadZipBtn").addEventListener("click", () => handleDownloadZip(scope));
  wrapper.querySelector(".copyHashtagsBtn").addEventListener("click", () => handleCopyHashtags(scope));
  wrapper.querySelector(".refreshPreviewBtn").addEventListener("click", () => renderPreview(scope));
  wrapper.querySelector(".selectPreviewBtn").addEventListener("click", () => handleSelectPreview(scope));

  return scope;
}

function renderPhotoGuide(scope, photoSlots, photoCaptions) {
  const photoSection = scope.el.querySelector(".photoGuideSection");
  if (photoSlots.length === 0) {
    photoSection.classList.add("hidden");
    return;
  }
  photoSection.classList.remove("hidden");
  const list = scope.el.querySelector(".photoGuideList");
  list.innerHTML = "";
  photoSlots.forEach((slot, i) => {
    const caption = photoCaptions[i] || "";
    const previewUrl = (scope.processedPhotos[i] && scope.processedPhotos[i].url) || slot.url;
    const row = document.createElement("div");
    row.className = "photo-guide-item";
    row.innerHTML = `
      <span class="num">#${i + 1}</span>
      <img src="${previewUrl}" alt="사진 ${i + 1}" loading="lazy" />
      <div>
        <div class="caption">${caption ? caption.replace(/</g, "&lt;") : "(설명 없음)"}</div>
        <div class="meta">ZIP에 "${simplePhotoFilename(i)}"로 들어있습니다${
      scope.processedPhotos[i] ? "" : " (보정 실패 — 원본으로 대체됩니다)"
    }</div>
      </div>
    `;
    list.appendChild(row);
  });
}

async function renderDraft(scope, result) {
  scope.result = result;
  renderTitles(scope.el.querySelector(".titlesList"), result.titles);
  renderChips(scope.el.querySelector(".requiredKeywords"), result.requiredKeywords, "required");
  renderChips(scope.el.querySelector(".goodKeywords"), result.goodKeywords, "good");
  renderChips(scope.el.querySelector(".signatureMenuOut"), result.signatureMenu, "menu");
  renderChips(scope.el.querySelector(".hashtagsOut"), result.hashtags, "hashtag");
  scope.el.querySelector(".draftOutput").value = result.draft || "";

  const photoSlots = Array.isArray(result.photoSlots) ? result.photoSlots : [];
  const photoCaptions = Array.isArray(result.photoCaptions) ? result.photoCaptions : [];
  scope.processedPhotos = [];
  renderPhotoGuide(scope, photoSlots, photoCaptions);

  if (photoSlots.length > 0) {
    const label = scope.total > 1 ? `원고 #${scope.num} 사진 보정 중` : "사진 보정 중";
    await ensureProcessedPhotos(scope.processedPhotos, photoSlots, (done, total) => {
      setStatus(`${label}... (${done} / ${total})`);
    });
    renderPhotoGuide(scope, photoSlots, photoCaptions);
  }

  if (result.parseFailed) {
    scope.el.querySelector(".error-line").textContent =
      "AI 응답을 정해진 형식으로 해석하지 못해 원문 그대로 표시합니다 — 키워드 분류는 비어 있습니다.";
  }

  renderPreview(scope);
}

// Rebuilds a draft's "블로그용 미리보기" block from whatever is currently
// in its draftOutput (so manual edits are reflected) plus that draft's
// own photo slots/captions. "[사진 삽입: N]" markers become a real
// <figure><img>+caption> in place — this is what makes the preview
// copy-paste as text-and-images together into a rich text editor like
// Naver Blog's, rather than just plain text with bracket placeholders.
function buildPreviewNode(draftText, photoSlots, photoCaptions, hashtags, processedPhotos) {
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
      img.src = (processedPhotos[num - 1] && processedPhotos[num - 1].url) || slot.url;
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

function renderPreview(scope) {
  const draftText = scope.el.querySelector(".draftOutput").value || "";
  const previewCard = scope.el.querySelector(".previewCard");
  if (!draftText.trim()) {
    previewCard.classList.add("hidden");
    return;
  }
  const photoSlots = scope.result && Array.isArray(scope.result.photoSlots) ? scope.result.photoSlots : [];
  const photoCaptions = scope.result && Array.isArray(scope.result.photoCaptions) ? scope.result.photoCaptions : [];
  const hashtags = scope.result && Array.isArray(scope.result.hashtags) ? scope.result.hashtags : [];
  const node = buildPreviewNode(draftText, photoSlots, photoCaptions, hashtags, scope.processedPhotos);
  const container = scope.el.querySelector(".blogPreview");
  container.innerHTML = "";
  container.appendChild(node);
  previewCard.classList.remove("hidden");
}

function handleSelectPreview(scope) {
  const el = scope.el.querySelector(".blogPreview");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  setStatus("전체 선택했습니다 — 이제 Ctrl+C(맥: Cmd+C)로 복사한 뒤 블로그 글쓰기 화면에 Ctrl+V로 붙여넣으세요.");
}

async function handleCopyDraft(scope) {
  const text = scope.el.querySelector(".draftOutput").value;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("클립보드에 복사했습니다.");
  } catch (err) {
    setStatus("클립보드 복사에 실패했습니다 — 직접 선택해서 복사하세요.", true);
  }
}

async function handleCopyHashtags(scope) {
  const hashtags = (scope.result && scope.result.hashtags) || [];
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

// Builds one zip containing 블로그원고.txt (the draft, with each
// "[사진 삽입: N]" marker rewritten in place to name the exact photo
// file it refers to — so reading the txt next to the extracted photos
// is enough, no separate guide needed) plus every referenced photo
// under that same filename. Runs entirely in this tab (not the
// background service worker) since, unlike the per-photo bulk
// downloader, there's nothing here that needs to survive the popup
// closing — this page stays open for as long as the zip takes to
// build.
async function handleDownloadZip(scope) {
  const draftText = scope.el.querySelector(".draftOutput").value || "";
  if (!draftText.trim()) {
    setStatus("먼저 원고를 생성하세요.", true);
    return;
  }

  const result = scope.result || {};
  const photoSlots = Array.isArray(result.photoSlots) ? result.photoSlots : [];
  const photoCaptions = Array.isArray(result.photoCaptions) ? result.photoCaptions : [];
  const titles = Array.isArray(result.titles) ? result.titles : [];
  const hashtags = Array.isArray(result.hashtags) ? result.hashtags : [];
  const storeName = document.getElementById("storeNameInput").value.trim();
  const statusEl = scope.el.querySelector(".downloadZipStatus");
  const btn = scope.el.querySelector(".downloadZipBtn");

  btn.disabled = true;
  statusEl.textContent = photoSlots.length > 0 ? `사진 ${photoSlots.length}장 보정하는 중...` : "압축 파일 만드는 중...";

  try {
    // Reuses whatever renderDraft already processed (resized + color
    // corrected) — only re-processes a slot here if that somehow never
    // ran or failed the first time.
    if (photoSlots.length > 0) {
      await ensureProcessedPhotos(scope.processedPhotos, photoSlots, (done, total) => {
        statusEl.textContent = `사진 보정하는 중... (${done} / ${total})`;
      });
    }

    const zip = new JSZip();

    const bodyWithPhotoNames = draftText.replace(/\[사진\s*삽입\s*:\s*(\d+)\]/g, (whole, numStr) => {
      const num = parseInt(numStr, 10);
      const slot = photoSlots[num - 1];
      if (!slot) return whole;
      const caption = photoCaptions[num - 1];
      return `[사진: ${simplePhotoFilename(num - 1)}${caption ? ` — ${caption}` : ""}]`;
    });

    const titleBlock = titles.length > 0 ? `[제목 추천]\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n` : "";
    const hashtagBlock = hashtags.length > 0 ? `\n\n${hashtags.join(" ")}` : "";
    const txtBody = `${titleBlock}${bodyWithPhotoNames}${hashtagBlock}`;
    zip.file("블로그원고.txt", "﻿" + txtBody);

    let failed = 0;
    for (let i = 0; i < photoSlots.length; i++) {
      const processed = scope.processedPhotos[i];
      if (processed) {
        zip.file(simplePhotoFilename(i), processed.blob);
      } else {
        // Processing failed for this slot — fall back to the original
        // file as-is rather than dropping it from the zip entirely.
        try {
          const res = await fetch(photoSlots[i].url);
          if (!res.ok) throw new Error(String(res.status));
          zip.file(simplePhotoFilename(i), await res.blob());
        } catch (err) {
          failed++;
        }
      }
    }

    statusEl.textContent = "압축 파일 만드는 중...";
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const numSuffix = scope.total > 1 ? `_${scope.num}` : "";
    const zipFilename = `${sanitizeForFilename(storeName) || "블로그원고"}${numSuffix}_${dateStr}.zip`;

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

// Splits the loaded reviews (and, if photos are on, the loaded review
// objects) into `draftCount` chunks and runs one GENERATE_BLOG_DRAFT
// call per chunk in sequence, so each resulting post draws on
// different reviews/photos instead of every post rehashing the same
// handful. Requested after collecting 151 reviews / ~400 photos but
// only ever getting one post out of them. Chunk i's review text and
// chunk i's photos come from independently-sized splits of the
// (textarea lines) and (lastLoadedReviews objects) arrays respectively
// — both were filled in the same order by handleLoadCollected, so they
// line up well in practice, though a reviewer who hand-edits the
// textarea afterward can throw that off slightly; not worth the extra
// bookkeeping to guarantee exactly, since the AI step downstream is
// already approximate.
async function handleGenerate() {
  const storeName = document.getElementById("storeNameInput").value.trim();
  const storeArea = document.getElementById("storeAreaInput").value.trim();
  const storeCategory = document.getElementById("storeCategoryInput").value.trim();
  const signatureMenuHint = document.getElementById("signatureMenuInput").value.trim();
  const customInstructions = document.getElementById("customInstructionsInput").value.trim();
  const apiKey = document.getElementById("apiKeyInput").value.trim();
  const model = document.getElementById("modelSelect").value;
  const reviewLines = parseReviewsInput();
  const includePhotos = document.getElementById("includePhotosCheckbox").checked;
  const photoCountMin = Math.max(1, parseInt(document.getElementById("photoCountMinInput").value, 10) || 7);
  const photoCountMax = Math.max(photoCountMin, parseInt(document.getElementById("photoCountMaxInput").value, 10) || 15);
  const requestedDraftCount = Math.max(1, Math.min(20, parseInt(document.getElementById("draftCountInput").value, 10) || 1));

  if (!apiKey) {
    setStatus("먼저 Gemini API 키를 입력하고 저장하세요.", true);
    return;
  }
  if (!storeName) {
    setStatus("상호명을 입력하세요.", true);
    return;
  }
  if (reviewLines.length === 0) {
    setStatus("리뷰를 한 줄에 하나씩 붙여넣으세요.", true);
    return;
  }
  if (includePhotos && lastLoadedReviews.length === 0) {
    setStatus('사진을 쓰려면 먼저 "수집한 플레이스 리뷰 불러오기"로 리뷰를 불러오세요 (직접 붙여넣은 텍스트에는 사진 정보가 없습니다).', true);
    return;
  }

  // Filter the candidate pool by the free-text instruction BEFORE
  // splitting across drafts, so e.g. "흰색만 써줘" narrows which
  // reviews' photos are even eligible to be picked by selectPhotoSlots
  // below, not just which ones get mentioned in the prompt text.
  const filteredPhotoPool = includePhotos ? filterReviewsByInstructions(lastLoadedReviews, customInstructions) : [];

  const reviewChunks = chunkArray(reviewLines, requestedDraftCount);
  const photoChunks = includePhotos ? chunkArray(filteredPhotoPool, requestedDraftCount) : [];
  const draftCount = reviewChunks.length;

  await chrome.storage.local.set({
    blogApiKey: apiKey,
    blogModel: model,
    blogStoreName: storeName,
    blogStoreArea: storeArea,
    blogStoreCategory: storeCategory,
    blogSignatureMenu: signatureMenuHint,
    blogCustomInstructions: customInstructions,
  });

  document.getElementById("resultsContainer").innerHTML = "";

  const generateBtn = document.getElementById("generateBtn");
  generateBtn.disabled = true;

  if (draftCount < requestedDraftCount) {
    setStatus(`리뷰 수가 적어서 원고 ${draftCount}개로 조정했습니다 (요청: ${requestedDraftCount}개).`);
  }

  let succeeded = 0;
  let stoppedByQuota = false;
  for (let i = 0; i < draftCount; i++) {
    const chunkReviewLines = reviewChunks[i];
    let photoSlots = [];
    if (includePhotos) {
      photoSlots = selectPhotoSlots(photoChunks[i] || [], photoCountMin, photoCountMax);
    }

    setStatus(
      draftCount > 1
        ? `원고 ${i + 1}/${draftCount} 생성 중 (리뷰 ${chunkReviewLines.length}건${
            photoSlots.length ? `, 사진 ${photoSlots.length}장` : ""
          })...`
        : `AI가 리뷰 ${chunkReviewLines.length}건${photoSlots.length ? ` + 사진 ${photoSlots.length}장` : ""}을 분석해 원고를 만드는 중입니다...`
    );

    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_BLOG_DRAFT",
      storeName,
      storeArea,
      storeCategory,
      signatureMenuHint,
      customInstructions,
      reviews: chunkReviewLines,
      apiKey,
      model,
      photoSlots,
    });

    const scope = createDraftCard(i + 1, draftCount);

    if (!response || !response.ok) {
      const reason = response && response.reason;
      let msg;
      if (reason === "already_running") msg = "이미 다른 생성 작업이 진행 중입니다.";
      else if (reason === "no_api_key") msg = "API 키가 필요합니다.";
      else if (reason === "no_reviews") msg = "이 구간에 리뷰가 없습니다.";
      else msg = `생성 실패: ${(response && response.error) || "알 수 없는 오류"}`;
      scope.el.querySelector(".error-line").textContent = msg;

      if (response && response.quotaExceeded) {
        setStatus(
          `원고 ${i + 1}/${draftCount}에서 중단: ${msg} (하루 한도이므로 나머지 ${
            draftCount - i - 1
          }개는 지금 시도해도 똑같이 실패해 생성을 멈췄습니다)`,
          true
        );
        stoppedByQuota = true;
        break;
      }

      setStatus(`원고 ${i + 1}/${draftCount} 생성 실패 (${msg}) — 나머지는 계속 진행합니다.`, true);
      continue;
    }

    await renderDraft(scope, response.result);
    succeeded++;
  }

  generateBtn.disabled = false;
  if (!stoppedByQuota) {
    setStatus(
      draftCount > 1
        ? `완료: 원고 ${succeeded}/${draftCount}개 생성됨. 발행 전 각각 꼭 검토하세요.`
        : succeeded > 0
        ? "완료되었습니다. 발행 전 내용을 꼭 직접 검토하세요."
        : "생성에 실패했습니다."
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  document.getElementById("saveApiKeyBtn").addEventListener("click", saveApiKey);
  document.getElementById("loadCollectedBtn").addEventListener("click", handleLoadCollected);
  document.getElementById("loadNaverStoreBtn").addEventListener("click", handleLoadNaverStoreReviews);
  document.getElementById("loadGoogleReviewsBtn").addEventListener("click", handleLoadGoogleReviews);
  document.getElementById("generateBtn").addEventListener("click", handleGenerate);
  document.getElementById("includePhotosCheckbox").addEventListener("change", (e) => {
    document.getElementById("photoCountRow").style.display = e.target.checked ? "flex" : "none";
    document.getElementById("photoCountHint").style.display = e.target.checked ? "block" : "none";
  });
});
