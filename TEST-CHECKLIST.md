# Release checklist

- `cd bridge && npm run self-test`
- 在 Chrome 重新加载 `extension`。
- 在 ChatGPT 侧栏验证“项目新任务”与“已有会话”。
- 收起侧栏，验证 ChatGPT 页面内联 `Codex →`。
- 确认 Git 暂存区不含 token、日志、`~/.sol-codex-bridge/`、`.DS_Store` 或本地数据库。
