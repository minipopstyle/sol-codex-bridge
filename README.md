# Run in Codex POC

链路：ChatGPT assistant 消息 ↔ Codex 内置浏览器扩展 ↔ `127.0.0.1:4329` 适配层 ↔ Codex 项目/Session。

这是独立的 GitHub 发布版：使用 `4329` 端口、独立的 launchd 标识和 `~/.sol-codex-run-in-codex-poc-publish` 运行目录。

目录按职责区分：`bridge/` 是跨平台适配层，`chatgpt-extension/` 是共用浏览器扩展，`Windows/` 和根目录的 macOS `.command` 文件只负责各自平台的后台托管。

只使用浏览器原生 API 和 Node 标准库；任务只保存在内存中，并在达到数量或时间上限后清理。

## 命令怎么选

普通使用只需要双击下面 4 个 `.command` 文件。它们只管理这个隔离副本，不会改动原项目；GitHub 上传仍由你最后确认后手动执行。

| 文件 | 用途 | 什么时候点 |
| --- | --- | --- |
| `run-in-codex-poc.command` | 安装并启动 | 第一次使用或需要启动时点这个 |
| `restart-run-in-codex-poc.command` | 启动、同步代码并重启 | 中途挂了、改完代码、扩展无法连接时点这个 |
| `status-run-in-codex-poc.command` | 查看状态 | 不确定是否运行时先点这个；不会启动或停止 |
| `uninstall-run-in-codex-poc.command` | 停止并清理发布版 | 想彻底卸载后再重新安装时点这个 |

最短判断：安装或启动 → `run-in-codex-poc.command`；挂了或改完代码 → `restart`；只想确认 → `status`；清理重装 → `uninstall`。

卸载只删除发布版的 launchd、运行目录和日志，不删除共享 Pairing Token。

`com.sol-codex.run-in-codex-poc.plist` 只是 macOS 的配置模板，不要双击它；`bridge/`、`chatgpt-extension/`、`tests/` 是代码目录，也不是启动入口。

如果 macOS 第一次阻止 `.command`，在 Finder 中右键它并选择“打开”，确认一次即可。

脚本使用仓库内的 Bridge 依赖；可以通过 `C2C_PROJECT_PATH` 指定默认项目。运行时 plist 会在安装到当前用户的 LaunchAgents 前动态生成，不提交机器专属路径。

不需要在 Codex Console 粘贴脚本，也不需要手动启动 receiver；回到 ChatGPT 刷新页面后点击 `▶ 在 Codex 执行` 即可。

首次使用：双击 `run-in-codex-poc.command`。它会启动发布版 Bridge、保持后台运行，并把 Pairing Token（通常位于 `~/.sol-codex-bridge/token`）复制到剪贴板。回到目标卡片，点击设置按钮左侧的「配对」，粘贴并保存；验证成功后按钮显示「已配对」。关闭安装命令窗口不会停止服务。

## Windows 版

Windows 使用当前用户的任务计划程序托管发布版 Bridge，不需要管理员权限。它继续使用隔离端口 `4329`；原版 `sol-codex-bridge` 的 Windows 服务使用 `37821`，两者不会抢端口。

Windows 对外只保留 4 个命令，公共脚本放在 `Windows/`；`run-in-codex-poc.common.ps1` 和 `bridge-launcher.ps1` 是内部文件，不要单独运行：

| 文件 | 类型 | 什么时候运行 |
| --- | --- | --- |
| `Windows/install-run-in-codex-poc.ps1` | 首次安装 / 更新 | 第一次使用，或需要同步发布版代码时 |
| `Windows/restart-run-in-codex-poc.ps1` | 重启 | 中途挂了，或更新代码后 |
| `Windows/status-run-in-codex-poc.ps1` | 查看状态 | 只检查，不启动、不停止 |
| `Windows/uninstall-run-in-codex-poc.ps1` | 卸载 | 想清理发布版后重新安装时 |

在 PowerShell 中运行首次安装：

```powershell
cd C:\path\to\sol-codex-bridge
powershell -ExecutionPolicy Bypass -File .\Windows\install-run-in-codex-poc.ps1
```

安装脚本会使用当前仓库内的 Bridge 依赖，并将运行时复制到独立目录。安装后会复制 Pairing Token 到剪贴板。PowerShell 窗口可以关闭，Bridge 由任务计划程序继续运行。

Windows 版卸载只删除发布版任务、运行目录和日志，不删除共享 Pairing Token。

手动启动方式（仅排查使用）：

```sh
cd /path/to/sol-codex-bridge
node bridge/server.mjs
```

验证 Bridge：

```sh
curl http://127.0.0.1:4329/health
```

## macOS Bridge 管理

Bridge 由 `launchd` 托管；命令执行完后，关闭 Terminal 窗口不会停止它。重启、暂停和停止只影响这个隔离副本安装的 POC Bridge，不会停止已有的 `sol-codex-bridge`。

## 加载 ChatGPT 扩展

1. 在 Codex 内置浏览器的设置中打开“扩展程序”。
2. 开启 Developer mode。
3. 选择“加载未打包的扩展程序”，选择 `chatgpt-extension/`。
4. 打开或刷新 ChatGPT 对话。
5. assistant 回复底部会出现 `▶ 在 Codex 执行`。

## 目标选择

点击旁边的「目标」打开选择卡片，必须明确选择已有 Session 或项目新任务。

选择卡片支持：

- 指定项目中的已有 Session
- 在指定项目创建新 Codex 任务

发送时适配层直接复用已有 `sol-codex-bridge` 的 `queueToSession()`、`launchNewTask()` 和 Session 索引。

已有会话发送成功后，会复用 `sol-codex-bridge` 的 `openSessionInCodex(sessionId)`，通过 `codex://threads/<sessionId>` 将 Codex Desktop 切到目标项目和会话页面。

打开「目标」卡片后，卡片顶部可在「发送到 Codex」和「读取」两个同级 Tab 之间切换。读取页可在同一个 Project / Session 目标下读取最近进度、项目上下文、Session transcript、Git Diff 和项目文件。首次读取项目需要授权；授权状态由 Bridge 服务端保存和校验。读取结果只会预览，点击「插入 ChatGPT」才写入当前 Composer，不会自动发送。

卡片右上角齿轮打开共享设置，支持 `auto`、`text`、`file` 三种传输方式，同时作用于「发送到 Codex」和「读取」。大内容在 `auto` 下使用本地 `sol-codex-bridge` 的 Markdown handoff artifact；读取到 ChatGPT 时上传入口不可用则回退为文本。项目与 Session 仍来自已有状态索引，Composer 插入也复用其站点适配逻辑。

Context 适配层只接线到已有的 `workspace-guard.mjs`、`codex-transcript.mjs`、`project-context.mjs`、`context-bundle.mjs` 和 `project-files.mjs`，不使用 MCP，也不接受项目外的绝对文件路径。

任务顺序为 `queued → accepted → running → executed`；这里的 `executed` 表示输入已提交到 Codex 队列，实际 turn 仍由 Codex 执行。

## 验证任务状态

Bridge 提供最小调试接口（需要 Pairing Token）：

```sh
curl -H "X-Bridge-Token: $(cat ~/.sol-codex-bridge/token)" http://127.0.0.1:4329/tasks/<taskId>
```

## 测试

```sh
node --test tests/*.mjs
```

覆盖创建、领取、去重、合法状态流转、非法状态流转、workspace 隔离，以及 Context 路由的语法和现有发送链路回归。

## POC 边界

- 任务和目标设置仍保存在本地内存/扩展存储中，没有数据库、WebSocket 或自动 Review。
- 不使用 `locked`、最近更新时间或其它启发式推断原生 UI 当前高亮的 Session；目标必须显式选择。
- ChatGPT Composer 适配集中在 `chatgpt-extension/chatgpt-site.js`。
- 失败重试依赖重新点击；Bridge 重启会丢失内存任务。
