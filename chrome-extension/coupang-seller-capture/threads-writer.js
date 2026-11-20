function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

// Shares storage keys with the blog-writer tool (blogApiKey/blogModel/
// blogStoreName/...) deliberately — same Gemini key and same store
// info, no reason to make the user enter either twice.
async function loadSettings() {
  const { blogApiKey, blogModel, blogStoreName, blogStoreArea, blogStoreCategory } = await chrome.storage.local.get([
    "blogApiKey",
    "blogModel",
    "blogStoreName",
    "blogStoreArea",
    "blogStoreCategory",
  ]);
  document.getElementById("apiKeyInput").value = blogApiKey || "";
  document.getElementById("modelSelect").value = blogModel || "gemini-3.8-flash";
  document.getElementById("storeNameInput").value = blogStoreName || "";
  document.getElementById("storeAreaInput").value = blogStoreArea || "";
  document.getElementById("storeCategoryInput").value = blogStoreCategory || "";
}

async function saveApiKey() {
  await chrome.storage.local.set({
    blogApiKey: document.getElementById("apiKeyInput").value.trim(),
    blogModel: document.getElementById("modelSelect").value,
  });
  setStatus("API 설정을 저장했습니다.");
}

function sanitizeForFilename(s) {
  return (s || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

function flattenReviewText(r) {
  const ratingPart = r.rating ? `[${r.rating}점] ` : "";
  const flatBody = (r.body || "").replace(/\s*\n\s*/g, " ").trim();
  const tagPart = r.keywordTags ? ` (키워드: ${r.keywordTags})` : "";
  return `${ratingPart}${flatBody}${tagPart}`;
}

// Populated by handleLoadCollected with the raw collected review
// objects (photoUrls included).
let lastLoadedReviews = [];

function countTotalPhotos(reviews) {
  return reviews.reduce((sum, r) => sum + (Array.isArray(r.photoUrls) ? r.photoUrls.length : 0), 0);
}

function updatePoolStats() {
  const el = document.getElementById("poolStats");
  if (lastLoadedReviews.length === 0) {
    el.classList.add("hidden");
    return;
  }
  const totalPhotos = countTotalPhotos(lastLoadedReviews);
  const reviewsWithPhotos = lastLoadedReviews.filter((r) => Array.isArray(r.photoUrls) && r.photoUrls.length > 0).length;
  const photosPerPost = Math.max(1, parseInt(document.getElementById("photosPerPostInput").value, 10) || 2);
  const maxPosts = Math.floor(totalPhotos / photosPerPost);
  el.classList.remove("hidden");
  el.textContent = `사진 있는 리뷰 ${reviewsWithPhotos}건, 사진 총 ${totalPhotos}장 → 글 1개당 사진 ${photosPerPost}장씩이면 최대 ${maxPosts}개 글 생성 가능`;
}

async function handleLoadCollected() {
  const { placeReviews } = await chrome.storage.local.get("placeReviews");
  const reviews = Array.isArray(placeReviews) ? placeReviews : [];
  const statusEl = document.getElementById("loadCollectedStatus");
  if (reviews.length === 0) {
    statusEl.textContent = "수집된 플레이스 리뷰가 없습니다 — 먼저 확장프로그램 팝업에서 리뷰 수집을 실행하세요.";
    document.getElementById("poolStats").classList.add("hidden");
    return;
  }
  lastLoadedReviews = reviews;
  statusEl.textContent = `${reviews.length}건을 불러왔습니다.`;
  updatePoolStats();
}

// Builds up to `maxPosts` posts, each exactly `photosPerPost` photos,
// by flattening every loaded review's photos into one pool (spread
// across reviews round-robin — one photo from each review with photos
// first, then a second from each that still has one, and so on, same
// idea as the blog tool's selectPhotoSlots) and then chunking that
// pool sequentially. A trailing chunk shorter than photosPerPost is
// dropped rather than shipped as a short post.
function buildThreadsPostPlan(reviews, photosPerPost, maxPosts) {
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

  const pool = [];
  let round = 0;
  let addedAny = true;
  while (addedAny) {
    addedAny = false;
    for (const group of byReview) {
      if (group.urls[round]) {
        pool.push({
          url: group.urls[round],
          reviewIndex: group.reviewIndex,
          photoIndex: round,
          nickname: group.nickname,
          body: group.body,
          rating: group.rating,
          keywordTags: group.keywordTags,
          placeName: group.placeName,
        });
        addedAny = true;
      }
    }
    round++;
  }

  const posts = [];
  for (let i = 0; i + photosPerPost <= pool.length && posts.length < maxPosts; i += photosPerPost) {
    posts.push(pool.slice(i, i + photosPerPost));
  }
  return posts;
}

// Every photo is resized/cropped to the same square and run through a
// mild auto-enhance filter, same approach and same reasoning as the
// blog-writer tool: review photos come from different visitors' phones
// in wildly different sizes/exposures. Built on Canvas 2D
// (createImageBitmap + ctx.filter) against a fetched Blob, never an
// <img src> tag, since drawing a cross-origin <img> taints the canvas.
const PHOTO_SIZE = 1080;
const PHOTO_FILTER = "contrast(1.08) saturate(1.15) brightness(1.04)";

async function processPhotoBlob(rawBlob, targetSize) {
  const bitmap = await createImageBitmap(rawBlob);
  const canvas = document.createElement("canvas");
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(targetSize / bitmap.width, targetSize / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  ctx.filter = PHOTO_FILTER;
  ctx.drawImage(bitmap, (targetSize - drawWidth) / 2, (targetSize - drawHeight) / 2, drawWidth, drawHeight);
  bitmap.close();
  return await new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob 실패"))), "image/jpeg", 0.88)
  );
}

async function ensureProcessedPhotos(processedArr, photoSlots, onProgress) {
  for (let i = 0; i < photoSlots.length; i++) {
    if (processedArr[i]) continue;
    try {
      const res = await fetch(photoSlots[i].url);
      if (!res.ok) throw new Error(String(res.status));
      const rawBlob = await res.blob();
      const outBlob = await processPhotoBlob(rawBlob, PHOTO_SIZE);
      processedArr[i] = { blob: outBlob, url: URL.createObjectURL(outBlob) };
    } catch (err) {
      processedArr[i] = null;
    }
    if (onProgress) onProgress(i + 1, photoSlots.length);
  }
  return processedArr;
}

// Collected across a generation run so "전체 ZIP 다운로드" can bundle
// every post without re-deriving anything — each entry is the scope
// object createPostCard returned, already carrying that post's own
// processedPhotos/result.
let allPostScopes = [];

function createPostCard(num, total) {
  const wrapper = document.createElement("div");
  wrapper.className = "card post-card";
  wrapper.innerHTML = `
    <h2>글 #${num}${total > 1 ? ` / ${total}` : ""}</h2>
    <div class="post-error-line post-error"></div>
    <div class="post-photos"></div>
    <textarea class="post-text" rows="5"></textarea>
    <div class="post-actions">
      <button type="button" class="copyPostBtn">복사</button>
      <button type="button" class="downloadPostZipBtn">이 글만 ZIP 다운로드</button>
    </div>
    <div class="post-zip-status file-hint"></div>
  `;
  document.getElementById("resultsContainer").appendChild(wrapper);

  const scope = { el: wrapper, num, total, result: null, photoSlots: [], processedPhotos: [] };
  wrapper.querySelector(".copyPostBtn").addEventListener("click", () => handleCopyPost(scope));
  wrapper.querySelector(".downloadPostZipBtn").addEventListener("click", () => handleDownloadPostZip(scope));
  return scope;
}

function renderPostPhotos(scope) {
  const container = scope.el.querySelector(".post-photos");
  container.innerHTML = "";
  scope.photoSlots.forEach((slot, i) => {
    const img = document.createElement("img");
    img.src = (scope.processedPhotos[i] && scope.processedPhotos[i].url) || slot.url;
    img.alt = `사진 ${i + 1}`;
    container.appendChild(img);
  });
}

async function renderPost(scope, result) {
  scope.result = result;
  scope.el.querySelector(".post-text").value = result.text || "";
  if (result.parseFailed) {
    scope.el.querySelector(".post-error-line").textContent = "AI 응답을 정해진 형식으로 해석하지 못해 원문 그대로 표시합니다.";
  }
  renderPostPhotos(scope);
  await ensureProcessedPhotos(scope.processedPhotos, scope.photoSlots, (done, total) => {
    const label = scope.total > 1 ? `글 #${scope.num} 사진 보정 중` : "사진 보정 중";
    setStatus(`${label}... (${done} / ${total})`);
  });
  renderPostPhotos(scope);
}

async function handleCopyPost(scope) {
  const text = scope.el.querySelector(".post-text").value;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("글을 복사했습니다.");
  } catch (err) {
    setStatus("복사에 실패했습니다 — 직접 선택해서 복사하세요.", true);
  }
}

function postPhotoFilename(index) {
  return `사진${index + 1}.jpg`;
}

async function buildPostZipEntries(zip, scope, folderPrefix) {
  const text = scope.el.querySelector(".post-text").value || "";
  zip.file(`${folderPrefix}글.txt`, "﻿" + text);

  await ensureProcessedPhotos(scope.processedPhotos, scope.photoSlots, () => {});
  for (let i = 0; i < scope.photoSlots.length; i++) {
    const processed = scope.processedPhotos[i];
    if (processed) {
      zip.file(`${folderPrefix}${postPhotoFilename(i)}`, processed.blob);
    } else {
      try {
        const res = await fetch(scope.photoSlots[i].url);
        if (res.ok) zip.file(`${folderPrefix}${postPhotoFilename(i)}`, await res.blob());
      } catch (err) {
        // skip this one photo rather than failing the whole zip
      }
    }
  }
}

async function handleDownloadPostZip(scope) {
  const statusEl = scope.el.querySelector(".post-zip-status");
  const btn = scope.el.querySelector(".downloadPostZipBtn");
  btn.disabled = true;
  statusEl.textContent = "압축 파일 만드는 중...";
  try {
    const zip = new JSZip();
    await buildPostZipEntries(zip, scope, "");
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const storeName = document.getElementById("storeNameInput").value.trim();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `${sanitizeForFilename(storeName) || "쓰레드글"}_${scope.num}_${dateStr}.zip`;
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    statusEl.textContent = "ZIP 다운로드를 시작했습니다.";
  } catch (err) {
    statusEl.textContent = `ZIP 생성 실패: ${(err && err.message) || "알 수 없는 오류"}`;
  } finally {
    btn.disabled = false;
  }
}

async function handleDownloadAllZip() {
  const statusEl = document.getElementById("downloadAllZipStatus");
  const btn = document.getElementById("downloadAllZipBtn");
  if (allPostScopes.length === 0) {
    statusEl.textContent = "다운로드할 글이 없습니다.";
    return;
  }
  btn.disabled = true;
  try {
    const zip = new JSZip();
    for (let i = 0; i < allPostScopes.length; i++) {
      statusEl.textContent = `압축하는 중... (${i + 1} / ${allPostScopes.length})`;
      await buildPostZipEntries(zip, allPostScopes[i], `글${allPostScopes[i].num}/`);
    }
    statusEl.textContent = "압축 파일 만드는 중...";
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const storeName = document.getElementById("storeNameInput").value.trim();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `${sanitizeForFilename(storeName) || "쓰레드글"}_전체_${dateStr}.zip`;
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    statusEl.textContent = `ZIP 다운로드를 시작했습니다 (글 ${allPostScopes.length}개 포함, 각각 "글N/" 폴더에 들어있습니다).`;
  } catch (err) {
    statusEl.textContent = `ZIP 생성 실패: ${(err && err.message) || "알 수 없는 오류"}`;
  } finally {
    btn.disabled = false;
  }
}

async function handleGenerate() {
  const storeName = document.getElementById("storeNameInput").value.trim();
  const storeArea = document.getElementById("storeAreaInput").value.trim();
  const storeCategory = document.getElementById("storeCategoryInput").value.trim();
  const apiKey = document.getElementById("apiKeyInput").value.trim();
  const model = document.getElementById("modelSelect").value;
  const photosPerPost = Math.max(1, parseInt(document.getElementById("photosPerPostInput").value, 10) || 2);
  const requestedCount = Math.max(1, parseInt(document.getElementById("postCountInput").value, 10) || 20);

  if (!apiKey) {
    setStatus("먼저 Gemini API 키를 입력하고 저장하세요.", true);
    return;
  }
  if (!storeName) {
    setStatus("상호명을 입력하세요.", true);
    return;
  }
  if (lastLoadedReviews.length === 0) {
    setStatus('먼저 "수집한 플레이스 리뷰 불러오기"로 리뷰를 불러오세요.', true);
    return;
  }

  const plan = buildThreadsPostPlan(lastLoadedReviews, photosPerPost, requestedCount);
  if (plan.length === 0) {
    setStatus(`사진이 있는 리뷰가 부족해서 글을 만들 수 없습니다 (글 1개당 사진 ${photosPerPost}장 필요).`, true);
    return;
  }

  await chrome.storage.local.set({
    blogApiKey: apiKey,
    blogModel: model,
    blogStoreName: storeName,
    blogStoreArea: storeArea,
    blogStoreCategory: storeCategory,
  });

  document.getElementById("resultsContainer").innerHTML = "";
  document.getElementById("bulkActions").classList.add("hidden");
  allPostScopes = [];

  const generateBtn = document.getElementById("generateBtn");
  generateBtn.disabled = true;

  if (plan.length < requestedCount) {
    setStatus(`사진 공급량 기준으로 글 ${plan.length}개로 조정했습니다 (요청: ${requestedCount}개).`);
  }

  let succeeded = 0;
  for (let i = 0; i < plan.length; i++) {
    const photoSlots = plan[i];
    const uniqueReviewIndexes = Array.from(new Set(photoSlots.map((p) => p.reviewIndex)));
    const reviewTexts = uniqueReviewIndexes.map((idx) => flattenReviewText(lastLoadedReviews[idx]));

    setStatus(`글 ${i + 1}/${plan.length} 작성 중...`);

    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_THREADS_POST",
      storeName,
      storeArea,
      storeCategory,
      reviewTexts,
      photoSlots,
      apiKey,
      model,
    });

    const scope = createPostCard(i + 1, plan.length);
    scope.photoSlots = photoSlots;

    if (!response || !response.ok) {
      const reason = response && response.reason;
      let msg;
      if (reason === "already_running") msg = "이미 다른 생성 작업이 진행 중입니다.";
      else if (reason === "no_api_key") msg = "API 키가 필요합니다.";
      else if (reason === "no_photos") msg = "사진이 없습니다.";
      else msg = `생성 실패: ${(response && response.error) || "알 수 없는 오류"}`;
      scope.el.querySelector(".post-error-line").textContent = msg;
      setStatus(`글 ${i + 1}/${plan.length} 생성 실패 (${msg}) — 나머지는 계속 진행합니다.`, true);
      continue;
    }

    await renderPost(scope, response.result);
    allPostScopes.push(scope);
    succeeded++;
  }

  generateBtn.disabled = false;
  if (succeeded > 0) document.getElementById("bulkActions").classList.remove("hidden");
  setStatus(
    plan.length > 1
      ? `완료: 글 ${succeeded}/${plan.length}개 생성됨. 발행 전 각각 꼭 검토하세요.`
      : succeeded > 0
      ? "완료되었습니다. 발행 전 내용을 꼭 직접 검토하세요."
      : "생성에 실패했습니다."
  );
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  document.getElementById("saveApiKeyBtn").addEventListener("click", saveApiKey);
  document.getElementById("loadCollectedBtn").addEventListener("click", handleLoadCollected);
  document.getElementById("photosPerPostInput").addEventListener("input", updatePoolStats);
  document.getElementById("generateBtn").addEventListener("click", handleGenerate);
  document.getElementById("downloadAllZipBtn").addEventListener("click", handleDownloadAllZip);
});
