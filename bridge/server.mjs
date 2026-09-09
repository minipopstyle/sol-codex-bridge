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
import { findCodexDesktop, startBridge } from "./lib/platform/index.mjs";
import { buildContextBundle, buildSessionSnapshot } from "./lib/context-bundle.mjs";
import { readTranscript } from "./lib/codex-transcript.mjs";
import { getGitDiff, searchProject, readProjectFile } from "./lib/project-context.mjs";
import { listProjectDirectory, readProjectFile as readProjectPreview, readProjectFileData } from "./lib/project-files.mjs";
import { isReadAllowed, readPermission, setReadPermission } from "./lib/workspace-guard.mjs";
import { appendHandoff } from "./lib/handoff-ledger.mjs";
import { prepareHandoffPayload } from "./lib/handoff-payload.mjs";
import { cleanupHandoffArtifacts } from "./lib/handoff-artifact.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SOL_CODEX_BRIDGE_PORT || 37821);
const TOKEN = getOrCreateToken();
const startedAt = Date.now();
const newTaskStates = new Map();

try { startBridge(); } catch (error) {
  error.code = error.code || "BRIDGE_START_FAILED";
  throw error;
}

function recordHandoff(source, projectPath, sessionId, transport, payload) {
  try { appendHandoff({ source, projectPath, sessionId, transport, payload }); }
  catch (error) { console.error(`[HandoffLedger] ${error?.message || error}`); }
}

// Heavy discovery happens once at process start, never inside /health or /sessions.
const stateInit = initializeStateIndex();
startStateIndexWatcher();
let codexSnapshot = getCodexInfo({ fresh: true });
const desktopApp = findCodexDesktop();

function capabilities() {
  const desktop = Boolean(desktopApp);
  return {
    codexCli: Boolean(codexSnapshot?.found),
    codexDesktop: desktop,
    openThread: desktop,
    openProject: desktop,
    sessionRead: true,
    projectFiles: true,
    gitDiff: true
  };
}
try { cleanupHandoffArtifacts(); } catch (error) { console.error(`[HandoffArtifacts] ${error?.message || error}`); }

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
      bridgeVersion: "0.2.12",
      uptimeMs: Date.now() - startedAt,
      platform: process.platform,
      desktopAvailable: Boolean(desktopApp),
      cliAvailable: Boolean(codexSnapshot?.found),
      capabilities: capabilities(),
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

  if (req.method === "GET" && url.pathname === "/api/context/permission") {
    const projectPath = url.searchParams.get("project") || "";
    if (!projectPath) return json(res, 400, { error: "缺少 project" });
    return json(res, 200, { ...readPermission(projectPath), allowed: isReadAllowed(projectPath) });
  }

  if (req.method === "POST" && url.pathname === "/api/context/permission") {
    const body = await readBody(req);
    if (typeof body.allowed !== "boolean") return json(res, 400, { error: "allowed 必须是布尔值" });
    return json(res, 200, setReadPermission(String(body.projectPath || ""), body.allowed));
  }

  if (req.method === "GET" && url.pathname === "/api/context/snapshot") {
    const projectPath = url.searchParams.get("project") || "";
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!projectPath || !sessionId) return json(res, 400, { error: "缺少 project 或 sessionId" });
    return json(res, 200, buildSessionSnapshot({ projectPath, sessionId }));
  }

  if (req.method === "GET" && url.pathname === "/api/context/session") {
    const projectPath = url.searchParams.get("project") || "";
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!projectPath || !sessionId) return json(res, 400, { error: "缺少 project 或 sessionId" });
    return json(res, 200, readTranscript({
      projectPath,
      sessionId,
      direction: url.searchParams.get("direction") || "tail",
      cursor: url.searchParams.get("cursor") || null,
      maxMessages: url.searchParams.get("maxMessages") || 60,
      maxTotalBytes: url.searchParams.get("maxTotalBytes") || 80_000,
      maxToolOutputBytes: url.searchParams.get("maxToolOutputBytes") || 12_000,
      excludeToolOutputs: url.searchParams.get("excludeToolOutputs") === "true"
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/context/git") {
    const projectPath = url.searchParams.get("project") || "";
    if (!projectPath) return json(res, 400, { error: "缺少 project" });
    return json(res, 200, getGitDiff(projectPath));
  }

  if (req.method === "GET" && url.pathname === "/api/project-files") {
    const projectPath = url.searchParams.get("project") || "";
    if (!projectPath) return json(res, 400, { error: "缺少 project" });
    return json(res, 200, listProjectDirectory(projectPath, url.searchParams.get("path") || ""));
  }

  if (req.method === "GET" && url.pathname === "/api/project-file") {
    const projectPath = url.searchParams.get("project") || "";
    if (!projectPath) return json(res, 400, { error: "缺少 project" });
    return json(res, 200, readProjectPreview(projectPath, url.searchParams.get("path") || ""));
  }

  if (req.method === "GET" && url.pathname === "/api/project-file-data") {
    const projectPath = url.searchParams.get("project") || "";
    if (!projectPath) return json(res, 400, { error: "缺少 project" });
    return json(res, 200, readProjectFileData(projectPath, url.searchParams.get("path") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/context/file") {
    const body = await readBody(req);
    return json(res, 200, readProjectFile(body));
  }

  if (req.method === "POST" && url.pathname === "/api/context/search") {
    const body = await readBody(req);
    return json(res, 200, searchProject(body));
  }

  if (req.method === "POST" && url.pathname === "/api/context/bundle") {
    const body = await readBody(req);
    return json(res, 200, buildContextBundle({
      ...body,
      runtimeInfo: {
        found: Boolean(codexSnapshot?.found),
        version: codexSnapshot?.version || null,
        source: codexSnapshot?.source || null,
        capabilities: codexSnapshot?.capabilities || {},
        desktop: { found: Boolean(desktopApp) },
        bridgeCapabilities: capabilities()
      }
    }));
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
    const handoffStartedAt = Date.now();
    const payload = prepareHandoffPayload({
      text: prompt,
      projectPath,
      sessionId,
      source,
      transferMode: body.transferMode || body.payloadMode || body.forceMode || "auto"
    });
    const codexPrompt = payload.codexPrompt;
    const payloadInfo = {
      mode: payload.mode,
      transferMode: payload.transferMode,
      originalBytes: payload.originalBytes,
      artifact: payload.artifact ? {
        filename: payload.artifact.filename,
        relativePath: payload.artifact.relativePath,
        format: payload.artifact.format,
        mimeType: payload.artifact.mimeType,
        bytes: payload.artifact.bytes,
        sha256: payload.artifact.sha256,
        reused: payload.artifact.reused
      } : null
    };

    if (mode === "new") {
      console.log(`[Handoff New] payload prepared ${Date.now() - handoffStartedAt}ms`);
      const launched = await launchNewTask(projectPath, codexPrompt);
      console.log(`[Handoff New] thread started ${Date.now() - handoffStartedAt}ms`);
      recordHandoff(source, projectPath, launched.sessionId, launched.transport, payload);
      newTaskStates.set(launched.sessionId, { known: true, running: true, completed: false });
      launched.finished.then((success) => {
        console.log(`[Handoff New] task completed ${Date.now() - handoffStartedAt}ms success=${success}`);
        newTaskStates.set(launched.sessionId, { known: true, running: false, completed: true, success });
        setTimeout(() => newTaskStates.delete(launched.sessionId), 30 * 60_000).unref?.();
      });
      if (body.openApp) {
        launched.finished.then((completed) => {
          if (!completed) return;
          try {
            openSessionInCodex(launched.sessionId);
            console.log(`[Handoff New] desktop open after completion ${Date.now() - handoffStartedAt}ms`);
          } catch (error) {
            console.error(`[NewTask Open] ${error?.message || error}`);
          }
        }).catch(() => {});
      }
      return json(res, 200, {
        ok: true,
        accepted: true,
        running: true,
        message: payload.transferMode === "file" ? "已作为 Markdown 上下文发送到 Codex" : body.openApp ? "已创建 Codex 新任务，完成后切换到 Codex 会话" : "已创建并发送到 Codex 新任务",
        transport: launched.transport,
        sessionId: launched.sessionId,
        payload: payloadInfo,
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
      const queued = await queueToSession(sessionId, codexPrompt, { projectPath });
      recordHandoff(source, projectPath, sessionId, queued.transport, payload);

      const via = queued.transport === "state-db-queue"
        ? "Codex 本地持久队列"
        : queued.transport === "codex-exec-resume"
          ? "Codex Resume"
        : queued.transport === "codex-queue"
          ? "Codex Queue"
          : "Codex app-server daemon";
      const baseMessage = payload.transferMode === "file" ? "已作为 Markdown 上下文发送到 Codex" : `方案已加入已有 Codex 会话（${via}）`;
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
        payload: payloadInfo,
        source
      });
    }

    if (mode === "fork") {
      if (!sessionId) return json(res, 400, { error: "请选择已有会话" });
      launchForkTask(projectPath, sessionId, codexPrompt);
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
    json(res, error.status || 500, { error: error.message || "Bridge 内部错误", code: error.code || null });
  }).finally(() => {
    const ms = Date.now() - requestStarted;
    if (ms >= 100) console.log(`[API] ${req.method} ${req.url} ${ms}ms`);
  });
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    error.code = "PORT_IN_USE";
    console.error(`Bridge 端口 ${PORT} 已被占用。请运行对应平台的 restart-bridge 脚本清理旧进程后重试。`);
  } else {
    error.code = "BRIDGE_START_FAILED";
    console.error("Bridge server error:", error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const state = getStateIndexInfo();
  console.log("Sol → Codex Local Bridge v0.2.12");
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
