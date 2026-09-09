import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";

const CODEX_BUNDLE_ID = "com.openai.codex";

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 8000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env || process.env
  }).trim();
}

export function isExecutable(file) {
  if (!file) return false;
  try {
    fs.accessSync(file, fsConstants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function bundleId(appPath) {
  try {
    return execText("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")], { timeout: 2500 });
  } catch {
    return "";
  }
}

export function findCodexDesktop() {
  const home = os.homedir();
  const candidates = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    path.join(home, "Applications", "ChatGPT.app"),
    path.join(home, "Applications", "Codex.app")
  ];
  let compatibleFallback = null;
  for (const appPath of candidates) {
    try {
      if (!fs.statSync(appPath).isDirectory()) continue;
      const id = bundleId(appPath);
      if (id === CODEX_BUNDLE_ID) {
        return { appPath, bundleId: id, appName: path.basename(appPath, ".app"), canonical: true };
      }
      const embeddedCodex = fs.existsSync(path.join(appPath, "Contents/Resources/codex"));
      if (!compatibleFallback && embeddedCodex && /^com\.openai\./.test(id)) {
        compatibleFallback = { appPath, bundleId: id, appName: path.basename(appPath, ".app"), canonical: false };
      }
    } catch {}
  }
  return compatibleFallback;
}

function interactiveShellCodex() {
  const shell = process.env.SHELL || "/bin/zsh";
  if (!isExecutable(shell)) return null;
  try {
    const result = execText(shell, ["-lic", "command -v codex 2>/dev/null || true"], {
      timeout: 2500,
      env: {
        ...process.env,
        PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      }
    });
    return isExecutable(result) ? result : null;
  } catch {
    return null;
  }
}

export function findCodexCli({ savedBin = null, extraBins = [] } = {}) {
  const raw = [];
  const push = (bin, source) => {
    if (isExecutable(bin)) raw.push({ bin, source });
  };

  push(process.env.CODEX_BIN, "CODEX_BIN");
  push(savedBin, "saved");
  for (const bin of extraBins) push(bin, "extra");

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

export function execCodex(bin, args, options = {}) {
  return execText(bin, args, options);
}

export function spawnCodex(bin, args, options = {}) {
  return spawn(bin, args, options);
}

export function openCodex(url) {
  const app = findCodexDesktop();
  if (!app) {
    const error = new Error("没有找到 OpenAI Codex Desktop（bundle id: com.openai.codex）");
    error.code = "CODEX_DESKTOP_NOT_FOUND";
    throw error;
  }
  try {
    execText("/usr/bin/open", ["-a", app.appPath, url], { timeout: 8000 });
    return app;
  } catch (error) {
    error.code = "DESKTOP_OPEN_FAILED";
    throw error;
  }
}

function threadUrl(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("缺少 Codex 会话 ID");
  return `codex://threads/${encodeURIComponent(id)}`;
}

function newThreadUrl(projectPath) {
  const project = String(projectPath || "").trim();
  if (!project) throw new Error("缺少 Codex 项目路径");
  return `codex://threads/new?${new URLSearchParams({ path: project })}`;
}

export function openThread(sessionId) {
  const app = openCodex(threadUrl(sessionId));
  return { ok: true, appPath: app.appPath, sessionId: String(sessionId) };
}

export function openProject(projectPath) {
  const app = openCodex(newThreadUrl(projectPath));
  return { ok: true, appPath: app.appPath };
}

export function copyText(text) {
  const result = spawnSync("/usr/bin/pbcopy", [], {
    input: String(text),
    encoding: "utf8",
    timeout: 2500,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error("无法写入 macOS 剪贴板");
  return true;
}

function clipboardText() {
  try { return execText("/usr/bin/pbpaste", [], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }); } catch { return null; }
}

function injectClipboardIntoDesktop(prompt, { waitMs = 900 } = {}) {
  const bridgeHome = process.env.SOL_CODEX_BRIDGE_HOME || path.join(os.homedir(), ".sol-codex-bridge");
  const injectorApp = path.join(bridgeHome, "Sol Codex Bridge.app");
  if (!fs.existsSync(injectorApp)) throw new Error("Bridge 辅助应用未安装；请重新运行 macOS/install-bridge.command。");
  const previous = clipboardText();
  copyText(prompt);
  try {
    execText("/usr/bin/open", ["-W", injectorApp], { timeout: Math.max(10000, waitMs + 9000) });
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim() || error?.stdout?.toString?.().trim() || error?.message || String(error);
    const wrapped = new Error(
      detail.includes("CODEX_COMPOSER_NOT_FOUND") ? "已打开 Codex Desktop，但没有找到可编辑的输入框；没有发送任何内容。" :
      detail.includes("CODEX_PROCESS_NOT_FOUND") ? "Codex Desktop 没有成功启动。" :
      "需要在 系统设置 → 隐私与安全性 → 辅助功能 中允许“Sol Codex Bridge”，然后重试。"
    );
    wrapped.code = "DESKTOP_UI_INJECTION_FAILED";
    throw wrapped;
  } finally {
    if (previous !== null) setTimeout(() => { try { copyText(previous); } catch {} }, 350);
  }
}

export function sendToExistingDesktopThread(sessionId, prompt) {
  const opened = openCodex(threadUrl(sessionId));
  injectClipboardIntoDesktop(prompt, { waitMs: 1000 });
  return { ok: true, transport: "desktop-ui", appPath: opened.appPath, sessionId: String(sessionId) };
}

export function sendToNewDesktopThread(projectPath, prompt) {
  const opened = openCodex(newThreadUrl(projectPath));
  injectClipboardIntoDesktop(prompt, { waitMs: 1200 });
  return { ok: true, transport: "desktop-ui", appPath: opened.appPath };
}

export function startBridge() { return { ok: true }; }
export function stopBridge() { return { ok: true }; }

export function stateDbCandidates({ codexHome, sqliteHome } = {}) {
  const home = os.homedir();
  return [
    path.join(sqliteHome || codexHome || path.join(home, ".codex"), "state_5.sqlite"),
    path.join(codexHome || path.join(home, ".codex"), "state_5.sqlite"),
    path.join(home, "Library", "Application Support", "Codex", "state_5.sqlite"),
    path.join(home, "Library", "Application Support", "OpenAI", "Codex", "state_5.sqlite")
  ];
}

export function findOpenFiles(files) {
  const unique = [...new Set(files.filter((file) => file && fs.existsSync(file)))].slice(0, 500);
  if (!unique.length) return new Set();
  const child = spawnSync("lsof", ["-Fn", "--", ...unique], {
    encoding: "utf8",
    timeout: 1800,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const opened = new Set();
  for (const line of String(child.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("n") && line.length > 1) opened.add(line.slice(1));
  }
  return opened;
}
