const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, shell, nativeTheme, screen, dialog, powerMonitor } = require('electron');
const { createUpdateController } = require('./update-controller');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const { createSecrets } = require('./secrets');
const { createCloudEngine, createGeminiEngine, EngineError, DEFAULT_CLOUD_SERVER } = require('./engines');
const { createLocalEngine } = require('./local-engine');
const { createKeyHelper, snapshotClipboard, restoreClipboard } = require('./keys');
const { createAppScanner } = require('./apps');

// ============================================
// One-time migration from the old "Dictaloom" install
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
    const oldRecordings = path.join(oldDir, 'failed-recordings');
    if (fs.existsSync(oldRecordings)) {
      const newRecordings = path.join(app.getPath('userData'), 'failed-recordings');
      fs.mkdirSync(newRecordings, { recursive: true });
      for (const f of fs.readdirSync(oldRecordings)) fs.copyFileSync(path.join(oldRecordings, f), path.join(newRecordings, f));
    }
  } catch (e) {
    console.error('Dictaloom migration failed:', e);
  }
}
migrateFromDictaloom();

// ============================================
// File logger
// ============================================
const MAX_LOG_SIZE = 5 * 1024 * 1024;
let logFilePath = null;

function initLogger() {
  logFilePath = path.join(app.getPath('userData'), 'freesia.log');
}

function writeLog(level, context, message, stack) {
  if (!logFilePath) return;
  try {
    if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > MAX_LOG_SIZE) {
      const oldPath = logFilePath + '.old';
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      fs.renameSync(logFilePath, oldPath);
    }
    let entry = `[${new Date().toISOString()}] [${level}] [${context}] ${redact(String(message))}\n`;
    if (stack) entry += `  Stack: ${redact(String(stack))}\n`;
    fs.appendFileSync(logFilePath, entry, 'utf-8');
  } catch (e) {
    console.error('Logger write failed:', e);
  }
}

process.on('uncaughtException', (err) => {
  writeLog('FATAL', 'main:uncaughtException', err.message, err.stack);
  try { sendErrorReport({ level: 'FATAL', context: 'main:uncaughtException', message: err.message, stack: err.stack }); } catch { /* never disrupt */ }
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : '';
  writeLog('ERROR', 'main:unhandledRejection', msg, stack);
  try { sendErrorReport({ level: 'ERROR', context: 'main:unhandledRejection', message: msg, stack }); } catch { /* never disrupt */ }
  console.error('Unhandled Rejection:', reason);
});

// Multiple instances silently fight over the global shortcut.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', () => showMainWindow());

const isNewInstall = !fs.existsSync(path.join(app.getPath('userData'), 'config.json'));
const store = new Store({
  defaults: {
    onboarded: false,
    dictationShortcut: 'Ctrl+Shift+Space',
    commandShortcut: 'Ctrl+Shift+Alt+Space',
    // Transcription engine: cloud (a Freesia Voice server), local, gemini
    engine: isNewInstall ? 'cloud' : 'gemini',
    engineFallback: true,
    // Who formats text for styles: auto (cloud, then Gemini), cloud, gemini, off
    formatter: 'auto',
    aiFormatting: true,
    geminiModel: 'gemini-3.5-flash-lite',
    localModel: 'qwen3-asr-1.7b',
    localUnloadMinutes: 20,
    localUseGpu: true,
    microphoneId: '',
    language: 'auto',
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
    keepSuccessRecordings: false,
    customStyles: [],
    toolTrimSpelling: false,
    toolSpokenEmoji: false,
    toolPolish: false,
    errorReporting: isNewInstall,
    installId: ''
  }
});

if (!store.get('installId')) store.set('installId', require('crypto').randomUUID());

const secrets = createSecrets(store);

const cloud = createCloudEngine({ store, secrets, log: writeLog });
const gemini = createGeminiEngine({ store, secrets, log: writeLog });
const local = createLocalEngine({
  userDataDir: app.getPath('userData'), store, secrets, log: writeLog,
  onStatus: (s) => sendToMain('local-status', s)
});
const engines = { cloud, local, gemini };
const appScanner = createAppScanner({ app, shell, log: writeLog });
let keys = null;

function getStylesDir() {
  const dir = path.join(app.getPath('userData'), 'styles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isRecording = false;
let updateState = { status: 'idle', message: 'Update checks are ready.', version: app.getVersion(), isPackaged: app.isPackaged };

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function getThemeState() {
  return { source: nativeTheme.themeSource, shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
}

function applyAppTheme(themeSource) {
  const nextSource = ['system', 'light', 'dark'].includes(themeSource) ? themeSource : 'system';
  nativeTheme.themeSource = nextSource;
  store.set('theme', nextSource);
  sendToMain('theme-updated', getThemeState());
  return getThemeState();
}

function sendUpdateStatus(status, extra = {}) {
  updateState = { ...updateState, ...extra, status, version: app.getVersion(), isPackaged: app.isPackaged };
  sendToMain('update-status', updateState);
  return updateState;
}

let updateController;
function setupAutoUpdater() {
  autoUpdater.logger = {
    info: (m) => writeLog('INFO', 'autoUpdater', String(m)),
    warn: (m) => writeLog('WARN', 'autoUpdater', String(m)),
    error: (m) => writeLog('ERROR', 'autoUpdater', String(m)),
    debug: (m) => writeLog('DEBUG', 'autoUpdater', String(m))
  };
  updateController = createUpdateController({
    updater: autoUpdater, publish: sendUpdateStatus, packaged: app.isPackaged,
    canInstall: () => !isRecording && !isProcessing,
    beforeInstall: () => { app.isQuitting = true; },
    installFailed: () => { app.isQuitting = false; }
  });
  updateController.start();
  powerMonitor.on('resume', () => updateController.check());
  mainWindow.on('show', () => updateController.check());
  app.on('before-quit', () => updateController.stop());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 780,
    minWidth: 820,
    minHeight: 600,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#efeeea',
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The hidden-to-tray window hosts the recorder. Never throttle it.
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('maximize', () => sendToMain('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => sendToMain('window-state', { maximized: false }));
  // Links in transcripts or docs open in the browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    writeLog('ERROR', 'mainWindow:render-process-gone', details.reason);
    isRecording = false;
    isProcessing = false;
    hideOverlay();
    try { mainWindow.webContents.reload(); } catch { /* recreated on next activate */ }
  });
}

// The pill is 280x56; the window adds room for its shadow and bloom glow.
const OVERLAY_W = 340;
const OVERLAY_H = 104;

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
    hasShadow: false,
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
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.webContents.on('render-process-gone', (_, details) => {
    writeLog('ERROR', 'overlay:render-process-gone', details.reason);
    try { overlayWindow.destroy(); } catch { /* ignore */ }
    overlayWindow = null;
  });
}

function ensureOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  return overlayWindow;
}

function positionOverlay() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const saved = store.get('overlayPosition');
  let x = Math.round(dx + (dw - OVERLAY_W) / 2);
  let y = dy + dh - OVERLAY_H - 28;
  if (saved && saved.x >= 0 && saved.y >= 0) {
    const onScreen = screen.getAllDisplays().some((d) =>
      saved.x >= d.workArea.x && saved.x < d.workArea.x + d.workArea.width &&
      saved.y >= d.workArea.y && saved.y < d.workArea.y + d.workArea.height);
    if (onScreen) { x = saved.x; y = saved.y; }
  }
  overlayWindow.setBounds({ x, y, width: OVERLAY_W, height: OVERLAY_H });
}

let overlayHideTimer = null;
function showOverlay(state, info) {
  if (!store.get('showOverlay')) return;
  clearTimeout(overlayHideTimer);
  const win = ensureOverlayWindow();
  positionOverlay();
  // Re-assert topmost every time: Windows silently demotes always-on-top.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.showInactive();
  win.webContents.send('overlay-state', { state, ...info });
}

function setOverlay(state, info, hideAfterMs) {
  clearTimeout(overlayHideTimer);
  sendOverlay('overlay-state', { state, ...info });
  if (hideAfterMs) overlayHideTimer = setTimeout(hideOverlay, hideAfterMs);
}

function hideOverlay() {
  clearTimeout(overlayHideTimer);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-state', { state: 'hidden' });
    // Give the pill its exit animation before the window disappears
    setTimeout(() => { if (overlayWindow && !overlayWindow.isDestroyed() && !isRecording && !isProcessing) overlayWindow.hide(); }, 260);
  }
}

function sendOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, payload);
}

function createTray() {
  let trayIcon;
  try {
    const trayPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
    trayIcon = nativeImage.createFromPath(fs.existsSync(trayPath) ? trayPath : path.join(__dirname, '..', '..', 'assets', 'icon.png')).resize({ width: 16, height: 16, quality: 'best' });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('Freesia');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Freesia', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Start dictation', click: () => handleShortcut('dictate') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showMainWindow());
}

function toAccelerator(shortcut) {
  return String(shortcut || '').replace(/\bCtrl\b/g, 'CommandOrControl');
}

// Returns which shortcuts registered so the UI can flag conflicts.
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const result = {};
  for (const [key, mode, fallback] of [['dictationShortcut', 'dictate', 'Ctrl+Shift+Space'], ['commandShortcut', 'command', 'Ctrl+Shift+Alt+Space']]) {
    const shortcut = store.get(key) || fallback;
    try {
      result[key] = globalShortcut.register(toAccelerator(shortcut), () => handleShortcut(mode));
      if (!result[key]) writeLog('WARN', 'shortcuts', `Could not register ${shortcut}; another app may own it`);
    } catch (e) {
      result[key] = false;
      writeLog('ERROR', 'shortcuts', `Failed to register ${shortcut}: ${e.message}`, e.stack);
    }
  }
  if (isRecording) globalShortcut.register('Escape', cancelDictation);
  return result;
}

// Debounce and state machine for shortcut handling
let lastShortcutTime = 0;
let isProcessing = false;
let processingSince = 0;
const SHORTCUT_COOLDOWN_MS = 350;
const PROCESSING_STUCK_MS = 600000;

function handleShortcut(mode) {
  const now = Date.now();
  if (now - lastShortcutTime < SHORTCUT_COOLDOWN_MS) return;
  lastShortcutTime = now;
  // Never let a stale processing flag eat shortcuts forever
  if (isProcessing && now - processingSince > PROCESSING_STUCK_MS) {
    writeLog('WARN', 'handleShortcut', 'Clearing stuck processing state');
    isProcessing = false;
    hideOverlay();
  }
  if (isProcessing) return;
  if (isRecording) stopDictation(mode);
  else if (mode === 'command') startCommandMode();
  else startDictation();
}

function startDictation() {
  isRecording = true;
  globalShortcut.register('Escape', cancelDictation);
  sendToMain('dictation-start');
  showOverlay('listening', { mode: 'dictate' });
}

function stopDictation(mode = 'dictate') {
  if (!isRecording) return;
  isRecording = false;
  isProcessing = true;
  processingSince = Date.now();
  globalShortcut.unregister('Escape');
  sendToMain('dictation-stop', mode);
  setOverlay('processing');
}

// Command mode edits the selection by voice, so grab the selection first
// (2.x never read it, so commands had nothing to edit).
async function startCommandMode() {
  isRecording = true;
  globalShortcut.register('Escape', cancelDictation);
  showOverlay('listening', { mode: 'command' });
  let selection = '';
  try { selection = await captureSelection(); } catch (e) { writeLog('WARN', 'command', `Selection capture failed: ${e.message}`); }
  if (!isRecording) return;
  sendToMain('command-start', { selection });
  if (!selection) setOverlay('listening', { mode: 'command', hint: 'No selection: will write new text' });
}

function cancelDictation() {
  if (!isRecording) return;
  isRecording = false;
  isProcessing = false;
  globalShortcut.unregister('Escape');
  sendToMain('dictation-cancel');
  hideOverlay();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureSelection() {
  const snap = snapshotClipboard(clipboard);
  const sentinel = `⁣freesia-${Date.now()}`;
  clipboard.writeText(sentinel);
  const ok = await keys.copy();
  let selection = '';
  if (ok) {
    for (let i = 0; i < 8; i++) {
      await sleep(40);
      const now = clipboard.readText();
      if (now !== sentinel) { selection = now; break; }
    }
  }
  restoreClipboard(clipboard, snap);
  return selection.slice(0, 20000);
}

async function pasteSendKeysFallback() {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"],
      { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

async function injectText(text) {
  const snap = snapshotClipboard(clipboard);
  clipboard.writeText(text);
  // Let clipboard managers and remote-desktop clients sync before pasting
  await sleep(120);
  let method = 'scan-code';
  let ok = await keys.paste();
  if (!ok) {
    writeLog('WARN', 'inject', 'Scan-code paste failed, trying SendKeys fallback');
    ok = await pasteSendKeysFallback();
    method = 'SendKeys-fallback';
  }
  if (!ok) {
    // Leave the transcript in the clipboard so the user can paste it
    writeLog('ERROR', 'inject', 'Paste failed; transcript left in clipboard for manual Ctrl+V');
    return false;
  }
  writeLog('INFO', 'inject', `Pasted ${text.length} chars (${method})`);
  setTimeout(() => {
    // Only restore if nothing else replaced the clipboard meanwhile
    if (clipboard.readText() === text) restoreClipboard(clipboard, snap);
  }, 900);
  return true;
}

// ============================================
// IPC: settings (secrets and account data are never exposed)
// ============================================
const PRIVATE_KEYS = new Set(['secrets', 'cloud', 'apiKey', 'installId']);
function publicSettings() {
  const out = { ...store.store };
  for (const k of PRIVATE_KEYS) delete out[k];
  return out;
}
ipcMain.handle('get-settings', () => publicSettings());
ipcMain.handle('set-setting', (_, key, value) => {
  if (typeof key !== 'string' || PRIVATE_KEYS.has(key.split('.')[0])) return false;
  if (value === undefined || value === null) store.delete(key);
  else store.set(key, value);
  return true;
});
ipcMain.handle('get-setting', (_, key) => (PRIVATE_KEYS.has(String(key).split('.')[0]) ? undefined : store.get(key)));

ipcMain.handle('get-foreground-app', async () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    const psCmd = `(Get-Process | Where-Object { $_.MainWindowHandle -eq (Add-Type -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow();' -Name 'Win32' -Namespace Win32 -PassThru)::GetForegroundWindow() }).Name`;
    exec(`powershell -NoProfile -Command "${psCmd}"`, { windowsHide: true, timeout: 3000 }, (err, stdout) => resolve(err ? '' : (stdout || '').trim().toLowerCase()));
  });
});

ipcMain.handle('inject-text', (_, text) => injectText(String(text || '')));
ipcMain.handle('copy-text', (_, text) => { clipboard.writeText(String(text || '')); return true; });

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('toggle-maximize-window', () => { if (!mainWindow) return; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.handle('close-window', () => mainWindow?.hide());

ipcMain.on('recording-state', (_, state) => {
  isRecording = state === 'recording';
  isProcessing = state === 'processing';
  if (isProcessing) { processingSince = Date.now(); setOverlay('processing'); }
  if (isRecording) globalShortcut.register('Escape', cancelDictation);
  else globalShortcut.unregister('Escape');
});
ipcMain.handle('recording-failed', (_, message) => {
  isRecording = false;
  isProcessing = false;
  globalShortcut.unregister('Escape');
  setOverlay('error', { message: String(message || 'Could not record') }, 2600);
});
ipcMain.handle('overlay-done', (_, info) => {
  isProcessing = false;
  setOverlay('done', info || {}, 1700);
});
ipcMain.handle('overlay-error', (_, message) => {
  isProcessing = false;
  setOverlay('error', { message: String(message || 'Something went wrong') }, 3200);
});
ipcMain.handle('overlay-progress', (_, info) => setOverlay('processing', info || {}));
ipcMain.handle('overlay-hide', () => { isProcessing = false; hideOverlay(); });
ipcMain.handle('overlay-timer', (_, timeStr) => sendOverlay('overlay-timer', timeStr));
ipcMain.on('overlay-audio-level', (_, level) => sendOverlay('overlay-audio-level', Math.max(0, Math.min(1, Number(level) || 0))));

ipcMain.handle('open-external', (_, url) => {
  if (/^https:\/\//.test(String(url))) return shell.openExternal(url);
  return false;
});

ipcMain.handle('register-shortcuts', () => registerShortcuts());
ipcMain.handle('set-shortcut', (_, key, value) => {
  if (!['dictationShortcut', 'commandShortcut'].includes(key)) return { ok: false };
  const previous = store.get(key);
  store.set(key, value);
  const result = registerShortcuts();
  if (!result[key]) {
    store.set(key, previous);
    registerShortcuts();
    return { ok: false, message: `${value} is already used by another app or Windows.` };
  }
  return { ok: true };
});
// While the user records a new shortcut, the old ones must not fire
ipcMain.handle('suspend-shortcuts', () => { globalShortcut.unregisterAll(); return true; });

ipcMain.handle('get-theme-info', () => getThemeState());
ipcMain.handle('set-app-theme', (_, themeSource) => applyAppTheme(themeSource));
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-update-status', () => updateState);
ipcMain.handle('check-for-updates', () => updateController.check(true));
ipcMain.handle('download-update', () => updateController.download());
ipcMain.handle('install-update', () => updateController.install());

ipcMain.handle('set-auto-launch', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  store.set('autoLaunch', !!enabled);
});

ipcMain.handle('open-log', async () => {
  const persistentLog = path.join(app.getPath('userData'), 'freesia.log');
  if (!fs.existsSync(persistentLog)) fs.writeFileSync(persistentLog, '', 'utf-8');
  shell.openPath(persistentLog);
  return persistentLog;
});
ipcMain.handle('log-to-file', (_, level, context, message, stack) => { writeLog(level, context, message, stack); return true; });

// ============================================
// IPC: engines
// ============================================
function engineStatus() {
  return {
    engine: store.get('engine'),
    formatter: store.get('formatter'),
    cloud: cloud.status(),
    local: local.status(),
    gemini: gemini.status()
  };
}

function serializeError(e) {
  return { error: { code: e?.code || 'server', message: e?.message || String(e) } };
}

ipcMain.handle('engine:status', () => engineStatus());
ipcMain.handle('engine:set', (_, key, value) => {
  if (key === 'engine' && engines[value]) store.set('engine', value);
  if (key === 'formatter' && ['auto', 'cloud', 'gemini', 'off'].includes(value)) store.set('formatter', value);
  if (key === 'engine' && value === 'local') local.start().catch((e) => writeLog('WARN', 'local', `Warm start failed: ${e.message}`));
  return engineStatus();
});

// payload: { engine, audio: ArrayBuffer, mime, wav: ArrayBuffer|null, language, prompt, instruction, durationSec }
ipcMain.handle('engine:transcribe', async (event, payload) => {
  const engine = engines[payload?.engine];
  if (!engine) return serializeError(new EngineError('config', 'Unknown engine'));
  try {
    const args = {
      audio: Buffer.from(payload.audio || new ArrayBuffer(0)),
      wav: payload.wav ? Buffer.from(payload.wav) : null,
      mime: String(payload.mime || 'audio/webm'),
      language: payload.language,
      prompt: payload.prompt,
      instruction: payload.instruction,
      durationSec: Number(payload.durationSec) || 0,
      onRetry: (model) => event.sender.send('engine-retry', { engine: 'gemini', model })
    };
    if (engine === local && !args.wav) throw new EngineError('audio', 'The on-device engine needs WAV audio');
    const result = await engine.transcribe(args);
    return { ...result, engine: engine.id };
  } catch (e) {
    writeLog('WARN', `transcribe:${payload.engine}`, `${e.code || ''} ${e.message}`);
    return serializeError(e);
  }
});

ipcMain.handle('engine:format', async (_, { engine, prompt, temperature }) => {
  const target = engine === 'cloud' ? cloud : engine === 'gemini' ? gemini : null;
  if (!target) return serializeError(new EngineError('config', 'No formatter'));
  try {
    // Long dictations produce long outputs; allow ~1 s per 40 words on top of a base
    const timeoutMs = Math.min(180000, 25000 + String(prompt || '').length * 4);
    return { text: await target.format(String(prompt || ''), { temperature, timeoutMs }) };
  } catch (e) {
    writeLog('WARN', `format:${engine}`, `${e.code || ''} ${e.message}`);
    return serializeError(e);
  }
});

const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { return serializeError(e); } };
ipcMain.handle('cloud:login', wrap((_, server, username, password) =>
  cloud.login(server, String(username || ''), String(password || ''), `Freesia on ${os.hostname()}`)));
ipcMain.handle('cloud:logout', wrap(() => cloud.logout()));
ipcMain.handle('cloud:health', wrap(() => cloud.health()));
ipcMain.handle('cloud:open-account', () => { const s = cloud.status().server; return s ? shell.openExternal(s) : false; });
ipcMain.handle('gemini:set-key', wrap((_, key) => gemini.setKey(key)));
ipcMain.handle('gemini:refresh-models', wrap(() => gemini.refreshModels()));
ipcMain.handle('local:install', wrap((_, modelId) => local.install(modelId)));
ipcMain.handle('local:cancel', () => local.cancelInstall());
ipcMain.handle('local:remove', wrap((_, modelId) => local.remove(modelId)));
ipcMain.handle('local:start', wrap(async () => { await local.start(); return local.status(); }));
ipcMain.handle('local:stop', wrap(async () => { await local.stop(); return local.status(); }));
ipcMain.handle('local:select', wrap(async (_, modelId) => { store.set('localModel', modelId); await local.stop(); return local.status(); }));
ipcMain.handle('local:open-folder', () => {
  const dir = path.join(app.getPath('userData'), 'engines');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ============================================
// Saved recordings
// ============================================
function getFailedDir() {
  const dir = path.join(app.getPath('userData'), 'failed-recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const validBase = (b) => /^recording-[\w-]+$/.test(String(b || ''));

ipcMain.handle('save-failed-audio', async (_, audio, metadata, existingBase) => {
  const dir = getFailedDir();
  if (existingBase && !validBase(existingBase)) throw new Error('Invalid recording id');
  const base = existingBase || `recording-${Date.now()}-${require('crypto').randomUUID()}`;
  if (audio) await fs.promises.writeFile(path.join(dir, base + '.webm'), Buffer.from(audio));
  await fs.promises.writeFile(path.join(dir, base + '.json'), JSON.stringify(metadata, null, 2), 'utf-8');
  return base;
});

ipcMain.handle('get-failed-recordings', async () => {
  const dir = getFailedDir();
  const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.webm'));
  const entries = [];
  for (const f of files) {
    const base = f.replace('.webm', '');
    let meta = {};
    try { meta = JSON.parse(await fs.promises.readFile(path.join(dir, base + '.json'), 'utf-8')); } catch { /* audio still recoverable */ }
    try {
      const stat = await fs.promises.stat(path.join(dir, f));
      entries.push({ filename: f, baseName: base, sizeMB: (stat.size / 1024 / 1024).toFixed(1), ...meta });
    } catch { /* removed during enumeration */ }
  }
  return entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
});

ipcMain.handle('get-failed-recording-data', async (_, baseName) => {
  if (!validBase(baseName)) return null;
  const filePath = path.join(getFailedDir(), baseName + '.webm');
  if (!fs.existsSync(filePath)) return null;
  const buf = await fs.promises.readFile(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('delete-failed-recording', async (_, baseName) => {
  if (!validBase(baseName)) return false;
  const dir = getFailedDir();
  for (const ext of ['.webm', '.json']) {
    const p = path.join(dir, baseName + ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return true;
});

ipcMain.handle('show-recording-in-folder', (_, baseName) => {
  const audioPath = path.join(getFailedDir(), baseName + '.webm');
  if (validBase(baseName) && fs.existsSync(audioPath)) { shell.showItemInFolder(audioPath); return true; }
  shell.openPath(getFailedDir());
  return false;
});
ipcMain.handle('open-recordings-folder', () => shell.openPath(getFailedDir()));

// ============================================
// Custom style import (folder + file)
// ============================================
function coerceStyle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  const prompt = String(raw.prompt || '').trim();
  if (!name || !prompt) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 32) || 'style';
  return {
    id: String(raw.id || `custom-${slug}`),
    name: name.slice(0, 40),
    icon: [...String(raw.icon || '✨')].slice(0, 2).join(''),
    color: /^#[0-9a-fA-F]{6}$/.test(raw.color || '') ? raw.color : '#B69CFF',
    description: String(raw.description || '').slice(0, 120),
    prompt: prompt.slice(0, 4000),
    custom: true
  };
}

function parseStylesFromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(data) ? data : Array.isArray(data?.styles) ? data.styles : [data];
  return list.map(coerceStyle).filter(Boolean);
}

ipcMain.handle('apps:scan', (_, force, wanted) => appScanner.scan(!!force, Array.isArray(wanted) ? wanted : null).catch((e) => { writeLog('WARN', 'apps', e.message); return []; }));
ipcMain.handle('apps:running', () => appScanner.running().catch(() => []));
ipcMain.handle('get-styles-dir', () => getStylesDir());
ipcMain.handle('open-styles-folder', () => shell.openPath(getStylesDir()));
ipcMain.handle('import-styles-from-disk', () => {
  const dir = getStylesDir();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.json$/i.test(f)) continue;
    try { out.push(...parseStylesFromJson(fs.readFileSync(path.join(dir, f), 'utf-8'))); }
    catch (e) { writeLog('WARN', 'importStyles', `Bad style file ${f}: ${e.message}`); }
  }
  return out;
});
ipcMain.handle('import-style-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Freesia style', filters: [{ name: 'Freesia style', extensions: ['json'] }], properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  const out = [];
  for (const file of res.filePaths) {
    try { out.push(...parseStylesFromJson(fs.readFileSync(file, 'utf-8'))); }
    catch (e) { writeLog('WARN', 'importStyleFile', `${file}: ${e.message}`); }
  }
  return out;
});

// ============================================
// Optional, redacted error reporting
// ============================================
const REPORT_ENDPOINT = 'https://freesia.arash-ahmadi.com/report';

async function sendErrorReport({ level, context, message, stack }) {
  if (!store.get('errorReporting')) return false;
  try {
    const payload = {
      installId: store.get('installId') || 'unknown',
      appVersion: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      osRelease: os.release(),
      engine: store.get('engine'),
      level: String(level || 'ERROR').slice(0, 16),
      context: String(context || '').slice(0, 120),
      message: redact(String(message || '')).slice(0, 2000),
      stack: redact(String(stack || '')).slice(0, 6000),
      ts: new Date().toISOString()
    };
    const res = await fetch(REPORT_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
    });
    return res.ok;
  } catch (e) {
    writeLog('WARN', 'errorReport', `Failed to send report: ${e.message}`);
    return false;
  }
}

// Strip anything resembling a key or token from outgoing and logged text
function redact(s) {
  return s.replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza…[redacted]')
    .replace(/fv_[0-9A-Za-z_-]{10,}/g, 'fv_…[redacted]')
    .replace(/Bearer\s+[0-9A-Za-z._-]{10,}/gi, 'Bearer …[redacted]');
}

ipcMain.handle('send-error-report', (_, report) => sendErrorReport(report || {}));

// ============================================
// Lifecycle
// ============================================
app.whenReady().then(() => {
  // safeStorage (DPAPI) is only usable once the app is ready
  secrets.migrate();
  for (const name of ['gemini', 'cloud', 'localServer']) secrets.get(name);
  initLogger();
  writeLog('INFO', 'app', `Freesia ${app.getVersion()} starting (engine: ${store.get('engine')})`);
  keys = createKeyHelper({ dir: app.getPath('userData'), log: writeLog });
  keys.warm();
  applyAppTheme(store.get('theme'));
  createMainWindow();
  createOverlayWindow();
  createTray();
  registerShortcuts();
  setupAutoUpdater();
  if (store.get('autoLaunch')) app.setLoginItemSettings({ openAtLogin: true });
  // Load the on-device model early so the first dictation is instant
  if (store.get('engine') === 'local' && local.status().configured) {
    setTimeout(() => local.start().catch((e) => writeLog('WARN', 'local', `Warm start failed: ${e.message}`)), 2500);
  }
  if (gemini.status().configured) gemini.refreshModels().catch(() => {});
});

nativeTheme.on('updated', () => sendToMain('theme-updated', getThemeState()));

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  local.stop();
  keys?.dispose();
});

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('activate', () => { if (mainWindow === null) createMainWindow(); });

// Exposed for the end-to-end test harness (test/e2e.cjs)
module.exports = { captureSelection, injectText, handleShortcut, engines };
