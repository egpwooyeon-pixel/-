const CSV_COLUMNS = [
  { key: "capturedAt", header: "캡처일시" },
  { key: "keyword", header: "검색키워드" },
  { key: "sellerName", header: "상호/대표자" },
  { key: "address", header: "사업장 소재지" },
  { key: "email", header: "e-mail" },
  { key: "phone", header: "연락처" },
  { key: "mailOrderNo", header: "통신판매업 신고번호" },
  { key: "bizRegNo", header: "사업자번호" },
  { key: "safetyService", header: "구매안전서비스" },
  { key: "productTitle", header: "상품명(탭 제목)" },
  { key: "pageUrl", header: "상품 URL" },
];

// extractCoupangSellerInfo, clickShippingTabIfPresent and
// findProductLinksOnListingPage are defined in shared.js (loaded
// before this file in popup.html) so both the popup and the
// background service worker use the same extraction logic.

function setStatus(message, type) {
  const el = document.getElementById("status");
  el.textContent = message || "";
  el.className = type ? type : "";
}

function formatDateTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function getRecords() {
  const { records } = await chrome.storage.local.get("records");
  return Array.isArray(records) ? records : [];
}

async function saveRecords(records) {
  await chrome.storage.local.set({ records });
}

function renderList(records) {
  document.getElementById("countNum").textContent = String(records.length);
  const listEl = document.getElementById("list");
  listEl.innerHTML = "";

  if (records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "아직 캡처된 항목이 없습니다.";
    listEl.appendChild(empty);
    return;
  }

  records
    .slice()
    .reverse()
    .forEach((rec) => {
      const originalIndex = records.indexOf(rec);
      const item = document.createElement("div");
      item.className = "item";

      const seller = document.createElement("div");
      seller.className = "seller";
      seller.textContent = rec.sellerName || "(상호 미확인)";
      item.appendChild(seller);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${rec.capturedAt || ""} · ${rec.productTitle || ""}`;
      item.appendChild(meta);

      const delBtn = document.createElement("button");
      delBtn.className = "del";
      delBtn.textContent = "삭제";
      delBtn.addEventListener("click", async () => {
        const current = await getRecords();
        current.splice(originalIndex, 1);
        await saveRecords(current);
        renderList(current);
      });
      item.appendChild(delBtn);

      listEl.appendChild(item);
    });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(records) {
  const header = CSV_COLUMNS.map((c) => csvEscape(c.header)).join(",");
  const rows = records.map((rec) =>
    CSV_COLUMNS.map((c) => csvEscape(rec[c.key])).join(",")
  );
  return [header, ...rows].join("\r\n");
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

async function handleCapture() {
  setStatus("캡처 중...", "");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("현재 탭을 확인할 수 없습니다.", "error");
    return;
  }
  if (!tab.url || !/coupang\.com/i.test(tab.url)) {
    setStatus("쿠팡 상품페이지가 아닌 것 같습니다. 그래도 시도합니다...", "");
  }

  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCoupangSellerInfo,
    });
  } catch (err) {
    setStatus("페이지에서 정보를 읽어올 수 없습니다. 쿠팡 상품페이지를 새로고침한 뒤 다시 시도해주세요.", "error");
    return;
  }

  const result = injectionResults && injectionResults[0] && injectionResults[0].result;
  if (!result || !result.success) {
    setStatus("'판매자 정보' 영역을 찾지 못했습니다. 상품페이지의 배송/교환/반품 안내 탭을 열어둔 상태인지 확인해주세요.", "error");
    return;
  }

  const record = {
    ...result.data,
    capturedAt: formatDateTime(new Date()),
  };

  const records = await getRecords();
  records.push(record);
  await saveRecords(records);
  renderList(records);
  setStatus(`캡처 완료: ${record.sellerName || "상호 미확인"}`, "ok");
}

async function handleDownload() {
  const records = await getRecords();
  if (records.length === 0) {
    setStatus("저장된 항목이 없습니다.", "error");
    return;
  }
  const csv = "﻿" + buildCsv(records);
  const base64 = toBase64Utf8(csv);
  const dateStr = formatDateTime(new Date()).replace(/[:\s]/g, "-");
  try {
    await chrome.downloads.download({
      url: `data:text/csv;charset=utf-8;base64,${base64}`,
      filename: `coupang_seller_info_${dateStr}.csv`,
      saveAs: true,
    });
    setStatus("CSV 다운로드를 시작했습니다.", "ok");
  } catch (err) {
    setStatus("다운로드에 실패했습니다.", "error");
  }
}

async function handleClear() {
  const records = await getRecords();
  if (records.length === 0) return;
  const ok = window.confirm(`저장된 ${records.length}건을 모두 삭제할까요?`);
  if (!ok) return;
  await saveRecords([]);
  renderList([]);
  setStatus("전체 삭제했습니다.", "ok");
}

function renderBatchStatus(status) {
  const progressEl = document.getElementById("batchProgress");
  const barWrap = document.getElementById("progressBar");
  const barFill = document.getElementById("progressBarFill");
  const startBtn = document.getElementById("batchStartBtn");
  const keywordStartBtn = document.getElementById("keywordStartBtn");
  const openTabsBtn = document.getElementById("captureOpenTabsBtn");

  const hasContent = status && (status.running || status.total > 0 || status.keywordTotal > 0);
  if (!hasContent) {
    progressEl.textContent = "";
    barWrap.classList.remove("active");
    startBtn.disabled = false;
    keywordStartBtn.disabled = false;
    openTabsBtn.disabled = false;
    return;
  }

  const isKeywordMode = status.mode === "keywords";
  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  barWrap.classList.add("active");
  barFill.style.width = `${pct}%`;
  startBtn.disabled = !!status.running;
  keywordStartBtn.disabled = !!status.running;
  openTabsBtn.disabled = !!status.running;

  const titleSuffix = status.currentTitle ? " (" + status.currentTitle.slice(0, 22) + ")" : "";

  if (status.running && isKeywordMode) {
    progressEl.innerHTML = `키워드 <b>${status.keywordDone} / ${status.keywordTotal}</b> "${status.currentKeyword}" · 상품 <b>${status.done} / ${status.total}</b> 캡처 중...${titleSuffix}`;
  } else if (status.running) {
    progressEl.innerHTML = `<b>${status.done} / ${status.total}</b> 캡처 중...${titleSuffix}`;
  } else if (status.error === "no_links_found") {
    progressEl.textContent = "이 페이지에서 상품 링크를 찾지 못했습니다. 쿠팡 검색/카테고리 목록 페이지에서 사용해주세요.";
  } else if (status.error === "listing_read_failed") {
    progressEl.textContent = "목록 페이지를 읽는 데 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.";
  } else if (status.error === "no_keywords") {
    progressEl.textContent = "입력된 키워드가 없습니다.";
  } else if (status.error === "no_open_tabs") {
    progressEl.textContent = "열려있는 쿠팡 상품 탭을 찾지 못했습니다. 상품페이지를 몇 개 열어두고 다시 시도해주세요.";
  } else if (status.error === "interrupted") {
    const doneText = isKeywordMode ? `키워드 ${status.keywordDone} / ${status.keywordTotal}` : `${status.done} / ${status.total}건`;
    progressEl.innerHTML = `크롬이 확장프로그램을 잠시 재시작해 작업이 중단됐습니다 (<b>${doneText}</b>까지 저장됨). 필요하면 다시 시작해주세요.`;
  } else if (status.error === "cancelled") {
    const doneText = isKeywordMode ? `키워드 ${status.keywordDone} / ${status.keywordTotal}` : `${status.done} / ${status.total}건`;
    progressEl.innerHTML = `중지됨: <b>${doneText}</b>까지 처리`;
  } else if (status.error === "blocked") {
    const doneText = isKeywordMode ? `키워드 ${status.keywordDone} / ${status.keywordTotal}` : `${status.done} / ${status.total}건`;
    progressEl.innerHTML = `<b class="blocked-warning">쿠팡이 자동 접근을 차단한 것으로 보여 작업을 즉시 멈췄습니다</b> (${doneText}까지 저장됨). 몇 시간 정도 쉬었다가 훨씬 적은 개수로 다시 시도해주세요.`;
  } else if (isKeywordMode && status.keywordTotal > 0) {
    progressEl.innerHTML = `완료: 키워드 <b>${status.keywordDone}</b> / ${status.keywordTotal}개 처리`;
  } else if (status.total > 0) {
    const failedText = status.failed > 0 ? `, 실패 ${status.failed}건` : "";
    progressEl.innerHTML = `완료: <b>${status.done}</b> / ${status.total}건 처리${failedText}`;
  }
}

async function handleCaptureOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "*://www.coupang.com/*" });
  const productTabs = tabs.filter((t) => t.url && /\/vp\/products\/\d+/.test(t.url));

  if (productTabs.length === 0) {
    setStatus("열려있는 쿠팡 상품 탭을 찾지 못했습니다. 상품페이지를 몇 개 열어두고 다시 시도해주세요.", "error");
    return;
  }

  const ok = window.confirm(
    `현재 열려있는 쿠팡 상품 탭 ${productTabs.length}개에서 판매자정보를 읽어옵니다.\n새로 페이지를 열거나 요청을 보내지 않고, 이미 열려있는 탭만 읽습니다.\n시작할까요?`
  );
  if (!ok) return;

  const response = await chrome.runtime.sendMessage({ type: "CAPTURE_OPEN_TABS" });
  if (response && response.ok === false) {
    setStatus("이미 다른 캡처 작업이 진행 중입니다.", "error");
    return;
  }
  setStatus("열려있는 탭 캡처를 시작했습니다.", "ok");
}

async function handleBatchStart() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("현재 탭을 확인할 수 없습니다.", "error");
    return;
  }
  if (!tab.url || !/coupang\.com/i.test(tab.url)) {
    setStatus("쿠팡 검색/카테고리 목록 페이지에서 사용해주세요.", "error");
    return;
  }

  let previewLinks = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: findProductLinksOnListingPage,
    });
    previewLinks = (results && results[0] && results[0].result) || [];
  } catch (err) {
    setStatus("페이지를 읽는 데 실패했습니다. 새로고침 후 다시 시도해주세요.", "error");
    return;
  }

  if (previewLinks.length === 0) {
    setStatus("이 페이지에서 상품 링크를 찾지 못했습니다.", "error");
    return;
  }

  const count = Math.min(previewLinks.length, 30);
  const ok = window.confirm(
    `상품 ${count}개를 순서대로 열어 판매자정보를 자동 캡처합니다.\n쿠팡에 부담을 주지 않도록 상품당 약 7~8초의 여유를 두고 진행하며, 팝업을 닫아도 계속됩니다.\n쿠팡이 접근을 차단하면 자동으로 즉시 멈춥니다.\n시작할까요?`
  );
  if (!ok) return;

  const response = await chrome.runtime.sendMessage({ type: "START_BATCH", sourceTabId: tab.id });
  if (response && response.ok === false) {
    setStatus("이미 자동 캡처가 진행 중입니다.", "error");
    return;
  }
  setStatus("자동 캡처를 시작했습니다.", "ok");
}

async function handleKeywordStart() {
  const textarea = document.getElementById("keywordsInput");
  const countInput = document.getElementById("perKeywordCount");

  const allKeywords = textarea.value
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (allKeywords.length === 0) {
    setStatus("키워드를 한 줄에 하나씩 입력해주세요.", "error");
    return;
  }

  const MAX_KEYWORDS = 50;
  const keywords = allKeywords.slice(0, MAX_KEYWORDS);
  const truncatedNote = allKeywords.length > MAX_KEYWORDS ? `\n(입력하신 ${allKeywords.length}개 중 앞 ${MAX_KEYWORDS}개만 사용합니다.)` : "";

  let perKeywordCount = parseInt(countInput.value, 10);
  if (!Number.isFinite(perKeywordCount) || perKeywordCount < 1) perKeywordCount = 1;
  if (perKeywordCount > 30) perKeywordCount = 30;
  countInput.value = String(perKeywordCount);

  const maxTotal = keywords.length * perKeywordCount;
  const estimatedMinutes = Math.max(1, Math.round((keywords.length * (11 + perKeywordCount * 7.7)) / 60));

  const ok = window.confirm(
    `키워드 ${keywords.length}개 × 키워드당 최대 ${perKeywordCount}개 = 최대 ${maxTotal}건을 수집합니다.\n쿠팡에 부담을 주지 않도록 여유 있게 진행해 예상 소요 시간은 약 ${estimatedMinutes}분입니다. 팝업을 닫아도 계속됩니다.\n쿠팡이 접근을 차단하면 자동으로 즉시 멈춥니다.${truncatedNote}\n시작할까요?`
  );
  if (!ok) return;

  const response = await chrome.runtime.sendMessage({
    type: "START_KEYWORD_BATCH",
    keywords,
    perKeywordCount,
  });
  if (response && response.ok === false) {
    setStatus("이미 자동 캡처가 진행 중입니다.", "error");
    return;
  }
  setStatus("키워드 자동 수집을 시작했습니다.", "ok");
}

async function handleBatchStop() {
  const stopBtn = document.getElementById("batchStopBtn");
  stopBtn.disabled = true;
  setStatus("중지 처리 중...", "");
  const response = await chrome.runtime.sendMessage({ type: "STOP_BATCH" });
  stopBtn.disabled = false;
  if (response && response.wasRunning === false) {
    setStatus("이미 멈춰 있습니다.", "");
    const { batchStatus } = await chrome.storage.local.get("batchStatus");
    if (batchStatus && batchStatus.running) {
      await chrome.storage.local.set({ batchStatus: { ...batchStatus, running: false, error: "interrupted" } });
    }
  } else {
    setStatus("중지 요청을 보냈습니다. 진행 중인 상품을 마치는 대로 멈춥니다.", "");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const records = await getRecords();
  renderList(records);

  const { batchStatus } = await chrome.storage.local.get("batchStatus");
  renderBatchStatus(batchStatus);

  if (batchStatus && batchStatus.running) {
    // The stored state says a batch is running; ping the background
    // worker so it can wake up (if Chrome terminated it) and repair
    // stale "running" state left over from an interrupted batch.
    chrome.runtime.sendMessage({ type: "PING" }, () => void chrome.runtime.lastError);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.batchStatus) renderBatchStatus(changes.batchStatus.newValue);
    if (changes.records) renderList(Array.isArray(changes.records.newValue) ? changes.records.newValue : []);
  });

  document.getElementById("captureBtn").addEventListener("click", handleCapture);
  document.getElementById("captureOpenTabsBtn").addEventListener("click", handleCaptureOpenTabs);
  document.getElementById("downloadBtn").addEventListener("click", handleDownload);
  document.getElementById("clearBtn").addEventListener("click", handleClear);
  document.getElementById("batchStartBtn").addEventListener("click", handleBatchStart);
  document.getElementById("keywordStartBtn").addEventListener("click", handleKeywordStart);
  document.getElementById("batchStopBtn").addEventListener("click", handleBatchStop);
});
