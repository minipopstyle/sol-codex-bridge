import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const BRIDGE_HOME = process.env.SOL_CODEX_BRIDGE_HOME || path.join(os.homedir(), ".sol-codex-bridge");
export const CONFIG_PATH = path.join(BRIDGE_HOME, "config.json");
export const TOKEN_PATH = path.join(BRIDGE_HOME, "token");

export function ensureBridgeHome() {
  fs.mkdirSync(BRIDGE_HOME, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  ensureBridgeHome();
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      userProjects: Array.isArray(parsed.userProjects) ? parsed.userProjects : []
    };
  } catch {
    return { userProjects: [] };
  }
}

export function saveConfig(config) {
  ensureBridgeHome();
  const clean = { userProjects: [...new Set(config.userProjects || [])] };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  return clean;
}

export function getOrCreateToken() {
  ensureBridgeHome();
  try {
    const current = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (current.length >= 24) return current;
  } catch {}
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}
