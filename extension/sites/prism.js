(function () {
  const SELECTORS = Object.freeze({
    roots: [
      '[data-testid*="ai-assistant" i]',
      '[data-testid*="assistant" i]',
      '[aria-label*="AI Assistant" i]',
      '[aria-label*="Assistant" i]',
      '[aria-label*="AI" i]',
      '[id*="ai-assistant" i]',
      '[data-testid*="ai-chat" i]',
      '[class*="ai-assistant" i]',
      '[class*="ai-chat" i]',
      '[class*="assistant-panel" i]',
      '.chat-tab-conversation'
    ],
    messages: [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-author="assistant"]',
      '[data-testid*="assistant-message" i]',
      '[data-testid*="assistant-response" i]',
      '[aria-label*="assistant message" i]',
      '.text-text-editor-primary'
    ],
    composer: [
      'textarea[placeholder*="assistant" i]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="assistant" i]',
      '[contenteditable="true"][aria-label*="assistant" i]',
      '[contenteditable="true"][data-placeholder*="assistant" i]',
      '[role="textbox"][aria-label*="assistant" i]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ],
    stop: [
      'button[data-testid*="stop" i]',
      'button[data-testid*="cancel" i]',
      'button[aria-label*="stop" i]',
      'button[aria-label*="cancel" i]',
      'button[aria-label*="停止"]',
      'button[aria-label*="取消"]',
      'button[aria-label*="停止生成"]',
      'button[aria-label*="取消生成"]',
      '[aria-busy="true"]'
    ],
    uploadTrigger: [
      'button[aria-label*="上传文件" i]',
      'button[aria-label*="upload file" i]',
      'button[aria-label*="attach" i]',
      '[data-testid*="upload" i]'
    ]
  });
  let assistantUploadInput = null;

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  }

  function isCodeEditor(node) {
    return Boolean(node?.closest?.(".cm-editor, .cm-content, .cm-scroller, .monaco-editor, [class*='monaco-editor' i], [class*='code-editor' i]"));
  }

  function semanticMarker(node) {
    return ["id", "class", "role", "aria-label", "data-testid", "data-role", "data-author", "data-message-author-role"]
      .map((name) => node?.getAttribute?.(name) || "")
      .join(" ");
  }

  function looksLikeAssistant(value) {
    return /(?:ai[ -]?assistant|assistant|copilot|chat)/i.test(String(value || ""));
  }

  function findAssistantRoot() {
    const candidates = [];
    for (const selector of SELECTORS.roots) {
      for (const node of document.querySelectorAll(selector)) {
        if (isCodeEditor(node) || !looksLikeAssistant(semanticMarker(node))) continue;
        const score = (node.querySelector(SELECTORS.composer.join(",")) ? 10 : 0)
          + (node.querySelector(SELECTORS.messages.join(",")) ? 5 : 0)
          + Math.min(4, Math.floor((node.querySelectorAll("*").length || 0) / 20));
        candidates.push({ node, score });
      }
    }
    for (const selector of ["aside", '[role="complementary"]', '[role="region"]']) {
      for (const node of document.querySelectorAll(selector)) {
        if (isCodeEditor(node) || !looksLikeAssistant(`${semanticMarker(node)} ${node.textContent}`)) continue;
        const score = (node.querySelector(SELECTORS.composer.join(",")) ? 10 : 0)
          + (node.querySelector(SELECTORS.messages.join(",")) ? 5 : 0);
        candidates.push({ node, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.node || null;
  }

  function assistantText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.(".sol-codex-inline-wrap, .sol-codex-inline-btn").forEach((item) => item.remove());
    return normalizeText(clone.innerText || clone.textContent);
  }

  function assistantNodes() {
    const root = findAssistantRoot();
    if (!root) return [];
    const nodes = new Set();
    for (const selector of SELECTORS.messages) {
      for (const node of root.querySelectorAll(selector)) {
        if (node === root || isCodeEditor(node) || !assistantText(node)) continue;
        if (node.closest(".bg-chat-user-bubble-bg")) continue;
        if (node.matches(".text-text-editor-primary") && !node.querySelector(".markdown-block")) continue;
        nodes.add(node);
      }
    }
    return [...nodes];
  }

  function latestAssistantNode() {
    const nodes = assistantNodes();
    return nodes[nodes.length - 1] || null;
  }

  function composerField(root = findAssistantRoot()) {
    if (!root) return null;
    for (const selector of SELECTORS.composer) {
      const field = [...root.querySelectorAll(selector)].find((node) => !isCodeEditor(node));
      if (field) return field;
    }
    return null;
  }

  function getComposer() {
    const field = composerField();
    return field?.closest("form") || field?.closest('[role="group"]') || field?.parentElement || null;
  }

  function emitInput(element, data) {
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data }));
    } catch {}
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function insertText(text) {
    const value = String(text || "");
    if (!value) return { ok: false, code: "EMPTY_TEXT" };
    const field = composerField();
    if (!field) return { ok: false, code: "NO_COMPOSER" };
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      const insertion = field.value ? "\n\n" + value : value;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
      setter?.call(field, field.value + insertion);
      if (!setter) field.value += insertion;
      emitInput(field, insertion);
      field.focus();
      return { ok: true };
    }
    field.focus();
    const selection = window.getSelection();
    if (!selection || !field.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    const insertion = field.innerText?.trim() ? "\n\n" + value : value;
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, insertion); } catch {}
    if (!inserted) {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return { ok: false, code: "NO_COMPOSER" };
      range.deleteContents();
      range.insertNode(document.createTextNode(insertion));
      range.collapse(false);
    }
    emitInput(field, insertion);
    return { ok: true };
  }

  function findComposerFileInput() {
    const root = findAssistantRoot();
    if (!root) return null;
    if (assistantUploadInput?.isConnected) return assistantUploadInput;
    const composer = getComposer();
    const form = composer?.closest("form");
    const inputs = [...root.querySelectorAll('input[type="file"]')]
      .filter((input) => !isCodeEditor(input) && (!composer || composer.contains(input) || form?.contains(input)));
    const visible = inputs.filter((input) => input.offsetParent !== null || input.getClientRects().length > 0);
    const candidates = visible.length ? visible : inputs;
    return candidates.find((input) => /image/i.test(input.accept || "")) || candidates[0] || null;
  }

  function pageFileInputs() {
    return [...document.querySelectorAll('input[type="file"]')];
  }

  function assistantPortalFileInput() {
    return pageFileInputs().find((input) => input.parentElement === document.body && input.multiple && !isCodeEditor(input)) || null;
  }

  function assistantUploadTrigger(root) {
    for (const selector of SELECTORS.uploadTrigger) {
      const trigger = [...root.querySelectorAll(selector)].find((node) => !isCodeEditor(node));
      if (trigger) return trigger;
    }
    return null;
  }

  function uploadMenuItem() {
    return [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => /上传文件和照片|upload files and photos/i.test(String(node.textContent || "")));
  }

  function activateUploadTrigger(trigger) {
    try {
      if (typeof PointerEvent === "function") {
        trigger.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true
        }));
        trigger.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true
        }));
      }
      trigger.click();
    } catch {
      try { trigger.click(); } catch {}
    }
  }

  function clickUploadMenuItem(item) {
    if (typeof document.addEventListener !== "function") return item.click();
    const suppressChooser = (event) => {
      if (!event.target?.matches?.('input[type="file"]')) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", suppressChooser, true);
    try { return item.click(); } finally { document.removeEventListener("click", suppressChooser, true); }
  }

  function waitForAssistantUploadInput(previous) {
    return new Promise((resolve) => {
      let menuClicked = false;
      let finished = false;
      const finish = (input) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(input || null);
      };
      const scan = () => {
        const added = pageFileInputs().find((input) => !previous.has(input));
        if (added) return finish(added);
        if (!menuClicked) {
          const item = uploadMenuItem();
          if (item) {
            menuClicked = true;
            clickUploadMenuItem(item);
            const reused = assistantPortalFileInput();
            if (reused) return finish(reused);
          }
        }
      };
      const observer = new MutationObserver(scan);
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(pageFileInputs().find((input) => !previous.has(input)) || assistantPortalFileInput()), 1200);
      scan();
    });
  }

  async function openAssistantUpload() {
    const root = findAssistantRoot();
    const trigger = root && assistantUploadTrigger(root);
    if (!trigger) return null;
    const previous = new Set(pageFileInputs());
    const openMenu = uploadMenuItem();
    if (openMenu) {
      const existing = assistantPortalFileInput();
      if (existing) {
        assistantUploadInput = existing;
        return existing;
      }
    }
    activateUploadTrigger(trigger);
    const input = await waitForAssistantUploadInput(previous);
    assistantUploadInput = input;
    return input;
  }

  function attachmentDetected(root, file) {
    const scope = root || findAssistantRoot();
    if (!scope) return false;
    if (scope.querySelector('[data-testid*="attachment" i], [data-testid*="file" i], [aria-label*="Remove" i], [aria-label*="删除" i], img[src^="blob:"], img[src^="data:"]')) return true;
    return String(scope.textContent || "").includes(file.name);
  }

  function waitForAttachment(root, file, timeoutMs = 2600) {
    if (attachmentDetected(root, file)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        if (attachmentDetected(root, file)) finish(true);
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(attachmentDetected(root, file)), timeoutMs);
    });
  }

  function fileFromPayload({ name, mime, content, base64 } = {}) {
    const hasContent = content != null;
    if (!String(name || "").trim() || (!hasContent && !base64)) return null;
    let bytes = hasContent ? String(content) : null;
    if (!hasContent) {
      try {
        const binary = atob(String(base64).replace(/^data:[^;]+;base64,/, ""));
        bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      } catch {
        return null;
      }
    }
    return new File([bytes], String(name), { type: String(mime || "application/octet-stream") });
  }

  async function attachFile(payload) {
    // Prism renders the Assistant upload input in a body portal. Only use the
    // direct body input reached through the Assistant upload control.
    const input = findComposerFileInput() || await openAssistantUpload();
    if (!input) return { ok: false, code: "NO_ASSISTANT_UPLOAD_INPUT" };
    const file = fileFromPayload(payload);
    if (!file) return { ok: false, code: "INVALID_FILE" };
    const root = findAssistantRoot();
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      return { ok: false, code: "UPLOAD_INPUT_REJECTED" };
    }
    return (await waitForAttachment(root, file))
      ? { ok: true }
      : { ok: false, code: "ATTACHMENT_NOT_DETECTED" };
  }

  async function attachImage({ name, mime, base64 } = {}) {
    if (!/^image\//i.test(String(mime || "")) || !base64) return { ok: false, code: "INVALID_IMAGE" };
    return attachFile({ name: name || "image", mime, base64 });
  }

  globalThis.SolCodexPrismSite = {
    id: "prism",
    matches(url = location.href) {
      try { return new URL(url).hostname.toLowerCase() === "prism.openai.com"; } catch { return false; }
    },
    getAssistantNodes: assistantNodes,
    latestAssistantNode,
    getAssistantText: assistantText,
    getConversationId() {
      const projectId = new URL(location.href).searchParams.get("u");
      return `prism:${projectId || location.pathname}`;
    },
    getMessageId(node, index) {
      if (!node) return `assistant-${index}`;
      for (const selector of ["data-message-id", "data-id", "data-testid"]) {
        const value = node.getAttribute?.(selector);
        if (value) return value;
      }
      const ancestor = node.closest?.("[data-message-id], [data-id], [data-testid*='message' i]");
      return ancestor?.getAttribute("data-message-id") || ancestor?.getAttribute("data-id") || ancestor?.getAttribute("data-testid") || `assistant-${index}`;
    },
    getTitle() {
      const raw = normalizeText(document.title);
      return raw.replace(/\s*[-–—]\s*Prism\s*$/i, "") || "Prism";
    },
    isStreaming() {
      const root = findAssistantRoot();
      return Boolean(root?.querySelector(SELECTORS.stop.join(",")));
    },
    getComposer,
    findComposerFileInput,
    getObserverRoot: findAssistantRoot,
    getInlineButtonHost(node) {
      const root = findAssistantRoot();
      if (!root || !node || !root.contains(node)) return null;
      const host = node.closest?.("[data-message-id], [data-id], [data-testid*='message' i]") || node;
      return isCodeEditor(host) ? node : host;
    },
    insertText,
    attachFile,
    attachImage
  };
})();
