import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const modern of [false, true]) test(`reads and mounts the complete ${modern ? "current Codex browser" : "legacy"} assistant message`, async () => {
  const sent = [];
  const created = [];
  let click;
  let statusListener;
  const textNode = (value) => ({ nodeType: 3, nodeValue: value, textContent: value });
  const elementNode = (tagName, children = [], extra = {}) => ({
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    children,
    childNodes: children,
    textContent: children.map((child) => child.textContent || "").join(""),
    querySelector(selector) {
      if (selector === "code" && this.tagName === "PRE") return children.find((child) => child.tagName === "CODE") || null;
      if (selector.includes("font-medium")) return { textContent: "JavaScript" };
      if (selector === ".markdown" && this.className === "markdown") return this;
      return null;
    },
    querySelectorAll() { return []; },
    ...extra,
  });
  const code = elementNode("code", [textNode("function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet(\"Sol\"));")]);
  const pre = elementNode("pre", [code]);
  const codeBlock = elementNode("div", [pre], {
    getAttribute(name) { return name === "data-markdown-copy" ? "code-block" : null; },
    querySelector(selector) {
      if (selector === "pre") return pre;
      if (selector.includes("font-medium")) return { textContent: "JavaScript" };
      return null;
    },
  });
  const markdown = elementNode("div", [
    elementNode("p", [textNode("这是一段 Markdown + 代码测试文本。")]),
    elementNode("p", [textNode("Inline: "), elementNode(modern ? "span" : "code", [textNode("status")], {
      getAttribute(name) { return modern && name === "data-markdown-copy" ? "inline-code" : null; },
    })]),
    modern ? codeBlock : pre,
    elementNode("p", [textNode("正常情况下，上面应该显示为独立代码块。")]),
  ], { className: "markdown" });
  const makeElement = (tagName = "div") => {
    const element = {
    tagName,
    children: [],
    className: "",
    classList: {
      add(...names) {
        element.className = [...new Set(`${element.className} ${names.join(" ")}`.trim().split(/\s+/))].join(" ");
      },
    },
    dataset: {},
    disabled: false,
    style: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.append(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) { if (type === "click") { this.__click = handler; click = handler; } },
    querySelector(selector) {
      const match = selector.startsWith(".") ? selector.slice(1) : "";
      const visit = (node) => {
        if (node?.className?.split?.(/\s+/).includes(match)) return node;
        return node?.children?.map(visit).find(Boolean) || null;
      };
      return visit(this);
    },
    setAttribute() {},
    textContent: "",
    };
    created.push(element);
    return element;
  };
  const assistant = {
    classList: { add() {} },
    currentText: "这",
    append(child) { this.widget = child; },
    closest() { return null; },
    getAttribute(name) { return modern && name === "data-chatgpt-selection-message-id" ? "message-current" : null; },
    querySelector() { return this.widget || null; },
    cloneNode() {
      return {
        querySelectorAll() { return []; },
        querySelector(selector) {
          return selector === (modern ? '[data-markdown-text-style="assistant-message"]' : ".markdown") ? markdown : null;
        },
        get innerText() { return assistant.currentText; },
        textContent: assistant.currentText,
      };
    },
  };
  const context = {
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener(handler) { statusListener = handler; } },
        sendMessage(message, callback) {
          sent.push(message);
          callback(message.type === "GET_CODEX_TARGET_STATE"
            ? { accepted: true, ready: true, target: { mode: "queue", projectPath: "/tmp/project", sessionId: "session-1" } }
            : { accepted: true });
        },
      },
    },
    crypto: { randomUUID: () => "task-test" },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    location: { href: "https://chatgpt.com/c/test" },
    document: {
      body: {},
      title: "Test",
      createElement: (tagName) => makeElement(tagName),
      createElementNS: makeElement,
      querySelector() { return null; },
      querySelectorAll(selector) {
        if (selector.includes("button")) return created.filter((element) => element.tagName === "button");
        return selector === (modern ? '[data-chatgpt-selection-message-id]:has([data-markdown-text-style="assistant-message"])' : '[data-message-author-role="assistant"]') ? [assistant] : [];
      },
    },
    MutationObserver: class { observe() {} },
  };

  vm.runInNewContext(fs.readFileSync(path.join(root, "chatgpt-extension/content.js"), "utf8"), context);
  assert.equal(typeof click, "function");
  assert.ok(assistant.widget, "the current assistant DOM must get a widget");

  assistant.currentText = "渲染后的可见文本";
  const button = created.find((element) => element.className.includes("sol-codex-push-btn"));
  await button.__click();

  const taskMessage = sent.find((message) => message.type === "RUN_IN_CODEX");
  assert.ok(taskMessage);
  assert.equal(taskMessage.payload.text, [
    "这是一段 Markdown + 代码测试文本。",
    "",
    "Inline: `status`",
    "",
    "```JavaScript",
    "function greet(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    "",
    "console.log(greet(\"Sol\"));",
    "```",
    "",
    "正常情况下，上面应该显示为独立代码块。",
  ].join("\n"));
  assert.equal(taskMessage.payload.mode, "queue");
  assert.equal(taskMessage.payload.projectPath, "/tmp/project");
  assert.equal(taskMessage.payload.transferMode, "auto");
  if (modern) assert.equal(taskMessage.payload.messageId, "message-current");

  assert.equal(button.dataset.state, "accepted");
  const loader = button.querySelector(".sol-codex-loader-grid");
  assert.ok(loader);
  statusListener({ type: "CODEX_TASK_STATUS", taskId: "task-test", status: "accepted" });
  assert.equal(button.querySelector(".sol-codex-loader-grid"), loader);
});

test("keeps the Codex button geometry stable on hover", () => {
  const source = fs.readFileSync(path.join(root, "chatgpt-extension/content.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "chatgpt-extension/content.css"), "utf8");
  const buttonRule = css.match(/\.sol-codex-inline-btn \{([\s\S]*?)\n\}/)?.[1] || "";
  const hoverRule = css.match(/\.sol-codex-inline-btn:hover:not\(:disabled\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(buttonRule, /animation:\s*none\s*!important/);
  assert.match(buttonRule, /transition:\s*none\s*!important/);
  assert.match(buttonRule, /transform:\s*none\s*!important/);
  assert.match(hoverRule, /transform:\s*none\s*!important/);
  assert.match(source, /button\.append\(createIconSlot\(createArrowIcon\("left"\)\), label\)/);
  assert.match(css, /\.sol-codex-inline-icon \{[^}]*transition:\s*transform 160ms ease-out/);
  assert.match(css, /\.sol-codex-inline-icon \{[^}]*animation:\s*none\s*!important/);
  assert.match(css, /\.sol-codex-inline-icon\.left \{\s*transform:\s*rotate\(180deg\)/);
  assert.match(css, /data-state="idle"\]:hover:not\(:disabled\) \.sol-codex-inline-icon\.left[^}]*transform:\s*translateX\(-2px\) rotate\(180deg\)/);
  assert.match(css, /\.sol-codex-loader-pixel[^{]*\{[^}]*animation-name:/);
  assert.doesNotMatch(source, /跟随打开会话/);
  assert.doesNotMatch(source, /needsOpenSelection|ambiguousOpen|已打开 ·/);
  assert.match(source, /actions\.append\(targetButton, button\)/);
  assert.match(source, /sol-codex-target-tab-row/);
  assert.match(source, /sendTab\.textContent = "发送到 Codex"/);
  assert.match(source, /contextButton\.setAttribute\("role", "tab"\)/);
  assert.match(source, /createSettingsIcon\(\)/);
  assert.match(source, /sol-codex-target-pairing-button/);
  assert.match(source, /sol-codex-target-pairing-menu/);
  assert.match(source, /state\.accepted \? "ok" : "warning"/);
  assert.match(source, /__codexBridgeStateVersion/);
  assert.match(source, /modes\.setAttribute\("role", "group"\)/);
  assert.doesNotMatch(source, /item\.setAttribute\("role", "tab"\)/);
  assert.match(source, /sol-codex-target-settings-menu/);
  assert.doesNotMatch(source, /actions\.append\(contextButton\)/);
  assert.match(css, /\.sol-codex-target-tab-row/);
  assert.match(css, /\.sol-codex-target-topbar/);
  assert.match(css, /\.sol-codex-target-settings/);
  assert.match(css, /\.sol-codex-target-pairing-button/);
  assert.match(css, /\.sol-codex-target-pairing-menu/);
  assert.match(css, /pairing-button\[data-paired="false"\][^{]*\{[^}]*#f59e0b/);
  assert.match(source, /document\.addEventListener\("click", closeOnOutside, true\)/);
  assert.match(source, /document\.removeEventListener\("click", outsideHandler, true\)/);
  assert.match(source, /setTargetButtonLabel\(targetButton, targetLabel\(state\.target\)\)/);
  assert.match(source, /setTargetStatus\(targetStatus, "warning"/);
  assert.match(source, /createChoiceField\("项目", "选择项目"\)/);
  assert.match(source, /sol-codex-context-transfer/);
  assert.match(css, /\.sol-codex-target-btn[\s\S]*?border: 0;/);
  assert.match(css, /\.sol-codex-target-btn[\s\S]*?justify-content: flex-start;/);
  assert.match(css, /\.sol-codex-target-status[\s\S]*?animation: sol-codex-status-pulse/);
  assert.match(css, /data-status="warning"/);
  assert.match(css, /data-status="error"/);
  assert.match(css, /\.sol-codex-target-label[\s\S]*?text-overflow: ellipsis/);
  assert.match(css, /\.sol-codex-target-modes[\s\S]*?grid-template-columns: repeat\(2/);
  assert.match(source, /if \(!targetState\.ready\) \{[\s\S]*?setState\(button, "error", targetState\.reason/);
  assert.doesNotMatch(source, /if \(!targetState\.ready\) \{\s*await openTargetPicker/);
});

test("declares storage permission used by the background target state", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "chatgpt-extension/manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("storage"));
});
