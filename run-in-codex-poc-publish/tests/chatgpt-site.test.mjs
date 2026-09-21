import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ChatGPT insertion targets #prompt-textarea before arbitrary contenteditable nodes", () => {
  class Textarea {
    constructor() { this.value = "已有内容"; this.isContentEditable = false; }
    focus() { this.focused = true; }
    dispatchEvent(event) { this.lastEvent = event.type; }
  }
  class Input {}
  const textarea = new Textarea();
  const unrelated = { value: "不要写这里", isContentEditable: true };
  const context = {
    HTMLTextAreaElement: Textarea,
    HTMLInputElement: Input,
    InputEvent: class InputEvent { constructor(type) { this.type = type; } },
    Event: class Event { constructor(type) { this.type = type; } },
    document: {
      querySelector(selector) {
        if (selector === "#prompt-textarea") return textarea;
        if (selector === '[contenteditable="true"]') return unrelated;
        return null;
      }
    },
    window: { getSelection() { return null; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "chatgpt-extension/chatgpt-site.js"), "utf8"), context);
  const result = context.SolCodexChatGPTSite.insertText("新内容");
  assert.equal(result.ok, true);
  assert.equal(textarea.value, "已有内容\n\n新内容");
  assert.equal(unrelated.value, "不要写这里");
  assert.equal(textarea.lastEvent, "input");
});
