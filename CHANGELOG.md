# 更新日志

## 0.2.12

这一版主要继续完善 **ChatGPT ↔ Codex 双向上下文交接**，补齐项目 Context，并优化长任务和页面内联操作体验。

### 新增

- **Sol 快捷卡片补齐项目上下文**
  - Sol 与 Codex 两侧现在使用更一致的项目 / Session 上下文。
  - 从 Codex 拉回内容时，可以更明确地知道当前 Context 来自哪个项目。
- **项目文件能力增强**
  - 项目文件可以直接选择并插入 ChatGPT。
  - 减少手动打开文件、复制代码再回到 ChatGPT 的步骤。
- **图片文件支持**
  - 支持识别项目中的 PNG / JPG / WebP 等图片。
  - 可以预览并加入 ChatGPT Context，方便继续进行 UI、设计稿和视觉问题分析。

### 优化

- **Sol / Codex 快捷按钮交互统一**
  - 两个按钮使用一致的 hover / active 动效。
  - 修复鼠标停留时动画反复播放导致的按钮抖动。
- **长内容交接流程优化**
  - 调整长 Prompt / 长任务发送流程。
  - 保留先进入 Codex 执行、ChatGPT 页面继续显示任务状态的方式。
  - 避免任务执行期间锁住当前 ChatGPT 会话。
- **Loading 状态重新统一**
  - 恢复 Pixel Grid Loading 动画。
  - 保留实时执行计时和任务状态反馈。
  - Sol → Codex 的执行状态更加清晰。
- **项目 Context 状态对齐**
  - Side Panel、Sol 快捷卡片和 Codex 快捷按钮共享更一致的项目状态。
  - 减少切换入口后项目或 Session 不一致的问题。

### 当前工作流

`ChatGPT / Sol → 本地项目 / Session → Codex 执行`

`Codex → Session / Git Diff / Project Files / Images → ChatGPT`

目标仍然只有一个：

**Think in ChatGPT. Build in Codex.**

## 0.2.11

这版主要补齐了 **Sol ↔ Codex 双向上下文交接**，同时把项目文件读取和日常使用体验完善了一轮。

### 新增

- **Codex → Sol**
  - 可以从 Codex 获取当前工作内容，再带回 ChatGPT 继续分析。
  - 支持读取：
    - 最近进度
    - 会话记录
    - Git Diff
    - 项目文件
- **项目文件浏览**
  - 直接浏览当前 Codex 项目的目录和文件。
  - 支持展开文件夹、查看文本文件内容。
  - 选中的文件可以直接加入 ChatGPT，不用再手动复制粘贴。
- **图片文件支持**
  - 项目里的 PNG / JPG / WebP 等图片可以预览。
  - 图片可以直接添加到 ChatGPT，方便继续做 UI、设计稿、截图分析等任务。
- **中 / EN 双语界面**
  - 支持中文和 English 快速切换。
  - 会自动记住上次使用的语言。

### 体验优化

- 优化 ChatGPT 页面中的 **← Sol / Codex →** 快捷入口。
- 优化「从 Codex 获取」弹窗，长内容不再容易超出屏幕。
- 项目文件与插件当前选择的本地项目保持一致。
- 文本、图片、文件预览的交互更加统一。
- 优化按钮 Hover 效果，减少抖动和重复动画。
- 改进 Bridge 与扩展版本不一致时的提示和兼容处理。

### 现在可以这样用

**ChatGPT 里想好方案 → Codex 本地执行 → 把进度 / Diff / 文件重新带回 ChatGPT → 继续分析和修改。**

减少在 ChatGPT、Codex、Finder 之间反复切换和复制粘贴。

> 仍然保持 Local First，本地项目内容通过本机 Bridge 进行交接。
