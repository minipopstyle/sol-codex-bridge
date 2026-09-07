import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BRIDGE_HOME, ensureBridgeHome } from "./config.mjs";

export const HANDOFF_LEDGER_PATH = path.join(BRIDGE_HOME, "handoffs.jsonl");

export function appendHandoff({ source = {}, projectPath = "", sessionId = "", transport = "", payload = null } = {}) {
  ensureBridgeHome();
  const sourceInfo = source && typeof source === "object" ? source : {};
  const project = projectPath || null;
  const record = {
    handoffId: crypto.randomUUID(),
    conversationId: sourceInfo.conversationId || null,
    revision: Number(sourceInfo.revision || 0) || null,
    contentHash: sourceInfo.contentHash || payload?.artifact?.sha256 || null,
    projectPath: project,
    projectPathHash: project ? crypto.createHash("sha256").update(project).digest("hex") : null,
    sessionId: sessionId || null,
    sentAt: Date.now(),
    transport: transport || null,
    transferMode: payload?.transferMode || (payload?.mode === "artifact" ? "file" : "text"),
    payloadMode: payload?.mode || "inline",
    originalBytes: Number(payload?.originalBytes || 0) || null,
    artifact: payload?.artifact ? {
      filename: payload.artifact.filename,
      relativePath: payload.artifact.relativePath,
      format: payload.artifact.format,
      bytes: payload.artifact.bytes,
      sha256: payload.artifact.sha256
    } : null
  };
  fs.appendFileSync(HANDOFF_LEDGER_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try { fs.chmodSync(HANDOFF_LEDGER_PATH, 0o600); } catch {}
  return record;
}
