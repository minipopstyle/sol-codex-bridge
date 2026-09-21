import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Context transfer mode chooses text or Markdown file without changing the payload", async () => {
  const context = { TextEncoder, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, "chatgpt-extension/context-actions.js"), "utf8"), context);
  const actions = context.SolCodexContextActions;
  assert.equal(actions.resolveTransferMode("text", "large"), "text");
  assert.equal(actions.resolveTransferMode("file", "small"), "file");
  assert.equal(actions.resolveTransferMode("auto", "small"), "text");

  let attached;
  const result = await actions.sendPayload(actions.createPayload({ kind: "snapshot", content: "markdown" }), "file", {
    attachFile: async (file) => { attached = file; return { ok: true }; },
    insertText: async () => ({ ok: true }),
  });
  assert.equal(result.mode, "file");
  assert.equal(attached.name, "snapshot.md");
  assert.equal(attached.mime, "text/markdown");
  assert.equal(attached.content, "markdown");
});
