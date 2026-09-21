(() => {
  const WIDGET_ATTR = "data-codex-run-widget";
  const MESSAGE_ATTRS = ["data-message-id", "data-testid"];
  let fallbackMessageIndex = 0;

  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    '[data-testid*="conversation-turn"] [data-message-author-role="assistant"]',
  ];

  function assistantMessages() {
    const seen = new Set();
    return assistantSelectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((node) => {
        if (seen.has(node) || node.closest(`[${WIDGET_ATTR}]`)) return false;
        seen.add(node);
        return true;
      });
  }

  function normalizeText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  }

  function childNodesOf(node) {
    return [...(node?.childNodes || [])];
  }

  function inlineMarkdown(node) {
    if (!node) return "";
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || node.textContent || "";
    if (node.nodeType !== 1 || node.matches?.(`[${WIDGET_ATTR}]`)) return "";

    const tag = String(node.tagName || "").toLowerCase();
    const content = childNodesOf(node).map(inlineMarkdown).join("");
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return `**${content}**`;
    if (tag === "em" || tag === "i") return `*${content}*`;
    if (tag === "del" || tag === "s") return `~~${content}~~`;
    if (tag === "code") return `\`${content}\``;
    if (tag === "a") {
      const href = node.getAttribute?.("href");
      return href && content ? `[${content}](${href})` : content;
    }
    return content;
  }

  function codeLanguage(pre) {
    const label = pre.querySelector?.('[class*="font-medium"]');
    return normalizeText(label?.textContent).trim().replace(/\s+/g, " ");
  }

  function listMarkdown(node) {
    const ordered = String(node.tagName || "").toLowerCase() === "ol";
    return [...(node.children || [])]
      .filter((item) => String(item.tagName || "").toLowerCase() === "li")
      .map((item, index) => {
        const nested = [...(item.children || [])]
          .filter((child) => ["ol", "ul"].includes(String(child.tagName || "").toLowerCase()))
          .map(blockMarkdown)
          .filter(Boolean)
          .join("\n");
        const content = childNodesOf(item)
          .filter((child) => !["ol", "ul"].includes(String(child.tagName || "").toLowerCase()))
          .map(inlineMarkdown)
          .join("")
          .trim();
        const prefix = ordered ? `${index + 1}. ` : "- ";
        return `${prefix}${content}${nested ? `\n${nested.split("\n").map((line) => `  ${line}`).join("\n")}` : ""}`;
      })
      .join("\n");
  }

  function blockMarkdown(node) {
    if (!node) return "";
    if (node.nodeType === 3 || node.nodeType === 4) return normalizeText(node.nodeValue || node.textContent).trim();
    if (node.nodeType !== 1 || node.matches?.(`[${WIDGET_ATTR}]`)) return "";

    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "pre") {
      const code = node.querySelector?.("code");
      const value = normalizeText(code?.textContent ?? node.textContent).replace(/\n+$/, "");
      return `\`\`\`${codeLanguage(node)}\n${value}\n\`\`\``;
    }
    if (tag === "ul" || tag === "ol") return listMarkdown(node);
    if (tag === "blockquote") {
      const value = [...(node.children || [])].map(blockMarkdown).filter(Boolean).join("\n\n") || inlineMarkdown(node);
      return value.split("\n").map((line) => `> ${line}`).join("\n");
    }
    if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${inlineMarkdown(node).trim()}`;
    if (tag === "hr") return "---";
    if (["p", "li"].includes(tag)) return inlineMarkdown(node).trim();

    const children = [...(node.children || [])];
    if (children.some((child) => /^(p|pre|ul|ol|blockquote|h[1-6]|hr|div)$/.test(String(child.tagName || "").toLowerCase()))) {
      return children.map(blockMarkdown).filter(Boolean).join("\n\n");
    }
    return inlineMarkdown(node).trim();
  }

  function textFor(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(`[${WIDGET_ATTR}]`).forEach((widget) => widget.remove());
    const root = clone.querySelector?.(".markdown") || clone;
    const blocks = [...(root.children || [])].map(blockMarkdown).filter(Boolean);
    return (blocks.join("\n\n") || normalizeText(clone.innerText || clone.textContent || "")).trim();
  }

  function messageIdFor(node, text) {
    for (const attr of MESSAGE_ATTRS) {
      const value = node.getAttribute(attr);
      if (value) return value;
    }
    if (!node.__codexMessageId) {
      fallbackMessageIndex += 1;
      let hash = 2166136261;
      for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
      node.__codexMessageId = `assistant-${Math.abs(hash >>> 0)}-${fallbackMessageIndex}`;
    }
    return node.__codexMessageId;
  }

  function conversationTitle() {
    return (document.querySelector("h1")?.innerText || document.title || "ChatGPT conversation").trim();
  }

  const elapsedTimers = new WeakMap();
  const driveDelays = [90, 180, 90, 180, 0, 180, 90, 180, 90];
  const driveDuration = 650;

  function createArrowIcon(direction = "right", check = false) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("sol-codex-inline-icon");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", check ? "M3.25 8.25 6.35 11.1 12.75 4.9" : "M2.75 8h9.5m-3.25-3.25 3.25 3.25-3.25 3.25");
    if (direction === "left" && !check) svg.classList.add("left");
    svg.appendChild(path);
    return svg;
  }

  function createIconSlot(icon = null) {
    const slot = document.createElement("span");
    slot.className = "sol-codex-icon-slot";
    if (icon) slot.appendChild(icon);
    return slot;
  }

  function createSettingsIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("sol-codex-settings-icon");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z");
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "3");
    svg.append(path, circle);
    return svg;
  }

  function createChevronDownIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("sol-codex-chevron-icon");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "m6 9 6 6 6-6");
    svg.append(path);
    return svg;
  }

  function createDriveLoader() {
    const grid = document.createElement("span");
    grid.className = "sol-codex-loader-grid";
    grid.setAttribute("aria-hidden", "true");
    driveDelays.forEach((delay) => {
      const pixel = document.createElement("span");
      pixel.className = "sol-codex-loader-pixel";
      pixel.style.animationDelay = `${delay}ms`;
      pixel.style.animationDuration = `${driveDuration}ms`;
      grid.appendChild(pixel);
    });
    return grid;
  }

  function stopElapsed(button) {
    const timer = elapsedTimers.get(button);
    if (timer) clearInterval(timer);
    elapsedTimers.delete(button);
  }

  function startElapsed(button) {
    stopElapsed(button);
    const update = () => {
      const elapsed = button.querySelector?.(".sol-codex-loading-elapsed");
      if (!elapsed) return;
      elapsed.textContent = `${((Date.now() - Number(button.dataset.startedAt || Date.now())) / 1000).toFixed(1)}s`;
    };
    update();
    elapsedTimers.set(button, setInterval(update, 100));
  }

  function setState(button, state, error = "") {
    const previousState = button.dataset.state || "";
    const loading = ["sending", "accepted", "running"].includes(state);
    if (loading && !["sending", "accepted", "running"].includes(previousState)) {
      button.dataset.startedAt = String(Date.now());
    }
    if (!loading) stopElapsed(button);
    const renderState = `${state}:${error}`;
    if (button.dataset.renderState === renderState) return;
    button.dataset.renderState = renderState;
    button.dataset.state = state;
    button.replaceChildren();
    button.disabled = loading;
    button.title = error || "";
    button.setAttribute("aria-label", loading ? "Codex 执行中" : state === "error" ? "重试" : "发送到 Codex");

    const label = document.createElement("span");
    label.className = "sol-codex-inline-label";
    if (state === "idle" || state === "sent") {
      label.textContent = "Codex";
      button.append(createIconSlot(createArrowIcon("left")), label);
    } else if (state === "executed") {
      label.textContent = "Codex";
      button.append(label, createIconSlot(createArrowIcon(true)));
      setTimeout(() => {
        if (button.isConnected !== false && button.dataset.state === "executed") setState(button, "idle");
      }, 1200);
    } else if (loading) {
      const loadingLabel = document.createElement("span");
      loadingLabel.className = "sol-codex-loading-label";
      loadingLabel.textContent = state === "accepted" ? "Codex 已接收" : state === "running" ? "Codex 执行中…" : "正在发送…";
      const elapsed = document.createElement("span");
      elapsed.className = "sol-codex-loading-elapsed";
      button.append(createDriveLoader(), loadingLabel, elapsed);
      startElapsed(button);
    } else {
      label.textContent = "重试";
      button.append(label, createIconSlot());
    }
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response || {});
      });
    });
  }

  async function readTransferMode() {
    try {
      const saved = await chrome.storage.local.get(["transferMode"]);
      return globalThis.SolCodexContextActions?.normalizeTransferMode?.(saved.transferMode) || "auto";
    } catch {
      return "auto";
    }
  }

  async function saveTransferMode(value) {
    const transferMode = globalThis.SolCodexContextActions?.normalizeTransferMode?.(value) || "auto";
    try { await chrome.storage.local.set({ transferMode }); } catch {}
    return transferMode;
  }

  async function saveBridgeToken(value) {
    const result = await runtimeMessage({ type: "SET_BRIDGE_TOKEN", token: String(value || "").trim() });
    if (!result.accepted) throw Object.assign(new Error(result.error || "Pairing Token 无效"), { code: result.code });
    return result;
  }

  function targetLabel(target) {
    if (!target) return "选择目标";
    if (target.mode === "new") return `${target.projectName || "项目"} · 新任务`;
    return `${target.projectName || "项目"} · ${target.sessionTitle || "已有会话"}`;
  }

  function setTargetButtonLabel(button, text) {
    const status = button.querySelector?.(".sol-codex-target-status");
    button.replaceChildren();
    if (status) button.append(status);
    const label = document.createElement("span");
    label.className = "sol-codex-target-label";
    label.textContent = text;
    button.append(label);
  }

  function setTargetStatus(indicator, status, label) {
    if (!indicator) return;
    indicator.dataset.status = status;
    indicator.setAttribute("aria-label", label);
    indicator.title = label;
  }

  function closeContextPanel(wrapper) {
    const outsideHandler = wrapper.__codexContextOutsideHandler;
    if (outsideHandler) {
      document.removeEventListener("click", outsideHandler, true);
      delete wrapper.__codexContextOutsideHandler;
    }
    wrapper.querySelector?.(".sol-codex-context-panel")?.remove?.();
  }

  function contextText(resource, value) {
    if (!value) return "";
    if (["project", "session", "snapshot"].includes(resource)) return String(value.text || "");
    if (resource === "file") return value.kind === "text" ? String(value.content || "") : "";
    if (resource === "git-diff") {
      return [
        `Branch: ${value.branch || "unknown"}`,
        `Changed files: ${(value.changedFiles || []).join(", ") || "none"}`,
        "",
        value.diff || "",
        value.stagedDiff ? `\n\n--- staged ---\n${value.stagedDiff}` : "",
      ].join("\n").trim();
    }
    if (resource === "files") {
      return (value.entries || []).map((entry) => `${entry.type === "directory" ? "[dir] " : ""}${entry.path}`).join("\n");
    }
    return "";
  }

  function insertIntoChatGPT(text) {
    const site = globalThis.SolCodexChatGPTSite;
    if (!site?.insertText) throw new Error("ChatGPT composer adapter unavailable");
    const result = site.insertText(text);
    if (!result?.ok) {
      const error = new Error(result?.code === "NO_COMPOSER" ? "ChatGPT composer not found" : "无法插入 ChatGPT Composer");
      error.code = result?.code;
      throw error;
    }
    return result;
  }

  async function openContextPanel(wrapper, contextButton, targetStatus, { host = null, embedded = false } = {}) {
    closeContextPanel(wrapper);
    contextButton.disabled = true;
    setTargetStatus(targetStatus, "warning", "正在读取 Codex 项目列表");

    const panel = document.createElement("div");
    panel.className = embedded ? "sol-codex-context-panel sol-codex-target-read-view" : "sol-codex-context-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "读取 Codex 上下文");
    const title = document.createElement("div");
    title.className = "sol-codex-context-title";
    title.textContent = "读取 Codex 上下文";

    const tabs = document.createElement("div");
    tabs.className = "sol-codex-context-tabs";
    const content = document.createElement("div");
    content.className = "sol-codex-context-content";
    const fileList = document.createElement("div");
    fileList.className = "sol-codex-context-files";
    const preview = document.createElement("pre");
    preview.className = "sol-codex-context-preview";
    content.append(fileList, preview);
    const readTargetFields = document.createElement("div");
    readTargetFields.className = "sol-codex-context-target-fields";
    const readProjectField = createChoiceField("项目", "选择读取项目");
    const readSessionField = createChoiceField("会话", "选择读取会话");
    readTargetFields.append(readProjectField.field, readSessionField.field);
    if (!embedded) panel.append(title);
    panel.append(readTargetFields, tabs, content);

    const actions = document.createElement("div");
    actions.className = "sol-codex-context-actions";
    const permission = document.createElement("button");
    permission.type = "button";
    permission.className = "sol-codex-context-permission";
    const insert = document.createElement("button");
    insert.type = "button";
    insert.className = "sol-codex-context-insert";
    insert.textContent = "插入 ChatGPT";
    insert.disabled = true;
    const transferHint = document.createElement("span");
    transferHint.className = "sol-codex-context-transfer-hint";
    actions.append(permission, transferHint, insert);
    panel.append(actions);
    (host || wrapper).append(panel);

    if (!embedded) {
      const closeOnOutside = (event) => {
        if (panel.contains?.(event.target) || contextButton.contains?.(event.target)) return;
        closeContextPanel(wrapper);
        contextButton.setAttribute("aria-expanded", "false");
        contextButton.disabled = false;
      };
      wrapper.__codexContextOutsideHandler = closeOnOutside;
      document.addEventListener("click", closeOnOutside, true);
      contextButton.setAttribute("aria-expanded", "true");
    }

    let activeResource = "snapshot";
    let currentText = "";
    let currentFile = null;
    let currentDirectory = "";
    let transferMode = "auto";
    let allowed = false;
    let readProjects = [];
    let readTarget = null;
    let permissionProjectPath = "";

    function updateTransferHint() {
      const resolved = globalThis.SolCodexContextActions?.resolveTransferMode?.(transferMode, currentText) || "text";
      transferHint.textContent = resolved === "file" ? "将作为 Markdown 文件上传" : "将作为文本插入";
    }

    function setPreview(text, error = "") {
      currentText = String(text || "");
      preview.textContent = error || currentText || "暂无可显示内容。";
      insert.disabled = !currentText;
      updateTransferHint();
    }

    function setError(error) {
      fileList.replaceChildren();
      setPreview("", error?.message || String(error));
      setTargetStatus(targetStatus, "error", error?.message || String(error));
    }

    function tabsFor(target) {
      const items = target?.sessionId
        ? [["snapshot", "最近进度"], ["project", "项目上下文"], ["session", "会话记录"], ["git-diff", "Git Diff"], ["files", "项目文件"]]
        : [["project", "项目上下文"], ["git-diff", "Git Diff"], ["files", "项目文件"]];
      tabs.replaceChildren();
      items.forEach(([resource, label]) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "sol-codex-context-tab";
        tab.textContent = label;
        tab.dataset.resource = resource;
        tab.addEventListener("click", () => { activeResource = resource; load(resource); });
        tabs.append(tab);
      });
      activeResource = items.some(([resource]) => resource === activeResource) ? activeResource : items[0][0];
    }

    function selectedReadProject() {
      return readProjects.find((project) => project.path === readProjectField.getValue()) || null;
    }

    function fillReadSessions(preferred = "") {
      const sessions = selectedReadProject()?.sessions || [];
      readSessionField.setOptions(sessions.map((session) => ({
        value: session.id,
        label: `${session.title} · ${session.status}`,
      })));
      const sessionId = sessions.some((session) => session.id === preferred) ? preferred : sessions[0]?.id || "";
      readSessionField.setValue(sessionId);
      readSessionField.field.hidden = sessions.length === 0;
    }

    function setReadTargetState(state) {
      readProjects = state.projects || [];
      const saved = state.savedTarget || {};
      const currentProject = readProjects.some((project) => project.path === readProjectField.getValue())
        ? readProjectField.getValue()
        : saved.projectPath;
      const projectPath = readProjects.some((project) => project.path === currentProject)
        ? currentProject
        : readProjects[0]?.path || "";
      readProjectField.setOptions(readProjects.map((project) => ({ value: project.path, label: project.name || project.path })));
      readProjectField.setValue(projectPath);
      fillReadSessions(saved.sessionId || readSessionField.getValue());
      readTarget = state.target || null;
      panel.dataset.projectName = selectedReadProject()?.name || "";
    }

    async function saveReadSelection() {
      const project = selectedReadProject();
      const result = await runtimeMessage({
        type: "SET_CODEX_READ_TARGET",
        target: { mode: "queue", projectPath: project?.path || "", sessionId: readSessionField.getValue() },
      });
      if (!result.accepted) throw new Error(result.error || "无法保存读取目标");
      readTarget = result.target || null;
      return result;
    }

    function renderFiles(value) {
      fileList.replaceChildren();
      if (currentDirectory) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "sol-codex-context-file";
        back.textContent = "↩ 返回上级目录";
        back.addEventListener("click", () => {
          currentDirectory = currentDirectory.split("/").slice(0, -1).join("/");
          load("files");
        });
        fileList.append(back);
      }
      (value.entries || []).forEach((entry) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "sol-codex-context-file";
        item.textContent = `${entry.type === "directory" ? "▸" : "·"} ${entry.name}`;
        item.title = entry.path;
        item.addEventListener("click", () => {
          if (entry.type === "directory") {
            currentDirectory = entry.path;
            load("files");
          } else {
            load("file", { relativePath: entry.relativePath });
          }
        });
        fileList.append(item);
      });
    }

    async function load(resource, body = {}) {
      activeResource = resource;
      tabs.querySelectorAll?.(".sol-codex-context-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.resource === resource));
      fileList.replaceChildren();
      setPreview("读取中…");
      try {
        const result = await runtimeMessage({ type: "READ_CODEX_CONTEXT", resource, body: resource === "files" ? { relativePath: currentDirectory } : body });
        if (!result.accepted) throw new Error(result.error || "读取 Codex Context 失败");
        const value = result.value;
        currentFile = resource === "project" ? value?.file || null : null;
        if (resource === "files") renderFiles(value);
        setPreview(contextText(resource, value));
        setTargetStatus(targetStatus, "ok", "Codex Context 已读取");
      } catch (error) {
        setError(error);
      }
    }

    function showPermissionPrompt() {
      tabs.replaceChildren();
      fileList.replaceChildren();
      setPreview("首次读取此项目需要明确授权。授权后，服务端才会开放 Context、Session、Git 和项目文件读取。\n\n项目：" + (panel.dataset.projectName || "当前选择的项目"));
      permission.textContent = "允许读取此项目";
      setTargetStatus(targetStatus, "warning", "当前项目尚未授权 Context 读取");
    }

    async function loadPermission() {
      const targetState = await runtimeMessage({ type: "GET_CODEX_READ_TARGET_STATE" });
      if (!targetState.accepted) throw new Error(targetState.error || "无法读取 Codex 项目列表");
      setReadTargetState(targetState);
      if (!readProjects.length) {
        allowed = false;
        permission.disabled = true;
        tabs.replaceChildren();
        setPreview("已连接 Bridge，但没有发现可读取的 Codex 项目。");
        setTargetStatus(targetStatus, "warning", "未发现 Codex 项目");
        return;
      }
      return loadSelectedPermission();
    }

    async function loadSelectedPermission() {
      const project = selectedReadProject();
      permissionProjectPath = project?.path || "";
      if (!permissionProjectPath) throw new Error("请选择一个 Codex 项目");
      const result = await runtimeMessage({ type: "GET_CODEX_READ_PERMISSION", projectPath: permissionProjectPath });
      if (!result.accepted) throw new Error(result.error || "无法读取 Codex Context 权限");
      allowed = Boolean(result.permission?.allowed);
      permission.disabled = false;
      panel.dataset.projectName = project.name || project.path;
      if (!allowed) return showPermissionPrompt();
      const saved = await saveReadSelection();
      permission.textContent = "取消授权";
      tabsFor(saved.target || readTarget);
      await load(activeResource);
    }

    permission.addEventListener("click", async () => {
      try {
        if (!permissionProjectPath) throw new Error("请选择一个 Codex 项目");
        const result = await runtimeMessage({ type: "SET_CODEX_READ_PERMISSION", projectPath: permissionProjectPath, allowed: !allowed });
        if (!result.accepted) throw new Error(result.error || "无法更新 Context 权限");
        allowed = !allowed;
        if (allowed) {
          const saved = await saveReadSelection();
          permission.textContent = "取消授权";
          tabsFor(saved.target || readTarget);
          await load(activeResource);
        } else {
          showPermissionPrompt();
        }
      } catch (error) {
        setError(error);
      }
    });

    readProjectField.onChange(() => {
      fillReadSessions();
      void loadSelectedPermission().catch(setError);
    });
    readSessionField.onChange(() => {
      if (!allowed) return;
      void saveReadSelection().then((result) => {
        tabsFor(result.target || readTarget);
        return load(activeResource);
      }).catch(setError);
    });

    insert.addEventListener("click", async () => {
      insert.disabled = true;
      try {
        const payload = globalThis.SolCodexContextActions.createPayload({
          kind: activeResource,
          title: activeResource,
          content: currentText,
          suggestedFileName: currentFile?.filename || `codex-${activeResource}.md`,
          fileContent: currentFile?.text || currentText,
          mime: currentFile?.mimeType || "text/markdown"
        });
        const result = await globalThis.SolCodexContextActions.sendPayload(payload, transferMode, {
          insertText: (text) => insertIntoChatGPT(text),
          attachFile: (file) => globalThis.SolCodexChatGPTSite?.attachFile?.(file),
          fallbackToText: true
        });
        if (!result?.ok) throw Object.assign(new Error("无法发送 Context 到 ChatGPT"), { code: result?.code });
        insert.textContent = result.mode === "file" ? "已上传" : "已插入";
        setTimeout(() => { if (insert.isConnected) insert.textContent = "插入 ChatGPT"; }, 1200);
      } catch (error) {
        setError(error);
        insert.disabled = false;
      }
    });

    try {
      try {
        transferMode = await readTransferMode();
      } catch {}
      updateTransferHint();
      await loadPermission();
    } catch (error) {
      setError(error);
    } finally {
      contextButton.disabled = false;
    }
  }

  function createChoiceField(labelText, ariaLabel) {
    const field = document.createElement("div");
    field.className = "sol-codex-choice-field";

    const label = document.createElement("div");
    label.className = "sol-codex-choice-label";
    label.textContent = labelText;

    const shell = document.createElement("div");
    shell.className = "sol-codex-choice";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "sol-codex-choice-trigger";
    trigger.setAttribute("aria-label", ariaLabel);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const value = document.createElement("span");
    value.className = "sol-codex-choice-value";
    value.textContent = "请选择";
    const chevron = document.createElement("span");
    chevron.className = "sol-codex-choice-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.append(createChevronDownIcon());
    trigger.append(value, chevron);

    const list = document.createElement("div");
    list.className = "sol-codex-choice-menu";
    list.setAttribute("role", "listbox");
    list.hidden = true;

    shell.append(trigger, list);
    field.append(label, shell);

    let current = "";
    let items = [];
    let open = false;
    const changeHandlers = new Set();

    function setOpen(next) {
      open = next;
      list.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
      shell.classList.toggle("open", open);
    }

    function setValue(next) {
      current = String(next || "");
      const selected = items.find((item) => item.value === current);
      value.textContent = selected?.label || "请选择";
      items.forEach((item) => {
        item.node?.toggleAttribute?.("data-selected", item.value === current);
        item.node?.setAttribute?.("aria-selected", String(item.value === current));
      });
    }

    function setOptions(nextItems) {
      items = nextItems.map((item) => ({ ...item, value: String(item.value) }));
      list.replaceChildren();
      items.forEach((item) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "sol-codex-choice-option";
        option.setAttribute("role", "option");
        option.textContent = item.label;
        option.addEventListener("click", () => {
          setValue(item.value);
          setOpen(false);
          trigger.focus?.();
          changeHandlers.forEach((handler) => handler(item.value));
        });
        item.node = option;
        list.append(option);
      });
      setValue(current);
    }

    trigger.addEventListener("click", () => setOpen(!open));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
    });

    return {
      field,
      getValue: () => current,
      setValue,
      setOptions,
      onChange: (handler) => changeHandlers.add(handler),
    };
  }

  function closeTargetPicker(wrapper) {
    const outsideHandler = wrapper.__codexTargetOutsideHandler;
    if (outsideHandler) {
      document.removeEventListener("click", outsideHandler, true);
      delete wrapper.__codexTargetOutsideHandler;
    }
    wrapper.querySelector?.(".sol-codex-target-popover")?.remove?.();
  }

  async function openTargetPicker(wrapper, targetButton, targetStatus, contextButton) {
    closeTargetPicker(wrapper);
    targetButton.disabled = true;
    setTargetStatus(targetStatus, "warning", "正在读取 Codex 目标状态");
    let state = { projects: [], savedTarget: {}, ready: false, reason: "" };
    let stateError = "";
    try {
      state = await runtimeMessage({ type: "GET_CODEX_TARGET_STATE" });
      if (!state.accepted) throw new Error(state.error || "无法读取 Codex 目标");
    } catch (error) {
      stateError = error.message;
      state.reason = stateError;
    }
      setTargetStatus(
        targetStatus,
        stateError ? "error" : state.accepted ? "ok" : "warning",
        stateError || (state.ready ? "Codex 目标已就绪" : "Bridge 已配对，请选择 Codex 目标"),
    );
    targetButton.title = stateError || targetButton.title;
    targetButton.setAttribute("aria-expanded", "true");
    const initiallyPaired = Boolean(state.accepted && !stateError);

    const popover = document.createElement("div");
    popover.className = "sol-codex-target-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "选择 Codex 目标");

    const topbar = document.createElement("div");
    topbar.className = "sol-codex-target-topbar";
    const title = document.createElement("div");
    title.className = "sol-codex-target-title";
    title.textContent = "Codex Bridge";
    const tabRow = document.createElement("div");
    tabRow.className = "sol-codex-target-tab-row";
    const sendTab = document.createElement("button");
    sendTab.type = "button";
    sendTab.className = "sol-codex-target-tab active";
    sendTab.setAttribute("role", "tab");
    sendTab.setAttribute("aria-selected", "true");
    sendTab.textContent = "发送到 Codex";
    contextButton.classList.add("sol-codex-target-tab");
    contextButton.setAttribute("role", "tab");
    contextButton.setAttribute("aria-selected", "false");
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "sol-codex-target-settings";
    settingsButton.append(createSettingsIcon());
    settingsButton.title = "传输方式设置";
    settingsButton.setAttribute("aria-label", "传输方式设置");
    settingsButton.setAttribute("aria-haspopup", "menu");
    settingsButton.setAttribute("aria-expanded", "false");
    const settingsMenu = document.createElement("div");
    settingsMenu.className = "sol-codex-target-settings-menu";
    settingsMenu.setAttribute("role", "menu");
    const settingsLabel = document.createElement("div");
    settingsLabel.className = "sol-codex-target-settings-label";
    settingsLabel.textContent = "Context 传输";
    settingsMenu.append(settingsLabel);
    const settingButtons = new Map();
    [["auto", "自动"], ["text", "始终文本"], ["file", "始终 Markdown 文件"]].forEach(([value, label]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "sol-codex-target-setting-option";
      item.setAttribute("role", "menuitemradio");
      item.dataset.value = value;
      item.append(document.createElement("span"));
      item.firstChild.textContent = label;
      const check = document.createElement("span");
      check.className = "sol-codex-target-setting-check";
      check.textContent = "✓";
      item.append(check);
      settingsMenu.append(item);
      settingButtons.set(value, item);
    });
    const selectedTransferMode = await readTransferMode();
    settingButtons.forEach((item, value) => item.classList.toggle("active", value === selectedTransferMode));
    const pairingRow = document.createElement("div");
    pairingRow.className = "sol-codex-target-pairing-row";
    const pairingInput = document.createElement("input");
    pairingInput.type = "password";
    pairingInput.className = "sol-codex-target-pairing-input";
    pairingInput.placeholder = "粘贴 Pairing Token";
    pairingInput.autocomplete = "off";
    pairingInput.spellcheck = false;
    const pairingSave = document.createElement("button");
    pairingSave.type = "button";
    pairingSave.className = "sol-codex-target-pairing-save";
    pairingSave.textContent = "保存";
    pairingRow.append(pairingInput, pairingSave);
    const pairingStatus = document.createElement("div");
    pairingStatus.className = "sol-codex-target-pairing-status";
    const closeSettings = () => {
      settingsMenu.classList.remove("open");
      settingsButton.setAttribute("aria-expanded", "false");
    };
    settingsButton.addEventListener("click", () => {
      const open = settingsMenu.classList.toggle("open");
      settingsButton.setAttribute("aria-expanded", String(open));
    });
    const settingsWrap = document.createElement("div");
    settingsWrap.className = "sol-codex-target-settings-wrap";
    settingsWrap.append(settingsButton, settingsMenu);
    const pairingButton = document.createElement("button");
    pairingButton.type = "button";
    pairingButton.className = "sol-codex-target-pairing-button";
    pairingButton.setAttribute("aria-haspopup", "dialog");
    pairingButton.setAttribute("aria-expanded", "false");
    const pairingMenu = document.createElement("div");
    pairingMenu.className = "sol-codex-target-pairing-menu";
    pairingMenu.setAttribute("role", "dialog");
    pairingMenu.setAttribute("aria-label", "Bridge 配对");
    const pairingLabel = document.createElement("div");
    pairingLabel.className = "sol-codex-target-settings-label";
    pairingLabel.textContent = "Bridge 配对";
    pairingMenu.append(pairingLabel, pairingRow, pairingStatus);
    const pairingWrap = document.createElement("div");
    pairingWrap.className = "sol-codex-target-pairing-wrap";
    pairingWrap.append(pairingButton, pairingMenu);
    const updatePairingState = (paired, message = "") => {
      pairingButton.dataset.paired = String(paired);
      pairingButton.disabled = paired;
      pairingButton.textContent = paired ? "已配对" : "配对";
      pairingButton.title = paired ? "已配对" : "粘贴 Pairing Token 完成配对";
      pairingButton.setAttribute("aria-label", pairingButton.title);
      pairingStatus.textContent = message || (paired ? "已配对。Token 只保存在扩展本地存储。" : "尚未配对，请粘贴 Pairing Token。");
      setTargetStatus(targetStatus, paired ? "ok" : "warning", paired ? "Bridge 已配对，请选择 Codex 目标" : "Bridge 尚未配对，请点击配对");
    };
    updatePairingState(initiallyPaired);
    pairingButton.addEventListener("click", () => {
      closeSettings();
      const open = pairingMenu.classList.toggle("open");
      pairingButton.setAttribute("aria-expanded", String(open));
      if (!open) return;
      pairingInput.focus();
    });
    const closePairing = () => {
      pairingMenu.classList.remove("open");
      pairingButton.setAttribute("aria-expanded", "false");
    };
    const topbarActions = document.createElement("div");
    topbarActions.className = "sol-codex-target-topbar-actions";
    topbarActions.append(pairingWrap, settingsWrap);
    tabRow.append(sendTab, contextButton);
    topbar.append(title, topbarActions);
    popover.append(topbar, tabRow);
    settingButtons.forEach((item) => item.addEventListener("click", async () => {
      const value = await saveTransferMode(item.dataset.value);
      settingButtons.forEach((candidate, key) => candidate.classList.toggle("active", key === value));
      closeSettings();
    }));
    pairingSave.addEventListener("click", async () => {
      pairingSave.disabled = true;
      pairingStatus.textContent = "正在验证…";
      wrapper.__codexBridgeStateVersion = (wrapper.__codexBridgeStateVersion || 0) + 1;
      try {
        await saveBridgeToken(pairingInput.value);
        pairingInput.value = "";
        wrapper.__codexBridgePaired = true;
        updatePairingState(true, "已配对，正在刷新项目…");
        try {
          const refreshed = await refreshTargetState();
          setTargetStatus(
            targetStatus,
            refreshed.accepted ? "ok" : "error",
            refreshed.ready ? "Codex 目标已就绪" : "Bridge 已配对，请选择 Codex 目标",
          );
          pairingStatus.textContent = "已配对，项目列表已刷新。";
        } catch (error) {
          pairingStatus.textContent = `已配对，但项目刷新失败：${error.message || "请稍后重试"}`;
        }
        closePairing();
      } catch (error) {
        wrapper.__codexBridgePaired = false;
        updatePairingState(false, error.message || "Pairing Token 无效");
      } finally {
        pairingSave.disabled = false;
      }
    });
    settingsButton.addEventListener("click", closePairing);
    popover.addEventListener("click", (event) => {
      if (!settingsWrap.contains?.(event.target)) closeSettings();
      if (!pairingWrap.contains?.(event.target)) closePairing();
    });

    const sendView = document.createElement("div");
    sendView.className = "sol-codex-target-send-view";

    const modes = document.createElement("div");
    modes.className = "sol-codex-target-modes";
    modes.setAttribute("role", "group");
    const modeButtons = new Map();
    [
      ["queue", "已有会话"],
      ["new", "项目新任务"],
    ].forEach(([mode, label]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "sol-codex-target-mode";
      item.setAttribute("aria-pressed", "false");
      item.textContent = label;
      item.dataset.mode = mode;
      modes.append(item);
      modeButtons.set(mode, item);
    });
    const modeLabel = document.createElement("div");
    modeLabel.className = "sol-codex-target-section-label";
    modeLabel.textContent = "发送方式";
    sendView.append(modeLabel, modes);

    const fields = document.createElement("div");
    fields.className = "sol-codex-target-fields";
    const projectField = createChoiceField("项目", "选择项目");
    const sessionField = createChoiceField("会话", "选择会话");
    fields.append(projectField.field, sessionField.field);
    sendView.append(fields);

    const actions = document.createElement("div");
    actions.className = "sol-codex-target-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sol-codex-target-cancel";
    cancel.textContent = "取消";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "sol-codex-target-save";
    save.textContent = "保存目标";
    actions.append(cancel, save);
    const hint = document.createElement("div");
    hint.className = "sol-codex-target-hint";
    sendView.append(hint, actions);
    popover.append(sendView);
    wrapper.append(popover);
    const closeOnOutside = (event) => {
      if (popover.contains?.(event.target) || targetButton.contains?.(event.target)) return;
      closeTargetPicker(wrapper);
      targetButton.setAttribute("aria-expanded", "false");
      targetButton.disabled = false;
    };
    wrapper.__codexTargetOutsideHandler = closeOnOutside;
    document.addEventListener("click", closeOnOutside, true);

    let projects = state.projects || [];
    const saved = state.savedTarget || {};
    let mode = ["queue", "new"].includes(saved.mode) ? saved.mode : "queue";
    let readView = null;

    function setTab(tab) {
      const reading = tab === "read";
      sendTab.classList.toggle("active", !reading);
      sendTab.setAttribute("aria-selected", String(!reading));
      contextButton.classList.toggle("active", reading);
      contextButton.setAttribute("aria-selected", String(reading));
      sendView.hidden = reading;
      if (reading) {
        if (readView) return;
        readView = document.createElement("div");
        readView.className = "sol-codex-target-read-container";
        popover.append(readView);
        void openContextPanel(wrapper, contextButton, targetStatus, { host: readView, embedded: true });
        return;
      }
      closeContextPanel(wrapper);
      readView?.remove?.();
      readView = null;
      contextButton.disabled = false;
    }

    function selectedProject() {
      return projects.find((project) => project.path === projectField.getValue()) || null;
    }

    function fillProjects() {
      projectField.setOptions(projects.map((project) => ({ value: project.path, label: project.name || project.path })));
      const wanted = saved.projectPath && projects.some((project) => project.path === saved.projectPath)
        ? saved.projectPath
        : projects[0]?.path || "";
      projectField.setValue(wanted);
    }

    function fillSessions() {
      const sessions = selectedProject()?.sessions || [];
      sessionField.setOptions(sessions.map((session) => ({
        value: session.id,
        label: `${session.title} · ${session.status}`,
      })));
      const wanted = saved.sessionId && sessions.some((session) => session.id === saved.sessionId)
        ? saved.sessionId
        : sessions[0]?.id || "";
      sessionField.setValue(wanted);
    }

    function render() {
      modeButtons.forEach((item, key) => {
        const active = key === mode;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      fields.hidden = false;
      sessionField.field.hidden = mode !== "queue";
      save.disabled = mode === "queue" && !sessionField.getValue();
      hint.textContent = mode === "new"
        ? "将在当前项目中创建新的 Codex 任务。"
        : "当前内容将追加到所选 Codex 会话。";
    }

    async function refreshTargetState() {
      const refreshed = await runtimeMessage({ type: "GET_CODEX_TARGET_STATE" });
      if (!refreshed.accepted) throw new Error(refreshed.error || "无法刷新 Codex 目标");
      projects = refreshed.projects || [];
      fillProjects();
      fillSessions();
      render();
      if (refreshed.target) setTargetButtonLabel(targetButton, targetLabel(refreshed.target));
      if (readView) {
        readView.replaceChildren();
        void openContextPanel(wrapper, contextButton, targetStatus, { host: readView, embedded: true });
      }
      return refreshed;
    }

    fillProjects();
    fillSessions();
    projectField.onChange(() => { fillSessions(); render(); });
    sessionField.onChange(render);
    modeButtons.forEach((item, key) => item.addEventListener("click", () => { mode = key; render(); }));
    sendTab.addEventListener("click", () => setTab("send"));
    contextButton.onclick = () => setTab("read");
    cancel.addEventListener("click", () => {
      closeTargetPicker(wrapper);
      targetButton.setAttribute("aria-expanded", "false");
      targetButton.disabled = false;
    });
    save.addEventListener("click", async () => {
      const project = selectedProject();
      const target = mode === "new"
        ? { mode: "new", projectPath: project?.path || "", sessionId: null }
        : { mode: "queue", projectPath: project?.path || "", sessionId: sessionField.getValue() };
      let result;
      try {
        result = await runtimeMessage({ type: "SET_CODEX_TARGET", target });
      } catch (error) {
        setTargetStatus(targetStatus, "error", error.message);
        return;
      }
      if (!result.accepted) {
        setTargetStatus(targetStatus, "error", result.error || "无法保存 Codex 目标");
        return;
      }
      setTargetButtonLabel(targetButton, result.target ? targetLabel(result.target) : "目标");
      targetButton.title = result.target ? targetLabel(result.target) : result.reason || "选择 Codex 目标";
      setTargetStatus(
        targetStatus,
        result.target ? "ok" : "warning",
        result.target ? "Codex 目标已就绪" : result.reason || "请选择 Codex 目标",
      );
      closeTargetPicker(wrapper);
      targetButton.setAttribute("aria-expanded", "false");
      targetButton.disabled = false;
    });
    render();
    targetButton.disabled = false;
  }

  function makeWidget(node) {
    const wrapper = document.createElement("div");
    wrapper.setAttribute(WIDGET_ATTR, "");
    wrapper.className = "sol-codex-inline-wrap";
    const actions = document.createElement("div");
    actions.className = "sol-codex-inline-actions";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sol-codex-inline-btn sol-codex-push-btn";
    setState(button, "idle");
    const targetButton = document.createElement("button");
    targetButton.type = "button";
    targetButton.className = "sol-codex-inline-btn sol-codex-target-btn";
    targetButton.title = "选择 Codex 项目或会话";
    targetButton.setAttribute("aria-label", "选择 Codex 项目或会话");
    targetButton.setAttribute("aria-expanded", "false");
    const targetStatus = document.createElement("span");
    targetStatus.className = "sol-codex-target-status";
    targetStatus.setAttribute("role", "img");
    setTargetStatus(targetStatus, "warning", "正在检查 Codex 目标状态");
    targetButton.append(targetStatus);
    setTargetButtonLabel(targetButton, "目标");
    button.__codexTargetStatus = targetStatus;
    targetButton.addEventListener("click", () => {
      closeContextPanel(wrapper);
      void openTargetPicker(wrapper, targetButton, targetStatus, contextButton);
    });
    const contextButton = document.createElement("button");
    contextButton.type = "button";
    contextButton.className = "sol-codex-inline-btn sol-codex-target-read";
    contextButton.textContent = "读取";
    contextButton.title = "读取当前 Codex 项目的上下文";
    contextButton.setAttribute("aria-label", "读取当前 Codex 项目的上下文");
    contextButton.setAttribute("aria-expanded", "false");
    (async () => {
      const stateVersion = wrapper.__codexBridgeStateVersion || 0;
      try {
            const state = await runtimeMessage({ type: "GET_CODEX_TARGET_STATE" });
            if (stateVersion !== (wrapper.__codexBridgeStateVersion || 0)) return;
            wrapper.__codexBridgePaired = Boolean(state.accepted);
            if (state.target) {
              setTargetButtonLabel(targetButton, targetLabel(state.target));
              targetButton.title = targetLabel(state.target);
            }
            setTargetStatus(
              targetStatus,
              state.accepted ? "ok" : "warning",
              state.accepted ? (state.ready ? "Codex 目标已就绪" : "Bridge 已配对，请选择 Codex 目标") : "Bridge 尚未配对，请点击配对",
            );
      } catch (error) {
        if (stateVersion !== (wrapper.__codexBridgeStateVersion || 0)) return;
        wrapper.__codexBridgePaired = false;
        setTargetStatus(targetStatus, "warning", "Bridge 尚未配对，请点击配对");
      }
    })();
    actions.append(targetButton, button);
    wrapper.append(actions);
    node.classList.add("sol-codex-inline-host");
    node.append(wrapper);

    let taskId = null;

    button.addEventListener("click", async () => {
      const text = textFor(node);
      if (button.disabled || !text) return;
      let target;
      try {
        const targetState = await runtimeMessage({ type: "GET_CODEX_TARGET_STATE" });
        if (!targetState.accepted) throw new Error(targetState.error || "无法读取 Codex 目标");
        if (!targetState.ready) {
          setTargetStatus(targetStatus, "warning", targetState.reason || "请选择 Codex 目标");
          setState(button, "error", targetState.reason || "请先点击“目标”选择 Codex 会话");
          return;
        }
        target = targetState.target;
        setTargetStatus(targetStatus, "ok", "Codex 目标已就绪");
      } catch (error) {
        setTargetStatus(targetStatus, "error", error.message);
        setState(button, "error", error.message);
        return;
      }
      const messageId = messageIdFor(node, text);
      const transferMode = await readTransferMode();
      taskId = globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      button.dataset.taskId = taskId;
      setState(button, "sending");
      chrome.runtime.sendMessage(
        {
          type: "RUN_IN_CODEX",
          payload: {
            taskId,
            messageId,
            workspace: target.projectPath,
            projectPath: target.projectPath,
            mode: target.mode,
            sessionId: target.sessionId,
            text,
            transferMode,
            pageUrl: location.href,
            conversationTitle: conversationTitle(),
            createdAt: new Date().toISOString(),
            source: "chatgpt",
          },
        },
        (response) => {
          if (chrome.runtime.lastError || !response?.accepted && !response?.duplicate) {
            setTargetStatus(targetStatus, "error", chrome.runtime.lastError?.message || response?.error || "Bridge 拒绝了任务");
            setState(button, "error", chrome.runtime.lastError?.message || response?.error || "Bridge rejected task");
            return;
          }
          setTargetStatus(targetStatus, "ok", "Codex 目标已就绪");
          setState(button, "accepted");
        },
      );
    });

    node.__codexButton = button;
  }

  function scan() {
    assistantMessages().forEach((node) => {
      if (!node.querySelector(`[${WIDGET_ATTR}]`)) makeWidget(node);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "CODEX_TASK_STATUS") return;
    document.querySelectorAll(`[${WIDGET_ATTR}] button`).forEach((button) => {
      if (button.dataset.taskId !== message.taskId) return;
      setTargetStatus(
        button.__codexTargetStatus,
        message.status === "error" ? "error" : "ok",
        message.status === "error" ? message.error || "Codex 执行失败" : "Codex 目标已就绪",
      );
      setState(button, message.status, message.error);
    });
  });

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
