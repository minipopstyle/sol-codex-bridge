import * as macos from "./macos.mjs";
import * as windows from "./windows.mjs";

const unsupported = {
  findCodexCli: () => [],
  findCodexDesktop: () => null,
  openCodex: () => {
    const error = new Error(`当前平台不受支持：${process.platform}`);
    error.code = "UNSUPPORTED_PLATFORM";
    throw error;
  },
  openThread: () => unsupported.openCodex(),
  openProject: () => unsupported.openCodex(),
  copyText: () => {
    const error = new Error(`当前平台不受支持：${process.platform}`);
    error.code = "UNSUPPORTED_PLATFORM";
    throw error;
  },
  startBridge: () => ({ ok: true }),
  stopBridge: () => ({ ok: true }),
  stateDbCandidates: () => [],
  findOpenFiles: () => new Set(),
  isExecutable: () => false,
  execCodex: () => { throw new Error("CODEX_CLI_NOT_FOUND"); },
  spawnCodex: () => { throw new Error("CODEX_CLI_NOT_FOUND"); }
};

const adapters = { darwin: macos, win32: windows };
const adapter = adapters[process.platform] || unsupported;

export const {
  findCodexCli,
  findCodexDesktop,
  openCodex,
  openThread,
  openProject,
  copyText,
  startBridge,
  stopBridge,
  stateDbCandidates,
  findOpenFiles,
  isExecutable,
  execCodex,
  spawnCodex
} = adapter;

export function sendToExistingDesktopThread(...args) {
  if (typeof adapter.sendToExistingDesktopThread !== "function") return unsupported.openCodex();
  return adapter.sendToExistingDesktopThread(...args);
}

export function sendToNewDesktopThread(...args) {
  if (typeof adapter.sendToNewDesktopThread !== "function") return unsupported.openCodex();
  return adapter.sendToNewDesktopThread(...args);
}

export default adapter;
