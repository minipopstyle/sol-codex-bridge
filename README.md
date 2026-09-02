# Sol → Codex Local Bridge

![Sol → Codex Local Bridge cover](assets/cover.png)

一个仅限 macOS 的 Chrome 扩展与本地 Bridge：把 ChatGPT 当前回复发送到本机 Codex 项目或已有会话。

## 功能

- 从 ChatGPT 读取最新 Assistant 回复或选中文本。
- 从本机 Codex 状态读取项目和会话。
- 新建项目任务，或把内容加入已有会话。
- ChatGPT 页面内联 `Codex →` 一键发送；新任务执行时显示进度动画与计时。

## 安装

1. 双击 `install-bridge.command`。
2. 在 `chrome://extensions` 开启开发者模式，加载 `extension` 文件夹。
3. 打开侧栏，粘贴安装时复制的 Pairing Token。

需要 macOS、Node.js 18+ 与已登录的 Codex CLI。

## 使用

1. 在 ChatGPT 打开侧栏，选择本地项目。
2. 选择“项目新任务”创建任务，或选择“已有会话”把内容加入目标会话。
3. 点击“发送到 Codex”。新任务会显示像素动画和计时，完成后自动打开 Codex。
4. 侧栏收起后，最新 ChatGPT 回复旁仍可点击 `Codex →`；它会使用侧栏中保存的项目与发送方式。

“项目新任务”可用于普通文件夹，不要求该目录是 Git 仓库。

## 安全模型

- Bridge 仅监听 `127.0.0.1:37821`。
- 除健康检查外，接口都要求 Pairing Token。
- Token、日志、项目配置与会话缓存均存放在 `~/.sol-codex-bridge/`，不属于本仓库。
- 扩展仅请求 ChatGPT 与本机 Bridge；Bridge 不发送任何内容到第三方服务。

## 验证

```sh
cd bridge
npm run self-test
```

另外在 Chrome 重新加载扩展后，分别测试“项目新任务”和“已有会话”。

## 发布前

请在公开前选择并添加许可证；当前仓库未附带许可证。
