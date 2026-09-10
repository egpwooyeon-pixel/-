importScripts("shared.js");

const MAX_PRODUCTS_PER_BATCH = 30;
const TAB_LOAD_TIMEOUT_MS = 15000;
const DELAY_AFTER_LOAD_MS = 600;
const DELAY_AFTER_TAB_CLICK_MS = 900;
const DELAY_BETWEEN_PRODUCTS_MS = 1200;

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

async function isCancelRequested() {
  const { batchCancelRequested } = await chrome.storage.local.get("batchCancelRequested");
  return !!batchCancelRequested;
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

async function processOneProduct(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await delay(DELAY_AFTER_LOAD_MS);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickShippingTabIfPresent,
    });
    await delay(DELAY_AFTER_TAB_CLICK_MS);

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
  const current = await getBatchStatus();
  if (current.running) return;

  await chrome.storage.local.set({ batchCancelRequested: false });

  let links = [];
  try {
    const linkResults = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      func: findProductLinksOnListingPage,
    });
    links = (linkResults && linkResults[0] && linkResults[0].result) || [];
  } catch (err) {
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
    await setBatchStatus({ running: false, error: "no_links_found" });
    return;
  }

  for (let i = 0; i < capped.length; i++) {
    if (await isCancelRequested()) break;

    const res = await processOneProduct(capped[i]);
    const status = await getBatchStatus();
    await setBatchStatus({
      done: status.done + 1,
      failed: status.failed + (res.ok ? 0 : 1),
      currentTitle: res.title || status.currentTitle,
    });

    if (i < capped.length - 1) await delay(DELAY_BETWEEN_PRODUCTS_MS);
  }

  await setBatchStatus({ running: false });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "START_BATCH" && message.sourceTabId) {
    startBatch(message.sourceTabId);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
