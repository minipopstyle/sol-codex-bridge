import { writeHandoffArtifact } from "./handoff-artifact.mjs";

export const INLINE_MAX_BYTES = 24_000;
export const INLINE_MAX_LINES = 300;

function lineCount(text) {
  const value = String(text);
  return value.split(/\r?\n/).length - (value.endsWith("\n") ? 1 : 0);
}

function normalizeMode(value) {
  return ["inline", "artifact", "auto"].includes(value) ? value : "auto";
}

function codexPrompt(artifact) {
  const file = artifact.relativePath || artifact.path;
  return [
    "# Sol Handoff",
    "",
    "本次 Sol 内容较长，已转换为本地 Markdown 文件：",
    "",
    `文件：${file}`,
    "",
    "请先完整读取该文件，将文件内容视为本次用户的完整需求与上下文，然后继续当前项目任务。"
  ].join("\n");
}

export function prepareHandoffPayload({ text, projectPath, sessionId = "", source = {}, forceMode = "auto" } = {}) {
  const content = String(text || "").trim();
  if (!content) throw Object.assign(new Error("方案内容为空"), { status: 400, code: "EMPTY_PROMPT" });
  const originalBytes = Buffer.byteLength(content, "utf8");
  const requestedMode = normalizeMode(forceMode);
  const mode = requestedMode === "artifact"
    || (requestedMode === "auto" && (originalBytes > INLINE_MAX_BYTES || lineCount(content) > INLINE_MAX_LINES))
    ? "artifact"
    : "inline";
  if (mode === "inline") {
    return { mode, originalBytes, inlineText: content, artifact: null, codexPrompt: content };
  }

  const contentType = source?.contentType || (source?.type === "manual" ? "selected-text" : "assistant-response");
  const artifact = writeHandoffArtifact({ text: content, projectPath, sessionId, source, contentType });
  return { mode, originalBytes, inlineText: null, artifact, codexPrompt: codexPrompt(artifact) };
}
