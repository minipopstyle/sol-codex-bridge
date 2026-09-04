const i18n = globalThis.SolCodexI18n;
const t = (...args) => i18n.t(...args);
const $ = (id) => document.getElementById(id);
const els = {
  bridgeDot: $("bridgeDot"), bridgeText: $("bridgeText"), pairCard: $("pairCard"),
  tokenInput: $("tokenInput"), saveToken: $("saveToken"), pairError: $("pairError"),
  prompt: $("prompt"), contextMeta: $("contextMeta"), captureContext: $("captureContext"),
  sourceState: $("sourceState"), sourceVersion: $("sourceVersion"), sourceLive: $("sourceLive"), sourceSent: $("sourceSent"),
  refreshAll: $("refreshAll"), projectSelect: $("projectSelect"), projectPath: $("projectPath"),
  toggleAddProject: $("toggleAddProject"), addProjectBox: $("addProjectBox"),
  projectPathInput: $("projectPathInput"), addProject: $("addProject"), projectError: $("projectError"),
  sessionCard: $("sessionCard"), sessionCardTitle: $("sessionCardTitle"), sessionSelect: $("sessionSelect"), sessionMeta: $("sessionMeta"), sessionSync: $("sessionSync"),
  modeHint: $("modeHint"), openApp: $("openApp"), send: $("send"), sendLabel: $("sendLabel"), sendLoader: $("sendLoader"), sendElapsed: $("sendElapsed"),
  actionError: $("actionError"), toast: $("toast"), contextPermission: $("contextPermission"),
  pushView: $("pushView"), pullView: $("pullView"), contextManage: $("contextManage"), contextPermissionMenu: $("contextPermissionMenu"),
  disableContext: $("disableContext"), contextTargetMeta: $("contextTargetMeta"), contextPermissionBox: $("contextPermissionBox"),
  contextPermissionPath: $("contextPermissionPath"), allowContext: $("allowContext"), contextFileTools: $("contextFileTools"),
  contextSearchInput: $("contextSearchInput"), contextSearch: $("contextSearch"), contextResults: $("contextResults"),
  contextPreviewContent: $("contextPreviewContent"), contextPreviewMeta: $("contextPreviewMeta"), insertContext: $("insertContext"), contextError: $("contextError"),
  standardContextView: $("standardContextView"), projectFilesView: $("projectFilesView"),
  projectFilesProjectName: $("projectFilesProjectName"), projectFilesRefresh: $("projectFilesRefresh"),
  projectFilesTreeView: $("projectFilesTreeView"), projectFilePreviewView: $("projectFilePreviewView"),
  projectFilesBack: $("projectFilesBack"), projectFileCopy: $("projectFileCopy"),
  projectFilePreviewMeta: $("projectFilePreviewMeta"), projectFilePreviewContent: $("projectFilePreviewContent"), projectFilePreviewImage: $("projectFilePreviewImage"),
  projectFilePreviewNotice: $("projectFilePreviewNotice"), projectFileInsert: $("projectFileInsert")
};

let token = "";
let projects = [];
let sessions = [];
let sessionCacheByProject = {};
let selectedSessionByProject = {};
let mode = "new";
let currentSource = null;
let lastSent = null;
let activeTabId = null;
let lastAutoPrompt = "";
let sessionPoll = null;
let taskPoll = null;
let elapsedTimer = null;
let elapsedStartedAt = 0;
let bridgeDirection = "push";
let contextPart = "snapshot";
let contextPermission = null;
let contextText = "";
let contextResults = [];
let contextBusy = false;
let contextPermissionMenuOpen = false;
let contextIndexVersion = 0;
let contextCapturedAt = null;
let bridgeView = { kind: "cached", health: null, error: null };
let sendState = "idle";
const pullContextCache = new Map();
let projectFilesState = {
  projectPath: "",
  projectName: "",
  directories: new Map(),
  directoryErrors: new Map(),
  expandedPaths: new Set([""]),
  loadingPaths: new Set(),
  directoryRequests: new Map(),
  selectedFilePath: "",
  selectedFile: null,
  previewLoading: false,
  previewError: "",
  imageData: null,
  imageLoading: false,
  action: "idle",
  actionError: "",
  previewRequestId: 0,
  generation: 0,
  view: "tree",
  copied: false
};

const modeHintKeys = { new: "send.newHint", queue: "send.existingHint" };

function defaultSendLabel() {
  return currentSource && lastSent?.revision !== currentSource.revision
    ? t("send.revision", { revision: currentSource.revision })
    : t("send.toCodex");
}

function renderSendState() {
  const busy = sendState !== "idle";
  els.send.disabled = busy;
  els.send.classList.toggle("loading", busy);
  els.sendLabel.textContent = sendState === "sending" ? t("send.sending") : sendState === "running" ? t("send.running") : defaultSendLabel();
  els.sendLoader.classList.toggle("hidden", !busy);
  els.sendElapsed.classList.toggle("hidden", !busy);
}

function setSendState(next) {
  sendState = next === "running" || next === "sending" ? next : "idle";
  const busy = sendState !== "idle";
  renderSendState();
  if (busy && !elapsedTimer) {
    elapsedStartedAt = Date.now();
    const tick = () => { els.sendElapsed.textContent = `${((Date.now() - elapsedStartedAt) / 1000).toFixed(1)}s`; };
    tick();
    elapsedTimer = setInterval(tick, 100);
  }
  if (!busy && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function setSendBusy(busy) {
  setSendState(busy ? "sending" : "idle");
}

function watchNewTask(sessionId) {
  clearTimeout(taskPoll);
  const check = async () => {
    try {
      const result = await bg({
        type: "SOL_CODEX_BRIDGE_REQUEST",
        path: `/api/actions/task-status?sessionId=${encodeURIComponent(sessionId)}`,
        options: { timeoutMs: 4000 }
      });
      if (result.data?.completed) {
        setSendBusy(false);
        showToast(result.data.success ? t("toast.taskCompleted") : t("toast.taskFailed"));
        return;
      }
    } catch {}
    taskPoll = setTimeout(check, 1200);
  };
  check();
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function applyLanguage(next) {
  const locale = i18n.setLocale(next);
  document.documentElement.lang = locale;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.title = t(element.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll(".language-switch button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.locale === locale));
  });

  renderBridgeStatus();
  renderSourceState();
  renderProjects(els.projectSelect.value, { persist: false });
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  els.modeHint.textContent = t(modeHintKeys[mode]);
  renderDirection();
  renderSendState();
}

async function setLanguage(next) {
  const locale = i18n.normalizeLocale(next);
  applyLanguage(locale);
  await store({ uiLanguage: locale });
}

async function store(values) {
  await chrome.storage.local.set(values);
}

async function bg(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) {
    const error = new Error(result?.error || t("error.backgroundUnavailable"));
    error.status = result?.status;
    throw error;
  }
  return result;
}

function selectedProject() {
  return projects.find((item) => item.path === els.projectSelect.value) || null;
}

function selectedSession() {
  return sessions.find((item) => item.id === els.sessionSelect.value) || null;
}

function statusLabel(status) {
  if (status === "locked") return t("session.locked");
  if (status === "active") return t("session.active");
  return t("session.idle");
}

function latestSessionId(entries) {
  return [...entries]
    .sort((a, b) => Number(new Date(b.updatedAt || 0)) - Number(new Date(a.updatedAt || 0)))[0]?.id || "";
}

function preferredSessionId(projectPath, entries) {
  const saved = selectedSessionByProject[projectPath];
  if (saved && entries.some((item) => item.id === saved)) return saved;
  const active = entries.filter((item) => item.status === "locked" || item.status === "active");
  return latestSessionId(active.length ? active : entries);
}

function formatTime(value) {
  return i18n.formatTime(value);
}

function formatDateTime(value) {
  return i18n.formatDateTime(value);
}

function formatNumber(value) {
  return i18n.formatNumber(value);
}

function renderBridgeStatus() {
  const { kind, health } = bridgeView;
  if (kind === "online" && health) {
    els.bridgeDot.className = "dot online";
    const labels = [t("bridge.connected")];
    if (health.desktop?.found) labels.push(t("bridge.codexAvailable"));
    if (health.codex?.capabilities?.queueCli) labels.push(t("bridge.queueAvailable"));
    if (health.index?.sessions != null) labels.push(t("bridge.sessions", { count: formatNumber(health.index.sessions) }));
    els.bridgeText.textContent = labels.join(" · ");
  } else if (kind === "reconnecting") {
    els.bridgeDot.className = "dot error";
    els.bridgeText.textContent = projects.length ? t("bridge.reconnecting") : t("bridge.disconnected");
  } else if (health?.ok) {
    els.bridgeDot.className = "dot online";
    els.bridgeText.textContent = t("bridge.cachedRestored");
  } else {
    els.bridgeDot.className = "dot";
    els.bridgeText.textContent = t("bridge.cacheConnecting");
  }
}

function renderCachedBridge(saved) {
  bridgeView = { kind: "cached", health: saved.bridgeHealth || null, error: null };
  renderBridgeStatus();
}

function renderSourceState() {
  els.sourceState.className = "source-state neutral";
  els.sourceLive.textContent = "";
  if (!currentSource) {
    els.sourceVersion.textContent = t("plan.waiting");
    els.sourceSent.textContent = t("plan.following");
    return;
  }

  const revision = Number(currentSource.revision || 1);
  els.sourceVersion.textContent = `V${revision} · ${currentSource.pending ? t("plan.generating") : t("plan.latest")}`;
  els.sourceLive.textContent = currentSource.pending ? t("plan.syncing") : formatTime(currentSource.updatedAt || currentSource.capturedAt);

  const sentSame = Boolean(
    lastSent &&
    lastSent.conversationId === currentSource.conversationId &&
    Number(lastSent.revision) === revision &&
    lastSent.contentHash === currentSource.contentHash
  );

  if (sentSame) {
    els.sourceState.className = "source-state synced";
    els.sourceSent.textContent = t("plan.sentCurrent", { revision });
  } else if (lastSent?.conversationId === currentSource.conversationId) {
    els.sourceState.className = "source-state pending";
    els.sourceSent.textContent = t("plan.sentNew", { revision: lastSent.revision || "?", currentRevision: revision });
  } else {
    els.sourceState.className = "source-state pending";
    els.sourceSent.textContent = t("plan.notSent", { revision });
  }
}

function applySource(source, sent = undefined) {
  if (!source) return;
  const canAutoReplace = !els.prompt.value.trim() || els.prompt.value === lastAutoPrompt;
  currentSource = source;
  if (sent !== undefined) lastSent = sent;
  if (canAutoReplace && source.text) {
    els.prompt.value = source.text;
    lastAutoPrompt = source.text;
  }
  els.contextMeta.textContent = t("plan.sourceMeta", {
    title: source.title || "ChatGPT",
    count: t("plan.characters", { count: formatNumber(source.text.length) })
  });
  renderSourceState();
}

async function getActiveChatGPTTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(?:[^.]+\.)?chatgpt\.com\//i.test(tab.url || "")) return null;
  return tab;
}

async function restoreSourceState() {
  const tab = await getActiveChatGPTTab();
  activeTabId = tab?.id || null;
  if (!activeTabId) {
    els.contextMeta.textContent = t("error.notChatGPT");
    return;
  }
  try {
    const result = await bg({ type: "SOL_CODEX_GET_SOURCE_STATE", tabId: activeTabId });
    if (result.source) {
      currentSource = result.source;
      lastSent = result.lastSent || null;
      applySource(result.source, result.lastSent || null);
      return;
    }
  } catch {}
  await captureContext(false);
}

function renderProjects(preferredPath, { persist = true } = {}) {
  els.projectSelect.innerHTML = "";
  if (!projects.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("project.none");
    els.projectSelect.appendChild(option);
    els.projectPath.textContent = t("project.pathHint");
    sessions = [];
    renderSessions();
    return;
  }
  const appendOptions = (container, entries) => {
    for (const project of entries) {
      const option = document.createElement("option");
      option.value = project.path;
      option.textContent = project.name;
      container.appendChild(option);
    }
  };
  const codexProjects = projects.filter((project) => project.source?.includes("codex-projects-db"));
  const manualProjects = projects.filter((project) => !project.source?.includes("codex-projects-db") && project.source?.includes("manual"));
  const fallbackProjects = projects.filter((project) => !codexProjects.includes(project) && !manualProjects.includes(project));
  if (codexProjects.length) {
    const group = document.createElement("optgroup");
    group.label = t("project.group");
    appendOptions(group, codexProjects);
    els.projectSelect.appendChild(group);
  }
  if (manualProjects.length) {
    const group = document.createElement("optgroup");
    group.label = t("project.manual");
    appendOptions(group, manualProjects);
    els.projectSelect.appendChild(group);
  }
  if (fallbackProjects.length) {
    const group = document.createElement("optgroup");
    group.label = t("project.group");
    appendOptions(group, fallbackProjects);
    els.projectSelect.appendChild(group);
  }
  const exists = projects.some((item) => item.path === preferredPath);
  els.projectSelect.value = exists ? preferredPath : projects[0].path;
  const project = selectedProject();
  els.projectPath.textContent = project?.path || "";
  useCachedSessions(project?.path || "", persist);
}

function renderSessions(persist = true) {
  const project = selectedProject();
  const preferred = project ? preferredSessionId(project.path, sessions) : null;
  const currentValue = els.sessionSelect.value;
  els.sessionSelect.innerHTML = "";
  if (!sessions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("session.none");
    els.sessionSelect.appendChild(option);
    els.sessionMeta.textContent = bridgeDirection === "pull" ? t("session.nonePull") : t("session.nonePush");
    return;
  }
  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    const title = String(session.title || session.id.slice(0, 8));
    const visibleTitle = [...title].length > 20 ? `${[...title].slice(0, 20).join("")}…` : title;
    option.textContent = `${visibleTitle} · ${statusLabel(session.status)}`;
    option.title = `${title} · ${statusLabel(session.status)}`;
    els.sessionSelect.appendChild(option);
  }
  const wanted = (persist ? [preferred, currentValue] : [currentValue, preferred]).find((id) => sessions.some((item) => item.id === id));
  els.sessionSelect.value = wanted || sessions[0].id;
  // Persist the effective target even when the user accepts the default item.
  // The ChatGPT inline `Codex →` button reads this durable selection while the side panel is closed.
  onSessionChanged(persist);
}

function useCachedSessions(projectPath, persist = true) {
  const cached = sessionCacheByProject?.[projectPath];
  sessions = cached?.sessions || [];
  renderSessions(persist);
  if (cached?.updatedAt) els.sessionSync.textContent = t("session.cached", { time: formatTime(cached.updatedAt) });
  else els.sessionSync.textContent = "";
}

async function checkBridge({ quiet = false } = {}) {
  try {
    const result = await bg({ type: "SOL_CODEX_HEALTH" });
    const health = result.data;
    contextIndexVersion = Number(health.index?.version || 0);
    bridgeView = { kind: "online", health, error: null };
    renderBridgeStatus();
    if (health.authRequired && !token) els.pairCard.classList.remove("hidden");
    if (!quiet) els.actionError.textContent = "";
    return health;
  } catch (error) {
    bridgeView = { kind: "reconnecting", health: null, error };
    renderBridgeStatus();
    if (!quiet) els.actionError.textContent = error.message;
    return null;
  }
}

async function syncProjects({ quiet = true, preferredPath = null } = {}) {
  if (!token) return;
  try {
    const result = await bg({ type: "SOL_CODEX_LOAD_PROJECTS" });
    const data = result.data;
    const keep = preferredPath || els.projectSelect.value || (await chrome.storage.local.get(["selectedProject"])).selectedProject;
    projects = data.projects || [];
    renderProjects(keep);
    els.projectError.textContent = "";
    const project = selectedProject();
    if (project) {
      await store({ selectedProject: project.path });
      await syncSessions(project.path, { quiet: true });
    }
  } catch (error) {
    if (!quiet) els.projectError.textContent = error.message;
  }
}

async function syncSessions(projectPath, { quiet = true } = {}) {
  if (!token || !projectPath) return;
  try {
    const result = await bg({ type: "SOL_CODEX_LOAD_SESSIONS", projectPath });
    const data = result.data;
    contextIndexVersion = Number(data.indexVersion || contextIndexVersion || 0);
    sessionCacheByProject = { ...sessionCacheByProject, [projectPath]: data };
    if (selectedProject()?.path === projectPath) {
      const selectedBefore = els.sessionSelect.value;
      sessions = data.sessions || [];
      renderSessions();
      if (selectedBefore && sessions.some((item) => item.id === selectedBefore)) {
        els.sessionSelect.value = selectedBefore;
        onSessionChanged(false);
      }
      els.sessionSync.textContent = t("session.synced", { time: formatTime(Date.now()) });
    }
  } catch (error) {
    if (!quiet) els.sessionMeta.textContent = error.message;
  }
}

async function captureContext(showReading = true) {
  if (showReading) els.contextMeta.textContent = t("plan.readingPage");
  try {
    const tab = await getActiveChatGPTTab();
    if (!tab) throw new Error(t("error.notChatGPT"));
    activeTabId = tab.id;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "SOL_CODEX_GET_CONTEXT" });
    if (!response?.text) throw new Error(response?.error || t("plan.noLatestReply"));
    if (response.source === "selection") {
      els.prompt.value = response.text;
      lastAutoPrompt = "";
      els.contextMeta.textContent = t("plan.selectedMeta", {
        label: t("plan.selectedText"),
        count: t("plan.characters", { count: formatNumber(response.text.length) })
      });
      els.sourceLive.textContent = t("plan.selected");
    } else {
      els.prompt.value = response.text;
      lastAutoPrompt = response.text;
      els.contextMeta.textContent = t("plan.selectedMeta", {
        label: t("plan.latestAssistant"),
        count: t("plan.characters", { count: formatNumber(response.text.length) })
      });
      // Content script will publish source metadata to background; refresh its state shortly.
      setTimeout(restoreSourceState, 120);
    }
  } catch (error) {
    els.contextMeta.textContent = error.message;
  }
}

async function onProjectChanged(refresh = true) {
  const project = selectedProject();
  els.projectPath.textContent = project?.path || "";
  if (!project) return;
  contextText = "";
  contextResults = [];
  await store({ selectedProject: project.path });
  useCachedSessions(project.path);
  if (refresh) await syncSessions(project.path, { quiet: true });
  await syncContextPermission();
  if (bridgeDirection === "pull" && contextPermission === true && (contextPart === "files" || selectedSession())) {
    await pullSideContext(contextPart);
  }
}

async function onSessionChanged(save = true) {
  const session = selectedSession();
  if (!session) return;
  const bits = [statusLabel(session.status)];
  if (session.modelProvider) bits.push(session.modelProvider);
  if (session.gitBranch) bits.push(session.gitBranch);
  if (session.updatedAt) bits.push(formatDateTime(session.updatedAt));
  els.sessionMeta.textContent = bits.join(" · ");
  if (save) {
    const project = selectedProject();
    if (project) {
      selectedSessionByProject = { ...selectedSessionByProject, [project.path]: session.id };
      await store({ selectedSessionByProject });
    }
  }
}

async function contextBg(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) {
    const error = new Error(result?.error || t("error.contextRead"));
    error.status = result?.status;
    throw error;
  }
  return result.data;
}

function contextTarget() {
  return { project: selectedProject(), session: selectedSession() };
}

const contextLabels = {
  snapshot: "context.tabs.snapshot",
  transcript: "context.tabs.transcript",
  git: "context.tabs.git",
  files: "context.tabs.files"
};

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function contextCacheKey(part, project, session) {
  const indexVersion = Number(sessionCacheByProject[project.path]?.indexVersion || contextIndexVersion || 0);
  return `${project.path}\0${session.id}\0${part}\0${indexVersion}`;
}

function applyCachedContext(cached) {
  contextText = cached?.text || "";
  contextResults = cached?.results || [];
  contextCapturedAt = cached?.capturedAt || null;
}

function projectFilesErrorText(error, fallbackKey) {
  switch (error?.code) {
    case "PROJECT_NOT_FOUND":
    case "PROJECT_NOT_RECOGNIZED":
    case "PROJECT_PATH_INVALID":
    case "PROJECT_NOT_DIRECTORY":
      return t("files.projectMissing");
    case "PATH_NOT_FOUND":
    case "DIRECTORY_NOT_FOUND":
    case "FILE_NOT_FOUND":
      return t("files.notFound");
    case "PROJECT_PERMISSION_REQUIRED":
    case "FILE_READ_DENIED":
    case "DIRECTORY_READ_DENIED":
      return t("files.permissionDenied");
    case "PATH_TRAVERSAL_BLOCKED":
      return t("files.blockedLink");
    case "API_UNSUPPORTED":
      return t("files.apiUnsupported");
    default:
      if (error?.status === 401) return t("files.pairing");
      if (error?.status === 404) return t("files.apiUnsupported");
      if (!error?.status) return t("files.bridgeDisconnected");
      return error?.message || t(fallbackKey);
  }
}

function fileChevron(expanded) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("project-file-chevron");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 2.5 7.5 6 4 9.5");
  svg.appendChild(path);
  if (expanded) svg.classList.add("expanded");
  return svg;
}

function fileIcon(type) {
  const icon = document.createElement("span");
  icon.className = "project-file-icon " + (type === "directory" ? "folder" : "file");
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function renderProjectFileEntries(parent, entries, depth = 0) {
  for (const entry of entries) {
    const isDirectory = entry.type === "directory";
    const expanded = isDirectory && projectFilesState.expandedPaths.has(entry.path);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "project-file-row" + (projectFilesState.selectedFilePath === entry.path ? " selected" : "");
    row.style.paddingInlineStart = (8 + depth * 15) + "px";
    row.title = entry.path;
    row.disabled = Boolean(entry.blocked);
    if (isDirectory) row.setAttribute("aria-expanded", String(expanded));
    row.appendChild(isDirectory ? fileChevron(expanded) : document.createElement("span"));
    row.lastChild.classList.add("project-file-chevron-spacer");
    row.appendChild(fileIcon(entry.type));
    const name = document.createElement("span");
    name.className = "project-file-name";
    name.textContent = entry.name;
    row.appendChild(name);
    if (entry.sensitive || entry.blocked) {
      const meta = document.createElement("span");
      meta.className = "project-file-label";
      meta.textContent = t(entry.sensitive ? "files.sensitiveLabel" : "files.blockedLinkLabel");
      row.appendChild(meta);
    }
    row.addEventListener("click", () => {
      if (isDirectory) {
        if (expanded) {
          projectFilesState.expandedPaths.delete(entry.path);
          renderProjectFilesView();
        } else {
          projectFilesState.expandedPaths.add(entry.path);
          renderProjectFilesView();
          loadProjectDirectory(entry.path);
        }
      } else {
        loadProjectFile(entry);
      }
    });
    parent.appendChild(row);

    if (!expanded) continue;
    if (projectFilesState.loadingPaths.has(entry.path)) {
      const loading = document.createElement("div");
      loading.className = "project-file-tree-note";
      loading.style.paddingInlineStart = (23 + (depth + 1) * 15) + "px";
      loading.textContent = t("files.loading");
      parent.appendChild(loading);
    } else if (projectFilesState.directoryErrors.has(entry.path)) {
      const error = document.createElement("div");
      error.className = "project-file-tree-error";
      error.style.paddingInlineStart = (23 + (depth + 1) * 15) + "px";
      error.textContent = projectFilesState.directoryErrors.get(entry.path);
      parent.appendChild(error);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-btn project-file-retry";
      retry.style.marginInlineStart = (23 + (depth + 1) * 15) + "px";
      retry.textContent = t("files.retry");
      retry.addEventListener("click", () => loadProjectDirectory(entry.path, true));
      parent.appendChild(retry);
    } else if (projectFilesState.directories.has(entry.path)) {
      renderProjectFileEntries(parent, projectFilesState.directories.get(entry.path), depth + 1);
    }
  }
}

function renderProjectFilesTree() {
  els.projectFilesTreeView.replaceChildren();
  if (!projectFilesState.projectPath) {
    const empty = document.createElement("div");
    empty.className = "project-file-tree-note";
    empty.textContent = t("files.noProject");
    els.projectFilesTreeView.appendChild(empty);
    return;
  }
  if (contextPermission !== true) {
    const empty = document.createElement("div");
    empty.className = "project-file-tree-note";
    empty.textContent = contextPermission === false ? t("context.permissionRequired") : t("context.permissionNotChecked");
    els.projectFilesTreeView.appendChild(empty);
    return;
  }
  const root = document.createElement("div");
  root.className = "project-file-root";
  root.title = projectFilesState.projectPath;
  root.append(fileIcon("directory"));
  const rootName = document.createElement("strong");
  rootName.className = "project-file-name";
  rootName.textContent = projectFilesState.projectName || projectFilesState.projectPath.split(/[\\/]/).filter(Boolean).pop();
  root.appendChild(rootName);
  els.projectFilesTreeView.appendChild(root);

  if (projectFilesState.loadingPaths.has("")) {
    const loading = document.createElement("div");
    loading.className = "project-file-tree-note";
    loading.textContent = t("files.loading");
    els.projectFilesTreeView.appendChild(loading);
  } else if (projectFilesState.directoryErrors.has("")) {
    const error = document.createElement("div");
    error.className = "project-file-tree-error";
    error.textContent = projectFilesState.directoryErrors.get("");
    els.projectFilesTreeView.appendChild(error);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "text-btn project-file-retry";
    retry.textContent = t("files.retry");
    retry.addEventListener("click", () => loadProjectDirectory("", true));
    els.projectFilesTreeView.appendChild(retry);
  } else if (projectFilesState.directories.has("")) {
    const entries = projectFilesState.directories.get("");
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "project-file-tree-note";
      empty.textContent = t("files.empty");
      els.projectFilesTreeView.appendChild(empty);
    } else {
      renderProjectFileEntries(els.projectFilesTreeView, entries);
    }
  }
}

function renderProjectFilePreview() {
  const selected = projectFilesState.selectedFile;
  const isImage = selected?.kind === "image";
  const hasContent = !projectFilesState.previewLoading && !isImage && selected?.content != null;
  const hasImage = !projectFilesState.previewLoading && !projectFilesState.imageLoading && isImage && projectFilesState.imageData?.base64;
  els.projectFilePreviewMeta.textContent = selected
    ? (selected.path || selected.name || "") + (selected.size != null ? " · " + formatBytes(selected.size) : "")
    : t("files.noPreview");
  els.projectFilePreviewContent.classList.toggle("hidden", Boolean(isImage));
  els.projectFilePreviewContent.textContent = hasContent ? selected.content : "";
  els.projectFilePreviewImage.classList.toggle("hidden", !hasImage);
  if (hasImage) {
    els.projectFilePreviewImage.src = "data:" + selected.mime + ";base64," + projectFilesState.imageData.base64;
    els.projectFilePreviewImage.alt = selected.name || t("files.title");
  } else {
    els.projectFilePreviewImage.removeAttribute("src");
    els.projectFilePreviewImage.alt = "";
  }
  els.projectFilePreviewNotice.textContent = projectFilesState.previewLoading
    ? t("files.loading")
    : projectFilesState.previewError
      ? projectFilesState.previewError
      : selected?.blocked
        ? t("files.sensitive")
        : isImage && selected?.tooLarge
          ? t("files.imageTooLarge", { max: formatBytes(selected.maxBytes) })
          : isImage && projectFilesState.imageLoading
            ? t("files.imageLoading")
            : isImage && !hasImage
              ? t("files.imageUnsupported")
              : selected?.unsupportedImage
                ? t("files.imageUnsupported")
                : selected?.kind === "binary" || selected?.binary
                  ? t("files.binaryUnsupported")
        : selected?.tooLarge
          ? t("files.tooLarge")
                  : selected && selected.content === ""
                    ? t("files.emptyFile")
                    : selected ? "" : t("files.noPreview");
  els.projectFileCopy.classList.toggle("hidden", !hasContent);
  els.projectFileCopy.textContent = projectFilesState.copied ? t("files.copied") : t("files.copy");
  els.projectFileCopy.disabled = projectFilesState.copied;
  const canInsert = hasContent || hasImage;
  els.projectFileInsert.textContent = projectFilesState.action === "inserting"
    ? t("files.inserting")
    : projectFilesState.action === "success"
      ? t("files.inserted")
      : isImage ? t("files.insertImage") : t("files.insertText");
  els.projectFileInsert.disabled = !canInsert || projectFilesState.action === "inserting" || projectFilesState.action === "success";
  if (projectFilesState.actionError) els.projectFilePreviewNotice.textContent = projectFilesState.actionError;
}

function renderProjectFilesView() {
  const active = contextPart === "files";
  els.standardContextView.classList.toggle("hidden", active);
  els.projectFilesView.classList.toggle("hidden", !active);
  if (!active) return;
  els.projectFilesProjectName.textContent = projectFilesState.projectName || "";
  els.projectFilesTreeView.classList.toggle("hidden", projectFilesState.view !== "tree");
  els.projectFilePreviewView.classList.toggle("hidden", projectFilesState.view !== "preview");
  renderProjectFilesTree();
  renderProjectFilePreview();
}

function resetProjectFilesState(target = null) {
  projectFilesState = {
    ...projectFilesState,
    projectPath: target?.path || "",
    projectName: target?.name || "",
    directories: new Map(),
    directoryErrors: new Map(),
    expandedPaths: new Set([""]),
    loadingPaths: new Set(),
    directoryRequests: new Map(),
    selectedFilePath: "",
    selectedFile: null,
    previewLoading: false,
    previewError: "",
    imageData: null,
    imageLoading: false,
    action: "idle",
    actionError: "",
    previewRequestId: projectFilesState.previewRequestId + 1,
    generation: projectFilesState.generation + 1,
    view: "tree",
    copied: false
  };
}

async function loadProjectDirectory(relativePath = "", force = false) {
  const client = globalThis.SolCodexProjectFilesClient;
  const projectPath = projectFilesState.projectPath;
  if (!client || !projectPath || projectFilesState.loadingPaths.has(relativePath)) return;
  if (!force && projectFilesState.directories.has(relativePath)) return;
  const generation = projectFilesState.generation;
  const requestId = {};
  projectFilesState.directoryRequests.set(relativePath, requestId);
  projectFilesState.loadingPaths.add(relativePath);
  projectFilesState.directoryErrors.delete(relativePath);
  renderProjectFilesView();
  try {
    const data = await client.listDirectory(projectPath, relativePath);
    if (generation !== projectFilesState.generation || projectFilesState.directoryRequests.get(relativePath) !== requestId) return;
    projectFilesState.directories.set(relativePath, Array.isArray(data?.entries) ? data.entries : []);
  } catch (error) {
    if (generation === projectFilesState.generation && projectFilesState.directoryRequests.get(relativePath) === requestId) {
      projectFilesState.directoryErrors.set(relativePath, projectFilesErrorText(error, "files.directoryError"));
    }
  } finally {
    if (projectFilesState.directoryRequests.get(relativePath) === requestId) {
      projectFilesState.directoryRequests.delete(relativePath);
      projectFilesState.loadingPaths.delete(relativePath);
    }
    renderProjectFilesView();
  }
}

async function loadProjectFile(entry) {
  const client = globalThis.SolCodexProjectFilesClient;
  if (!client || !projectFilesState.projectPath || entry.blocked) return;
  const generation = projectFilesState.generation;
  const requestId = ++projectFilesState.previewRequestId;
  projectFilesState.selectedFilePath = entry.path;
  projectFilesState.selectedFile = entry;
  projectFilesState.previewLoading = true;
  projectFilesState.previewError = "";
  projectFilesState.imageData = null;
  projectFilesState.imageLoading = false;
  projectFilesState.action = "idle";
  projectFilesState.actionError = "";
  projectFilesState.copied = false;
  projectFilesState.view = "preview";
  renderProjectFilesView();
  try {
    const data = await client.readFile(projectFilesState.projectPath, entry.path);
    if (generation !== projectFilesState.generation || requestId !== projectFilesState.previewRequestId) return;
    projectFilesState.selectedFile = { ...entry, ...data };
    projectFilesState.previewLoading = false;
    if (data?.kind === "image" && !data.blocked && !data.tooLarge) {
      projectFilesState.imageLoading = true;
      renderProjectFilesView();
      try {
        const imageData = await client.readFileData(projectFilesState.projectPath, entry.path);
        if (generation !== projectFilesState.generation || requestId !== projectFilesState.previewRequestId) return;
        projectFilesState.imageData = imageData;
      } catch (error) {
        if (generation === projectFilesState.generation && requestId === projectFilesState.previewRequestId) projectFilesState.previewError = projectFilesErrorText(error, "files.fileError");
      } finally {
        if (generation === projectFilesState.generation && requestId === projectFilesState.previewRequestId) projectFilesState.imageLoading = false;
      }
    }
  } catch (error) {
    if (generation === projectFilesState.generation && requestId === projectFilesState.previewRequestId) {
      projectFilesState.previewError = projectFilesErrorText(error, "files.fileError");
    }
  } finally {
    if (generation === projectFilesState.generation && requestId === projectFilesState.previewRequestId) {
      projectFilesState.previewLoading = false;
      projectFilesState.imageLoading = false;
      renderProjectFilesView();
    }
  }
}

async function enterProjectFiles() {
  contextPart = "files";
  contextText = "";
  contextResults = [];
  contextCapturedAt = null;
  contextBusy = false;
  renderContext();
  const client = globalThis.SolCodexProjectFilesClient;
  if (!client) return;
  try {
    const target = await client.getSelectedProject();
    if (contextPart !== "files") return;
    if (!target?.path) {
      resetProjectFilesState();
      renderProjectFilesView();
      return;
    }
    if (projectFilesState.projectPath !== target.path) resetProjectFilesState(target);
    else if (!projectFilesState.projectName) projectFilesState.projectName = target.name || "";
    if (contextPermission !== true) {
      await syncContextPermission();
      if (contextPart !== "files" || contextPermission !== true) return;
    }
    renderProjectFilesView();
    await loadProjectDirectory("");
  } catch (error) {
    projectFilesState.directoryErrors.set("", projectFilesErrorText(error, "files.directoryError"));
    renderProjectFilesView();
  }
}

function renderContext() {
  const { project, session } = contextTarget();
  const projectFilesActive = contextPart === "files";
  els.contextTargetMeta.textContent = projectFilesActive
    ? project ? (project.name || project.path) : t("files.noProject")
    : !project
      ? t("context.chooseProject")
      : session ? t("context.selectType") : t("context.chooseSession");
  els.contextPermission.textContent = contextPermission === true
    ? t("context.permissionAllowed")
    : contextPermission === false ? t("context.permissionDenied") : t("context.permissionNotChecked");
  els.contextManage.classList.toggle("hidden", contextPermission !== true);
  els.contextPermissionMenu.classList.toggle("hidden", contextPermission !== true || !contextPermissionMenuOpen);
  els.contextPermissionBox.classList.toggle("hidden", contextPermission !== false);
  els.contextPermissionPath.textContent = project?.path || "";
  els.contextFileTools.classList.add("hidden");
  const contextLabel = t(contextLabels[contextPart]);
  els.contextPreviewContent.textContent = contextBusy && !contextText
    ? t("context.readingEllipsis")
    : contextText || t("context.selectToRead", { label: contextLabel });
  const contextStamp = contextCapturedAt ? ` · ${formatTime(contextCapturedAt)}` : "";
  els.contextPreviewMeta.textContent = contextText
    ? `${contextLabel}${contextStamp} · ${formatBytes(new Blob([contextText]).size)}`
    : contextBusy ? t("context.reading") : t("context.unread");
  els.insertContext.disabled = projectFilesActive || !contextText || contextBusy;
  els.contextSearch.disabled = contextBusy;
  document.querySelectorAll(".context-tab").forEach((button) => button.classList.toggle("active", button.dataset.contextPart === contextPart));
  els.contextResults.replaceChildren();
  for (const result of contextResults) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-result";
    button.textContent = `${result.path}:${result.line} · ${result.preview}`;
    button.title = result.preview;
    button.addEventListener("click", () => readSideContextFile(result));
    els.contextResults.appendChild(button);
  }
  renderProjectFilesView();
}

async function syncContextPermission() {
  els.contextError.textContent = "";
  const project = selectedProject();
  contextPermission = null;
  contextPermissionMenuOpen = false;
  renderContext();
  if (!project || !token) return;
  try {
    const result = await contextBg({ type: "SOL_CODEX_CONTEXT_PERMISSION", projectPath: project.path });
    contextPermission = Boolean(result.allowed);
    renderContext();
  } catch (error) {
    els.contextError.textContent = error.message;
    renderContext();
  }
}

function contextGitText(git) {
  if (!git?.isGitRepo) return t("context.notGit");
  return [
    `${t("context.branch")}: ${git.branch || "unknown"}`,
    ...(git.changedFiles?.length ? [t("context.changedFiles"), ...git.changedFiles.map((file) => `- ${file}`)] : [t("context.noChangedFiles")]),
    git.diff || "",
    git.stagedDiff ? `${t("context.staged")}\n${git.stagedDiff}` : ""
  ].filter(Boolean).join("\n");
}

async function pullSideContext(part = contextPart) {
  contextPart = part;
  els.contextError.textContent = "";
  const { project, session } = contextTarget();
  if (part === "files") {
    await enterProjectFiles();
    return;
  }
  if (!project || !session) {
    contextText = "";
    contextResults = [];
    contextCapturedAt = null;
    els.contextError.textContent = t("error.noProjectSession");
    renderContext();
    return;
  }
  if (contextPermission !== true) {
    await syncContextPermission();
    if (contextPermission !== true) return;
  }
  const cacheKey = contextCacheKey(part, project, session);
  if (pullContextCache.has(cacheKey)) {
    applyCachedContext(pullContextCache.get(cacheKey));
    contextBusy = false;
    renderContext();
    return;
  }

  contextText = "";
  contextResults = [];
  contextCapturedAt = null;
  contextBusy = true;
  renderContext();
  try {
    let data;
    if (part === "snapshot") data = await contextBg({ type: "SOL_CODEX_CONTEXT_SNAPSHOT", projectPath: project.path, sessionId: session.id });
    if (part === "transcript") data = await contextBg({ type: "SOL_CODEX_CONTEXT_SESSION", projectPath: project.path, sessionId: session.id, maxMessages: 60 });
    if (part === "git") data = await contextBg({ type: "SOL_CODEX_CONTEXT_GIT", projectPath: project.path });
    contextText = part === "git" ? contextGitText(data) : String(data?.text || "");
    contextCapturedAt = data?.capturedAt || data?.session?.updatedAt || data?.updatedAt || Date.now();
    pullContextCache.set(cacheKey, { text: contextText, results: [], capturedAt: contextCapturedAt });
  } catch (error) {
    els.contextError.textContent = error.message;
  } finally {
    contextBusy = false;
    renderContext();
  }
}

async function allowSideContext() {
  const project = selectedProject();
  if (!project) return;
  contextBusy = true;
  els.contextError.textContent = "";
  renderContext();
  try {
    await contextBg({ type: "SOL_CODEX_CONTEXT_PERMISSION", projectPath: project.path, allowed: true });
    contextPermission = true;
    contextBusy = false;
    await pullSideContext(contextPart === "files" ? "files" : "snapshot");
  } catch (error) {
    els.contextError.textContent = error.message;
    contextBusy = false;
    renderContext();
  }
}

async function disableSideContext() {
  const project = selectedProject();
  if (!project) return;
  try {
    await contextBg({ type: "SOL_CODEX_CONTEXT_PERMISSION", projectPath: project.path, allowed: false });
    contextPermission = false;
    contextPermissionMenuOpen = false;
    contextText = "";
    contextResults = [];
    renderContext();
  } catch (error) {
    els.contextError.textContent = error.message;
  }
}

async function searchSideContext() {
  const project = selectedProject();
  const query = els.contextSearchInput.value.trim();
  if (!project || !query) return;
  contextBusy = true;
  els.contextError.textContent = "";
  renderContext();
  try {
    contextResults = await contextBg({ type: "SOL_CODEX_CONTEXT_SEARCH", projectPath: project.path, query, maxResults: 50 });
  } catch (error) {
    els.contextError.textContent = error.message;
  } finally {
    contextBusy = false;
    renderContext();
  }
}

async function readSideContextFile(result) {
  const project = selectedProject();
  if (!project) return;
  contextBusy = true;
  els.contextError.textContent = "";
  renderContext();
  try {
    const data = await contextBg({
      type: "SOL_CODEX_CONTEXT_FILE",
      projectPath: project.path,
      relativePath: result.path,
      startLine: Math.max(1, Number(result.line || 1) - 12),
      endLine: Number(result.line || 1) + 28
    });
    contextText = `## ${data.relativePath} (${data.startLine}-${data.endLine})\n\n${data.content}`;
  } catch (error) {
    els.contextError.textContent = error.message;
  } finally {
    contextBusy = false;
    renderContext();
  }
}

async function insertTextSideContext(text) {
  try {
    await sendToChatGPT({ type: "SOL_CODEX_INSERT_CONTEXT", text });
    showToast(t("toast.contextInserted"));
    return true;
  } catch (error) {
    els.contextError.textContent = error.message || String(error);
    return false;
  }
}

async function sendToChatGPT(message) {
  const tab = await getActiveChatGPTTab();
  if (!tab) {
    const error = new Error(t("error.notChatGPT"));
    error.code = "NOT_CHATGPT";
    throw error;
  }
  const result = await chrome.tabs.sendMessage(tab.id, message);
  if (!result?.ok) {
    const error = new Error(result?.errorCode === "NO_COMPOSER" ? t("error.noComposer") : t("files.insertFailed"));
    error.code = result?.errorCode || "INSERT_FAILED";
    throw error;
  }
  return result;
}

async function insertSideContext() {
  await insertTextSideContext(contextText);
}

async function insertProjectFile() {
  const file = projectFilesState.selectedFile;
  const isImage = file?.kind === "image";
  const canInsert = isImage ? projectFilesState.imageData?.base64 : file?.content != null;
  if (!canInsert || projectFilesState.action === "inserting" || projectFilesState.action === "success") return;
  projectFilesState.action = "inserting";
  projectFilesState.actionError = "";
  renderProjectFilesView();
  try {
    await sendToChatGPT(isImage
      ? { type: "SOL_CODEX_ATTACH_IMAGE_TO_CHATGPT", image: { name: file.name, mime: file.mime, base64: projectFilesState.imageData.base64 } }
      : { type: "SOL_CODEX_INSERT_CONTEXT", text: "Project file:\n" + file.path + "\n\n" + file.content });
    projectFilesState.action = "success";
    showToast(isImage ? t("toast.imageAttached") : t("toast.contextInserted"));
  } catch (error) {
    projectFilesState.action = "idle";
    projectFilesState.actionError = error.code === "NO_UPLOAD_INPUT"
      ? t("files.noUploadInput")
      : error.code === "ATTACHMENT_NOT_DETECTED" || error.code === "UPLOAD_INPUT_REJECTED"
        ? t("files.attachmentNotDetected")
        : error.code === "INVALID_IMAGE"
          ? t("files.imageUnsupported")
          : error.message || t(isImage ? "files.attachFailed" : "files.insertFailed");
  }
  renderProjectFilesView();
}

async function copyProjectFile() {
  const file = projectFilesState.selectedFile;
  if (file?.content == null) return;
  try {
    await navigator.clipboard.writeText(file.content);
    projectFilesState.copied = true;
    renderProjectFilesView();
    setTimeout(() => {
      projectFilesState.copied = false;
      renderProjectFilesView();
    }, 1400);
  } catch (error) {
    projectFilesState.previewError = error.message || t("files.copyFailed");
    renderProjectFilesView();
  }
}

function refreshProjectFiles() {
  projectFilesState.directories.clear();
  projectFilesState.directoryErrors.clear();
  projectFilesState.loadingPaths.clear();
  projectFilesState.directoryRequests = new Map();
  projectFilesState.selectedFilePath = "";
  projectFilesState.selectedFile = null;
  projectFilesState.previewLoading = false;
  projectFilesState.previewError = "";
  projectFilesState.imageData = null;
  projectFilesState.imageLoading = false;
  projectFilesState.action = "idle";
  projectFilesState.actionError = "";
  projectFilesState.previewRequestId += 1;
  projectFilesState.generation += 1;
  projectFilesState.expandedPaths = new Set([""]);
  projectFilesState.view = "tree";
  projectFilesState.copied = false;
  renderProjectFilesView();
  loadProjectDirectory("");
}

function renderDirection() {
  document.querySelectorAll(".direction-option").forEach((button) => {
    const active = button.dataset.direction === bridgeDirection;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.pushView.classList.toggle("hidden", bridgeDirection !== "push");
  els.pullView.classList.toggle("hidden", bridgeDirection !== "pull");
  els.sessionCard.classList.toggle("hidden", bridgeDirection === "push" && mode === "new");
  els.sessionCardTitle.textContent = t("session.title");
  renderContext();
}

async function setDirection(next, persist = true) {
  bridgeDirection = next === "pull" ? "pull" : "push";
  if (persist) await store({ bridgeDirection });
  renderDirection();
  if (bridgeDirection === "pull") {
    await syncContextPermission();
    if (contextPermission === true && selectedProject() && selectedSession()) await pullSideContext(contextPart || "snapshot");
  }
}

function setMode(next, persist = true) {
  mode = next === "queue" ? "queue" : "new";
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  els.modeHint.textContent = t(modeHintKeys[mode]);
  renderSendState();
  renderDirection();
  if (persist) store({ mode });
}

async function addProject() {
  const projectPath = els.projectPathInput.value.trim();
  if (!projectPath) return;
  els.projectError.textContent = "";
  try {
    const result = await bg({
      type: "SOL_CODEX_BRIDGE_REQUEST",
      path: "/api/projects",
      options: { method: "POST", body: JSON.stringify({ path: projectPath }), timeoutMs: 5000 }
    });
    els.projectPathInput.value = "";
    els.addProjectBox.classList.add("hidden");
    await syncProjects({ quiet: false, preferredPath: result.data.project?.path || projectPath });
    showToast(t("toast.projectAdded"));
  } catch (error) {
    els.projectError.textContent = error.message;
  }
}

async function saveToken() {
  const value = els.tokenInput.value.trim();
  if (!value) return;
  token = value;
  els.pairError.textContent = "";
  await store({ bridgeToken: token });
  try {
    await bg({ type: "SOL_CODEX_LOAD_PROJECTS" });
    els.pairCard.classList.add("hidden");
    els.tokenInput.value = "";
    showToast(t("toast.paired"));
    await syncProjects({ quiet: false });
  } catch (error) {
    els.pairError.textContent = error.message;
  }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sourceForSend(prompt) {
  if (!currentSource) return { type: "manual", contentHash: await sha256(prompt), capturedAt: Date.now() };
  const currentHash = await sha256(prompt);
  return {
    ...currentSource,
    basedOnContentHash: currentSource.contentHash,
    contentHash: currentHash,
    manualEdited: currentHash !== currentSource.contentHash,
    sentTextLength: prompt.length
  };
}

async function send() {
  const project = selectedProject();
  const session = selectedSession();
  const prompt = els.prompt.value.trim();
  els.actionError.textContent = "";
  if (!project) return void (els.actionError.textContent = t("error.noProject"));
  if (!prompt) return void (els.actionError.textContent = t("error.emptyPrompt"));
  if (mode !== "new" && !session) return void (els.actionError.textContent = t("error.noSession"));

  setSendBusy(true);
  let taskStarted = false;
  try {
    const source = await sourceForSend(prompt);
    const result = await bg({
      type: "SOL_CODEX_BRIDGE_REQUEST",
      path: "/api/actions/send",
      options: {
        method: "POST",
        timeoutMs: mode === "queue" ? 35_000 : 10_000,
        body: JSON.stringify({
          mode,
          projectPath: project.path,
          sessionId: session?.id || null,
          prompt,
          source,
          openApp: els.openApp.checked
        })
      }
    });
    taskStarted = mode === "new" && Boolean(result.data?.sessionId);
    if (taskStarted) {
      setSendState("running");
      watchNewTask(result.data.sessionId);
    }
    if (source.conversationId) {
      const marked = await bg({ type: "SOL_CODEX_MARK_SENT", source });
      lastSent = marked.lastSent || source;
      renderSourceState();
    }
    showToast(result.data.warning || result.data.message || t("toast.sent"));
    if (result.data.warning) els.actionError.textContent = result.data.warning;
    setTimeout(() => syncSessions(project.path, { quiet: true }), 900);
  } catch (error) {
    if (error.status === 401) els.pairCard.classList.remove("hidden");
    els.actionError.textContent = error.message;
  } finally {
    if (!taskStarted) setSendBusy(false);
  }
}

async function refreshAll() {
  els.actionError.textContent = "";
  els.refreshAll.disabled = true;
  try {
    await checkBridge({ quiet: true });
    if (token) {
      await bg({
        type: "SOL_CODEX_BRIDGE_REQUEST",
        path: "/api/actions/refresh",
        options: { method: "POST", body: JSON.stringify({ refreshCodex: false }), timeoutMs: 8000 }
      });
      await syncProjects({ quiet: false });
    }
    await restoreSourceState();
    showToast(t("toast.synced"));
  } catch (error) {
    els.actionError.textContent = error.message;
  } finally {
    els.refreshAll.disabled = false;
  }
}

function startSessionPolling() {
  clearInterval(sessionPoll);
  sessionPoll = setInterval(() => {
    const project = selectedProject();
    if (document.visibilityState === "visible" && token && project) syncSessions(project.path, { quiet: true });
  }, 2200);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "SOL_CODEX_SOURCE_CHANGED") return;
  if (activeTabId != null && message.source?.tabId !== activeTabId) return;
  const previousText = currentSource?.text || lastAutoPrompt;
  const shouldReplace = !els.prompt.value.trim() || els.prompt.value === previousText || els.prompt.value === lastAutoPrompt;
  currentSource = message.source;
  if (shouldReplace) {
    els.prompt.value = currentSource.text || "";
    lastAutoPrompt = currentSource.text || "";
  }
  restoreSourceState();
});

els.captureContext.addEventListener("click", () => captureContext(true));
els.refreshAll.addEventListener("click", refreshAll);
els.projectSelect.addEventListener("change", () => onProjectChanged(true));
els.sessionSelect.addEventListener("change", async () => {
  await onSessionChanged(true);
  if (bridgeDirection === "pull") pullSideContext(contextPart);
  else renderContext();
});
els.toggleAddProject.addEventListener("click", () => els.addProjectBox.classList.toggle("hidden"));
els.addProject.addEventListener("click", addProject);
els.saveToken.addEventListener("click", saveToken);
els.send.addEventListener("click", send);
els.openApp.addEventListener("change", () => store({ openApp: els.openApp.checked }));
els.prompt.addEventListener("input", () => {
  if (currentSource && els.prompt.value !== currentSource.text) els.sourceLive.textContent = t("plan.edited");
  else renderSourceState();
});
document.querySelectorAll(".context-tab").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.contextPart === "files") enterProjectFiles();
  else pullSideContext(button.dataset.contextPart);
}));
els.allowContext.addEventListener("click", allowSideContext);
els.disableContext.addEventListener("click", disableSideContext);
els.contextSearch.addEventListener("click", searchSideContext);
els.contextSearchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchSideContext(); });
els.insertContext.addEventListener("click", insertSideContext);
els.projectFilesRefresh.addEventListener("click", refreshProjectFiles);
els.projectFilesBack.addEventListener("click", () => {
  projectFilesState.view = "tree";
  renderProjectFilesView();
});
els.projectFileCopy.addEventListener("click", copyProjectFile);
els.projectFileInsert.addEventListener("click", insertProjectFile);
document.querySelectorAll(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode, true)));
document.querySelectorAll(".direction-option").forEach((button) => button.addEventListener("click", () => setDirection(button.dataset.direction, true)));
els.contextManage.addEventListener("click", () => {
  contextPermissionMenuOpen = !contextPermissionMenuOpen;
  renderContext();
});
document.querySelectorAll(".language-switch button").forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.locale));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.uiLanguage) applyLanguage(changes.uiLanguage.newValue);
  if (changes.selectedProject) {
    contextPermission = null;
    resetProjectFilesState();
    if (contextPart === "files") enterProjectFiles();
  }
});

(async function init() {
  // Phase 1: restore durable UI state immediately. No Bridge request is needed.
  const saved = await chrome.storage.local.get([
    "bridgeToken", "bridgeHealth", "projectCache", "sessionCacheByProject",
    "selectedProject", "selectedSessionByProject", "mode", "openApp", "bridgeDirection", "uiLanguage"
  ]);
  const locale = i18n.normalizeLocale(saved.uiLanguage);
  if (saved.uiLanguage !== locale) await store({ uiLanguage: locale });
  token = saved.bridgeToken || "";
  sessionCacheByProject = saved.sessionCacheByProject || {};
  selectedSessionByProject = saved.selectedSessionByProject || {};
  projects = saved.projectCache?.projects || [];
  bridgeDirection = saved.bridgeDirection === "pull" ? "pull" : "push";
  if (saved.bridgeDirection !== "push" && saved.bridgeDirection !== "pull") store({ bridgeDirection: "push" });
  els.openApp.checked = saved.openApp !== false;
  setMode(saved.mode === "queue" ? "queue" : "new", false);
  if (saved.mode !== "new" && saved.mode !== "queue") store({ mode: "new" });
  renderCachedBridge(saved);
  renderProjects(saved.selectedProject);
  renderDirection();
  renderContext();
  applyLanguage(locale);
  if (!token) els.pairCard.classList.remove("hidden");
  await restoreSourceState();
  await syncContextPermission();
  if (bridgeDirection === "pull" && contextPermission === true && selectedSession()) await pullSideContext("snapshot");

  // Phase 2: silent freshness check. Cached lists remain visible while this runs.
  checkBridge({ quiet: true }).then(() => token && syncProjects({ quiet: true }));
  startSessionPolling();
})();
