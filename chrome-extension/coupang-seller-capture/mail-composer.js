const DEFAULT_SUBJECT_TEMPLATE = "{{PRODUCT}} 공동구매/라이브방송 제안드립니다";
const DEFAULT_BODY_TEMPLATE = `{{PRODUCT}} 대표님. 안녕하세요. 대표님 좋은 상품 판매 한번 해보고 싶어서 메일로 연락드렸습니다 :)

저는 13년차 마케터로 온라인 셀러를 준비하고 있는 {{NAME}}입니다.

네이버 스마트스토어에서 공동구매 및 라이브방송으로 함께 판매를 진행해보고 싶습니다. 네이버쇼핑 상위노출과 인플루언서 마케팅을 통해 판매량을 최대한 끌어올려보겠습니다.

혹시 협력 가능하시면 이 메일로 회신 부탁드립니다 🙂

감사합니다.
{{NAME}} 드림`;

let parsedHeaders = [];
let parsedRows = []; // [{ email, productRaw }]
let composedLog = {}; // email -> { composedAt, subject }

function setStatus(text) {
  document.getElementById("status").textContent = text || "";
}

async function loadSettings() {
  const {
    senderName,
    subjectTemplate,
    bodyTemplate,
    composedLog: storedLog,
    mailAutosendCountdownSeconds,
    mailAutosendPerHour,
  } = await chrome.storage.local.get([
    "senderName",
    "subjectTemplate",
    "bodyTemplate",
    "composedLog",
    "mailAutosendCountdownSeconds",
    "mailAutosendPerHour",
  ]);
  document.getElementById("senderName").value = senderName || "";
  document.getElementById("subjectTemplate").value = subjectTemplate || DEFAULT_SUBJECT_TEMPLATE;
  document.getElementById("bodyTemplate").value = bodyTemplate || DEFAULT_BODY_TEMPLATE;
  document.getElementById("countdownSeconds").value = mailAutosendCountdownSeconds || 60;
  document.getElementById("perHourCount").value = mailAutosendPerHour || 2;
  composedLog = storedLog || {};
}

async function saveSettings() {
  await chrome.storage.local.set({
    senderName: document.getElementById("senderName").value,
    subjectTemplate: document.getElementById("subjectTemplate").value,
    bodyTemplate: document.getElementById("bodyTemplate").value,
    mailAutosendCountdownSeconds: parseInt(document.getElementById("countdownSeconds").value, 10) || 60,
    mailAutosendPerHour: getPerHourCount(),
  });
}

// Chrome clamps periodic alarms to a 1-minute minimum, so more than
// 60/hour isn't achievable — cap the input so the UI doesn't promise
// a rate the alarm can't actually hit.
function getPerHourCount() {
  const raw = parseInt(document.getElementById("perHourCount").value, 10);
  if (!Number.isFinite(raw) || raw < 1) return 2;
  return Math.min(raw, 60);
}

function getIntervalMinutes() {
  return Math.max(1, Math.round(60 / getPerHourCount()));
}

function renderIntervalHint() {
  const perHour = getPerHourCount();
  const intervalMinutes = getIntervalMinutes();
  document.getElementById("intervalHint").textContent =
    `약 ${intervalMinutes}분 간격으로 1건씩 열립니다 (시간당 약 ${Math.round(60 / intervalMinutes)}건).`;
}

async function saveComposedLog() {
  await chrome.storage.local.set({ composedLog });
}

// Coupang titles look like "실제 상품명 - 카테고리 | 쿠팡"; take the part
// before the first " - " and trim it down to a short, email-friendly phrase.
// Always editable afterward — this is just a starting guess.
function guessProductName(title) {
  if (!title) return "";
  let base = String(title).split(" - ")[0].trim();
  base = base.replace(/\|\s*쿠팡\s*$/, "").trim();
  const words = base.split(/\s+/);
  let guess = words.slice(0, 4).join(" ");
  if (guess.length > 24) guess = guess.slice(0, 24).trim();
  return guess;
}

function findHeaderIndex(headers, patterns) {
  const idx = headers.findIndex((h) => patterns.some((p) => String(h).toLowerCase().includes(p)));
  return idx;
}

function rowsFromSheetJson(json) {
  if (json.length === 0) return { headers: [], rows: [] };
  const headers = Object.keys(json[0]);
  return { headers, rows: json };
}

function detectColumns(headers) {
  const emailIdx = findHeaderIndex(headers, ["mail", "이메일"]);
  const productIdx = findHeaderIndex(headers, ["상품명", "제목", "product"]);
  return {
    email: emailIdx >= 0 ? headers[emailIdx] : null,
    product: productIdx >= 0 ? headers[productIdx] : null,
  };
}

function populateColumnPickers(headers, detected) {
  const emailSelect = document.getElementById("emailColumnSelect");
  const productSelect = document.getElementById("productColumnSelect");
  emailSelect.innerHTML = "";
  productSelect.innerHTML = "";
  headers.forEach((h) => {
    const opt1 = document.createElement("option");
    opt1.value = h;
    opt1.textContent = h;
    emailSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = h;
    opt2.textContent = h;
    productSelect.appendChild(opt2);
  });
  if (detected.email) emailSelect.value = detected.email;
  if (detected.product) productSelect.value = detected.product;
  document.getElementById("columnPickers").classList.add("active");
}

function buildRowsFromColumns(json, emailKey, productKey) {
  return json
    .map((r) => ({
      email: String(r[emailKey] || "").trim(),
      productRaw: String(r[productKey] || "").trim(),
    }))
    .filter((r) => r.email);
}

function renderRows() {
  const tbody = document.getElementById("rowsBody");
  tbody.innerHTML = "";

  if (parsedRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">엑셀을 업로드하면 여기에 목록이 표시됩니다.</td></tr>';
    return;
  }

  parsedRows.forEach((row, i) => {
    const tr = document.createElement("tr");

    const emailTd = document.createElement("td");
    emailTd.className = "email";
    emailTd.textContent = row.email;
    if (composedLog[row.email]) {
      const badge = document.createElement("span");
      badge.className = "status-badge";
      badge.textContent = "이전에 작성함";
      emailTd.appendChild(badge);
    }
    tr.appendChild(emailTd);

    const productTd = document.createElement("td");
    productTd.className = "product";
    const productInput = document.createElement("input");
    productInput.type = "text";
    productInput.value = guessProductName(row.productRaw);
    productInput.dataset.index = String(i);
    productTd.appendChild(productInput);
    tr.appendChild(productTd);

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";

    const previewBtn = document.createElement("button");
    previewBtn.className = "previewBtn";
    previewBtn.textContent = "미리보기";
    actionsTd.appendChild(previewBtn);

    const composeBtn = document.createElement("button");
    composeBtn.className = "composeBtn";
    composeBtn.textContent = "Gmail로 작성하기";
    actionsTd.appendChild(composeBtn);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);

    const previewTr = document.createElement("tr");
    previewTr.className = "preview-row";
    previewTr.style.display = "none";
    const previewTd = document.createElement("td");
    previewTd.colSpan = 3;
    previewTr.appendChild(previewTd);
    tbody.appendChild(previewTr);

    previewBtn.addEventListener("click", () => {
      const visible = previewTr.style.display !== "none";
      if (visible) {
        previewTr.style.display = "none";
        return;
      }
      const msg = buildMessage(productInput.value);
      previewTd.textContent = `제목: ${msg.subject}\n\n${msg.body}`;
      previewTr.style.display = "";
    });

    composeBtn.addEventListener("click", async () => {
      const msg = buildMessage(productInput.value);
      const url =
        "https://mail.google.com/mail/?view=cm&fs=1" +
        `&to=${encodeURIComponent(row.email)}` +
        `&su=${encodeURIComponent(msg.subject)}` +
        `&body=${encodeURIComponent(msg.body)}`;
      window.open(url, "_blank");

      composedLog[row.email] = { composedAt: new Date().toISOString(), subject: msg.subject };
      await saveComposedLog();
      composeBtn.classList.add("done");
      composeBtn.textContent = "✓ 작성창 열림";
    });

    if (composedLog[row.email]) {
      composeBtn.classList.add("done");
      composeBtn.textContent = "✓ 작성창 열림 (다시 열기)";
    }
  });
}

function buildMessage(productName) {
  const name = document.getElementById("senderName").value || "";
  const subjectTpl = document.getElementById("subjectTemplate").value || DEFAULT_SUBJECT_TEMPLATE;
  const bodyTpl = document.getElementById("bodyTemplate").value || DEFAULT_BODY_TEMPLATE;
  const fill = (tpl) => tpl.split("{{PRODUCT}}").join(productName).split("{{NAME}}").join(name);
  return { subject: fill(subjectTpl), body: fill(bodyTpl) };
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function handleFile(file) {
  setStatus("파일을 읽는 중...");
  try {
    const buffer = await readFileAsArrayBuffer(file);
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (json.length === 0) {
      setStatus("파일에서 데이터를 찾지 못했습니다.");
      return;
    }

    const { headers } = rowsFromSheetJson(json);
    parsedHeaders = headers;
    const detected = detectColumns(headers);

    if (detected.email && detected.product) {
      document.getElementById("columnPickers").classList.remove("active");
      parsedRows = buildRowsFromColumns(json, detected.email, detected.product);
      setStatus(`${parsedRows.length}건을 불러왔습니다. (이메일 컬럼: "${detected.email}", 상품명 컬럼: "${detected.product}")`);
      renderRows();
    } else {
      populateColumnPickers(headers, detected);
      setStatus("이메일/상품명 컬럼을 자동으로 못 찾았습니다. 아래에서 직접 선택해주세요.");
      parsedRows = [];
      renderRows();
      window.__pendingJson = json;
    }
  } catch (err) {
    setStatus("파일을 읽는 데 실패했습니다: " + err.message);
  }
}

function applyManualColumns() {
  const emailKey = document.getElementById("emailColumnSelect").value;
  const productKey = document.getElementById("productColumnSelect").value;
  if (!window.__pendingJson || !emailKey || !productKey) return;
  parsedRows = buildRowsFromColumns(window.__pendingJson, emailKey, productKey);
  setStatus(`${parsedRows.length}건을 불러왔습니다.`);
  renderRows();
}

// Builds the send queue from whatever's currently in the table — i.e.
// any hand-edits to the product-name fields are captured — skipping
// rows already handled via the per-row "Gmail로 작성하기" button so
// autosend doesn't double up on those.
function buildAutosendQueue() {
  const productInputs = document.querySelectorAll("#rowsBody td.product input");
  const queue = [];
  parsedRows.forEach((row, i) => {
    if (composedLog[row.email]) return;
    const productValue = productInputs[i] ? productInputs[i].value : guessProductName(row.productRaw);
    const msg = buildMessage(productValue);
    queue.push({ to: row.email, subject: msg.subject, body: msg.body });
  });
  return queue;
}

async function renderAutosendStatus() {
  const state = await chrome.runtime.sendMessage({ type: "GET_MAIL_AUTOSEND_STATUS" });
  const el = document.getElementById("autosendStatus");
  const startBtn = document.getElementById("startAutosendBtn");
  if (!state || (!state.running && (!state.queue || state.queue.length === 0))) {
    el.textContent = "";
    startBtn.disabled = false;
    return;
  }
  const total = state.queue.length;
  const done = state.queue.filter((q) => q.status !== "pending").length;
  const intervalMinutes = state.intervalMinutes || getIntervalMinutes();
  startBtn.disabled = !!state.running;
  el.textContent = state.running
    ? `자동 발송 진행 중: ${done} / ${total}건 처리됨 (${intervalMinutes}분마다 1건씩)`
    : `자동 발송 종료: ${done} / ${total}건까지 처리됨`;
}

async function handleStartAutosend() {
  const queue = buildAutosendQueue();
  if (queue.length === 0) {
    setStatus("자동 발송할 대상이 없습니다 (전부 이미 작성했거나, 목록이 비어있습니다).");
    return;
  }
  const countdownSeconds = parseInt(document.getElementById("countdownSeconds").value, 10) || 60;
  const perHour = getPerHourCount();
  const intervalMinutes = getIntervalMinutes();
  const estimatedMinutes = (queue.length - 1) * intervalMinutes;
  const ok = window.confirm(
    `${queue.length}건을 ${intervalMinutes}분 간격으로(시간당 약 ${perHour}건) 순서대로 Gmail 작성창을 열어 발송합니다.\n` +
      `각 작성창은 ${countdownSeconds}초 동안 검토/수정할 수 있고, 그 후 자동으로 "보내기"가 눌립니다. 언제든 "지금 취소"로 막을 수 있습니다.\n` +
      `모두 처리되기까지 대략 ${estimatedMinutes}분 걸립니다.\n시작할까요?`
  );
  if (!ok) return;

  await saveSettings();
  const response = await chrome.runtime.sendMessage({ type: "START_MAIL_AUTOSEND", queue, countdownSeconds, perHour });
  if (response && response.ok === false) {
    setStatus("이미 자동 발송이 진행 중입니다.");
    return;
  }
  setStatus("자동 발송을 시작했습니다.");
  renderAutosendStatus();
}

async function handleStopAutosend() {
  await chrome.runtime.sendMessage({ type: "STOP_MAIL_AUTOSEND" });
  setStatus("자동 발송을 중지했습니다. 이미 열린 작성창은 각자 직접 처리해주세요.");
  renderAutosendStatus();
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  renderRows();
  renderAutosendStatus();
  renderIntervalHint();
  setInterval(renderAutosendStatus, 15000);

  ["senderName", "subjectTemplate", "bodyTemplate", "countdownSeconds", "perHourCount"].forEach((id) => {
    document.getElementById(id).addEventListener("change", saveSettings);
  });
  document.getElementById("perHourCount").addEventListener("input", renderIntervalHint);

  document.getElementById("fileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });

  document.getElementById("emailColumnSelect").addEventListener("change", applyManualColumns);
  document.getElementById("productColumnSelect").addEventListener("change", applyManualColumns);
  document.getElementById("startAutosendBtn").addEventListener("click", handleStartAutosend);
  document.getElementById("stopAutosendBtn").addEventListener("click", handleStopAutosend);
});
