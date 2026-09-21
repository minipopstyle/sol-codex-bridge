# Sol ↔ Codex Local Bridge

![Sol ↔ Codex Local Bridge cover](assets/cover.png)

<p align="center">
  <strong>让 ChatGPT 与 Codex 在本地安全交换上下文。</strong>
</p>

<p align="center">
  Think in ChatGPT. Build in Codex.
</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

---

## Sol ↔ Codex 是什么？

**Sol ↔ Codex Local Bridge** 是一个支持 macOS / Windows 的 Chrome 扩展 + 本地 Bridge，用于在 ChatGPT 与本机 Codex 项目、会话之间传递上下文。

它解决的是最后一段交接流程：

```text
ChatGPT
    ↕
Chrome Extension
    ↕
127.0.0.1:4329 Local Bridge
    ↕
Codex Project / Session / Git
```

不再需要反复：

**复制内容 → 切换 Codex → 找项目 → 找会话 → 粘贴上下文。**

## ✨ 核心功能

### 🔗 ChatGPT → Codex 一键发送

可以将 ChatGPT 的完整 Assistant 回复或页面选中文本发送到：

- 指定项目中的已有 Codex 会话；
- 指定项目中的新 Codex 任务。

### 📖 Codex → ChatGPT 读取上下文

在 ChatGPT 回复旁点击「读取」，可以读取：

- 项目上下文；
- 最近进度；
- 会话记录；
- Git Diff；
- 项目文件和文本预览。

读取是显式、只读的用户操作。内容只会插入当前 ChatGPT 输入框，不会自动发送消息。

### 📁 本地项目和会话

Bridge 从本机 Codex 状态中发现项目和会话。配对成功后，发送页和读取页会分别刷新项目列表；读取不需要先发送内容。

### 📝 三种 Context 传输方式

在目标卡片右上角设置中选择：

- **自动**：根据内容大小自动选择文本或 Markdown 文件；
- **始终文本**：以内联文本插入或发送；
- **始终 Markdown 文件**：作为 Markdown 文件上传。

该设置同时作用于发送和读取。

### 🔐 Pairing Token

首次安装 Bridge 后会生成 Pairing Token 并复制到剪贴板。打开目标卡片，点击「配对」，粘贴并保存即可。配对成功后会显示「已配对」，后续不需要重复配对。

## 两种发送方式

### 01 · 项目新任务

把当前 ChatGPT 内容作为新的 Codex 任务执行。

适合：

- 新功能开发；
- Bug 修复；
- UI 改造；
- 重构；
- 独立开发任务。

### 02 · 已有会话

把当前内容继续发送到已经存在的 Codex Session，保持原有上下文连续。

适合：

- 继续未完成任务；
- 修改上一版实现；
- 补充新需求；
- 根据新的分析继续迭代。

## 工作流

```text
① 在 ChatGPT 中讨论需求
        ↓
② 打开「发送到 Codex」目标卡片
        ↓
③ 配对并选择项目
        ↓
④ 选择「已有会话」或「项目新任务」
        ↓
⑤ 发送到 Codex
        ↓
⑥ 需要时切换到「读取」
        ↓
⑦ 选择 Context 类型并插入 ChatGPT
```

ChatGPT 负责 **Think / Plan**。

Codex 负责 **Build / Run**。

Local Bridge 负责中间的 **Handoff**。

## 安装

### 环境要求

- macOS 或 Windows；
- Google Chrome；
- Node.js 18 或更高版本；
- 已安装并登录的 Codex CLI / Codex Desktop。

### 1. 安装 Local Bridge

#### macOS

在仓库根目录双击：

```text
run-in-codex-poc.command
```

它会安装并启动独立的 `4329` Bridge，并由 `launchd` 保持后台运行。关闭命令窗口不会停止服务。

#### Windows

在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\Windows\install-run-in-codex-poc.ps1
```

它会注册当前用户的任务计划程序任务，不需要管理员权限。PowerShell 窗口可以关闭，Bridge 会继续运行。

### 2. 平台维护命令

| 操作 | macOS（仓库根目录双击） | Windows（PowerShell） |
| --- | --- | --- |
| 首次安装 / 启动 | `run-in-codex-poc.command` | `Windows/install-run-in-codex-poc.ps1` |
| 中途挂了 / 更新后重启 | `restart-run-in-codex-poc.command` | `Windows/restart-run-in-codex-poc.ps1` |
| 只查看状态 | `status-run-in-codex-poc.command` | `Windows/status-run-in-codex-poc.ps1` |
| 卸载并清理 | `uninstall-run-in-codex-poc.command` | `Windows/uninstall-run-in-codex-poc.ps1` |

最短判断：第一次点安装；挂了点重启；不确定先看状态；想彻底重装点卸载。

`com.sol-codex.run-in-codex-poc.plist` 是 macOS 配置模板，不要直接双击。

### 3. 安装 Chrome 扩展

打开：

```text
chrome://extensions
```

然后：

1. 开启「开发者模式」；
2. 点击「加载已解压的扩展程序」；
3. 选择仓库中的 `chatgpt-extension` 文件夹。

### 4. 配对

安装命令会生成并复制 Pairing Token。回到 ChatGPT，打开任意 Assistant 回复旁的「目标」或「读取」入口：

1. 点击目标卡片右上角「配对」；
2. 粘贴 Pairing Token；
3. 点击保存；
4. 看到「已配对」后，项目和会话列表会自动刷新。

配对 Token 只保存在扩展本地存储和本机 Bridge 配置中。

### 5. 刷新 ChatGPT

首次安装或更新扩展后，刷新 ChatGPT 页面。Assistant 回复旁出现 `目标` / `读取` 按钮，即表示扩展已经加载。

## 使用

### 发送到已有 Codex 会话

1. 点击 Assistant 回复旁的「目标」；
2. 选择「已有会话」；
3. 选择项目和会话；
4. 点击「保存目标」；
5. 点击「发送到 Codex」。

### 创建项目新任务

1. 点击「目标」；
2. 选择「项目新任务」；
3. 选择项目；
4. 点击「保存目标」；
5. 点击「发送到 Codex」。

### 读取 Codex Context

1. 点击「读取」；
2. 选择项目和会话；
3. 首次读取项目时允许 Context 读取；
4. 选择「项目上下文」「最近进度」「会话记录」「Git Diff」或「项目文件」；
5. 选择文本插入或 Markdown 文件上传；
6. 点击「插入 ChatGPT」。

“选择项目”不等于“允许读取”。读取权限由 Bridge 服务端按项目保存和校验。

## 🔒 Local First

### Bridge

Bridge 只监听本机回环地址：

```text
127.0.0.1:4329
```

不会监听公网地址。

### Pairing Token

除健康检查外，Bridge API 都需要 Pairing Token。Token 用于阻止其他网页或本机程序未经授权调用 Bridge。

### Context Read Permission

读取项目代码、Git 信息、会话记录和项目文件前，必须针对项目显式授权。服务端会校验项目路径、阻止项目外路径和敏感文件读取。

### 本地数据

发布版运行数据存储在：

```text
~/.sol-codex-run-in-codex-poc-publish/
```

Pairing Token 保存在本机 Bridge 配置目录，不会写入 Git 仓库。

### 网络请求

扩展只与 ChatGPT 和本机 Bridge 通信：

```text
ChatGPT
   ↕
Chrome Extension
   ↕
127.0.0.1:4329
   ↕
Codex
```

Bridge 不会主动把任务内容发送到额外的第三方服务。

## 项目结构

```text
sol-codex-bridge/
│
├── chatgpt-extension/       # ChatGPT Chrome 扩展
├── bridge/                  # 本地 Bridge 与 Context API
│   └── lib/                 # Codex 状态、Session、文件和权限适配
├── Windows/                 # Windows 安装、重启、状态、卸载脚本
├── run-in-codex-poc.command # macOS 安装 / 启动
├── restart-run-in-codex-poc.command
├── status-run-in-codex-poc.command
├── uninstall-run-in-codex-poc.command
├── tests/                   # 发布版测试
├── assets/                  # README 封面和项目图片
└── README.md
```

## 验证

运行发布版测试：

```sh
node --test tests/*.mjs
```

检查 Bridge：

```sh
curl http://127.0.0.1:4329/health
```

安装或更新扩展后，建议分别验证已有会话、项目新任务、项目上下文、最近进度、会话记录、Git Diff 和项目文件读取。

## 平台支持

| 功能 | macOS | Windows |
| --- | --- | --- |
| Chrome Extension | ✅ | ✅ |
| Local Bridge | ✅ | ✅ |
| 项目读取 | ✅ | ✅ |
| 项目文件 | ✅ | ✅ |
| Session | ✅ | ✅ |
| Git Diff | ✅ | ✅ |
| 已有会话发送 | ✅ | ✅ |
| 项目新任务 | ✅ | ✅ |

## License

当前仓库暂未附带 License。

正式公开发布前，请选择并添加合适的开源许可证。
