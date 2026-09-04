(function () {
  const i18n = globalThis.SolCodexI18n;
  const t = (...args) => i18n.t(...args);

  function createProjectFilesController({ state, client, button, render, insertText, attachImage }) {
    function fileSize(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value)) return "";
      if (value < 1024) return `${i18n.formatNumber(value)} B`;
      const units = ["KB", "MB", "GB"];
      let amount = value / 1024;
      let unit = units[0];
      for (let index = 1; amount >= 1024 && index < units.length; index += 1) {
        amount /= 1024;
        unit = units[index];
      }
      const formatted = new Intl.NumberFormat(i18n.getLocale() === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 }).format(amount);
      return `${formatted} ${unit}`;
    }

    function fileErrorText(error, fallbackKey) {
      switch (error?.code) {
        case "PROJECT_NOT_FOUND":
        case "PROJECT_NOT_RECOGNIZED":
        case "PROJECT_PATH_INVALID":
        case "PROJECT_NOT_DIRECTORY":
          return t("files.projectMissing");
        case "PATH_NOT_FOUND":
        case "DIRECTORY_NOT_FOUND":
        case "FILE_NOT_FOUND":
          return t("files.notFound");
        case "PROJECT_PERMISSION_REQUIRED":
        case "FILE_READ_DENIED":
        case "DIRECTORY_READ_DENIED":
          return t("files.permissionDenied");
        case "PATH_TRAVERSAL_BLOCKED":
          return t("files.blockedLink");
        case "API_UNSUPPORTED":
          return t("files.apiUnsupported");
        case "BINARY_FILE":
          return t("files.binary");
        case "FILE_TOO_LARGE":
          return t("files.tooLarge");
        case "IGNORED_DIRECTORY":
          return t("files.directoryError");
        default:
          if (error?.status === 401) return t("files.pairing");
          if (error?.status === 404) return t("files.apiUnsupported");
          if (!error?.status) return t("files.bridgeDisconnected");
          return error?.message || t(fallbackKey);
      }
    }

    function makeFileChevron(expanded = false) {
      const chevron = document.createElement("span");
      chevron.className = `sol-codex-file-chevron${expanded ? " expanded" : ""}`;
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "›";
      return chevron;
    }

    function makeFileIcon(type) {
      const icon = document.createElement("span");
      icon.className = `sol-codex-file-icon ${type === "directory" ? "folder" : "file"}`;
      icon.setAttribute("aria-hidden", "true");
      return icon;
    }

    function makeFileRow(entry, depth) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `sol-codex-file-row${state.fileSelectedPath === entry.path ? " selected" : ""}`;
      row.style.paddingInlineStart = `${8 + depth * 15}px`;
      row.title = entry.path;
      const isFolder = entry.type === "directory";
      row.appendChild(isFolder ? makeFileChevron(state.fileExpanded.has(entry.path)) : document.createElement("span"));
      row.lastChild.classList.add("sol-codex-file-chevron-spacer");
      row.appendChild(makeFileIcon(entry.type));
      const name = document.createElement("span");
      name.className = "sol-codex-file-name";
      name.textContent = entry.name;
      row.appendChild(name);
      if (entry.sensitive || entry.blocked) {
        const meta = document.createElement("span");
        meta.className = "sol-codex-file-meta";
        meta.textContent = t(entry.sensitive ? "files.sensitiveLabel" : "files.blockedLinkLabel");
        row.appendChild(meta);
      }
      row.disabled = Boolean(entry.blocked);
      row.addEventListener("click", () => isFolder ? toggleDirectory(entry) : loadFile(entry));
      return row;
    }

    function appendFileEntries(parent, entries, depth) {
      for (const entry of entries) {
        parent.appendChild(makeFileRow(entry, depth));
        if (entry.type !== "directory" || !state.fileExpanded.has(entry.path)) continue;
        if (state.fileLoading.has(entry.path)) {
          const loading = document.createElement("div");
          loading.className = "sol-codex-file-tree-note";
          loading.style.paddingInlineStart = `${23 + (depth + 1) * 15}px`;
          loading.textContent = t("files.loading");
          parent.appendChild(loading);
        } else if (state.fileErrors.has(entry.path)) {
          const error = document.createElement("div");
          error.className = "sol-codex-file-tree-error";
          error.style.paddingInlineStart = `${23 + (depth + 1) * 15}px`;
          error.textContent = state.fileErrors.get(entry.path);
          parent.appendChild(error);
          const retry = button(t("files.retry"), "sol-codex-files-retry", () => loadDirectory(entry.path, true));
          retry.style.marginInlineStart = `${23 + (depth + 1) * 15}px`;
          parent.appendChild(retry);
        } else if (state.fileCache.has(entry.path)) {
          appendFileEntries(parent, state.fileCache.get(entry.path), depth + 1);
        }
      }
    }

    function renderFileTree() {
      const tree = document.createElement("div");
      tree.className = "sol-codex-file-tree";
      tree.setAttribute("aria-label", t("files.title"));
      const root = document.createElement("div");
      root.className = "sol-codex-file-root";
      root.append(makeFileIcon("directory"));
      const rootName = document.createElement("strong");
      rootName.className = "sol-codex-file-name";
      rootName.textContent = state.target.projectName || state.target.projectPath.split(/[\\/]/).filter(Boolean).at(-1) || state.target.projectPath;
      root.title = state.target.projectPath;
      root.appendChild(rootName);
      tree.appendChild(root);
      if (state.fileLoading.has("")) {
        const loading = document.createElement("div");
        loading.className = "sol-codex-file-tree-note";
        loading.textContent = t("files.loading");
        tree.appendChild(loading);
      } else if (state.fileErrors.has("")) {
        const error = document.createElement("div");
        error.className = "sol-codex-file-tree-error";
        error.textContent = state.fileErrors.get("");
        tree.appendChild(error);
        tree.appendChild(button(t("files.retry"), "sol-codex-files-retry", () => loadDirectory("", true)));
      } else if (state.fileCache.has("")) {
        const entries = state.fileCache.get("");
        if (!entries.length) {
          const empty = document.createElement("div");
          empty.className = "sol-codex-file-tree-note";
          empty.textContent = t("files.empty");
          tree.appendChild(empty);
        } else appendFileEntries(tree, entries, 0);
      }
      return tree;
    }

function fileActionError(code, image) {
  if (code === "NO_COMPOSER") return t("error.noComposer");
  if (code === "NO_UPLOAD_INPUT") return t("files.noUploadInput");
  if (code === "ATTACHMENT_NOT_DETECTED" || code === "UPLOAD_INPUT_REJECTED") return t("files.attachmentNotDetected");
  if (code === "INVALID_IMAGE") return t("files.imageUnsupported");
  return image ? t("files.attachFailed") : t("files.insertFailed");
}

async function insertSelectedFile() {
  const selected = state.filePreview;
  if (!selected || state.fileAction === "inserting") return;
  const image = selected.kind === "image";
  if (selected.blocked || selected.tooLarge || selected.binary || (image && !state.fileImageData?.base64) || (!image && selected.content == null)) return;
  state.fileAction = "inserting";
  state.fileActionError = "";
  render();
  try {
    const result = image
      ? await attachImage({ name: selected.name, mime: selected.mime, base64: state.fileImageData.base64 })
      : await insertText("Project file:\n" + selected.path + "\n\n" + selected.content);
    if (!result?.ok) {
      state.fileAction = "idle";
      state.fileActionError = fileActionError(result?.code, image);
    } else {
      state.fileAction = "success";
    }
  } catch (error) {
    state.fileAction = "idle";
    state.fileActionError = fileActionError(error?.code, image);
  }
  render();
}

function renderFilePreview() {
  const preview = document.createElement("div");
  preview.className = "sol-codex-file-preview";
  const selected = state.filePreview || state.fileSelected;
  const header = document.createElement("div");
  header.className = "sol-codex-file-preview-header";
  const heading = document.createElement("div");
  heading.className = "sol-codex-file-preview-heading";
  const name = document.createElement("strong");
  name.textContent = selected?.name || t("files.title");
  const pathText = document.createElement("span");
  pathText.textContent = selected?.path || t("files.noPreview");
  heading.append(name, pathText);
  header.appendChild(heading);
  if (state.fileMobileView === "preview") {
    const back = button(t("files.back"), "sol-codex-files-back", () => {
      state.fileMobileView = "tree";
      render();
    });
    header.prepend(back);
  }
  const isText = selected?.kind === "text" || (!selected?.kind && selected?.content != null);
  if (isText && state.filePreview?.content != null && !state.filePreviewLoading) {
    const copy = button(state.fileCopied ? t("files.copied") : t("files.copy"), "sol-codex-files-copy", () => copyFileContent());
    copy.disabled = state.fileCopied;
    header.appendChild(copy);
  }
  preview.appendChild(header);
  const body = document.createElement("div");
  body.className = "sol-codex-file-preview-body";
  if (!selected) {
    const empty = document.createElement("div");
    empty.className = "sol-codex-file-preview-empty";
    empty.textContent = t("files.noPreview");
    body.appendChild(empty);
  } else {
    const size = document.createElement("div");
    size.className = "sol-codex-file-preview-size";
    size.textContent = fileSize(selected.size);
    body.appendChild(size);
    if (state.filePreviewLoading) {
      const loading = document.createElement("div");
      loading.className = "sol-codex-file-preview-empty";
      loading.textContent = t("files.loading");
      body.appendChild(loading);
    } else if (state.filePreviewError) {
      const error = document.createElement("div");
      error.className = "sol-codex-context-error";
      error.textContent = state.filePreviewError;
      body.appendChild(error);
    } else if (selected.blocked) {
      const blocked = document.createElement("div");
      blocked.className = "sol-codex-file-preview-empty";
      blocked.textContent = t("files.sensitive");
      body.appendChild(blocked);
    } else if (selected.kind === "image") {
      if (selected.tooLarge) {
        const large = document.createElement("div");
        large.className = "sol-codex-file-preview-empty";
        large.textContent = t("files.imageTooLarge", { max: fileSize(selected.maxBytes) });
        body.appendChild(large);
      } else if (state.fileImageLoading) {
        const loading = document.createElement("div");
        loading.className = "sol-codex-file-preview-empty";
        loading.textContent = t("files.imageLoading");
        body.appendChild(loading);
      } else if (state.fileImageData?.base64) {
        const image = document.createElement("img");
        image.className = "sol-codex-file-preview-image";
        image.alt = selected.name || t("files.title");
        image.src = "data:" + selected.mime + ";base64," + state.fileImageData.base64;
        body.appendChild(image);
      } else {
        const unsupported = document.createElement("div");
        unsupported.className = "sol-codex-file-preview-empty";
        unsupported.textContent = t("files.imageUnsupported");
        body.appendChild(unsupported);
      }
    } else if (selected.unsupportedImage) {
      const unsupported = document.createElement("div");
      unsupported.className = "sol-codex-file-preview-empty";
      unsupported.textContent = t("files.imageUnsupported");
      body.appendChild(unsupported);
    } else if (selected.kind === "binary" || selected.binary) {
      const binary = document.createElement("div");
      binary.className = "sol-codex-file-preview-empty";
      binary.textContent = t("files.binaryUnsupported");
      body.appendChild(binary);
    } else if (selected.content === "") {
      const empty = document.createElement("div");
      empty.className = "sol-codex-file-preview-empty";
      empty.textContent = t("files.emptyFile");
      body.appendChild(empty);
    } else if (selected.content != null) {
      const code = document.createElement("pre");
      code.className = "sol-codex-file-preview-content";
      const content = document.createElement("code");
      content.textContent = selected.content;
      code.appendChild(content);
      body.appendChild(code);
    }
  }
  preview.appendChild(body);
  if (state.fileActionError) {
    const actionError = document.createElement("div");
    actionError.className = "sol-codex-context-error";
    actionError.textContent = state.fileActionError;
    preview.appendChild(actionError);
  }
  const canImage = selected?.kind === "image" && !selected.blocked && !selected.tooLarge && state.fileImageData?.base64;
  const canText = isText && selected?.content != null;
  if (canImage || canText) {
    const footer = document.createElement("div");
    footer.className = "sol-codex-file-preview-footer";
    const action = button(
      state.fileAction === "inserting" ? t("files.inserting") : state.fileAction === "success" ? t("files.inserted") : canImage ? t("files.insertImage") : t("files.insertText"),
      "sol-codex-context-primary",
      insertSelectedFile
    );
    action.disabled = state.fileAction === "inserting" || state.fileAction === "success";
    footer.appendChild(action);
    preview.appendChild(footer);
  }
  return preview;
}

    function renderProjectFiles() {
      const panel = document.createElement("div");
      panel.className = `sol-codex-files-panel mobile-${state.fileMobileView}`;
      const toolbar = document.createElement("div");
      toolbar.className = "sol-codex-files-toolbar";
      const title = document.createElement("strong");
      title.textContent = t("files.title");
      const refresh = button("↻", "sol-codex-files-refresh", refreshProjectFiles);
      refresh.title = t("files.refresh");
      refresh.setAttribute("aria-label", t("files.refresh"));
      toolbar.append(title, refresh);
      panel.appendChild(toolbar);
      const explorer = document.createElement("div");
      explorer.className = "sol-codex-files-explorer";
      explorer.append(renderFileTree(), renderFilePreview());
      panel.appendChild(explorer);
      return panel;
    }

    async function loadDirectory(relativePath = "", force = false) {
      if (!state.target?.projectPath || state.fileLoading.has(relativePath)) return;
      if (!force && state.fileCache.has(relativePath)) return;
      const requestId = {};
      state.fileDirectoryRequests.set(relativePath, requestId);
      state.fileLoading.add(relativePath);
      state.fileErrors.delete(relativePath);
      render();
      try {
        const data = await client.listDirectory(state.target.projectPath, relativePath);
        if (state.fileDirectoryRequests.get(relativePath) !== requestId) return;
        state.fileCache.set(relativePath, Array.isArray(data?.entries) ? data.entries : []);
        state.fileExpanded.add(relativePath);
      } catch (error) {
        if (state.fileDirectoryRequests.get(relativePath) === requestId) state.fileErrors.set(relativePath, fileErrorText(error, "files.directoryError"));
      } finally {
        if (state.fileDirectoryRequests.get(relativePath) === requestId) {
          state.fileDirectoryRequests.delete(relativePath);
          state.fileLoading.delete(relativePath);
        }
        if (state.fileDirectoryRequests.get(relativePath) !== requestId) render();
      }
    }

    function toggleDirectory(entry) {
      if (state.fileExpanded.has(entry.path)) {
        state.fileExpanded.delete(entry.path);
        render();
      } else {
        state.fileExpanded.add(entry.path);
        render();
        loadDirectory(entry.path);
      }
    }

    async function loadFile(entry) {
      const requestId = ++state.filePreviewRequestId;
      state.fileSelected = entry;
      state.fileSelectedPath = entry.path;
      state.filePreview = null;
      state.fileImageData = null;
      state.fileImageLoading = false;
      state.fileAction = "idle";
      state.fileActionError = "";
      state.filePreviewError = "";
      state.filePreviewLoading = true;
      state.fileCopied = false;
      state.fileMobileView = "preview";
      render();
      try {
        const data = await client.readFile(state.target.projectPath, entry.path);
        if (requestId !== state.filePreviewRequestId) return;
        state.filePreview = data;
        state.filePreviewLoading = false;
        if (data?.kind === "image" && !data.blocked && !data.tooLarge) {
          state.fileImageLoading = true;
          render();
          try {
            const imageData = await client.readFileData(state.target.projectPath, entry.path);
            if (requestId !== state.filePreviewRequestId) return;
            state.fileImageData = imageData;
          } catch (error) {
            if (requestId === state.filePreviewRequestId) state.filePreviewError = fileErrorText(error, "files.fileError");
          } finally {
            if (requestId === state.filePreviewRequestId) state.fileImageLoading = false;
          }
        }
      } catch (error) {
        if (requestId === state.filePreviewRequestId) state.filePreviewError = fileErrorText(error, "files.fileError");
      } finally {
        if (requestId === state.filePreviewRequestId) {
          state.filePreviewLoading = false;
          state.fileImageLoading = false;
          render();
        }
      }
    }

    async function copyFileContent() {
      if (state.filePreview?.content == null) return;
      try {
        await navigator.clipboard.writeText(state.filePreview.content);
        state.fileCopied = true;
        render();
        setTimeout(() => {
          state.fileCopied = false;
          render();
        }, 1400);
      } catch {
        state.filePreviewError = t("files.copyFailed");
        render();
      }
    }

    function refreshProjectFiles() {
      state.fileCache.clear();
      state.fileExpanded.clear();
      state.fileLoading.clear();
      state.fileDirectoryRequests = new Map();
      state.fileErrors.clear();
      state.fileSelected = null;
      state.fileSelectedPath = "";
      state.filePreview = null;
      state.fileImageData = null;
      state.fileImageLoading = false;
      state.fileAction = "idle";
      state.fileActionError = "";
      state.filePreviewError = "";
      state.filePreviewLoading = false;
      state.filePreviewRequestId += 1;
      state.fileCopied = false;
      state.fileMobileView = "tree";
      render();
      loadDirectory();
    }

    return { render: renderProjectFiles, loadRoot: () => loadDirectory() };
  }

  globalThis.SolCodexProjectFiles = { create: createProjectFilesController };
})();
