import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || 8000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env || process.env,
    windowsHide: true
  }).trim();
}

export function isExecutable(file) {
  try { return Boolean(file) && fs.statSync(file).isFile(); } catch { return false; }
}

function commandCandidates(command) {
  try {
    return execText("where.exe", [command], { timeout: 2500 })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function findCodexCli({ savedBin = null, extraBins = [] } = {}) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const raw = [];
  const push = (bin, source) => {
    if (isExecutable(bin)) raw.push({ bin, source });
  };

  push(process.env.CODEX_BIN, "CODEX_BIN");
  push(savedBin, "saved");
  for (const bin of extraBins) push(bin, "extra");
  for (const bin of commandCandidates("codex")) push(bin, "PATH");
  for (const bin of [
    path.join(appData, "npm", "codex.cmd"),
    path.join(home, ".npm-global", "codex.cmd"),
    path.join(home, ".npm-global", "bin", "codex.cmd"),
    path.join(home, ".local", "bin", "codex.exe"),
    path.join(home, ".local", "bin", "codex.cmd"),
    path.join(home, ".local", "bin", "codex"),
    path.join(home, "bin", "codex.exe"),
    path.join(home, "bin", "codex.cmd")
  ]) push(bin, "common-path");
  for (const command of ["codex.exe", "codex.cmd", "codex"]) {
    for (const bin of commandCandidates(command)) push(bin, "PATH");
  }

  const deduped = [];
  const seen = new Set();
  for (const item of raw) {
    const key = path.normalize(item.bin).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function isCmdFile(bin) {
  return /\.(cmd|bat)$/i.test(String(bin));
}

function powershellEncodedCommand(bin, args) {
  const payload = Buffer.from(JSON.stringify({ bin: String(bin), args: args.map(String) }), "utf8").toString("base64");
  const script = "$ErrorActionPreference='Stop';$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "'));$job=$json|ConvertFrom-Json;$command=[string]$job.bin;& $command @($job.args);exit $LASTEXITCODE";
  return Buffer.from(script, "utf16le").toString("base64");
}

export function execCodex(bin, args, options = {}) {
  if (!isCmdFile(bin)) return execText(bin, args, options);
  return execText("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncodedCommand(bin, args)], options);
}

export function spawnCodex(bin, args, options = {}) {
  if (!isCmdFile(bin)) return spawn(bin, args, { ...options, windowsHide: true });
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncodedCommand(bin, args)], { ...options, windowsHide: true });
}

function existingFile(paths) {
  return paths.find((file) => isExecutable(file)) || null;
}

function appxInstallLocations() {
  try {
    return execText("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-AppxPackage | Where-Object { $_.Name -match 'OpenAI|Codex|ChatGPT' } | Select-Object -ExpandProperty InstallLocation"
    ], { timeout: 5000 }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function findCodexDesktop() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [
    path.join(localAppData, "Programs", "OpenAI", "Codex", "Codex.exe"),
    path.join(localAppData, "Programs", "Codex", "Codex.exe"),
    path.join(localAppData, "Programs", "OpenAI", "ChatGPT", "ChatGPT.exe"),
    path.join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
    path.join(localAppData, "OpenAI", "Codex", "Codex.exe"),
    path.join(programFiles, "OpenAI", "Codex", "Codex.exe"),
    path.join(programFiles, "OpenAI", "ChatGPT", "ChatGPT.exe"),
    path.join(programFiles, "ChatGPT", "ChatGPT.exe"),
    path.join(localAppData, "Microsoft", "WindowsApps", "ChatGPT.exe"),
    path.join(localAppData, "Microsoft", "WindowsApps", "Codex.exe")
  ];
  for (const location of appxInstallLocations()) {
    candidates.push(path.join(location, "Codex.exe"), path.join(location, "ChatGPT.exe"));
  }
  const found = existingFile(candidates);
  if (found) return { appPath: found, appName: path.basename(found, ".exe"), canonical: true };

  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const startMenu = [
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Codex.lnk"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "ChatGPT.lnk"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI", "Codex.lnk"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI", "ChatGPT.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "Codex.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "ChatGPT.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI", "Codex.lnk"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "OpenAI", "ChatGPT.lnk")
  ];
  const shortcut = startMenu.find((file) => fs.existsSync(file));
  return shortcut ? { appPath: shortcut, appName: path.basename(shortcut, ".lnk"), canonical: false } : null;
}

export function openCodex(url) {
  try {
    execText("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& { param([string]$target) Start-Process -FilePath $target }",
      String(url)
    ], { timeout: 8000 });
    return { ok: true, url: String(url) };
  } catch (error) {
    const wrapped = new Error(error?.stderr?.toString?.().trim() || "Codex Desktop 深链协议不可用");
    wrapped.code = "CODEX_PROTOCOL_NOT_AVAILABLE";
    throw wrapped;
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
  return { ...openCodex(threadUrl(sessionId)), sessionId: String(sessionId) };
}

export function openProject(projectPath) {
  return openCodex(newThreadUrl(projectPath));
}

export function copyText(text) {
  execFileSync("clip.exe", [], { input: String(text), encoding: "utf8", timeout: 2500, windowsHide: true });
  return true;
}

let loggingConfigured = false;

export function startBridge() {
  if (loggingConfigured) return { ok: true };
  const bridgeHome = process.env.SOL_CODEX_BRIDGE_HOME || path.join(os.homedir(), ".sol-codex-bridge");
  fs.mkdirSync(bridgeHome, { recursive: true });
  const append = (file, values) => {
    try { fs.appendFileSync(path.join(bridgeHome, file), `${values.map(String).join(" ")}\n`); } catch {}
  };
  const stdout = console.log.bind(console);
  const stderr = console.error.bind(console);
  console.log = (...values) => { append("bridge.log", values); stdout(...values); };
  console.error = (...values) => { append("bridge.error.log", values); stderr(...values); };
  loggingConfigured = true;
  return { ok: true };
}

export function stopBridge() { return { ok: true }; }

export function stateDbCandidates({ codexHome, sqliteHome } = {}) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return [
    path.join(sqliteHome || codexHome || path.join(home, ".codex"), "state_5.sqlite"),
    path.join(codexHome || path.join(home, ".codex"), "state_5.sqlite"),
    path.join(appData, "Codex", "state_5.sqlite"),
    path.join(localAppData, "Codex", "state_5.sqlite")
  ];
}

export function findOpenFiles() {
  return new Set();
}
