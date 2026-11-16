// Same public API as Electron's preload. Rust owns secrets and OS services.
(function () {
  if (!window.__TAURI__) return;
  const tauri = window.__TAURI__;
  const pendingListeners = [];
  function encode(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 32768)
      text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  }
  function pack(value) {
    if (value instanceof ArrayBuffer) return encode(new Uint8Array(value));
    if (ArrayBuffer.isView(value))
      return encode(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
    if (Array.isArray(value)) return value.map(pack);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, pack(v)]),
      );
    return value === undefined ? null : value;
  }
  async function invoke(channel, ...args) {
    const value = await tauri.core.invoke("ipc", {
      channel,
      args: args.map(pack),
    });
    if (channel === "get-failed-recording-data" && typeof value === "string") {
      const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      return bytes.buffer;
    }
    return value;
  }
  function send(channel, ...args) {
    invoke(channel, ...args).catch((e) => console.error(channel, e));
  }
  const on =
    (channel, map = (...a) => a[1]) =>
    (callback) => {
      let disposed = false,
        unlisten;
      const ready = tauri.event
        .listen(channel, (event) => {
          if (!disposed) callback(map(null, event.payload));
        })
        .then((fn) => {
          unlisten = fn;
          if (disposed) fn();
        });
      pendingListeners.push(ready);
      return () => {
        disposed = true;
        unlisten?.();
      };
    };
  window.freesia = {
    // Settings (secrets never cross this bridge)
    getSettings: () => invoke("get-settings"),
    setSetting: (key, value) => invoke("set-setting", key, value),
    getSetting: (key) => invoke("get-setting", key),

    // Text output
    injectText: (text) => invoke("inject-text", text),
    copyText: (text) => invoke("copy-text", text),

    // Window
    minimize: () => invoke("minimize-window"),
    toggleMaximize: () => invoke("toggle-maximize-window"),
    close: () => invoke("close-window"),

    // Overlay pill
    overlayDone: (info) => invoke("overlay-done", info),
    overlayError: (message) => invoke("overlay-error", message),
    overlayProgress: (info) => invoke("overlay-progress", info),
    overlayHide: () => invoke("overlay-hide"),
    overlayKept: () => invoke("overlay-kept"),
    overlayTimer: (timeStr) => invoke("overlay-timer", timeStr),
    overlayAudioLevel: (level) => send("overlay-audio-level", level),

    // Recording state sync with the shortcut state machine
    recordingFailed: (message) => invoke("recording-failed", message),
    recordingState: (state) => send("recording-state", state),
    recordingLive: () => send("recording-live"),

    openExternal: (url) => invoke("open-external", url),

    // Shortcuts
    registerShortcuts: () => invoke("register-shortcuts"),
    setShortcut: (key, value) => invoke("set-shortcut", key, value),
    suspendShortcuts: () => invoke("suspend-shortcuts"),

    // Theme
    getThemeInfo: () => invoke("get-theme-info"),
    setAppTheme: (themeSource) => invoke("set-app-theme", themeSource),

    // Updates
    getAppVersion: () => invoke("get-app-version"),
    getUpdateStatus: () => invoke("get-update-status"),
    checkForUpdates: () => invoke("check-for-updates"),
    downloadUpdate: () => invoke("download-update"),
    installUpdate: () => invoke("install-update"),

    setAutoLaunch: (enabled) => invoke("set-auto-launch", enabled),

    // Logs
    openLog: () => invoke("open-log"),
    logToFile: (level, context, message, stack) =>
      invoke("log-to-file", level, context, message, stack),

    // Engines
    engineStatus: () => invoke("engine:status"),
    setEngine: (key, value) => invoke("engine:set", key, value),
    transcribe: (payload) => invoke("engine:transcribe", payload),
    format: (payload) => invoke("engine:format", payload),
    cloudLogin: (server, username, password) =>
      invoke("cloud:login", server, username, password),
    cloudLogout: () => invoke("cloud:logout"),
    cloudHealth: () => invoke("cloud:health"),
    cloudContribution: () => invoke("cloud:contrib-get"),
    cloudSetContribution: (enabled, version) =>
      invoke("cloud:contrib-set", enabled, version),
    cloudDeleteContributions: () => invoke("cloud:contrib-delete"),
    cloudOpenAccount: () => invoke("cloud:open-account"),
    geminiSetKey: (key) => invoke("gemini:set-key", key),
    geminiRefreshModels: () => invoke("gemini:refresh-models"),
    localInstall: (modelId) => invoke("local:install", modelId),
    localCancel: () => invoke("local:cancel"),
    localRemove: (modelId) => invoke("local:remove", modelId),
    localStart: () => invoke("local:start"),
    localStop: () => invoke("local:stop"),
    localSelect: (modelId) => invoke("local:select", modelId),
    localOpenFolder: () => invoke("local:open-folder"),
    onLocalStatus: on("local-status"),
    onEngineRetry: on("engine-retry"),

    // Saved recordings
    saveFailedAudio: (audio, metadata, existingBase) =>
      invoke("save-failed-audio", audio, metadata, existingBase),
    getFailedRecordings: () => invoke("get-failed-recordings"),
    getFailedRecordingData: (baseName) =>
      invoke("get-failed-recording-data", baseName),
    deleteFailedRecording: (baseName) =>
      invoke("delete-failed-recording", baseName),
    showRecordingInFolder: (baseName) =>
      invoke("show-recording-in-folder", baseName),
    openRecordingsFolder: () => invoke("open-recordings-folder"),

    // Custom styles
    getStylesDir: () => invoke("get-styles-dir"),
    openStylesFolder: () => invoke("open-styles-folder"),
    importStylesFromDisk: () => invoke("import-styles-from-disk"),
    importStyleFile: () => invoke("import-style-file"),

    sendErrorReport: (report) => invoke("send-error-report", report),
    getForegroundApp: () => invoke("get-foreground-app"),
    scanApps: (force, wanted) => invoke("apps:scan", force, wanted),
    runningApps: () => invoke("apps:running"),

    // Events from the main process
    onDictationStart: on("dictation-start", () => undefined),
    onDictationStop: on("dictation-stop"),
    onDictationCancel: on("dictation-cancel", () => undefined),
    onCommandStart: on("command-start"),
    onOverlayState: on("overlay-state"),
    onOverlayTimer: on("overlay-timer"),
    onOverlayAudioLevel: on("overlay-audio-level"),
    onUpdateStatus: on("update-status"),
    onThemeUpdated: on("theme-updated"),
    onWindowState: on("window-state"),
  };
  on("native-visibility")((visible) => {
    window.__freesiaVisible = visible;
    document.documentElement.toggleAttribute("data-native-hidden", !visible);
    window.dispatchEvent(new Event("freesia-visibility"));
  });
  document.addEventListener("DOMContentLoaded", async () => {
    const style = document.createElement("style");
    style.textContent =
      "[data-native-hidden] *,[data-native-hidden] *::before,[data-native-hidden] *::after {animation-play-state:paused!important}";
    document.head.append(style);
    const titlebar = document.querySelector(".titlebar");
    titlebar?.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button,a,input,select,textarea"))
        return;
      if (e.detail === 2) window.freesia.toggleMaximize();
      else tauri.window.getCurrentWindow().startDragging().catch(console.error);
    });
    await Promise.all(pendingListeners);
    await invoke("native:ready");
  });
})();
