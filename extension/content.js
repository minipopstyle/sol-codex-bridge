const i18n = globalThis.SolCodexI18n;
const t = (...args) => i18n.t(...args);

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
let contextPopover = null;
let contextState = null;
let contextPositionFrame = 0;

async function contextRequest(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) {
    const error = new Error(result?.error || t("error.contextRead"));
    error.status = result?.status;
    error.code = result?.code;
    throw error;
  }
  return result.data;
}

function contextTargetDescription(target) {
  if (!target?.projectPath) return t("context.noProject");
  return `${target.projectName || target.projectPath} · ${target.sessionTitle || t("context.noSession")}`;
}

function contextGitText(git) {
  if (!git?.isGitRepo) return t("context.notGit");
  return [
    `${t("context.branch")}: ${git.branch || "unknown"}`,
    ...(git.changedFiles?.length ? [t("context.changedFiles"), ...git.changedFiles.map((file) => `- ${file}`)] : [t("context.noChangedFiles")]),
    git.diff ? `\n${git.diff}` : "",
    git.stagedDiff ? `\n${t("context.staged")}\n${git.stagedDiff}` : ""
  ].join("\n");
}

function contextTime(value) {
  return i18n.formatTime(value, { seconds: false });
}

function closeContextPopover() {
  const button = contextState?.button;
  contextPopover?.remove();
  contextPopover = null;
  contextState = null;
  document.removeEventListener("pointerdown", onContextOutside, true);
  document.removeEventListener("keydown", onContextKeydown, true);
  window.removeEventListener("resize", scheduleContextPopoverPosition);
  window.removeEventListener("scroll", scheduleContextPopoverPosition, true);
  window.visualViewport?.removeEventListener("resize", scheduleContextPopoverPosition);
  if (contextPositionFrame) cancelAnimationFrame(contextPositionFrame);
  contextPositionFrame = 0;
  if (button?.isConnected) {
    delete button.dataset.holdUntil;
    setQuickButtonVisual(button, "pull", "ready");
    renderInlineButtonMeta(button);
    button.disabled = false;
  }
}

function onContextOutside(event) {
  if (!contextPopover?.contains(event.target) && !event.target.closest?.(".sol-codex-context-btn")) closeContextPopover();
}

function onContextKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeContextPopover();
  }
}

function scheduleContextPopoverPosition() {
  if (contextPositionFrame || !contextPopover) return;
  contextPositionFrame = requestAnimationFrame(() => {
    contextPositionFrame = 0;
    if (contextPopover && contextState?.button?.isConnected) positionContextPopover(contextState.button);
  });
}

function positionContextPopover(button) {
  if (!contextPopover || !button) return;
  const viewport = window.visualViewport;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const margin = Math.min(12, Math.max(6, viewportWidth / 40));
  const gap = 10;
  const panelWidth = Math.max(1, Math.min(640, viewportWidth - margin * 2));
  contextPopover.style.width = `${panelWidth}px`;
  contextPopover.style.maxHeight = `${Math.max(1, viewportHeight - margin * 2)}px`;
  contextPopover.style.visibility = "hidden";
  const measured = contextPopover.getBoundingClientRect();
  const height = Math.min(measured.height || contextPopover.scrollHeight, viewportHeight - margin * 2);
  const width = Math.min(measured.width || panelWidth, viewportWidth - margin * 2);
  const anchor = button.getBoundingClientRect();
  const above = anchor.top - gap - height;
  const below = anchor.bottom + gap;
  const preferredTop = above >= margin
    ? above
    : below + height <= viewportHeight - margin
      ? below
      : above;
  const top = Math.max(margin, Math.min(viewportHeight - height - margin, preferredTop));
  const preferredLeft = anchor.right - width;
  const left = Math.max(margin, Math.min(viewportWidth - width - margin, preferredLeft));
  contextPopover.style.left = `${left}px`;
  contextPopover.style.top = `${top}px`;
  contextPopover.style.visibility = "visible";
}

function contextButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

async function pullContext(kind) {
  const state = contextState;
  if (!state) return;
  state.kind = kind;
  state.loading = true;
  state.error = "";
  renderContextPopover();
  try {
    const { target } = state;
    if (!target?.projectPath || !target.sessionId) throw new Error(t("error.noProjectSession"));
    let data;
    if (kind === "snapshot") data = await contextRequest({ type: "SOL_CODEX_CONTEXT_SNAPSHOT", projectPath: target.projectPath, sessionId: target.sessionId });
    if (kind === "transcript") data = await contextRequest({ type: "SOL_CODEX_CONTEXT_SESSION", projectPath: target.projectPath, sessionId: target.sessionId, maxMessages: 60 });
    if (kind === "git") data = await contextRequest({ type: "SOL_CODEX_CONTEXT_GIT", projectPath: target.projectPath });
    state.text = kind === "git" ? contextGitText(data) : String(data?.text || "");
    state.capturedAt = data?.capturedAt || data?.session?.updatedAt || data?.updatedAt || Date.now();
    if (contextState === state) setQuickButtonVisual(state.button, "pull", "loaded");
  } catch (error) {
    if (contextState === state) state.error = error.message || String(error);
  } finally {
    if (contextState === state) {
      state.loading = false;
      renderContextPopover();
    }
  }
}

async function allowContextRead() {
  const state = contextState;
  if (!state?.target?.projectPath) return;
  state.loading = true;
  state.error = "";
  renderContextPopover();
  try {
    await contextRequest({ type: "SOL_CODEX_CONTEXT_PERMISSION", projectPath: state.target.projectPath, allowed: true });
    if (contextState !== state) return;
    state.allowed = true;
    await pullContext("snapshot");
  } catch (error) {
    if (contextState === state) {
      state.error = error.message || String(error);
      state.loading = false;
      renderContextPopover();
    }
  }
}

function fileController(state) {
  return state.fileController || (state.fileController = globalThis.SolCodexProjectFiles.create({
    state,
    client: globalThis.SolCodexProjectFilesClient,
    button: contextButton,
    render: renderContextPopover,
    insertText: (text) => globalThis.SolCodexChatGPT.insertText(text),
    attachImage: (image) => globalThis.SolCodexChatGPT.attachImage(image)
  }));
}

function renderProjectFiles(state) {
  return fileController(state).render();
}

async function refreshContextTarget() {
  const state = contextState;
  if (!state) return;
  const target = await getQuickTarget({ fresh: true });
  if (contextState !== state) return;
  const previousKey = `${state.target?.projectPath || ""}|${state.target?.sessionId || ""}|${state.target?.mode || ""}`;
  const nextKey = `${target?.projectPath || ""}|${target?.sessionId || ""}|${target?.mode || ""}`;
  if (previousKey === nextKey) return;
  state.target = target;
  state.allowed = null;
  state.loading = true;
  state.error = "";
  state.text = "";
  state.fileCache.clear();
  state.fileExpanded = new Set([""]);
  state.fileLoading.clear();
  state.fileDirectoryRequests = new Map();
  state.fileErrors.clear();
  state.fileSelected = null;
  state.fileSelectedPath = "";
  state.filePreview = null;
  state.filePreviewError = "";
  state.fileImageData = null;
  state.fileImageLoading = false;
  state.fileAction = "idle";
  state.fileActionError = "";
  state.filePreviewLoading = false;
  state.filePreviewRequestId += 1;
  state.fileCopied = false;
  state.fileMobileView = "tree";
  renderContextPopover();
  if (!target?.projectPath) {
    state.loading = false;
    renderContextPopover();
    return;
  }
  try {
    const permission = await contextRequest({ type: "SOL_CODEX_CONTEXT_PERMISSION", projectPath: target.projectPath });
    if (contextState !== state) return;
    state.allowed = Boolean(permission.allowed);
    state.loading = false;
    renderContextPopover();
    if (!state.allowed) return;
    if (state.kind === "files") fileController(state).loadRoot();
    else if (target.sessionId) pullContext(state.kind);
  } catch (error) {
    if (contextState !== state) return;
    state.loading = false;
    state.error = error.message || String(error);
    renderContextPopover();
  }
}

function renderContextPopover() {
  if (!contextPopover || !contextState) return;
  const { target } = contextState;
  const button = contextState.button;
  if (button?.isConnected) {
    const state = contextState.loading ? "loading" : contextState.error ? "error" : contextState.text ? "loaded" : "ready";
    setQuickButtonVisual(button, "pull", state);
    renderInlineButtonMeta(button);
    button.disabled = Boolean(contextState.loading);
  }
  contextPopover.replaceChildren();
  const header = document.createElement("div");
  header.className = "sol-codex-context-header";
  const title = document.createElement("strong");
  title.className = "sol-codex-context-title";
  title.textContent = t("context.pullTitle");
  const targetText = document.createElement("div");
  targetText.className = "sol-codex-context-target";
  targetText.textContent = contextTargetDescription(target);
  header.append(title, targetText);
  contextPopover.appendChild(header);

  if (!target?.projectPath) {
    const empty = document.createElement("p");
    empty.className = "sol-codex-context-muted";
    empty.textContent = t("context.chooseProject");
    const body = document.createElement("div");
    body.className = "sol-codex-context-body";
    body.appendChild(empty);
    contextPopover.appendChild(body);
    scheduleContextPopoverPosition();
    return;
  }

  if (contextState.allowed === false) {
    const permission = document.createElement("div");
    permission.className = "sol-codex-context-permission";
    permission.textContent = `${t("context.permissionRequired")}: ${target.projectPath}`;
    permission.appendChild(contextButton(t("context.allow"), "sol-codex-context-primary", allowContextRead));
    const body = document.createElement("div");
    body.className = "sol-codex-context-body";
    body.appendChild(permission);
    if (contextState.error) appendContextError(body, contextState.error);
    contextPopover.appendChild(body);
    scheduleContextPopoverPosition();
    return;
  }

  const actions = document.createElement("div");
  actions.className = "sol-codex-context-tabs";
  const actionItems = [
    ["snapshot", t("context.tabs.snapshot")],
    ["transcript", t("context.tabs.transcript")],
    ["git", t("context.tabs.git")],
    ["files", t("context.tabs.files")]
  ];
  for (const [kind, label] of actionItems) {
    const button = contextButton(label, contextState.kind === kind ? "active" : "", () => {
      if (kind === "files") {
        contextState.kind = "files";
        contextState.text = "";
        contextState.error = "";
        renderContextPopover();
        fileController(contextState).loadRoot();
      } else pullContext(kind);
    });
    actions.appendChild(button);
  }
  contextPopover.appendChild(actions);
  const body = document.createElement("div");
  body.className = "sol-codex-context-body";
  if (contextState.kind === "files") {
    body.appendChild(renderProjectFiles(contextState));
  } else if (!target.sessionId) {
    const empty = document.createElement("div");
    empty.className = "sol-codex-context-muted";
    empty.textContent = t("context.chooseSession");
    body.appendChild(empty);
  } else if (contextState.loading) {
    const loading = document.createElement("div");
    loading.className = "sol-codex-context-muted";
    loading.textContent = t("context.readingEllipsis");
    body.appendChild(loading);
  } else if (contextState.text) {
    const preview = document.createElement("div");
    preview.className = "sol-codex-context-preview";
    const toolbar = document.createElement("div");
    toolbar.className = "sol-codex-context-preview-toolbar";
    const label = document.createElement("span");
    const contextLabel = t("context.loaded", { label: t(`context.tabs.${contextState.kind}`) });
    label.textContent = `${contextLabel}${contextTime(contextState.capturedAt) ? ` · ${contextTime(contextState.capturedAt)}` : ""}`;
    const size = document.createElement("span");
    size.textContent = `${(new Blob([contextState.text]).size / 1024).toFixed(1)} KB`;
    toolbar.append(label, size);
    const content = document.createElement("pre");
    content.className = "sol-codex-context-preview-content";
    content.textContent = contextState.text.length > 900 ? `${contextState.text.slice(0, 900)}\n…` : contextState.text;
    preview.append(toolbar, content);
    body.appendChild(preview);
    body.appendChild(contextButton(t("context.insert"), "sol-codex-context-primary", () => {
      const button = contextState.button;
      if (globalThis.SolCodexChatGPT.insertText(contextState.text).ok) {
        closeContextPopover();
        if (button?.isConnected) {
          button.disabled = true;
          setQuickButtonVisual(button, "pull", "inserted");
          setTimeout(() => {
            if (!button.isConnected) return;
            setQuickButtonVisual(button, "pull", "ready");
            button.disabled = false;
          }, 1200);
        }
      } else contextState.error = t("error.noComposer");
      renderContextPopover();
    }));
  }
  if (contextState.error) appendContextError(body, contextState.error);
  contextPopover.appendChild(body);
  scheduleContextPopoverPosition();
}

function appendContextError(parent, message) {
  const error = document.createElement("div");
  error.className = "sol-codex-context-error";
  error.textContent = message;
  parent.appendChild(error);
}

async function openContextPopover(button) {
  closeContextPopover();
  button.disabled = true;
  setQuickButtonVisual(button, "pull", "loading");
  const target = await getQuickTarget({ fresh: true });
  const state = {
    target, button, allowed: null, kind: "snapshot", text: "", results: [], capturedAt: null, loading: true, error: "",
    fileCache: new Map(), fileExpanded: new Set([""]), fileLoading: new Set(), fileErrors: new Map(),
    fileDirectoryRequests: new Map(),
    fileSelected: null, fileSelectedPath: "", filePreview: null, filePreviewLoading: false, filePreviewError: "",
    fileImageData: null, fileImageLoading: false, fileAction: "idle", fileActionError: "",
    filePreviewRequestId: 0, fileCopied: false, fileMobileView: "tree"
  };
  contextState = state;
  contextPopover = document.createElement("section");
  contextPopover.className = "sol-codex-context-popover";
  contextPopover.setAttribute("role", "dialog");
  document.body.appendChild(contextPopover);
  renderContextPopover();
  positionContextPopover(button);
  document.addEventListener("pointerdown", onContextOutside, true);
  document.addEventListener("keydown", onContextKeydown, true);
  window.addEventListener("resize", scheduleContextPopoverPosition);
  window.addEventListener("scroll", scheduleContextPopoverPosition, true);
  window.visualViewport?.addEventListener("resize", scheduleContextPopoverPosition);
  try {
    if (!target?.projectPath) throw new Error(t("context.chooseProject"));
    const permission = await contextRequest({ type: "SOL_CODEX_CONTEXT_PERMISSION", projectPath: target.projectPath });
    if (contextState !== state) return;
    state.allowed = Boolean(permission.allowed);
    state.loading = false;
    renderContextPopover();
    if (state.allowed && target.sessionId) pullContext("snapshot");
    else {
      setQuickButtonVisual(button, "pull", state.allowed ? "error" : "ready");
      if (!state.allowed) button.disabled = false;
    }
  } catch (error) {
    if (contextState !== state) return;
    state.loading = false;
    state.error = error.message || String(error);
    renderContextPopover();
    setQuickButtonVisual(button, "pull", "error");
  }
}

function createArrowIcon(direction = "right", check = false) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sol-codex-inline-icon");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", check ? "M3.25 8.25 6.35 11.1 12.75 4.9" : "M2.75 8h9.5m-3.25-3.25 3.25 3.25-3.25 3.25");
  if (direction === "left" && !check) svg.classList.add("left");
  svg.appendChild(path);
  return svg;
}

function setQuickButtonVisual(button, action = "push", state = "ready", force = false) {
  const renderState = `${action}:${state}`;
  if (!force && button.dataset.renderState === renderState) return;
  button.dataset.renderState = renderState;
  button.dataset.state = state;
  button.dataset.action = action;
  button.replaceChildren();
  button.setAttribute("aria-label", action === "pull" ? "← Sol" : "Codex →");
  const label = document.createElement("span");
  label.className = "sol-codex-inline-label";

  if (state === "ready") {
    const icon = createArrowIcon(action === "pull" ? "left" : "right");
    if (action === "pull") button.append(icon, label);
    else button.append(label, icon);
    label.textContent = t(action === "pull" ? "inline.pullReady" : "inline.ready");
    return;
  }

  if (state === "loaded") {
    label.textContent = t("inline.loaded");
    button.appendChild(label);
    return;
  }

  if (state === "sent") {
    label.textContent = t("inline.sent");
    button.appendChild(label);
    return;
  }

  if (state === "inserted") {
    label.textContent = t("inline.inserted");
    button.appendChild(label);
    return;
  }

  const key = state === "sending" ? "inline.sending" : state === "running" ? "inline.running" : state === "loading" ? "inline.generating" : "inline.retry";
  label.textContent = t(key);
  button.appendChild(label);
}

function renderInlineButtonMeta(button) {
  const action = button.dataset.action || "push";
  const state = button.dataset.state || "ready";
  if (button.dataset.errorMessage && state === "error") {
    button.title = button.dataset.errorMessage;
    return;
  }
  if (action === "pull") {
    button.title = !button.dataset.hasSession
      ? t("inline.pullNeedSession")
      : state === "loaded" ? t("inline.pullLoadedTitle")
        : state === "inserted" ? t("inline.pullInsertedTitle")
          : t("inline.pullTitle");
    return;
  }
  if (state === "loading") button.title = t("inline.streamingTitle");
  else if (state === "sending") button.title = t("inline.sendingTitle");
  else if (state === "running") button.title = t("inline.runningTitle");
  else if (state === "sent") button.title = t("inline.sentTitle", { target: button.dataset.targetDescription || "" });
  else if (state === "error") button.title = t("inline.retryTitle");
  else button.title = t("inline.pushTitle", { target: button.dataset.targetDescription ? `: ${button.dataset.targetDescription}` : "" });
}

function renderInlineButtons() {
  observer.disconnect();
  document.querySelectorAll(".sol-codex-inline-btn").forEach((button) => {
    setQuickButtonVisual(button, button.dataset.action || "push", button.dataset.state || "ready", true);
    renderInlineButtonMeta(button);
  });
  if (contextPopover) renderContextPopover();
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

function stopInlineTaskTimer(button) {
  delete button.dataset.running;
}

function restoreQuickButton(button) {
  stopInlineTaskTimer(button);
  delete button.dataset.running;
  button.dataset.holdUntil = String(Date.now() + 1800);
  setQuickButtonVisual(button, "push", "sent");
  renderInlineButtonMeta(button);
  setTimeout(() => {
    if (!button.isConnected) return;
    delete button.dataset.holdUntil;
    setQuickButtonVisual(button, "push", "ready");
    renderInlineButtonMeta(button);
    button.disabled = false;
  }, 1800);
}

function watchInlineTask(button, sessionId) {
  button.dataset.running = "true";
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
  if (!keepKey) closeContextPopover();
}

function quickButtonHost(node) {
  const turn = node?.closest?.('article[data-testid^="conversation-turn"]');
  if (turn) return turn;
  const message = node?.closest?.('[data-message-author-role="assistant"]');
  return message || node?.parentElement || document.body;
}

function targetDescription(target) {
  if (!target) return "";
  if (target.mode === "queue") return target.sessionTitle || target.sessionId || t("send.existingSession");
  return `${target.projectName || t("project.title")} · ${t("send.newTask")}`;
}

function makeContextButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sol-codex-inline-btn sol-codex-pull-btn sol-codex-context-btn";
  setQuickButtonVisual(button, "pull", "ready");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openContextPopover(button);
  });
  return button;
}

async function sendFromInlineButton(button) {
  if (quickButtonBusy) return;
  quickButtonBusy = true;
  button.disabled = true;
  setQuickButtonVisual(button, "push", "sending");
  renderInlineButtonMeta(button);
  try {
    const source = await buildLatestSource();
    if (!source?.text) throw new Error(t("error.noLatestReply"));
    if (source.isStreaming) throw new Error(t("error.replyGenerating"));
    const result = await chrome.runtime.sendMessage({ type: "SOL_CODEX_QUICK_SEND", source });
    if (!result?.ok) throw new Error(result?.error || t("inline.retryTitle"));
    if (result.target?.mode === "new" && result.data?.sessionId) {
      setQuickButtonVisual(button, "push", "running");
      watchInlineTask(button, result.data.sessionId);
      delete button.dataset.errorMessage;
      renderInlineButtonMeta(button);
      return;
    }
    setQuickButtonVisual(button, "push", "sent");
    const desc = targetDescription(result.target);
    const warning = result?.data?.warning || "";
    delete button.dataset.errorMessage;
    button.dataset.targetDescription = desc;
    button.title = warning || (desc ? t("inline.sentTitle", { target: desc }) : t("toast.sent"));
    button.dataset.holdUntil = String(Date.now() + 1800);
    setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.holdUntil;
      setQuickButtonVisual(button, "push", "ready");
      renderInlineButtonMeta(button);
      button.disabled = false;
    }, 1800);
  } catch (error) {
    setQuickButtonVisual(button, "push", "error");
    button.dataset.errorMessage = error?.message || String(error);
    renderInlineButtonMeta(button);
    button.dataset.holdUntil = String(Date.now() + 2200);
    setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.holdUntil;
      setQuickButtonVisual(button, "push", "ready");
      renderInlineButtonMeta(button);
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
  let button = wrap?.querySelector(".sol-codex-push-btn") || wrap?.querySelector(".sol-codex-inline-btn:not(.sol-codex-context-btn)") || null;
  let contextButtonElement = wrap?.querySelector(".sol-codex-context-btn") || null;
  let actions = wrap?.querySelector(".sol-codex-inline-actions") || null;
  const host = quickButtonHost(node);
  host?.classList?.add("sol-codex-inline-host");
  if (!wrap || !button) {
    wrap = document.createElement("div");
    wrap.className = "sol-codex-inline-wrap";
    wrap.dataset.messageKey = key;
    actions = document.createElement("div");
    actions.className = "sol-codex-inline-actions";
    contextButtonElement = makeContextButton();
    button = document.createElement("button");
    button.type = "button";
    button.className = "sol-codex-inline-btn sol-codex-push-btn";
    setQuickButtonVisual(button, "push", "ready");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendFromInlineButton(button);
    });
    actions.append(contextButtonElement, button);
    wrap.appendChild(actions);
    host.appendChild(wrap);
  } else {
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "sol-codex-inline-actions";
      contextButtonElement = makeContextButton();
      actions.append(contextButtonElement, button);
      wrap.replaceChildren(actions);
    }
    if (!contextButtonElement) {
      contextButtonElement = makeContextButton();
      actions.prepend(contextButtonElement);
    }
    button.classList.add("sol-codex-push-btn");
    if (actions.childElementCount !== 2 || actions.firstElementChild !== contextButtonElement || actions.lastElementChild !== button) {
      actions.replaceChildren(contextButtonElement, button);
    }
    if (host && wrap.parentElement !== host) host.appendChild(wrap);
  }

  const streaming = Boolean(source.isStreaming);
  const holding = Number(button.dataset.holdUntil || 0) > Date.now();
  const running = button.dataset.running === "true";
  if (!quickButtonBusy && !holding && !running) {
    button.disabled = streaming;
    setQuickButtonVisual(button, "push", streaming ? "loading" : "ready");
  }
  if (contextButtonElement) {
    contextButtonElement.dataset.hasSession = target.sessionId ? "true" : "";
    contextButtonElement.disabled = !target.sessionId;
    renderInlineButtonMeta(contextButtonElement);
  }
  const desc = targetDescription(target);
  button.dataset.targetDescription = desc;
  renderInlineButtonMeta(button);
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

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.uiLanguage) {
    i18n.setLocale(changes.uiLanguage.newValue);
    renderInlineButtons();
    if (contextPopover) renderContextPopover();
  }
  const targetKeys = new Set(["bridgeToken", "selectedProject", "selectedSessionByProject", "mode", "openApp", "projectCache", "sessionCacheByProject"]);
  if (Object.keys(changes).some((key) => targetKeys.has(key))) {
    quickTargetCache = null;
    quickTargetAt = 0;
    schedulePublish(80);
    if (contextPopover) refreshContextTarget();
  }
});

(async () => {
  await i18n.loadLocale();
  renderInlineButtons();
  schedulePublish(100);
})();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SOL_CODEX_REFRESH_INLINE") {
    quickTargetCache = null;
    quickTargetAt = 0;
    schedulePublish(30);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "SOL_CODEX_INSERT_CONTEXT") {
    const result = globalThis.SolCodexChatGPT.insertText(message.text);
    sendResponse({ ok: Boolean(result?.ok), errorCode: result?.code || null });
    return false;
  }
  if (message?.type === "SOL_CODEX_ATTACH_IMAGE_TO_CHATGPT") {
    globalThis.SolCodexChatGPT.attachImage(message.image)
      .then((result) => sendResponse({ ok: Boolean(result?.ok), errorCode: result?.code || null }))
      .catch((error) => sendResponse({ ok: false, errorCode: error?.code || "ATTACH_FAILED" }));
    return true;
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
