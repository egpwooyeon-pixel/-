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

// Mirrors repeatCycleState.running (chrome.storage) in memory so the
// other "already_running" guards below can check it synchronously,
// without an extra storage round-trip on every button click. Reset to
// false on service-worker startup and reconstructed from storage if a
// cycle was actually still running — see the startup reconciliation
// block at the bottom.
let repeatCycleRunning = false;

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

const SELLER_DEALS_URL = "https://www.coupang.com/np/omp";

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

  const newRecord = { ...record, itemKey: key, sheetSynced: false };
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

// Same idea as fetchKeywordProductLinks, but for the "판매자특가" hub
// page (coupang.com/np/omp) — that page has one fixed URL and filters
// in place via its own in-page search box instead of a ?q= URL, so this
// opens the fixed URL once and drives that search box via
// searchSellerDealsPage() (see shared.js) rather than building a
// per-keyword URL. searchFailed: true means the search box itself
// couldn't be found/used (Coupang changed the page's markup) — distinct
// from an empty result, so the caller can tell "no matches" apart from
// "couldn't even search".
async function fetchSellerDealsProductLinks(keyword, rocketOnly) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: SELLER_DEALS_URL, active: false });
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

    const searchResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: searchSellerDealsPage,
      args: [keyword],
    });
    const searchOk = !!(searchResults && searchResults[0] && searchResults[0].result && searchResults[0].result.ok);
    if (!searchOk) {
      return { links: [], blocked: false, searchFailed: true };
    }
    if (cancelRequested) return { links: [], blocked: false };

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
async function captureOpenTabs(closeAfterCapture) {
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
      if (closeAfterCapture) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch (err) {
          // tab may already be closed; nothing to do
        }
      }
    } else {
      // Deliberately left open even when closeAfterCapture is on — a
      // failed tab is exactly the one the user needs to go look at.
      await setBatchStatus({ done: status.done + 1, failed: status.failed + 1 });
    }

    if (cancelRequested) break;
    if (i < tabs.length - 1) await delayWithJitter(1200, 0.5);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

// productDelaySeconds (from the popup's "상품 사이 대기시간" field)
// overrides the default DELAY_BETWEEN_PRODUCTS_MS pacing when given —
// lets the user slow things down further if they're seeing blocks even
// at the default pace, without needing a code change each time.
function resolveProductDelayMs(productDelaySeconds) {
  const seconds = Number(productDelaySeconds);
  if (!Number.isFinite(seconds) || seconds < 3) return DELAY_BETWEEN_PRODUCTS_MS;
  return Math.min(seconds, 120) * 1000;
}

async function startBatch(sourceTabId, rocketOnly, productDelaySeconds) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";
  const productDelayMs = resolveProductDelayMs(productDelaySeconds);

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
    if (i < capped.length - 1) await delayWithJitter(productDelayMs);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

async function startKeywordBatch(rawKeywords, perKeywordCount, rocketOnly, source, productDelaySeconds) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";
  const useSellerDeals = source === "sellerDeals";
  const productDelayMs = resolveProductDelayMs(productDelaySeconds);

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

    const { links, blocked, searchFailed } = useSellerDeals
      ? await fetchSellerDealsProductLinks(keyword, rocketOnly)
      : await fetchKeywordProductLinks(keyword, rocketOnly);
    if (blocked || cancelRequested) break;
    if (searchFailed) {
      // Couldn't even use the page's search box this time — skip this
      // keyword rather than silently scraping whatever unfiltered/wrong
      // set happened to be on screen, and keep going with the rest.
      const status = await getBatchStatus();
      await setBatchStatus({ keywordDone: status.keywordDone + 1 });
      if (k < keywords.length - 1) await delayWithJitter(DELAY_BETWEEN_KEYWORDS_MS);
      continue;
    }

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
      if (i < capped.length - 1) await delayWithJitter(productDelayMs);
    }

    if (keywordStoppedEarly) break;

    const status = await getBatchStatus();
    await setBatchStatus({ keywordDone: status.keywordDone + 1 });

    if (k < keywords.length - 1) await delayWithJitter(DELAY_BETWEEN_KEYWORDS_MS);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

// Same keyword → link-gathering as startKeywordBatch, but instead of
// opening each product tab, extracting, and closing it, this just opens
// the tab and leaves it there — no click-through, no data extraction, no
// closing. The idea (per user request): the automated part that risks
// looking bot-like is opening pages quickly, so keep just that part,
// pace it slowly, and let the user run the existing (safest) "열려있는
// 쿠팡 상품 탭 모두 캡처" afterward — that one only reads tabs already
// open, no new requests at all.
async function startOpenProductTabs(rawKeywords, perKeywordCount, rocketOnly, source, productDelaySeconds) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";
  const useSellerDeals = source === "sellerDeals";
  const productDelayMs = resolveProductDelayMs(productDelaySeconds);

  const keywords = rawKeywords
    .map((k) => (k || "").trim())
    .filter((k) => k.length > 0)
    .slice(0, MAX_KEYWORDS_PER_BATCH);
  const perKeyword = Math.min(Math.max(1, perKeywordCount || MAX_PRODUCTS_PER_BATCH), MAX_PRODUCTS_PER_BATCH);

  if (keywords.length === 0) {
    isRunning = false;
    await setBatchStatus({ running: false, mode: "open-tabs-keywords", error: "no_keywords" });
    return;
  }

  await setBatchStatus({
    running: true,
    mode: "open-tabs-keywords",
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

    let blocked = false;
    let searchFailed = false;
    let keywordStoppedEarly = false;

    if (useSellerDeals) {
      // These cards have no href to harvest up front (see
      // clickSellerDealsProductCard in shared.js) — total is an upper
      // bound (perKeyword) rather than a known count, since we only
      // find out how many cards actually exist as we click through them.
      await setBatchStatus({ total: perKeyword });
      const result = await openSellerDealsProductTabsForKeyword(keyword, rocketOnly, perKeyword, productDelayMs);
      blocked = result.blocked;
      searchFailed = result.searchFailed;
      if (cancelRequested) keywordStoppedEarly = true;
    } else {
      const { links, blocked: linksBlocked } = await fetchKeywordProductLinks(keyword, rocketOnly);
      blocked = linksBlocked;
      if (!blocked && !cancelRequested) {
        const capped = links.slice(0, perKeyword);
        await setBatchStatus({ total: capped.length });
        for (let i = 0; i < capped.length; i++) {
          if (cancelRequested) {
            keywordStoppedEarly = true;
            break;
          }
          try {
            await chrome.tabs.create({ url: capped[i], active: false });
          } catch (err) {
            // couldn't open this one; still count it and move on
          }
          const status = await getBatchStatus();
          await setBatchStatus({ done: status.done + 1 });
          if (cancelRequested) {
            keywordStoppedEarly = true;
            break;
          }
          if (i < capped.length - 1) await delayWithJitter(productDelayMs);
        }
      }
    }

    if (blocked || cancelRequested) break;
    if (searchFailed) {
      const status = await getBatchStatus();
      await setBatchStatus({ keywordDone: status.keywordDone + 1 });
      if (k < keywords.length - 1) await delayWithJitter(DELAY_BETWEEN_KEYWORDS_MS);
      continue;
    }
    if (keywordStoppedEarly) break;

    const status = await getBatchStatus();
    await setBatchStatus({ keywordDone: status.keywordDone + 1 });

    if (k < keywords.length - 1) await delayWithJitter(DELAY_BETWEEN_KEYWORDS_MS);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stopReason });
}

// Seller-deals equivalent of fetchKeywordProductLinks + the tabs.create
// loop above, but click-driven: these cards have no href (see
// clickSellerDealsProductCard in shared.js) — a real hand-click was
// confirmed (by the user, live) to open the product in a brand-new tab
// — so instead of harvesting URLs up front, this opens the search-
// results tab once, searches it, then clicks through its cards one at a
// time, pacing between clicks the same way every other "one page at a
// time" flow here does. Keeps the search tab open until every click is
// done (unlike fetchSellerDealsProductLinks, which closes it right
// after harvesting), then closes just that one tab.
async function openSellerDealsProductTabsForKeyword(keyword, rocketOnly, perKeyword, productDelayMs) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: SELLER_DEALS_URL, active: false });
  } catch (err) {
    return { opened: 0, blocked: false };
  }
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    if (cancelRequested) return { opened: 0, blocked: false };
    await delayWithJitter(DELAY_AFTER_LOAD_MS);
    if (cancelRequested) return { opened: 0, blocked: false };

    if (await checkBlockedOnTab(tab.id)) {
      markBlocked();
      return { opened: 0, blocked: true };
    }

    const searchResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: searchSellerDealsPage,
      args: [keyword],
    });
    const searchOk = !!(searchResults && searchResults[0] && searchResults[0].result && searchResults[0].result.ok);
    if (!searchOk) return { opened: 0, blocked: false, searchFailed: true };
    if (cancelRequested) return { opened: 0, blocked: false };

    if (rocketOnly) {
      const clicked = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: clickRocketFilterIfPresent,
      });
      if (clicked && clicked[0] && clicked[0].result) {
        await delayWithJitter(1000);
        if (cancelRequested) return { opened: 0, blocked: false };
      }
    }

    let opened = 0;
    for (let i = 0; i < perKeyword; i++) {
      if (cancelRequested) break;
      let clickResult;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: clickSellerDealsProductCard,
          args: [i],
        });
        clickResult = results && results[0] && results[0].result;
      } catch (err) {
        break;
      }
      if (!clickResult || !clickResult.ok) break; // ran out of cards on this page

      opened++;
      const status = await getBatchStatus();
      await setBatchStatus({ done: status.done + 1 });
      if (cancelRequested) break;
      if (i < perKeyword - 1) await delayWithJitter(productDelayMs);
    }

    return { opened };
  } catch (err) {
    return { opened: 0, blocked: false };
  } finally {
    await closeTabSafely(tab.id);
  }
}

// --- 네이버 스토어 리뷰 수집 -----------------------------------------
// Reuses the same isRunning/cancelRequested flags as the Coupang batch
// flows above (only one automated run at a time, and "중지" works the
// same way), and the same pacing philosophy (one scroll-load at a time,
// with a jittered delay between them) rather than hammering the
// (infinite-scroll) review list quickly. clickNaverSortOption,
// loadMoreNaverReviews and extractVisibleNaverReviews (all in
// shared.js) were built and confirmed against real page markup the
// user provided — see the README for what's still unverified.

const NAVER_REVIEW_PAGE_DELAY_MS = 3000;
const NAVER_REVIEW_TARGET_PER_SORT = 500;
const NAVER_SORT_MODES = [
  { label: "최신순", matches: ["최신순"] },
  { label: "평점 낮은순", matches: ["평점낮은순", "평점 낮은순"] },
];

async function getNaverReviewStatus() {
  const { naverReviewStatus } = await chrome.storage.local.get("naverReviewStatus");
  return (
    naverReviewStatus || {
      running: false,
      phase: "",
      collected: 0,
      target: NAVER_REVIEW_TARGET_PER_SORT,
      total: 0,
      error: "",
    }
  );
}

async function setNaverReviewStatus(patch) {
  const current = await getNaverReviewStatus();
  await chrome.storage.local.set({ naverReviewStatus: { ...current, ...patch } });
}

// Each review's `data-shp-contents-id` (confirmed via live DevTools
// inspection) is a real, stable numeric review id — use it directly
// when present. Falls back to reviewer id + date + a body snippet for
// any Naver template that doesn't expose that id.
function naverReviewDedupeKey(review) {
  if (review.reviewId) return "id:" + review.reviewId;
  return [review.reviewerId, review.date, (review.body || "").slice(0, 40)].join("|");
}

async function appendNaverReviews(newReviews) {
  const { naverReviews } = await chrome.storage.local.get("naverReviews");
  const list = Array.isArray(naverReviews) ? naverReviews : [];
  const seen = new Set(list.map(naverReviewDedupeKey));
  let added = 0;
  newReviews.forEach((r) => {
    const key = naverReviewDedupeKey(r);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(r);
    added++;
  });
  await chrome.storage.local.set({ naverReviews: list });
  return added;
}

// clickNaverSortOption's first call may only open a dropdown menu
// ("opened_menu") instead of actually selecting the option, when the
// wanted label isn't directly visible yet — retrying a couple more
// times after a short wait covers that case (the option should be
// directly clickable once the menu is open).
async function setNaverSortWithRetry(tabId, matches) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let result;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: clickNaverSortOption,
        args: [matches],
      });
      result = results && results[0] && results[0].result;
    } catch (err) {
      return false;
    }
    if (result && result.ok) return true;
    if (!result || result.reason !== "opened_menu") return false;
    await delay(800);
  }
  return false;
}

// Collects up to NAVER_REVIEW_TARGET_PER_SORT reviews for each sort
// mode in NAVER_SORT_MODES, on the given tab (must already be a Naver
// product page with its review section visible/open). Clears any
// previously collected reviews at the start of each run — this is
// "give me a fresh 최신순 500 + 평점낮은순 500", not an accumulating log.
async function startNaverReviewCollection(tabId) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";

  await chrome.storage.local.set({ naverReviews: [] });
  await setNaverReviewStatus({
    running: true,
    phase: "",
    collected: 0,
    total: 0,
    target: NAVER_REVIEW_TARGET_PER_SORT,
    error: "",
    startedAt: Date.now(),
  });

  let pageUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url || "";
  } catch (err) {
    // ignore; pageUrl stays blank
  }

  for (const sortMode of NAVER_SORT_MODES) {
    if (cancelRequested) break;
    await setNaverReviewStatus({ phase: sortMode.label, collected: 0 });

    const sortOk = await setNaverSortWithRetry(tabId, sortMode.matches);
    if (!sortOk) {
      await setNaverReviewStatus({ error: `"${sortMode.label}" 정렬 버튼을 찾지 못해 건너뜀` });
      continue;
    }
    await delayWithJitter(1500);
    if (cancelRequested) break;

    let collectedForSort = 0;
    let pageCount = 0;
    const MAX_PAGES = 60; // safety cap in case pagination never signals "no more"

    while (collectedForSort < NAVER_REVIEW_TARGET_PER_SORT && pageCount < MAX_PAGES && !cancelRequested) {
      let pageReviews = [];
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractVisibleNaverReviews,
        });
        pageReviews = (results && results[0] && results[0].result) || [];
      } catch (err) {
        break;
      }

      const tagged = pageReviews.map((r) => ({
        ...r,
        sortLabel: sortMode.label,
        pageUrl,
        capturedAt: formatDateTime(new Date()),
      }));
      const added = await appendNaverReviews(tagged);
      collectedForSort += added;

      const status = await getNaverReviewStatus();
      await setNaverReviewStatus({ collected: collectedForSort, total: status.total + added });

      if (collectedForSort >= NAVER_REVIEW_TARGET_PER_SORT || cancelRequested) break;

      let hasNext = false;
      try {
        const nextResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: loadMoreNaverReviews,
        });
        hasNext = !!(nextResults && nextResults[0] && nextResults[0].result && nextResults[0].result.ok);
      } catch (err) {
        hasNext = false;
      }
      if (!hasNext) break;

      pageCount++;
      await delayWithJitter(NAVER_REVIEW_PAGE_DELAY_MS);
    }
  }

  isRunning = false;
  await setNaverReviewStatus({ running: false, error: cancelRequested ? "cancelled" : "" });
}

// --- 자동 반복 실행 (탭 열기 → 열려있는 탭 캡처+닫기를 주기적으로 반복) ----
// Chains the two existing, already-safe steps the user was doing by
// hand every time — "키워드로 상품 탭만 순서대로 열기" then "열려있는
// 쿠팡 상품 탭 모두 캡처" with auto-close on — into one repeating cycle,
// on a timer. Uses chrome.alarms rather than a plain setTimeout loop for
// the wait between cycles (same reasoning as the mail auto-send feature
// above): a bare in-memory delay can't survive Chrome killing an idle
// MV3 service worker, but an alarm does — Chrome wakes the worker
// specifically to fire it, so a multi-minute gap between cycles doesn't
// require this service worker to somehow stay alive the whole time.
const REPEAT_CYCLE_ALARM_NAME = "repeatCycleTick";

async function getRepeatCycleState() {
  const { repeatCycleState } = await chrome.storage.local.get("repeatCycleState");
  return (
    repeatCycleState || {
      running: false,
      keywords: [],
      perKeywordCount: 10,
      rocketOnly: false,
      source: "sellerDeals",
      productDelaySeconds: 10,
      cycleIntervalMinutes: 15,
      maxCycles: 20,
      cycleCount: 0,
      phase: "",
      error: "",
    }
  );
}

async function setRepeatCycleState(patch) {
  const current = await getRepeatCycleState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ repeatCycleState: next });
  return next;
}

// One full cycle: open tabs for the configured keywords, wait for that
// to finish, then capture+close whatever Coupang product tabs are open
// (not just the ones this cycle opened — same as the manual button),
// then leave the alarm to fire the next cycle later. If a previous
// cycle is somehow still mid-flight when the alarm fires again (it ran
// long), this tick just no-ops rather than overlapping with it.
async function runOneRepeatCycle() {
  const state = await getRepeatCycleState();
  if (!state.running) return;
  if (isRunning) return;

  if (state.cycleCount >= state.maxCycles) {
    await chrome.alarms.clear(REPEAT_CYCLE_ALARM_NAME);
    repeatCycleRunning = false;
    await setRepeatCycleState({ running: false, phase: "" });
    return;
  }

  await setRepeatCycleState({ phase: "상품 탭 여는 중" });
  await startOpenProductTabs(
    state.keywords,
    state.perKeywordCount,
    state.rocketOnly,
    state.source,
    state.productDelaySeconds
  );

  if (stopReason === "blocked" || cancelRequested) {
    await chrome.alarms.clear(REPEAT_CYCLE_ALARM_NAME);
    repeatCycleRunning = false;
    await setRepeatCycleState({ running: false, phase: "", error: stopReason || "cancelled" });
    return;
  }

  await setRepeatCycleState({ phase: "열려있는 탭 캡처 중" });
  await captureOpenTabs(true);

  if (stopReason === "blocked" || cancelRequested) {
    await chrome.alarms.clear(REPEAT_CYCLE_ALARM_NAME);
    repeatCycleRunning = false;
    await setRepeatCycleState({ running: false, phase: "", error: stopReason || "cancelled" });
    return;
  }

  const latest = await getRepeatCycleState();
  await setRepeatCycleState({ cycleCount: latest.cycleCount + 1, phase: "다음 회차 대기 중" });
}

async function startRepeatCycle(
  keywords,
  perKeywordCount,
  rocketOnly,
  source,
  productDelaySeconds,
  cycleIntervalMinutes,
  maxCycles
) {
  const state = await getRepeatCycleState();
  if (state.running || isRunning || repeatCycleRunning) return { ok: false, reason: "already_running" };

  const intervalMinutes = Math.max(1, cycleIntervalMinutes || 15);

  repeatCycleRunning = true;
  await setRepeatCycleState({
    running: true,
    keywords,
    perKeywordCount,
    rocketOnly,
    source,
    productDelaySeconds,
    cycleIntervalMinutes: intervalMinutes,
    maxCycles: Math.max(1, maxCycles || 20),
    cycleCount: 0,
    phase: "",
    error: "",
    startedAt: Date.now(),
  });

  await chrome.alarms.create(REPEAT_CYCLE_ALARM_NAME, { periodInMinutes: intervalMinutes });
  runOneRepeatCycle(); // first cycle right away instead of waiting a full interval
  return { ok: true };
}

async function stopRepeatCycle() {
  await chrome.alarms.clear(REPEAT_CYCLE_ALARM_NAME);
  repeatCycleRunning = false;
  await setRepeatCycleState({ running: false, phase: "" });
}

// --- Paced Gmail auto-send (mail-composer.html) ----------------------
// chrome.alarms (unlike the in-memory isRunning/cancelRequested flags
// above) survives service worker restarts — Chrome wakes the worker to
// fire it — so this state lives entirely in chrome.storage.local
// rather than module-level variables.

const MAIL_AUTOSEND_ALARM_NAME = "mailAutosendTick";

async function getMailAutosendState() {
  const { mailAutosend } = await chrome.storage.local.get("mailAutosend");
  return (
    mailAutosend || {
      running: false,
      queue: [],
      countdownSeconds: 60,
      intervalMinutes: 30,
      processedCount: 0,
      dailyLimit: 0,
      dailySentDate: "",
      dailySentCount: 0,
    }
  );
}

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function setMailAutosendState(patch) {
  const current = await getMailAutosendState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ mailAutosend: next });
  return next;
}

function buildGmailComposeUrl(to, subject, body) {
  return (
    "https://mail.google.com/mail/?view=cm&fs=1" +
    `&to=${encodeURIComponent(to)}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  );
}

// Opens the next pending item's Gmail compose tab (in the foreground,
// so the user actually sees the countdown banner and can edit/cancel),
// injects the countdown+auto-send script, and marks the item handled.
// One call = at most one tab opened, matching the alarm's pacing.
async function processNextMailAutosendItem() {
  const state = await getMailAutosendState();
  if (!state.running) return;

  const idx = state.queue.findIndex((item) => item.status === "pending");
  if (idx === -1) {
    await chrome.alarms.clear(MAIL_AUTOSEND_ALARM_NAME);
    await setMailAutosendState({ running: false });
    return;
  }

  // Daily send cap (spam/account-suspension avoidance). The alarm keeps
  // firing on its usual hourly-pace cadence regardless of the cap — once
  // the calendar date rolls over, dailySentCount resets and sending just
  // resumes on the next tick, no extra "resume tomorrow" logic needed.
  const today = todayKey();
  const dailySentCount = state.dailySentDate === today ? state.dailySentCount || 0 : 0;
  if (state.dailySentDate !== today) {
    await setMailAutosendState({ dailySentDate: today, dailySentCount: 0 });
  }
  if (state.dailyLimit > 0 && dailySentCount >= state.dailyLimit) {
    return; // today's cap reached; try again on the next tick (which may be tomorrow)
  }

  const item = state.queue[idx];
  const url = buildGmailComposeUrl(item.to, item.subject, item.body);

  // Marked "opened" as soon as the tab exists — before script injection,
  // not after — so if the service worker gets killed mid-call, the next
  // alarm tick won't re-open a second compose tab (and risk a duplicate
  // send) for the same recipient. Worst case on that rare timing is a
  // compose tab with no countdown banner, which just needs a manual send.
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: true });
  } catch (err) {
    return; // couldn't even open the tab; leave item pending, retry next tick
  }

  const latest = await getMailAutosendState();
  const latestIdx = latest.queue.findIndex((q) => q.to === item.to && q.status === "pending");
  if (latestIdx !== -1) latest.queue[latestIdx].status = "opened";
  await setMailAutosendState({
    queue: latest.queue,
    processedCount: latest.processedCount + 1,
    dailySentDate: today,
    dailySentCount: dailySentCount + 1,
  });

  // Best-effort: mark the spreadsheet row red/bold so it's visible at a
  // glance which rows are already handled. Doesn't block/undo the
  // compose tab already opened above if the sheet is unreachable.
  if (state.sheetUrl && item.itemKey) {
    markSheetRowSent(state.sheetUrl, item.itemKey);
  }

  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await delay(1500); // let Gmail's SPA finish rendering the compose dialog
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: startGmailAutoSendCountdown,
      args: [state.countdownSeconds],
    });
  } catch (err) {
    // Banner injection failed — tab is open, user can still send manually.
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MAIL_AUTOSEND_ALARM_NAME) processNextMailAutosendItem();
  if (alarm.name === REPEAT_CYCLE_ALARM_NAME) runOneRepeatCycle();
});

// Chrome clamps a periodic alarm to a 1-minute minimum, which caps the
// achievable rate at 60/hour — anything requested above that just runs
// at 1-minute intervals instead of erroring.
function computeIntervalMinutes(perHour) {
  const count = Math.min(Math.max(1, perHour || 2), 60);
  return Math.max(1, Math.round(60 / count));
}

async function startMailAutosend(queue, countdownSeconds, perHour, sheetUrl, dailyLimit) {
  const state = await getMailAutosendState();
  if (state.running) return { ok: false, reason: "already_running" };

  const intervalMinutes = computeIntervalMinutes(perHour);

  // dailySentDate/dailySentCount are deliberately left untouched here
  // (not reset to 0) — the daily cap tracks total sends across the whole
  // day, including ones from a previous start/stop of this same tool
  // earlier today, not just this one queue/batch.
  await setMailAutosendState({
    running: true,
    queue: queue.map((item) => ({ ...item, status: "pending" })),
    countdownSeconds: countdownSeconds || 60,
    intervalMinutes,
    processedCount: 0,
    startedAt: Date.now(),
    sheetUrl: sheetUrl || "",
    dailyLimit: dailyLimit || 0,
  });

  await chrome.alarms.create(MAIL_AUTOSEND_ALARM_NAME, { periodInMinutes: intervalMinutes });
  processNextMailAutosendItem(); // send the first one right away instead of waiting a full interval
  return { ok: true };
}

async function stopMailAutosend() {
  await chrome.alarms.clear(MAIL_AUTOSEND_ALARM_NAME);
  await setMailAutosendState({ running: false });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "START_BATCH" && message.sourceTabId) {
    if (isRunning || repeatCycleRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startBatch(message.sourceTabId, message.rocketOnly, message.productDelaySeconds);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "START_KEYWORD_BATCH" && Array.isArray(message.keywords)) {
    if (isRunning || repeatCycleRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startKeywordBatch(message.keywords, message.perKeywordCount, message.rocketOnly, message.source, message.productDelaySeconds);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "OPEN_KEYWORD_PRODUCT_TABS" && Array.isArray(message.keywords)) {
    if (isRunning || repeatCycleRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startOpenProductTabs(message.keywords, message.perKeywordCount, message.rocketOnly, message.source, message.productDelaySeconds);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "CAPTURE_OPEN_TABS") {
    if (isRunning || repeatCycleRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    captureOpenTabs(message.closeAfterCapture);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "STOP_BATCH") {
    cancelRequested = true;
    stopReason = "cancelled";
    if (repeatCycleRunning) stopRepeatCycle(); // also stops any repeat cycle waiting between rounds
    sendResponse({ ok: true, wasRunning: isRunning || repeatCycleRunning });
    return false;
  }
  if (message && message.type === "PING") {
    sendResponse({ ok: true, isRunning });
    return false;
  }
  if (message && message.type === "START_REPEAT_CYCLE" && Array.isArray(message.keywords)) {
    startRepeatCycle(
      message.keywords,
      message.perKeywordCount,
      message.rocketOnly,
      message.source,
      message.productDelaySeconds,
      message.cycleIntervalMinutes,
      message.maxCycles
    ).then(sendResponse);
    return true; // async response
  }
  if (message && message.type === "GET_REPEAT_CYCLE_STATUS") {
    getRepeatCycleState().then(sendResponse);
    return true;
  }
  if (message && message.type === "START_NAVER_REVIEW_COLLECTION" && message.tabId) {
    if (isRunning || repeatCycleRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startNaverReviewCollection(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "GET_NAVER_REVIEW_STATUS") {
    getNaverReviewStatus().then(sendResponse);
    return true;
  }
  if (message && message.type === "START_MAIL_AUTOSEND" && Array.isArray(message.queue)) {
    startMailAutosend(message.queue, message.countdownSeconds, message.perHour, message.sheetUrl, message.dailyLimit).then(
      sendResponse
    );
    return true; // async response
  }
  if (message && message.type === "STOP_MAIL_AUTOSEND") {
    stopMailAutosend().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message && message.type === "GET_MAIL_AUTOSEND_STATUS") {
    getMailAutosendState().then(sendResponse);
    return true;
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
  const naverStatus = await getNaverReviewStatus();
  if (naverStatus.running && !isRunning) {
    await setNaverReviewStatus({ running: false, error: "interrupted" });
  }
  // Unlike the two above, an active repeat cycle isn't marked
  // "interrupted" here — its REPEAT_CYCLE_ALARM_NAME alarm survives this
  // restart just like it does, and will keep firing on schedule. Only
  // the in-memory repeatCycleRunning mirror needs restoring so the
  // "already_running" guards work correctly again; the next alarm tick
  // just starts a fresh cycle (any sub-step lost mid-flight isn't
  // resumed, but nothing is left stuck).
  const repeatCycle = await getRepeatCycleState();
  if (repeatCycle.running) repeatCycleRunning = true;
})();
