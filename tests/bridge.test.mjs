import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBridgeServer } from "../bridge/server.mjs";
import { TaskStore } from "../bridge/task-store.mjs";

let server;
let baseUrl;

before(async () => {
  server = createBridgeServer({ dispatch: null, token: "test-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-bridge-token": "test-token", ...(options?.headers || {}) },
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

function task(overrides = {}) {
  return {
    taskId: "task-1",
    messageId: "message-1",
    workspace: "新的测试项",
    text: "TASK_ID: cli_word_counter",
    source: "chatgpt",
    ...overrides,
  };
}

test("creates a task and exposes only redacted task status", async () => {
  const created = await request("/tasks", { method: "POST", body: JSON.stringify(task({ mode: "new" })) });
  assert.equal(created.status, 202);
  assert.deepEqual(created.body, { accepted: true, taskId: "task-1", status: "queued" });

  const status = await request("/tasks/task-1");
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "queued");
  assert.equal(status.body.mode, "new");
  assert.equal("text" in status.body, false);
  assert.equal("projectPath" in status.body, false);
});

test("requires a pairing token for non-health routes", async () => {
  const response = await fetch(`${baseUrl}/targets`);
  assert.equal(response.status, 401);
});

test("keeps task lifecycle and transfer mode in the store", () => {
  const store = new TaskStore();
  const created = store.enqueue(task({ taskId: "lifecycle", messageId: "message-lifecycle", mode: "new", transferMode: "file" }));
  const next = store.next(created.task.workspace);
  assert.equal(next.transferMode, "file");
  store.setStatus(next.taskId, "accepted", { leaseId: next.leaseId });
  store.setStatus(next.taskId, "running");
  store.setStatus(next.taskId, "executed");
  assert.equal(store.get(next.taskId).status, "executed");
});

test("deduplicates the same taskId and messageId", async () => {
  const first = await request("/tasks", { method: "POST", body: JSON.stringify(task({ taskId: "task-2" })) });
  const duplicate = await request("/tasks", { method: "POST", body: JSON.stringify(task({ taskId: "task-2" })) });
  assert.equal(first.body.accepted, true);
  assert.deepEqual(duplicate.body, {
    accepted: false,
    duplicate: true,
    taskId: "task-2",
    status: "queued",
  });
});

test("rejects invalid status transitions", () => {
  const store = new TaskStore();
  store.enqueue(task({ taskId: "task-3", messageId: "message-3" }));
  assert.throws(() => store.setStatus("task-3", "executed"), /Invalid task status transition/);
});

test("does not return a missing task", async () => {
  const result = await request("/tasks/missing-task");
  assert.equal(result.status, 404);
});

test("rejects a conflicting task id", async () => {
  const first = await request("/tasks", { method: "POST", body: JSON.stringify(task({ taskId: "same-task", messageId: "message-a" })) });
  const second = await request("/tasks", { method: "POST", body: JSON.stringify(task({ taskId: "same-task", messageId: "message-b" })) });
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "TASK_ID_CONFLICT");
});

test("context routes require an explicit project path", async () => {
  const result = await request("/api/context/project", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "缺少 projectPath");
});

test("context file browsing stays behind the existing project guard", async () => {
  const result = await request("/api/context/files", {
    method: "POST",
    body: JSON.stringify({ projectPath: "/tmp", relativePath: "" }),
  });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, "PROJECT_NOT_RECOGNIZED");
});
