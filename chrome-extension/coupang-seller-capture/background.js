importScripts("shared.js");

const MAX_PRODUCTS_PER_BATCH = 30;
const MAX_KEYWORDS_PER_BATCH = 50;
const TAB_LOAD_TIMEOUT_MS = 15000;
const DELAY_AFTER_LOAD_MS = 900;
const DELAY_AFTER_TAB_CLICK_MS = 1200;
// Base pacing delays between requests. These get random jitter added
// (see delayWithJitter) so the request cadence doesn't look like a
// perfectly uniform bot interval, and they're intentionally
// conservative — the goal is to look like unhurried manual browsing,
// not to squeeze out maximum throughput.
const DELAY_BETWEEN_PRODUCTS_MS = 4000;
const DELAY_BETWEEN_KEYWORDS_MS = 8000;

// In-memory flags for the running batch. Checked directly (no storage
// round-trip) so "중지" takes effect within one checkpoint instead of
// waiting on an async read. These only live as long as this service
// worker instance does; see the startup reconciliation block at the
// bottom for what happens if Chrome terminates the worker mid-batch.
let isRunning = false;
let cancelRequested = false;
let stopReason = ""; // "cancelled" | "blocked" | ""

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithJitter(baseMs, jitterRatio = 0.35) {
  const jitter = Math.floor(baseMs * jitterRatio * Math.random());
  return delay(baseMs + jitter);
}

function formatDateTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildCoupangSearchUrl(keyword) {
  return `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&channel=user`;
}

async function getBatchStatus() {
  const { batchStatus } = await chrome.storage.local.get("batchStatus");
  return (
    batchStatus || {
      running: false,
      mode: "",
      total: 0,
      done: 0,
      failed: 0,
      duplicates: 0,
      currentTitle: "",
      keywordTotal: 0,
      keywordDone: 0,
      currentKeyword: "",
    }
  );
}

async function setBatchStatus(patch) {
  const current = await getBatchStatus();
  await chrome.storage.local.set({ batchStatus: { ...current, ...patch } });
}

// Skips adding a record if the same seller offer (see
// extractCapturedItemKey in shared.js) is already stored, so
// re-capturing a tab/product that was already saved — pressing the
// shortcut twice, running "열려있는 탭 모두 캡처" again, the same
// product surfacing under two different keywords — doesn't pile up
// duplicate rows in the CSV. Returns whether it actually added a row.
//
// Also best-effort pushes the new record straight to the configured
// Google Sheet (see postRecordsToSheet in shared.js). If that isn't
// configured or the request fails, the record just stays
// sheetSynced: false — the "지금 동기화" button in the popup catches
// up anything still unsynced, so a flaky network never loses data.
async function appendRecord(record) {
  const { records } = await chrome.storage.local.get("records");
  const list = Array.isArray(records) ? records : [];
  const key = extractCapturedItemKey(record.pageUrl);
  const alreadyCaptured = list.some((r) => extractCapturedItemKey(r.pageUrl) === key);
  if (alreadyCaptured) return { added: false };

  const newRecord = { ...record, sheetSynced: false };
  list.push(newRecord);
  await chrome.storage.local.set({ records: list });

  const syncResult = await postRecordsToSheet([newRecord]).catch(() => ({ ok: false }));
  if (syncResult && syncResult.ok) {
    const { records: latest } = await chrome.storage.local.get("records");
    const latestList = Array.isArray(latest) ? latest : [];
    const idx = latestList.findIndex((r) => extractCapturedItemKey(r.pageUrl) === key);
    if (idx !== -1) latestList[idx].sheetSynced = true;
    await chrome.storage.local.set({ records: latestList });
  }

  return { added: true };
}

function markBlocked() {
  cancelRequested = true;
  stopReason = "blocked";
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function closeTabSafely(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // tab may already be closed
  }
}

async function checkBlockedOnTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: isCoupangBlockedPage,
    });
    return !!(results && results[0] && results[0].result);
  } catch (err) {
    return false;
  }
}

// Opens a Coupang search results page for `keyword`, harvests the
// product links on it, and closes the tab. Returns { links, blocked }
// — a bad/empty keyword just yields links: [], but a detected block
// page sets blocked: true so the caller stops the whole run instead
// of continuing to hammer a page that's actively refusing access.
async function fetchKeywordProductLinks(keyword, rocketOnly) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: buildCoupangSearchUrl(keyword), active: false });
  } catch (err) {
    return { links: [], blocked: false };
  }
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    if (cancelRequested) return { links: [], blocked: false };
    await delayWithJitter(DELAY_AFTER_LOAD_MS);
    if (cancelRequested) return { links: [], blocked: false };

    if (await checkBlockedOnTab(tab.id)) {
      markBlocked();
      return { links: [], blocked: true };
    }

    if (rocketOnly) {
      const clicked = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: clickRocketFilterIfPresent,
      });
      if (clicked && clicked[0] && clicked[0].result) {
        await delayWithJitter(1000);
        if (cancelRequested) return { links: [], blocked: false };
      }
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: findProductLinksOnListingPage,
      args: [!!rocketOnly],
    });
    const links = (results && results[0] && results[0].result) || [];
    return { links, blocked: false };
  } catch (err) {
    return { links: [], blocked: false };
  } finally {
    await closeTabSafely(tab.id);
  }
}

// Processes one product tab, bailing out early at each checkpoint if
// the user has requested a stop, so cancellation doesn't have to wait
// for the slowest step (tab load) to finish. `keyword` is recorded
// alongside the seller info when this product came from a keyword
// search, so the CSV can be grouped by keyword; it's "" for captures
// triggered from a listing page or a single product page.
async function processOneProduct(url, keyword) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    if (cancelRequested) return { ok: false, cancelled: true };
    await delayWithJitter(DELAY_AFTER_LOAD_MS);
    if (cancelRequested) return { ok: false, cancelled: true };

    if (await checkBlockedOnTab(tab.id)) {
      markBlocked();
      return { ok: false, blocked: true };
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickShippingTabIfPresent,
    });
    if (cancelRequested) return { ok: false, cancelled: true };
    await delayWithJitter(DELAY_AFTER_TAB_CLICK_MS);
    if (cancelRequested) return { ok: false, cancelled: true };

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCoupangSellerInfo,
    });
    const result = injectionResults && injectionResults[0] && injectionResults[0].result;

    if (result && result.success) {
      const { added } = await appendRecord({
        ...result.data,
        keyword: keyword || "",
        capturedAt: formatDateTime(new Date()),
      });
      return { ok: true, title: result.data.productTitle, duplicate: !added };
    }
    return { ok: false, title: "", reason: result ? result.reason : "no_result" };
  } catch (err) {
    return { ok: false, title: "", reason: "exception" };
  } finally {
    await closeTabSafely(tab.id);
  }
}

// Extracts seller info from a tab that's already loaded — no
// navigation, no new request beyond the in-page "배송/교환/반품
// 안내" click if the info isn't showing yet. Used by both the
// keyboard-shortcut single capture and the "capture all open tabs"
// feature below.
async function extractFromTab(tabId) {
  const tryOnce = async () => {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: extractCoupangSellerInfo });
    return r && r[0] && r[0].result;
  };
  let result = await tryOnce();
  if (result && !result.success && result.reason === "not_found") {
    await chrome.scripting.executeScript({ target: { tabId }, func: clickShippingTabIfPresent });
    await delay(600);
    result = await tryOnce();
  }
  return result;
}

const PRODUCT_URL_PATTERN = /\/vp\/products\/\d+/;

async function findOpenProductTabs() {
  const tabs = await chrome.tabs.query({ url: "*://www.coupang.com/*" });
  return tabs.filter((t) => t.url && PRODUCT_URL_PATTERN.test(t.url));
}

// Reads seller info out of tabs the user already has open (opened by
// their own clicks, not created by this extension) instead of
// creating any new navigation. No new HTTP requests originate from
// this extension here, so it carries essentially none of the
// request-pattern risk the auto-navigating batch modes do.
async function captureOpenTabs() {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";

  const tabs = await findOpenProductTabs();

  await setBatchStatus({
    running: true,
    mode: "open-tabs",
    total: tabs.length,
    done: 0,
    failed: 0,
    duplicates: 0,
    currentTitle: "",
    error: "",
    startedAt: Date.now(),
  });

  if (tabs.length === 0) {
    isRunning = false;
    await setBatchStatus({ running: false, error: "no_open_tabs" });
    return;
  }

  for (let i = 0; i < tabs.length; i++) {
    if (cancelRequested) break;
    const tab = tabs[i];

    if (await checkBlockedOnTab(tab.id)) {
      markBlocked();
      break;
    }

    const result = await extractFromTab(tab.id);
    const status = await getBatchStatus();
    if (result && result.success) {
      const { added } = await appendRecord({ ...result.data, keyword: "", capturedAt: formatDateTime(new Date()) });
      await setBatchStatus({
        done: status.done + 1,
        duplicates: status.duplicates + (added ? 0 : 1),
        currentTitle: result.data.productTitle,
      });
    } else {
      await setBatchStatus({ done: status.done + 1, failed: status.failed + 1 });
    }

    if (cancelRequested) break;
    if (i < tabs.length - 1) await delayWithJitter(1200, 0.5);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

async function startBatch(sourceTabId, rocketOnly) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";

  let links = [];
  try {
    if (rocketOnly) {
      const clicked = await chrome.scripting.executeScript({
        target: { tabId: sourceTabId },
        func: clickRocketFilterIfPresent,
      });
      if (clicked && clicked[0] && clicked[0].result) {
        await delayWithJitter(1000);
      }
    }

    const linkResults = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      func: findProductLinksOnListingPage,
      args: [!!rocketOnly],
    });
    links = (linkResults && linkResults[0] && linkResults[0].result) || [];
  } catch (err) {
    isRunning = false;
    await setBatchStatus({ running: false, mode: "listing", error: "listing_read_failed" });
    return;
  }

  const capped = links.slice(0, MAX_PRODUCTS_PER_BATCH);

  await setBatchStatus({
    running: true,
    mode: "listing",
    total: capped.length,
    done: 0,
    failed: 0,
    duplicates: 0,
    currentTitle: "",
    error: "",
    startedAt: Date.now(),
  });

  if (capped.length === 0) {
    isRunning = false;
    await setBatchStatus({ running: false, error: "no_links_found" });
    return;
  }

  for (let i = 0; i < capped.length; i++) {
    if (cancelRequested) break;

    const res = await processOneProduct(capped[i], "");
    const status = await getBatchStatus();
    await setBatchStatus({
      done: status.done + 1,
      failed: status.failed + (res.ok ? 0 : 1),
      duplicates: status.duplicates + (res.duplicate ? 1 : 0),
      currentTitle: res.title || status.currentTitle,
    });

    if (res.cancelled || res.blocked || cancelRequested) break;
    if (i < capped.length - 1) await delayWithJitter(DELAY_BETWEEN_PRODUCTS_MS);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

async function startKeywordBatch(rawKeywords, perKeywordCount, rocketOnly) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";

  const keywords = rawKeywords
    .map((k) => (k || "").trim())
    .filter((k) => k.length > 0)
    .slice(0, MAX_KEYWORDS_PER_BATCH);
  const perKeyword = Math.min(Math.max(1, perKeywordCount || MAX_PRODUCTS_PER_BATCH), MAX_PRODUCTS_PER_BATCH);

  if (keywords.length === 0) {
    isRunning = false;
    await setBatchStatus({ running: false, mode: "keywords", error: "no_keywords" });
    return;
  }

  await setBatchStatus({
    running: true,
    mode: "keywords",
    keywordTotal: keywords.length,
    keywordDone: 0,
    currentKeyword: "",
    total: 0,
    done: 0,
    failed: 0,
    duplicates: 0,
    currentTitle: "",
    error: "",
    startedAt: Date.now(),
  });

  for (let k = 0; k < keywords.length; k++) {
    if (cancelRequested) break;
    const keyword = keywords[k];
    await setBatchStatus({ currentKeyword: keyword, total: 0, done: 0, currentTitle: "" });

    const { links, blocked } = await fetchKeywordProductLinks(keyword, rocketOnly);
    if (blocked || cancelRequested) break;

    const capped = links.slice(0, perKeyword);
    await setBatchStatus({ total: capped.length });

    let keywordStoppedEarly = false;
    for (let i = 0; i < capped.length; i++) {
      if (cancelRequested) {
        keywordStoppedEarly = true;
        break;
      }
      const res = await processOneProduct(capped[i], keyword);
      const status = await getBatchStatus();
      await setBatchStatus({
        done: status.done + 1,
        failed: status.failed + (res.ok ? 0 : 1),
        duplicates: status.duplicates + (res.duplicate ? 1 : 0),
        currentTitle: res.title || status.currentTitle,
      });
      if (res.cancelled || res.blocked || cancelRequested) {
        keywordStoppedEarly = true;
        break;
      }
      if (i < capped.length - 1) await delayWithJitter(DELAY_BETWEEN_PRODUCTS_MS);
    }

    if (keywordStoppedEarly) break;

    const status = await getBatchStatus();
    await setBatchStatus({ keywordDone: status.keywordDone + 1 });

    if (k < keywords.length - 1) await delayWithJitter(DELAY_BETWEEN_KEYWORDS_MS);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "START_BATCH" && message.sourceTabId) {
    if (isRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startBatch(message.sourceTabId, message.rocketOnly);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "START_KEYWORD_BATCH" && Array.isArray(message.keywords)) {
    if (isRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startKeywordBatch(message.keywords, message.perKeywordCount, message.rocketOnly);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "CAPTURE_OPEN_TABS") {
    if (isRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    captureOpenTabs();
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "STOP_BATCH") {
    cancelRequested = true;
    stopReason = "cancelled";
    sendResponse({ ok: true, wasRunning: isRunning });
    return false;
  }
  if (message && message.type === "PING") {
    sendResponse({ ok: true, isRunning });
    return false;
  }
  return false;
});

function flashActionBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 1500);
}

// Keyboard-shortcut capture for genuine manual browsing: the user
// opens product pages themselves (clicking links/tabs like any normal
// shopper) and just presses the shortcut on each one instead of
// opening the popup and clicking the capture button. Every page load
// here is a real user navigation, not something this extension
// triggered, so it carries none of the request-pattern risk that the
// batch/keyword auto-capture modes do.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-current-page") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    const result = await extractFromTab(tab.id);

    if (result && result.success) {
      const { added } = await appendRecord({ ...result.data, keyword: "", capturedAt: formatDateTime(new Date()) });
      if (added) {
        flashActionBadge(tab.id, "OK", "#16a34a");
      } else {
        flashActionBadge(tab.id, "DUP", "#d97706");
      }
    } else {
      flashActionBadge(tab.id, "X", "#dc2626");
    }
  } catch (err) {
    flashActionBadge(tab.id, "X", "#dc2626");
  }
});

// Chrome can terminate an idle MV3 service worker and restart it later
// on the next event; any in-flight batch loop (and its in-memory
// isRunning/cancelRequested flags) is lost when that happens, which
// would otherwise leave batchStatus stuck at running:true forever with
// nothing left to respond to "중지". This runs once whenever the
// worker starts up and repairs that stale state.
(async () => {
  const status = await getBatchStatus();
  if (status.running && !isRunning) {
    await setBatchStatus({ running: false, error: "interrupted" });
  }
})();
