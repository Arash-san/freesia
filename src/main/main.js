const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, shell, nativeTheme, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// ============================================
// One-time migration from the old "Dictaloom" install
// Runs before the store is created so existing users keep
// their API key, snippets, dictionary, history, and stats.
// ============================================
function migrateFromDictaloom() {
  try {
    const newConfig = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(newConfig)) return;
    const oldDir = path.join(app.getPath('appData'), 'Dictaloom');
    const oldConfig = path.join(oldDir, 'config.json');
    if (!fs.existsSync(oldConfig)) return;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.copyFileSync(oldConfig, newConfig);
    // Bring saved recordings along too
    const oldRecordings = path.join(oldDir, 'failed-recordings');
    if (fs.existsSync(oldRecordings)) {
      const newRecordings = path.join(app.getPath('userData'), 'failed-recordings');
      fs.mkdirSync(newRecordings, { recursive: true });
      for (const f of fs.readdirSync(oldRecordings)) {
        fs.copyFileSync(path.join(oldRecordings, f), path.join(newRecordings, f));
      }
    }
  } catch (e) {
    console.error('Dictaloom migration failed:', e);
  }
}
migrateFromDictaloom();

// ============================================
// File-based Logger
// ============================================
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
let logFilePath = null;

function initLogger() {
  logFilePath = path.join(app.getPath('userData'), 'freesia.log');
}

function writeLog(level, context, message, stack) {
  if (!logFilePath) return;
  try {
    // Rotate if too large
    if (fs.existsSync(logFilePath)) {
      const stat = fs.statSync(logFilePath);
      if (stat.size > MAX_LOG_SIZE) {
        const oldPath = logFilePath + '.old';
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        fs.renameSync(logFilePath, oldPath);
      }
    }
    const ts = new Date().toISOString();
    let entry = `[${ts}] [${level}] [${context}] ${message}\n`;
    if (stack) entry += `  Stack: ${stack}\n`;
    fs.appendFileSync(logFilePath, entry, 'utf-8');
  } catch (e) {
    console.error('Logger write failed:', e);
  }
}

// Catch main process errors
process.on('uncaughtException', (err) => {
  writeLog('FATAL', 'main:uncaughtException', err.message, err.stack);
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  writeLog('ERROR', 'main:unhandledRejection', msg, stack);
  console.error('Unhandled Rejection:', reason);
});

// Single instance only. Multiple instances silently fight over the global
// shortcut: a stale instance can own Ctrl+Shift+Space while its overlay is
// dead, which is exactly "the popup stopped appearing".
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

const store = new Store({
  defaults: {
    apiKey: '',
    onboarded: false,
    dictationShortcut: 'Ctrl+Shift+Space',
    commandShortcut: 'Ctrl+Shift+Alt+Space',
    aiFormatting: true,
    geminiModel: '',
    language: 'en',
    theme: 'system',
    autoLaunch: false,
    showOverlay: true,
    sounds: true,
    dictionary: [],
    snippets: [],
    history: [],
    stats: null,
    overlayPosition: { x: -1, y: -1 },
    activeStyle: 'normal',
    autoStyleSwitch: false,
    styleOverrides: {},
    keepSuccessRecordings: false
  }
});

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isRecording = false;
let updateState = {
  status: 'idle',
  message: 'Update checks are ready.',
  version: app.getVersion(),
  isPackaged: app.isPackaged
};

function getThemeState() {
  return {
    source: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  };
}

function broadcastThemeState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme-updated', getThemeState());
  }
}

function applyAppTheme(themeSource) {
  const nextSource = ['system', 'light', 'dark'].includes(themeSource) ? themeSource : 'system';
  nativeTheme.themeSource = nextSource;
  store.set('theme', nextSource);
  broadcastThemeState();
  return getThemeState();
}

function sanitizeUpdateInfo(info) {
  if (!info) return null;
  return {
    version: info.version || '',
    releaseName: info.releaseName || '',
    releaseDate: info.releaseDate || '',
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
  };
}

function sendUpdateStatus(status, extra = {}) {
  updateState = {
    ...updateState,
    ...extra,
    status,
    version: app.getVersion(),
    isPackaged: app.isPackaged
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', updateState);
  }

  return updateState;
}

function serializeUpdateError(error) {
  return error instanceof Error ? error.message : String(error || 'Update check failed.');
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message) => writeLog('INFO', 'autoUpdater', String(message)),
    warn: (message) => writeLog('WARN', 'autoUpdater', String(message)),
    error: (message) => writeLog('ERROR', 'autoUpdater', String(message)),
    debug: (message) => writeLog('DEBUG', 'autoUpdater', String(message))
  };

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking', {
      message: 'Checking GitHub Releases for updates.',
      progress: null
    });
  });

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available', {
      message: `Version ${info.version} is available.`,
      updateInfo: sanitizeUpdateInfo(info),
      progress: null
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus('current', {
      message: 'Freesia is up to date.',
      updateInfo: sanitizeUpdateInfo(info),
      progress: null
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent || 0);
    sendUpdateStatus('downloading', {
      message: `Downloading update (${percent}%).`,
      progress: {
        percent,
        transferred: progress.transferred || 0,
        total: progress.total || 0,
        bytesPerSecond: progress.bytesPerSecond || 0
      }
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded', {
      message: `Version ${info.version} is ready to install.`,
      updateInfo: sanitizeUpdateInfo(info),
      progress: { percent: 100 }
    });
  });

  autoUpdater.on('error', (error) => {
    const message = serializeUpdateError(error);
    writeLog('ERROR', 'autoUpdater', message, error?.stack);
    sendUpdateStatus('error', {
      message,
      progress: null
    });
  });

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((error) => {
        const message = serializeUpdateError(error);
        writeLog('ERROR', 'autoUpdater:autoCheck', message, error?.stack);
        sendUpdateStatus('error', { message, progress: null });
      });
    }, 10000);
  } else {
    sendUpdateStatus('disabled', {
      message: 'Updates are enabled in installed builds.',
      progress: null
    });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    transparent: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14101c' : '#faf7f2',
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The hidden-to-tray window hosts the recorder. Never throttle it,
      // otherwise shortcuts appear dead after the app sits in the tray.
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // If the renderer that owns recording dies, reset state and reload it
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    writeLog('ERROR', 'mainWindow:render-process-gone', details.reason);
    isRecording = false;
    isProcessing = false;
    hideOverlay();
    try { mainWindow.webContents.reload(); } catch (e) { /* recreated on next activate */ }
  });
}

const OVERLAY_W = 300;
const OVERLAY_H = 74;

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  // Keep above fullscreen apps and never appear in screen shares oddly
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.webContents.on('render-process-gone', (_, details) => {
    writeLog('ERROR', 'overlay:render-process-gone', details.reason);
    try { overlayWindow.destroy(); } catch (e) { /* ignore */ }
    overlayWindow = null;
  });
}

// The overlay must always exist and always be on top when shown.
function ensureOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }
  return overlayWindow;
}

function positionOverlay() {
  // Follow the cursor's display so the pill is visible where the user works
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  const saved = store.get('overlayPosition');
  let x = Math.round(dx + (dw - OVERLAY_W) / 2);
  let y = dy + dh - OVERLAY_H - 48;
  if (saved && saved.x >= 0 && saved.y >= 0) {
    // Respect a saved position only if it is still on a connected display
    const onScreen = screen.getAllDisplays().some(d =>
      saved.x >= d.workArea.x && saved.x < d.workArea.x + d.workArea.width &&
      saved.y >= d.workArea.y && saved.y < d.workArea.y + d.workArea.height);
    if (onScreen) { x = saved.x; y = saved.y; }
  }
  overlayWindow.setBounds({ x, y, width: OVERLAY_W, height: OVERLAY_H });
}

function showOverlay(state) {
  if (!store.get('showOverlay')) return;
  const win = ensureOverlayWindow();
  positionOverlay();
  // Re-assert topmost every time: Windows silently demotes always-on-top
  // when other topmost windows churn, which made the pill stop appearing.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.showInactive();
  win.webContents.send('overlay-state', state);
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

function sendOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Freesia', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Start Dictation', click: () => startDictation() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Freesia - AI Voice Dictation');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow && mainWindow.show());
}

function registerShortcuts() {
  globalShortcut.unregisterAll();

  const dictShortcut = store.get('dictationShortcut') || 'Ctrl+Shift+Space';
  const cmdShortcut = store.get('commandShortcut') || 'Ctrl+Shift+Alt+Space';

  try {
    const electronDictShortcut = dictShortcut.replace('Ctrl', 'CommandOrControl');
    const ok = globalShortcut.register(electronDictShortcut, () => {
      handleShortcut('dictate');
    });
    if (!ok) writeLog('WARN', 'shortcuts', `Could not register ${dictShortcut} — another app may already own it`);
  } catch (e) {
    writeLog('ERROR', 'shortcuts', `Failed to register dictation shortcut: ${e.message}`, e.stack);
  }

  try {
    const electronCmdShortcut = cmdShortcut.replace('Ctrl', 'CommandOrControl');
    const ok = globalShortcut.register(electronCmdShortcut, () => {
      handleShortcut('command');
    });
    if (!ok) writeLog('WARN', 'shortcuts', `Could not register ${cmdShortcut} — another app may already own it`);
  } catch (e) {
    writeLog('ERROR', 'shortcuts', `Failed to register command shortcut: ${e.message}`, e.stack);
  }
}

// Debounce and state machine for shortcut handling
let lastShortcutTime = 0;
let isProcessing = false;
let processingSince = 0;
const SHORTCUT_COOLDOWN_MS = 350;
const PROCESSING_STUCK_MS = 45000;

function handleShortcut(mode) {
  const now = Date.now();
  // Ignore rapid-fire from key repeat
  if (now - lastShortcutTime < SHORTCUT_COOLDOWN_MS) return;
  lastShortcutTime = now;

  // Never let a stale processing flag eat shortcuts forever
  if (isProcessing && now - processingSince > PROCESSING_STUCK_MS) {
    writeLog('WARN', 'handleShortcut', 'Clearing stuck processing state');
    isProcessing = false;
    hideOverlay();
  }
  if (isProcessing) return;

  if (isRecording) {
    stopDictation(mode);
  } else {
    if (mode === 'command') {
      startCommandMode();
    } else {
      startDictation();
    }
  }
}

function startDictation() {
  isRecording = true;
  globalShortcut.register('Escape', cancelDictation);
  if (mainWindow) mainWindow.webContents.send('dictation-start');
  showOverlay('listening');
}

function stopDictation(mode = 'dictate') {
  if (!isRecording) return; // Guard against double-stop
  isRecording = false;
  isProcessing = true;
  processingSince = Date.now();
  globalShortcut.unregister('Escape');
  if (mainWindow) mainWindow.webContents.send('dictation-stop', mode);
  sendOverlay('overlay-state', 'processing');
  // Safety timeout: reset processing state if renderer never responds
  setTimeout(() => {
    if (isProcessing && Date.now() - processingSince >= PROCESSING_STUCK_MS - 1000) {
      isProcessing = false;
      hideOverlay();
    }
  }, PROCESSING_STUCK_MS);
}

function startCommandMode() {
  isRecording = true;
  globalShortcut.register('Escape', cancelDictation);
  if (mainWindow) mainWindow.webContents.send('command-start');
  showOverlay('listening');
}

function cancelDictation() {
  if (!isRecording) return;
  isRecording = false;
  isProcessing = false;
  globalShortcut.unregister('Escape');
  if (mainWindow) mainWindow.webContents.send('dictation-cancel');
  hideOverlay();
}

async function injectText(text) {
  const savedClipboard = clipboard.readText();
  clipboard.writeText(text);

  // Simulate Ctrl+V using PowerShell
  try {
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"',
        { windowsHide: true, timeout: 8000 },
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
    writeLog('INFO', 'inject', `Pasted ${text.length} chars into the foreground app`);
  } catch (e) {
    // Do NOT restore the old clipboard on failure: leave the transcript
    // there so the user can paste it manually with Ctrl+V.
    writeLog('ERROR', 'inject', `Paste failed, transcript left in clipboard: ${e.message}`, e.stack);
    return false;
  }

  // Restore clipboard after a short delay
  setTimeout(() => {
    clipboard.writeText(savedClipboard || '');
  }, 500);
  return true;
}

// IPC Handlers
ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('set-setting', (_, key, value) => {
  if (value === undefined || value === null) {
    store.delete(key);
  } else {
    store.set(key, value);
  }
  return true;
});
ipcMain.handle('get-setting', (_, key) => store.get(key));

ipcMain.handle('get-foreground-app', async () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    const psCmd = `(Get-Process | Where-Object { $_.MainWindowHandle -eq (Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();' -Name 'Win32' -Namespace Win32 -PassThru)::GetForegroundWindow() }).Name`;
    exec(`powershell -NoProfile -Command "${psCmd}"`, { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(''); return; }
      resolve((stdout || '').trim().toLowerCase());
    });
  });
});

ipcMain.handle('inject-text', async (_, text) => {
  return await injectText(text);
});

ipcMain.handle('copy-text', (_, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.handle('close-window', () => mainWindow && mainWindow.hide());

// Renderer failed to start recording (mic denied, device missing).
// Without this, main-process state stayed "recording" and the next
// shortcut press behaved like a stop — looking like a dead hotkey.
ipcMain.handle('recording-failed', () => {
  isRecording = false;
  isProcessing = false;
  globalShortcut.unregister('Escape');
  sendOverlay('overlay-state', 'error');
  setTimeout(() => hideOverlay(), 2000);
});

ipcMain.handle('overlay-done', () => {
  isProcessing = false;
  sendOverlay('overlay-state', 'done');
  setTimeout(() => hideOverlay(), 1500);
});

ipcMain.handle('overlay-error', () => {
  isProcessing = false;
  sendOverlay('overlay-state', 'error');
  setTimeout(() => hideOverlay(), 2000);
});

ipcMain.handle('overlay-hide', () => {
  isProcessing = false;
  hideOverlay();
});

ipcMain.handle('overlay-timer', (_, timeStr) => {
  sendOverlay('overlay-timer', timeStr);
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('register-shortcuts', () => registerShortcuts());

ipcMain.handle('get-theme-info', () => getThemeState());
ipcMain.handle('set-app-theme', (_, themeSource) => applyAppTheme(themeSource));

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-update-status', () => updateState);

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return sendUpdateStatus('disabled', {
      message: 'Install a packaged build to check GitHub Releases for updates.',
      progress: null
    });
  }

  try {
    await autoUpdater.checkForUpdates();
    return updateState;
  } catch (error) {
    const message = serializeUpdateError(error);
    writeLog('ERROR', 'autoUpdater:manualCheck', message, error?.stack);
    return sendUpdateStatus('error', { message, progress: null });
  }
});

ipcMain.handle('download-update', async () => {
  if (!app.isPackaged) {
    return sendUpdateStatus('disabled', {
      message: 'Updates are only downloaded by installed builds.',
      progress: null
    });
  }

  try {
    await autoUpdater.downloadUpdate();
    return updateState;
  } catch (error) {
    const message = serializeUpdateError(error);
    writeLog('ERROR', 'autoUpdater:download', message, error?.stack);
    return sendUpdateStatus('error', { message, progress: null });
  }
});

ipcMain.handle('install-update', () => {
  if (!app.isPackaged) {
    return sendUpdateStatus('disabled', {
      message: 'Updates can only be installed from packaged builds.',
      progress: null
    });
  }

  autoUpdater.quitAndInstall(false, true);
  return true;
});

ipcMain.handle('set-auto-launch', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  store.set('autoLaunch', enabled);
});

ipcMain.handle('save-and-open-log', async (_, logContent) => {
  // Open the persistent log file instead of writing a temp one
  const persistentLog = path.join(app.getPath('userData'), 'freesia.log');
  // Also append the renderer error log for completeness
  if (logContent && logContent !== 'No errors recorded.') {
    fs.appendFileSync(persistentLog, '\n--- Renderer Error Log Snapshot ---\n' + logContent + '\n', 'utf-8');
  }
  shell.openPath(persistentLog);
  return persistentLog;
});

// Log from renderer
ipcMain.handle('log-to-file', async (_, level, context, message, stack) => {
  writeLog(level, context, message, stack);
  return true;
});

// Failed recordings management
function getFailedDir() {
  const dir = path.join(app.getPath('userData'), 'failed-recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('save-failed-audio', async (_, base64Data, metadata) => {
  const dir = getFailedDir();
  const ts = Date.now();
  const audioPath = path.join(dir, `recording-${ts}.webm`);
  const metaPath = path.join(dir, `recording-${ts}.json`);
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(audioPath, buffer);
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');
  writeLog('WARN', 'failedRecording', `Saved failed recording: recording-${ts}.webm (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  return `recording-${ts}`;
});

ipcMain.handle('get-failed-recordings', async () => {
  const dir = getFailedDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.webm'));
  return files.map(f => {
    const base = f.replace('.webm', '');
    const metaPath = path.join(dir, base + '.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) { /* ignore */ }
    const stat = fs.statSync(path.join(dir, f));
    return { filename: f, baseName: base, sizeMB: (stat.size / 1024 / 1024).toFixed(1), ...meta };
  }).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
});

ipcMain.handle('get-failed-recording-data', async (_, filename) => {
  const filePath = path.join(getFailedDir(), filename);
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
});

ipcMain.handle('delete-failed-recording', async (_, baseName) => {
  const dir = getFailedDir();
  const audioPath = path.join(dir, baseName + '.webm');
  const metaPath = path.join(dir, baseName + '.json');
  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  return true;
});

// App lifecycle
app.whenReady().then(() => {
  initLogger();
  writeLog('INFO', 'app', 'Freesia starting up');
  applyAppTheme(store.get('theme'));
  createMainWindow();
  createOverlayWindow();
  createTray();
  registerShortcuts();
  setupAutoUpdater();

  if (store.get('autoLaunch')) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
});

nativeTheme.on('updated', broadcastThemeState);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit, stay in tray
  }
});

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
});
