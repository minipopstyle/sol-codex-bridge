import fs from "node:fs";
import { assertSessionBelongsToProject, getSessionById } from "./codex-state.mjs";

export const TRANSCRIPT_DEFAULTS = Object.freeze({
  direction: "tail",
  maxMessages: 60,
  maxTotalBytes: 80_000,
  maxToolOutputBytes: 12_000
});

const TRANSCRIPT_LIMITS = Object.freeze({
  maxMessages: 300,
  maxTotalBytes: 300_000,
  maxToolOutputBytes: 50_000
});
const BLOCK_BYTES = 64 * 1024;

function integer(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), maximum) : fallback;
}

function truncateText(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes)) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function publicText(value) {
  if (typeof value === "string") return value.trim();
  if (value == null || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(publicText).filter(Boolean).join("\n").trim();
  if (typeof value.text === "string") return value.text.trim();
  for (const key of ["content", "output", "result", "message", "value", "summary"]) {
    if (value[key] != null) {
      const text = publicText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function eventMessage(event, maxToolOutputBytes, excludeToolOutputs) {
  const payload = event?.payload && typeof event.payload === "object"
    ? event.payload
    : event?.data && typeof event.data === "object" ? event.data : event;
  const type = String(payload?.type || event?.type || "").toLowerCase();
  const ts = event?.timestamp || payload?.timestamp || null;

  if (type === "message" || type === "user_message" || type === "assistant_message") {
    const role = String(payload?.role || payload?.message?.role || (type === "user_message" ? "user" : "assistant")).toLowerCase();
    if (!["user", "assistant", "tool"].includes(role)) return null;
    const content = publicText(payload?.content ?? payload?.message ?? payload?.text);
    return content ? { role, content, ts, type: "message" } : null;
  }

  if (type === "function_call") {
    const name = payload?.name || payload?.function?.name || payload?.call?.name || "function_call";
    return { role: "assistant", content: `[Tool: ${String(name).slice(0, 200)}]`, ts, type: "tool_call" };
  }

  if (type === "function_call_output") {
    if (excludeToolOutputs) return null;
    const output = truncateText(publicText(payload?.output ?? payload?.result ?? payload?.content ?? payload?.message), maxToolOutputBytes);
    if (!output.text) return null;
    return { role: "tool", content: output.text, ts, type: "tool_output", _truncated: output.truncated };
  }

  // Reasoning and internal/developer/system events deliberately stop here.
  return null;
}

function readJsonlLines(file, maxOffset, onLine) {
  const fd = fs.openSync(file, "r");
  const block = Buffer.alloc(BLOCK_BYTES);
  let fileOffset = 0;
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;
  try {
    while (fileOffset < maxOffset) {
      const requested = Math.min(BLOCK_BYTES, maxOffset - fileOffset);
      const bytesRead = fs.readSync(fd, block, 0, requested, fileOffset);
      if (!bytesRead) break;
      fileOffset += bytesRead;
      pending = Buffer.concat([pending, block.subarray(0, bytesRead)]);
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline);
        const offset = pendingOffset;
        pending = pending.subarray(newline + 1);
        pendingOffset = offset + newline + 1;
        if (offset < maxOffset) onLine(line.toString("utf8"), offset, pendingOffset);
      }
    }
    if (pending.length && pendingOffset < maxOffset) onLine(pending.toString("utf8"), pendingOffset, Math.min(fileOffset, maxOffset));
  } finally {
    fs.closeSync(fd);
  }
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    modelProvider: session.modelProvider,
    gitBranch: session.gitBranch,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    status: session.status,
    projectId: session.projectId
  };
}

function formatMessages(messages) {
  return messages.map((item) => {
    const label = item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : "Tool";
    return `${label}: ${item.content}`;
  }).join("\n\n");
}

export function readTranscript({
  sessionId,
  projectPath,
  direction = TRANSCRIPT_DEFAULTS.direction,
  cursor = null,
  maxMessages = TRANSCRIPT_DEFAULTS.maxMessages,
  maxTotalBytes = TRANSCRIPT_DEFAULTS.maxTotalBytes,
  excludeToolOutputs = false,
  maxToolOutputBytes = TRANSCRIPT_DEFAULTS.maxToolOutputBytes
} = {}) {
  const session = assertSessionBelongsToProject(sessionId, projectPath);
  const normalizedDirection = direction === "head" ? "head" : direction === "tail" ? "tail" : null;
  if (!normalizedDirection) throw Object.assign(new Error("direction 必须是 head 或 tail"), { status: 400, code: "DIRECTION_INVALID" });
  const messageLimit = integer(maxMessages, TRANSCRIPT_DEFAULTS.maxMessages, TRANSCRIPT_LIMITS.maxMessages);
  const byteLimit = integer(maxTotalBytes, TRANSCRIPT_DEFAULTS.maxTotalBytes, TRANSCRIPT_LIMITS.maxTotalBytes);
  const toolLimit = integer(maxToolOutputBytes, TRANSCRIPT_DEFAULTS.maxToolOutputBytes, TRANSCRIPT_LIMITS.maxToolOutputBytes);
  let stat;
  try { stat = fs.statSync(session.rolloutPath); } catch { throw Object.assign(new Error("Codex Session 文件不存在"), { status: 404, code: "ROLLOUT_NOT_FOUND" }); }
  if (!stat.isFile()) throw Object.assign(new Error("Codex Session 文件无效"), { status: 404, code: "ROLLOUT_INVALID" });

  const parsedCursor = cursor == null || cursor === "" ? null : Number(cursor);
  if (parsedCursor != null && (!Number.isInteger(parsedCursor) || parsedCursor < 0 || parsedCursor > stat.size)) {
    throw Object.assign(new Error("transcript cursor 无效"), { status: 400, code: "CURSOR_INVALID" });
  }
  const limitOffset = normalizedDirection === "tail" ? (parsedCursor ?? stat.size) : stat.size;
  const messages = [];
  let totalBytes = 0;
  let truncated = false;
  let nextCursor = null;

  const addTail = (message, offset, endOffset) => {
    const clipped = truncateText(message.content, byteLimit);
    const item = { ...message, content: clipped.text, _offset: offset, _endOffset: endOffset };
    if (clipped.truncated) truncated = true;
    item._bytes = Buffer.byteLength(item.content, "utf8");
    messages.push(item);
    totalBytes += item._bytes;
    while (messages.length > messageLimit || totalBytes > byteLimit) {
      const removed = messages.shift();
      totalBytes -= removed._bytes;
    }
  };
  const addHead = (message, offset, endOffset) => {
    const remaining = byteLimit - totalBytes;
    if (remaining <= 0) { truncated = true; return false; }
    const clipped = truncateText(message.content, remaining);
    const item = { ...message, content: clipped.text, _offset: offset, _endOffset: endOffset };
    if (clipped.truncated) truncated = true;
    messages.push(item);
    totalBytes += Buffer.byteLength(item.content, "utf8");
    if (messages.length >= messageLimit || clipped.truncated) { truncated = true; return false; }
    return true;
  };

  readJsonlLines(session.rolloutPath, limitOffset, (line, offset, endOffset) => {
    if (normalizedDirection === "tail" && parsedCursor != null && offset >= parsedCursor) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const message = eventMessage(event, toolLimit, Boolean(excludeToolOutputs));
    if (!message) return;
    if (normalizedDirection === "tail") addTail(message, offset, endOffset);
    else if (messages.length < messageLimit) addHead(message, offset, endOffset);
  });

  const cleanMessages = messages.map(({ _offset, _endOffset, _bytes, _truncated, ...message }) => message);
  if (normalizedDirection === "tail") {
    const oldest = messages[0];
    nextCursor = oldest && oldest._offset > 0 ? String(oldest._offset) : null;
    if (nextCursor) truncated = true;
  } else if (messages.length) {
    const last = messages.at(-1);
    if (last._endOffset < stat.size) {
      nextCursor = String(last._endOffset);
      truncated = true;
    }
  }
  const safeTitle = cleanMessages.find((item) => item.role === "user")?.content || session.title;
  return {
    session: publicSession({ ...session, title: safeTitle }),
    messages: cleanMessages,
    cursor: cursor == null || cursor === "" ? null : String(parsedCursor),
    nextCursor,
    hasMore: Boolean(nextCursor),
    truncated,
    sourceSizeBytes: stat.size,
    text: formatMessages(cleanMessages)
  };
}
