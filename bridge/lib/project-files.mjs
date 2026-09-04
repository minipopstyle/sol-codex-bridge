import fs from "node:fs";
import path from "node:path";
import { assertContextReadable, isSubpath } from "./workspace-guard.mjs";

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ignoredDirectoryNames = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".cache", ".vite", ".turbo", "vendor", ".ssh"
]);
const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".tgz", ".dmg", ".sqlite", ".db",
  ".mp3", ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".otf", ".dylib", ".so", ".bin"
]);
const imageMimes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

function fileError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function relativePathFor(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function isIgnoredDirectory(relativePath) {
  return String(relativePath || "").split("/").some((part) => ignoredDirectoryNames.has(part));
}

export function isSensitiveFile(relativePath) {
  const name = path.posix.basename(String(relativePath || "").replaceAll("\\", "/"));
  return name === ".env" || name.startsWith(".env.") || name === ".npmrc" || name === ".pypirc"
    || /\.(?:pem|key)$/i.test(name)
    || name === "id_rsa" || name === "id_ed25519"
    || name === "credentials.json" || /^service-account.*\.json$/i.test(name);
}

export function isBinaryFile(relativePath, sample = null) {
  const extension = path.posix.extname(String(relativePath || "")).toLocaleLowerCase();
  return binaryExtensions.has(extension) || Boolean(sample?.includes?.(0));
}

function imageMime(relativePath) {
  return imageMimes.get(path.posix.extname(String(relativePath || "")).toLocaleLowerCase()) || "";
}

function readSample(target) {
  let descriptor;
  try {
    descriptor = fs.openSync(target, "r");
    const sample = Buffer.alloc(16);
    const length = fs.readSync(descriptor, sample, 0, sample.length, 0);
    return sample.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function imageInfo(relativePath, sample) {
  const mime = imageMime(relativePath);
  if (!mime || !sample) return null;
  const valid = mime === "image/png"
    ? sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg"
      ? sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff
      : mime === "image/gif"
        ? sample.subarray(0, 6).toString("ascii") === "GIF87a" || sample.subarray(0, 6).toString("ascii") === "GIF89a"
        : sample.subarray(0, 4).toString("ascii") === "RIFF" && sample.subarray(8, 12).toString("ascii") === "WEBP";
  return { mime, valid };
}

function resolveExisting(projectPath, relativePath, { allowRoot = false } = {}) {
  const root = assertContextReadable(projectPath);
  const value = String(relativePath ?? "").trim();
  if (!allowRoot && !value) throw fileError("必须指定项目相对路径", 400, "RELATIVE_PATH_REQUIRED");
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw fileError("只允许读取项目相对路径", 400, "RELATIVE_PATH_REQUIRED");
  }
  const candidate = path.resolve(root, value.replaceAll("\\", path.sep));
  if (!isSubpath(root, candidate)) throw fileError("读取路径超出项目目录", 403, "PATH_TRAVERSAL_BLOCKED");
  let target;
  try { target = fs.realpathSync(candidate); } catch { throw fileError("项目文件或目录不存在", 404, "PATH_NOT_FOUND"); }
  if (!isSubpath(root, target)) throw fileError("读取路径超出项目目录", 403, "PATH_TRAVERSAL_BLOCKED");
  const relative = relativePathFor(root, target);
  if (isIgnoredDirectory(relative)) throw fileError("该目录默认不提供浏览", 403, "IGNORED_DIRECTORY");
  return { root, target, relativePath: relative };
}

function metadata(root, target, relativePath, stat, extra = {}) {
  return {
    name: path.basename(target),
    path: relativePath,
    relativePath,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    ...extra
  };
}

function entryMetadata(root, directory, entry) {
  const fullPath = path.join(directory, entry.name);
  const relativePath = relativePathFor(root, fullPath);
  if (!entry.isSymbolicLink() && entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) return null;

  let target = fullPath;
  let stat;
  let symlink = false;
  if (entry.isSymbolicLink()) {
    symlink = true;
    try { target = fs.realpathSync(fullPath); } catch { return { name: entry.name, path: relativePath, type: "symlink", blocked: true }; }
    if (!isSubpath(root, target) || isIgnoredDirectory(relativePathFor(root, target))) {
      return { name: entry.name, path: relativePath, type: "symlink", symlink: true, blocked: true };
    }
  }
  try { stat = fs.statSync(target); } catch { return null; }
  if (!stat.isDirectory() && !stat.isFile()) return null;
  const type = stat.isDirectory() ? "directory" : "file";
  const image = type === "file" ? imageInfo(relativePath, readSample(target)) : null;
  const kind = type === "directory" ? "directory" : image?.valid ? "image" : isBinaryFile(relativePath) ? "binary" : "text";
  return metadata(root, fullPath, relativePath, stat, {
    type,
    kind,
    symlink,
    sensitive: type === "file" && isSensitiveFile(relativePath),
    binary: kind === "binary"
  });
}

export function listProjectDirectory(projectPath, relativePath = "") {
  const resolved = resolveExisting(projectPath, relativePath, { allowRoot: true });
  let stat;
  try { stat = fs.statSync(resolved.target); } catch { throw fileError("项目目录不存在", 404, "DIRECTORY_NOT_FOUND"); }
  if (!stat.isDirectory()) throw fileError("目标不是目录", 400, "DIRECTORY_REQUIRED");
  let entries;
  try { entries = fs.readdirSync(resolved.target, { withFileTypes: true }); }
  catch { throw fileError("无法读取项目目录", 403, "DIRECTORY_READ_DENIED"); }
  const result = entries.map((entry) => entryMetadata(resolved.root, resolved.target, entry)).filter(Boolean);
  result.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { ok: true, project: resolved.root, path: resolved.relativePath, entries: result };
}

export function readProjectFile(projectPath, relativePath = "") {
  const resolved = resolveExisting(projectPath, relativePath);
  let stat;
  try { stat = fs.statSync(resolved.target); } catch { throw fileError("项目文件不存在", 404, "FILE_NOT_FOUND"); }
  if (!stat.isFile()) throw fileError("只允许读取文件", 400, "FILE_REQUIRED");
  const base = metadata(resolved.root, resolved.target, resolved.relativePath, stat);
  const image = imageInfo(resolved.relativePath, readSample(resolved.target));
  if (isSensitiveFile(resolved.relativePath)) {
    return { ok: true, ...base, kind: image?.valid ? "image" : "binary", mime: image?.mime || null, blocked: true, reason: "sensitive-file" };
  }
  if (image?.mime) {
    if (!image.valid) return { ok: true, ...base, kind: "binary", binary: true, unsupportedImage: true, mime: image.mime };
    if (stat.size > MAX_IMAGE_BYTES) return { ok: true, ...base, kind: "image", mime: image.mime, tooLarge: true, maxBytes: MAX_IMAGE_BYTES };
    return { ok: true, ...base, kind: "image", mime: image.mime, tooLarge: false };
  }
  if (stat.size > MAX_TEXT_BYTES) return { ok: true, ...base, kind: "text", tooLarge: true, maxBytes: MAX_TEXT_BYTES };
  let content;
  try { content = fs.readFileSync(resolved.target); } catch { throw fileError("无法读取项目文件", 403, "FILE_READ_DENIED"); }
  if (isBinaryFile(resolved.relativePath, content)) return { ok: true, ...base, kind: "binary", binary: true };
  return { ok: true, ...base, kind: "text", mime: "text/plain", content: content.toString("utf8"), truncated: false };
}

export function readProjectFileData(projectPath, relativePath = "") {
  const resolved = resolveExisting(projectPath, relativePath);
  let stat;
  try { stat = fs.statSync(resolved.target); } catch { throw fileError("项目文件不存在", 404, "FILE_NOT_FOUND"); }
  if (!stat.isFile()) throw fileError("只允许读取文件", 400, "FILE_REQUIRED");
  const base = metadata(resolved.root, resolved.target, resolved.relativePath, stat);
  const image = imageInfo(resolved.relativePath, readSample(resolved.target));
  if (isSensitiveFile(resolved.relativePath)) return { ok: true, ...base, kind: image?.valid ? "image" : "binary", mime: image?.mime || null, blocked: true, reason: "sensitive-file" };
  if (!image?.mime || !image.valid) return { ok: true, ...base, kind: "binary", binary: true, unsupportedImage: Boolean(image?.mime), mime: image?.mime || null };
  if (stat.size > MAX_IMAGE_BYTES) return { ok: true, ...base, kind: "image", mime: image.mime, tooLarge: true, maxBytes: MAX_IMAGE_BYTES };
  let content;
  try { content = fs.readFileSync(resolved.target); } catch { throw fileError("无法读取图片文件", 403, "FILE_READ_DENIED"); }
  return { ok: true, ...base, kind: "image", mime: image.mime, tooLarge: false, base64: content.toString("base64") };
}
