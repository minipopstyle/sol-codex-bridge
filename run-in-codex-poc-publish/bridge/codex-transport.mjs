import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pocRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeRoot = process.env.SOL_CODEX_BRIDGE_ROOT || path.resolve(pocRoot, "../../ChatGPT-with-Codex/sol-codex-bridge");
const projectPath = process.env.C2C_PROJECT_PATH || path.resolve(pocRoot, "..");

let modulesPromise;

async function modules() {
  modulesPromise ||= Promise.all([
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/codex-cli.mjs")).href),
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/codex-state.mjs")).href),
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/handoff-payload.mjs")).href),
  ]);
  const [cli, state, handoff] = await modulesPromise;
  return { cli, state, handoff };
}

function prepareTaskPayload(handoff, task, root, sessionId = "") {
  return handoff.prepareHandoffPayload({
    text: task.text,
    projectPath: root,
    sessionId,
    source: {
      type: task.source || "chatgpt",
      pageUrl: task.pageUrl || "",
      conversationTitle: task.conversationTitle || "",
    },
    transferMode: task.transferMode,
  });
}

export function targetProjectPath(task = {}) {
  const requested = String(task.projectPath || "").trim();
  if (requested) return path.resolve(requested);
  if (String(task.workspace || "").trim() === path.basename(projectPath)) return projectPath;
  throw new Error(`找不到工作区对应的项目路径：${task.workspace || ""}`);
}

function assertKnownProject(state, root) {
  if (!state.isKnownProject(root)) throw new Error(`目标项目未被 Codex 识别：${root}`);
}

export function chooseSession(sessions, requestedId = "") {
  const list = Array.isArray(sessions) ? sessions : [];
  const id = String(requestedId).trim();
  if (!id) throw new Error("发送到已有会话前必须明确选择 Codex Session");
  const requested = list.find((session) => session.id === id);
  if (requested) return requested;
  throw new Error(`目标 Codex Session 不属于当前项目：${id}`);
}

export function openTargetSession(openSession, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return { desktopOpened: false, openWarning: "缺少 Codex 会话 ID" };
  try {
    return { desktopOpened: true, openWarning: null, desktop: openSession(id) };
  } catch (error) {
    return { desktopOpened: false, openWarning: error?.message || String(error) };
  }
}

export function openTargetProject(openProject, projectPath) {
  const path = String(projectPath || "").trim();
  if (!path) return { desktopOpened: false, openWarning: "缺少 Codex 项目路径" };
  try {
    return { desktopOpened: true, openWarning: null, desktop: openProject(path) };
  } catch (error) {
    return { desktopOpened: false, openWarning: error?.message || String(error) };
  }
}

export function scheduleTargetSessionOpen(finished, openSession, sessionId) {
  if (!finished || typeof finished.then !== "function") return false;
  void finished.then((completed) => {
    if (completed) openTargetSession(openSession, sessionId);
  }).catch(() => {});
  return true;
}

export async function sendToCurrentSession(task) {
  const { cli, state, handoff } = await modules();
  const root = targetProjectPath(task);
  assertKnownProject(state, root);
  const discovered = state.discoverSessions(root);
  const session = chooseSession(discovered.sessions, String(task.sessionId || "").trim());
  if (!session) throw new Error(`项目没有可用的 Codex Session：${root}`);
  const payload = prepareTaskPayload(handoff, task, root, session.id);

  const info = cli.getCodexInfo({ fresh: true });
  const result = info.capabilities?.queueCli
    ? cli.queueViaCli(session.id, payload.codexPrompt, info, root)
    : await cli.queueToSession(session.id, payload.codexPrompt, { projectPath: root });
  return {
    ...result,
    ...openTargetSession(cli.openSessionInCodex, session.id),
    projectPath: root,
    sessionId: session.id,
    transferMode: payload.transferMode,
    payload: { mode: payload.mode, artifact: payload.artifact },
  };
}

export async function sendToNewTask(task) {
  const { cli, state, handoff } = await modules();
  const root = targetProjectPath(task);
  assertKnownProject(state, root);
  const info = cli.getCodexInfo({ fresh: true });
  if (!info.capabilities?.exec) throw new Error("当前 Codex CLI 不支持创建新任务");
  const payload = prepareTaskPayload(handoff, task, root);
  const projectNavigation = openTargetProject(cli.openProjectInCodex, root);
  const result = await cli.launchNewTask(root, payload.codexPrompt);
  const navigationScheduled = scheduleTargetSessionOpen(result.finished, cli.openSessionInCodex, result.sessionId);
  return {
    ...result,
    ...projectNavigation,
    ...(navigationScheduled
      ? { desktopOpened: null, openWarning: null }
      : openTargetSession(cli.openSessionInCodex, result.sessionId)),
    projectPath: root,
    sessionId: result.sessionId || null,
    transferMode: payload.transferMode,
    payload: { mode: payload.mode, artifact: payload.artifact },
  };
}

export async function sendTask(task) {
  return String(task.mode || "queue") === "new"
    ? sendToNewTask(task)
    : sendToCurrentSession(task);
}

export async function discoverTargets() {
  const { state } = await modules();
  const discovered = state.discoverProjects();
  return {
    projects: discovered.projects.map((project) => ({
      ...project,
      sessions: state.discoverSessions(project.path).sessions,
    })),
    metadata: discovered.metadata,
  };
}

export { bridgeRoot, projectPath };
