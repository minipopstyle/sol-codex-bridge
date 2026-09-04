import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { BRIDGE_HOME, ensureBridgeHome, loadConfig, saveConfig } from "./config.mjs";

const INDEX_PATH = path.join(BRIDGE_HOME, "session-index.json");
const WATCH_INTERVAL_MS = Number(process.env.SOL_CODEX_INDEX_INTERVAL_MS || 1500);
const ACTIVE_WINDOW_MS = Number(process.env.SOL_CODEX_ACTIVE_WINDOW_MS || 90_000);

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
let nativeDb = null;
let nativeDbPath = null;
let nativeDbInode = null;
let sqliteAvailable = null;
let schemaCache = null;
let watcher = null;
let refreshInProgress = false;
let initialized = false;
let lastFingerprint = "";
let openFileCache = new Set();
let openFileCacheAt = 0;
let index = loadPersistedIndex();
let metrics = {
  cacheLoaded: Boolean(index?.metadata?.persistedAt),
  refreshCount: 0,
  lastBuildMs: null,
  lastRefreshAt: index?.metadata?.updatedAt || null,
  source: index?.metadata?.sessionSource || null,
  sessionCount: countSessions(index),
  projectCount: index?.projects?.length || 0,
  indexVersion: Number(index?.metadata?.indexVersion || 0)
};

function emptyIndex() {
  return {
    projects: [],
    sessionsByProject: {},
    sessionsById: {},
    metadata: {
      stateDb: null,
      sessionSource: null,
      codexHome: codexHome(),
      updatedAt: null,
      persistedAt: null,
      indexVersion: 0
    }
  };
}

function countSessions(value) {
  if (!value?.sessionsById || typeof value.sessionsById !== "object") return 0;
  return Object.keys(value.sessionsById).length;
}

function loadPersistedIndex() {
  ensureBridgeHome();
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    if (!parsed || !Array.isArray(parsed.projects) || typeof parsed.sessionsByProject !== "object") return emptyIndex();
    return parsed;
  } catch {
    return emptyIndex();
  }
}

function persistIndex(next) {
  ensureBridgeHome();
  const clean = {
    ...next,
    metadata: { ...next.metadata, persistedAt: Date.now() }
  };
  const tmp = `${INDEX_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, INDEX_PATH);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function existsFile(value) {
  try { return fs.statSync(value).isFile(); } catch { return false; }
}

function existsDir(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function safeRealpath(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

export function normalizeProjectPath(value) {
  if (!value) return "";
  return safeRealpath(String(value).replace(/[\\/]$/, ""));
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function sqliteHome() {
  return process.env.CODEX_SQLITE_HOME || codexHome();
}

export function stateDbCandidates() {
  const home = os.homedir();
  return [...new Set([
    path.join(sqliteHome(), "state_5.sqlite"),
    path.join(codexHome(), "state_5.sqlite"),
    path.join(home, "Library", "Application Support", "Codex", "state_5.sqlite"),
    path.join(home, "Library", "Application Support", "OpenAI", "Codex", "state_5.sqlite")
  ])];
}

export function findStateDb() {
  return stateDbCandidates().find(existsFile) || null;
}

function hasSqlite3() {
  if (DatabaseSync) return true;
  if (sqliteAvailable != null) return sqliteAvailable;
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore", timeout: 1500 });
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

function nativeDatabase(dbPath) {
  if (!DatabaseSync) return null;
  let inode = null;
  try { inode = fs.statSync(dbPath).ino; } catch {}
  if (nativeDb && nativeDbPath === dbPath && nativeDbInode === inode) return nativeDb;
  try { nativeDb?.close?.(); } catch {}
  nativeDb = new DatabaseSync(dbPath, { readOnly: true });
  nativeDbPath = dbPath;
  nativeDbInode = inode;
  return nativeDb;
}

function sqliteJson(dbPath, sql) {
  if (DatabaseSync) {
    const db = nativeDatabase(dbPath);
    return db.prepare(sql).all();
  }
  const output = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 20 * 1024 * 1024
  }).trim();
  if (!output) return [];
  return JSON.parse(output);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeTimestamp(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 10_000_000_000) return n * 1000;
  return n;
}

function newestTimestamp(row) {
  return normalizeTimestamp(row.recency_at_ms)
    || normalizeTimestamp(row.updated_at_ms)
    || normalizeTimestamp(row.updated_at)
    || normalizeTimestamp(row.created_at_ms)
    || normalizeTimestamp(row.created_at)
    || 0;
}

function readSchema(dbPath) {
  if (!dbPath || !hasSqlite3()) return null;
  let statKey = dbPath;
  try { statKey += `:${fs.statSync(dbPath).ino}`; } catch {}
  if (schemaCache?.key === statKey) return schemaCache.value;
  try {
    const tables = new Set(sqliteJson(dbPath, "SELECT name FROM sqlite_master WHERE type='table';").map((row) => row.name));
    const columns = {};
    for (const table of ["threads", "projects", "project_roots"]) {
      columns[table] = tables.has(table)
        ? new Set(sqliteJson(dbPath, `PRAGMA table_info(${quoteIdentifier(table)});`).map((row) => row.name))
        : new Set();
    }
    const value = { tables, columns };
    schemaCache = { key: statKey, value };
    return value;
  } catch {
    return null;
  }
}

function loadDbThreads(dbPath, schema) {
  if (!dbPath || !schema?.tables?.has("threads")) return [];
  const columns = schema.columns.threads;
  const desired = [
    "id", "cwd", "name", "title", "preview", "model_provider", "source", "rollout_path",
    "updated_at_ms", "updated_at", "created_at_ms", "created_at", "recency_at_ms",
    "archived", "project_id", "git_branch", "tokens_used", "has_user_event",
    "thread_source", "thread_section_id"
  ].filter((name) => columns.has(name));
  if (!desired.includes("id") || !desired.includes("cwd")) return [];
  const filters = [];
  if (columns.has("archived")) filters.push("archived = 0");
  if (columns.has("thread_source")) filters.push("COALESCE(thread_source, 'user') = 'user'");
  if (columns.has("thread_section_id")) filters.push("thread_section_id IS NULL");
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const order = columns.has("recency_at_ms") ? "recency_at_ms" : columns.has("updated_at_ms") ? "updated_at_ms" : columns.has("updated_at") ? "updated_at" : "rowid";
  try {
    return sqliteJson(dbPath, `SELECT ${desired.map(quoteIdentifier).join(",")} FROM threads ${where} ORDER BY ${quoteIdentifier(order)} DESC LIMIT 800;`)
      .map((row) => ({ ...row, _updatedAt: newestTimestamp(row) }));
  } catch {
    return [];
  }
}

function loadDbProjects(dbPath, schema) {
  if (!dbPath || !schema?.tables?.has("projects") || !schema?.tables?.has("project_roots")) return [];
  const projectCols = schema.columns.projects;
  const rootCols = schema.columns.project_roots;
  if (!projectCols.has("id") || !rootCols.has("project_id") || !rootCols.has("path")) return [];
  const name = projectCols.has("name") ? "p.name" : "NULL AS name";
  const position = projectCols.has("position") ? "p.position" : "0 AS position";
  const updated = projectCols.has("updated_at_ms") ? "p.updated_at_ms" : "NULL AS updated_at_ms";
  const rootWhere = rootCols.has("position") ? "WHERE r.position = 0" : "";
  const order = projectCols.has("position") ? "p.position ASC, p.id ASC" : "p.id ASC";
  try {
    return sqliteJson(dbPath, `
      SELECT p.id, ${name}, ${position}, ${updated}, r.path
      FROM projects p
      JOIN project_roots r ON r.project_id = p.id
      ${rootWhere}
      ORDER BY ${order};
    `);
  } catch {
    return [];
  }
}

function recursiveFiles(root, limit = 500) {
  const found = [];
  if (!existsDir(root)) return found;
  const stack = [root];
  while (stack.length && found.length < limit) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) found.push(full);
      if (found.length >= limit) break;
    }
  }
  return found;
}

function deepFindText(value, roleHint = null) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string" && value.text.trim().length > 3) return value.text.trim();
  if (typeof value.message === "string" && value.message.trim().length > 3 && (!roleHint || roleHint === "user")) return value.message.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = deepFindText(item, roleHint);
      if (text) return text;
    }
    return "";
  }
  const role = typeof value.role === "string" ? value.role : roleHint;
  if (role && role !== "user") return "";
  for (const key of ["content", "payload", "data", "item"]) {
    if (value[key] != null) {
      const text = deepFindText(value[key], role);
      if (text) return text;
    }
  }
  return "";
}

function parseRollout(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  let raw;
  try {
    const fd = fs.openSync(file, "r");
    const size = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    fs.closeSync(fd);
    raw = buffer.toString("utf8");
  } catch { return null; }

  let id = path.basename(file, ".jsonl");
  let cwd = "";
  let title = "";
  let provider = "";
  let branch = "";
  let createdAt = stat.birthtimeMs || stat.mtimeMs;
  const updatedAt = stat.mtimeMs;
  const lines = raw.split(/\r?\n/).slice(0, 500);
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload || event.data || event;
    if (event.type === "session_meta" || event.type === "session") {
      id = payload.id || event.id || id;
      cwd = payload.cwd || cwd;
      provider = payload.model_provider || payload.provider || provider;
      createdAt = normalizeTimestamp(payload.created_at_ms || payload.created_at || payload.timestamp || event.timestamp) || createdAt;
    }
    if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
    if (!provider && typeof payload.model_provider === "string") provider = payload.model_provider;
    if (!branch && typeof payload.git_branch === "string") branch = payload.git_branch;
    if (!title) {
      const candidate = deepFindText(event);
      if (candidate && !candidate.startsWith("<environment_context>")) title = candidate.replace(/\s+/g, " ").slice(0, 110);
    }
  }
  if (!cwd) return null;
  return { id, cwd, title: title || `会话 ${String(id).slice(0, 8)}`, model_provider: provider, git_branch: branch, rollout_path: file, _updatedAt: updatedAt, _createdAt: createdAt, source: "jsonl" };
}

function loadJsonlThreads() {
  const roots = [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")];
  const files = roots.flatMap((root) => recursiveFiles(root, 400));
  files.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  return files.slice(0, 350).map(parseRollout).filter(Boolean);
}

function batchOpenFiles(files) {
  if (process.platform === "win32") return new Set();
  const cacheMs = Number(process.env.SOL_CODEX_LSOF_CACHE_MS || 10_000);
  if (Date.now() - openFileCacheAt < cacheMs) return openFileCache;
  const unique = [...new Set(files.filter((file) => file && existsFile(file)))].slice(0, 500);
  if (!unique.length) {
    openFileCache = new Set();
    openFileCacheAt = Date.now();
    return openFileCache;
  }
  const child = spawnSync("lsof", ["-Fn", "--", ...unique], {
    encoding: "utf8",
    timeout: 1800,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const output = String(child.stdout || "");
  const opened = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("n") && line.length > 1) opened.add(line.slice(1));
  }
  openFileCache = opened;
  openFileCacheAt = Date.now();
  return openFileCache;
}

function isInside(projectPath, cwd) {
  const root = safeRealpath(projectPath);
  const child = safeRealpath(cwd);
  return child === root || child.startsWith(`${root}${path.sep}`);
}

function projectNameFromPath(projectPath) {
  return path.basename(projectPath.replace(/[\\/]$/, "")) || projectPath;
}

function buildIndex() {
  const started = Date.now();
  const config = loadConfig();
  const db = findStateDb();
  const schema = readSchema(db);
  const dbThreads = loadDbThreads(db, schema);
  const source = dbThreads.length ? "sqlite" : "jsonl";
  const threads = dbThreads.length ? dbThreads : loadJsonlThreads();
  const dbProjects = loadDbProjects(db, schema);
  const openPaths = batchOpenFiles(threads.map((thread) => thread.rollout_path));
  const now = Date.now();

  const projectsMap = new Map();
  const addProject = (projectPath, data = {}) => {
    if (!projectPath || !existsDir(projectPath)) return;
    const normalized = normalizeProjectPath(projectPath);
    const existing = projectsMap.get(normalized) || { path: normalized, name: projectNameFromPath(normalized), source: [] };
    const sources = new Set([...(existing.source || []), ...(data.source || [])]);
    projectsMap.set(normalized, { ...existing, ...data, path: normalized, source: [...sources] });
  };

  for (const p of dbProjects) addProject(p.path, {
    name: p.name || projectNameFromPath(p.path),
    projectId: p.id,
    position: Number(p.position),
    updatedAt: normalizeTimestamp(p.updated_at_ms),
    source: ["codex-projects-db"]
  });
  for (const p of config.userProjects) addProject(p, { source: ["manual"] });
  // The Projects sidebar is authoritative when Codex exposes it. Thread cwd values
  // also include temporary/scratch folders and must not become sidebar projects.
  if (!dbProjects.length) {
    for (const thread of threads) addProject(thread.cwd, { source: [source], updatedAt: Number(thread._updatedAt || 0) || null });
  }

  const sessionsById = {};
  const normalizedThreads = threads.map((thread) => {
    const updatedAt = Number(thread._updatedAt || 0) || null;
    const rolloutPath = thread.rollout_path || null;
    const open = rolloutPath ? openPaths.has(rolloutPath) : false;
    const status = open ? "locked" : updatedAt && now - updatedAt < ACTIVE_WINDOW_MS ? "active" : "idle";
    const title = String(thread.name || thread.title || thread.preview || `会话 ${String(thread.id).slice(0, 8)}`).replace(/\s+/g, " ").trim().slice(0, 120);
    const session = {
      id: String(thread.id),
      title,
      cwd: thread.cwd,
      modelProvider: thread.model_provider || null,
      source: thread.source || source,
      gitBranch: thread.git_branch || null,
      updatedAt,
      createdAt: normalizeTimestamp(thread.created_at_ms || thread.created_at || thread._createdAt),
      status,
      rolloutPath,
      projectId: thread.project_id || null
    };
    sessionsById[session.id] = session;
    return session;
  });

  const projects = [...projectsMap.values()].map((project) => {
    const related = normalizedThreads.filter((session) => session.cwd && isInside(project.path, session.cwd));
    const latest = related.reduce((max, item) => Math.max(max, Number(item.updatedAt || 0)), Number(project.updatedAt || 0));
    return { ...project, sessionCount: related.length, updatedAt: latest || null };
  }).sort((a, b) => {
    const aCodex = a.source?.includes("codex-projects-db");
    const bCodex = b.source?.includes("codex-projects-db");
    if (aCodex !== bCodex) return aCodex ? -1 : 1;
    if (aCodex && bCodex) return Number(a.position || 0) - Number(b.position || 0);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });

  const sessionsByProject = {};
  for (const project of projects) {
    sessionsByProject[project.path] = normalizedThreads
      .filter((session) => session.cwd && isInside(project.path, session.cwd))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  const nextVersion = Math.max(Number(index?.metadata?.indexVersion || 0), metrics.indexVersion || 0) + 1;
  const next = {
    projects,
    sessionsByProject,
    sessionsById,
    metadata: {
      stateDb: db,
      sessionSource: source,
      codexHome: codexHome(),
      updatedAt: Date.now(),
      persistedAt: null,
      indexVersion: nextVersion
    }
  };

  index = next;
  metrics = {
    ...metrics,
    refreshCount: metrics.refreshCount + 1,
    lastBuildMs: Date.now() - started,
    lastRefreshAt: next.metadata.updatedAt,
    source,
    sessionCount: Object.keys(sessionsById).length,
    projectCount: projects.length,
    indexVersion: nextVersion
  };
  persistIndex(next);
  return next;
}

function pathMtime(value) {
  try { return Math.floor(fs.statSync(value).mtimeMs); } catch { return 0; }
}

function sourceFingerprint() {
  const db = findStateDb();
  const configPath = path.join(BRIDGE_HOME, "config.json");
  const sessionsRoot = path.join(codexHome(), "sessions");
  const archivedRoot = path.join(codexHome(), "archived_sessions");
  return [db || "", pathMtime(db), pathMtime(configPath), pathMtime(sessionsRoot), pathMtime(archivedRoot)].join("|");
}

export function forceRefreshStateIndex() {
  if (refreshInProgress) return index;
  refreshInProgress = true;
  try {
    const next = buildIndex();
    lastFingerprint = sourceFingerprint();
    return next;
  } finally {
    refreshInProgress = false;
  }
}

export function initializeStateIndex() {
  if (initialized) return { usedCache: Boolean(metrics.cacheLoaded), indexVersion: Number(index?.metadata?.indexVersion || 0) };
  const hasUsefulCache = Boolean(index?.projects?.length || countSessions(index));
  if (!hasUsefulCache) forceRefreshStateIndex();
  else lastFingerprint = sourceFingerprint();
  initialized = true;
  return { usedCache: hasUsefulCache, indexVersion: Number(index?.metadata?.indexVersion || 0) };
}

export function startStateIndexWatcher() {
  if (watcher) return watcher;
  watcher = setInterval(() => {
    try {
      const fingerprint = sourceFingerprint();
      if (fingerprint !== lastFingerprint) forceRefreshStateIndex();
    } catch {}
  }, Math.max(750, WATCH_INTERVAL_MS));
  watcher.unref?.();
  return watcher;
}

export function stopStateIndexWatcher() {
  if (!watcher) return;
  clearInterval(watcher);
  watcher = null;
}

export function getStateIndexInfo() {
  return {
    ...metrics,
    stateDb: index?.metadata?.stateDb || findStateDb(),
    codexHome: codexHome(),
    persistedCache: INDEX_PATH,
    updatedAt: index?.metadata?.updatedAt || null,
    indexVersion: Number(index?.metadata?.indexVersion || metrics.indexVersion || 0)
  };
}

export function discoverProjects() {
  if (!initialized) initializeStateIndex();
  return {
    projects: index.projects || [],
    metadata: {
      stateDb: index?.metadata?.stateDb || null,
      sessionSource: index?.metadata?.sessionSource || null,
      codexHome: codexHome(),
      indexVersion: Number(index?.metadata?.indexVersion || 0),
      updatedAt: index?.metadata?.updatedAt || null,
      cached: true
    }
  };
}

export function discoverSessions(projectPath) {
  if (!initialized) initializeStateIndex();
  const root = normalizeProjectPath(projectPath);
  const sessions = index.sessionsByProject?.[root] || [];
  return {
    sessions,
    source: index?.metadata?.sessionSource || null,
    indexVersion: Number(index?.metadata?.indexVersion || 0),
    updatedAt: index?.metadata?.updatedAt || null,
    cached: true
  };
}

export function getSessionById(sessionId) {
  if (!initialized) initializeStateIndex();
  const id = String(sessionId || "").trim();
  if (!id) return null;
  return index.sessionsById?.[id] || null;
}

export function assertSessionBelongsToProject(sessionId, projectPath) {
  const session = getSessionById(sessionId);
  if (!session) throw Object.assign(new Error("Codex 会话不存在或尚未被索引"), { status: 404, code: "SESSION_NOT_FOUND" });
  const root = normalizeProjectPath(projectPath);
  const cwd = normalizeProjectPath(session.cwd);
  const relative = root && cwd ? path.relative(root, cwd) : "..";
  if (!root || !cwd || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Codex 会话不属于当前项目"), { status: 403, code: "SESSION_PROJECT_MISMATCH" });
  }
  return session;
}

export function isKnownProject(projectPath) {
  if (!initialized) initializeStateIndex();
  const root = normalizeProjectPath(projectPath);
  return Boolean(root && index.projects?.some((project) => project.path === root));
}

export function addUserProject(projectPath) {
  if (!projectPath || !path.isAbsolute(projectPath)) throw new Error("请输入本地项目的绝对路径");
  if (!existsDir(projectPath)) throw new Error("目录不存在");
  const normalized = normalizeProjectPath(projectPath);
  const config = loadConfig();
  if (!config.userProjects.includes(normalized)) config.userProjects.push(normalized);
  saveConfig(config);
  forceRefreshStateIndex();
  return { path: normalized, name: projectNameFromPath(normalized) };
}
