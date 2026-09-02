const BRIDGE = "http://127.0.0.1:37821";
const REQUEST_TIMEOUT_MS = 1800;

async function setPanelBehavior() {
  if (chrome.sidePanel?.setPanelBehavior) {
    try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch {}
  }
}

chrome.runtime.onInstalled.addListener(setPanelBehavior);
chrome.runtime.onStartup.addListener(setPanelBehavior);
setPanelBehavior();

async function bridgeFetch(path, options = {}, needsAuth = true) {
  const saved = await chrome.storage.local.get(["bridgeToken"]);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (needsAuth && saved.bridgeToken) headers["X-Bridge-Token"] = saved.bridgeToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || REQUEST_TIMEOUT_MS));
  try {
    const response = await fetch(`${BRIDGE}${path}`, {
      ...options,
      headers,
      signal: controller.signal
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(data.error || `Bridge ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Bridge 响应超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getCachedState() {
  return chrome.storage.local.get([
    "bridgeToken",
    "bridgeHealth",
    "bridgeLastSeen",
    "bridgeLastError",
    "projectCache",
    "sessionCacheByProject",
    "selectedProject",
    "selectedSessionByProject",
    "mode",
    "openApp",
    "chatgptSourceByTab",
    "chatgptRevisionStateByConversation",
    "lastSentByConversation"
  ]);
}

async function health() {
  try {
    const data = await bridgeFetch("/api/health", {}, false);
    await chrome.storage.local.set({
      bridgeHealth: data,
      bridgeLastSeen: Date.now(),
      bridgeLastError: ""
    });
    return data;
  } catch (error) {
    await chrome.storage.local.set({ bridgeLastError: error.message || String(error) });
    throw error;
  }
}

async function loadProjects() {
  const data = await bridgeFetch("/api/projects");
  await chrome.storage.local.set({
    projectCache: data,
    bridgeLastSeen: Date.now(),
    bridgeLastError: ""
  });
  return data;
}

async function loadSessions(projectPath) {
  const data = await bridgeFetch(`/api/sessions?project=${encodeURIComponent(projectPath)}`);
  const saved = await chrome.storage.local.get(["sessionCacheByProject"]);
  const next = { ...(saved.sessionCacheByProject || {}), [projectPath]: data };
  await chrome.storage.local.set({
    sessionCacheByProject: next,
    bridgeLastSeen: Date.now(),
    bridgeLastError: ""
  });
  return data;
}

function sameIdentity(a, b) {
  return Boolean(a && b && a.conversationId === b.conversationId && a.messageKey === b.messageKey);
}

async function handleSourceUpdate(raw, sender) {
  if (!raw?.conversationId || !raw?.text) return null;
  const tabId = sender?.tab?.id;
  if (tabId == null) return null;

  const saved = await chrome.storage.local.get([
    "chatgptSourceByTab",
    "chatgptRevisionStateByConversation"
  ]);
  const byTab = { ...(saved.chatgptSourceByTab || {}) };
  const revisions = { ...(saved.chatgptRevisionStateByConversation || {}) };
  const previous = revisions[raw.conversationId] || null;

  let revision = Number(previous?.revision || 0);
  let pending = Boolean(raw.isStreaming);
  const identityChanged = !sameIdentity(previous, raw);
  const contentChanged = previous?.contentHash !== raw.contentHash;

  if (!previous) {
    revision = 1;
  } else if (raw.isStreaming) {
    if (identityChanged || (!previous.pending && contentChanged)) revision += 1;
  } else if (identityChanged) {
    revision += 1;
  } else if (previous.pending) {
    // Finalization of the currently streaming revision: keep the same V number.
    revision = Math.max(1, revision);
  } else if (contentChanged) {
    // Same visible turn changed after it was committed: regenerated/branch-switched answer.
    revision += 1;
  }

  const source = {
    ...raw,
    revision: Math.max(1, revision),
    pending,
    tabId,
    updatedAt: Date.now()
  };

  revisions[raw.conversationId] = source;
  byTab[String(tabId)] = source;

  // Keep bounded state so long-running ChatGPT usage cannot grow storage forever.
  const revisionEntries = Object.entries(revisions)
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
    .slice(0, 30);
  const tabEntries = Object.entries(byTab)
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
    .slice(0, 20);

  await chrome.storage.local.set({
    chatgptRevisionStateByConversation: Object.fromEntries(revisionEntries),
    chatgptSourceByTab: Object.fromEntries(tabEntries)
  });

  try { await chrome.runtime.sendMessage({ type: "SOL_CODEX_SOURCE_CHANGED", source }); } catch {}
  return source;
}

async function sourceStateForTab(tabId) {
  const saved = await chrome.storage.local.get(["chatgptSourceByTab", "lastSentByConversation"]);
  const source = saved.chatgptSourceByTab?.[String(tabId)] || null;
  const lastSent = source?.conversationId ? saved.lastSentByConversation?.[source.conversationId] || null : null;
  return { source, lastSent };
}

async function markSent(source) {
  if (!source?.conversationId) return null;
  const saved = await chrome.storage.local.get(["lastSentByConversation"]);
  const map = { ...(saved.lastSentByConversation || {}) };
  map[source.conversationId] = { ...source, sentAt: Date.now() };
  await chrome.storage.local.set({ lastSentByConversation: map });
  return map[source.conversationId];
}

async function getQuickTarget() {
  const saved = await chrome.storage.local.get([
    "bridgeToken", "selectedProject", "selectedSessionByProject", "mode", "openApp",
    "projectCache", "sessionCacheByProject"
  ]);
  const projectPath = String(saved.selectedProject || "");
  const mode = saved.mode === "queue" ? "queue" : "new";
  const sessionId = mode === "new" ? "" : String(saved.selectedSessionByProject?.[projectPath] || "");
  const project = saved.projectCache?.projects?.find?.((item) => item.path === projectPath) || null;
  const session = saved.sessionCacheByProject?.[projectPath]?.sessions?.find?.((item) => item.id === sessionId) || null;
  const ready = Boolean(saved.bridgeToken && projectPath && (mode === "new" || sessionId));
  return {
    ready,
    mode,
    projectPath,
    projectName: project?.name || (projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : ""),
    sessionId: sessionId || null,
    sessionTitle: session?.title || null,
    openApp: saved.openApp !== false,
    reason: ready ? "" : !saved.bridgeToken ? "Bridge 尚未配对" : !projectPath ? "尚未选择项目" : "尚未选择目标会话"
  };
}

async function quickSend(raw, sender) {
  const source = await handleSourceUpdate(raw, sender);
  if (!source?.text) throw new Error("没有读取到 ChatGPT 最新方案");
  if (source.pending || source.isStreaming) throw new Error("当前回复仍在生成，请生成完成后再发送");

  const target = await getQuickTarget();
  if (!target.ready) throw new Error(target.reason || "请先在 Sol → Codex 侧栏完成目标配置");

  const data = await bridgeFetch("/api/actions/send", {
    method: "POST",
    timeoutMs: target.mode === "queue" ? 35_000 : 10_000,
    body: JSON.stringify({
      mode: target.mode,
      projectPath: target.projectPath,
      sessionId: target.sessionId,
      prompt: source.text,
      source,
      openApp: target.openApp
    })
  });
  const lastSent = await markSent(source);
  try {
    await chrome.runtime.sendMessage({ type: "SOL_CODEX_SENT_CHANGED", source, lastSent, target });
  } catch {}
  return { data, source, lastSent, target };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const knownTypes = new Set([
    "SOL_CODEX_SOURCE_UPDATE", "SOL_CODEX_GET_SOURCE_STATE", "SOL_CODEX_MARK_SENT",
    "SOL_CODEX_GET_CACHED_STATE", "SOL_CODEX_HEALTH", "SOL_CODEX_LOAD_PROJECTS",
    "SOL_CODEX_LOAD_SESSIONS", "SOL_CODEX_BRIDGE_REQUEST",
    "SOL_CODEX_GET_QUICK_TARGET", "SOL_CODEX_QUICK_SEND"
  ]);
  if (!knownTypes.has(message?.type)) return false;

  const run = async () => {
    switch (message?.type) {
      case "SOL_CODEX_SOURCE_UPDATE":
        return { ok: true, source: await handleSourceUpdate(message.source, sender) };
      case "SOL_CODEX_GET_SOURCE_STATE":
        return { ok: true, ...(await sourceStateForTab(message.tabId)) };
      case "SOL_CODEX_MARK_SENT":
        return { ok: true, lastSent: await markSent(message.source) };
      case "SOL_CODEX_GET_CACHED_STATE":
        return { ok: true, state: await getCachedState() };
      case "SOL_CODEX_HEALTH":
        return { ok: true, data: await health() };
      case "SOL_CODEX_LOAD_PROJECTS":
        return { ok: true, data: await loadProjects() };
      case "SOL_CODEX_LOAD_SESSIONS":
        return { ok: true, data: await loadSessions(String(message.projectPath || "")) };
      case "SOL_CODEX_GET_QUICK_TARGET":
        return { ok: true, target: await getQuickTarget() };
      case "SOL_CODEX_QUICK_SEND":
        return { ok: true, ...(await quickSend(message.source, sender)) };
      case "SOL_CODEX_BRIDGE_REQUEST":
        return {
          ok: true,
          data: await bridgeFetch(message.path, message.options || {}, message.needsAuth !== false)
        };
      default:
        return null;
    }
  };

  run().then((result) => {
    if (result != null) sendResponse(result);
  }).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error), status: error.status || null });
  });
  return true;
});
