import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CODEX_BUNDLE_ID = "com.openai.codex";

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 8000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    env: options.env || process.env
  }).trim();
}

function bundleId(appPath) {
  try {
    return execText("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")], { timeout: 2500 });
  } catch {
    return "";
  }
}

export function findCodexDesktopApp() {
  if (process.platform !== "darwin") return null;
  const home = os.homedir();
  const candidates = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    path.join(home, "Applications/ChatGPT.app"),
    path.join(home, "Applications/Codex.app")
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

function threadUrl(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("缺少 Codex 会话 ID");
  return `codex://threads/${encodeURIComponent(id)}`;
}

function newThreadUrl(projectPath) {
  const project = String(projectPath || "").trim();
  if (!project) throw new Error("缺少 Codex 项目路径");
  const query = new URLSearchParams({ path: project }).toString();
  return `codex://threads/new?${query}`;
}

function openDesktopUrl(url) {
  const app = findCodexDesktopApp();
  if (!app) throw new Error("没有找到 OpenAI Codex Desktop（bundle id: com.openai.codex）。当前不会回退到 Terminal/CLI。");
  execText("/usr/bin/open", ["-a", app.appPath, url], { timeout: 8000 });
  return app;
}

function clipboardText() {
  try { return execText("/usr/bin/pbpaste", [], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }); } catch { return null; }
}

function setClipboardText(text) {
  const result = spawnSync("/usr/bin/pbcopy", [], {
    input: String(text),
    encoding: "utf8",
    timeout: 2500,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error("无法写入 macOS 剪贴板用于 Codex Desktop 注入");
}

function injectClipboardIntoDesktop(prompt, app, { waitMs = 900 } = {}) {
  const bridgeHome = process.env.SOL_CODEX_BRIDGE_HOME || path.join(os.homedir(), ".sol-codex-bridge");
  const injectorApp = path.join(bridgeHome, "Sol Codex Bridge.app");
  if (!fs.existsSync(injectorApp)) throw new Error("Bridge 辅助应用未安装；请重新运行 install-bridge.command。");
  const previous = clipboardText();
  setClipboardText(prompt);
  try {
    execText("/usr/bin/open", ["-W", injectorApp], { timeout: Math.max(10000, waitMs + 9000) });
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim() || error?.stdout?.toString?.().trim() || error?.message || String(error);
    const e = new Error(
      detail.includes("CODEX_COMPOSER_NOT_FOUND") ? "已打开 Codex Desktop，但没有找到可编辑的输入框；没有发送任何内容。" :
      detail.includes("CODEX_PROCESS_NOT_FOUND") ? "Codex Desktop 没有成功启动。" :
      "需要在 系统设置 → 隐私与安全性 → 辅助功能 中允许“Sol Codex Bridge”，然后重试。"
    );
    e.code = "DESKTOP_UI_INJECTION_FAILED";
    throw e;
  } finally {
    if (previous !== null) {
      setTimeout(() => {
        try { setClipboardText(previous); } catch {}
      }, 350);
    }
  }
}

export function sendToExistingDesktopThread(sessionId, prompt) {
  const app = openDesktopUrl(threadUrl(sessionId));
  injectClipboardIntoDesktop(prompt, app, { waitMs: 1000 });
  return { ok: true, transport: "desktop-ui", appPath: app.appPath, sessionId: String(sessionId) };
}

export function sendToNewDesktopThread(projectPath, prompt) {
  const app = openDesktopUrl(newThreadUrl(projectPath));
  injectClipboardIntoDesktop(prompt, app, { waitMs: 1200 });
  return { ok: true, transport: "desktop-ui", appPath: app.appPath };
}

export function openDesktopThread(sessionId) {
  const app = openDesktopUrl(threadUrl(sessionId));
  return { ok: true, appPath: app.appPath, sessionId: String(sessionId) };
}

export function openDesktopProject(projectPath) {
  const app = openDesktopUrl(newThreadUrl(projectPath));
  return { ok: true, appPath: app.appPath };
}
