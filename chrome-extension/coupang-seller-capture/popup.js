const FIELD_DEFS = [
  { key: "sellerName", labels: ["상호/대표자", "상호 / 대표자", "상호명/대표자", "상호"] },
  { key: "address", labels: ["사업장 소재지", "소재지"] },
  { key: "email", labels: ["e-mail", "E-mail", "이메일"] },
  { key: "phone", labels: ["연락처"] },
  { key: "mailOrderNo", labels: ["통신판매업 신고번호", "통신판매업신고번호"] },
  { key: "bizRegNo", labels: ["사업자번호", "사업자등록번호"] },
  { key: "safetyService", labels: ["구매안전서비스"] },
];

const CSV_COLUMNS = [
  { key: "capturedAt", header: "캡처일시" },
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

// Runs inside the target page via chrome.scripting.executeScript.
// Must be self-contained: no references to outer scope.
function extractCoupangSellerInfo() {
  const norm = (s) => s.replace(/\s+/g, "");

  const labelMap = [
    { key: "sellerName", labels: ["상호/대표자", "상호 / 대표자", "상호명/대표자", "상호"] },
    { key: "address", labels: ["사업장 소재지", "소재지"] },
    { key: "email", labels: ["e-mail", "E-mail", "이메일"] },
    { key: "phone", labels: ["연락처"] },
    { key: "mailOrderNo", labels: ["통신판매업 신고번호", "통신판매업신고번호"] },
    { key: "bizRegNo", labels: ["사업자번호", "사업자등록번호"] },
    { key: "safetyService", labels: ["구매안전서비스"] },
  ];

  const bodyText = document.body ? document.body.innerText || document.body.textContent || "" : "";
  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]) === "판매자정보") startIdx = i;
  }
  if (startIdx === -1) return { success: false, reason: "not_found" };

  const windowLines = lines.slice(startIdx, startIdx + 60);
  const isAnyLabel = (line) =>
    labelMap.some((e) => e.labels.some((l) => norm(line) === norm(l)));

  const result = {};
  for (let i = 0; i < windowLines.length; i++) {
    const line = windowLines[i];
    for (const entry of labelMap) {
      if (result[entry.key]) continue;
      if (entry.labels.some((l) => norm(line) === norm(l))) {
        for (let j = i + 1; j < windowLines.length; j++) {
          const candidate = windowLines[j];
          if (candidate.length > 0 && !isAnyLabel(candidate)) {
            result[entry.key] = candidate;
            break;
          }
        }
      }
    }
  }

  if (Object.keys(result).length === 0) return { success: false, reason: "no_fields" };

  return {
    success: true,
    data: {
      sellerName: result.sellerName || "",
      address: result.address || "",
      email: result.email || "",
      phone: result.phone || "",
      mailOrderNo: result.mailOrderNo || "",
      bizRegNo: result.bizRegNo || "",
      safetyService: result.safetyService || "",
      productTitle: document.title || "",
      pageUrl: location.href,
    },
  };
}

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

document.addEventListener("DOMContentLoaded", async () => {
  const records = await getRecords();
  renderList(records);

  document.getElementById("captureBtn").addEventListener("click", handleCapture);
  document.getElementById("downloadBtn").addEventListener("click", handleDownload);
  document.getElementById("clearBtn").addEventListener("click", handleClear);
});
