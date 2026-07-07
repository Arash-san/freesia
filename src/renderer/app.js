// ============================================
// Freesia - Main Application Logic
// ============================================

const api = window.freesia;

// ============================================
// State
// ============================================
let settings = {};
let isRecording = false;
let isProcessingAudio = false;
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let animFrameId = null;
let availableModels = [];
let errorLog = [];
let activeStyleId = 'normal';
let lastDetectedApp = '';
let recordingStartTime = null;
let recordingTimerInterval = null;
let currentUpdateStatus = { status: 'idle', message: 'Update checks are ready.' };

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const PREFERRED_GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  DEFAULT_GEMINI_MODEL,
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
];
const BLOCKED_MODEL_ID_PATTERNS = [
  'embedding',
  'aqa',
  'imagen',
  'veo',
  'image',
  'tts',
  'live',
  'computer',
  'learnlm'
];
const BLOCKED_MODEL_TEXT_PATTERNS = [
  'nano banana',
  'nano-banana',
  'text-to-speech',
  'text to speech',
  'computer use',
  'computer-use'
];

// ============================================
// Error Logging
// ============================================
function logError(context, error) {
  const entry = {
    timestamp: new Date().toISOString(),
    context,
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
  errorLog.push(entry);
  console.error(`[${context}]`, error);
  // Save to persistent storage
  api.setSetting('errorLog', errorLog);
  // Write to persistent log file
  api.logToFile('ERROR', context, entry.message, entry.stack);
}

// ============================================
// Utilities for Large Audio
// ============================================
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ============================================
// Recording Timer
// ============================================
function startRecordingTimer() {
  recordingStartTime = Date.now();
  const timerEl = document.getElementById('recordingTimer');
  const timeEl = document.getElementById('recordingTime');
  if (timerEl) timerEl.style.display = 'flex';
  if (timeEl) timeEl.textContent = '0:00';
  recordingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const timeStr = `${min}:${sec.toString().padStart(2, '0')}`;
    if (timeEl) timeEl.textContent = timeStr;
    // Also update overlay with time
    if (api.overlayTimer) api.overlayTimer(timeStr);
  }, 1000);
}

function stopRecordingTimer() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
}

function getRecordingDuration() {
  if (!recordingStartTime) return '0:00';
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function getRecordingSeconds() {
  if (!recordingStartTime) return 0;
  return Math.max(0, Math.round((Date.now() - recordingStartTime) / 1000));
}

function hideRecordingTimer() {
  stopRecordingTimer();
  const timerEl = document.getElementById('recordingTimer');
  if (timerEl) timerEl.style.display = 'none';
  recordingStartTime = null;
}

function viewErrorLog() {
  const log = errorLog.length > 0
    ? errorLog.map(e => `[${e.timestamp}] ${e.context}: ${e.message}\n${e.stack}`).join('\n\n---\n\n')
    : 'No errors recorded.';
  // Save to file via main process and open
  api.saveAndOpenLog(log);
}

// Catch unhandled errors globally
window.onerror = (msg, src, line, col, err) => {
  logError('window.onerror', { message: `${msg} at ${src}:${line}:${col}`, stack: err?.stack || '' });
};
window.addEventListener('unhandledrejection', (e) => {
  logError('unhandledrejection', e.reason);
});

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  settings = await api.getSettings();
  applyTheme({
    source: settings.theme || 'system',
    shouldUseDarkColors: window.matchMedia?.('(prefers-color-scheme: dark)').matches
  });
  errorLog = settings.errorLog || [];
  if (settings.onboarded && settings.apiKey) {
    showPage('pageMain');
  } else {
    showPage('pageOnboarding');
  }
  bindEvents();
  activeStyleId = settings.activeStyle || 'normal';
  setupIpcListeners();
  setupUpdateListeners();
  setupThemeListeners();
  updateSettingsUI();
  initTheme();
  initAppMetadata();
  updateDashboardStats();
  renderDictionary();
  renderSnippets();
  renderHistory();
  renderStyleGrid();
  renderAppRules();
  loadFailedRecordings();
  // Place the segmented-nav highlight once the top bar has laid out
  requestAnimationFrame(positionNavIndicator);
});

// ============================================
// Page Navigation
// ============================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
}

function showContentPage(pageId) {
  document.querySelectorAll('.view').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.topnav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
  const nav = document.querySelector(`.topnav-item[data-page="${pageId.replace('Page', '')}"]`);
  if (nav) nav.classList.add('active');
  positionNavIndicator();
  // Scroll the stage back to the top on view change
  const stage = document.querySelector('.stage');
  if (stage) stage.scrollTop = 0;
}

// Slide the segmented-nav highlight under the active item
function positionNavIndicator() {
  const indicator = document.getElementById('topnavIndicator');
  const active = document.querySelector('.topnav-item.active');
  if (!indicator || !active) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft - 4}px)`;
}

// ============================================
// Event Bindings
// ============================================
function bindEvents() {
  // Window chrome
  document.getElementById('btnMinimize')?.addEventListener('click', () => api.minimize());
  document.getElementById('btnClose')?.addEventListener('click', () => api.close());

  // Onboarding
  document.getElementById('btnGetStarted')?.addEventListener('click', () => goToOnboardingStep(2));
  document.getElementById('btnBack2')?.addEventListener('click', () => goToOnboardingStep(1));
  document.getElementById('btnNext2')?.addEventListener('click', validateApiKey);
  document.getElementById('btnBack3')?.addEventListener('click', () => goToOnboardingStep(2));
  document.getElementById('btnFinish')?.addEventListener('click', finishOnboarding);
  document.getElementById('btnToggleKey')?.addEventListener('click', toggleKeyVisibility);
  document.getElementById('getKeyLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    api.openExternal('https://aistudio.google.com/app/apikey');
  });

  // API key input
  const apiInput = document.getElementById('apiKeyInput');
  if (apiInput) {
    apiInput.addEventListener('input', () => {
      document.getElementById('btnNext2').disabled = apiInput.value.trim().length < 10;
    });
    apiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && apiInput.value.trim().length >= 10) validateApiKey();
    });
  }

  // Top segmented nav
  document.querySelectorAll('.topnav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => showContentPage(btn.dataset.page + 'Page'));
  });
  document.getElementById('navSettings')?.addEventListener('click', () => showPage('pageSettings'));
  document.getElementById('btnBackSettings')?.addEventListener('click', () => {
    showPage('pageMain');
    // Recompute the nav highlight now that the bar is measurable again
    requestAnimationFrame(positionNavIndicator);
  });
  document.getElementById('btnThemeToggle')?.addEventListener('click', toggleTheme);
  // Keep the nav highlight aligned when the window resizes
  window.addEventListener('resize', positionNavIndicator);

  // Settings
  document.getElementById('btnChangeKey')?.addEventListener('click', () => {
    goToOnboardingStep(2);
    showPage('pageOnboarding');
  });
  document.getElementById('toggleFormatting')?.addEventListener('change', (e) => saveSetting('aiFormatting', e.target.checked));
  document.getElementById('selectLanguage')?.addEventListener('change', (e) => saveSetting('language', e.target.value));
  document.getElementById('selectTheme')?.addEventListener('change', (e) => setTheme(e.target.value));
  document.getElementById('toggleAutoLaunch')?.addEventListener('change', (e) => {
    api.setAutoLaunch(e.target.checked);
  });
  document.getElementById('toggleKeepRecordings')?.addEventListener('change', (e) => saveSetting('keepSuccessRecordings', e.target.checked));
  document.getElementById('toggleOverlay')?.addEventListener('change', (e) => saveSetting('showOverlay', e.target.checked));
  document.getElementById('toggleSounds')?.addEventListener('change', (e) => saveSetting('sounds', e.target.checked));
  document.getElementById('btnGitHub')?.addEventListener('click', () => api.openExternal('https://github.com/arash-san/freesia'));
  document.getElementById('btnCheckUpdates')?.addEventListener('click', checkForUpdates);
  document.getElementById('btnDownloadUpdate')?.addEventListener('click', downloadUpdate);
  document.getElementById('btnInstallUpdate')?.addEventListener('click', installUpdate);

  // Danger Zone
  document.getElementById('btnViewErrors')?.addEventListener('click', viewErrorLog);
  document.getElementById('btnResetSettings')?.addEventListener('click', resetAllSettings);

  // Styles
  document.getElementById('toggleAutoStyle')?.addEventListener('change', (e) => saveSetting('autoStyleSwitch', e.target.checked));

  // Dictionary
  document.getElementById('btnAddWord')?.addEventListener('click', () => {
    const el = document.getElementById('dictionaryInput');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    document.getElementById('newWordInput')?.focus();
  });
  document.getElementById('btnSaveWord')?.addEventListener('click', addWord);
  document.getElementById('btnCancelWord')?.addEventListener('click', () => {
    document.getElementById('dictionaryInput').style.display = 'none';
  });
  document.getElementById('newWordInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWord();
  });

  // Snippets
  document.getElementById('btnAddSnippet')?.addEventListener('click', () => {
    currentEditSnippetId = null;
    document.getElementById('snippetTrigger').value = '';
    document.getElementById('snippetExpansion').value = '';
    const el = document.getElementById('snippetForm');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnSaveSnippet')?.addEventListener('click', saveSnippet);
  document.getElementById('btnCancelSnippet')?.addEventListener('click', () => {
    document.getElementById('snippetForm').style.display = 'none';
  });

  // History
  document.getElementById('btnClearHistory')?.addEventListener('click', async () => {
    await saveSetting('history', []);
    settings.history = [];
    renderHistory();
    showToast('History cleared', 'info');
  });

  // Mic test
  document.getElementById('btnMicTest')?.addEventListener('click', toggleMicTest);
}

// ============================================
// Onboarding
// ============================================
function goToOnboardingStep(step) {
  document.querySelectorAll('.onboarding-step').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`step${step}`);
  if (el) {
    el.classList.add('active');
    el.scrollTop = 0;
  }
}

function toggleKeyVisibility() {
  const input = document.getElementById('apiKeyInput');
  if (input.type === 'password') {
    input.type = 'text';
    document.getElementById('btnToggleKey').textContent = '🙈';
  } else {
    input.type = 'password';
    document.getElementById('btnToggleKey').textContent = '👁';
  }
}

async function validateApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  const statusEl = document.getElementById('apiStatus');
  const btn = document.getElementById('btnNext2');
  
  btn.disabled = true;
  btn.textContent = 'Validating...';
  statusEl.className = 'api-status loading';
  statusEl.innerHTML = '<span class="spinner"></span> Testing connection...';

  try {
    // Validate by listing models (works for any valid key)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (response.ok) {
      statusEl.className = 'api-status success';
      statusEl.innerHTML = '✅ Connected! Fetching available models...';
      await saveSetting('apiKey', key);
      settings.apiKey = key;
      await fetchAvailableModels();
      statusEl.innerHTML = '✅ Connected successfully!';
      setTimeout(() => goToOnboardingStep(3), 600);
    } else {
      const err = await response.json();
      statusEl.className = 'api-status error';
      statusEl.innerHTML = `❌ ${err.error?.message || 'Invalid API key'}`;
    }
  } catch (e) {
    statusEl.className = 'api-status error';
    statusEl.innerHTML = '❌ Network error. Check your connection.';
  }

  btn.disabled = false;
  btn.textContent = 'Validate & Continue';
}

async function finishOnboarding() {
  await saveSetting('onboarded', true);
  settings.onboarded = true;
  showPage('pageMain');
  requestAnimationFrame(positionNavIndicator);
  showToast('Welcome to Freesia! 🌸', 'success');
}

// ============================================
// Settings
// ============================================
async function saveSetting(key, value) {
  settings[key] = value;
  await api.setSetting(key, value);
}

function normalizeModelId(modelId) {
  return (modelId || '').replace(/^models\//, '').toLowerCase();
}

function isBlockedModel(model) {
  const id = normalizeModelId(typeof model === 'string' ? model : (model.id || model.name));
  const name = typeof model === 'string' ? '' : (model.displayName || model.name || '');
  const desc = typeof model === 'string' ? '' : (model.description || '');
  const text = `${name} ${desc}`.toLowerCase();

  return BLOCKED_MODEL_ID_PATTERNS.some(pattern => id.includes(pattern))
    || BLOCKED_MODEL_TEXT_PATTERNS.some(pattern => text.includes(pattern));
}

function pickPreferredGeminiModel(models) {
  const availableIds = models.map(m => normalizeModelId(m.id));
  const preferred = PREFERRED_GEMINI_MODELS.find(id => availableIds.includes(id));
  return preferred || models[0]?.id || DEFAULT_GEMINI_MODEL;
}

function getSelectedModel() {
  if (settings.geminiModel && !isBlockedModel(settings.geminiModel)) {
    return settings.geminiModel;
  }
  return DEFAULT_GEMINI_MODEL;
}

async function fetchAvailableModels() {
  if (!settings.apiKey) return;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${settings.apiKey}&pageSize=100`
    );
    if (!response.ok) return;
    const data = await response.json();

    // Voice-capable keywords — models that can handle audio input
    const voiceCapablePatterns = ['flash', 'pro', '2.5', '2.0', '3.0', '3.1'];

    const models = (data.models || [])
      .filter(m => {
        const methods = m.supportedGenerationMethods || [];
        const id = m.name.replace('models/', '').toLowerCase();
        const desc = (m.description || '').toLowerCase();
        // Must support generateContent
        if (!methods.includes('generateContent')) return false;
        // Exclude image, Nano Banana, TTS, Live, computer-use, and other non-dictation models
        if (isBlockedModel(m)) return false;
        // Must be a gemini model
        if (!id.startsWith('gemini')) return false;
        // Check for multimodal/audio support in description or modern model versions
        const isMultimodal = desc.includes('audio') || desc.includes('multimodal') || desc.includes('image');
        const isModern = voiceCapablePatterns.some(p => id.includes(p));
        return isMultimodal || isModern;
      })
      .map(m => {
        const id = m.name.replace('models/', '');
        return {
          id,
          name: m.displayName || id,
          description: m.description || '',
          inputTokenLimit: m.inputTokenLimit || 0,
          outputTokenLimit: m.outputTokenLimit || 0
        };
      })
      .sort((a, b) => {
        const getPreference = (id) => {
          const index = PREFERRED_GEMINI_MODELS.indexOf(normalizeModelId(id));
          return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        const preferenceDiff = getPreference(a.id) - getPreference(b.id);
        if (preferenceDiff !== 0) return preferenceDiff;

        const getVersion = (id) => {
          const match = id.match(/(\d+\.\d+)/);
          return match ? parseFloat(match[1]) : 0;
        };
        return getVersion(b.id) - getVersion(a.id);
      });

    availableModels = models;
    renderModelCards();

    // Auto-select best model if none is saved
    if ((!settings.geminiModel || isBlockedModel(settings.geminiModel)) && models.length > 0) {
      const best = pickPreferredGeminiModel(models);
      await saveSetting('geminiModel', best);
      settings.geminiModel = best;
      renderModelCards();
    }
  } catch (e) {
    logError('fetchAvailableModels', e);
  }
}

function renderModelCards() {
  const containers = document.querySelectorAll('.model-list');
  if (containers.length === 0) return;

  const selected = settings.geminiModel || '';

  const html = availableModels.length === 0
    ? '<div class="model-card glass-card loading-card"><span class="text-muted">No voice-capable models found</span></div>'
    : availableModels.map((m, i) => {
        const isSelected = m.id === selected;
        const isFlash = m.id.includes('flash');
        const isPro = m.id.includes('pro');
        const isPreview = m.id.includes('preview');
        const isLatest = i === 0;

        let badges = '';
        if (isLatest) badges += '<span class="model-badge latest">Latest</span>';
        if (isFlash) badges += '<span class="model-badge flash">Fast</span>';
        if (isPro) badges += '<span class="model-badge pro">Pro</span>';
        if (isPreview) badges += '<span class="model-badge preview">Preview</span>';

        return `
          <div class="model-card glass-card ${isSelected ? 'selected' : ''}" data-model-id="${m.id}" onclick="selectModel('${m.id}')">
            <div class="model-radio"></div>
            <div class="model-details">
              <div class="model-name">${escapeHtml(m.name)}</div>
              <div class="model-id">${m.id}</div>
            </div>
            <div class="model-badges">${badges}</div>
          </div>
        `;
      }).join('');

  containers.forEach(c => { c.innerHTML = html; });
}

async function selectModel(modelId) {
  await saveSetting('geminiModel', modelId);
  settings.geminiModel = modelId;
  renderModelCards();
  showToast(`Model set to ${modelId}`, 'success');
}

async function resetAllSettings() {
  if (!confirm('Are you sure? This will clear your API key, dictionary, snippets, history, and all settings.')) return;
  const keys = ['apiKey', 'onboarded', 'geminiModel', 'aiFormatting', 'language', 'theme',
    'autoLaunch', 'showOverlay', 'sounds', 'keepSuccessRecordings', 'dictionary', 'snippets',
    'history', 'stats', 'errorLog'];
  for (const k of keys) await api.setSetting(k, undefined);
  settings = await api.getSettings();
  availableModels = [];
  errorLog = [];
  goToOnboardingStep(1);
  showPage('pageOnboarding');
  showToast('Settings reset. Welcome back!', 'info');
}

function updateSettingsUI() {
  if (settings.apiKey) {
    const masked = settings.apiKey.substring(0, 6) + '••••••••';
    const el = document.getElementById('settingsApiPreview');
    if (el) el.textContent = masked;
    // Fetch models if we have a key but haven't loaded them yet
    if (availableModels.length === 0) fetchAvailableModels();
  }
  const fmt = document.getElementById('toggleFormatting');
  if (fmt) fmt.checked = settings.aiFormatting !== false;
  const lang = document.getElementById('selectLanguage');
  if (lang) lang.value = settings.language || 'en';
  const theme = document.getElementById('selectTheme');
  if (theme) theme.value = settings.theme || 'system';
  const al = document.getElementById('toggleAutoLaunch');
  if (al) al.checked = settings.autoLaunch || false;
  const kr = document.getElementById('toggleKeepRecordings');
  if (kr) kr.checked = settings.keepSuccessRecordings || false;
  const ov = document.getElementById('toggleOverlay');
  if (ov) ov.checked = settings.showOverlay !== false;
  const snd = document.getElementById('toggleSounds');
  if (snd) snd.checked = settings.sounds !== false;
}

function applyTheme(themeInfo = {}) {
  const source = themeInfo.source || settings.theme || 'system';
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  const shouldUseDarkColors = source === 'dark'
    || (source === 'system' && (themeInfo.shouldUseDarkColors ?? prefersDark));

  document.documentElement.dataset.theme = shouldUseDarkColors ? 'dark' : 'light';
  document.documentElement.dataset.themeSource = source;
}

async function initTheme() {
  try {
    const themeInfo = await api.getThemeInfo?.();
    if (themeInfo) applyTheme(themeInfo);
  } catch (e) {
    logError('initTheme', e);
  }
}

function setupThemeListeners() {
  if (!api.onThemeUpdated) return;
  api.onThemeUpdated((themeInfo) => applyTheme(themeInfo));
}

async function setTheme(themeSource) {
  settings.theme = themeSource;
  applyTheme({
    source: themeSource,
    shouldUseDarkColors: window.matchMedia?.('(prefers-color-scheme: dark)').matches
  });

  // Keep the Settings dropdown in sync with the top-bar toggle
  const themeSelect = document.getElementById('selectTheme');
  if (themeSelect) themeSelect.value = themeSource;

  try {
    const themeInfo = await api.setAppTheme?.(themeSource);
    if (themeInfo) applyTheme(themeInfo);
  } catch (e) {
    logError('setTheme', e);
    await saveSetting('theme', themeSource);
  }
}

// Top-bar quick toggle: flips between the two effective appearances and
// pins an explicit choice (so it no longer follows the system).
function toggleTheme() {
  const isDark = document.documentElement.dataset.theme !== 'light';
  const next = isDark ? 'light' : 'dark';
  setTheme(next);
  showToast(next === 'dark' ? '🌙 Dark theme' : '☀️ Light theme', 'info');
}

async function initAppMetadata() {
  try {
    const version = await api.getAppVersion?.();
    const versionEl = document.getElementById('appVersionLabel');
    if (versionEl && version) versionEl.textContent = `Version ${version} - MIT License`;

    const updateStatus = await api.getUpdateStatus?.();
    if (updateStatus) renderUpdateStatus(updateStatus);
  } catch (e) {
    logError('initAppMetadata', e);
  }
}

function setupUpdateListeners() {
  if (!api.onUpdateStatus) return;
  api.onUpdateStatus((state) => renderUpdateStatus(state));
}

function renderUpdateStatus(state = {}) {
  currentUpdateStatus = state;

  const statusEl = document.getElementById('updateStatusText');
  const checkBtn = document.getElementById('btnCheckUpdates');
  const downloadBtn = document.getElementById('btnDownloadUpdate');
  const installBtn = document.getElementById('btnInstallUpdate');
  const progressEl = document.getElementById('updateProgress');
  const progressBar = document.getElementById('updateProgressBar');

  if (statusEl) {
    statusEl.textContent = state.message || 'Update checks are ready.';
  }

  const status = state.status || 'idle';
  const busy = status === 'checking' || status === 'downloading';
  if (checkBtn) checkBtn.disabled = busy;
  if (downloadBtn) downloadBtn.style.display = status === 'available' ? '' : 'none';
  if (installBtn) installBtn.style.display = status === 'downloaded' ? '' : 'none';

  const percent = Math.max(0, Math.min(100, Math.round(state.progress?.percent || 0)));
  if (progressEl && progressBar) {
    const showProgress = status === 'downloading' || status === 'downloaded';
    progressEl.style.display = showProgress ? 'block' : 'none';
    progressBar.style.width = `${status === 'downloaded' ? 100 : percent}%`;
  }
}

async function checkForUpdates() {
  try {
    renderUpdateStatus({ ...currentUpdateStatus, status: 'checking', message: 'Checking for updates.' });
    const state = await api.checkForUpdates?.();
    if (state) renderUpdateStatus(state);
  } catch (e) {
    logError('checkForUpdates', e);
    renderUpdateStatus({ status: 'error', message: e.message || 'Update check failed.' });
  }
}

async function downloadUpdate() {
  try {
    renderUpdateStatus({ ...currentUpdateStatus, status: 'downloading', message: 'Starting update download.' });
    const state = await api.downloadUpdate?.();
    if (state) renderUpdateStatus(state);
  } catch (e) {
    logError('downloadUpdate', e);
    renderUpdateStatus({ status: 'error', message: e.message || 'Update download failed.' });
  }
}

async function installUpdate() {
  try {
    await api.installUpdate?.();
  } catch (e) {
    logError('installUpdate', e);
    renderUpdateStatus({ status: 'error', message: e.message || 'Update install failed.' });
  }
}

// ============================================
// Dashboard Stats
// ============================================
// Average typing speed used to estimate saved time. Speaking runs at
// 130+ WPM, so time saved = estimated typing time - actual speaking time.
const TYPING_WPM = 40;

function localDateString(d = new Date()) {
  // Local calendar date, not UTC — the old toISOString() version rolled
  // the "day" over at UTC midnight, resetting stats mid-evening in the US.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyDayStats(date) {
  return { date, words: 0, sessions: 0, recordSec: 0, savedSec: 0 };
}

function normalizeStats(raw) {
  const today = localDateString();
  // Fresh install
  if (!raw) {
    return {
      today: emptyDayStats(today),
      lifetime: { words: 0, sessions: 0, recordSec: 0, savedSec: 0 },
      streak: { current: 0, best: 0, lastDate: '' }
    };
  }
  // Migrate the legacy flat shape { wordsToday, timeSaved, sessions, lastDate }
  if (raw.wordsToday !== undefined || !raw.lifetime) {
    const words = raw.wordsToday || 0;
    const sessions = raw.sessions || 0;
    const savedSec = (raw.timeSaved || 0) * 60;
    const isToday = raw.lastDate === today;
    return {
      today: isToday
        ? { date: today, words, sessions, recordSec: 0, savedSec }
        : emptyDayStats(today),
      // Seed lifetime with whatever the legacy counters held so the
      // user doesn't start back at zero.
      lifetime: { words, sessions, recordSec: 0, savedSec },
      streak: { current: raw.lastDate ? 1 : 0, best: raw.lastDate ? 1 : 0, lastDate: raw.lastDate || '' }
    };
  }
  // Current shape: roll the day over without touching lifetime or streak
  if (raw.today?.date !== today) {
    raw.today = emptyDayStats(today);
  }
  return raw;
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function updateDashboardStats() {
  const stats = normalizeStats(settings.stats);
  settings.stats = stats;
  saveSetting('stats', stats);

  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  set('statWords', stats.today.words.toLocaleString());
  set('statTime', formatDuration(stats.today.savedSec));
  set('statSessions', String(stats.today.sessions));
  set('statStreak', String(stats.streak.current));

  set('statWordsAll', stats.lifetime.words.toLocaleString());
  set('statTimeAll', formatDuration(stats.lifetime.savedSec));
  set('statSessionsAll', String(stats.lifetime.sessions));
  const avg = stats.lifetime.sessions > 0
    ? Math.round(stats.lifetime.words / stats.lifetime.sessions)
    : 0;
  set('statAvg', String(avg));
}

async function incrementStats(wordCount, recordSeconds = 0) {
  const stats = normalizeStats(settings.stats);
  const today = localDateString();

  // Exact seconds, no per-session rounding: a 15-word dictation used to
  // contribute Math.round(15/40) = 0 minutes forever.
  const typingSec = (wordCount / TYPING_WPM) * 60;
  const savedSec = Math.max(0, typingSec - recordSeconds);

  stats.today.words += wordCount;
  stats.today.sessions += 1;
  stats.today.recordSec += recordSeconds;
  stats.today.savedSec += savedSec;

  stats.lifetime.words += wordCount;
  stats.lifetime.sessions += 1;
  stats.lifetime.recordSec += recordSeconds;
  stats.lifetime.savedSec += savedSec;

  // Streak: consecutive calendar days with at least one dictation
  if (stats.streak.lastDate !== today) {
    const yesterday = localDateString(new Date(Date.now() - 86400000));
    stats.streak.current = stats.streak.lastDate === yesterday ? stats.streak.current + 1 : 1;
    stats.streak.best = Math.max(stats.streak.best, stats.streak.current);
    stats.streak.lastDate = today;
  }

  await saveSetting('stats', stats);
  settings.stats = stats;
  updateDashboardStats();
}

// ============================================
// Dictionary
// ============================================
async function addWord() {
  const input = document.getElementById('newWordInput');
  const word = input.value.trim();
  if (!word) return;
  const dict = settings.dictionary || [];
  if (!dict.includes(word)) {
    dict.push(word);
    await saveSetting('dictionary', dict);
    settings.dictionary = dict;
    renderDictionary();
    showToast(`Added "${word}" to dictionary`, 'success');
  }
  input.value = '';
  document.getElementById('dictionaryInput').style.display = 'none';
}

async function removeWord(word) {
  const dict = (settings.dictionary || []).filter(w => w !== word);
  await saveSetting('dictionary', dict);
  settings.dictionary = dict;
  renderDictionary();
}

function renderDictionary() {
  const list = document.getElementById('dictionaryList');
  if (!list) return;
  const dict = settings.dictionary || [];
  if (dict.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📖</div><p>No words added yet</p><p class="text-sm text-secondary">Add custom words to improve accuracy</p></div>`;
    return;
  }
  list.innerHTML = dict.map(word => `
    <div class="tag" style="margin: 4px;">
      ${escapeHtml(word)}
      <span class="tag-remove" onclick="removeWord('${escapeHtml(word)}')" title="Remove">✕</span>
    </div>
  `).join('');
}

// ============================================
// Snippets
// ============================================
let currentEditSnippetId = null;

async function saveSnippet() {
  const trigger = document.getElementById('snippetTrigger').value.trim();
  const expansion = document.getElementById('snippetExpansion').value.trim();
  if (!trigger || !expansion) return showToast('Fill in both fields', 'error');
  
  const snippets = settings.snippets || [];
  
  if (currentEditSnippetId) {
    const idx = snippets.findIndex(s => s.id === currentEditSnippetId);
    if (idx !== -1) {
      snippets[idx].trigger = trigger;
      snippets[idx].expansion = expansion;
    }
    currentEditSnippetId = null;
  } else {
    snippets.push({ trigger, expansion, id: Date.now() });
  }
  
  await saveSetting('snippets', snippets);
  settings.snippets = snippets;
  renderSnippets();
  document.getElementById('snippetTrigger').value = '';
  document.getElementById('snippetExpansion').value = '';
  document.getElementById('snippetForm').style.display = 'none';
  showToast(`Snippet "${trigger}" saved`, 'success');
}

function editSnippet(id) {
  const snippets = settings.snippets || [];
  const s = snippets.find(s => s.id === id);
  if (!s) return;
  
  currentEditSnippetId = id;
  document.getElementById('snippetTrigger').value = s.trigger;
  document.getElementById('snippetExpansion').value = s.expansion;
  document.getElementById('snippetForm').style.display = 'block';
  document.getElementById('snippetTrigger').focus();
}

async function removeSnippet(id) {
  const snippets = (settings.snippets || []).filter(s => s.id !== id);
  await saveSetting('snippets', snippets);
  settings.snippets = snippets;
  renderSnippets();
}

function renderSnippets() {
  const list = document.getElementById('snippetList');
  if (!list) return;
  const snippets = settings.snippets || [];
  if (snippets.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⚡</div><p>No snippets yet</p><p class="text-sm text-secondary">Create shortcuts for text you use often</p></div>`;
    return;
  }
  list.innerHTML = snippets.map(s => `
    <div class="snippet-item glass-card">
      <div class="snippet-trigger-label">"${escapeHtml(s.trigger)}"</div>
      <div class="snippet-expansion-text text-secondary text-sm">${escapeHtml(s.expansion)}</div>
      <div class="snippet-actions" style="display: flex; gap: 8px;">
        <button class="btn btn-secondary btn-sm" onclick="editSnippet(${s.id})">Edit</button>
        <button class="btn btn-danger btn-sm snippet-delete" onclick="removeSnippet(${s.id})">Remove</button>
      </div>
    </div>
  `).join('');
}

// ============================================
// History
// ============================================
async function addToHistory(text, mode) {
  const history = settings.history || [];
  history.unshift({
    text,
    mode,
    timestamp: new Date().toISOString(),
    id: Date.now()
  });
  if (history.length > 100) history.pop();
  await saveSetting('history', history);
  settings.history = history;
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  const history = settings.history || [];
  if (history.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>No history yet</p><p class="text-sm text-secondary">Your transcriptions will appear here</p></div>`;
    return;
  }
  list.innerHTML = history.map(h => {
    const date = new Date(h.timestamp);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const id = String(h.id || '');
    return `
      <div class="history-item glass-card">
        <div class="history-meta">
          <span class="tag">${h.mode === 'command' ? '✨ Command' : '🎤 Dictation'}</span>
          <div class="history-actions">
            <span class="text-muted text-sm">${time}</span>
            <button class="btn btn-ghost btn-sm history-copy-btn" onclick="copyHistoryItem('${escapeHtml(id)}')" title="Copy text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              Copy
            </button>
          </div>
        </div>
        <div class="history-text">${escapeHtml(h.text)}</div>
      </div>
    `;
  }).join('');
}

async function copyHistoryItem(id) {
  const item = (settings.history || []).find(h => String(h.id) === String(id));
  if (!item) return;

  try {
    await api.copyText(item.text);
    showToast('Copied to clipboard', 'success');
  } catch (e) {
    logError('copyHistoryItem', e);
    showToast('Copy failed', 'error');
  }
}

// ============================================
// Audio & Dictation
// ============================================
async function toggleMicTest() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (isProcessingAudio) return; // Don't start while processing
  try {
    // Auto-detect style from focused app before recording
    await detectAndApplyAutoStyle();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    isRecording = true;

    // Visual feedback
    const btn = document.getElementById('btnMicTest');
    if (btn) btn.classList.add('recording');

    // Start recording timer
    startRecordingTimer();

    // Set up audio analysis for waveform
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    drawWaveform();

    // Set up recording — use timeslice to capture data periodically for long recordings
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      cancelAnimationFrame(animFrameId);
      clearWaveform();
      const btn = document.getElementById('btnMicTest');
      if (btn) btn.classList.remove('recording');
      stopRecordingTimer();

      if (audioChunks.length > 0) {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        await processAudio(audioBlob, 'dictate');
      }
    };

    // Use 10s timeslice so data is captured incrementally (prevents data loss on crash)
    mediaRecorder.start(10000);
    showToast('🎤 Recording... Click again to stop', 'info');
  } catch (e) {
    logError('startRecording', e);
    showToast('Microphone access denied', 'error');
    hideRecordingTimer();
    isRecording = false;
    // Tell the main process the recording never started so the global
    // shortcut state machine doesn't get stuck in "recording".
    api.recordingFailed?.();
  }
}

function stopRecording() {
  isRecording = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  // Timer continues until processAudio finishes
}

async function processAudio(audioBlob, mode) {
  if (isProcessingAudio) return;
  isProcessingAudio = true;
  const outputEl = document.getElementById('testOutput');
  const duration = getRecordingDuration();
  if (outputEl) outputEl.innerHTML = `<span class="spinner"></span> Saving recording...`;

  let base64Audio = null;
  let audioSizeMB = '0';
  let savedBaseName = null;

  // ── STEP 1: Encode audio ──
  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    base64Audio = arrayBufferToBase64(arrayBuffer);
    audioSizeMB = (arrayBuffer.byteLength / (1024 * 1024)).toFixed(1);
  } catch (e) {
    logError('processAudio:encode', e);
    if (outputEl) outputEl.innerHTML = `<span style="color: var(--accent-warning)">Error encoding audio: ${escapeHtml(e.message)}</span>`;
    isProcessingAudio = false;
    hideRecordingTimer();
    api.overlayError();
    return;
  }

  // ── STEP 2: Save to disk FIRST (safety net — never lose audio) ──
  try {
    savedBaseName = await api.saveFailedAudio(base64Audio, {
      timestamp: new Date().toISOString(),
      mode,
      sizeMB: audioSizeMB,
      duration,
      error: 'Pending transcription',
      style: activeStyleId
    });
    await loadFailedRecordings();
  } catch (saveErr) {
    logError('processAudio:safetySave', saveErr);
    // Continue anyway — transcription might still work
  }

  if (outputEl) outputEl.innerHTML = `<span class="spinner"></span> Transcribing ${duration} of audio...`;

  // ── STEP 3: Attempt transcription with retries ──
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [2000, 5000, 10000];
  let lastError = null;
  let success = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1] || 10000;
        if (outputEl) outputEl.innerHTML = `<span class="spinner"></span> Retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s...`;
        showToast(`Retrying transcription (${attempt}/${MAX_RETRIES})...`, 'info');
        await new Promise(r => setTimeout(r, delay));
        if (outputEl) outputEl.innerHTML = '<span class="spinner"></span> Retrying transcription...';
      }

      const model = getSelectedModel();
      const transcriptResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: 'audio/webm', data: base64Audio } },
                { text: (() => {
                    const style = getActiveStyle();
                    const lang = (style.id === 'native' && style.language)
                      ? (settings.nativeLanguage || style.language)
                      : (settings.language || 'en');
                    const langName = style.languageOptions?.find(l => l.code === lang)?.name || lang;
                    if (style.id === 'native') {
                      return `The user is speaking in ${langName}. Transcribe their speech and translate it into fluent, natural English. Do NOT drop any meaning. Do NOT summarize. Preserve every idea and detail. Return ONLY the English translation, nothing else.`;
                    }
                    return `Transcribe this audio exactly. Language: ${lang}. Return ONLY the transcribed text, nothing else.`;
                  })() }
              ]
            }]
          })
        }
      );

      if (!transcriptResponse.ok) {
        const err = await transcriptResponse.json().catch(() => ({}));
        throw new Error(err.error?.message || `Transcription failed (HTTP ${transcriptResponse.status})`);
      }

      const transcriptData = await transcriptResponse.json();
      let rawText = transcriptData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      rawText = rawText.trim();

      if (!rawText) {
        if (outputEl) outputEl.innerHTML = '<span class="text-muted">No speech detected. Try again.</span>';
        // Keep the saved file — user might want to retry manually
        hideRecordingTimer();
        api.overlayError();
        isProcessingAudio = false;
        return;
      }

      let finalText = rawText;
      if (settings.aiFormatting !== false) {
        // Snippet expansion is handled inside the AI prompt so the model
        // can judge intent (deliberate sign-off vs. casual "thank you").
        finalText = await formatWithAI(rawText, mode);
      } else {
        // No AI available: conservative word-boundary expansion on the
        // raw transcript only.
        finalText = expandSnippets(finalText);
      }

      if (outputEl) {
        outputEl.innerHTML = `<span class="transcribed-text">${escapeHtml(finalText)}</span>`;
        outputEl.style.animation = 'fadeInUp 0.3s ease forwards';
      }

      if (mode === 'dictate-inject' || mode === 'command') {
        const injected = await api.injectText(finalText);
        if (injected === false) {
          showToast('Couldn\'t type into the app — text is in your clipboard, press Ctrl+V', 'error');
        }
      }

      const wordCount = finalText.split(/\s+/).filter(Boolean).length;
      await incrementStats(wordCount, getRecordingSeconds());
      await addToHistory(finalText, mode);

      // ── SUCCESS: Delete or keep the safety-saved file based on setting ──
      if (savedBaseName && !settings.keepSuccessRecordings) {
        try {
          await api.deleteFailedRecording(savedBaseName);
          await loadFailedRecordings();
        } catch (e) { /* non-critical */ }
      } else if (savedBaseName) {
        // Update metadata to mark as successful
        try {
          await api.saveFailedAudio(base64Audio, {
            timestamp: new Date().toISOString(),
            mode,
            sizeMB: audioSizeMB,
            duration,
            error: null,
            status: 'success',
            transcription: finalText.substring(0, 200),
            style: activeStyleId
          });
          await loadFailedRecordings();
        } catch (e) { /* non-critical */ }
      }

      hideRecordingTimer();
      api.overlayDone();
      showToast(`✅ ${wordCount} words transcribed (${duration}, ${audioSizeMB} MB)`, 'success');
      success = true;
      break;

    } catch (e) {
      lastError = e;
      logError(`processAudio (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, e);
      const msg = (e.message || '').toLowerCase();
      if (['api key', 'api_key', 'quota', 'permission', 'forbidden'].some(t => msg.includes(t))) break;
      if (attempt < MAX_RETRIES) {
        showToast(`Transcription failed, retrying (${attempt + 1}/${MAX_RETRIES})...`, 'error');
      }
    }
  }

  if (!success) {
    // Update the saved file's metadata with the actual error
    if (savedBaseName) {
      try {
        // Re-save with updated error info (overwrites the 'Pending' metadata)
        await api.saveFailedAudio(base64Audio, {
          timestamp: new Date().toISOString(),
          mode,
          sizeMB: audioSizeMB,
          duration,
          error: lastError?.message || 'Unknown error',
          style: activeStyleId
        });
      } catch (e) { /* already saved, non-critical */ }
    }
    if (outputEl) {
      outputEl.innerHTML = `<span style="color: var(--accent-warning)">⚠️ Transcription failed. Recording is saved safely.</span>`;
    }
    showToast('⚠️ Recording saved — retry from Dashboard', 'error');
    await loadFailedRecordings();
    api.overlayError();
  }

  isProcessingAudio = false;
  hideRecordingTimer();
}

function buildSnippetInstructions() {
  const snippets = settings.snippets || [];
  if (snippets.length === 0) return '';
  const list = snippets
    .map(s => `- Trigger: "${s.trigger}" -> Expansion: "${s.expansion}"`)
    .join('\n');
  return `\n\nThe user has personal text snippets (voice shortcuts):\n${list}\n` +
    `Snippet rules — follow them strictly:\n` +
    `1. Apply an expansion ONLY when the speaker deliberately dictated the trigger phrase as a shortcut, for example explicitly closing a formal message with a sign-off trigger.\n` +
    `2. If similar words occur naturally in speech (a casual "thank you", mentioning the phrase in passing, or talking ABOUT the snippet), leave the words exactly as spoken and do NOT expand.\n` +
    `3. Never apply an expansion because YOUR formatting introduced words resembling a trigger. Expansions may only be justified by the speaker's own words.\n` +
    `4. When in doubt, do not expand.`;
}

async function formatWithAI(rawText, mode) {
  const dictWords = (settings.dictionary || []).join(', ');
  const dictInstructions = dictWords ? `\nPreserve these custom words exactly: ${dictWords}` : '';

  // Get active style
  const style = getActiveStyle();

  // If verbatim style (no AI formatting), return raw text
  if (style.id === 'verbatim' && mode !== 'command') return rawText;

  const snippetInstructions = buildSnippetInstructions();
  const noInventions = '\nDo NOT invent content the speaker did not say: no added greetings, no added sign-offs, no added names or signatures unless the speaker dictated them or deliberately used a snippet trigger.';

  let prompt;
  if (mode === 'command') {
    prompt = `You are a text editor. The user selected text and gave a voice command. Execute the command on the text and return ONLY the result.\n\nVoice command and context: "${rawText}"\n\nReturn only the edited text.`;
  } else {
    // Use style-specific prompt
    const stylePrompt = style.prompt || 'Clean up this dictation into polished text.';
    let langNote = '';
    if (style.id === 'native') {
      langNote = '\nIMPORTANT: The output must be in English. Ensure natural, fluent English text.';
    }
    prompt = `${stylePrompt}${langNote}${noInventions}${dictInstructions}${snippetInstructions}\n\nRaw transcript: "${rawText}"\n\nReturn ONLY the formatted text, nothing else.`;
  }

  try {
    const model = getSelectedModel();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || rawText).trim();
    }
  } catch (e) {
    logError('formatWithAI', e);
  }
  return rawText; // Fallback to raw text
}

function expandSnippets(text) {
  // Fallback path (AI formatting disabled). Word-boundary match so a
  // trigger like "regards" can no longer fire from inside other words,
  // and each trigger expands at most once per dictation.
  const snippets = settings.snippets || [];
  let result = text;
  for (const s of snippets) {
    const escaped = s.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    result = result.replace(regex, s.expansion);
  }
  return result;
}

// ============================================
// Waveform Visualization
// ============================================
// Radial waveform that blooms outward from the central mic button, like
// petals of sound. Drawn on the single #waveformCanvas behind the bloom.
function drawWaveform() {
  const canvas = document.getElementById('waveformCanvas');
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const BAR_COUNT = 88;

  // Petal palette read from the active theme so it works in light + dark
  const styles = getComputedStyle(document.documentElement);
  const violet = (styles.getPropertyValue('--accent-violet') || '#A78BFA').trim();
  const pink = (styles.getPropertyValue('--accent-pink') || '#F472B6').trim();
  const amber = (styles.getPropertyValue('--accent-amber') || '#FBBF24').trim();

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    const size = canvas.clientWidth || 380;
    if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    // Inner radius sits just outside the 184px mic button
    const inner = size * 0.265;
    const maxLen = size * 0.20;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < BAR_COUNT; i++) {
      const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
      const dataIndex = Math.floor((i / BAR_COUNT) * bufferLength * 0.7);
      const value = dataArray[dataIndex] / 255;
      const len = 4 + value * maxLen;

      const x1 = cx + Math.cos(angle) * inner;
      const y1 = cy + Math.sin(angle) * inner;
      const x2 = cx + Math.cos(angle) * (inner + len);
      const y2 = cy + Math.sin(angle) * (inner + len);

      // Colour ramps violet → pink → amber around the ring
      const t = i / BAR_COUNT;
      const color = t < 0.5 ? lerpColor(violet, pink, t * 2) : lerpColor(pink, amber, (t - 0.5) * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35 + value * 0.65;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  draw();
}

// Small hex-color interpolator for the radial gradient ring
function lerpColor(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa.r + (pb.r - pa.r) * t);
  const g = Math.round(pa.g + (pb.g - pa.g) * t);
  const bl = Math.round(pa.b + (pb.b - pa.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}
function clearWaveform() {
  const canvas = document.getElementById('waveformCanvas');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ============================================
// IPC Listeners (from main process shortcuts)
// ============================================
function setupIpcListeners() {
  if (!api.onDictationStart) return;

  api.onDictationStart(async () => {
    if (!isRecording) {
      await startRecording();
    }
  });

  api.onDictationStop((mode) => {
    if (isRecording) {
      // Override the onstop to inject text
      if (mediaRecorder) {
        const originalStop = mediaRecorder.onstop;
        mediaRecorder.onstop = async () => {
          const stream = mediaRecorder.stream;
          stream.getTracks().forEach(t => t.stop());
          cancelAnimationFrame(animFrameId);
      clearWaveform();
          const btn = document.getElementById('btnMicTest');
          if (btn) btn.classList.remove('recording');
          stopRecordingTimer();
          if (audioChunks.length > 0) {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            await processAudio(audioBlob, 'dictate-inject');
          }
        };
      }
      stopRecording();
    }
  });

  api.onCommandStart(async () => {
    if (!isRecording) {
      await startRecording();
    }
  });

  if (api.onDictationCancel) {
    api.onDictationCancel(() => {
      if (isRecording) {
        if (mediaRecorder) {
          mediaRecorder.onstop = async () => {
            const stream = mediaRecorder.stream;
            stream.getTracks().forEach(t => t.stop());
            cancelAnimationFrame(animFrameId);
      clearWaveform();
            const btn = document.getElementById('btnMicTest');
            if (btn) btn.classList.remove('recording');
            stopRecordingTimer();
            // DISCARD the audio chunks entirely
            audioChunks = [];
            
            const outputEl = document.getElementById('testOutput');
            if (outputEl) outputEl.innerHTML = '<span class="text-muted">Recording discarded.</span>';
            showToast('Recording cancelled', 'info');
          };
        }
        stopRecording();
      }
    });
  }
}

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-msg">${message}</span>`;
  toast.style.animation = 'slideInRight 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease forwards';
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// ============================================
// Utilities
// ============================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================
// Dictation Styles
// ============================================
function getActiveStyle() {
  const styles = window.BUILT_IN_STYLES || [];
  return styles.find(s => s.id === activeStyleId) || styles[0] || { id: 'normal', name: 'Normal', prompt: null };
}

function renderStyleGrid() {
  const grid = document.getElementById('styleGrid');
  if (!grid) return;
  const styles = window.BUILT_IN_STYLES || [];

  let html = styles.map(s => `
    <div class="style-chip ${s.id === activeStyleId ? 'active' : ''}" onclick="selectStyle('${s.id}')">
      <span class="style-chip-icon">${s.icon}</span>
      <span class="style-chip-name">${s.name}</span>
      <span class="style-chip-color" style="background: ${s.color};"></span>
    </div>
  `).join('');

  // Add native language picker when native style is active
  const active = getActiveStyle();
  if (active.id === 'native' && active.languageOptions) {
    const currentLang = settings.nativeLanguage || active.language || 'fa';
    html += `
      <div class="native-lang-picker" style="grid-column: 1 / -1; margin-top: var(--space-sm);">
        <label class="text-sm text-secondary" style="margin-bottom: 6px; display: block;">🌐 Transcription language:</label>
        <select id="nativeLangSelect" class="select-input" onchange="setNativeLanguage(this.value)">
          ${active.languageOptions.map(l => `<option value="${l.code}" ${l.code === currentLang ? 'selected' : ''}>${l.name}</option>`).join('')}
        </select>
      </div>
    `;
  }

  grid.innerHTML = html;

  // Update badge
  const badge = document.getElementById('activeStyleBadge');
  if (badge) {
    if (active.id === 'native') {
      const lang = settings.nativeLanguage || active.language || 'fa';
      const langName = active.languageOptions?.find(l => l.code === lang)?.name || lang;
      badge.textContent = `${active.icon} ${langName}`;
    } else {
      badge.textContent = `${active.icon} ${active.name}`;
    }
  }

  // Update auto label
  const autoLabel = document.getElementById('styleAutoLabel');
  if (autoLabel) autoLabel.style.display = settings.autoStyleSwitch ? '' : 'none';

  // Update toggle
  const toggle = document.getElementById('toggleAutoStyle');
  if (toggle) toggle.checked = !!settings.autoStyleSwitch;
}

async function selectStyle(styleId) {
  activeStyleId = styleId;
  await saveSetting('activeStyle', styleId);
  renderStyleGrid();
  const style = getActiveStyle();
  showToast(`Style: ${style.icon} ${style.name}`, 'success');
}

async function detectAndApplyAutoStyle() {
  if (!settings.autoStyleSwitch) return;
  try {
    const appName = await api.getForegroundApp();
    if (!appName) return;
    lastDetectedApp = appName;

    // Check user overrides first
    const overrides = settings.styleOverrides || {};
    if (overrides[appName]) {
      activeStyleId = overrides[appName];
      renderStyleGrid();
      return;
    }

    // Check built-in map
    const map = window.APP_STYLE_MAP || {};
    const entry = map[appName];
    if (entry) {
      activeStyleId = entry.styleId;
      renderStyleGrid();
    }
  } catch (e) {
    logError('detectAndApplyAutoStyle', e);
  }
}

function renderAppRules() {
  const list = document.getElementById('appRulesList');
  if (!list) return;
  const map = window.APP_STYLE_MAP || {};
  const styles = window.BUILT_IN_STYLES || [];

  // Group by category (first 40 most popular apps)
  const popularKeys = [
    'telegram', 'whatsapp', 'discord', 'slack', 'signal',
    'outlook', 'thunderbird', 'protonmail',
    'code', 'cursor', 'devenv', 'idea64', 'sublime_text',
    'chrome', 'firefox', 'msedge', 'brave', 'arc',
    'winword', 'excel', 'powerpnt',
    'notion', 'obsidian', 'evernote',
    'twitter', 'instagram', 'linkedin', 'reddit',
    'zoom', 'teams',
    'figma', 'photoshop',
    'windowsterminal', 'powershell',
    'spotify', 'chatgpt',
    'todoist', 'linear', 'jira'
  ];

  list.innerHTML = popularKeys
    .filter(k => map[k])
    .map(k => {
      const app = map[k];
      const style = styles.find(s => s.id === app.styleId);
      const iconUrl = window.getAppIconUrl?.(app.icon, 'ffffff') || '';
      return `
        <div class="app-rule-row">
          <img class="app-rule-icon" src="${iconUrl}" alt="" onerror="this.style.display='none'">
          <span class="app-rule-name">${escapeHtml(app.name)}</span>
          <span class="app-rule-style" style="background: ${style?.color || '#666'}22; color: ${style?.color || '#999'};">${style?.icon || ''} ${style?.name || app.styleId}</span>
        </div>
      `;
    }).join('');
}

// ============================================
// Failed Recordings
// ============================================
async function loadFailedRecordings() {
  try {
    const recordings = await api.getFailedRecordings();
    renderFailedRecordings(recordings);
  } catch (e) {
    logError('loadFailedRecordings', e);
  }
}

function renderFailedRecordings(recordings) {
  const section = document.getElementById('failedRecordingsSection');
  const list = document.getElementById('failedRecordingsList');
  const badge = document.getElementById('failedCountBadge');
  if (!section || !list) return;

  if (!recordings || recordings.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  if (badge) badge.textContent = recordings.length;

  list.innerHTML = recordings.map(r => {
    const date = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'Unknown';
    const dur = r.duration || '?';
    const size = r.sizeMB || '?';
    const isSuccess = r.status === 'success';
    
    let detailsHtml = '';
    if (isSuccess) {
      const txt = r.transcription ? escapeHtml(r.transcription) + '...' : 'Saved successfully';
      detailsHtml = `<div class="failed-recording-error text-sm" style="color: var(--accent-success); margin-top: 4px;">✅ ${txt}</div>`;
    } else {
      const err = r.error ? escapeHtml(r.error).substring(0, 80) : 'Unknown error';
      detailsHtml = `<div class="failed-recording-error text-sm" style="color: var(--accent-warning); margin-top: 4px;">⚠️ ${err}</div>`;
    }

    return `
      <div class="failed-recording-item glass-card" style="border-color: ${isSuccess ? 'var(--border)' : 'rgba(255,107,107,0.3)'}">
        <div class="failed-recording-info">
          <div class="failed-recording-meta">
            <span class="tag">🎤 ${dur}</span>
            <span class="text-muted text-sm">${size} MB • ${date}</span>
          </div>
          ${detailsHtml}
        </div>
        <div class="failed-recording-actions">
          <button class="btn btn-primary btn-sm" onclick="retryFailedRecording('${escapeHtml(r.baseName)}')">${isSuccess ? 'Process Again' : 'Retry'}</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteFailedRecording('${escapeHtml(r.baseName)}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

async function retryFailedRecording(baseName) {
  const outputEl = document.getElementById('testOutput');
  if (outputEl) outputEl.innerHTML = '<span class="spinner"></span> Loading saved recording...';
  showToast('Retrying saved recording...', 'info');

  try {
    const base64Audio = await api.getFailedRecordingData(baseName + '.webm');
    if (!base64Audio) {
      showToast('Recording file not found', 'error');
      return;
    }

    // Convert base64 back to blob for processAudio
    const binaryStr = atob(base64Audio);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const audioBlob = new Blob([bytes], { type: 'audio/webm' });

    // Process the audio (will retry internally too)
    await processAudio(audioBlob, 'dictate-inject');

    // If we get here without the audio being saved again, delete the old file
    // Check if it still exists (processAudio may have re-saved on failure)
    const remaining = await api.getFailedRecordings();
    const stillExists = remaining.some(r => r.baseName === baseName);
    if (stillExists) {
      // processAudio must have succeeded before re-save, but let's check
      // Actually if processAudio failed, it saved a NEW recording, so the old one is still there
    } else {
      showToast('Recording retried — but file was already cleaned up', 'info');
    }

    // Delete the original failed recording on success
    await api.deleteFailedRecording(baseName);
    await loadFailedRecordings();
  } catch (e) {
    logError('retryFailedRecording', e);
    showToast('Retry failed: ' + e.message, 'error');
  }
}

async function deleteFailedRecording(baseName) {
  if (!confirm('Delete this saved recording? This cannot be undone.')) return;
  try {
    await api.deleteFailedRecording(baseName);
    await loadFailedRecordings();
    showToast('Recording deleted', 'info');
  } catch (e) {
    logError('deleteFailedRecording', e);
  }
}

// Make functions available globally for onclick handlers
window.removeWord = removeWord;
window.removeSnippet = removeSnippet;
window.editSnippet = editSnippet;
window.selectModel = selectModel;
async function setNativeLanguage(langCode) {
  await saveSetting('nativeLanguage', langCode);
  // Also update the style's runtime language for current session
  const style = getActiveStyle();
  if (style.id === 'native') style.language = langCode;
  renderStyleGrid();
  const langName = style.languageOptions?.find(l => l.code === langCode)?.name || langCode;
  showToast(`Language: ${langName}`, 'success');
}

window.selectStyle = selectStyle;
window.setNativeLanguage = setNativeLanguage;
window.copyHistoryItem = copyHistoryItem;
window.retryFailedRecording = retryFailedRecording;
window.deleteFailedRecording = deleteFailedRecording;

// Pure helpers exposed for the unit tests (harmless in production).
window.__freesiaTest = {
  normalizeStats,
  formatDuration,
  localDateString,
  buildSnippetInstructions,
  expandSnippets,
  setSettings: (s) => { settings = s; }
};
