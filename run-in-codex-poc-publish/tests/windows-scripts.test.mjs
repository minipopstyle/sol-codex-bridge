import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsRoot = path.join(root, "Windows");

test("Windows publish scripts use the isolated task and port", () => {
  const files = [
    "install-run-in-codex-poc.ps1",
    "restart-run-in-codex-poc.ps1",
    "status-run-in-codex-poc.ps1",
    "uninstall-run-in-codex-poc.ps1",
    "run-in-codex-poc.common.ps1",
    "bridge-launcher.ps1",
  ];
  files.forEach((file) => assert.ok(fs.existsSync(path.join(windowsRoot, file)), file));

  const common = fs.readFileSync(path.join(windowsRoot, "run-in-codex-poc.common.ps1"), "utf8");
  assert.match(common, /\$script:Port = 4329/);
  assert.match(common, /Sol Codex POC Publish Bridge/);
  assert.match(common, /Register-ScheduledTask/);
  assert.match(common, /SOL_CODEX_BRIDGE_ROOT/);

  const install = fs.readFileSync(path.join(windowsRoot, "install-run-in-codex-poc.ps1"), "utf8");
  const uninstall = fs.readFileSync(path.join(windowsRoot, "uninstall-run-in-codex-poc.ps1"), "utf8");
  assert.match(install, /Copy-PairingToken/);
  assert.match(uninstall, /\$script:DataHome/);
  assert.doesNotMatch(uninstall, /\.sol-codex-bridge[\\/]/);
});
