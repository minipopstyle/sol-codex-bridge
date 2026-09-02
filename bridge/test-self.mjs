import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
].join("\n"));

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

console.log("self-test: ok");
