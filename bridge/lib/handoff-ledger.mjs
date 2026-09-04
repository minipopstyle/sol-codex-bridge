import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BRIDGE_HOME, ensureBridgeHome } from "./config.mjs";

export const HANDOFF_LEDGER_PATH = path.join(BRIDGE_HOME, "handoffs.jsonl");

export function appendHandoff({ source = {}, projectPath = "", sessionId = "", transport = "" } = {}) {
  ensureBridgeHome();
  const record = {
    handoffId: crypto.randomUUID(),
    conversationId: source.conversationId || null,
    revision: Number(source.revision || 0) || null,
    contentHash: source.contentHash || null,
    projectPath: projectPath || null,
    sessionId: sessionId || null,
    sentAt: Date.now(),
    transport: transport || null
  };
  fs.appendFileSync(HANDOFF_LEDGER_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try { fs.chmodSync(HANDOFF_LEDGER_PATH, 0o600); } catch {}
  return record;
}
