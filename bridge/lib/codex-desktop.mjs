// Compatibility facade for callers of the former desktop module.
// The macOS-only Sol Codex Bridge.app behavior lives in platform/macos.mjs.
export {
  findCodexDesktop as findCodexDesktopApp,
  openThread as openDesktopThread,
  openProject as openDesktopProject,
  sendToExistingDesktopThread,
  sendToNewDesktopThread
} from "./platform/index.mjs";
