import path from "node:path";
import { getGitDiff, getGitStatus } from "./project-context.mjs";
import { readTranscript } from "./codex-transcript.mjs";
import { assertContextReadable } from "./workspace-guard.mjs";

const SNAPSHOT_TTL_MS = 1_000;
const snapshotCache = new Map();

function projectName(projectPath) {
  return path.basename(String(projectPath).replace(/[\\/]$/, "")) || projectPath;
}

function recentErrors(messages) {
  const matches = [];
  for (const message of messages) {
    if (message.type !== "tool_output") continue;
    if (!/error|failed|failure|exit code|exception/i.test(message.content || "")) continue;
    const value = String(message.content).replace(/\s+/g, " ").trim().slice(0, 1_000);
    if (value && !matches.includes(value)) matches.push(value);
  }
  return matches.slice(-5);
}

function snapshotText(snapshot) {
  const lines = [
    "# Codex Current Context",
    "",
    `Project: ${snapshot.projectName}`,
    `Session: ${snapshot.session.title || snapshot.session.id}`,
    `Status: ${snapshot.session.status || "unknown"}`,
    `Updated: ${snapshot.session.updatedAt ? new Date(snapshot.session.updatedAt).toISOString() : "unknown"}`,
    "",
    "## Current task",
    snapshot.task || "暂无可见的最近任务。",
    "",
    "## Recent actions",
    ...(snapshot.recentActions.length ? snapshot.recentActions.map((item) => `- ${item.content}`) : ["- 暂无可见工具调用。"]),
    "",
    "## Changed files",
    ...(snapshot.changedFiles.length ? snapshot.changedFiles.map((item) => `- ${item}`) : ["- 暂无未提交文件变化。"]),
    "",
    "## Recent errors",
    ...(snapshot.errors.length ? snapshot.errors.map((item) => `- ${item}`) : ["- 未检测到可见错误。"]),
    "",
    "## Git",
    snapshot.git.isGitRepo ? `- Branch: ${snapshot.git.branch || "unknown"}` : "- 当前目录不是 Git 仓库。"
  ];
  return lines.join("\n");
}

export function buildSessionSnapshot({ projectPath, sessionId } = {}) {
  const root = assertContextReadable(projectPath);
  const key = `${root}\0${String(sessionId || "")}`;
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
  const transcript = readTranscript({
    sessionId,
    projectPath: root,
    maxMessages: 30,
    maxTotalBytes: 60_000,
    excludeToolOutputs: false,
    maxToolOutputBytes: 12_000
  });
  const session = transcript.session;
  const task = [...transcript.messages].reverse().find((item) => item.role === "user")?.content || "";
  const recentActions = transcript.messages.filter((item) => item.type === "tool_call").slice(-8).map(({ role, content, ts, type }) => ({ role, content, ts, type }));
  const changedFiles = getGitStatus(root);
  const snapshot = {
    projectName: projectName(root),
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
      modelProvider: session.modelProvider,
      gitBranch: session.gitBranch
    },
    task,
    recentActions,
    changedFiles: changedFiles.changedFiles || [],
    errors: recentErrors(transcript.messages),
    git: changedFiles,
    text: ""
  };
  snapshot.text = snapshotText(snapshot);
  snapshotCache.set(key, { at: Date.now(), value: snapshot });
  return snapshot;
}

function bundleText(project, session, snapshot, transcript, git) {
  const sections = [
    "[Sol → Codex Local Context]",
    "",
    `Project: ${project}`,
    `Session: ${session?.title || session?.id || "unknown"}`,
    `Captured: ${new Date().toISOString()}`
  ];
  if (snapshot) sections.push("", "## Current progress", snapshot.text);
  if (transcript) sections.push("", "## Recent transcript", transcript.text || "暂无可见 transcript。");
  if (git) {
    const gitText = git.isGitRepo
      ? [`Branch: ${git.branch || "unknown"}`, ...(git.changedFiles.length ? ["Changed files:", ...git.changedFiles.map((item) => `- ${item}`)] : ["No changed files."]), git.diff ? `\n${git.diff}` : "", git.stagedDiff ? `\n[Staged]\n${git.stagedDiff}` : ""].join("\n")
      : "当前目录不是 Git 仓库。";
    sections.push("", "## Git changes", gitText);
  }
  sections.push("", "[End Local Context]");
  return sections.join("\n");
}

export function buildContextBundle({ projectPath, sessionId, parts = ["snapshot", "transcript", "git"], options = {} } = {}) {
  const root = assertContextReadable(projectPath);
  const requested = [...new Set(Array.isArray(parts) ? parts : [])];
  const allowed = new Set(["snapshot", "transcript", "git"]);
  if (!requested.length) requested.push("snapshot");
  if (requested.some((part) => !allowed.has(part))) throw Object.assign(new Error("Context bundle part 无效"), { status: 400, code: "CONTEXT_PART_INVALID" });
  const snapshot = requested.includes("snapshot") ? buildSessionSnapshot({ projectPath: root, sessionId }) : null;
  const session = snapshot?.session || (requested.includes("transcript") ? readTranscript({ sessionId, projectPath: root, maxMessages: 1 }).session : null);
  const transcript = requested.includes("transcript") ? readTranscript({
    sessionId,
    projectPath: root,
    maxMessages: options.transcriptMessages || 40,
    maxTotalBytes: options.transcriptBytes || 80_000,
    excludeToolOutputs: options.excludeToolOutputs === true,
    maxToolOutputBytes: options.maxToolOutputBytes || 12_000
  }) : null;
  const git = requested.includes("git") ? getGitDiff(root) : null;
  const context = { project: { name: projectName(root) }, session, snapshot, transcript, git };
  return { context, text: bundleText(projectName(root), session, snapshot, transcript, git) };
}
