const $ = (id) => document.getElementById(id);
const els = {
  bridgeDot: $("bridgeDot"), bridgeText: $("bridgeText"), pairCard: $("pairCard"),
  tokenInput: $("tokenInput"), saveToken: $("saveToken"), pairError: $("pairError"),
  prompt: $("prompt"), contextMeta: $("contextMeta"), captureContext: $("captureContext"),
  sourceState: $("sourceState"), sourceVersion: $("sourceVersion"), sourceLive: $("sourceLive"), sourceSent: $("sourceSent"),
  refreshAll: $("refreshAll"), projectSelect: $("projectSelect"), projectPath: $("projectPath"),
  toggleAddProject: $("toggleAddProject"), addProjectBox: $("addProjectBox"),
  projectPathInput: $("projectPathInput"), addProject: $("addProject"), projectError: $("projectError"),
  sessionBlock: $("sessionBlock"), sessionSelect: $("sessionSelect"), sessionMeta: $("sessionMeta"), sessionSync: $("sessionSync"),
  modeHint: $("modeHint"), openApp: $("openApp"), send: $("send"), sendLabel: $("sendLabel"), sendLoader: $("sendLoader"), sendElapsed: $("sendElapsed"),
  actionError: $("actionError"), toast: $("toast")
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

const modeHints = {
  new: "在所选本地项目中自动启动一条新的 Codex 任务。",
  queue: "直接把当前最新方案加入已存在的 Codex 会话；列表来自 Bridge 内存索引，不重新扫描数据库。"
};

function defaultSendLabel() {
  return currentSource && lastSent?.revision !== currentSource.revision
    ? `发送 V${currentSource.revision} 到 Codex`
    : "发送到 Codex";
}

function setSendBusy(busy, label = defaultSendLabel()) {
  els.send.disabled = busy;
  els.send.classList.toggle("loading", busy);
  els.sendLabel.textContent = label;
  els.sendLoader.classList.toggle("hidden", !busy);
  els.sendElapsed.classList.toggle("hidden", !busy);
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
        showToast(result.data.success ? "新任务已完成，Codex 会话已打开" : "新任务执行失败，请查看 Codex 日志");
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

async function store(values) {
  await chrome.storage.local.set(values);
}

async function bg(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) {
    const error = new Error(result?.error || "扩展后台无响应");
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
  if (status === "locked") return "使用中";
  if (status === "active") return "活跃";
  return "空闲";
}

function formatTime(value) {
  if (!value) return "";
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return ""; }
}

function renderCachedBridge(saved) {
  const health = saved.bridgeHealth;
  if (health?.ok) {
    els.bridgeDot.className = "dot online";
    els.bridgeText.textContent = "Bridge 缓存已恢复 · 正在确认";
  } else {
    els.bridgeDot.className = "dot";
    els.bridgeText.textContent = "已恢复插件缓存 · 正在连接 Bridge";
  }
}

function renderSourceState() {
  els.sourceState.className = "source-state neutral";
  els.sourceLive.textContent = "";
  if (!currentSource) {
    els.sourceVersion.textContent = "等待 ChatGPT 方案";
    els.sourceSent.textContent = "插件会自动跟踪当前 ChatGPT 最新回复";
    return;
  }

  const revision = Number(currentSource.revision || 1);
  els.sourceVersion.textContent = `V${revision} · ${currentSource.pending ? "生成中" : "最新"}`;
  els.sourceLive.textContent = currentSource.pending ? "同步中" : formatTime(currentSource.updatedAt || currentSource.capturedAt);

  const sentSame = Boolean(
    lastSent &&
    lastSent.conversationId === currentSource.conversationId &&
    Number(lastSent.revision) === revision &&
    lastSent.contentHash === currentSource.contentHash
  );

  if (sentSame) {
    els.sourceState.className = "source-state synced";
    els.sourceSent.textContent = `V${revision} 已发送到 Codex · 当前版本已同步`;
  } else if (lastSent?.conversationId === currentSource.conversationId) {
    els.sourceState.className = "source-state pending";
    els.sourceSent.textContent = `V${lastSent.revision || "?"} 已发送 · V${revision} 有新版未发送`;
  } else {
    els.sourceState.className = "source-state pending";
    els.sourceSent.textContent = `V${revision} 尚未发送到 Codex`;
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
  els.contextMeta.textContent = `${source.title || "ChatGPT"} · ${source.text.length.toLocaleString()} 字符 · 自动跟踪`;
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
    els.contextMeta.textContent = "当前标签页不是 ChatGPT";
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

function renderProjects(preferredPath) {
  els.projectSelect.innerHTML = "";
  if (!projects.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未发现本地项目";
    els.projectSelect.appendChild(option);
    els.projectPath.textContent = "请点击“+ 添加”输入项目绝对路径";
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
    group.label = "项目";
    appendOptions(group, codexProjects);
    els.projectSelect.appendChild(group);
  }
  if (manualProjects.length) {
    const group = document.createElement("optgroup");
    group.label = "手动添加";
    appendOptions(group, manualProjects);
    els.projectSelect.appendChild(group);
  }
  if (fallbackProjects.length) {
    const group = document.createElement("optgroup");
    group.label = "项目";
    appendOptions(group, fallbackProjects);
    els.projectSelect.appendChild(group);
  }
  const exists = projects.some((item) => item.path === preferredPath);
  els.projectSelect.value = exists ? preferredPath : projects[0].path;
  const project = selectedProject();
  els.projectPath.textContent = project?.path || "";
  useCachedSessions(project?.path || "");
}

function renderSessions() {
  const project = selectedProject();
  const preferred = project ? selectedSessionByProject[project.path] : null;
  const currentValue = els.sessionSelect.value;
  els.sessionSelect.innerHTML = "";
  if (!sessions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "该项目暂无可识别会话";
    els.sessionSelect.appendChild(option);
    els.sessionMeta.textContent = "仍可使用“项目新任务”。";
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
  const wanted = [currentValue, preferred].find((id) => sessions.some((item) => item.id === id));
  els.sessionSelect.value = wanted || sessions[0].id;
  // Persist the effective target even when the user accepts the default item.
  // The ChatGPT inline `Codex →` button reads this durable selection while the side panel is closed.
  onSessionChanged(true);
}

function useCachedSessions(projectPath) {
  const cached = sessionCacheByProject?.[projectPath];
  sessions = cached?.sessions || [];
  renderSessions();
  if (cached?.updatedAt) els.sessionSync.textContent = `缓存 ${formatTime(cached.updatedAt)}`;
  else els.sessionSync.textContent = "";
}

async function checkBridge({ quiet = false } = {}) {
  try {
    const result = await bg({ type: "SOL_CODEX_HEALTH" });
    const health = result.data;
    els.bridgeDot.className = "dot online";
    const desktopLabel = health.desktop?.found ? " · Codex App 可用" : "";
    const queueLabel = health.codex?.capabilities?.queueCli ? " · Queue 可用" : "";
    const indexLabel = health.index?.sessions != null ? ` · ${health.index.sessions} 会话` : "";
    els.bridgeText.textContent = `Bridge 已连接${desktopLabel}${queueLabel}${indexLabel}`;
    if (health.authRequired && !token) els.pairCard.classList.remove("hidden");
    if (!quiet) els.actionError.textContent = "";
    return health;
  } catch (error) {
    els.bridgeDot.className = "dot error";
    els.bridgeText.textContent = projects.length ? "Bridge 重连中 · 已显示本地缓存" : "本地 Bridge 未连接";
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
    sessionCacheByProject = { ...sessionCacheByProject, [projectPath]: data };
    if (selectedProject()?.path === projectPath) {
      const selectedBefore = els.sessionSelect.value;
      sessions = data.sessions || [];
      renderSessions();
      if (selectedBefore && sessions.some((item) => item.id === selectedBefore)) {
        els.sessionSelect.value = selectedBefore;
        onSessionChanged(false);
      }
      els.sessionSync.textContent = `已同步 ${formatTime(Date.now())}`;
    }
  } catch (error) {
    if (!quiet) els.sessionMeta.textContent = error.message;
  }
}

async function captureContext(showReading = true) {
  if (showReading) els.contextMeta.textContent = "正在读取当前 ChatGPT 页面…";
  try {
    const tab = await getActiveChatGPTTab();
    if (!tab) throw new Error("当前标签页不是 ChatGPT");
    activeTabId = tab.id;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "SOL_CODEX_GET_CONTEXT" });
    if (!response?.text) throw new Error(response?.error || "没有读取到最新回复，请直接粘贴方案");
    if (response.source === "selection") {
      els.prompt.value = response.text;
      lastAutoPrompt = "";
      els.contextMeta.textContent = `已读取选中文本 · ${response.text.length.toLocaleString()} 字符`;
      els.sourceLive.textContent = "选中文本";
    } else {
      els.prompt.value = response.text;
      lastAutoPrompt = response.text;
      els.contextMeta.textContent = `已读取最新 Assistant 回复 · ${response.text.length.toLocaleString()} 字符`;
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
  await store({ selectedProject: project.path });
  useCachedSessions(project.path);
  if (refresh) await syncSessions(project.path, { quiet: true });
}

async function onSessionChanged(save = true) {
  const session = selectedSession();
  if (!session) return;
  const bits = [statusLabel(session.status)];
  if (session.modelProvider) bits.push(session.modelProvider);
  if (session.gitBranch) bits.push(session.gitBranch);
  if (session.updatedAt) bits.push(new Date(session.updatedAt).toLocaleString());
  els.sessionMeta.textContent = bits.join(" · ");
  if (save) {
    const project = selectedProject();
    if (project) {
      selectedSessionByProject = { ...selectedSessionByProject, [project.path]: session.id };
      await store({ selectedSessionByProject });
    }
  }
}

function setMode(next, persist = true) {
  mode = next === "queue" ? "queue" : "new";
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  els.modeHint.textContent = modeHints[mode];
  els.sessionBlock.classList.toggle("hidden", mode === "new");
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
    showToast("项目已添加");
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
    showToast("Bridge 配对成功");
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
  if (!project) return void (els.actionError.textContent = "请选择本地项目");
  if (!prompt) return void (els.actionError.textContent = "方案内容为空");
  if (mode !== "new" && !session) return void (els.actionError.textContent = "请选择已有会话");

  setSendBusy(true, "正在发送…");
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
      els.sendLabel.textContent = "任务执行中…";
      watchNewTask(result.data.sessionId);
    }
    if (source.conversationId) {
      const marked = await bg({ type: "SOL_CODEX_MARK_SENT", source });
      lastSent = marked.lastSent || source;
      renderSourceState();
    }
    showToast(result.data.warning || result.data.message || "已发送到 Codex");
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
    showToast("已同步最新状态");
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
els.sessionSelect.addEventListener("change", () => onSessionChanged(true));
els.toggleAddProject.addEventListener("click", () => els.addProjectBox.classList.toggle("hidden"));
els.addProject.addEventListener("click", addProject);
els.saveToken.addEventListener("click", saveToken);
els.send.addEventListener("click", send);
els.openApp.addEventListener("change", () => store({ openApp: els.openApp.checked }));
els.prompt.addEventListener("input", () => {
  if (currentSource && els.prompt.value !== currentSource.text) els.sourceLive.textContent = "已手动修改";
  else renderSourceState();
});
document.querySelectorAll(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode, true)));

(async function init() {
  // Phase 1: restore durable UI state immediately. No Bridge request is needed.
  const saved = await chrome.storage.local.get([
    "bridgeToken", "bridgeHealth", "projectCache", "sessionCacheByProject",
    "selectedProject", "selectedSessionByProject", "mode", "openApp"
  ]);
  token = saved.bridgeToken || "";
  sessionCacheByProject = saved.sessionCacheByProject || {};
  selectedSessionByProject = saved.selectedSessionByProject || {};
  projects = saved.projectCache?.projects || [];
  els.openApp.checked = saved.openApp !== false;
  setMode(saved.mode === "queue" ? "queue" : "new", false);
  if (saved.mode !== "new" && saved.mode !== "queue") store({ mode: "new" });
  renderCachedBridge(saved);
  renderProjects(saved.selectedProject);
  if (!token) els.pairCard.classList.remove("hidden");
  await restoreSourceState();

  // Phase 2: silent freshness check. Cached lists remain visible while this runs.
  checkBridge({ quiet: true }).then(() => token && syncProjects({ quiet: true }));
  startSessionPolling();
})();
