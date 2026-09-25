const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, map = (...a) => a[1]) => (callback) => {
  const handler = (...args) => callback(map(...args));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('freesia', {
  // Settings (secrets never cross this bridge)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),

  // Text output
  injectText: (text) => ipcRenderer.invoke('inject-text', text),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  // Window
  minimize: () => ipcRenderer.invoke('minimize-window'),
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize-window'),
  close: () => ipcRenderer.invoke('close-window'),

  // Overlay pill
  overlayDone: (info) => ipcRenderer.invoke('overlay-done', info),
  overlayError: (message) => ipcRenderer.invoke('overlay-error', message),
  overlayProgress: (info) => ipcRenderer.invoke('overlay-progress', info),
  overlayHide: () => ipcRenderer.invoke('overlay-hide'),
  overlayTimer: (timeStr) => ipcRenderer.invoke('overlay-timer', timeStr),
  overlayAudioLevel: (level) => ipcRenderer.send('overlay-audio-level', level),

  // Recording state sync with the shortcut state machine
  recordingFailed: (message) => ipcRenderer.invoke('recording-failed', message),
  recordingState: (state) => ipcRenderer.send('recording-state', state),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Shortcuts
  registerShortcuts: () => ipcRenderer.invoke('register-shortcuts'),
  setShortcut: (key, value) => ipcRenderer.invoke('set-shortcut', key, value),
  suspendShortcuts: () => ipcRenderer.invoke('suspend-shortcuts'),

  // Theme
  getThemeInfo: () => ipcRenderer.invoke('get-theme-info'),
  setAppTheme: (themeSource) => ipcRenderer.invoke('set-app-theme', themeSource),

  // Updates
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

  // Logs
  openLog: () => ipcRenderer.invoke('open-log'),
  logToFile: (level, context, message, stack) => ipcRenderer.invoke('log-to-file', level, context, message, stack),

  // Engines
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  setEngine: (key, value) => ipcRenderer.invoke('engine:set', key, value),
  transcribe: (payload) => ipcRenderer.invoke('engine:transcribe', payload),
  format: (payload) => ipcRenderer.invoke('engine:format', payload),
  cloudLogin: (server, username, password) => ipcRenderer.invoke('cloud:login', server, username, password),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudHealth: () => ipcRenderer.invoke('cloud:health'),
  cloudOpenAccount: () => ipcRenderer.invoke('cloud:open-account'),
  geminiSetKey: (key) => ipcRenderer.invoke('gemini:set-key', key),
  geminiRefreshModels: () => ipcRenderer.invoke('gemini:refresh-models'),
  localInstall: (modelId) => ipcRenderer.invoke('local:install', modelId),
  localCancel: () => ipcRenderer.invoke('local:cancel'),
  localRemove: (modelId) => ipcRenderer.invoke('local:remove', modelId),
  localStart: () => ipcRenderer.invoke('local:start'),
  localStop: () => ipcRenderer.invoke('local:stop'),
  localSelect: (modelId) => ipcRenderer.invoke('local:select', modelId),
  localOpenFolder: () => ipcRenderer.invoke('local:open-folder'),
  onLocalStatus: on('local-status'),
  onEngineRetry: on('engine-retry'),

  // Saved recordings
  saveFailedAudio: (audio, metadata, existingBase) => ipcRenderer.invoke('save-failed-audio', audio, metadata, existingBase),
  getFailedRecordings: () => ipcRenderer.invoke('get-failed-recordings'),
  getFailedRecordingData: (baseName) => ipcRenderer.invoke('get-failed-recording-data', baseName),
  deleteFailedRecording: (baseName) => ipcRenderer.invoke('delete-failed-recording', baseName),
  showRecordingInFolder: (baseName) => ipcRenderer.invoke('show-recording-in-folder', baseName),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),

  // Custom styles
  getStylesDir: () => ipcRenderer.invoke('get-styles-dir'),
  openStylesFolder: () => ipcRenderer.invoke('open-styles-folder'),
  importStylesFromDisk: () => ipcRenderer.invoke('import-styles-from-disk'),
  importStyleFile: () => ipcRenderer.invoke('import-style-file'),

  sendErrorReport: (report) => ipcRenderer.invoke('send-error-report', report),
  getForegroundApp: () => ipcRenderer.invoke('get-foreground-app'),
  scanApps: (force, wanted) => ipcRenderer.invoke('apps:scan', force, wanted),
  runningApps: () => ipcRenderer.invoke('apps:running'),

  // Events from the main process
  onDictationStart: on('dictation-start', () => undefined),
  onDictationStop: on('dictation-stop'),
  onDictationCancel: on('dictation-cancel', () => undefined),
  onCommandStart: on('command-start'),
  onOverlayState: on('overlay-state'),
  onOverlayTimer: on('overlay-timer'),
  onOverlayAudioLevel: on('overlay-audio-level'),
  onUpdateStatus: on('update-status'),
  onThemeUpdated: on('theme-updated'),
  onWindowState: on('window-state')
});
