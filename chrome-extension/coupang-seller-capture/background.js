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

// --- 네이버 플레이스(지도) 영수증리뷰 수집 ------------------------
// extractVisiblePlaceReviews and loadMorePlaceReviews (shared.js) were
// built and confirmed against real markup the user pasted — a review
// card's outerHTML, and (confirmed on two different place pages) the
// list's own "펼쳐서 더보기" button, which loadMorePlaceReviews clicks
// rather than relying on scroll (scroll alone was confirmed NOT to
// auto-load more). No sort control is touched here (unlike the Smart
// Store collector above) — this just collects whatever's currently
// sorted/visible, since the place panel's own "추천순/최신순" sort
// buttons haven't been inspected yet. Runs with `allFrames: true`
// because it isn't confirmed whether the review panel on a
// map.naver.com place page is same-frame or an embedded
// pcmap.place.naver.com iframe — each frame is tried and empty results
// from the wrong one are harmless.
const PLACE_REVIEW_TARGET = 150;

async function getPlaceReviewStatus() {
  const { placeReviewStatus } = await chrome.storage.local.get("placeReviewStatus");
  return (
    placeReviewStatus || {
      running: false,
      phase: "",
      collected: 0,
      target: PLACE_REVIEW_TARGET,
      error: "",
    }
  );
}

async function setPlaceReviewStatus(patch) {
  const current = await getPlaceReviewStatus();
  await chrome.storage.local.set({ placeReviewStatus: { ...current, ...patch } });
}

// No stable per-review id is exposed in the markup seen so far, so
// this falls back to the same kind of composite key the Smart Store
// collector uses when it lacks one: reviewer + date + a body snippet.
function placeReviewDedupeKey(review) {
  return [review.userId, review.date, (review.body || "").slice(0, 40)].join("|");
}

async function appendPlaceReviews(newReviews) {
  const { placeReviews } = await chrome.storage.local.get("placeReviews");
  const list = Array.isArray(placeReviews) ? placeReviews : [];
  const seen = new Set(list.map(placeReviewDedupeKey));
  let added = 0;
  newReviews.forEach((r) => {
    const key = placeReviewDedupeKey(r);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(r);
    added++;
  });
  await chrome.storage.local.set({ placeReviews: list });
  return added;
}

// Loads all the way first (clicking "더보기" repeatedly), then does
// ONE reveal-everything scroll sweep, then ONE extraction pass over
// the whole list — rather than the earlier design, which re-extracted
// all currently-rendered cards after every single "더보기" click. That
// repeated-extraction design silently lost photos: a card extracted
// early (before its lazyload-wrapper had rendered any `<img>`) got
// permanently locked in with empty photoUrls by appendPlaceReviews's
// dedupe-skip, even though a later pass — after more scrolling had
// happened — would have read the real photos out of the same card.
// Confirmed live: 150 reviews collected that way came back with only
// 3 reviews' worth of photos. Extracting once, after revealAllPlaceCards
// has had a chance to trigger every card's lazyload, avoids that
// entirely.
async function startPlaceReviewCollection(tabId) {
  isRunning = true;
  cancelRequested = false;
  stopReason = "";

  await chrome.storage.local.set({ placeReviews: [] });
  await setPlaceReviewStatus({
    running: true,
    phase: "리뷰 목록 불러오는 중",
    collected: 0,
    target: PLACE_REVIEW_TARGET,
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

  let cardCount = 0;
  let round = 0;
  const MAX_ROUNDS = 40;

  while (cardCount < PLACE_REVIEW_TARGET && round < MAX_ROUNDS && !cancelRequested) {
    let hasNext = false;
    try {
      const nextResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: loadMorePlaceReviews,
      });
      // allFrames:true runs this in every frame on the page, including
      // ones with nothing to do with reviews (ad/map-tile iframes) —
      // those always come back {ok:false, before:0, after:0}. Picking
      // just the first truthy result (an earlier version of this did)
      // can grab one of those instead of the frame that actually has
      // the review list, making a perfectly normal page look like "no
      // reviews found". Aggregate across all frames instead: hasNext
      // is true if ANY frame succeeded, and cardCount takes the
      // largest `after` seen (the real review frame's), not whichever
      // frame happened to run first.
      const frameResults = (nextResults || []).map((r) => r && r.result).filter(Boolean);
      hasNext = frameResults.some((r) => r.ok);
      const maxAfter = frameResults.reduce((max, r) => (typeof r.after === "number" ? Math.max(max, r.after) : max), 0);
      cardCount = Math.max(cardCount, maxAfter);
    } catch (err) {
      hasNext = false;
    }

    if (round === 0 && cardCount === 0 && !hasNext) {
      await setPlaceReviewStatus({
        running: false,
        error: "리뷰를 찾지 못했습니다 — 플레이스 리뷰 탭이 화면에 보이는 상태인지 확인하거나, 리뷰 카드 outerHTML을 다시 보내주세요.",
      });
      isRunning = false;
      return;
    }

    await setPlaceReviewStatus({ phase: `리뷰 목록 불러오는 중 (${cardCount}건)` });

    if (!hasNext || cardCount >= PLACE_REVIEW_TARGET || cancelRequested) break;

    round++;
    await delayWithJitter(2500);
  }

  if (cancelRequested) {
    isRunning = false;
    await setPlaceReviewStatus({ running: false, error: "cancelled" });
    return;
  }

  await setPlaceReviewStatus({ phase: `사진 불러오는 중 (${cardCount}건, 시간이 좀 걸릴 수 있습니다)` });
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: revealAllPlaceCards,
    });
  } catch (err) {
    // Best-effort — extraction still proceeds even if this fails, just
    // with whatever photos happened to already be rendered.
  }

  await setPlaceReviewStatus({ phase: "리뷰 추출 중" });
  let pageReviews = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: extractVisiblePlaceReviews,
    });
    pageReviews = (results || []).flatMap((r) => (r && r.result) || []);
  } catch (err) {
    isRunning = false;
    await setPlaceReviewStatus({
      running: false,
      error: "리뷰 추출 중 오류: " + ((err && err.message) || "알 수 없는 오류"),
    });
    return;
  }

  const tagged = pageReviews.map((r) => ({ ...r, pageUrl, capturedAt: formatDateTime(new Date()) }));
  const added = await appendPlaceReviews(tagged);

  isRunning = false;
  await setPlaceReviewStatus({ running: false, collected: added, phase: `${added}건 수집됨` });
}

// --- 네이버 플레이스 리뷰 사진 다운로드 ---------------------------
// This has to run here, not in popup.js: a popup's own script is torn
// down the instant the popup loses focus (clicking elsewhere, the OS
// download notification stealing focus, etc.), so a sequential loop
// over dozens of photos living only in the popup stopped dead after
// whatever download was in flight — confirmed live ("사진이 한장만
// 다운로드됨"). Every other multi-step job in this extension already
// runs here for the same reason; this brings photo downloads in line
// with that instead of being the one exception.
let placePhotoDownloadRunning = false;

async function getPlacePhotoDownloadStatus() {
  const { placePhotoDownloadStatus } = await chrome.storage.local.get("placePhotoDownloadStatus");
  return placePhotoDownloadStatus || { running: false, total: 0, done: 0, failed: 0, error: "" };
}

async function setPlacePhotoDownloadStatus(patch) {
  const current = await getPlacePhotoDownloadStatus();
  await chrome.storage.local.set({ placePhotoDownloadStatus: { ...current, ...patch } });
}

function sanitizeForFilename(s) {
  return (s || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

async function startPlacePhotoDownload(reviews) {
  if (placePhotoDownloadRunning) return { ok: false, reason: "already_running" };

  const jobs = [];
  (reviews || []).forEach((r, reviewIndex) => {
    const urls = Array.isArray(r.photoUrls) ? r.photoUrls : [];
    urls.forEach((url, photoIndex) => {
      jobs.push({ url, reviewIndex, photoIndex, nickname: r.nickname, placeName: r.placeName });
    });
  });
  if (jobs.length === 0) return { ok: false, reason: "no_photos" };

  placePhotoDownloadRunning = true;
  await setPlacePhotoDownloadStatus({ running: true, total: jobs.length, done: 0, failed: 0, error: "" });

  const folder = sanitizeForFilename(jobs[0].placeName) || "플레이스";
  let done = 0;
  let failed = 0;

  for (const job of jobs) {
    const extMatch = job.url.match(/\.(jpg|jpeg|png|webp|gif)(?:[?&]|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";
    const filename = `네이버플레이스사진/${folder}/${String(job.reviewIndex + 1).padStart(3, "0")}_${
      sanitizeForFilename(job.nickname) || "익명"
    }_${job.photoIndex + 1}.${ext}`;

    try {
      await chrome.downloads.download({ url: job.url, filename, saveAs: false });
    } catch (err) {
      failed++;
    }
    done++;
    await setPlacePhotoDownloadStatus({ done, failed });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  placePhotoDownloadRunning = false;
  await setPlacePhotoDownloadStatus({ running: false, done, failed });
  return { ok: true, total: jobs.length, failed };
}

// --- 네이버 플레이스 후기 기반 블로그 원고 생성 (AI) ---------------
// Takes review text the user pasted by hand, or pulled in from the
// place-review collector above, plus basic store info, and asks the
// Google Gemini API to
// (1) classify recurring keywords into 필수/좋은/시그니처메뉴 buckets and
// (2) draft a natural first-person blog post that works them in. Uses
// Gemini specifically because its free tier has no cost for this kind
// of occasional, low-volume use (unlike Anthropic/OpenAI, which are
// pay-per-call) — the tradeoff is the free tier's rate limits, which
// show up as an API error if hit. The user's own Gemini API key is
// stored locally and sent directly to generativelanguage.googleapis.com
// from this service worker — never to any server of ours. Only review
// body text is sent, never reviewer names/ids, so no individual
// reviewer's identity reaches the third-party API.

let blogDraftRunning = false;

async function getBlogDraftStatus() {
  const { blogDraftStatus } = await chrome.storage.local.get("blogDraftStatus");
  return (
    blogDraftStatus || {
      running: false,
      phase: "",
      error: "",
      result: null,
      updatedAt: 0,
    }
  );
}

async function setBlogDraftStatus(patch) {
  const current = await getBlogDraftStatus();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ blogDraftStatus: next });
  return next;
}

// Fetches a photo and base64-encodes it as Gemini's inline_data part
// format. Chunked String.fromCharCode rather than one huge call —
// a multi-MB image as a single fromCharCode.apply call can blow the
// function's argument-count limit.
async function fetchImageInlineData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 요청 실패 (${res.status})`);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return { mimeType: blob.type || "image/jpeg", data: btoa(binary) };
}

// photoSlots (optional) is an ordered list the caller already picked
// from the collected reviews' real photoUrls. First version of this
// only told Gemini which review each slot came from (text only) and
// asked it to guess a caption from that — confirmed live that this
// produces captions that don't match what's actually in the photo
// (e.g. a soup photo captioned "숯불에 노릇하게 굽기"), since a review
// with several photos can mention several different dishes in its
// text with no way to know which photo shows which. This fetches each
// photo and sends the actual image bytes to Gemini as inline_data
// parts, interleaved with its slot number and review context, so
// captions are grounded in what the model actually sees rather than
// inferred from text alone.
async function buildBlogDraftParts({ storeName, storeArea, storeCategory, signatureMenuHint, reviews, photoSlots }) {
  const hasPhotos = Array.isArray(photoSlots) && photoSlots.length > 0;
  const reviewBlock = reviews.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const parts = [
    {
      text: `당신은 실제 방문 경험을 바탕으로 자연스러운 블로그 후기를 쓰는 한국어 블로거입니다. 아래는 "${storeName}"(${storeArea}, ${storeCategory}) 네이버 플레이스에 달린 실제 영수증리뷰 ${reviews.length}건입니다. 이 리뷰들에 공통적으로 나타나는 표현과 평가만 근거로 사용하세요 — 리뷰에 없는 내용을 지어내지 마세요.

[리뷰 목록]
${reviewBlock}
${signatureMenuHint ? `\n[참고: 알려준 시그니처 메뉴] ${signatureMenuHint}\n` : ""}`,
    },
  ];

  if (hasPhotos) {
    parts.push({
      text: `\n아래에 사진 ${photoSlots.length}장이 번호 순서(1~${photoSlots.length})대로 첨부되어 있습니다. 각 사진 앞의 텍스트는 그 사진이 달린 리뷰의 평점/본문 일부로, 참고용일 뿐입니다 — 설명 문구는 반드시 그 사진에 실제로 보이는 내용(음식 종류, 플레이팅, 분위기 등)을 바탕으로 작성하세요.\n`,
    });
    for (let i = 0; i < photoSlots.length; i++) {
      const slot = photoSlots[i];
      parts.push({
        text: `사진 ${i + 1} (별점 ${slot.rating || "-"}, 리뷰: ${(slot.body || "").slice(0, 60) || "본문 없음"}):`,
      });
      try {
        parts.push({ inlineData: await fetchImageInlineData(slot.url) });
      } catch (err) {
        parts.push({ text: "(이 사진은 불러오지 못했습니다 — 리뷰 내용만 참고해 무난하게 작성)" });
      }
    }
  }

  parts.push({
    text: `
다음 작업을 수행하고, 다른 설명 없이 아래 JSON 형식으로만 답하세요(마크다운 코드블록 없이 순수 JSON 하나만):

{
  "requiredKeywords": ["지역+업종 조합 등 블로그 제목/본문에 꼭 들어가야 하는 키워드 2~4개"],
  "goodKeywords": ["리뷰에서 반복적으로 나타나는 긍정 표현(분위기, 가성비, 친절, 웨이팅 등) 3~6개"],
  "signatureMenu": ["리뷰에 자주 언급된 구체적 메뉴/음식 이름 1~5개"],
  "titles": ["사람들이 네이버에서 실제로 많이 검색할 법한 키워드(지역+업종, 지역+대표메뉴 등 requiredKeywords 조합 위주)를 앞쪽에 자연스럽게 넣은 블로그 제목 후보 3개. 각 25~40자 내외, 서로 다른 조합/느낌으로, 클릭하고 싶게 쓰되 낚시성 과장은 금지"],
  "hashtags": ["requiredKeywords/goodKeywords/signatureMenu와 지역명을 바탕으로 한 해시태그 10~15개, 전부 '#단어' 형태(태그 하나 안에는 띄어쓰기 없이 붙여쓰기, 예: '#신사역맛집'), 중복 없이"],
  "draft": "실제 1인칭 방문 후기 톤의 블로그 본문 전체 텍스트.${
    hasPhotos
      ? ` 사진이 많으니 1500~2500자 내외로, 문단을 충분히 나누고 각 문단 사이에 [사진 삽입: N] 마커를 한 줄로 넣어 총 ${photoSlots.length}개(1부터 ${photoSlots.length}까지 모두, 중복·누락 없이)를 사진 순서(위 첨부 순서)와 맞춰 배치.`
      : " 800~1200자 내외."
  } 과장 광고 문구 없이 자연스럽게 위 키워드들을 녹여서 작성. 리뷰에 단점/주의사항(예: 웨이팅, 협소한 주차)이 보이면 1개 정도 솔직하게 포함."${
      hasPhotos
        ? `,\n  "photoCaptions": ["사진 1부터 ${photoSlots.length}까지 순서대로, 각 사진에 실제로 보이는 내용을 바탕으로 한 짧은 설명 문구(5~15자 내외) ${photoSlots.length}개"]`
        : ""
    }
}`,
  });

  return parts;
}

// 503 ("model is currently experiencing high demand... usually
// temporary") is Google's own server being briefly overloaded, not
// anything wrong with the request — confirmed live, and worth a couple
// of automatic retries with backoff, especially now that a batch of
// 20+ drafts/posts means 20+ separate calls where any single one can
// hit this transient state. 429 (rate limit) deliberately isn't
// retried here: it means this request itself is the one over the
// free-tier quota, and retrying quickly within the same run is more
// likely to just trip it again than to help.
const GEMINI_RETRYABLE_STATUSES = new Set([503]);
const GEMINI_RETRY_DELAYS_MS = [2000, 5000];

async function callGeminiForBlogDraft({ apiKey, model, parts }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError = null;
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
      }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const errJson = await res.json();
        detail = (errJson && errJson.error && errJson.error.message) || "";
      } catch (err) {
        // response body wasn't JSON — leave detail blank
      }
      const rateLimited = res.status === 429 ? " (무료 티어 호출 한도 초과일 수 있습니다 — 잠시 후 다시 시도하세요)" : "";
      lastError = new Error(`API 오류 (${res.status})${detail ? ": " + detail : ""}${rateLimited}`);

      if (GEMINI_RETRYABLE_STATUSES.has(res.status) && attempt < GEMINI_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, GEMINI_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    const data = await res.json();
    const candidate = data && data.candidates && data.candidates[0];
    const text =
      candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
    if (!text) {
      const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
      throw new Error(blockReason ? `Gemini가 응답을 차단했습니다 (${blockReason})` : "API 응답에서 텍스트를 찾지 못했습니다.");
    }
    return text;
  }

  throw lastError;
}

// The model is asked for pure JSON but may still wrap it in a markdown
// fence or add stray whitespace — strip that defensively before
// parsing. If parsing still fails, falls back to showing the raw text
// as the draft (with empty keyword lists) rather than losing the
// response entirely.
function parseBlogDraftResponse(text, photoSlots) {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      requiredKeywords: [],
      goodKeywords: [],
      signatureMenu: [],
      titles: [],
      hashtags: [],
      draft: text,
      photoCaptions: [],
      parseFailed: true,
    };
  }
  const hasPhotos = Array.isArray(photoSlots) && photoSlots.length > 0;
  let photoCaptions = Array.isArray(parsed.photoCaptions) ? parsed.photoCaptions.map((c) => String(c)) : [];
  // Pad/trim so the caption list always matches the number of photo
  // slots the caller asked for, even if the model under/over-counted —
  // the UI zips captions to slots by index and a length mismatch would
  // otherwise silently misattribute a caption to the wrong photo.
  if (hasPhotos) {
    while (photoCaptions.length < photoSlots.length) photoCaptions.push("");
    photoCaptions = photoCaptions.slice(0, photoSlots.length);
  }
  // The model is told to format each tag as "#단어" with no internal
  // spaces, but defensively normalize anyway: ensure a leading "#" and
  // strip any whitespace the model left inside one, rather than
  // trusting it followed the instruction exactly.
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags
        .map((h) => "#" + String(h).replace(/\s+/g, "").replace(/^#+/, ""))
        .filter((h) => h.length > 1)
    : [];

  return {
    requiredKeywords: Array.isArray(parsed.requiredKeywords) ? parsed.requiredKeywords : [],
    goodKeywords: Array.isArray(parsed.goodKeywords) ? parsed.goodKeywords : [],
    signatureMenu: Array.isArray(parsed.signatureMenu) ? parsed.signatureMenu : [],
    titles: Array.isArray(parsed.titles) ? parsed.titles.map((t) => String(t)) : [],
    hashtags,
    draft: typeof parsed.draft === "string" ? parsed.draft : text,
    photoCaptions,
    parseFailed: false,
  };
}

async function generateBlogDraft({ storeName, storeArea, storeCategory, signatureMenuHint, reviews, apiKey, model, photoSlots }) {
  if (blogDraftRunning) return { ok: false, reason: "already_running" };
  if (!apiKey) return { ok: false, reason: "no_api_key" };
  if (!Array.isArray(reviews) || reviews.length === 0) return { ok: false, reason: "no_reviews" };

  blogDraftRunning = true;
  await setBlogDraftStatus({
    running: true,
    phase: Array.isArray(photoSlots) && photoSlots.length > 0 ? "사진 불러오는 중" : "AI 분석 중",
    error: "",
    result: null,
  });

  try {
    const parts = await buildBlogDraftParts({ storeName, storeArea, storeCategory, signatureMenuHint, reviews, photoSlots });
    await setBlogDraftStatus({ phase: "AI 분석 중" });
    const text = await callGeminiForBlogDraft({ apiKey, model: model || "gemini-3.8-flash", parts });
    const result = parseBlogDraftResponse(text, photoSlots);
    result.photoSlots = Array.isArray(photoSlots) ? photoSlots : [];
    await setBlogDraftStatus({ running: false, phase: "완료", error: "", result });
    return { ok: true, result };
  } catch (err) {
    await setBlogDraftStatus({ running: false, phase: "", error: (err && err.message) || "알 수 없는 오류" });
    return { ok: false, reason: "error", error: (err && err.message) || "알 수 없는 오류" };
  } finally {
    blogDraftRunning = false;
  }
}

// --- 쓰레드(Threads) 홍보글 생성 (AI) ----------------------------
// Short-form sibling of the blog-draft generator above: one small,
// fixed-size batch of photos + whichever reviews they came from -> one
// punchy Threads-length post. Reuses callGeminiForBlogDraft (it just
// takes a prebuilt `parts` array, nothing blog-specific about it) but
// has its own prompt/schema and its own running flag + status, since a
// Threads batch fires many more, smaller calls in one run than a
// single blog draft does and shouldn't be blocked by — or block — an
// unrelated blog-draft generation happening around the same time.
let threadsPostRunning = false;

async function getThreadsPostStatus() {
  const { threadsPostStatus } = await chrome.storage.local.get("threadsPostStatus");
  return threadsPostStatus || { running: false, phase: "", error: "", result: null, updatedAt: 0 };
}

async function setThreadsPostStatus(patch) {
  const current = await getThreadsPostStatus();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ threadsPostStatus: next });
  return next;
}

async function buildThreadsPostParts({ storeName, storeArea, storeCategory, reviewTexts, photoSlots }) {
  const reviewBlock = reviewTexts.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const parts = [
    {
      text: `당신은 실제 방문 리뷰를 참고해서 쓰레드(Threads)에 올릴 짧은 홍보 게시글을 쓰는 한국어 작성자입니다. 아래는 "${storeName}"(${storeArea}, ${storeCategory})의 실제 리뷰 내용과, 이 글과 함께 올릴 사진 ${photoSlots.length}장입니다. 리뷰에 없는 내용은 지어내지 마세요.

[참고 리뷰]
${reviewBlock}
`,
    },
  ];

  parts.push({
    text: `\n아래에 사진 ${photoSlots.length}장이 첨부되어 있습니다. 실제로 사진에 보이는 내용을 참고해서 글을 쓰세요(리뷰 텍스트만으로 추측하지 마세요).\n`,
  });
  for (let i = 0; i < photoSlots.length; i++) {
    const slot = photoSlots[i];
    parts.push({ text: `사진 ${i + 1}:` });
    try {
      parts.push({ inlineData: await fetchImageInlineData(slot.url) });
    } catch (err) {
      parts.push({ text: "(이 사진은 불러오지 못했습니다)" });
    }
  }

  parts.push({
    text: `
다른 설명 없이 아래 JSON 형식으로만 답하세요(마크다운 코드블록 없이 순수 JSON 하나만):

{
  "text": "쓰레드에 바로 올릴 수 있는 본문. 1인칭 방문 후기 톤으로 2~4문장, 이모지 1~2개 정도 자연스럽게, 과장 광고 문구 없이, 끝에 해시태그 2~4개(모두 '#단어' 형태, 띄어쓰기 없이)를 포함해서 전체 400자 이내로 작성."
}`,
  });

  return parts;
}

function parseThreadsPostResponse(text) {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      return { text: parsed.text.trim(), parseFailed: false };
    }
  } catch (err) {
    // fall through to the raw-text fallback below
  }
  return { text: text.trim(), parseFailed: true };
}

async function generateThreadsPost({ storeName, storeArea, storeCategory, reviewTexts, photoSlots, apiKey, model }) {
  if (threadsPostRunning) return { ok: false, reason: "already_running" };
  if (!apiKey) return { ok: false, reason: "no_api_key" };
  if (!Array.isArray(photoSlots) || photoSlots.length === 0) return { ok: false, reason: "no_photos" };

  threadsPostRunning = true;
  await setThreadsPostStatus({ running: true, phase: "AI 작성 중", error: "", result: null });

  try {
    const parts = await buildThreadsPostParts({ storeName, storeArea, storeCategory, reviewTexts, photoSlots });
    const text = await callGeminiForBlogDraft({ apiKey, model: model || "gemini-3.8-flash", parts });
    const result = parseThreadsPostResponse(text);
    await setThreadsPostStatus({ running: false, phase: "완료", error: "", result });
    return { ok: true, result };
  } catch (err) {
    await setThreadsPostStatus({ running: false, phase: "", error: (err && err.message) || "알 수 없는 오류" });
    return { ok: false, reason: "error", error: (err && err.message) || "알 수 없는 오류" };
  } finally {
    threadsPostRunning = false;
  }
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
  if (message && message.type === "START_PLACE_REVIEW_COLLECTION" && message.tabId) {
    if (isRunning || repeatCycleRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startPlaceReviewCollection(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "GET_PLACE_REVIEW_STATUS") {
    getPlaceReviewStatus().then(sendResponse);
    return true;
  }
  if (message && message.type === "START_PLACE_PHOTO_DOWNLOAD" && Array.isArray(message.reviews)) {
    startPlacePhotoDownload(message.reviews).then(sendResponse);
    return true;
  }
  if (message && message.type === "GET_PLACE_PHOTO_DOWNLOAD_STATUS") {
    getPlacePhotoDownloadStatus().then(sendResponse);
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
  if (message && message.type === "GENERATE_BLOG_DRAFT" && Array.isArray(message.reviews)) {
    generateBlogDraft(message).then(sendResponse);
    return true;
  }
  if (message && message.type === "GET_BLOG_DRAFT_STATUS") {
    getBlogDraftStatus().then(sendResponse);
    return true;
  }
  if (message && message.type === "GENERATE_THREADS_POST" && Array.isArray(message.photoSlots)) {
    generateThreadsPost(message).then(sendResponse);
    return true;
  }
  if (message && message.type === "GET_THREADS_POST_STATUS") {
    getThreadsPostStatus().then(sendResponse);
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
  const placeStatus = await getPlaceReviewStatus();
  if (placeStatus.running && !isRunning) {
    await setPlaceReviewStatus({ running: false, error: "interrupted" });
  }
  const photoDownloadStatus = await getPlacePhotoDownloadStatus();
  if (photoDownloadStatus.running && !placePhotoDownloadRunning) {
    await setPlacePhotoDownloadStatus({ running: false, error: "interrupted" });
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

  const blogStatus = await getBlogDraftStatus();
  if (blogStatus.running && !blogDraftRunning) {
    await setBlogDraftStatus({ running: false, error: "interrupted" });
  }

  const threadsStatus = await getThreadsPostStatus();
  if (threadsStatus.running && !threadsPostRunning) {
    await setThreadsPostStatus({ running: false, error: "interrupted" });
  }
})();
