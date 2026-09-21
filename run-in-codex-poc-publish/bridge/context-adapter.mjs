import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pocRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const bridgeRoot = process.env.SOL_CODEX_BRIDGE_ROOT
  || path.resolve(pocRoot, "../../ChatGPT-with-Codex/sol-codex-bridge");

let modulesPromise;

async function modules() {
  modulesPromise ||= Promise.all([
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/context-bundle.mjs")).href),
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/codex-transcript.mjs")).href),
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/project-context.mjs")).href),
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/project-files.mjs")).href),
    import(pathToFileURL(path.join(bridgeRoot, "bridge/lib/workspace-guard.mjs")).href),
  ]);
  const [bundle, transcript, projectContext, projectFiles, guard] = await modulesPromise;
  return { bundle, transcript, projectContext, projectFiles, guard };
}

function projectPathOf(body = {}) {
  const projectPath = String(body.projectPath || "").trim();
  if (!projectPath) throw Object.assign(new Error("缺少 projectPath"), { status: 400, code: "PROJECT_PATH_REQUIRED" });
  return projectPath;
}

function sessionIdOf(body = {}) {
  const sessionId = String(body.sessionId || "").trim();
  if (!sessionId) throw Object.assign(new Error("缺少 sessionId"), { status: 400, code: "SESSION_ID_REQUIRED" });
  return sessionId;
}

export async function getProjectContext(body = {}) {
  const { bundle } = await modules();
  return bundle.buildContextBundle({
    projectPath: projectPathOf(body),
    sessionId: String(body.sessionId || "").trim(),
    profile: "project",
    options: { includeFile: true },
  });
}

export async function getSessionTranscript(body = {}) {
  const { transcript } = await modules();
  return transcript.readTranscript({
    projectPath: projectPathOf(body),
    sessionId: sessionIdOf(body),
    direction: body.direction || "tail",
    maxMessages: body.maxMessages || undefined,
    maxTotalBytes: body.maxTotalBytes || undefined,
    maxToolOutputBytes: body.maxToolOutputBytes || undefined,
    excludeToolOutputs: body.excludeToolOutputs === true,
  });
}

export async function getSnapshot(body = {}) {
  const { bundle } = await modules();
  return bundle.buildSessionSnapshot({
    projectPath: projectPathOf(body),
    sessionId: sessionIdOf(body),
  });
}

export async function getGitDiff(body = {}) {
  const { projectContext } = await modules();
  return projectContext.getGitDiff(projectPathOf(body));
}

export async function listFiles(body = {}) {
  const { projectFiles } = await modules();
  return projectFiles.listProjectDirectory(projectPathOf(body), body.relativePath || "");
}

export async function readFile(body = {}) {
  const { projectFiles } = await modules();
  return projectFiles.readProjectFile(projectPathOf(body), body.relativePath || "");
}

export async function getPermission(body = {}) {
  const { guard } = await modules();
  return guard.readPermission(projectPathOf(body));
}

export async function setPermission(body = {}) {
  const { guard } = await modules();
  if (typeof body.allowed !== "boolean") {
    throw Object.assign(new Error("allowed 必须是布尔值"), { status: 400, code: "PERMISSION_VALUE_INVALID" });
  }
  return guard.setReadPermission(projectPathOf(body), body.allowed);
}
