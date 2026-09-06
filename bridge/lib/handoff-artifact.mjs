import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { BRIDGE_HOME, ensureBridgeHome } from "./config.mjs";

export const HANDOFF_ARTIFACT_ROOT = path.join(BRIDGE_HOME, "handoffs");
export const HANDOFF_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const HANDOFF_MAX_BYTES = 200 * 1024 * 1024;

function safeValue(value, fallback = "unknown") {
  return String(value ?? fallback).replace(/[\r\n]/g, " ").trim() || fallback;
}

export function buildArtifactDocument({ schema = "sol-codex-handoff/v1", metadata = {}, text = "" } = {}) {
  const fields = Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : safeValue(value)}`);
  return ["---", `schema: ${safeValue(schema)}`, ...fields, "---", "", String(text)].join("\n");
}

function projectName(projectPath) {
  return path.basename(String(projectPath || "").replace(/[\\/]$/, "")) || "project";
}

function filenamePart(value) {
  return String(value || "project").normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "project";
}

function localTimestamp(value) {
  const date = new Date(value);
  const pad = (item) => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function realProjectPath(value) {
  const input = String(value || "").trim();
  if (!input || !path.isAbsolute(input)) throw Object.assign(new Error("项目路径必须是绝对路径"), { status: 400, code: "PROJECT_PATH_INVALID" });
  let root;
  try { root = fs.realpathSync(input); } catch { throw Object.assign(new Error("项目目录不存在"), { status: 400, code: "PROJECT_NOT_FOUND" }); }
  if (!fs.statSync(root).isDirectory()) throw Object.assign(new Error("项目路径不是目录"), { status: 400, code: "PROJECT_NOT_DIRECTORY" });
  return root;
}

function isSubpath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativePath(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function writeFileAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, value, { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function ensureStore(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  const probe = path.join(root, `.probe-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
  fs.writeFileSync(probe, "ok", { mode: 0o600 });
  try { fs.chmodSync(probe, 0o600); } catch {}
  fs.readFileSync(probe, "utf8");
  fs.unlinkSync(probe);
  return root;
}

function projectStore(root) {
  return path.join(root, ".sol-codex-bridge", "handoffs");
}

function storeCandidates(root) {
  const local = projectStore(root);
  return process.env.SOL_CODEX_HANDOFF_FORCE_PROJECT === "1"
    ? [{ root: local, kind: "project" }, { root: HANDOFF_ARTIFACT_ROOT, kind: "home" }]
    : [{ root: HANDOFF_ARTIFACT_ROOT, kind: "home" }, { root: local, kind: "project" }];
}

function listArtifactDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function readMetadata(directory) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));
    const filename = path.basename(String(metadata.filename || ""));
    if (!filename || filename !== metadata.filename) return null;
    const file = path.join(directory, filename);
    if (!fs.statSync(file).isFile()) return null;
    return { directory, metadata, file };
  } catch {
    return null;
  }
}

function findExisting(roots, projectPath, sessionId, sha256) {
  // ponytail: linear metadata scan; add an index if handoff volume makes sends slow.
  for (const candidate of roots) {
    for (const directory of listArtifactDirectories(candidate.root)) {
      const entry = readMetadata(directory);
      if (!entry) continue;
      if (entry.metadata.projectPath === projectPath && String(entry.metadata.sessionId || "") === sessionId && entry.metadata.sha256 === sha256) {
        return { ...candidate, ...entry };
      }
    }
  }
  return null;
}

function addGitExclude(root) {
  let exclude;
  try {
    exclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!exclude) return;
    if (!path.isAbsolute(exclude)) exclude = path.resolve(root, exclude);
  } catch {
    exclude = path.join(root, ".git", "info", "exclude");
  }
  try {
    if (!fs.existsSync(path.dirname(exclude))) return;
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (/^\.sol-codex-bridge\/?\s*$/m.test(current)) return;
    fs.writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.sol-codex-bridge/\n`, { mode: 0o600 });
  } catch {}
}

function artifactResult({ candidate, directory, filename, contentBytes, sha256, contentType, sessionId, reused = false }) {
  const file = path.join(directory, filename);
  const relative = candidate.kind === "project" ? relativePath(candidate.projectPath, file) : null;
  return {
    id: path.basename(directory),
    path: file,
    relativePath: relative || file,
    filename,
    format: "markdown",
    mimeType: "text/markdown",
    bytes: contentBytes,
    sha256,
    contentType,
    sessionId: sessionId || null,
    storage: candidate.kind,
    reused
  };
}

export function writeHandoffArtifact({ text, projectPath, sessionId = "", source = {}, contentType = "assistant-response" } = {}) {
  const content = String(text || "");
  if (!content.trim()) throw Object.assign(new Error("方案内容为空"), { status: 400, code: "EMPTY_PROMPT" });
  const root = realProjectPath(projectPath);
  const contentBytes = Buffer.byteLength(content, "utf8");
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const candidates = storeCandidates(root).map((item) => ({ ...item, projectPath: root }));
  const existing = findExisting(candidates, root, String(sessionId || ""), sha256);
  if (existing) {
    return artifactResult({ candidate: existing, directory: existing.directory, filename: existing.metadata.filename, contentBytes, sha256, contentType: existing.metadata.contentType || contentType, sessionId, reused: true });
  }

  const createdAt = new Date().toISOString();
  const sourceName = "chatgpt";
  const filename = `Sol-Handoff_${filenamePart(projectName(root))}_${localTimestamp(createdAt)}.md`;
  let failure = null;
  for (const candidate of candidates) {
    try {
      ensureStore(candidate.root);
      const id = crypto.randomUUID();
      const directory = path.join(candidate.root, id);
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
      try { fs.chmodSync(directory, 0o700); } catch {}
      const document = buildArtifactDocument({
        schema: "sol-codex-handoff/v1",
        metadata: {
          source: sourceName,
          project: projectName(root),
          created_at: createdAt,
          content_type: contentType,
          format: "markdown",
          bytes: contentBytes,
          sha256
        },
        text: content
      });
      writeFileAtomic(path.join(directory, filename), document);
      writeFileAtomic(path.join(directory, "metadata.json"), `${JSON.stringify({
        schema: "sol-codex-handoff/v1",
        id,
        source: sourceName,
        target: "codex",
        contentType,
        project: projectName(root),
        projectPath: root,
        sessionId: sessionId || null,
        filename,
        format: "markdown",
        mimeType: "text/markdown",
        bytes: contentBytes,
        sha256,
        createdAt
      }, null, 2)}\n`);
      if (candidate.kind === "project") addGitExclude(root);
      return artifactResult({ candidate, directory, filename, contentBytes, sha256, contentType, sessionId });
    } catch (error) {
      failure = error;
    }
  }
  throw Object.assign(new Error(`无法写入 Handoff 文件：${failure?.message || failure}`), { status: 500, code: "HANDOFF_ARTIFACT_WRITE_FAILED" });
}

function directoryBytes(directory) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try { total += fs.statSync(path.join(directory, entry.name)).size; } catch {}
    }
  } catch {}
  return total;
}

function storeEntries(root) {
  return listArtifactDirectories(root).map((directory) => {
    const metadata = readMetadata(directory)?.metadata || {};
    let createdAt = Date.parse(metadata.createdAt || "");
    if (!Number.isFinite(createdAt)) {
      try { createdAt = fs.statSync(directory).mtimeMs; } catch { createdAt = 0; }
    }
    return { directory, createdAt, bytes: directoryBytes(directory) };
  });
}

export function cleanupHandoffArtifacts({ now = Date.now(), retentionMs = HANDOFF_RETENTION_MS, maxBytes = HANDOFF_MAX_BYTES } = {}) {
  ensureBridgeHome();
  const entries = storeEntries(HANDOFF_ARTIFACT_ROOT).sort((a, b) => a.createdAt - b.createdAt);
  let total = entries.reduce((sum, item) => sum + item.bytes, 0);
  let removed = 0;
  let removedBytes = 0;
  for (const item of entries) {
    if (item.createdAt > 0 && now - item.createdAt <= retentionMs && total <= maxBytes) continue;
    try {
      fs.rmSync(item.directory, { recursive: true, force: true });
      total -= item.bytes;
      removed += 1;
      removedBytes += item.bytes;
    } catch {}
  }
  return { removed, removedBytes, bytes: Math.max(0, total), maxBytes, retentionMs };
}
