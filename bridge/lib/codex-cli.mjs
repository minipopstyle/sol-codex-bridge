import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { queueViaLocalDaemon, daemonSocketExists } from "./codex-daemon.mjs";
import { findStateDb } from "./codex-state.mjs";
import { openDesktopThread, openDesktopProject } from "./codex-desktop.mjs";

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}

const CACHE_TTL_MS = Number(process.env.SOL_CODEX_CLI_CACHE_MS || 10 * 60 * 1000);
let cachedSelection = null;
let cachedAt = 0;

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 12_000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env || process.env
  }).trim();
}

function executable(file) {
  if (!file) return false;
  try {
    fs.accessSync(file, fsConstants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function savedCodexBin() {
  const bridgeHome = process.env.SOL_CODEX_BRIDGE_HOME || path.join(os.homedir(), ".sol-codex-bridge");
  const config = path.join(bridgeHome, "codex-bin");
  try {
    const value = fs.readFileSync(config, "utf8").trim();
    return executable(value) ? value : null;
  } catch {
    return null;
  }
}

function interactiveShellCodex() {
  const shell = process.env.SHELL || "/bin/zsh";
  if (!executable(shell)) return null;
  try {
    const result = execText(shell, ["-lic", "command -v codex 2>/dev/null || true"], {
      timeout: 2500,
      env: {
        ...process.env,
        PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      }
    });
    return executable(result) ? result : null;
  } catch {
    return null;
  }
}

function commandList(bin) {
  if (!bin) return new Set();
  try {
    const help = execText(bin, ["--help"], { timeout: 3500 });
    const commands = new Set();
    let inCommands = false;
    for (const line of help.split(/\r?\n/)) {
      if (/^Commands:\s*$/.test(line.trimEnd())) {
        inCommands = true;
        continue;
      }
      if (!inCommands) continue;
      if (/^\S/.test(line) && line.trim()) break;
      const match = line.match(/^\s{2,}([a-z][a-z0-9-]*)\s{2,}/i);
      if (match) commands.add(match[1]);
    }
    return commands;
  } catch {
    return new Set();
  }
}

function subcommandList(bin, command) {
  if (!bin) return new Set();
  try {
    const help = execText(bin, [command, "--help"], { timeout: 3500 });
    const commands = new Set();
    let inCommands = false;
    for (const line of help.split(/\r?\n/)) {
      if (/^Commands:\s*$/.test(line.trimEnd())) {
        inCommands = true;
        continue;
      }
      if (!inCommands) continue;
      if (/^\S/.test(line) && line.trim()) break;
      const match = line.match(/^\s{2,}([a-z][a-z0-9-]*)\s{2,}/i);
      if (match) commands.add(match[1]);
    }
    return commands;
  } catch {
    return new Set();
  }
}

function versionTuple(version) {
  const match = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function versionScore(version) {
  const [major, minor, patch] = versionTuple(version);
  return major * 1_000_000 + minor * 1_000 + patch;
}

function candidateScore(info) {
  // Existing-session handoff is the most important capability for this bridge.
  // A newer app-bundled CLI that has `queue` must beat an older shell CLI that does not.
  let score = 0;
  if (info.capabilities.queueCli) score += 1_000_000_000;
  if (info.capabilities.fork) score += 10_000_000;
  if (info.capabilities.app) score += 1_000_000;
  if (info.capabilities.execResume) score += 100_000;
  score += Math.min(versionScore(info.version), 99_999);
  if (/^(Codex|ChatGPT)\.app/.test(info.source || "")) score += 100;
  return score;
}

function candidatePaths() {
  const raw = [];
  const push = (bin, source) => {
    if (executable(bin)) raw.push({ bin, source });
  };

  // CODEX_BIN is a hint by default, not an unconditional override. v0.2.3 made
  // this a hard override and could pin the bridge to an older npm CLI forever.
  push(process.env.CODEX_BIN, "CODEX_BIN");
  push(savedCodexBin(), "saved");

  const extra = String(process.env.SOL_CODEX_EXTRA_BINS || "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const bin of extra) push(bin, "extra");

  push("/Applications/Codex.app/Contents/Resources/codex", "Codex.app");
  push(path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"), "Codex.app(user)");
  push("/Applications/ChatGPT.app/Contents/Resources/codex", "ChatGPT.app");
  push(path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"), "ChatGPT.app(user)");

  for (const bin of [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".cargo", "bin", "codex"),
    path.join(os.homedir(), "Library", "pnpm", "codex")
  ]) push(bin, "common-path");

  push(interactiveShellCodex(), "login-shell");
  try { push(execText("/usr/bin/which", ["codex"], { timeout: 1500 }), "PATH"); } catch {}

  const deduped = [];
  const seen = new Set();
  for (const item of raw) {
    let key = item.bin;
    try { key = fs.realpathSync(item.bin); } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function inspectCandidate(candidate) {
  const { bin, source } = candidate;
  let version = null;
  try { version = execText(bin, ["--version"], { timeout: 2500 }); } catch {}
  const commands = commandList(bin);
  const execCommands = commands.has("exec") ? subcommandList(bin, "exec") : new Set();
  const capabilities = {
    exec: commands.has("exec"),
    queue: commands.has("queue"),
    queueCli: commands.has("queue"),
    daemonQueueCandidate: daemonSocketExists(),
    fork: commands.has("fork") || execCommands.has("fork"),
    app: commands.has("app"),
    execResume: execCommands.has("resume")
  };
  const info = { found: true, bin, source, version, capabilities };
  info.score = candidateScore(info);
  return info;
}

function selectCodexCandidate({ fresh = false } = {}) {
  if (!fresh && cachedSelection && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSelection;

  const candidates = candidatePaths().map(inspectCandidate);
  let selected = null;

  if (process.env.SOL_CODEX_FORCE_BIN === "1" && executable(process.env.CODEX_BIN)) {
    selected = candidates.find((item) => item.bin === process.env.CODEX_BIN) || inspectCandidate({ bin: process.env.CODEX_BIN, source: "CODEX_BIN(force)" });
  } else {
    selected = [...candidates].sort((a, b) => b.score - a.score)[0] || null;
  }

  cachedSelection = { selected, candidates };
  cachedAt = Date.now();
  return cachedSelection;
}

export function findCodexBin() {
  return selectCodexCandidate().selected?.bin || null;
}

export function refreshCodexInfo() {
  return getCodexInfo({ fresh: true });
}

export function getCodexInfo(options = {}) {
  const { selected, candidates } = selectCodexCandidate(options);
  if (!selected) return { found: false, bin: null, source: null, version: null, capabilities: {}, candidates: [] };
  const { score: _score, ...cleanSelected } = selected;
  return {
    ...cleanSelected,
    candidates: candidates.map(({ score, ...item }) => item)
  };
}

function ensureProject(projectPath) {
  const stat = fs.statSync(projectPath, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error("项目目录不存在");
}

function writePromptTemp(prompt) {
  const dir = path.join(os.tmpdir(), "sol-codex-bridge");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `prompt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  return file;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function openProjectInCodex(projectPath) {
  ensureProject(projectPath);
  return openDesktopProject(projectPath);
}

export function codexThreadUrl(sessionId) {
  const value = String(sessionId || "").trim();
  if (!value) throw new Error("缺少 Codex 会话 ID");
  return `codex://threads/${encodeURIComponent(value)}`;
}

function openCodexDeepLink(url) {
  if (process.platform === "darwin") {
    // Codex Desktop registers com.openai.codex. Routing by bundle id is more
    // reliable than `codex app <PATH>` and, crucially, does not create a new thread.
    try {
      execText("/usr/bin/open", ["-b", "com.openai.codex", url], { timeout: 8000 });
    } catch {
      // Fallback lets LaunchServices pick the registered handler.
      execText("/usr/bin/open", [url], { timeout: 8000 });
    }
    return;
  }

  if (process.platform === "win32") {
    execText("powershell.exe", [
      "-NoProfile",
      "-Command",
      "& { param($target) Start-Process -FilePath $target }",
      url
    ], { timeout: 8000 });
    return;
  }

  throw new Error("当前平台暂不支持自动切换 Codex Desktop 会话");
}

export function openSessionInCodex(sessionId) {
  return openDesktopThread(sessionId);
}

function queueConfigIssue(text) {
  const value = String(text || "");
  const match = value.match(/Model provider\s+[`']([^`']+)[`']\s+not found/i);
  if (match) {
    return {
      code: "MODEL_PROVIDER_NOT_FOUND",
      provider: match[1],
      message: `Codex config.toml 引用了不存在的 model provider：${match[1]}`
    };
  }
  if (/无法加载\s*config\.toml|failed to load.*config\.toml|config\.toml/i.test(value) && /provider|model/i.test(value)) {
    return { code: "CODEX_CONFIG_INVALID", provider: null, message: "Codex config.toml 无法加载" };
  }
  return null;
}

export function queueViaCli(sessionId, prompt, info = getCodexInfo({ fresh: true }), projectPath = null) {
  const threadId = String(sessionId || "").trim();
  const text = String(prompt || "");
  if (!threadId) throw new Error("缺少 Codex 会话 ID");
  if (!text.trim()) throw new Error("方案内容为空");
  if (!info?.bin || !info?.capabilities?.queueCli) throw new Error("当前 Codex CLI 不支持 queue");

  try {
    const args = ["queue", "--thread", threadId, "--message", text];
    if (projectPath) args.push("-C", projectPath);
    const output = execText(info.bin, args, { timeout: 30_000, cwd: projectPath || undefined });
    return { ok: true, transport: "codex-queue", codexBin: info.bin, codexVersion: info.version, output };
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim() || error?.stdout?.toString?.().trim() || error?.message || String(error);
    const wrapped = new Error(detail || "Codex queue 发送失败");
    wrapped.code = queueConfigIssue(detail)?.code || "CODEX_QUEUE_FAILED";
    throw wrapped;
  }
}

function startNewViaCli(projectPath, prompt, info = getCodexInfo({ fresh: true })) {
  const text = String(prompt || "");
  if (!text.trim()) throw new Error("方案内容为空");
  ensureProject(projectPath);
  if (!info?.bin || !info?.capabilities?.exec) throw new Error("当前 Codex CLI 不支持创建新任务");

  return new Promise((resolve, reject) => {
    const child = spawn(info.bin, ["exec", "--skip-git-repo-check", "--json", text], {
      cwd: projectPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let started = false;
    let stdout = "";
    let stderr = "";
    let finish;
    const finished = new Promise((done) => { finish = done; });
    const timer = setTimeout(() => {
      if (started) return;
      child.kill();
      reject(new Error("Codex 新任务启动超时"));
    }, 12_000);

    child.stdout.on("data", (chunk) => {
      if (started) return;
      stdout = (stdout + chunk.toString()).slice(-64 * 1024);
      const event = stdout.split(/\r?\n/).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).find((item) => item?.type === "thread.started");
      if (!event) return;
      const sessionId = String(event.thread_id || event.threadId || event.thread?.id || "").trim();
      if (!sessionId) return;
      started = true;
      clearTimeout(timer);
      resolve({
        ok: true,
        transport: "codex-exec",
        codexBin: info.bin,
        codexVersion: info.version,
        sessionId,
        pid: child.pid,
        finished
      });
    });
    child.stderr.on("data", (chunk) => {
      if (!started) stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!started) reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!started) reject(new Error(stderr.trim() || stdout.trim() || `Codex 新任务已退出（${code}）`));
      else {
        if (code !== 0) console.error(`[Codex New Task] exit=${code}`);
        finish(code === 0);
      }
    });
  });
}

export function resumeViaCli(sessionId, prompt, projectPath, info = getCodexInfo({ fresh: true })) {
  const threadId = String(sessionId || "").trim();
  const text = String(prompt || "");
  if (!threadId) throw new Error("缺少 Codex 会话 ID");
  if (!text.trim()) throw new Error("方案内容为空");
  ensureProject(projectPath);
  if (!info?.bin || !info?.capabilities?.execResume) throw new Error("当前 Codex CLI 不支持 exec resume");

  return new Promise((resolve, reject) => {
    const child = spawn(info.bin, ["exec", "resume", "--skip-git-repo-check", "--json", threadId, text], {
      cwd: projectPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let started = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (started) return;
      child.kill();
      reject(new Error("Codex exec resume 启动超时"));
    }, 12_000);

    child.stdout.on("data", (chunk) => {
      if (started) return;
      stdout = (stdout + chunk.toString()).slice(-64 * 1024);
      if (!stdout.split(/\r?\n/).some((line) => {
        try { return JSON.parse(line).type === "thread.started"; } catch { return false; }
      })) return;
      started = true;
      clearTimeout(timer);
      resolve({ ok: true, transport: "codex-exec-resume", codexBin: info.bin, codexVersion: info.version, pid: child.pid });
    });
    child.stderr.on("data", (chunk) => {
      if (!started) stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!started) reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!started) reject(new Error(stderr.trim() || stdout.trim() || `Codex exec resume 已退出（${code}）`));
      else if (code !== 0) console.error(`[Codex Resume] thread=${threadId} exit=${code}`);
    });
  });
}

function stateDbQueueSupport() {
  if (!DatabaseSync) return { available: false, reason: "node:sqlite 不可用" };
  const dbPath = findStateDb();
  if (!dbPath) return { available: false, reason: "未找到 Codex state_5.sqlite" };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 1200");
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='trigger'").all().map((row) => row.name));
    const available = names.has("threads") && names.has("queued_items") && names.has("queued_thread_revisions") && names.has("queued_items_revision_after_insert");
    return {
      available,
      dbPath,
      reason: available ? null : "当前 Codex state DB 缺少 queued_items / queued_thread_revisions / queued_items_revision_after_insert"
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export function queueViaStateDb(sessionId, prompt) {
  if (!DatabaseSync) throw new Error("当前 Node.js 不提供 node:sqlite，无法使用 Codex 本地持久队列兜底");
  const dbPath = findStateDb();
  if (!dbPath) throw new Error("未找到 Codex state_5.sqlite，无法写入本地持久队列");

  const threadId = String(sessionId || "").trim();
  if (!threadId) throw new Error("缺少 Codex 会话 ID");
  const text = String(prompt || "");
  if (!text.trim()) throw new Error("方案内容为空");

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 2500");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has("threads") || !tables.has("queued_items")) {
      throw new Error("当前 Codex state DB 尚不支持 queued_items 持久队列");
    }
    // Codex Desktop's external queue watcher discovers changes through the
    // revision table maintained by this insert trigger. Without both pieces a
    // raw queued_items insert could persist forever without waking the thread,
    // so fail loudly instead of reporting a false successful handoff.
    const revisionTable = tables.has("queued_thread_revisions");
    const revisionTrigger = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type='trigger' AND name='queued_items_revision_after_insert' LIMIT 1"
    ).get();
    if (!revisionTable || !revisionTrigger) {
      throw new Error("当前 Codex state DB 缺少 external queue revision schema，无法安全直写持久队列");
    }
    const thread = db.prepare("SELECT id FROM threads WHERE id = ? LIMIT 1").get(threadId);
    if (!thread) throw new Error(`Codex 会话不存在：${threadId}`);

    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM queued_items WHERE thread_id = ?").get(threadId)?.n || 0);
    if (count >= 100) throw new Error("该 Codex 会话待处理队列已达到 100 条上限");

    const itemId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    const now = Date.now();
    // Codex TurnInput uses serde's externally-tagged enum representation.
    // This is the same durable payload consumed by codex-rs/ext/queue.
    const payload = JSON.stringify({
      UserInput: {
        content: [{ type: "text", text, text_elements: [] }],
        client_id: clientId
      }
    });

    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`
        INSERT INTO queued_items (
          id, thread_id, payload_json, queue_order,
          created_at_ms, updated_at_ms
        )
        VALUES (
          ?, ?, ?,
          COALESCE((SELECT MAX(queue_order) FROM queued_items WHERE thread_id = ?), -1) + 1,
          ?, ?
        )
        RETURNING id, queue_order
      `).get(itemId, threadId, payload, threadId, now, now);
      db.exec("COMMIT");
      return {
        ok: true,
        transport: "state-db-queue",
        queuedSubmissionId: row?.id || itemId,
        clientUserMessageId: clientId,
        queueOrder: row?.queue_order ?? null,
        stateDb: dbPath
      };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    try { db.close(); } catch {}
  }
}

export async function queueToSession(sessionId, prompt, { projectPath = null } = {}) {
  const errors = [];
  const stateDbSupport = stateDbQueueSupport();
  const daemonAvailable = daemonSocketExists();

  if (daemonAvailable) {
    try {
      return await queueViaLocalDaemon(sessionId, prompt);
    } catch (error) {
      errors.push(`app-server daemon: ${error?.message || error}`);
    }
  } else {
    errors.push("app-server daemon socket: not found");
  }

  if (stateDbSupport.available) {
    try {
      return queueViaStateDb(sessionId, prompt);
    } catch (error) {
      errors.push(`state DB queue: ${error?.message || error}`);
    }
  } else {
    errors.push(`state DB queue: ${stateDbSupport.reason}`);
  }

  const cliInfo = getCodexInfo({ fresh: true });
  if (cliInfo.capabilities?.execResume && projectPath) {
    try {
      const result = await resumeViaCli(sessionId, prompt, projectPath, cliInfo);
      return { ...result, fallbackFrom: errors };
    } catch (error) {
      errors.push(`codex exec resume: ${error?.message || error}`);
    }
  }

  if (cliInfo.capabilities?.queueCli) {
    try {
      const result = queueViaCli(sessionId, prompt, cliInfo, projectPath);
      return { ...result, fallbackFrom: errors };
    } catch (error) {
      errors.push(`codex queue: ${error?.message || error}`);
    }
  } else {
    errors.push("codex queue: 当前 Codex CLI 不支持 queue");
  }

  const error = new Error(`无法向 Codex 会话发送：${errors.join("；")}`);
  error.code = "CODEX_QUEUE_UNAVAILABLE";
  error.previousTransportErrors = errors;
  throw error;
}

export function launchNewTask(projectPath, prompt) {
  return startNewViaCli(projectPath, prompt);
}

export function launchForkTask(projectPath, sessionId, prompt) {
  ensureProject(projectPath);
  const error = new Error("派生任务目前没有稳定的 Codex Desktop 深链/API。为避免再次打开 Terminal/CLI，v2.10 暂时禁用自动派生；请先使用‘已有会话’或‘项目新任务’。");
  error.code = "DESKTOP_FORK_NOT_SUPPORTED";
  throw error;
}
