const BRIDGE_URL = "http://127.0.0.1:4329";
const CONTEXT_RESOURCES = new Set(["project", "session", "snapshot", "git-diff", "files", "file"]);
const watchers = new Set();
let fallbackTarget = { mode: "queue", projectPath: "", sessionId: "" };
let fallbackReadTarget = { mode: "queue", projectPath: "", sessionId: "" };
let fallbackBridgeToken = "";

function trustedSender(sender) {
  if (!sender?.tab) return true;
  try {
    const url = new URL(sender.tab.url || "");
    return ["chatgpt.com", "chat.openai.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

async function getBridgeToken() {
  if (globalThis.chrome?.storage?.local?.get) {
    try {
      const saved = await chrome.storage.local.get(["bridgeToken"]);
      return String(saved.bridgeToken || "");
    } catch {}
  }
  return fallbackBridgeToken;
}

async function saveBridgeToken(value) {
  fallbackBridgeToken = value;
  if (globalThis.chrome?.storage?.local?.set) {
    try { await chrome.storage.local.set({ bridgeToken: value }); } catch {}
  }
}

async function getSavedTarget() {
  if (globalThis.chrome?.storage?.local?.get) {
    try {
      const saved = await chrome.storage.local.get(["codexTarget"]);
      return saved.codexTarget || fallbackTarget;
    } catch {}
  }
  return fallbackTarget;
}

async function saveTarget(target) {
  fallbackTarget = target;
  if (globalThis.chrome?.storage?.local?.set) {
    try { await chrome.storage.local.set({ codexTarget: target }); } catch {}
  }
}

async function getSavedReadTarget() {
  if (globalThis.chrome?.storage?.local?.get) {
    try {
      const saved = await chrome.storage.local.get(["codexReadTarget"]);
      return saved.codexReadTarget || fallbackReadTarget;
    } catch {}
  }
  return fallbackReadTarget;
}

async function saveReadTarget(target) {
  fallbackReadTarget = target;
  if (globalThis.chrome?.storage?.local?.set) {
    try { await chrome.storage.local.set({ codexReadTarget: target }); } catch {}
  }
}

function resolveTarget(projects, savedTarget, allowProjectOnly = false) {
  const target = savedTarget || { mode: "queue", projectPath: "", sessionId: "" };
  const project = projects.find((item) => item.path === target.projectPath);
  if (target.mode === "new") {
    return project
      ? { target: { mode: "new", projectPath: project.path, projectName: project.name, sessionId: null }, reason: "" }
      : { target: null, reason: "请选择一个 Codex 项目" };
  }
  if (target.mode === "queue") {
    const session = project?.sessions?.find((item) => item.id === target.sessionId);
    if (project && (session || allowProjectOnly)) {
      return {
        target: {
          mode: "queue",
          projectPath: project.path,
          projectName: project.name,
          sessionId: session?.id || "",
          sessionTitle: session?.title || "",
        },
        reason: "",
      };
    }
    return { target: null, reason: "请选择一个已有 Codex 会话" };
  }
  return { target: null, reason: "请从目标卡片选择已有会话或项目新任务" };
}

async function targetState() {
  const [discovered, saved] = await Promise.all([
    bridgeJson("/targets"),
    getSavedTarget().then((codexTarget) => ({ codexTarget })),
  ]);
  const projects = discovered.projects || [];
  const savedTarget = saved.codexTarget || { mode: "queue", projectPath: "", sessionId: "" };
  const resolved = resolveTarget(projects, savedTarget);
  return { projects, savedTarget, target: resolved.target, ready: Boolean(resolved.target), reason: resolved.reason };
}

async function readTargetState() {
  const [discovered, savedTarget] = await Promise.all([bridgeJson("/targets"), getSavedReadTarget()]);
  const projects = discovered.projects || [];
  const resolved = resolveTarget(projects, savedTarget, true);
  return {
    projects,
    savedTarget,
    target: resolved.target,
    ready: Boolean(resolved.target),
    reason: resolved.reason,
  };
}

async function bridgeJson(path, options = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), Number(options.timeoutMs || 10_000)) : null;
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  const token = await getBridgeToken();
  if (token) headers["x-bridge-token"] = token;
  try {
    const response = await fetch(`${BRIDGE_URL}${path}`, { ...options, headers, ...(controller ? { signal: controller.signal } : {}) });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error(body?.error || `Bridge returned ${response.status}`);
      error.status = response.status;
      error.code = body?.code || null;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Bridge 请求超时");
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function contextTarget(resource) {
  const readState = await readTargetState();
  const state = readState.ready ? readState : await targetState();
  if (!state.ready || !state.target) throw new Error(state.reason || "请选择 Codex 项目或会话");
  if (["session", "snapshot"].includes(resource) && !state.target.sessionId) {
    throw new Error("当前目标没有已选择的 Codex Session");
  }
  return state.target;
}

async function readContext(resource, body = {}) {
  if (!CONTEXT_RESOURCES.has(resource)) throw new Error("未知的 Codex Context 类型");
  const target = await contextTarget(resource);
  return bridgeJson(`/api/context/${resource}`, {
    method: "POST",
    body: JSON.stringify({
      ...body,
      projectPath: target.projectPath,
      sessionId: target.sessionId || "",
    }),
  });
}

function notifyTab(tabId, payload) {
  if (typeof tabId !== "number") return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watchTask(taskId, tabId) {
  if (watchers.has(taskId)) return;
  watchers.add(taskId);
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await sleep(750);
      const task = await bridgeJson(`/tasks/${encodeURIComponent(taskId)}`);
      if (task.status === "accepted") notifyTab(tabId, { type: "CODEX_TASK_STATUS", taskId, status: "accepted" });
      if (task.status === "running") notifyTab(tabId, { type: "CODEX_TASK_STATUS", taskId, status: "running" });
      if (task.status === "executed" || task.status === "error") {
        notifyTab(tabId, { type: "CODEX_TASK_STATUS", taskId, status: task.status, error: task.error });
        break;
      }
    }
  } catch (error) {
    notifyTab(tabId, { type: "CODEX_TASK_STATUS", taskId, status: "error", error: error.message });
  } finally {
    watchers.delete(taskId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!trustedSender(sender)) return undefined;
  if (!message?.type) return undefined;

  if (message.type === "SET_BRIDGE_TOKEN") {
    const token = String(message.token || "").trim();
    if (!token) {
      sendResponse({ accepted: false, error: "Pairing Token 不能为空", code: "PAIRING_TOKEN_REQUIRED" });
      return false;
    }
    saveBridgeToken(token)
      .then(() => bridgeJson("/targets", { timeoutMs: 5_000 }))
      .then(() => sendResponse({ accepted: true }))
      .catch(async (error) => {
        await saveBridgeToken("");
        sendResponse({ accepted: false, error: error.message, code: error.code || "PAIRING_TOKEN_INVALID" });
      });
    return true;
  }

  if (message.type === "GET_CODEX_TARGET_STATE") {
    targetState().then((result) => sendResponse({ accepted: true, ...result }))
      .catch((error) => sendResponse({ accepted: false, error: error.message }));
    return true;
  }

  if (message.type === "SET_CODEX_TARGET") {
    saveTarget(message.target || { mode: "queue", projectPath: "", sessionId: "" })
      .then(() => targetState())
      .then((result) => sendResponse({ accepted: true, ...result }))
      .catch((error) => sendResponse({ accepted: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_CODEX_READ_TARGET_STATE") {
    readTargetState().then((result) => sendResponse({ accepted: true, ...result }))
      .catch((error) => sendResponse({ accepted: false, error: error.message }));
    return true;
  }

  if (message.type === "SET_CODEX_READ_TARGET") {
    saveReadTarget(message.target || { mode: "queue", projectPath: "", sessionId: "" })
      .then(() => readTargetState())
      .then((result) => sendResponse({ accepted: true, ...result }))
      .catch((error) => sendResponse({ accepted: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_CODEX_READ_PERMISSION") {
    (async () => {
      try {
        const projectPath = String(message.projectPath || "").trim();
        if (!projectPath) throw new Error("请选择一个 Codex 项目");
        const permission = await bridgeJson(`/api/context/permission?projectPath=${encodeURIComponent(projectPath)}`);
        sendResponse({ accepted: true, permission });
      } catch (error) {
        sendResponse({ accepted: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "SET_CODEX_READ_PERMISSION") {
    (async () => {
      try {
        const projectPath = String(message.projectPath || "").trim();
        if (!projectPath) throw new Error("请选择一个 Codex 项目");
        const permission = await bridgeJson("/api/context/permission", {
          method: "POST",
          body: JSON.stringify({ projectPath, allowed: Boolean(message.allowed) }),
        });
        sendResponse({ accepted: true, permission });
      } catch (error) {
        sendResponse({ accepted: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "GET_CODEX_CONTEXT_PERMISSION") {
    (async () => {
      try {
        const target = await contextTarget("project");
        const permission = await bridgeJson(`/api/context/permission?projectPath=${encodeURIComponent(target.projectPath)}`);
        sendResponse({ accepted: true, target, permission });
      } catch (error) {
        sendResponse({ accepted: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "SET_CODEX_CONTEXT_PERMISSION") {
    (async () => {
      try {
        const target = await contextTarget("project");
        const permission = await bridgeJson("/api/context/permission", {
          method: "POST",
          body: JSON.stringify({ projectPath: target.projectPath, allowed: Boolean(message.allowed) }),
        });
        sendResponse({ accepted: true, target, permission });
      } catch (error) {
        sendResponse({ accepted: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "READ_CODEX_CONTEXT") {
    (async () => {
      try {
        const resource = String(message.resource || "snapshot");
        const value = await readContext(resource, message.body || {});
        sendResponse({ accepted: true, resource, value });
      } catch (error) {
        sendResponse({ accepted: false, error: error.message, code: error.code || null });
      }
    })();
    return true;
  }

  if (message.type !== "RUN_IN_CODEX") return undefined;

  (async () => {
    try {
      const payload = message.payload || {};
      const result = await bridgeJson("/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      void watchTask(result.taskId || payload.taskId, sender.tab?.id);
      sendResponse(result);
    } catch (error) {
      sendResponse({ accepted: false, error: error.message });
    }
  })();

  return true;
});
