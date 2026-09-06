import fs from "node:fs";
import path from "node:path";
import { getGitDiff, getGitStatus } from "./project-context.mjs";
import { readTranscript } from "./codex-transcript.mjs";
import { isBinaryFile } from "./project-files.mjs";
import { ABSOLUTE_MAX_FILE_BYTES, assertContextReadable, assertReadableFile, walkReadableFiles } from "./workspace-guard.mjs";
import { buildArtifactDocument } from "./handoff-artifact.mjs";

const SNAPSHOT_TTL_MS = 1_000;
const MAX_PROJECT_INDEX_FILES = 800;
const MAX_INSTRUCTION_FILES = 4;
const MAX_INSTRUCTION_FILE_BYTES = 20_000;
const MAX_CONFIG_DEPTH = 3;
const MAX_CONFIG_FILES = 12;
const MAX_CONFIG_FILE_BYTES = 20_000;
const MAX_CONFIG_TOTAL_BYTES = 80_000;
const MAX_RELEVANT_FILES = 8;
const MAX_RELEVANT_FILE_BYTES = 24_000;
const MAX_RELEVANT_TOTAL_BYTES = 96_000;
const DEFAULT_PROJECT_CONTEXT_BYTES = 180_000;
const ABSOLUTE_PROJECT_CONTEXT_BYTES = 240_000;
const DEFAULT_GIT_DIFF_BYTES = 60_000;
const snapshotCache = new Map();

function projectName(projectPath) {
  return path.basename(String(projectPath).replace(/[\\/]$/, "")) || projectPath;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, Math.max(0, maxBytes));
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return { text: text.slice(0, end), truncated: true };
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

function fileDepth(relativePath) {
  return String(relativePath || "").split("/").length - 1;
}

function fileName(relativePath) {
  return path.posix.basename(String(relativePath || "").replaceAll("\\", "/"));
}

function readText(root, relativePath, maxBytes) {
  try {
    const file = assertReadableFile(root, relativePath, { maxBytes: ABSOLUTE_MAX_FILE_BYTES });
    const limit = Math.max(1, Number(maxBytes) || MAX_CONFIG_FILE_BYTES);
    const fd = fs.openSync(file.target, "r");
    const buffer = Buffer.alloc(Math.min(limit, file.stat.size));
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
    } finally {
      fs.closeSync(fd);
    }
    const clipped = truncateUtf8(buffer.subarray(0, offset).toString("utf8"), limit);
    return { text: clipped.text, truncated: file.stat.size > limit || clipped.truncated, size: file.stat.size };
  } catch {
    return null;
  }
}

function instructionPriority(relativePath) {
  const name = fileName(relativePath).toLocaleLowerCase();
  if (name === "agents.md") return 0;
  if (name === "readme.md") return 1;
  if (name === "contributing.md") return 2;
  if (name === "claude.md") return 3;
  if (name.startsWith("readme.")) return 4;
  return 5;
}

function isInstructionFile(relativePath) {
  return ["agents.md", "claude.md", "contributing.md", "readme.md"].includes(fileName(relativePath).toLocaleLowerCase())
    || fileName(relativePath).toLocaleLowerCase().startsWith("readme.");
}

function isConfigFile(relativePath) {
  const name = fileName(relativePath).toLocaleLowerCase();
  return name === "tsconfig.json" || name === "jsconfig.json" || name === "manifest.json"
    || /^vite\.config\./.test(name) || /^next\.config\./.test(name) || /^webpack\.config\./.test(name)
    || /^eslint\.config\./.test(name) || name.startsWith(".eslintrc") || name.startsWith(".prettierrc")
    || ["pyproject.toml", "requirements.txt", "cargo.toml", "go.mod", "dockerfile", "docker-compose.yml", "compose.yml", "makefile", "pnpm-workspace.yaml", "turbo.json", "nx.json"].includes(name);
}

function isPackageFile(relativePath) {
  return fileName(relativePath).toLocaleLowerCase() === "package.json";
}

function parsePackage(root, relativePath) {
  const raw = readText(root, relativePath, MAX_CONFIG_FILE_BYTES);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw.text);
    const map = (input) => input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return {
      path: relativePath,
      name: value.name || null,
      version: value.version || null,
      type: value.type || null,
      packageManager: value.packageManager || null,
      engines: map(value.engines),
      scripts: map(value.scripts),
      dependencies: map(value.dependencies),
      devDependencies: map(value.devDependencies),
      workspaces: value.workspaces || null,
      truncated: raw.truncated
    };
  } catch {
    return { path: relativePath, parseError: true, raw: raw.text, truncated: raw.truncated };
  }
}

function packageManagerName(value) {
  const match = String(value || "").trim().match(/^(pnpm|yarn|bun|npm)(?=@|$)/i);
  return match ? match[1].toLocaleLowerCase() : "";
}

function packageManagerFromFiles(files, packageFiles) {
  for (const item of packageFiles) {
    const value = packageManagerName(item.packageManager);
    if (value) return value;
  }
  const locks = new Map([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"]
  ]);
  for (const [name, manager] of locks) {
    if (files.some((file) => fileName(file.relativePath).toLocaleLowerCase() === name)) return manager;
  }
  return null;
}

function extractSessionPaths(messages, knownPaths, root) {
  // ponytail: token-based path extraction; expose structured tool args only if transcript needs that API later.
  const known = new Set(knownPaths);
  const found = new Set();
  const toolFound = new Set();
  const add = (value, target = found) => {
    const candidate = String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
    if (known.has(candidate)) target.add(candidate);
  };
  for (const message of messages || []) {
    const content = String(message?.content || "");
    const target = message?.type === "tool_call" ? toolFound : found;
    for (const token of content.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g) || []) add(token, target);
    if (root) {
      const absoluteRoot = `${root.replaceAll("\\", "/")}/`;
      for (const token of content.match(/\/[A-Za-z0-9._/-]+/g) || []) {
        if (token.startsWith(absoluteRoot)) add(token.slice(absoluteRoot.length), target);
      }
    }
  }
  return { paths: [...found], toolPaths: [...toolFound] };
}

function lineCount(value) {
  return String(value || "").split("\n").length;
}

const CORE_FILE_NAMES = new Set(["server.mjs", "background.js", "content.js", "sidepanel.js", "package.json", "manifest.json"]);

function taskTokens(value) {
  return String(value || "").toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
}

function buildRelevantFiles(root, walked, changedFiles, transcript, packageFiles, configs, instructions, task = "") {
  const entries = new Map(walked.files.map((file) => [file.relativePath, file]));
  const sessionPaths = extractSessionPaths(transcript?.messages, entries.keys(), root);
  const changed = new Set(changedFiles || []);
  const mentioned = new Set(sessionPaths.paths);
  const toolPaths = new Set(sessionPaths.toolPaths);
  const tokens = taskTokens(task);
  const reserved = new Set([
    ...packageFiles.map((item) => item.path),
    ...configs.map((item) => item.path),
    ...instructions.map((item) => item.path)
  ]);
  const candidatePaths = [...new Set([...changed, ...mentioned, ...toolPaths])]
    .filter((relativePath) => entries.has(relativePath) && !reserved.has(relativePath) && !isBinaryFile(relativePath));
  const candidates = candidatePaths.map((relativePath) => {
    const name = fileName(relativePath).toLocaleLowerCase();
    const pathValue = relativePath.toLocaleLowerCase();
    const reasons = [];
    let score = 0;
    if (changed.has(relativePath)) { score += 100; reasons.push("git-changed"); }
    if (mentioned.has(relativePath)) { score += 90; reasons.push("session-mentioned"); }
    if (toolPaths.has(relativePath)) { score += 80; reasons.push("recent-tool-call"); }
    if (tokens.some((token) => pathValue.includes(token))) { score += 50; reasons.push("task-match"); }
    if (CORE_FILE_NAMES.has(name)) { score += 30; reasons.push("core-architecture"); }
    return { relativePath, score, reasons };
  }).sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  const relevant = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (relevant.length >= MAX_RELEVANT_FILES) break;
    const relativePath = candidate.relativePath;
    const entry = entries.get(relativePath);
    const remaining = MAX_RELEVANT_TOTAL_BYTES - totalBytes;
    if (remaining <= 0) break;
    const limit = Math.min(MAX_RELEVANT_FILE_BYTES, remaining);
    const content = readText(root, relativePath, limit);
    const size = entry?.size ?? content?.size ?? null;
    if (!content) continue;
    relevant.push({
      path: relativePath,
      size,
      lines: lineCount(content.text),
      content: content.text,
      truncated: content.truncated,
      score: candidate.score,
      reasons: candidate.reasons
    });
    totalBytes += Buffer.byteLength(content.text, "utf8");
  }
  return { files: relevant, candidateCount: candidates.length };
}

export function buildProjectProfile({ projectPath, sessionId = "", transcript = null, git = null, task = "" } = {}) {
  const root = assertContextReadable(projectPath);
  const walked = walkReadableFiles(root, MAX_PROJECT_INDEX_FILES, { countAll: true });
  const files = walked.files.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const instructionFiles = files.filter((file) => isInstructionFile(file.relativePath))
    .sort((a, b) => instructionPriority(a.relativePath) - instructionPriority(b.relativePath) || a.relativePath.localeCompare(b.relativePath))
    .slice(0, MAX_INSTRUCTION_FILES);
  const instructions = instructionFiles.map((file) => {
    const content = readText(root, file.relativePath, MAX_INSTRUCTION_FILE_BYTES);
    return content ? { path: file.relativePath, content: content.text, truncated: content.truncated } : null;
  }).filter(Boolean);
  const packageFiles = files.filter((file) => isPackageFile(file.relativePath) && fileDepth(file.relativePath) <= MAX_CONFIG_DEPTH)
    .slice(0, MAX_CONFIG_FILES).map((file) => parsePackage(root, file.relativePath)).filter(Boolean);
  const configFiles = files.filter((file) => !isPackageFile(file.relativePath) && isConfigFile(file.relativePath) && fileDepth(file.relativePath) <= MAX_CONFIG_DEPTH)
    .slice(0, Math.max(0, MAX_CONFIG_FILES - packageFiles.length));
  const configs = [];
  let configBytes = 0;
  for (const file of configFiles) {
    if (configBytes >= MAX_CONFIG_TOTAL_BYTES) break;
    const content = readText(root, file.relativePath, Math.min(MAX_CONFIG_FILE_BYTES, MAX_CONFIG_TOTAL_BYTES - configBytes));
    if (!content) continue;
    configs.push({ path: file.relativePath, content: content.text, truncated: content.truncated });
    configBytes += Buffer.byteLength(content.text, "utf8");
  }
  const status = git || getGitStatus(root);
  const languages = {};
  for (const file of files) {
    const extension = path.posix.extname(file.relativePath).toLocaleLowerCase() || "[no extension]";
    languages[extension] = (languages[extension] || 0) + 1;
  }
  const indexedPaths = new Set(files.map((file) => file.relativePath));
  const changedFiles = (status.changedReadableFiles || status.changedFiles || []).filter((item) => indexedPaths.has(item));
  const relevant = buildRelevantFiles(root, walked, changedFiles, transcript, packageFiles, configs, instructions, task);
  return {
    name: projectName(root),
    stats: { files: walked.totalFiles, indexedFiles: files.length, truncated: walked.truncated },
    structure: files.map((file) => file.relativePath),
    packageFiles,
    instructions,
    configs,
    languages,
    changedFiles,
    relevantFiles: relevant.files,
    relevantCandidateCount: relevant.candidateCount,
    relevantFilesTruncated: relevant.files.filter((item) => item.truncated).length,
    projectType: status.isGitRepo ? "Git repository" : "Local project",
    sessionId: sessionId || null
  };
}

export function buildEnvironmentProfile({ projectPath, projectFiles = [], packageFiles = [], runtimeInfo = null, workspaceName = "" } = {}) {
  const root = assertContextReadable(projectPath);
  const files = projectFiles.length ? projectFiles : walkReadableFiles(root, MAX_PROJECT_INDEX_FILES, { countAll: false }).files;
  const runtimeHints = {};
  for (const name of [".nvmrc", ".node-version", ".tool-versions", ".python-version"]) {
    const file = files.find((item) => item.relativePath === name);
    if (!file) continue;
    const content = readText(root, name, MAX_INSTRUCTION_FILE_BYTES);
    if (content?.text) runtimeHints[name] = content.text.trim();
  }
  const safeCodex = runtimeInfo && typeof runtimeInfo === "object" ? {
    found: Boolean(runtimeInfo.found),
    version: runtimeInfo.version || null,
    source: runtimeInfo.source || null,
    capabilities: runtimeInfo.capabilities && typeof runtimeInfo.capabilities === "object" ? runtimeInfo.capabilities : {},
    desktop: { found: Boolean(runtimeInfo.desktop?.found || runtimeInfo.desktopFound) }
  } : { found: false, version: null, source: null, capabilities: {}, desktop: { found: false } };
  return {
    workspace: workspaceName || projectName(root),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    packageManager: packageManagerFromFiles(files, packageFiles),
    runtimeHints,
    codex: safeCodex
  };
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

function formatMap(value) {
  return Object.entries(value || {}).map(([key, item]) => `- ${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`);
}

function packageText(item) {
  if (item.parseError) return [`## ${item.path}`, "", "Unable to parse package.json; raw content:", item.raw || ""].join("\n");
  return [
    `## ${item.path}`,
    `Package: ${item.name || "unknown"}`,
    item.version ? `Version: ${item.version}` : "",
    item.type ? `Type: ${item.type}` : "",
    item.packageManager ? `Package manager: ${item.packageManager}` : "",
    Object.keys(item.engines || {}).length ? `Engines:\n${formatMap(item.engines).join("\n")}` : "",
    Object.keys(item.scripts || {}).length ? `Scripts:\n${formatMap(item.scripts).join("\n")}` : "",
    Object.keys(item.dependencies || {}).length ? `Dependencies:\n${formatMap(item.dependencies).join("\n")}` : "",
    Object.keys(item.devDependencies || {}).length ? `Dev dependencies:\n${formatMap(item.devDependencies).join("\n")}` : "",
    item.workspaces ? `Workspaces: ${JSON.stringify(item.workspaces)}` : ""
  ].filter(Boolean).join("\n");
}

function languagesText(languages) {
  const labels = { ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".jsx": "JavaScript", ".css": "CSS", ".html": "HTML", ".json": "JSON", ".py": "Python", ".rs": "Rust", ".go": "Go", ".swift": "Swift" };
  const totals = {};
  for (const [extension, count] of Object.entries(languages || {})) {
    const label = labels[extension] || extension;
    totals[label] = (totals[label] || 0) + count;
  }
  return Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `- ${name}: ${count} files`);
}

function projectText(profile) {
  const stats = profile.stats || {};
  return [
    "# Project",
    "",
    `Name: ${profile.name}`,
    `Project type: ${profile.projectType || "Local project"}`,
    `Files: ${stats.files} total · ${stats.indexedFiles} indexed`,
    stats.truncated ? `Project index truncated: ${stats.indexedFiles} / ${stats.files} files` : "",
    profile.changedFiles?.length ? `Changed files: ${profile.changedFiles.length}` : "Changed files: 0",
    "",
    "## Languages",
    ...(languagesText(profile.languages).length ? languagesText(profile.languages) : ["- No recognized file extensions."])
  ].join("\n");
}

function environmentText(environment) {
  const codex = environment.codex || {};
  const capabilities = Object.entries(codex.capabilities || {}).filter(([, value]) => value).map(([key]) => key).join(", ") || "none";
  return [
    "# Local environment",
    "",
    `Workspace: ${environment.workspace || "unknown"}`,
    `Platform: ${environment.platform}`,
    `Architecture: ${environment.arch}`,
    `Node: ${environment.node}`,
    `Package manager: ${environment.packageManager || "unknown"}`,
    `Codex: ${codex.found ? "available" : "not found"}${codex.version ? ` · ${codex.version}` : ""}${codex.source ? ` · ${codex.source}` : ""}`,
    `Codex capabilities: ${capabilities}`,
    `Codex Desktop: ${codex.desktop?.found ? "available" : "not found"}`,
    Object.keys(environment.runtimeHints || {}).length ? `\nRuntime constraints:\n${Object.entries(environment.runtimeHints).map(([name, value]) => `- ${name}: ${value}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function instructionText(instructions) {
  return ["# Project instructions", ...(instructions?.length ? instructions.flatMap((item) => [`\n## ${item.path}`, "", item.content]) : ["\nNo project instruction files found."])].join("\n");
}

function structureText(profile) {
  return ["# Project structure", "", ...(profile.structure?.length ? profile.structure : ["No readable project files found."])].join("\n");
}

function packagesText(profile) {
  return ["# Packages", ...(profile.packageFiles?.length ? profile.packageFiles.flatMap((item) => ["", packageText(item)]) : ["\nNo package.json files found."])].join("\n");
}

function configsText(profile) {
  return ["# Key configuration", ...(profile.configs?.length ? profile.configs.flatMap((item) => [`\n## ${item.path}`, "", item.content]) : ["\nNo supported configuration files found."])].join("\n");
}

function currentTaskText(session, snapshot, transcript) {
  const task = snapshot?.task || [...(transcript?.messages || [])].reverse().find((item) => item.role === "user")?.content || "No current Codex task selected.";
  return [
    "# Current Codex task",
    "",
    `Session: ${session?.title || session?.id || "none"}`,
    `Status: ${session?.status || "unknown"}`,
    `Current task: ${task}`
  ].join("\n");
}

function progressText(snapshot) {
  if (!snapshot) return "# Recent progress\n\nNo Codex session progress selected.";
  return [
    "# Recent progress",
    "",
    ...(snapshot.recentActions?.length ? snapshot.recentActions.map((item) => `- ${item.content}`) : ["- No recent tool calls." ]),
    "",
    "Recent errors:",
    ...(snapshot.errors?.length ? snapshot.errors.map((item) => `- ${item}`) : ["- No visible errors."])
  ].join("\n");
}

function relevantText(profile) {
  const lines = ["# Relevant files", ""];
  if (!profile.relevantFiles?.length) return `${lines.join("\n")}No relevant files selected.`;
  for (const file of profile.relevantFiles) {
    lines.push(`## ${file.path}`);
    lines.push(`Score: ${file.score ?? 0} · Reasons: ${(file.reasons || []).join(", ") || "none"}`);
    lines.push(`Size: ${file.size ?? "unknown"} bytes · Lines: ${file.lines ?? "unknown"}`);
    if (file.content == null) lines.push("Content unavailable; inspect this path if needed.");
    else lines.push("", "```", file.content, "```");
    if (file.truncated) lines.push("Content truncated.");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function gitText(git) {
  if (!git?.isGitRepo) return "# Git Status\n\nThis project is not a Git repository.";
  return [
    "# Git Status",
    "",
    `Branch: ${git.branch || "unknown"}`,
    git.changedFiles?.length ? `\nChanged files:\n${git.changedFiles.map((item) => `- ${item}`).join("\n")}` : "\nNo changed files.",
    git.stagedFiles?.length ? `\nStaged:\n${git.stagedFiles.map((item) => `- ${item}`).join("\n")}` : "",
    git.diff ? `\n## Current diff\n${git.diff}` : "",
    git.stagedDiff ? `\n## Staged diff\n${git.stagedDiff}` : ""
  ].filter(Boolean).join("\n");
}

function transcriptText(transcript) {
  return `# Session transcript\n\n${transcript?.text || "No visible transcript."}`;
}

function metadataText(context, maxBytes, actualBytes = "000000", complete = null) {
  const project = context.project || {};
  const relevant = project.relevantFiles || [];
  return [
    "# Context Metadata",
    "",
    "schema: sol-project-context/v2",
    `complete: ${complete == null ? !project.stats?.truncated : complete}`,
    `truncated: ${Boolean(project.stats?.truncated)}`,
    `relevant_files: ${relevant.length}`,
    `relevant_files_truncated: ${relevant.filter((item) => item.truncated).length}`,
    `session_attached: ${Boolean(context.session)}`,
    `git_attached: ${Boolean(context.git)}`,
    "sensitive_files_excluded: true",
    `context_bytes: ${actualBytes}`,
    `context_limit: ${maxBytes}`
  ].join("\n");
}

function bundleText(context, maxBytes) {
  const prefix = `${context.project?.stats ? "[Sol Project Context]" : "[Sol → Codex Local Context]"}\n\nCaptured: ${context.capturedAt}`;
  const suffix = "[End Sol Project Context]";
  const sections = [
    ["project", context.project?.stats ? projectText(context.project) : `# Project\n\nName: ${context.project?.name || "unknown"}`],
    ["environment", context.environment ? environmentText(context.environment) : ""],
    ["task", currentTaskText(context.session, context.snapshot, context.transcript)],
    ["progress", progressText(context.snapshot)],
    ["git", context.git ? gitText(context.git) : ""],
    ["instructions", context.project?.stats ? instructionText(context.project.instructions) : ""],
    ["packages", context.project?.stats ? packagesText(context.project) : ""],
    ["configs", context.project?.stats ? configsText(context.project) : ""],
    ["structure", context.project?.stats ? structureText(context.project) : ""],
    ["relevantFiles", context.project?.stats ? relevantText(context.project) : ""],
    ["transcript", context.transcript ? transcriptText(context.transcript) : ""]
  ].filter(([, value]) => value);
  const metadataPlaceholder = context.project?.stats ? metadataText(context, maxBytes) : "";
  const fixedBytes = Buffer.byteLength(`${prefix}\n\n${suffix}`, "utf8") + (metadataPlaceholder ? Buffer.byteLength(`\n\n${metadataPlaceholder}`, "utf8") : 0);
  let remaining = Math.max(0, maxBytes - fixedBytes);
  const output = [prefix];
  const truncatedSections = [];
  for (let index = 0; index < sections.length; index += 1) {
    const [name, value] = sections[index];
    if (remaining <= 0) {
      truncatedSections.push(...sections.slice(index).map(([section]) => section));
      break;
    }
    const full = `\n\n${value}`;
    const bytes = Buffer.byteLength(full, "utf8");
    if (bytes <= remaining) {
      output.push(full);
      remaining -= bytes;
      continue;
    }
    const clipped = truncateUtf8(full, remaining).text;
    if (clipped) output.push(clipped);
    truncatedSections.push(name, ...sections.slice(index + 1).map(([section]) => section));
    remaining = 0;
    break;
  }
  output.push(metadataPlaceholder ? `\n\n${metadataPlaceholder}` : "", `\n\n${suffix}`);
  let text = output.join("");
  const limits = { bytes: Buffer.byteLength(text, "utf8"), maxBytes, truncated: truncatedSections.length > 0, truncatedSections: [...new Set(truncatedSections)] };
  if (metadataPlaceholder) {
    const complete = !limits.truncated && !context.project.stats.truncated;
    const actual = String(limits.bytes).padStart(6, "0");
    const finalMetadata = metadataText(context, maxBytes, actual, complete);
    const index = text.lastIndexOf(metadataPlaceholder);
    if (index >= 0) text = text.slice(0, index) + finalMetadata + text.slice(index + metadataPlaceholder.length);
    context.metadata = {
      schema: "sol-project-context/v2",
      projectContextComplete: complete,
      projectIndexTruncated: Boolean(context.project.stats.truncated),
      relevantFiles: context.project.relevantFiles?.length || 0,
      relevantFilesTruncated: context.project.relevantFiles?.filter((item) => item.truncated).length || 0,
      sessionAttached: Boolean(context.session),
      gitAttached: Boolean(context.git),
      sensitiveFilesExcluded: true,
      contextBytes: limits.bytes,
      contextLimit: maxBytes
    };
    limits.bytes = Buffer.byteLength(text, "utf8");
  }
  return { text, limits };
}

function filenamePart(value) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "project";
}

function localTimestamp(value) {
  const date = new Date(value);
  const pad = (item) => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function frontMatterValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").replace(/[:#]/g, "-").trim() || "unknown";
}

function redactAttachmentText(value, context) {
  let result = String(value || "");
  for (const root of [context.projectRoot, context.workspaceRoot, process.env.HOME].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(String(root), "<local-path>");
  }
  return result;
}

function projectContextFile(context, text, capturedAt) {
  const profile = context.project || {};
  const project = frontMatterValue(profile.name || "project");
  const branch = frontMatterValue(context.git?.branch || context.session?.gitBranch || "unknown");
  const dirty = Boolean(context.git?.changedFiles?.length || context.git?.stagedFiles?.length);
  const content = buildArtifactDocument({
    schema: "sol-project-context/v2",
    metadata: {
      captured_at: new Date(capturedAt).toISOString(),
      project,
      project_type: profile.projectType === "Git repository" ? "git" : "local",
      branch,
      dirty,
      session_attached: Boolean(context.session),
      sensitive_files_excluded: true
    },
    text: redactAttachmentText(text, context)
  });
  return {
    filename: `Sol-Project-Context_${filenamePart(profile.name)}_${localTimestamp(capturedAt)}.md`,
    mimeType: "text/markdown",
    text: content,
    size: Buffer.byteLength(content, "utf8"),
    capturedAt,
    projectName: profile.name || "project"
  };
}

export function buildContextBundle({ projectPath, workspaceRoot = "", sessionId = "", parts = null, profile = "", options = {}, runtimeInfo = null } = {}) {
  const root = assertContextReadable(projectPath);
  const workspace = String(workspaceRoot || root);
  const requested = [...new Set(Array.isArray(parts) ? parts : [])];
  const allowed = new Set(["project", "environment", "snapshot", "transcript", "git"]);
  if (!requested.length) {
    requested.push("project", "environment", "git");
    if (sessionId) requested.push("snapshot", "transcript");
  }
  if (profile === "project") {
    if (!requested.includes("project")) requested.unshift("project");
    if (!requested.includes("environment")) requested.splice(1, 0, "environment");
  }
  if (requested.some((part) => !allowed.has(part))) throw Object.assign(new Error("Context bundle part 无效"), { status: 400, code: "CONTEXT_PART_INVALID" });

  const snapshot = requested.includes("snapshot") && sessionId ? buildSessionSnapshot({ projectPath: root, sessionId }) : null;
  const transcript = requested.includes("transcript") && sessionId ? readTranscript({
    sessionId,
    projectPath: root,
    maxMessages: options.transcriptMessages || 30,
    maxTotalBytes: options.transcriptBytes || 40_000,
    excludeToolOutputs: options.excludeToolOutputs !== false,
    maxToolOutputBytes: options.maxToolOutputBytes || 12_000
  }) : null;
  const session = snapshot?.session || transcript?.session || (sessionId && requested.includes("project") ? readTranscript({ sessionId, projectPath: root, maxMessages: 1, maxTotalBytes: 1_000, excludeToolOutputs: true }).session : null);
  const git = requested.includes("git") || requested.includes("project") ? getGitDiff(root, { maxBytes: options.gitBytes || DEFAULT_GIT_DIFF_BYTES }) : null;
  const profileTranscript = transcript || (sessionId && requested.includes("project") ? readTranscript({ sessionId, projectPath: root, maxMessages: 30, maxTotalBytes: 40_000, excludeToolOutputs: true }) : null);
  const task = snapshot?.task || [...(profileTranscript?.messages || [])].reverse().find((item) => item.role === "user")?.content || "";
  const project = requested.includes("project") ? buildProjectProfile({ projectPath: root, sessionId, transcript: profileTranscript, git, task }) : { name: projectName(root) };
  const environment = requested.includes("environment") ? buildEnvironmentProfile({ projectPath: root, projectFiles: requested.includes("project") ? project.structure.map((relativePath) => ({ relativePath })) : [], packageFiles: project.packageFiles || [], runtimeInfo, workspaceName: projectName(workspace) }) : null;
  const capturedAt = new Date().toISOString();
  const context = {
    schema: profile === "project" ? "sol-project-context/v2" : null,
    workspaceRoot: workspace,
    projectRoot: root,
    workspace: { name: projectName(workspace) },
    project,
    environment,
    session,
    snapshot,
    transcript,
    git,
    capturedAt,
    limits: null,
    metadata: null
  };
  const maxBytes = Math.min(ABSOLUTE_PROJECT_CONTEXT_BYTES, Math.max(1, Number(options.maxBytes) || DEFAULT_PROJECT_CONTEXT_BYTES));
  const rendered = bundleText(context, maxBytes);
  context.limits = rendered.limits;
  const result = { context, text: rendered.text, limits: rendered.limits, capturedAt };
  if (profile === "project" && options.includeFile !== false) result.file = projectContextFile(context, rendered.text, capturedAt);
  return result;
}

export function buildProjectContextFile(options = {}) {
  const result = buildContextBundle({ ...options, profile: "project", options: { ...(options.options || {}), includeFile: false } });
  return projectContextFile(result.context, result.text, result.capturedAt);
}
