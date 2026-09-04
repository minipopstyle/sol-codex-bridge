import fs from "node:fs";
import path from "node:path";
import { isKnownProject, normalizeProjectPath } from "./codex-state.mjs";
import { loadConfig, saveConfig } from "./config.mjs";

export const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;
export const ABSOLUTE_MAX_FILE_BYTES = 4 * 1024 * 1024;

const blockedDirectoryNames = new Set([
  ".git", "node_modules", ".ssh", "dist", "build", ".next", "coverage", ".cache"
]);

function guardError(message, status = 403, code = "CONTEXT_READ_BLOCKED") {
  return Object.assign(new Error(message), { status, code });
}

function realpathOrThrow(value) {
  try { return fs.realpathSync(value); } catch { throw guardError("项目目录不存在", 400, "PROJECT_NOT_FOUND"); }
}

export function normalizeRoot(value) {
  const input = String(value || "").trim();
  if (!input || !path.isAbsolute(input)) throw guardError("项目路径必须是绝对路径", 400, "PROJECT_PATH_INVALID");
  const root = realpathOrThrow(input);
  if (!fs.statSync(root).isDirectory()) throw guardError("项目路径不是目录", 400, "PROJECT_NOT_DIRECTORY");
  return root;
}

export function isSubpath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relativePathFor(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

export function isBlockedRelativePath(relativePath) {
  const value = String(relativePath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = value.split("/").filter(Boolean);
  const name = segments.at(-1) || "";
  if (segments.some((segment) => blockedDirectoryNames.has(segment))) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (/\.(?:pem|key)$/i.test(name)) return true;
  if (name === "id_rsa" || name === "id_ed25519") return true;
  if (name === "credentials.json" || /^service-account.*\.json$/i.test(name)) return true;
  return false;
}

export function resolveReadPath(projectPath, relativePath) {
  const root = assertContextReadable(projectPath);
  const value = String(relativePath || "").trim();
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw guardError("只允许读取项目相对路径", 400, "RELATIVE_PATH_REQUIRED");
  }
  const candidate = path.resolve(root, value.replaceAll("\\", path.sep));
  const target = realpathOrThrow(candidate);
  if (!isSubpath(root, target)) throw guardError("读取路径超出项目目录", 403, "PATH_TRAVERSAL_BLOCKED");
  const relative = relativePathFor(root, target);
  if (isBlockedRelativePath(relative)) throw guardError("该路径属于受保护文件或目录", 403, "BLOCKED_PATH");
  return { root, target, relativePath: relative };
}

export function assertReadableFile(projectPath, relativePath, { maxBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0 || limit > ABSOLUTE_MAX_FILE_BYTES) {
    throw guardError("文件读取大小限制无效", 400, "FILE_LIMIT_INVALID");
  }
  const resolved = resolveReadPath(projectPath, relativePath);
  let stat;
  try { stat = fs.statSync(resolved.target); } catch { throw guardError("文件不存在", 404, "FILE_NOT_FOUND"); }
  if (!stat.isFile()) throw guardError("只允许读取文件", 400, "FILE_REQUIRED");
  if (stat.size > limit) throw guardError(`文件超过 ${Math.round(limit / 1024 / 1024)} MB 读取限制`, 413, "FILE_TOO_LARGE");
  const fd = fs.openSync(resolved.target, "r");
  const sample = Buffer.alloc(Math.min(4096, stat.size));
  try { fs.readSync(fd, sample, 0, sample.length, 0); } finally { fs.closeSync(fd); }
  if (sample.includes(0)) throw guardError("不允许读取二进制文件", 415, "BINARY_FILE");
  return { ...resolved, stat };
}

export function assertKnownProject(projectPath) {
  const root = normalizeRoot(projectPath);
  if (!isKnownProject(root)) throw guardError("当前项目尚未被 Bridge 识别", 403, "PROJECT_NOT_RECOGNIZED");
  return root;
}

export function isReadAllowed(projectPath) {
  let root;
  try { root = normalizeRoot(projectPath); } catch { return false; }
  return loadConfig().readAllowedProjects.some((item) => {
    try { return normalizeRoot(item) === root; } catch { return false; }
  });
}

export function assertContextReadable(projectPath) {
  const root = assertKnownProject(projectPath);
  if (!isReadAllowed(root)) throw guardError("当前项目未授权 Context 读取", 403, "PROJECT_PERMISSION_REQUIRED");
  return root;
}

export function setReadPermission(projectPath, allowed) {
  const root = assertKnownProject(projectPath);
  const config = loadConfig();
  const current = new Set(config.readAllowedProjects.map((item) => {
    try { return normalizeRoot(item); } catch { return ""; }
  }).filter(Boolean));
  if (allowed) current.add(root);
  else current.delete(root);
  const saved = saveConfig({ ...config, readAllowedProjects: [...current] });
  return { projectPath: root, allowed: saved.readAllowedProjects.includes(root) };
}

export function readPermission(projectPath) {
  let root = "";
  try { root = normalizeRoot(projectPath); } catch {}
  return { projectPath: root || String(projectPath || ""), allowed: root ? isReadAllowed(root) : false };
}

export function walkReadableFiles(projectPath, maxFiles = 5000) {
  const root = assertContextReadable(projectPath);
  const files = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      const relative = relativePathFor(root, full);
      if (isBlockedRelativePath(relative)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push({ full, relativePath: relative });
    }
  }
  return { root, files, truncated: stack.length > 0 };
}
