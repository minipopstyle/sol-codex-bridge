import { randomUUID } from "node:crypto";
import { assertTransition } from "./protocol.mjs";

export class TaskNotFoundError extends Error {}
export class InvalidLeaseError extends Error {}

export class TaskStore {
  constructor({ leaseMs = 10_000, retentionMs = 30 * 60_000, maxTasks = 256, now = () => Date.now() } = {}) {
    this.leaseMs = leaseMs;
    this.retentionMs = retentionMs;
    this.maxTasks = maxTasks;
    this.now = now;
    this.tasks = new Map();
    this.keys = new Map();
  }

  remove(taskId) {
    this.tasks.delete(taskId);
    for (const [key, value] of this.keys) {
      if (value === taskId) this.keys.delete(key);
    }
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    for (const [taskId, task] of this.tasks) {
      const terminal = task.status === "executed" || task.status === "error";
      if (terminal && Date.parse(task.updatedAt) <= cutoff) this.remove(taskId);
    }
  }

  enqueue(input) {
    this.prune();
    const key = JSON.stringify([input.taskId, input.messageId]);
    const existingId = this.keys.get(key);
    if (existingId) {
      return { accepted: false, duplicate: true, task: this.tasks.get(existingId) };
    }
    if (this.tasks.has(input.taskId)) {
      throw Object.assign(new Error(`Task id already exists: ${input.taskId}`), {
        status: 409,
        code: "TASK_ID_CONFLICT",
      });
    }
    if (this.tasks.size >= this.maxTasks) {
      throw Object.assign(new Error("任务队列已满"), { status: 429, code: "TASK_QUEUE_FULL" });
    }

    const timestamp = new Date(this.now()).toISOString();
    const task = {
      taskId: input.taskId,
      messageId: input.messageId,
      workspace: input.workspace,
      mode: input.mode ?? "queue",
      projectPath: input.projectPath ?? null,
      sessionId: input.sessionId ?? null,
      text: input.text,
      transferMode: typeof input.transferMode === "string" ? input.transferMode : "auto",
      source: input.source ?? "chatgpt",
      pageUrl: input.pageUrl ?? null,
      conversationTitle: input.conversationTitle ?? null,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
      status: "queued",
      error: null,
      leaseId: null,
      leaseExpiresAt: null,
      transport: null,
    };

    this.tasks.set(task.taskId, task);
    this.keys.set(key, task.taskId);
    return { accepted: true, duplicate: false, task };
  }

  next(workspace) {
    this.prune();
    const now = this.now();
    for (const task of this.tasks.values()) {
      if (task.status !== "queued" || task.workspace !== workspace) continue;
      if (task.leaseExpiresAt && task.leaseExpiresAt > now) continue;

      task.leaseId = randomUUID();
      task.leaseExpiresAt = now + this.leaseMs;
      task.updatedAt = new Date(now).toISOString();
      return task;
    }
    return null;
  }

  get(taskId) {
    this.prune();
    return this.tasks.get(taskId) ?? null;
  }

  setStatus(taskId, status, { leaseId = null, error = null } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);

    assertTransition(task.status, status);
    if (status === task.status) return task;

    if (task.status === "queued" && status === "accepted" && task.leaseId !== leaseId) {
      throw new InvalidLeaseError(`Invalid lease for task: ${taskId}`);
    }

    task.status = status;
    task.error = status === "error" ? String(error || "Unknown task error") : null;
    task.updatedAt = new Date(this.now()).toISOString();
    if (status === "accepted") {
      task.leaseId = null;
      task.leaseExpiresAt = null;
    }
    return task;
  }

  list() {
    this.prune();
    return [...this.tasks.values()];
  }
}
