# Sol ↔ Codex Local Bridge

![Sol ↔ Codex Local Bridge cover](assets/cover.png)

<p align="center">
  <strong>让 ChatGPT 与 Codex 在本地安全交换上下文。</strong>
</p>

<p align="center">
  Think in ChatGPT. Build in Codex.
</p>

---

## Sol ↔ Codex 是什么？

**Sol ↔ Codex Local Bridge** 是一个仅限 macOS 的 Chrome 扩展 + 本地 Bridge，提供两个一级方向：Sol → Codex 发送方案，以及 Codex → Sol 读取本地 Context。

它解决的是 ChatGPT 与 Codex 之间最后一段「上下文交接」：

```text
ChatGPT
    ↕
Chrome Extension
    ↕
127.0.0.1 Local Bridge
    ↕
Codex Session / Project Files / Git
```

你可以在 ChatGPT 中完成需求分析、方案设计和任务拆解，然后直接把当前回复发送到本机 Codex。

不再需要反复：

**复制内容 → 切换 Codex → 找项目 → 找会话 → 粘贴上下文。**

---

## ✨ 核心功能

### 🌐 中 / EN 双语界面

侧栏和 ChatGPT 页面内联操作支持中文 / English 即时切换，并记住你的语言选择。

### 🔗 ChatGPT → Codex 一键发送

直接读取：

- ChatGPT 最新 Assistant 回复
- 当前选中的文本

并发送给本机 Codex。

### Codex → Sol 读取内容

最新 Assistant 回复旁会同时出现：

```text
← Sol        Codex →
```

点击 `← Sol` 后，可从当前已选项目和会话读取：

- 最近进度 Snapshot
- Session transcript
- Git Diff
- 项目文件只读浏览与文本预览

默认读取“最近进度”。读取内容需要用户操作，并只提供“插入 ChatGPT”，不会自动发送 ChatGPT 消息。

### 📁 本地项目

Bridge 会读取本机 Codex 状态，并显示可用项目。

选择目标项目后，可以直接创建新的 Codex 任务。

> “项目新任务”支持普通文件夹，不要求目录必须是 Git 仓库。

### 💬 继续已有会话

除了创建新任务，也可以直接选择已有 Codex 会话。

新的分析、修改方案或补充需求可以继续追加到原来的 Session 中，保持上下文连续。

### ⚡ 页面内联发送与读取

ChatGPT 最新回复旁会出现：

`← Sol    Codex →`

即使侧栏已经收起，也可以直接发送。

它会自动使用侧栏中保存的：

- 本地项目
- 发送方式
- 目标会话

### ⏱️ 执行状态

创建新任务后会显示：

- 执行动画
- 实时计时
- 当前运行状态

若开启“发送后切换到 Codex”，任务完成后会自动打开 Codex。

---

## 两种发送方式

### 01 · 项目新任务

把当前 ChatGPT 内容作为新的 Codex Task 执行。

适合：

- 新功能开发
- Bug 修复
- UI 改造
- 重构
- 独立开发任务

### 02 · 已有会话

把当前内容继续发送到已经存在的 Codex Session。

适合：

- 继续未完成任务
- 修改上一版实现
- 补充新需求
- 根据新的分析继续迭代
- 保留已有上下文

---

## 工作流

```text
① 在 ChatGPT 中讨论需求
        ↓
② 得到实施方案
        ↓
③ 在 Side Panel 选择方向并读取当前回复
        ↓
④ 选择本地项目
        ↓
⑤ 选择「项目新任务」或「已有会话」
        ↓
⑥ Sol → Codex 发送，或 Codex → Sol 读取 Context
        ↓
⑦ 检查后手动发送 ChatGPT
```

ChatGPT 负责 **Think / Plan**。

Codex 负责 **Build / Run**。

Local Bridge 负责中间的 **Handoff**。

读取内容是显式、只读的用户操作；Bridge 不会主动上传本地代码。

---

## 安装

### 环境要求

目前仅支持：

- macOS
- Google Chrome
- Node.js 18+
- 已安装并登录的 Codex CLI

### 1. 安装 Local Bridge

双击：

```text
install-bridge.command
```

安装完成后会生成一个 **Pairing Token**，并自动复制到剪贴板。

### 2. 安装 Chrome 扩展

打开：

```text
chrome://extensions
```

然后：

1. 开启右上角「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 选择项目中的 `extension` 文件夹

### 3. 连接 Bridge

打开扩展侧栏。

安装脚本复制的 **Pairing Token** 会自动粘贴。安装和连接期间，请不要复制其他文字，否则会覆盖配对码。

连接成功后即可读取本机 Codex 项目和会话。

### 4. 刷新 ChatGPT 和插件

首次安装扩展后，请刷新 ChatGPT 网页，并重新打开或刷新扩展侧栏。

当会话右下角出现 `← Sol    Codex →` 按钮，表示页面数据已刷新成功。

---

## 使用

### 创建新的 Codex 任务

1. 在 ChatGPT 打开 Sol ↔ Codex 侧栏
2. 选择本地项目
3. 选择 **项目新任务**
4. 点击 **发送到 Codex**
5. 等待任务执行

执行过程中会显示动画和计时。

若开启“发送后切换到 Codex”，完成后会自动打开 Codex。

### 发送到已有 Codex 会话

1. 选择 **已有会话**
2. 选择目标 Session
3. 点击 **发送到 Codex**

Bridge 会把当前 ChatGPT 内容追加到这个会话，而不是重新创建任务。

### 快速发送

完成一次配置后，可以收起侧栏。

直接点击 ChatGPT 回复旁的：

```text
← Sol    Codex →
```

即可使用之前保存的项目和发送方式快速发送。

### Codex → Sol：读取 Context

1. 在侧栏切换到 **Codex → Sol**
2. 选择项目和 Codex 会话；若未选择，会优先使用活跃/使用中的最新会话
3. 首次读取时点击“允许读取”
4. 选择“最近进度”“会话记录”“Git Diff”或“项目文件”
5. 检查 Context Preview 后点击“插入 ChatGPT”
6. 回到 ChatGPT，确认内容后由用户手动点击 Send

“项目被选择”不等于“允许读取”。关闭读取权限后，Bridge 会对 Context API 返回 `403`。

---

## 🔒 Local First

Sol → Codex Local Bridge 采用本地优先的设计。

### Bridge

Bridge 仅监听：

```text
127.0.0.1:37821
```

不会监听公网地址。

### Pairing Token

除健康检查外，Bridge API 都需要 Pairing Token。

Token 用于防止其他网页或本机程序未经授权调用 Bridge。

### Context Read Permission

读取项目代码、Git 信息和 Session Context 前，必须针对项目显式授权。授权保存为 `readAllowedProjects` 的 normalized realpath；撤销后服务端会拒绝读取，而不仅是隐藏 UI。

Workspace Guard 会拒绝项目外路径、symlink escape、`.env`、密钥、`.git`、`node_modules`、构建产物和二进制文件。项目文件 API 只接受 `projectPath + relativePath`，不接受任意 `sourcePath`。

### 本地数据

以下数据存储在：

```text
~/.sol-codex-bridge/
```

包括：

- Pairing Token
- Bridge 日志
- 项目配置
- Codex 会话缓存
- Context 读取授权
- 不含完整 prompt 的 Handoff ledger

这些数据不属于 Git 仓库，也不会随项目提交。

### 网络请求

Chrome 扩展只与以下目标通信：

```text
ChatGPT
      ↕
Chrome Extension
      ↕
127.0.0.1 Local Bridge
      ↕
Codex
```

Bridge 不会主动把任务内容发送到额外的第三方服务。

---

## 项目结构

```text
sol-codex-bridge/
│
├── extension/               # Chrome 扩展
├── bridge/                  # 本地 Bridge 服务与只读 Context API
│   └── lib/
│       ├── workspace-guard.mjs
│       ├── codex-transcript.mjs
│       ├── project-context.mjs
│       ├── context-bundle.mjs
│       └── handoff-ledger.mjs
├── install-bridge.command   # macOS 安装脚本
├── assets/                  # README / 项目图片
└── README.md
```

---

## 验证

Bridge 提供本地自检：

```sh
cd bridge
npm run self-test
```

安装或更新扩展后，建议分别测试两个方向、项目/会话保持、`← Sol` Quick Pull 和 `Codex →` 发送链路，确保 ChatGPT ↔ Bridge ↔ Codex 整条链路工作正常。

---

## 当前定位

Sol ↔ Codex 并不是另一个 Coding Agent。

它只负责解决一个问题：

> **让 ChatGPT 的规划与 Codex 的本地执行环境，在用户确认下交换上下文。**

```text
ChatGPT / Sol
      ↕
  Local Context Bridge
      ↕
Codex Session / Project / Git
```

---

## Platform

目前：**macOS only**

Windows / Linux 暂未支持。

---

## License

当前仓库暂未附带 License。

正式公开发布前，请选择并添加合适的开源许可证。
