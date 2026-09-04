import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertContextReadable,
  assertReadableFile,
  isBlockedRelativePath,
  walkReadableFiles
} from "./workspace-guard.mjs";

const GIT_TTL_MS = 1_000;
const SEARCH_TTL_MS = 5_000;
const MAX_DIFF_BYTES = 300_000;
const DEFAULT_DIFF_BYTES = 120_000;
const gitCache = new Map();
const searchCache = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function gitText(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function decodePorcelainPath(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch {}
  }
  const renamed = text.lastIndexOf(" -> ");
  return renamed === -1 ? text : text.slice(renamed + 4);
}

function parseStatus(output) {
  const lines = String(output || "").split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## ")) || "";
  let branch = branchLine.slice(3).trim() || null;
  if (branch?.startsWith("No commits yet on ")) branch = branch.slice("No commits yet on ".length).trim();
  if (branch?.startsWith("Initial commit on ")) branch = branch.slice("Initial commit on ".length).trim();
  const changedFiles = [];
  const stagedFiles = [];
  for (const line of lines) {
    if (line.startsWith("## ") || line.length < 4) continue;
    const code = line.slice(0, 2);
    const file = decodePorcelainPath(line.slice(3));
    if (!file || isBlockedRelativePath(file)) continue;
    if (!changedFiles.includes(file)) changedFiles.push(file);
    if (code[0] && code[0] !== "?") stagedFiles.push(file);
  }
  return { branch, changedFiles, stagedFiles };
}

export function getGitStatus(projectPath) {
  const root = assertContextReadable(projectPath);
  const cached = gitCache.get(root);
  if (cached && Date.now() - cached.at < GIT_TTL_MS && cached.status) return clone(cached.status);
  try {
    const status = parseStatus(gitText(root, ["status", "--porcelain=v1", "--branch"]));
    const result = { isGitRepo: true, ...status };
    gitCache.set(root, { ...(cached || {}), at: Date.now(), status: result });
    return clone(result);
  } catch {
    const result = { isGitRepo: false };
    gitCache.set(root, { ...(cached || {}), at: Date.now(), status: result });
    return result;
  }
}

function diffPath(block) {
  const header = String(block).match(/^diff --git a\/(.+) b\/(.+)$/m);
  if (!header) return null;
  return [header[1], header[2]];
}

function filterDiff(value) {
  const blocks = String(value || "").split(/(?=^diff --git )/m);
  return blocks.filter((block) => {
    if (!block.startsWith("diff --git ")) return false;
    const paths = diffPath(block);
    return paths && paths.every((item) => !isBlockedRelativePath(item));
  }).join("");
}

export function getGitDiff(projectPath, { maxBytes = DEFAULT_DIFF_BYTES } = {}) {
  const root = assertContextReadable(projectPath);
  const cached = gitCache.get(root);
  if (cached && Date.now() - cached.at < GIT_TTL_MS && cached.diff) return clone(cached.diff);
  const status = getGitStatus(root);
  if (!status.isGitRepo) return status;
  const limit = Math.min(Math.max(1, Number(maxBytes) || DEFAULT_DIFF_BYTES), MAX_DIFF_BYTES);
  try {
    const working = truncateUtf8(filterDiff(gitText(root, ["diff", "--no-ext-diff", "--no-color"])), limit);
    const staged = truncateUtf8(filterDiff(gitText(root, ["diff", "--cached", "--no-ext-diff", "--no-color"])), limit);
    const result = {
      isGitRepo: true,
      branch: status.branch,
      changedFiles: status.changedFiles,
      stagedFiles: status.stagedFiles,
      diff: working.text,
      stagedDiff: staged.text,
      truncated: working.truncated || staged.truncated
    };
    gitCache.set(root, { at: Date.now(), status, diff: result });
    return clone(result);
  } catch {
    return {
      isGitRepo: true,
      branch: status.branch,
      changedFiles: status.changedFiles,
      stagedFiles: status.stagedFiles,
      diff: "",
      stagedDiff: "",
      truncated: true
    };
  }
}

export function readProjectFile({ projectPath, relativePath, startLine = 1, endLine = null } = {}) {
  const file = assertReadableFile(projectPath, relativePath);
  const start = Number.isInteger(Number(startLine)) && Number(startLine) > 0 ? Number(startLine) : 1;
  const requestedEnd = endLine == null || endLine === "" ? start + 299 : Number(endLine);
  if (!Number.isInteger(requestedEnd) || requestedEnd < start) throw Object.assign(new Error("行号范围无效"), { status: 400, code: "LINE_RANGE_INVALID" });
  if (requestedEnd - start + 1 > 1_000) throw Object.assign(new Error("最多读取 1000 行"), { status: 400, code: "LINE_RANGE_TOO_LARGE" });
  const raw = fs.readFileSync(file.target, "utf8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "" && raw.endsWith("\n")) lines.pop();
  const end = Math.min(requestedEnd, lines.length);
  return {
    relativePath: file.relativePath,
    startLine: start,
    endLine: end < start ? start : end,
    totalLines: lines.length,
    content: end < start ? "" : lines.slice(start - 1, end).join("\n"),
    truncated: end < lines.length
  };
}

function likelyText(relativePath) {
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|woff2?|ttf|dylib|so|bin)$/i.test(relativePath);
}

export function searchProject({ projectPath, query, maxResults = 50 } = {}) {
  const root = assertContextReadable(projectPath);
  const needle = String(query || "");
  if (!needle.trim()) throw Object.assign(new Error("搜索内容不能为空"), { status: 400, code: "SEARCH_QUERY_EMPTY" });
  if (needle.length > 200) throw Object.assign(new Error("搜索内容最多 200 个字符"), { status: 400, code: "SEARCH_QUERY_TOO_LONG" });
  const limit = Number.isFinite(Number(maxResults)) ? Math.min(Math.max(1, Math.floor(Number(maxResults))), 200) : 50;
  const key = `${root}\0${needle}\0${limit}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return clone(cached.value);
  const walked = walkReadableFiles(root, 5_000);
  const candidates = walked.files.sort((a, b) => Number(likelyText(b.relativePath)) - Number(likelyText(a.relativePath)));
  const results = [];
  const lowerNeedle = needle.toLocaleLowerCase();
  for (const file of candidates) {
    if (results.length >= limit) break;
    if (!likelyText(file.relativePath)) continue;
    let readable;
    try { readable = assertReadableFile(root, file.relativePath); } catch { continue; }
    let content;
    try { content = fs.readFileSync(readable.target, "utf8"); } catch { continue; }
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length && results.length < limit; index += 1) {
      const line = lines[index];
      const column = line.toLocaleLowerCase().indexOf(lowerNeedle);
      if (column === -1) continue;
      results.push({ path: file.relativePath, line: index + 1, column: column + 1, preview: line.trim().slice(0, 240) });
    }
  }
  searchCache.set(key, { at: Date.now(), value: results });
  return clone(results);
}

export const CONTEXT_LIMITS = { defaultDiffBytes: DEFAULT_DIFF_BYTES, maxDiffBytes: MAX_DIFF_BYTES };
