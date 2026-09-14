// Functions in this file are injected into Coupang pages via
// chrome.scripting.executeScript({ func: ... }). Each must stay
// self-contained (no references to outer closures) because the
// browser re-serializes the function body and runs it inside the
// target page's own context.
//
// extractCapturedItemKey() below is the one exception — it's a plain
// string helper (not page-injected) shared between popup.js and
// background.js via a normal <script>/importScripts include, used to
// tell whether two captured records are the same seller offer.

// Coupang product URLs carry several ids: the productId in the path
// is a listing *group* — the same productId can be sold by several
// different sellers, each with their own vendorItemId — while
// clickEventId/searchId/traceId etc. are just per-visit tracking noise
// that differs every time even for the exact same offer. So dedupe by
// vendorItemId (the most specific real identifier) when present,
// falling back to itemId, then productId, then the raw URL.
function extractCapturedItemKey(url) {
  try {
    const u = new URL(url);
    const vendorItemId = u.searchParams.get("vendorItemId");
    if (vendorItemId) return `v:${vendorItemId}`;
    const itemId = u.searchParams.get("itemId");
    if (itemId) return `i:${itemId}`;
    const m = u.pathname.match(/\/vp\/products\/(\d+)/);
    if (m) return `p:${m[1]}`;
    return url || "";
  } catch (err) {
    const m = (url || "").match(/\/vp\/products\/(\d+)/);
    return m ? `p:${m[1]}` : url || "";
  }
}

// --- Google Sheets sync helpers -------------------------------------
// Extension-context only (chrome.storage / fetch aren't available
// inside an injected page script) — never pass these to
// chrome.scripting.executeScript. Used from both popup.js and
// background.js, which is why they live here instead of being
// duplicated in each.

async function getSheetWebAppUrl() {
  const { sheetWebAppUrl } = await chrome.storage.local.get("sheetWebAppUrl");
  return sheetWebAppUrl || "";
}

// Sends records to the Apps Script web app in chunks (its execution
// time/payload limits make one huge POST risky). Uses
// "text/plain" as the content type on purpose: a JSON content type
// triggers a CORS preflight (OPTIONS) request that Apps Script web
// apps don't handle, which would make every sync silently fail.
async function postRecordsToSheet(records) {
  const url = await getSheetWebAppUrl();
  if (!url) return { ok: false, reason: "no_url" };
  if (!records || records.length === 0) return { ok: true, added: 0 };

  const CHUNK_SIZE = 100;
  let added = 0;
  let duplicates = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ records: chunk }),
      });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return { ok: false, reason: "response_not_ok", added, duplicates };
      added += data.added != null ? data.added : chunk.length;
      duplicates += data.duplicates || 0;
    } catch (err) {
      return { ok: false, reason: "network_error", added, duplicates };
    }
  }
  return { ok: true, added, duplicates };
}

// Runs on any Coupang page. Detects known access-blocked pages —
// Coupang's own "사용권한이 없습니다" page, and the Akamai
// (errors.edgesuite.net) "Access Denied" edge block that can trigger
// before the request even reaches Coupang's app servers — so the
// caller can stop instead of plowing through the rest of the batch
// against a wall.
function isCoupangBlockedPage() {
  const norm = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
  const text = document.body ? document.body.innerText || document.body.textContent || "" : "";
  const normalized = norm(text);
  if (normalized.includes(norm("사용권한이 없습니다"))) return true;
  if (normalized.includes(norm("Access Denied")) && normalized.includes(norm("don't have permission to access"))) return true;
  return false;
}

// Runs on a product detail page.
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

// Runs on a product detail page. The seller info block only renders
// after the "배송/교환/반품 안내" tab is opened, so click it first.
function clickShippingTabIfPresent() {
  const norm = (s) => (s || "").replace(/\s+/g, "");
  const els = Array.from(document.querySelectorAll("a, button, li, div, span"));
  const target = els.find((el) => {
    if (el.children && el.children.length > 2) return false;
    const t = norm(el.textContent);
    if (t === "배송/교환/반품안내") return true;
    return t.length < 20 && t.includes("배송") && t.includes("교환") && t.includes("반품") && t.includes("안내");
  });
  if (target) {
    target.click();
    return true;
  }
  return false;
}

// Runs on a Coupang search/category listing page. Clicks the site's
// own "판매자로켓" filter chip/checkbox if one is visible, so the
// search results are filtered by Coupang's own (authoritative) logic
// instead of relying only on scanning rendered badge text — a badge
// shown as an icon with no text would be invisible to that scan.
// Returns whether a filter control was found and clicked.
function clickRocketFilterIfPresent() {
  const norm = (s) => (s || "").replace(/\s+/g, "");
  const candidates = Array.from(document.querySelectorAll("label, button, a, li, div, span"));
  const target = candidates.find((el) => {
    if (el.children && el.children.length > 3) return false;
    return norm(el.textContent) === "판매자로켓";
  });
  if (!target) return false;

  const input = target.querySelector && target.querySelector('input[type="checkbox"], input[type="radio"]');
  if (input) {
    input.click();
  } else {
    target.click();
  }
  return true;
}

// Walks up from a product anchor to the largest ancestor that still
// belongs to just that one product card — stops as soon as a parent
// would span more than one product anchor (i.e. the shared list
// container). Coupang's card markup uses hashed/rotating class names
// so this counts sibling product links instead of matching a class.
function findProductCardContainer(anchor) {
  let current = anchor;
  while (current.parentElement && current.parentElement !== document.body) {
    const parent = current.parentElement;
    if (parent.querySelectorAll('a[href*="/vp/products/"]').length > 1) break;
    current = parent;
  }
  return current;
}

// Runs on a Coupang search/category listing page. Pass rocketOnly:
// true to keep only cards showing a "로켓" delivery badge
// (판매자로켓/로켓배송/로켓프레시/로켓직구 all contain "로켓").
function findProductLinksOnListingPage(rocketOnly) {
  const anchors = Array.from(document.querySelectorAll('a[href*="/vp/products/"]'));
  const seen = new Set();
  const links = [];
  for (const a of anchors) {
    const href = a.href;
    const m = href.match(/\/vp\/products\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;

    if (rocketOnly) {
      const container = findProductCardContainer(a);
      const text = container ? container.textContent || "" : "";
      if (!text.includes("로켓")) continue;
    }

    seen.add(id);
    links.push(href);
  }
  return links;
}

// Runs on a Gmail compose tab (mail.google.com) that background.js just
// opened via the compose URL scheme (view=cm&to=&su=&body=). Shows a
// countdown banner and, when it reaches 0, clicks Gmail's own Send
// button — so whatever the user edited in the compose box during the
// countdown is exactly what goes out, since this operates the real
// compose UI rather than submitting separately-held content. A visible
// "지금 취소" always beats the timer; the send is never silent.
function startGmailAutoSendCountdown(countdownSeconds) {
  function findSendButton() {
    const candidates = Array.from(document.querySelectorAll('div[role="button"], [role="button"]'));
    return candidates.find((el) => {
      const label = (el.getAttribute("aria-label") || "").trim();
      return label.includes("보내기") || /^send\b/i.test(label);
    });
  }

  function makeBanner() {
    const banner = document.createElement("div");
    banner.id = "__coupang_ext_autosend_banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:#111827;color:#fff;padding:10px 16px;" +
      "font-family:-apple-system,sans-serif;font-size:14px;" +
      "display:flex;align-items:center;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.3);";

    const text = document.createElement("span");
    text.id = "__coupang_ext_autosend_text";
    banner.appendChild(text);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "지금 취소";
    cancelBtn.style.cssText = "padding:5px 10px;border:none;border-radius:5px;background:#dc2626;color:#fff;cursor:pointer;font-size:13px;";
    banner.appendChild(cancelBtn);

    const nowBtn = document.createElement("button");
    nowBtn.textContent = "지금 바로 전송";
    nowBtn.style.cssText = "padding:5px 10px;border:none;border-radius:5px;background:#16a34a;color:#fff;cursor:pointer;font-size:13px;";
    banner.appendChild(nowBtn);

    document.body.appendChild(banner);
    return { banner, text, cancelBtn, nowBtn };
  }

  let cancelled = false;
  let pollAttempts = 0;

  const waitForCompose = setInterval(() => {
    pollAttempts++;
    const sendBtn = findSendButton();
    if (sendBtn) {
      clearInterval(waitForCompose);
      runCountdown();
      return;
    }
    if (pollAttempts > 20) {
      clearInterval(waitForCompose);
      const { text, cancelBtn, nowBtn } = makeBanner();
      text.textContent = "작성창을 찾지 못했습니다. 직접 '보내기'를 눌러주세요.";
      cancelBtn.style.display = "none";
      nowBtn.style.display = "none";
    }
  }, 500);

  function runCountdown() {
    const { banner, text, cancelBtn, nowBtn } = makeBanner();
    let remaining = countdownSeconds;

    const render = () => {
      text.textContent = `이 메일은 ${remaining}초 후 자동으로 전송됩니다. 지금 작성창에서 내용을 수정하셔도 됩니다.`;
    };
    render();

    const tick = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(tick);
        doSend();
        return;
      }
      render();
    }, 1000);

    cancelBtn.addEventListener("click", () => {
      cancelled = true;
      clearInterval(tick);
      banner.remove();
    });

    nowBtn.addEventListener("click", () => {
      clearInterval(tick);
      doSend();
    });

    function doSend() {
      if (cancelled) return;
      const btn = findSendButton();
      if (btn) {
        btn.click();
        text.textContent = "전송했습니다.";
        cancelBtn.style.display = "none";
        nowBtn.style.display = "none";
        setTimeout(() => banner.remove(), 3000);
      } else {
        text.textContent = "전송 버튼을 찾지 못했습니다. 직접 '보내기'를 눌러주세요.";
        cancelBtn.style.display = "none";
        nowBtn.style.display = "none";
      }
    }
  }
}
