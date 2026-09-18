(() => {
  const id = "sol-codex-poc-marker";
  if (document.getElementById(id)) return;

  const marker = document.createElement("div");
  marker.id = id;
  marker.textContent = "Sol Codex POC ✓";
  Object.assign(marker.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    padding: "4px 7px",
    borderRadius: "4px",
    background: "rgba(15, 23, 42, 0.92)",
    color: "#f8fafc",
    font: "11px/1.2 -apple-system, BlinkMacSystemFont, sans-serif",
    pointerEvents: "none",
    userSelect: "none"
  });
  (document.body || document.documentElement).appendChild(marker);
  console.log("[Sol Codex POC] content script loaded");
})();
