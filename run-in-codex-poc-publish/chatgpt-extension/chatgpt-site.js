(function () {
  function composerField() {
    return document.querySelector("#prompt-textarea")
      || document.querySelector('[data-testid="composer"] textarea')
      || document.querySelector('[data-testid="composer"] [contenteditable="true"]')
      || document.querySelector('textarea[placeholder*="Message" i], textarea[placeholder*="消息"]')
      || document.querySelector('[contenteditable="true"]');
  }

  function getComposer() {
    const field = composerField();
    return field?.closest("form") || field?.closest('[data-testid="composer"]') || field?.parentElement || null;
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
    const root = getComposer();
    const form = root?.closest("form") || (root?.tagName === "FORM" ? root : null);
    if (!root && !form) return null;
    const scoped = [...document.querySelectorAll('input[type="file"]')]
      .filter((input) => (root?.contains(input) || form?.contains(input)) && !input.closest("article,[data-message-id],[data-testid*='history' i]"));
    const visible = scoped.filter((input) => input.offsetParent !== null || input.getClientRects().length > 0);
    const candidates = visible.length ? visible : scoped;
    return candidates.find((input) => /image/i.test(input.accept || "")) || candidates[0] || null;
  }

  function attachmentDetected(root, file) {
    const scope = root || document;
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
      observer.observe(root || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(attachmentDetected(root, file)), timeoutMs);
    });
  }

  function fileFromPayload({ name, mime, content } = {}) {
    if (!String(name || "").trim() || content == null) return null;
    return new File([String(content)], String(name), { type: String(mime || "application/octet-stream") });
  }

  async function attachFile(payload) {
    const input = findComposerFileInput();
    if (!input) return { ok: false, code: "NO_UPLOAD_INPUT" };
    const file = fileFromPayload(payload);
    if (!file) return { ok: false, code: "INVALID_FILE" };
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      return { ok: false, code: "UPLOAD_INPUT_REJECTED" };
    }
    return (await waitForAttachment(getComposer(), file))
      ? { ok: true }
      : { ok: false, code: "ATTACHMENT_NOT_DETECTED" };
  }

  globalThis.SolCodexChatGPTSite = Object.freeze({ insertText, attachFile });
})();
