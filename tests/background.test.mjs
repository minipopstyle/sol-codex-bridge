import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("target state works when Codex browser omits chrome.storage", async () => {
  let listener;
  const context = {
    chrome: {
      runtime: { onMessage: { addListener(handler) { listener = handler; } } },
    },
    fetch: async () => new Response(JSON.stringify({
      projects: [{ path: "/tmp/project", name: "Project", sessions: [] }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "chatgpt-extension/background.js"), "utf8"), context);

  const result = await new Promise((resolve) => listener({ type: "GET_CODEX_TARGET_STATE" }, {}, resolve));
  assert.equal(result.accepted, true);
  assert.equal(result.savedTarget.mode, "queue");
  assert.match(result.reason, /已有 Codex 会话/);
});

test("read target state exposes projects before a send target is saved", async () => {
  let listener;
  const context = {
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} } },
      runtime: { onMessage: { addListener(handler) { listener = handler; } } },
    },
    fetch: async () => new Response(JSON.stringify({
      projects: [{ path: "/tmp/project", name: "Project", sessions: [{ id: "session-1", title: "Session", status: "idle" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "chatgpt-extension/background.js"), "utf8"), context);

  const result = await new Promise((resolve) => listener({ type: "GET_CODEX_READ_TARGET_STATE" }, {}, resolve));
  assert.equal(result.accepted, true);
  assert.equal(result.projects[0].path, "/tmp/project");
  assert.equal(result.ready, false);
});

test("stores the Pairing Token and sends it to the Bridge", async () => {
  let listener;
  let bridgeToken = "";
  let requestHeaders;
  const context = {
    chrome: {
      storage: {
        local: {
          async get() { return { bridgeToken }; },
          async set(value) { bridgeToken = value.bridgeToken; },
        },
      },
      runtime: { onMessage: { addListener(handler) { listener = handler; } } },
    },
    fetch: async (_url, options) => {
      requestHeaders = options.headers;
      return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
    URL,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "chatgpt-extension/background.js"), "utf8"), context);

  const result = await new Promise((resolve) => listener(
    { type: "SET_BRIDGE_TOKEN", token: "pairing-token" },
    { tab: { url: "https://chatgpt.com/c/test" } },
    resolve,
  ));
  assert.equal(result.accepted, true);
  assert.equal(bridgeToken, "pairing-token");
  assert.equal(requestHeaders["x-bridge-token"], "pairing-token");
});
