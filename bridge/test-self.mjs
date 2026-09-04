import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sol-codex-bridge-test-"));
const codexHome = path.join(temp, ".codex");
const sessionsDir = path.join(codexHome, "sessions", "2026", "09", "01");
fs.mkdirSync(sessionsDir, { recursive: true });
const project = path.join(temp, "agent-workbench");
fs.mkdirSync(project);
const session = path.join(sessionsDir, "rollout-test-session.jsonl");
fs.writeFileSync(session, [
  JSON.stringify({ timestamp: "2026-09-01T10:00:00Z", type: "session_meta", payload: { id: "01a-test-session", cwd: project, model_provider: "openai" } }),
  JSON.stringify({ timestamp: "2026-09-01T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: "实现 Trace Compare 本地会话发现" } })
].join("\n") + "\n");

const script = `
  const m = await import(${JSON.stringify(new URL("./lib/codex-state.mjs", import.meta.url).href)});
  const p = m.discoverProjects();
  const s = m.discoverSessions(${JSON.stringify(project)});
  console.log(JSON.stringify({p,s}));
`;
const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
  env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: path.join(temp, "missing"), SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge") },
  encoding: "utf8"
});
assert.equal(child.status, 0, child.stderr);
const data = JSON.parse(child.stdout.trim());
const normalizedProject = fs.realpathSync(project);
assert.ok(data.p.projects.some((item) => item.path === normalizedProject), "project not discovered");
assert.ok(data.s.sessions.some((item) => item.id === "01a-test-session"), "session not discovered");


// Regression: a queue-capable CLI must handle the existing-session handoff
// when daemon/state DB transports are unavailable.
const newBin = path.join(temp, "new-codex");
fs.writeFileSync(newBin, `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.151.0-alpha.7.2' ;;
  --help) printf 'Codex CLI\n\nCommands:\n  exec    Run\n  queue   Queue\n  fork    Fork\n  app     App\n' ;;
  exec)
    if [ "$2" = '--help' ]; then
      printf 'Commands:\n  resume  Resume\n'
    elif [ "$2" = 'resume' ]; then
      printf '{"type":"thread.started","thread_id":"%s"}\n' "$4"
    elif case " $* " in *" --json "*) true;; *) false;; esac; then
      printf '{"type":"thread.started","thread_id":"019f-new-task"}\n'
    fi
    ;;
  queue) printf 'queued %s\n' "$3" ;;
esac
`, { mode: 0o755 });
const cliScript = `
  const m = await import(${JSON.stringify(new URL("./lib/codex-cli.mjs", import.meta.url).href)});
  const info = m.getCodexInfo({fresh:true});
  if (!info.capabilities.queueCli) throw new Error("queue-capable candidate was not selected: " + JSON.stringify(info));
  const queued = await m.queueToSession("019f-test", "Bridge regression probe", {projectPath:${JSON.stringify(project)}});
  const threadUrl = m.codexThreadUrl("019f-test/thread");
  console.log(JSON.stringify({info,queued,threadUrl}));
`;
const cliChild = spawnSync(process.execPath, ["--input-type=module", "-e", cliScript], {
  env: {
    ...process.env,
    CODEX_BIN: newBin,
    SOL_CODEX_EXTRA_BINS: newBin,
    SOL_CODEX_FORCE_BIN: "1",
    SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-cli"),
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: path.join(temp, "missing")
  },
  encoding: "utf8"
});
assert.equal(cliChild.status, 0, cliChild.stderr);
const cliData = JSON.parse(cliChild.stdout.trim());
assert.equal(cliData.info.capabilities.queueCli, true);
assert.equal(cliData.queued.transport, "codex-exec-resume");
assert.equal(cliData.threadUrl, "codex://threads/019f-test%2Fthread");

const newTaskScript = `
  const m = await import(${JSON.stringify(new URL("./lib/codex-cli.mjs", import.meta.url).href)});
  const launched = await m.launchNewTask(${JSON.stringify(project)}, "Bridge new-task regression probe");
  console.log(JSON.stringify({...launched, finished: await launched.finished}));
`;
const newTaskChild = spawnSync(process.execPath, ["--input-type=module", "-e", newTaskScript], {
  env: {
    ...process.env,
    CODEX_BIN: newBin,
    SOL_CODEX_EXTRA_BINS: newBin,
    SOL_CODEX_FORCE_BIN: "1",
    SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-new-task"),
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: path.join(temp, "missing")
  },
  encoding: "utf8"
});
assert.equal(newTaskChild.status, 0, newTaskChild.stderr);
const newTask = JSON.parse(newTaskChild.stdout.trim());
assert.equal(newTask.transport, "codex-exec");
assert.equal(newTask.sessionId, "019f-new-task");
assert.equal(newTask.finished, true);

// Desktop-only invariant: Bridge source must not launch Terminal/TUI.
const cliSource = fs.readFileSync(new URL("./lib/codex-cli.mjs", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
assert.doesNotMatch(cliSource, /tell application ["']Terminal["']/);
assert.doesNotMatch(cliSource, /do script/);
assert.match(cliSource, /function queueViaCli/);
assert.match(serverSource, /launched\.finished\.then/);
assert.doesNotMatch(serverSource, /launched\.ready/);
assert.doesNotMatch(serverSource, /Access-Control-Allow-Origin/);
const desktopSource = fs.readFileSync(new URL("./lib/codex-desktop.mjs", import.meta.url), "utf8");
const injectorSource = fs.readFileSync(new URL("./desktop-injector.applescript", import.meta.url), "utf8");
assert.match(desktopSource, /Sol Codex Bridge\.app/);
assert.match(injectorSource, /CODEX_COMPOSER_NOT_FOUND/);
assert.doesNotMatch(injectorSource, /on run argv/);
assert.match(injectorSource, /com\.openai\.chat/);

// Regression: when Desktop already has the target thread open, Bridge can write
// Codex's durable user queue directly without loading config.toml/model providers.
let TestDatabaseSync = null;
try { ({ DatabaseSync: TestDatabaseSync } = await import("node:sqlite")); } catch {}
if (TestDatabaseSync) {
  // Project pages omit internal guardian threads and sessions placed in another
  // sidebar section (such as Pinned); Bridge must match that visible list.
  const visibilityHome = path.join(temp, "visibility-home");
  fs.mkdirSync(visibilityHome, { recursive: true });
  const visibilityDb = new TestDatabaseSync(path.join(visibilityHome, "state_5.sqlite"));
  visibilityDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, name TEXT, archived INTEGER,
      thread_source TEXT, thread_section_id TEXT, updated_at_ms INTEGER
    );
    INSERT INTO threads VALUES ('visible', '${project.replaceAll("'", "''")}', 'Raw title', 'Visible in Codex', 0, 'user', NULL, 3);
    INSERT INTO threads VALUES ('guardian', '${project.replaceAll("'", "''")}', 'Guardian', NULL, 0, 'guardian_review', NULL, 2);
    INSERT INTO threads VALUES ('pinned', '${project.replaceAll("'", "''")}', 'Pinned', NULL, 0, 'user', 'pinned-section', 1);
  `);
  visibilityDb.close();
  const visibilityScript = `
    const m = await import(${JSON.stringify(new URL("./lib/codex-state.mjs", import.meta.url).href)});
    console.log(JSON.stringify(m.discoverSessions(${JSON.stringify(project)}).sessions.map(({ id, title }) => ({ id, title }))));
  `;
  const visibilityChild = spawnSync(process.execPath, ["--input-type=module", "-e", visibilityScript], {
    env: {
      ...process.env,
      CODEX_HOME: visibilityHome,
      CODEX_SQLITE_HOME: visibilityHome,
      SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-visibility")
    },
    encoding: "utf8"
  });
  assert.equal(visibilityChild.status, 0, visibilityChild.stderr);
  assert.deepEqual(JSON.parse(visibilityChild.stdout.trim()), [{ id: "visible", title: "Visible in Codex" }]);

  // When Codex exposes its Projects sidebar, do not turn every historical
  // thread cwd into another project, and preserve the sidebar's order.
  const projectListHome = path.join(temp, "project-list-home");
  fs.mkdirSync(projectListHome, { recursive: true });
  const projectListDb = new TestDatabaseSync(path.join(projectListHome, "state_5.sqlite"));
  const scratch = path.join(temp, "scratch-thread-folder");
  fs.mkdirSync(scratch);
  projectListDb.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER, updated_at_ms INTEGER);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER);
    CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, archived INTEGER, thread_source TEXT, thread_section_id TEXT, updated_at_ms INTEGER);
    INSERT INTO projects VALUES ('second', '第二个项目', 1, 1), ('first', '第一个项目', 0, 1);
    INSERT INTO project_roots VALUES ('first', '${project.replaceAll("'", "''")}', 0), ('second', '${scratch.replaceAll("'", "''")}', 0);
    INSERT INTO threads VALUES ('temporary', '${path.join(temp, "unlisted-thread-folder").replaceAll("'", "''")}', '不应成为项目', 0, 'user', NULL, 9);
  `);
  projectListDb.close();
  const projectListScript = `
    const m = await import(${JSON.stringify(new URL("./lib/codex-state.mjs", import.meta.url).href)});
    console.log(JSON.stringify(m.discoverProjects().projects.map(({ name }) => name)));
  `;
  const projectListChild = spawnSync(process.execPath, ["--input-type=module", "-e", projectListScript], {
    env: {
      ...process.env,
      CODEX_HOME: projectListHome,
      CODEX_SQLITE_HOME: projectListHome,
      SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-project-list")
    },
    encoding: "utf8"
  });
  assert.equal(projectListChild.status, 0, projectListChild.stderr);
  assert.deepEqual(JSON.parse(projectListChild.stdout.trim()), ["第一个项目", "第二个项目"]);

  const queueHome = path.join(temp, "queue-home");
  fs.mkdirSync(queueHome, { recursive: true });
  const queueDb = path.join(queueHome, "state_5.sqlite");
  const db = new TestDatabaseSync(queueDb);
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
    INSERT INTO threads (id, cwd) VALUES ('019f-queue-test', '${project.replaceAll("'", "''")}');
    CREATE TABLE queued_items (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      queue_order INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX queued_items_thread_order_idx ON queued_items(thread_id, queue_order);
    CREATE TABLE queued_thread_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE
    );
    CREATE TRIGGER queued_items_revision_after_insert
    AFTER INSERT ON queued_items
    BEGIN
      INSERT INTO queued_thread_revisions (thread_id)
      VALUES (NEW.thread_id)
      ON CONFLICT(thread_id) DO UPDATE
      SET revision = (SELECT COALESCE(MAX(revision), 0) + 1 FROM queued_thread_revisions);
    END;
  `);
  db.close();

  const stateQueueScript = `
    const m = await import(${JSON.stringify(new URL("./lib/codex-cli.mjs", import.meta.url).href)});
    const result = m.queueViaStateDb("019f-queue-test", "从 ChatGPT 发送的方案");
    console.log(JSON.stringify(result));
  `;
  const stateQueueChild = spawnSync(process.execPath, ["--input-type=module", "-e", stateQueueScript], {
    env: {
      ...process.env,
      CODEX_HOME: queueHome,
      CODEX_SQLITE_HOME: queueHome,
      SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-queue")
    },
    encoding: "utf8"
  });
  assert.equal(stateQueueChild.status, 0, stateQueueChild.stderr);
  const stateQueueData = JSON.parse(stateQueueChild.stdout.trim());
  assert.equal(stateQueueData.transport, "state-db-queue");

  const verifyDb = new TestDatabaseSync(queueDb, { readOnly: true });
  const queuedRow = verifyDb.prepare("SELECT payload_json, queue_order FROM queued_items WHERE thread_id = ?").get("019f-queue-test");
  assert.equal(queuedRow.queue_order, 0);
  const payload = JSON.parse(queuedRow.payload_json);
  assert.equal(payload.UserInput.content[0].type, "text");
  assert.equal(payload.UserInput.content[0].text, "从 ChatGPT 发送的方案");
  const revision = verifyDb.prepare("SELECT revision FROM queued_thread_revisions WHERE thread_id = ?").get("019f-queue-test");
  assert.ok(Number(revision.revision) >= 1, "external queue revision trigger did not fire");
  verifyDb.close();
}

// v0.2.11 read-only Context bridge coverage.
const trackedFile = path.join(project, "bridge.js");
const outsideFile = path.join(temp, "outside-secret.txt");
fs.writeFileSync(trackedFile, "function queueToSession() { return true; }\n");
fs.writeFileSync(outsideFile, "outside secret\n");
fs.writeFileSync(path.join(project, ".env"), "TOKEN=do-not-read\n");
fs.writeFileSync(path.join(project, "private.pem"), "-----BEGIN PRIVATE KEY-----\n");
fs.writeFileSync(path.join(project, "binary.bin"), Buffer.from([0, 1, 2, 3]));
fs.writeFileSync(path.join(project, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
fs.writeFileSync(path.join(project, "image.png"), Buffer.concat([tinyPng, Buffer.alloc(1_500_000 - tinyPng.length)]));
fs.writeFileSync(path.join(project, "fake.png"), Buffer.from("not an image\n"));
fs.writeFileSync(path.join(project, "huge.png"), Buffer.concat([tinyPng, Buffer.alloc(8 * 1024 * 1024)]));
fs.mkdirSync(path.join(project, "extension"), { recursive: true });
fs.writeFileSync(path.join(project, "extension", "content.js"), "const bridge = true;\n");
fs.writeFileSync(path.join(project, "empty.txt"), "");
fs.mkdirSync(path.join(project, "node_modules", "fixture"), { recursive: true });
fs.writeFileSync(path.join(project, "node_modules", "fixture", "ignored.js"), "ignored\n");
try { fs.symlinkSync(outsideFile, path.join(project, "link")); } catch {}
const gitInit = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
assert.equal(gitInit.status, 0, gitInit.stderr);
assert.equal(spawnSync("git", ["-C", project, "add", "bridge.js"], { encoding: "utf8" }).status, 0);
assert.equal(spawnSync("git", ["-C", project, "-c", "user.name=Bridge Test", "-c", "user.email=bridge@test", "commit", "-qm", "baseline"], { encoding: "utf8" }).status, 0);
fs.appendFileSync(trackedFile, "// changed\n");
fs.appendFileSync(session, [
  JSON.stringify({ timestamp: "2026-09-01T10:00:02Z", payload: { type: "message", role: "assistant", content: "已检查项目结构" } }),
  JSON.stringify({ timestamp: "2026-09-01T10:00:03Z", payload: { type: "function_call", name: "queueToSession" } }),
  JSON.stringify({ timestamp: "2026-09-01T10:00:04Z", payload: { type: "function_call_output", output: "error: tool output ".repeat(20) } }),
  JSON.stringify({ timestamp: "2026-09-01T10:00:05Z", payload: { type: "reasoning", text: "this must stay hidden" } }),
  JSON.stringify({ timestamp: "2026-09-01T10:00:06Z", payload: { type: "message", role: "developer", content: "internal metadata" } }),
  JSON.stringify({ timestamp: "2026-09-01T10:00:07Z", payload: { type: "message", role: "user", content: "继续验证 queueToSession" } })
].join("\n") + "\n");

const contextScript = `
  const config = await import(${JSON.stringify(new URL("./lib/config.mjs", import.meta.url).href)});
  config.saveConfig({ userProjects: [${JSON.stringify(project)}], readAllowedProjects: [${JSON.stringify(project)}] });
  const guard = await import(${JSON.stringify(new URL("./lib/workspace-guard.mjs", import.meta.url).href)});
  const files = await import(${JSON.stringify(new URL("./lib/project-context.mjs", import.meta.url).href)});
  const projectFiles = await import(${JSON.stringify(new URL("./lib/project-files.mjs", import.meta.url).href)});
  const transcript = await import(${JSON.stringify(new URL("./lib/codex-transcript.mjs", import.meta.url).href)});
  const bundle = await import(${JSON.stringify(new URL("./lib/context-bundle.mjs", import.meta.url).href)});
  const ledger = await import(${JSON.stringify(new URL("./lib/handoff-ledger.mjs", import.meta.url).href)});
  const fail = (fn) => { try { fn(); return null; } catch (error) { return { status: error.status, code: error.code }; } };
  const sessionId = "01a-test-session";
  const read = (relativePath) => files.readProjectFile({ projectPath: ${JSON.stringify(project)}, relativePath });
  const tail = transcript.readTranscript({ sessionId, projectPath: ${JSON.stringify(project)}, maxMessages: 3, maxToolOutputBytes: 20 });
  const page2 = transcript.readTranscript({ sessionId, projectPath: ${JSON.stringify(project)}, maxMessages: 2, cursor: tail.nextCursor });
  const head = transcript.readTranscript({ sessionId, projectPath: ${JSON.stringify(project)}, direction: "head", maxMessages: 2 });
  const status = files.getGitStatus(${JSON.stringify(project)});
  const diff = files.getGitDiff(${JSON.stringify(project)});
  const snapshot = bundle.buildSessionSnapshot({ projectPath: ${JSON.stringify(project)}, sessionId });
  const context = bundle.buildContextBundle({ projectPath: ${JSON.stringify(project)}, sessionId, parts: ["snapshot", "transcript", "git"], options: { transcriptMessages: 4 } });
  const listed = projectFiles.listProjectDirectory(${JSON.stringify(project)});
  const nested = projectFiles.listProjectDirectory(${JSON.stringify(project)}, "extension");
  const preview = projectFiles.readProjectFile(${JSON.stringify(project)}, "extension/content.js");
  const empty = projectFiles.readProjectFile(${JSON.stringify(project)}, "empty.txt");
  const sensitivePreview = projectFiles.readProjectFile(${JSON.stringify(project)}, ".env");
  const binaryPreview = projectFiles.readProjectFile(${JSON.stringify(project)}, "binary.bin");
  const largePreview = projectFiles.readProjectFile(${JSON.stringify(project)}, "large.txt");
  const imagePreview = projectFiles.readProjectFile(${JSON.stringify(project)}, "image.png");
  const fakeImagePreview = projectFiles.readProjectFile(${JSON.stringify(project)}, "fake.png");
  const hugeImagePreview = projectFiles.readProjectFile(${JSON.stringify(project)}, "huge.png");
  const imageData = projectFiles.readProjectFileData(${JSON.stringify(project)}, "image.png");
  const hugeImageData = projectFiles.readProjectFileData(${JSON.stringify(project)}, "huge.png");
  const ledgerRecord = ledger.appendHandoff({ source: { conversationId: "chat-test", revision: 2, contentHash: "hash-test", text: "do not persist this prompt" }, projectPath: ${JSON.stringify(project)}, sessionId, transport: "test" });
  config.saveConfig({ userProjects: [${JSON.stringify(project)}], readAllowedProjects: [] });
  const permissionOff = fail(() => files.getGitStatus(${JSON.stringify(project)}));
  config.saveConfig({ userProjects: [${JSON.stringify(project)}], readAllowedProjects: [${JSON.stringify(project)}] });
  console.log(JSON.stringify({
    safe: read("bridge.js").content,
    traversal: fail(() => read("../outside-secret.txt")),
    absolute: fail(() => read(${JSON.stringify(outsideFile)})),
    symlink: fail(() => read("link")),
    env: fail(() => read(".env")),
    key: fail(() => read("private.pem")),
    binary: fail(() => read("binary.bin")),
    large: fail(() => read("large.txt")),
    listed, nested, preview, empty, sensitivePreview, binaryPreview, largePreview, imagePreview, fakeImagePreview, hugeImagePreview,
    imageData: { kind: imageData.kind, mime: imageData.mime, base64Length: imageData.base64?.length || 0 },
    hugeImageData: { kind: hugeImageData.kind, tooLarge: hugeImageData.tooLarge, base64Length: hugeImageData.base64?.length || 0 },
    filesTraversal: fail(() => projectFiles.listProjectDirectory(${JSON.stringify(project)}, "../outside-secret.txt")),
    filesAbsolute: fail(() => projectFiles.readProjectFile(${JSON.stringify(project)}, ${JSON.stringify(outsideFile)})),
    filesSymlink: fail(() => projectFiles.readProjectFile(${JSON.stringify(project)}, "link")),
    tail, page2, head, status, diff,
    snapshot: { task: snapshot.task, actions: snapshot.recentActions, changedFiles: snapshot.changedFiles, errors: snapshot.errors, text: snapshot.text },
    context: { text: context.text, hasGit: Boolean(context.context.git), hasTranscript: Boolean(context.context.transcript) },
    permissionOff, ledgerRecord
  }));
`;
const contextChild = spawnSync(process.execPath, ["--input-type=module", "-e", contextScript], {
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: path.join(temp, "missing-context"),
    SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-context")
  },
  encoding: "utf8"
});
assert.equal(contextChild.status, 0, contextChild.stderr);
const contextData = JSON.parse(contextChild.stdout.trim());
assert.match(contextData.safe, /queueToSession/);
assert.equal(contextData.traversal.status, 403);
assert.equal(contextData.absolute.status, 400);
assert.equal(contextData.symlink.status, 403);
assert.equal(contextData.env.code, "BLOCKED_PATH");
assert.equal(contextData.key.code, "BLOCKED_PATH");
assert.equal(contextData.binary.code, "BINARY_FILE");
assert.equal(contextData.large.code, "FILE_TOO_LARGE");
assert.ok(contextData.listed.entries.some((item) => item.name === "extension" && item.type === "directory"));
assert.ok(!contextData.listed.entries.some((item) => item.name === "node_modules"), "ignored directory leaked into listing");
assert.equal(contextData.nested.entries[0].name, "content.js");
assert.equal(contextData.preview.content, "const bridge = true;\n");
assert.equal(contextData.empty.content, "");
assert.equal(contextData.sensitivePreview.blocked, true);
assert.equal(contextData.sensitivePreview.reason, "sensitive-file");
assert.equal(contextData.binaryPreview.binary, true);
assert.equal(contextData.largePreview.tooLarge, true);
assert.equal(contextData.imagePreview.kind, "image");
assert.equal(contextData.imagePreview.tooLarge, false);
assert.equal(contextData.imagePreview.content, undefined);
assert.equal(contextData.fakeImagePreview.kind, "binary");
assert.equal(contextData.fakeImagePreview.unsupportedImage, true);
assert.equal(contextData.hugeImagePreview.kind, "image");
assert.equal(contextData.hugeImagePreview.tooLarge, true);
assert.equal(contextData.imageData.kind, "image");
assert.equal(contextData.imageData.mime, "image/png");
assert.ok(contextData.imageData.base64Length > 100);
assert.equal(contextData.hugeImageData.tooLarge, true);
assert.equal(contextData.hugeImageData.base64Length, 0);
assert.equal(contextData.filesTraversal.code, "PATH_TRAVERSAL_BLOCKED");
assert.equal(contextData.filesAbsolute.code, "RELATIVE_PATH_REQUIRED");
assert.equal(contextData.filesSymlink.code, "PATH_TRAVERSAL_BLOCKED");
assert.ok(contextData.tail.messages.some((item) => item.role === "assistant"));
assert.ok(contextData.tail.messages.some((item) => item.type === "tool_call"));
assert.ok(contextData.tail.messages.every((item) => !item.content.includes("this must stay hidden")));
assert.ok(contextData.tail.messages.find((item) => item.type === "tool_output").content.length <= 20);
assert.ok(contextData.tail.hasMore && contextData.page2.messages.length > 0, "transcript pagination failed");
assert.equal(contextData.head.messages[0].role, "user");
assert.ok(contextData.status.isGitRepo);
assert.ok(contextData.status.changedFiles.includes("bridge.js"));
assert.match(contextData.diff.diff, /changed/);
assert.ok(contextData.snapshot.task.includes("继续验证"));
assert.ok(contextData.snapshot.actions.some((item) => item.content.includes("queueToSession")));
assert.ok(contextData.snapshot.changedFiles.includes("bridge.js"));
assert.ok(contextData.snapshot.errors.some((item) => item.includes("error")));
assert.doesNotMatch(contextData.snapshot.text, /this must stay hidden/);
assert.match(contextData.context.text, /\[Sol → Codex Local Context\]/);
assert.ok(contextData.context.hasGit && contextData.context.hasTranscript);
assert.equal(contextData.permissionOff.status, 403);
assert.ok(contextData.ledgerRecord.handoffId && !Object.prototype.hasOwnProperty.call(contextData.ledgerRecord, "text"));
assert.match(serverSource, /bridgeVersion: "0\.2\.11"/);

const apiPort = 37920 + (process.pid % 100);
const bridgeProcess = spawn(process.execPath, ["server.mjs"], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: path.join(temp, "missing-api"),
    SOL_CODEX_BRIDGE_HOME: path.join(temp, ".bridge-context"),
    SOL_CODEX_BRIDGE_PORT: String(apiPort),
    SOL_CODEX_INDEX_INTERVAL_MS: "60000"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let bridgeOutput = "";
let bridgeError = "";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Bridge API 启动超时: ${bridgeOutput} ${bridgeError}`)), 10_000);
  bridgeProcess.stdout.on("data", (chunk) => {
    bridgeOutput += chunk.toString();
    if (!bridgeOutput.includes("Listening:")) return;
    clearTimeout(timer);
    resolve();
  });
  bridgeProcess.stderr.on("data", (chunk) => { bridgeError += chunk.toString(); });
  bridgeProcess.once("error", (error) => { clearTimeout(timer); reject(error); });
  bridgeProcess.once("exit", (code) => {
    if (code) { clearTimeout(timer); reject(new Error(`Bridge API 退出: ${code} ${bridgeOutput} ${bridgeError}`)); }
  });
});
try {
  const apiToken = fs.readFileSync(path.join(temp, ".bridge-context", "token"), "utf8").trim();
  const api = async (route, options = {}, withAuth = true) => {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (withAuth) headers["X-Bridge-Token"] = apiToken;
    const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
      ...options,
      headers
    });
    return { status: response.status, data: await response.json() };
  };
  const health = await api("/api/health", {}, false);
  assert.equal(health.status, 200);
  assert.equal(health.data.bridgeVersion, "0.2.11");
  const unauthenticatedFiles = await api(`/api/project-files?${new URLSearchParams({ project, path: "" })}`, {}, false);
  assert.equal(unauthenticatedFiles.status, 401);
  const permission = await api(`/api/context/permission?project=${encodeURIComponent(project)}`);
  assert.equal(permission.status, 200);
  assert.equal(permission.data.allowed, true);
  const off = await api("/api/context/permission", { method: "POST", body: JSON.stringify({ projectPath: project, allowed: false }) });
  assert.equal(off.status, 200);
  const denied = await api(`/api/context/git?project=${encodeURIComponent(project)}`);
  assert.equal(denied.status, 403, JSON.stringify(denied));
  const on = await api("/api/context/permission", { method: "POST", body: JSON.stringify({ projectPath: project, allowed: true }) });
  assert.equal(on.status, 200);
  const search = await api("/api/context/search", { method: "POST", body: JSON.stringify({ projectPath: project, query: "queueToSession" }) });
  assert.equal(search.status, 200);
  assert.ok(search.data.some((item) => item.path === "bridge.js"));
  const blocked = await api("/api/context/file", { method: "POST", body: JSON.stringify({ projectPath: project, relativePath: "../outside-secret.txt" }) });
  assert.equal(blocked.status, 403);
  const rootFiles = await api(`/api/project-files?${new URLSearchParams({ project, path: "" })}`);
  assert.equal(rootFiles.status, 200);
  assert.ok(rootFiles.data.entries.some((item) => item.name === "extension"));
  const filePreview = await api(`/api/project-file?${new URLSearchParams({ project, path: "extension/content.js" })}`);
  assert.equal(filePreview.status, 200);
  assert.equal(filePreview.data.content, "const bridge = true;\n");
  const imagePreview = await api(`/api/project-file?${new URLSearchParams({ project, path: "image.png" })}`);
  assert.equal(imagePreview.status, 200);
  assert.equal(imagePreview.data.kind, "image");
  assert.equal(imagePreview.data.tooLarge, false);
  const imageData = await api(`/api/project-file-data?${new URLSearchParams({ project, path: "image.png" })}`);
  assert.equal(imageData.status, 200);
  assert.equal(imageData.data.kind, "image");
  assert.ok(imageData.data.base64.length > 100);
  const fakeImage = await api(`/api/project-file-data?${new URLSearchParams({ project, path: "fake.png" })}`);
  assert.equal(fakeImage.status, 200);
  assert.equal(fakeImage.data.kind, "binary");
  assert.equal(fakeImage.data.unsupportedImage, true);
  const fileTraversal = await api(`/api/project-file?${new URLSearchParams({ project, path: "../../etc/passwd" })}`);
  assert.equal(fileTraversal.status, 403);
  const apiBundle = await api("/api/context/bundle", { method: "POST", body: JSON.stringify({ projectPath: project, sessionId: "01a-test-session", parts: ["snapshot", "transcript", "git"] }) });
  assert.equal(apiBundle.status, 200);
  assert.match(apiBundle.data.text, /\[Sol → Codex Local Context\]/);
} finally {
  bridgeProcess.kill();
}

console.log("self-test: ok");
