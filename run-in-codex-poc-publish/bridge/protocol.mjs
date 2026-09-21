export const TASK_STATUSES = Object.freeze([
  "queued",
  "accepted",
  "running",
  "executed",
  "error",
]);

const transitions = Object.freeze({
  queued: new Set(["accepted", "error"]),
  accepted: new Set(["running", "error"]),
  running: new Set(["executed", "error"]),
  executed: new Set(),
  error: new Set(),
});

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function canTransition(from, to) {
  return from === to || Boolean(transitions[from]?.has(to));
}

export function assertTransition(from, to) {
  if (!isTaskStatus(to) || !canTransition(from, to)) {
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
  }
}
