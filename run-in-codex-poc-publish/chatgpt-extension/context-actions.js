(function () {
  const TRANSFER_MODES = ["auto", "text", "file"];
  const INLINE_MAX_BYTES = 24_000;
  const INLINE_MAX_LINES = 300;

  function safeFilename(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "project";
  }

  function normalizeTransferMode(value) {
    if (value === "inline") return "text";
    if (value === "artifact") return "file";
    return TRANSFER_MODES.includes(value) ? value : "auto";
  }

  function byteLength(value) {
    const text = String(value || "");
    return typeof TextEncoder === "undefined" ? unescape(encodeURIComponent(text)).length : new TextEncoder().encode(text).length;
  }

  function resolveTransferMode(value, text) {
    const mode = normalizeTransferMode(value);
    if (mode !== "auto") return mode;
    const content = String(text || "");
    const bytes = byteLength(content);
    const lines = content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
    return bytes > INLINE_MAX_BYTES || lines > INLINE_MAX_LINES ? "file" : "text";
  }

  function createPayload({ kind, title, content, suggestedFileName, fileContent, mime = "text/markdown" } = {}) {
    const text = String(content || "");
    return {
      kind: String(kind || "context"),
      title: String(title || kind || "Context"),
      content: text,
      byteLength: byteLength(text),
      suggestedFileName: suggestedFileName || `${safeFilename(kind || "context")}.md`,
      fileContent: fileContent == null ? text : String(fileContent),
      mime
    };
  }

  function payloadFile(payload) {
    const content = payload?.fileContent == null ? payload?.content : payload.fileContent;
    if (content == null || content === "") return null;
    return {
      name: safeFilename(payload.suggestedFileName || `${payload.kind || "context"}.md`),
      mime: payload.mime || "text/markdown",
      content: String(content)
    };
  }

  function canFallbackToText(error) {
    return ["NO_UPLOAD_INPUT", "UPLOAD_INPUT_REJECTED", "ATTACHMENT_NOT_DETECTED", "ATTACHER_UNAVAILABLE"].includes(error?.code);
  }

  async function attachPayloadAsFile(payload, attachFile) {
    const file = payloadFile(payload);
    if (!file) return { ok: false, code: "EMPTY_CONTEXT" };
    if (typeof attachFile !== "function") return { ok: false, code: "ATTACHER_UNAVAILABLE" };
    return attachFile(file);
  }

  async function insertPayloadAsText(payload, insertText) {
    const text = String(payload?.content || "");
    if (!text) return { ok: false, code: "EMPTY_CONTEXT" };
    if (typeof insertText !== "function") return { ok: false, code: "INSERTER_UNAVAILABLE" };
    return insertText(text);
  }

  async function sendPayload(payload, transferMode, { attachFile, insertText, fallbackToText = false } = {}) {
    const requestedMode = normalizeTransferMode(transferMode);
    const mode = resolveTransferMode(transferMode, payload?.content);
    if (mode !== "file") return { ...(await insertPayloadAsText(payload, insertText)), mode };
    try {
      const result = await attachPayloadAsFile(payload, attachFile);
      if (result?.ok || !fallbackToText || requestedMode !== "auto" || !canFallbackToText(result)) return { ...(result || { ok: false }), mode };
    } catch (error) {
      if (!fallbackToText || requestedMode !== "auto" || !canFallbackToText(error)) throw error;
    }
    return { ...(await insertPayloadAsText(payload, insertText)), mode: "text" };
  }

  globalThis.SolCodexContextActions = Object.freeze({
    TRANSFER_MODES,
    normalizeTransferMode,
    resolveTransferMode,
    createPayload,
    payloadFile,
    sendPayload
  });
})();
