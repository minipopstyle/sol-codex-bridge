import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getOrCreateToken } from "./lib/config.mjs";
import {
  discoverProjects,
  discoverSessions,
  addUserProject,
  codexHome,
  initializeStateIndex,
  startStateIndexWatcher,
  forceRefreshStateIndex,
  getStateIndexInfo
} from "./lib/codex-state.mjs";
import {
  getCodexInfo,
  refreshCodexInfo,
  openProjectInCodex,
  openSessionInCodex,
  queueToSession,
  launchNewTask,
  launchForkTask
} from "./lib/codex-cli.mjs";
import { findCodexDesktopApp } from "./lib/codex-desktop.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOL_CODEX_BRIDGE_PORT || 37821);
const TOKEN = getOrCreateToken();
const startedAt = Date.now();
const newTaskStates = new Map();

// Heavy discovery happens once at process start, never inside /health or /sessions.
const stateInit = initializeStateIndex();
startStateIndexWatcher();
let codexSnapshot = getCodexInfo({ fresh: true });
const desktopApp = findCodexDesktopApp();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function authorized(req) {
  const value = String(req.headers["x-bridge-token"] || "");
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 512_000) throw new Error("请求内容过大");
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("请求 JSON 无效"); }
}

function ensurePrompt(prompt) {
  const value = String(prompt || "").trim();
  if (!value) throw new Error("方案内容为空");
  if (value.length > 200_000) throw new Error("方案内容过长，当前限制 200000 字符");
  return value;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    // O(1): no Codex CLI spawn, no SQLite query, no session scan.
    const state = getStateIndexInfo();
    return json(res, 200, {
      ok: true,
      authRequired: true,
      bridgeVersion: "0.2.10",
      uptimeMs: Date.now() - startedAt,
      codex: codexSnapshot,
      desktop: { found: Boolean(desktopApp) },
      stateDb: state.stateDb,
      codexHome: codexHome(),
      index: {
        ready: true,
        version: state.indexVersion,
        updatedAt: state.updatedAt,
        lastBuildMs: state.lastBuildMs,
        projects: state.projectCount,
        sessions: state.sessionCount,
        source: state.source,
        cacheLoaded: state.cacheLoaded
      }
    });
  }

  if (!authorized(req)) return json(res, 401, { error: "Pairing Token 无效或尚未配置" });

  if (req.method === "GET" && url.pathname === "/api/projects") {
    return json(res, 200, discoverProjects());
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readBody(req);
    const project = addUserProject(String(body.path || ""));
    return json(res, 200, { ok: true, project });
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const project = url.searchParams.get("project") || "";
    if (!project) return json(res, 400, { error: "缺少 project" });
    return json(res, 200, discoverSessions(project));
  }

  if (req.method === "GET" && url.pathname === "/api/index-status") {
    return json(res, 200, getStateIndexInfo());
  }

  if (req.method === "GET" && url.pathname === "/api/actions/task-status") {
    const sessionId = String(url.searchParams.get("sessionId") || "").trim();
    if (!sessionId) return json(res, 400, { error: "缺少 sessionId" });
    const state = newTaskStates.get(sessionId);
    return json(res, 200, state || { known: false, running: false, completed: false });
  }

  if (req.method === "POST" && url.pathname === "/api/actions/refresh") {
    const body = await readBody(req);
    const before = getStateIndexInfo().indexVersion;
    forceRefreshStateIndex();
    if (body.refreshCodex === true) codexSnapshot = refreshCodexInfo();
    const after = getStateIndexInfo();
    return json(res, 200, { ok: true, before, after, codex: codexSnapshot });
  }

  if (req.method === "POST" && url.pathname === "/api/actions/open-project") {
    const body = await readBody(req);
    openProjectInCodex(String(body.projectPath || ""));
    return json(res, 200, { ok: true, message: "已请求 Codex 打开项目" });
  }

  if (req.method === "POST" && url.pathname === "/api/actions/open-session") {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) return json(res, 400, { error: "缺少 sessionId" });
    openSessionInCodex(sessionId);
    return json(res, 200, { ok: true, message: "已请求 Codex 打开目标会话", sessionId });
  }

  if (req.method === "POST" && url.pathname === "/api/actions/send") {
    const body = await readBody(req);
    const mode = String(body.mode || "new");
    const projectPath = String(body.projectPath || "");
    const sessionId = body.sessionId ? String(body.sessionId) : "";
    const prompt = ensurePrompt(body.prompt);
    const source = body.source && typeof body.source === "object" ? body.source : null;

    if (mode === "new") {
      const launched = await launchNewTask(projectPath, prompt);
      newTaskStates.set(launched.sessionId, { known: true, running: true, completed: false });
      launched.finished.then((success) => {
        newTaskStates.set(launched.sessionId, { known: true, running: false, completed: true, success });
        setTimeout(() => newTaskStates.delete(launched.sessionId), 30 * 60_000).unref?.();
      });
      if (body.openApp) {
        launched.finished.then((completed) => {
          if (!completed) return;
          try { openSessionInCodex(launched.sessionId); }
          catch (error) { console.error(`[NewTask Open] ${error?.message || error}`); }
        });
      }
      return json(res, 200, {
        ok: true,
        message: body.openApp ? "已创建 Codex 新任务，后台完成并释放会话后将自动打开" : "已创建并发送到 Codex 新任务",
        transport: launched.transport,
        sessionId: launched.sessionId,
        source
      });
    }

    if (mode === "queue") {
      if (!sessionId) return json(res, 400, { error: "请选择已有会话" });

      const currentSession = discoverSessions(projectPath)?.sessions?.find?.((item) => item.id === sessionId) || null;
      const targetAlreadyOpen = currentSession?.status === "locked";
      let openWarning = null;
      if (body.openApp) {
        try {
          openSessionInCodex(sessionId);
        } catch (error) {
          openWarning = error?.message || String(error);
        }
      }
      const queued = await queueToSession(sessionId, prompt, { projectPath });

      const via = queued.transport === "state-db-queue"
        ? "Codex 本地持久队列"
        : queued.transport === "codex-exec-resume"
          ? "Codex Resume"
        : queued.transport === "codex-queue"
          ? "Codex Queue"
          : "Codex app-server daemon";
      const baseMessage = `方案已加入已有 Codex 会话（${via}）`;
      return json(res, 200, {
        ok: true,
        message: openWarning ? `${baseMessage}，但自动切换会话失败` : baseMessage,
        transport: queued.transport,
        codexBin: queued.codexBin || null,
        queuedSubmissionId: queued.queuedSubmissionId || null,
        targetAlreadyOpen,
        openSkipped: null,
        openWarning,
        warning: queued.warning || null,
        configIssue: queued.configIssue || null,
        source
      });
    }

    if (mode === "fork") {
      if (!sessionId) return json(res, 400, { error: "请选择已有会话" });
      launchForkTask(projectPath, sessionId, prompt);
      if (body.openApp) {
        setTimeout(() => { try { openProjectInCodex(projectPath); } catch {} }, 700);
      }
      return json(res, 200, { ok: true, message: "已基于现有会话派生新的 Codex 任务", source });
    }

    return json(res, 400, { error: "未知发送方式" });
  }

  return json(res, 404, { error: "Not Found" });
}

const server = http.createServer((req, res) => {
  const requestStarted = Date.now();
  handle(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: error.message || "Bridge 内部错误" });
  }).finally(() => {
    const ms = Date.now() - requestStarted;
    if (ms >= 100) console.log(`[API] ${req.method} ${req.url} ${ms}ms`);
  });
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Bridge 端口 ${PORT} 已被占用。请运行 restart-bridge.command 清理旧进程后重试。`);
  } else {
    console.error("Bridge server error:", error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const state = getStateIndexInfo();
  console.log("Sol → Codex Local Bridge v0.2.10");
  console.log(`Listening: http://${HOST}:${PORT}`);
  console.log(`Codex: ${codexSnapshot.version || "NOT FOUND"}`);
  console.log(`State DB: ${state.stateDb || "fallback to JSONL"}`);
  console.log(`[SessionIndex] cache=${stateInit.usedCache ? "hit" : "miss"} projects=${state.projectCount} sessions=${state.sessionCount} build=${state.lastBuildMs ?? "cached"}ms version=${state.indexVersion}`);

  // stale-while-revalidate: if a persisted cache was used, serve it immediately,
  // then refresh after the server is already accepting requests.
  if (stateInit.usedCache) {
    setTimeout(() => {
      try {
        const before = getStateIndexInfo().indexVersion;
        forceRefreshStateIndex();
        const after = getStateIndexInfo();
        console.log(`[SessionIndex] background refresh ${before}→${after.indexVersion} ${after.lastBuildMs}ms`);
      } catch (error) {
        console.error("[SessionIndex] refresh failed:", error.message);
      }
    }, 250).unref?.();
  }
});
