importScripts("shared.js");

const MAX_PRODUCTS_PER_BATCH = 30;
const TAB_LOAD_TIMEOUT_MS = 15000;
const DELAY_AFTER_LOAD_MS = 600;
const DELAY_AFTER_TAB_CLICK_MS = 900;
const DELAY_BETWEEN_PRODUCTS_MS = 1200;

// In-memory flags for the running batch. Checked directly (no storage
// round-trip) so "중지" takes effect within one checkpoint instead of
// waiting on an async read. These only live as long as this service
// worker instance does; see the startup reconciliation block at the
// bottom for what happens if Chrome terminates the worker mid-batch.
let isRunning = false;
let cancelRequested = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function getBatchStatus() {
  const { batchStatus } = await chrome.storage.local.get("batchStatus");
  return batchStatus || { running: false, total: 0, done: 0, failed: 0, currentTitle: "" };
}

async function setBatchStatus(patch) {
  const current = await getBatchStatus();
  await chrome.storage.local.set({ batchStatus: { ...current, ...patch } });
}

async function appendRecord(record) {
  const { records } = await chrome.storage.local.get("records");
  const list = Array.isArray(records) ? records : [];
  list.push(record);
  await chrome.storage.local.set({ records: list });
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

// Processes one product tab, bailing out early at each checkpoint if
// the user has requested a stop, so cancellation doesn't have to wait
// for the slowest step (tab load) to finish.
async function processOneProduct(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    if (cancelRequested) return { ok: false, cancelled: true };
    await delay(DELAY_AFTER_LOAD_MS);
    if (cancelRequested) return { ok: false, cancelled: true };

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickShippingTabIfPresent,
    });
    if (cancelRequested) return { ok: false, cancelled: true };
    await delay(DELAY_AFTER_TAB_CLICK_MS);
    if (cancelRequested) return { ok: false, cancelled: true };

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCoupangSellerInfo,
    });
    const result = injectionResults && injectionResults[0] && injectionResults[0].result;

    if (result && result.success) {
      await appendRecord({ ...result.data, capturedAt: formatDateTime(new Date()) });
      return { ok: true, title: result.data.productTitle };
    }
    return { ok: false, title: "", reason: result ? result.reason : "no_result" };
  } catch (err) {
    return { ok: false, title: "", reason: "exception" };
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      // tab may already be closed
    }
  }
}

async function startBatch(sourceTabId) {
  isRunning = true;
  cancelRequested = false;

  let links = [];
  try {
    const linkResults = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      func: findProductLinksOnListingPage,
    });
    links = (linkResults && linkResults[0] && linkResults[0].result) || [];
  } catch (err) {
    isRunning = false;
    await setBatchStatus({ running: false, error: "listing_read_failed" });
    return;
  }

  const capped = links.slice(0, MAX_PRODUCTS_PER_BATCH);

  await setBatchStatus({
    running: true,
    total: capped.length,
    done: 0,
    failed: 0,
    currentTitle: "",
    error: "",
    startedAt: Date.now(),
  });

  if (capped.length === 0) {
    isRunning = false;
    await setBatchStatus({ running: false, error: "no_links_found" });
    return;
  }

  let stoppedEarly = false;
  for (let i = 0; i < capped.length; i++) {
    if (cancelRequested) {
      stoppedEarly = true;
      break;
    }

    const res = await processOneProduct(capped[i]);
    const status = await getBatchStatus();
    await setBatchStatus({
      done: status.done + 1,
      failed: status.failed + (res.ok ? 0 : 1),
      currentTitle: res.title || status.currentTitle,
    });

    if (res.cancelled || cancelRequested) {
      stoppedEarly = true;
      break;
    }
    if (i < capped.length - 1) await delay(DELAY_BETWEEN_PRODUCTS_MS);
  }

  isRunning = false;
  await setBatchStatus({ running: false, error: stoppedEarly ? "cancelled" : "" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "START_BATCH" && message.sourceTabId) {
    if (isRunning) {
      sendResponse({ ok: false, reason: "already_running" });
      return false;
    }
    startBatch(message.sourceTabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === "STOP_BATCH") {
    cancelRequested = true;
    sendResponse({ ok: true, wasRunning: isRunning });
    return false;
  }
  if (message && message.type === "PING") {
    sendResponse({ ok: true, isRunning });
    return false;
  }
  return false;
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
