(function () {
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) {
      const error = new Error(result?.error || "Project Files request failed");
      error.status = result?.status;
      error.code = result?.code;
      throw error;
    }
    return result.data;
  }

  async function getSelectedProject() {
    const result = await chrome.runtime.sendMessage({ type: "SOL_CODEX_GET_SELECTED_PROJECT" });
    if (!result?.ok) {
      const error = new Error(result?.error || "Unable to get the selected project");
      error.status = result?.status;
      error.code = result?.code;
      throw error;
    }
    return result.project || { ready: false, path: "", name: "", project: null };
  }

  globalThis.SolCodexProjectFilesClient = {
    getSelectedProject,
    listDirectory: (projectPath, relativePath = "") => send({
      type: "SOL_CODEX_LIST_PROJECT_FILES",
      projectPath,
      path: relativePath
    }),
    readFile: (projectPath, relativePath) => send({
      type: "SOL_CODEX_READ_PROJECT_FILE",
      projectPath,
      path: relativePath
    }),
    readFileData: (projectPath, relativePath) => send({
      type: "SOL_CODEX_READ_PROJECT_FILE_DATA",
      projectPath,
      path: relativePath
    })
  };
})();
