import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { TaskStore } from "./task-store.mjs";
import { bridgeRoot } from "./context-adapter.mjs";
import { discoverTargets, sendTask } from "./codex-transport.mjs";
import {
  getGitDiff,
  getPermission,
  getProjectContext,
  getSessionTranscript,
  getSnapshot,
  listFiles,
  readFile,
  setPermission,
} from "./context-adapter.mjs";

export const HOST = "127.0.0.1";
export const PORT = 4329;
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_TEXT_BYTES = 6 * 1024 * 1024;

const { getOrCreateToken } = await import(
  pathToFileURL(path.join(bridgeRoot, "bridge/lib/config.mjs")).href,
);
const DEFAULT_PAIRING_TOKEN = getOrCreateToken();

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, jsonHeaders);
  response.end(JSON.stringify(body));
}

function sendEmpty(response, statusCode) {
  response.writeHead(statusCode, jsonHeaders);
  response.end();
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error("请求内容过大"), { status: 413, code: "REQUEST_TOO_LARGE" });
    }
  }
  if (!body) return {};
  const value = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("请求 JSON 必须是对象"), { status: 400, code: "JSON_OBJECT_REQUIRED" });
  }
  return value;
}

function validateTask(body) {
  for (const field of ["taskId", "messageId", "workspace", "text"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      throw Object.assign(new Error(`Missing task field: ${field}`), { status: 400, code: "TASK_FIELD_REQUIRED" });
    }
  }
  const limits = { taskId: 256, messageId: 256, workspace: 4096, text: MAX_TASK_TEXT_BYTES };
  for (const [field, limit] of Object.entries(limits)) {
    if (Buffer.byteLength(body[field], "utf8") > limit) {
      throw Object.assign(new Error(`任务字段过长: ${field}`), { status: 413, code: "TASK_FIELD_TOO_LARGE" });
    }
  }
  if (body.mode != null && !["queue", "new"].includes(body.mode)) {
    throw Object.assign(new Error("mode 无效"), { status: 400, code: "TASK_MODE_INVALID" });
  }
  if (body.transferMode != null && !["auto", "text", "file"].includes(body.transferMode)) {
    throw Object.assign(new Error("transferMode 无效"), { status: 400, code: "TRANSFER_MODE_INVALID" });
  }
  const optionalLimits = { projectPath: 4096, sessionId: 256, source: 128, pageUrl: 4096, conversationTitle: 512, createdAt: 64 };
  for (const [field, limit] of Object.entries(optionalLimits)) {
    if (body[field] != null && typeof body[field] !== "string") {
      throw Object.assign(new Error(`任务字段必须是文本: ${field}`), { status: 400, code: "TASK_FIELD_INVALID" });
    }
    if (typeof body[field] === "string" && Buffer.byteLength(body[field], "utf8") > limit) {
      throw Object.assign(new Error(`任务字段过长: ${field}`), { status: 413, code: "TASK_FIELD_TOO_LARGE" });
    }
  }
}

function authorized(request, token) {
  const provided = Buffer.from(String(request.headers["x-bridge-token"] || ""));
  const expected = Buffer.from(String(token || ""));
  return provided.length > 0 && provided.length === expected.length && timingSafeEqual(provided, expected);
}

function publicTask(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    error: task.error,
    mode: task.mode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function dispatchTask(task, store, transport = sendTask) {
  const leased = store.next(task.workspace);
  if (!leased || leased.taskId !== task.taskId) return;

  try {
    store.setStatus(task.taskId, "accepted", { leaseId: leased.leaseId });
    const result = await transport(task);
    task.sessionId = result.sessionId;
    task.projectPath = result.projectPath;
    task.transport = result.transport || null;
    store.setStatus(task.taskId, "running");
    if (task.mode === "new" && result.finished?.then) {
      result.finished.then(
        () => store.setStatus(task.taskId, "executed"),
        (error) => store.setStatus(task.taskId, "error", { error: error.message }),
      );
    } else {
      // Queue transport means Codex has accepted the input; the actual turn runs in Codex.
      store.setStatus(task.taskId, "executed");
    }
  } catch (error) {
    try { store.setStatus(task.taskId, "error", { error: error.message }); } catch {}
    console.error(`[C2C] ${task.taskId}: ${error.message}`);
  }
}

export function createBridgeServer({ store = new TaskStore(), dispatch = dispatchTask, token = DEFAULT_PAIRING_TOKEN } = {}) {
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") return sendEmpty(response, 204);

    const url = new URL(request.url, `http://${HOST}`);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          ok: true,
          authRequired: true,
        });
      }

      if (!authorized(request, token)) {
        return sendJson(response, 401, { error: "Bridge pairing required", code: "PAIRING_TOKEN_INVALID" });
      }

      if (request.method === "GET" && url.pathname === "/targets") {
        return sendJson(response, 200, await discoverTargets());
      }

      if (request.method === "POST" && url.pathname === "/api/context/project") {
        return sendJson(response, 200, await getProjectContext(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/context/session") {
        return sendJson(response, 200, await getSessionTranscript(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/context/snapshot") {
        return sendJson(response, 200, await getSnapshot(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/context/git-diff") {
        return sendJson(response, 200, await getGitDiff(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/context/files") {
        return sendJson(response, 200, await listFiles(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/context/file") {
        return sendJson(response, 200, await readFile(await readJson(request)));
      }

      if (request.method === "POST" && url.pathname === "/api/context/permission") {
        return sendJson(response, 200, await setPermission(await readJson(request)));
      }

      if (request.method === "GET" && url.pathname === "/api/context/permission") {
        const projectPath = url.searchParams.get("projectPath") || "";
        return sendJson(response, 200, await getPermission({ projectPath }));
      }

      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = await readJson(request);
        validateTask(body);
        const result = store.enqueue(body);
        if (result.duplicate) {
          return sendJson(response, 200, {
            accepted: false,
            duplicate: true,
            taskId: result.task.taskId,
            status: result.task.status,
          });
        }
        if (dispatch) void dispatch(result.task, store).catch((error) => console.error(`[C2C] ${error.message}`));
        return sendJson(response, 202, {
          accepted: true,
          taskId: result.task.taskId,
          status: result.task.status,
        });
      }

      if (request.method === "GET" && parts[0] === "tasks" && parts[1]) {
        const task = store.get(decodeURIComponent(parts[1]));
        return task ? sendJson(response, 200, publicTask(task)) : sendJson(response, 404, { error: "Task not found" });
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "Invalid JSON" });
      const status = Number.isInteger(error.status) ? error.status : 500;
      return sendJson(response, status, {
        error: status >= 500 ? "Bridge request failed" : String(error.message || "请求失败").slice(0, 240),
        code: error.code || (status >= 500 ? "BRIDGE_REQUEST_FAILED" : null),
      });
    }
  });

  return server;
}

export function startBridge({ port = PORT, host = HOST } = {}) {
  const server = createBridgeServer({ token: DEFAULT_PAIRING_TOKEN });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`C2C bridge listening on http://${address.address}:${address.port}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge({ port: Number(process.env.C2C_BRIDGE_PORT || PORT) });
}
