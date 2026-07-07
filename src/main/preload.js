const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freesia', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),

  // Text injection
  injectText: (text) => ipcRenderer.invoke('inject-text', text),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  // Window controls
  minimize: () => ipcRenderer.invoke('minimize-window'),
  close: () => ipcRenderer.invoke('close-window'),

  // Overlay
  overlayDone: () => ipcRenderer.invoke('overlay-done'),
  overlayError: () => ipcRenderer.invoke('overlay-error'),
  overlayHide: () => ipcRenderer.invoke('overlay-hide'),
  overlayTimer: (timeStr) => ipcRenderer.invoke('overlay-timer', timeStr),

  // Recording state sync
  recordingFailed: () => ipcRenderer.invoke('recording-failed'),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Shortcuts
  registerShortcuts: () => ipcRenderer.invoke('register-shortcuts'),

  // Theme
  getThemeInfo: () => ipcRenderer.invoke('get-theme-info'),
  setAppTheme: (themeSource) => ipcRenderer.invoke('set-app-theme', themeSource),

  // App updates
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Auto-launch
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

  // Error log
  saveAndOpenLog: (logContent) => ipcRenderer.invoke('save-and-open-log', logContent),
  logToFile: (level, context, message, stack) => ipcRenderer.invoke('log-to-file', level, context, message, stack),

  // Failed recordings
  saveFailedAudio: (base64Data, metadata) => ipcRenderer.invoke('save-failed-audio', base64Data, metadata),
  getFailedRecordings: () => ipcRenderer.invoke('get-failed-recordings'),
  getFailedRecordingData: (filename) => ipcRenderer.invoke('get-failed-recording-data', filename),
  deleteFailedRecording: (baseName) => ipcRenderer.invoke('delete-failed-recording', baseName),

  // Foreground app detection
  getForegroundApp: () => ipcRenderer.invoke('get-foreground-app'),

  // Events from main process
  onDictationStart: (callback) => ipcRenderer.on('dictation-start', callback),
  onDictationStop: (callback) => ipcRenderer.on('dictation-stop', (_, mode) => callback(mode)),
  onDictationCancel: (callback) => ipcRenderer.on('dictation-cancel', callback),
  onCommandStart: (callback) => ipcRenderer.on('command-start', callback),
  onOverlayState: (callback) => ipcRenderer.on('overlay-state', (_, state) => callback(state)),
  onOverlayTimer: (callback) => ipcRenderer.on('overlay-timer', (_, timeStr) => callback(timeStr)),
  onUpdateStatus: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
  onThemeUpdated: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('theme-updated', handler);
    return () => ipcRenderer.removeListener('theme-updated', handler);
  },
});
