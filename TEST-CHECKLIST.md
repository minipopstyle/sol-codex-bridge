# Release checklist

- `cd bridge && npm run self-test`
- 在 Chrome 重新加载 `extension`。
- 在 Side Panel 验证顶部 `Sol ↔ Codex` 与 `Sol → Codex / Codex → Sol` 方向切换。
- 验证 Push / Pull 共享项目与会话，切换方向不重新加载 SessionIndex。
- 在 Push 验证“项目新任务”“已有会话”与发送按钮。
- 在 Pull 选择项目和已有会话，首次读取验证授权提示、管理菜单和“已授权”状态。
- 验证“最近进度”“会话记录”“Git Diff”“项目文件”与 Preview。
- 点击“插入 ChatGPT”，确认只插入 composer、不自动发送。
- 收起侧栏，验证 ChatGPT 页面内联 `← Sol    Codex →`，尺寸、hover、active 和 dark mode 一致。
- 验证 `← Sol` 默认读取最近进度，Popover 可插入 ChatGPT；“项目文件”直接打开懒加载文件树与只读预览。
- 验证 Popover 在页面顶部/底部、窄窗口和长内容下均被 viewport clamp，只有内容区域滚动。
- 验证关闭读取权限后 Context API 返回 403。
- 验证 `../.ssh/id_rsa`、`.env`、密钥、symlink escape、二进制和超大文件均被拒绝。
- 确认 Git 暂存区不含 token、日志、`~/.sol-codex-bridge/`、`.DS_Store` 或本地数据库。
