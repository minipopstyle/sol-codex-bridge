import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(new URL("./context-actions.js", import.meta.url), "utf8"), sandbox);

const actions = sandbox.SolCodexContextActions;
assert.equal(actions.resolveTransferMode("text", "x".repeat(100_000)), "text");
assert.equal(actions.resolveTransferMode("file", "short"), "file");
assert.equal(actions.resolveTransferMode("auto", "short"), "text");
assert.equal(actions.resolveTransferMode("auto", "x".repeat(24_001)), "file");
const fallbackFile = actions.projectContextFile({ projectName: "ChatGPT/with:Codex", text: "# context" });
assert.equal(fallbackFile.name, "sol-project-context-ChatGPT-with-Codex.md");
assert.equal(fallbackFile.mime, "text/markdown");
assert.equal(fallbackFile.content, "# context");

let attached;
const result = await actions.attachProjectContextAsFile(
  { file: { filename: "context.md", mimeType: "text/markdown", text: "full context" } },
  (file) => { attached = file; return { ok: true }; }
);
assert.equal(result.ok, true);
assert.equal(attached.name, "context.md");
assert.equal(attached.mime, "text/markdown");
assert.equal(attached.content, "full context");
assert.equal((await actions.insertProjectContextAsText({ text: "context" }, () => ({ ok: true }))).ok, true);
let sentFile;
const sent = await actions.sendPayload(
  actions.createPayload({ kind: "snapshot", content: "snapshot", suggestedFileName: "recent.md" }),
  "file",
  { attachFile: (file) => { sentFile = file; return { ok: true }; } }
);
assert.equal(sent.mode, "file");
assert.equal(sentFile.name, "recent.md");
console.log("context-actions self-check passed");
