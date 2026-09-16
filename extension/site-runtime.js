(function () {
  const sites = [globalThis.SolCodexPrismSite, globalThis.SolCodexChatGPTSite].filter(Boolean);
  const current = sites.find((site) => site.matches()) || null;
  globalThis.SolCodexSite = current;
})();
