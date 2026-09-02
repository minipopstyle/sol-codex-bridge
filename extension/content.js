function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

function assistantText(node) {
  if (!node) return "";
  // The injected Codex button may live inside ChatGPT's turn/action DOM. Strip it
  // from a clone before extracting text so it never changes contentHash/revision.
  const clone = node.cloneNode(true);
  clone.querySelectorAll?.(".sol-codex-inline-wrap, .sol-codex-inline-btn").forEach((item) => item.remove());
  return normalizeText(clone.innerText || clone.textContent);
}

function assistantNodes() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .filter((node) => normalizeText(node.innerText || node.textContent).length > 0);
}

function latestAssistantNode() {
  const nodes = assistantNodes();
  return nodes[nodes.length - 1] || null;
}

function messageIdFor(node, index) {
  if (!node) return `assistant-${index}`;
  const own = node.getAttribute?.("data-message-id");
  if (own) return own;
  const ancestor = node.closest?.("[data-message-id]");
  if (ancestor?.getAttribute("data-message-id")) return ancestor.getAttribute("data-message-id");
  const child = node.querySelector?.("[data-message-id]");
  if (child?.getAttribute("data-message-id")) return child.getAttribute("data-message-id");
  const turn = node.closest?.('article[data-testid^="conversation-turn"]');
  const testId = turn?.getAttribute("data-testid");
  return testId || `assistant-${index}`;
}

function conversationId() {
  const match = location.pathname.match(/\/c\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  return `path:${location.pathname}`;
}

function currentUserSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return "";
  return normalizeText(selection.toString());
}

function pageTitle() {
  const raw = normalizeText(document.title);
  return raw.replace(/\s*[-–—]\s*ChatGPT\s*$/i, "") || "ChatGPT";
}

function streamingNow() {
  return Boolean(document.querySelector([
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="停止"]',
    '[data-testid="stop-button"]'
  ].join(",")));
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildLatestSource() {
  const nodes = assistantNodes();
  const node = nodes[nodes.length - 1];
  if (!node) return null;
  const text = assistantText(node);
  if (!text) return null;
  const assistantIndex = nodes.length - 1;
  const messageId = messageIdFor(node, assistantIndex);
  const contentHash = await sha256(text);
  return {
    type: "chatgpt",
    conversationId: conversationId(),
    messageId,
    messageKey: `${messageId}:${assistantIndex}`,
    branchId: null,
    assistantIndex,
    contentHash,
    text,
    title: pageTitle(),
    url: location.href,
    capturedAt: Date.now(),
    isStreaming: streamingNow()
  };
}

let lastSignature = "";
let timer = null;
let publishRunning = false;
let publishQueued = false;
let quickTargetCache = null;
let quickTargetAt = 0;
let quickButtonBusy = false;

function setQuickButtonVisual(button, state = "ready") {
  button.dataset.state = state;
  button.replaceChildren();

  if (state === "running") {
    const loader = document.createElement("span");
    loader.className = "sol-codex-inline-loader";
    loader.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 9; index += 1) loader.appendChild(document.createElement("i"));
    const label = document.createElement("span");
    label.className = "sol-codex-inline-label";
    label.textContent = "执行中";
    const elapsed = document.createElement("span");
    elapsed.className = "sol-codex-inline-elapsed";
    elapsed.textContent = "0.0s";
    button.append(loader, label, elapsed);
    return;
  }

  const label = document.createElement("span");
  label.className = "sol-codex-inline-label";
  label.textContent = state === "sent" ? "Sent" : state === "error" ? "Retry" : state === "sending" ? "Sending" : "Codex";
  button.appendChild(label);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sol-codex-inline-icon");

  if (state === "sent") {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M3.25 8.25 6.35 11.1 12.75 4.9");
    svg.appendChild(path);
  } else if (state === "sending") {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M3 8h10");
    svg.appendChild(path);
  } else {
    const line = document.createElementNS(svg.namespaceURI, "path");
    line.setAttribute("d", "M2.75 8h9.5");
    const head = document.createElementNS(svg.namespaceURI, "path");
    head.setAttribute("d", "m9.25 4.75 3.25 3.25-3.25 3.25");
    svg.append(line, head);
  }
  button.appendChild(svg);
}

function stopInlineTaskTimer(button) {
  if (button._solCodexElapsedTimer) clearInterval(button._solCodexElapsedTimer);
  delete button._solCodexElapsedTimer;
}

function restoreQuickButton(button) {
  stopInlineTaskTimer(button);
  delete button.dataset.running;
  button.dataset.holdUntil = String(Date.now() + 1800);
  setQuickButtonVisual(button, "sent");
  setTimeout(() => {
    if (!button.isConnected) return;
    delete button.dataset.holdUntil;
    setQuickButtonVisual(button, "ready");
    button.disabled = false;
  }, 1800);
}

function watchInlineTask(button, sessionId) {
  const startedAt = Date.now();
  button.dataset.running = "true";
  const updateElapsed = () => {
    const elapsed = button.querySelector(".sol-codex-inline-elapsed");
    if (elapsed) elapsed.textContent = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  };
  updateElapsed();
  button._solCodexElapsedTimer = setInterval(updateElapsed, 100);
  const check = async () => {
    if (!button.isConnected) return stopInlineTaskTimer(button);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SOL_CODEX_BRIDGE_REQUEST",
        path: `/api/actions/task-status?sessionId=${encodeURIComponent(sessionId)}`,
        options: { timeoutMs: 4000 }
      });
      if (result?.ok && result.data?.completed) return restoreQuickButton(button);
    } catch {}
    setTimeout(check, 1200);
  };
  check();
}

async function getQuickTarget({ fresh = false } = {}) {
  if (!fresh && quickTargetCache && Date.now() - quickTargetAt < 1200) return quickTargetCache;
  try {
    const result = await chrome.runtime.sendMessage({ type: "SOL_CODEX_GET_QUICK_TARGET" });
    quickTargetCache = result?.ok ? result.target : null;
  } catch {
    quickTargetCache = null;
  }
  quickTargetAt = Date.now();
  return quickTargetCache;
}

function removeStaleQuickButtons(keepKey = "") {
  document.querySelectorAll(".sol-codex-inline-wrap").forEach((wrap) => {
    if (!keepKey || wrap.dataset.messageKey !== keepKey) wrap.remove();
  });
}

function quickButtonHost(node) {
  const turn = node?.closest?.('article[data-testid^="conversation-turn"]');
  if (turn) return turn;
  const message = node?.closest?.('[data-message-author-role="assistant"]');
  return message || node?.parentElement || document.body;
}

function targetDescription(target) {
  if (!target) return "";
  if (target.mode === "queue") return target.sessionTitle || target.sessionId || "已有会话";
  return `${target.projectName || "项目"} · 新任务`;
}

async function sendFromInlineButton(button) {
  if (quickButtonBusy) return;
  quickButtonBusy = true;
  button.disabled = true;
  setQuickButtonVisual(button, "sending");
  try {
    const source = await buildLatestSource();
    if (!source?.text) throw new Error("没有读取到最新回复");
    if (source.isStreaming) throw new Error("当前回复仍在生成");
    const result = await chrome.runtime.sendMessage({ type: "SOL_CODEX_QUICK_SEND", source });
    if (!result?.ok) throw new Error(result?.error || "发送失败");
    if (result.target?.mode === "new" && result.data?.sessionId) {
      setQuickButtonVisual(button, "running");
      watchInlineTask(button, result.data.sessionId);
      button.title = "Codex 新任务正在执行";
      return;
    }
    setQuickButtonVisual(button, "sent");
    const desc = targetDescription(result.target);
    const warning = result?.data?.warning || "";
    button.title = warning || (desc ? `已发送到 Codex：${desc}` : "已发送到 Codex");
    button.dataset.holdUntil = String(Date.now() + 1800);
    setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.holdUntil;
      setQuickButtonVisual(button, "ready");
      button.disabled = false;
    }, 1800);
  } catch (error) {
    setQuickButtonVisual(button, "error");
    button.title = error?.message || String(error);
    button.dataset.holdUntil = String(Date.now() + 2200);
    setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.holdUntil;
      setQuickButtonVisual(button, "ready");
      button.disabled = false;
    }, 2200);
  } finally {
    quickButtonBusy = false;
  }
}

async function ensureQuickButton(source = null) {
  source ||= await buildLatestSource();
  const node = latestAssistantNode();
  if (!source || !node) {
    removeStaleQuickButtons();
    return;
  }

  const target = await getQuickTarget();
  const key = source.messageKey;
  if (!target?.ready) {
    removeStaleQuickButtons();
    return;
  }

  removeStaleQuickButtons(key);
  let wrap = document.querySelector(`.sol-codex-inline-wrap[data-message-key="${CSS.escape(key)}"]`);
  let button = wrap?.querySelector(".sol-codex-inline-btn") || null;
  const host = quickButtonHost(node);
  host?.classList?.add("sol-codex-inline-host");
  if (!wrap || !button) {
    wrap = document.createElement("div");
    wrap.className = "sol-codex-inline-wrap";
    wrap.dataset.messageKey = key;
    button = document.createElement("button");
    button.type = "button";
    button.className = "sol-codex-inline-btn";
    setQuickButtonVisual(button, "ready");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendFromInlineButton(button);
    });
    wrap.appendChild(button);
    host.appendChild(wrap);
  } else if (host && wrap.parentElement !== host) {
    host.appendChild(wrap);
  }

  const streaming = Boolean(source.isStreaming);
  const holding = Number(button.dataset.holdUntil || 0) > Date.now();
  const running = button.dataset.running === "true";
  if (!quickButtonBusy && !holding && !running) {
    button.disabled = streaming;
    setQuickButtonVisual(button, streaming ? "waiting" : "ready");
  }
  const desc = targetDescription(target);
  button.title = streaming
    ? "当前回复仍在生成，完成后可一键发送"
    : `一键发送到 Codex${desc ? `：${desc}` : ""}`;
}

async function publishLatestSource() {
  if (publishRunning) {
    publishQueued = true;
    return;
  }
  publishRunning = true;
  try {
    const source = await buildLatestSource();
    if (!source) {
      removeStaleQuickButtons();
      return;
    }
    const signature = `${source.conversationId}|${source.messageKey}|${source.contentHash}|${source.isStreaming}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      try {
        await chrome.runtime.sendMessage({ type: "SOL_CODEX_SOURCE_UPDATE", source });
      } catch {}
    }
    await ensureQuickButton(source);
  } finally {
    publishRunning = false;
    if (publishQueued) {
      publishQueued = false;
      schedulePublish(150);
    }
  }
}

function schedulePublish(delay = 450) {
  clearTimeout(timer);
  timer = setTimeout(publishLatestSource, delay);
}

const observer = new MutationObserver(() => schedulePublish(streamingNow() ? 650 : 300));
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

// Covers SPA URL/branch changes that do not reliably mutate the latest message node.
setInterval(() => schedulePublish(50), 1800);
schedulePublish(100);

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  const targetKeys = new Set(["bridgeToken", "selectedProject", "selectedSessionByProject", "mode", "openApp", "projectCache", "sessionCacheByProject"]);
  if (Object.keys(changes).some((key) => targetKeys.has(key))) {
    quickTargetCache = null;
    quickTargetAt = 0;
    schedulePublish(80);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SOL_CODEX_REFRESH_INLINE") {
    quickTargetCache = null;
    quickTargetAt = 0;
    schedulePublish(30);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type !== "SOL_CODEX_GET_CONTEXT") return;
  (async () => {
    const selected = currentUserSelection();
    const source = await buildLatestSource();
    const text = selected || source?.text || "";
    sendResponse({
      ok: true,
      source: selected ? "selection" : "latest-assistant",
      text,
      title: pageTitle(),
      url: location.href,
      sourceMeta: selected ? null : source
    });
  })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
