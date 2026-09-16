import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = {
  location: new URL("https://prism.openai.com/?u=PROJECT_ID&pg=1&m=main.tex"),
  document: {},
  console,
  URL
};
context.globalThis = context;

for (const file of ["sites/chatgpt.js", "sites/prism.js", "site-runtime.js"]) {
  vm.runInNewContext(fs.readFileSync(new URL(file, import.meta.url), "utf8"), context, { filename: file });
}

assert.equal(context.SolCodexPrismSite.matches(), true);
assert.equal(context.SolCodexChatGPTSite.matches(), false);
assert.equal(context.SolCodexSite.id, "prism");
assert.equal(context.SolCodexPrismSite.getConversationId(), "prism:PROJECT_ID");

context.location = new URL("https://prism.openai.com/?pg=2&m=refs.bib");
assert.equal(context.SolCodexPrismSite.getConversationId(), "prism:/");

let menuOpen = false;
let triggerClicked = false;
let pointerDown = false;
let menuClicked = false;
let inputClickPrevented = false;
const uploadListeners = new Map();
const body = {};
const root = {
  textContent: "",
  getAttribute(name) { return name === "class" ? "chat-tab-conversation" : ""; },
  querySelector() { return null; },
  querySelectorAll(selector) {
    if (selector === "*") return [];
    if (selector.includes("上传文件")) return [trigger];
    return [];
  },
  closest() { return null; }
};
const trigger = {
  dispatchEvent(event) { if (event.type === "pointerdown") { pointerDown = true; menuOpen = true; } },
  click() { triggerClicked = true; menuOpen = true; },
  closest() { return null; }
};
const menuItem = {
  textContent: "上传文件和照片",
  click() {
    menuClicked = true;
    const event = {
      target: input,
      preventDefault() { inputClickPrevented = true; },
      stopPropagation() {}
    };
    uploadListeners.get("click")?.(event);
  },
  closest() { return null; }
};
const input = {
  accept: "", multiple: true, parentElement: body, isConnected: true,
  matches(selector) { return selector === 'input[type="file"]'; },
  closest() { return null; }, getClientRects() { return []; },
  set files(value) { this._files = value; }, get files() { return this._files || []; },
  dispatchEvent(event) { if (event.type === "change") root.textContent = this.files[0]?.name || ""; }
};
const uploadContext = {
  location: new URL("https://prism.openai.com/?u=PROJECT_ID"), URL, console,
  document: {
    body,
    addEventListener(type, listener) { uploadListeners.set(type, listener); },
    removeEventListener(type) { uploadListeners.delete(type); },
    querySelectorAll(selector) {
      if (selector === "input[type=\"file\"]") return [input];
      if (selector === "[role=\"menuitem\"]") return menuOpen ? [menuItem] : [];
      if (selector.includes(".chat-tab-conversation")) return [root];
      return [];
    }
  },
  Event: class { constructor(type) { this.type = type; } },
  PointerEvent: class { constructor(type) { this.type = type; } },
  File: class { constructor(_parts, name) { this.name = name; } },
  DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout() { return 1; }, clearTimeout() {}
};
uploadContext.globalThis = uploadContext;
vm.runInNewContext(fs.readFileSync(new URL("sites/prism.js", import.meta.url), "utf8"), uploadContext, { filename: "sites/prism.js" });
const reusedInputResult = await uploadContext.SolCodexPrismSite.attachFile({ name: "context.md", content: "context" });
assert.equal(reusedInputResult.ok, true);
assert.equal(pointerDown, true);
assert.equal(triggerClicked, true);
assert.equal(menuClicked, true);
assert.equal(inputClickPrevented, true);
assert.equal(uploadListeners.size, 0);
assert.equal(input.files[0].name, "context.md");

console.log("site adapter checks passed");
