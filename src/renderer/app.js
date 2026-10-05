// ==========================================================
// Freesia 3 — renderer
// ==========================================================
const api = window.freesia;
const { $, $$, h, escapeHtml, icon, isRtl, toast, dialog, confirmDialog, countUp, segmented, formatDuration, clock, bytes, kbdHtml, dayLabel, revealText } = window.UI;

// ---------------------------------------------------------- state
let settings = {};
let engineState = { engine: 'cloud', formatter: 'auto', cloud: {}, local: { models: {} }, gemini: {} };
let activeStyleId = 'normal';
let currentView = 'home';
let errorLog = [];
let updateStatus = { status: 'idle', message: 'Update checks are ready.' };

let isRecording = false;
let isStartingRecording = false;
let isStoppingRecording = false;
let isProcessingAudio = false;
let recordingSession = 0;
let mediaRecorder = null;
let audioContext = null;
let analyser = null;
let meterTimer = null;
let recordingStartTime = null;
let recordingTimer = null;
let lastOverlayLevelAt = 0;
let homeOrb = null;
let obOrb = null;
let lastOutputText = '';

const ENGINE_LABELS = { cloud: 'Freesia Cloud', local: 'On this PC', gemini: 'Google Gemini' };
const FALLBACK_ORDER = ['cloud', 'local', 'gemini'];
const TYPING_WPM = 40;
const LANGUAGES = [
  ['auto', 'Automatic'], ['en', 'English'], ['fa', 'Persian (فارسی)'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['de', 'German'],
  ['fr', 'French'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['ru', 'Russian'], ['tr', 'Turkish'], ['hi', 'Hindi'], ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'], ['th', 'Thai'], ['id', 'Indonesian'], ['sv', 'Swedish'], ['he', 'Hebrew'], ['ur', 'Urdu']
];

// ---------------------------------------------------------- errors
function logError(context, error) {
  const entry = { timestamp: new Date().toISOString(), context, message: error?.message || String(error), stack: error?.stack || '' };
  errorLog.push(entry);
  if (errorLog.length > 100) errorLog.splice(0, errorLog.length - 100);
  console.error(`[${context}]`, error);
  api.logToFile?.('ERROR', context, entry.message, entry.stack);
  api.sendErrorReport?.({ level: 'ERROR', context, message: entry.message, stack: entry.stack });
}
window.onerror = (msg, src, line, col, err) => logError('window.onerror', { message: `${msg} at ${src}:${line}:${col}`, stack: err?.stack || '' });
window.addEventListener('unhandledrejection', (e) => logError('unhandledrejection', e.reason));

async function saveSetting(key, value) {
  settings[key] = value;
  await api.setSetting(key, value);
}

// ==========================================================
// Boot
// ==========================================================
document.addEventListener('DOMContentLoaded', async () => {
  window.FreesiaAudio?.warm?.(); // the start chime plays without delay
  settings = await api.getSettings();
  applyTheme({ source: settings.theme || 'system', shouldUseDarkColors: window.matchMedia?.('(prefers-color-scheme: dark)').matches });
  activeStyleId = settings.activeStyle || 'normal';
  try { engineState = await api.engineStatus?.() || engineState; } catch (e) { logError('engineStatus', e); }

  bindChrome();
  bindOnboarding();
  bindHome();
  bindHistory();
  bindStyles();
  bindVocabulary();
  bindEngines();
  bindSettings();
  setupIpcListeners();

  showScreen(settings.onboarded ? 'screenMain' : 'screenOnboarding');
  if (!settings.onboarded) obGo(0);

  renderShortcuts();
  updateSettingsUI();
  updateDashboardStats();
  renderDictionary();
  renderSnippets();
  renderHistory();
  renderStyleGrid();
  renderAppRules();
  renderEngines();
  renderEnginePill();
  renderGreeting();
  loadFailedRecordings();
  loadStylesFromDisk();
  loadMicrophones();
  initAppMetadata();
  initTheme();
  navigator.mediaDevices?.addEventListener?.('devicechange', loadMicrophones);
  requestAnimationFrame(positionNavIndicator);
  window.addEventListener('resize', positionNavIndicator);
  if (typeof window.createBloomOrb === 'function' && $('homeOrb')?.getContext) {
    try { homeOrb = window.createBloomOrb($('homeOrb'), { palette: bloomPalette() }); } catch (e) { logError('orb', e); }
  }
  if (settings.onboarded && !settings.seenV3) setTimeout(showWhatsNew, 900);
  // After an update, people signed in to a server that collects voice
  // contributions are asked once (per version of its terms) whether to share
  if (settings.onboarded) setTimeout(() => checkContribution(), settings.seenV3 ? 1800 : 2600);
});

// One-time note for people upgrading from 2.x, who were all on Gemini
async function showWhatsNew() {
  await saveSetting('seenV3', true);
  const body = h('div.rows', {}, [
    ['cloud', 'Free, fast speech recognition', 'Freesia Cloud connects to a Freesia Voice server running Qwen3-ASR. Sign in with the account you were given.'],
    ['chip', 'Private, offline dictation', 'Download Qwen3-ASR once and it runs on your own graphics card or CPU.'],
    ['styles', 'A brand new Freesia', 'Redesigned from scratch, with command mode that finally edits your selection.']
  ].map(([ic, title, desc]) => h('div.row', {}, [h('span.engine-glyph', { html: icon(ic) }), h('span.row-text', {}, [h('span.row-title', { text: title }), h('span.row-desc', { style: { display: 'block' }, text: desc })])])));
  const go = await dialog({ title: 'Welcome to Freesia 3', text: 'You no longer need a paid Gemini key. Your key, words, snippets and history came along.', body,
    actions: [{ label: 'Later', kind: 'ghost', value: false }, { label: 'Choose an engine', kind: 'primary', value: true }] });
  if (go) showView('engines');
}

function bloomPalette() {
  const s = getComputedStyle(document.documentElement);
  return [1, 2, 3, 4].map((i) => (s.getPropertyValue(`--orb-${i}`) || '').trim()).filter(Boolean);
}

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'screenMain') requestAnimationFrame(positionNavIndicator);
}

// ==========================================================
// Navigation
// ==========================================================
function showView(name) {
  if (!$(`view${cap(name)}`)) return;
  const swap = () => {
    currentView = name;
    $$('.view').forEach((v) => {
      const on = v.dataset.view === name;
      v.classList.toggle('active', on);
      v.classList.toggle('entering', on);
    });
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    const view = $(`view${cap(name)}`);
    if (view) view.scrollTop = 0;
    $$('.stagger > *', view).forEach((el, i) => el.style.setProperty('--i', i));
    positionNavIndicator();
    if (name === 'engines') refreshEngines();
    if (name === 'history') loadFailedRecordings();
    setTimeout(() => view?.classList.remove('entering'), 900);
  };
  if (document.startViewTransition && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && currentView !== name) {
    document.startViewTransition(swap);
  } else {
    swap();
  }
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function positionNavIndicator() {
  const ind = $('navIndicator');
  const active = document.querySelector('.nav-item.active');
  if (!ind || !active || !active.offsetHeight) return;
  ind.style.height = `${active.offsetHeight}px`;
  ind.style.transform = `translateY(${active.offsetTop}px)`;
}

function bindChrome() {
  $('btnMinimize')?.addEventListener('click', () => api.minimize());
  $('btnMaximize')?.addEventListener('click', () => api.toggleMaximize?.());
  $('btnClose')?.addEventListener('click', () => api.close());
  $$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('enginePill')?.addEventListener('click', () => showView('engines'));
  // Ctrl+1..6 jumps between views
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || shortcutRecorder) return;
    const n = Number(e.key);
    const items = $$('.nav-item[data-view]');
    if (n >= 1 && n <= items.length && $('screenMain').classList.contains('active')) { e.preventDefault(); showView(items[n - 1].dataset.view); }
  });
}

// ==========================================================
// Theme
// ==========================================================
function applyTheme(info = {}) {
  const source = info.source || settings.theme || 'system';
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  const dark = source === 'dark' || (source === 'system' && (info.shouldUseDarkColors ?? prefersDark));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeSource = source;
  homeOrb?.setPalette(bloomPalette());
  obOrb?.setPalette(bloomPalette());
  themeSeg?.set(source, true);
}

async function initTheme() {
  try { const info = await api.getThemeInfo?.(); if (info) applyTheme(info); } catch (e) { logError('initTheme', e); }
  api.onThemeUpdated?.((info) => applyTheme(info));
}

async function setTheme(source) {
  settings.theme = source;
  applyTheme({ source, shouldUseDarkColors: window.matchMedia?.('(prefers-color-scheme: dark)').matches });
  try { const info = await api.setAppTheme?.(source); if (info) applyTheme(info); } catch (e) { logError('setTheme', e); await saveSetting('theme', source); }
}

// ==========================================================
// Onboarding
// ==========================================================
let obStep = 0;
let obEngine = 'cloud';
let obMicStream = null;
let obMeterTimer = null;

function bindOnboarding() {
  $$('[data-ob-next]').forEach((b) => b.addEventListener('click', () => obGo(obStep + 1)));
  $$('[data-ob-back]').forEach((b) => b.addEventListener('click', () => obGo(obStep - 1)));
  $$('[data-ob-skip]').forEach((b) => b.addEventListener('click', () => obGo(obStep + 1)));
  $$('#obEngineChoices .choice').forEach((c) => c.addEventListener('click', () => {
    obEngine = c.dataset.engine;
    $$('#obEngineChoices .choice').forEach((x) => x.classList.toggle('selected', x === c));
    renderObEngineForm();
  }));
  $('obEngineNext')?.addEventListener('click', obEngineContinue);
  $('btnFinish')?.addEventListener('click', finishOnboarding);
  $('obPractice')?.addEventListener('input', (e) => e.target.classList.toggle('got', !!e.target.value.trim()));
  $('onboardingErrorReporting')?.addEventListener('change', (e) => {
    saveSetting('errorReporting', e.target.checked);
    if ($('toggleErrorReporting')) $('toggleErrorReporting').checked = e.target.checked;
  });
  $('obMic')?.addEventListener('change', (e) => { saveSetting('microphoneId', e.target.value); startObMeter(); });
}

function obGo(step) {
  step = Math.max(0, Math.min(3, step));
  const steps = $$('.ob-step');
  steps.forEach((s) => {
    const n = Number(s.dataset.step);
    s.classList.toggle('leaving', n < step);
    s.classList.toggle('active', n === step);
  });
  $$('#obDots i').forEach((d, i) => d.classList.toggle('on', i === step));
  obStep = step;
  if (!obOrb && typeof window.createBloomOrb === 'function' && $('obOrb')?.getContext) {
    try { obOrb = window.createBloomOrb($('obOrb'), { palette: bloomPalette(), scale: 0.26 }); } catch (e) { logError('orb', e); }
  }
  obOrb?.setState(step === 3 ? 'done' : 'idle');
  if (step === 1) renderObEngineForm();
  if (step === 2) startObMeter(); else stopObMeter();
  if (step === 3) { renderShortcuts(); $('obPractice')?.focus(); }
}

function renderObEngineForm() {
  const host = $('obEngineForm');
  if (!host) return;
  host.replaceChildren();
  if (obEngine === 'cloud') {
    if (engineState.cloud?.configured) {
      host.append(h('p.hint', { html: `${icon('check')} Signed in as <b>${escapeHtml(engineState.cloud.username)}</b>.` }));
      return;
    }
    host.append(cloudLoginForm(async () => { renderObEngineForm(); }));
  } else if (obEngine === 'local') {
    host.append(localInstallBlock(true));
  } else {
    host.append(geminiKeyForm(() => renderObEngineForm()));
  }
}

async function obEngineContinue() {
  await setEngine(obEngine, true);
  obGo(2);
}

async function startObMeter() {
  stopObMeter();
  await loadMicrophones();
  const meter = window.FreesiaAudio?.createMeter($('obMeter'), 26);
  try {
    obMicStream = await openMicrophoneStream();
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(obMicStream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const m = window.createAudioMeter();
    obMeterTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const level = m.sample(buf);
      meter.set(level);
      obOrb?.setLevel(level);
      obOrb?.setState(level > 0.05 ? 'listening' : 'idle');
    }, 50);
    obMicStream._ctx = ctx;
  } catch (e) {
    toast(micErrorMessage(e), 'error');
  }
}

function stopObMeter() {
  clearInterval(obMeterTimer);
  obMeterTimer = null;
  if (obMicStream) {
    obMicStream.getTracks().forEach((t) => t.stop());
    obMicStream._ctx?.close().catch(() => {});
    obMicStream = null;
  }
}

async function finishOnboarding() {
  stopObMeter();
  await saveSetting('onboarded', true);
  await saveSetting('seenV3', true);
  showScreen('screenMain');
  showView('home');
  toast('Welcome to Freesia', 'success');
  homeOrb?.setState('done');
  setTimeout(() => homeOrb?.setState('idle'), 1400);
  setTimeout(() => checkContribution(), 2200);
}

// ==========================================================
// Home
// ==========================================================
function bindHome() {
  $('orbButton')?.addEventListener('click', () => {
    if (isProcessingAudio) return;
    if (isRecording || isStartingRecording) stopRecording();
    else startRecording('test');
  });
  $('btnCopyOutput')?.addEventListener('click', async () => {
    if (!lastOutputText) return;
    await api.copyText(lastOutputText);
    toast('Copied', 'success');
  });
  $('homeStyleChip')?.addEventListener('click', () => showView('styles'));
  $('btnReviewRecoveries')?.addEventListener('click', () => showView('history'));
  $('btnSetupEngine')?.addEventListener('click', () => showView('engines'));
  $('btnHomeUpdate')?.addEventListener('click', () => {
    if (updateStatus.status === 'available') return downloadUpdate();
    if (updateStatus.status === 'downloaded') return installUpdate();
    return checkForUpdates();
  });
}

function renderGreeting() {
  const hr = new Date().getHours();
  const part = hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const el = $('homeGreeting');
  if (el) el.textContent = `${part} · ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`;
}

function setOutput(state, text = '', meta = []) {
  const out = $('testOutput');
  if (!out) return;
  out.classList.toggle('is-error', state === 'error');
  out.classList.toggle('is-working', state === 'working');
  if (state === 'text') {
    lastOutputText = text;
    revealText(out, text);
    $('btnCopyOutput').disabled = false;
  } else if (state === 'working') {
    out.innerHTML = `<span class="shimmer-text">${escapeHtml(text)}</span>`;
  } else if (state === 'error') {
    out.innerHTML = `${escapeHtml(text)}`;
  } else {
    out.innerHTML = '<span class="placeholder">Your words will bloom here.</span>';
  }
  const metaEl = $('outputMeta');
  if (metaEl) metaEl.innerHTML = meta.map((m) => `<span class="pill-tag ${m.kind || ''}">${escapeHtml(m.text)}</span>`).join('');
}

function setOrbCaption(text) {
  const el = $('orbCaption');
  if (el) el.textContent = text;
}

// ---------------------------------------------------------- stats
function localDateString(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function emptyDayStats(date) { return { date, words: 0, sessions: 0, recordSec: 0, savedSec: 0 }; }

function normalizeStats(raw) {
  const today = localDateString();
  if (!raw) {
    return { today: emptyDayStats(today), lifetime: { words: 0, sessions: 0, recordSec: 0, savedSec: 0 }, streak: { current: 0, best: 0, lastDate: '' }, days: {} };
  }
  if (raw.wordsToday !== undefined || !raw.lifetime) {
    const words = raw.wordsToday || 0;
    const sessions = raw.sessions || 0;
    const savedSec = (raw.timeSaved || 0) * 60;
    const isToday = raw.lastDate === today;
    return {
      today: isToday ? { date: today, words, sessions, recordSec: 0, savedSec } : emptyDayStats(today),
      lifetime: { words, sessions, recordSec: 0, savedSec },
      streak: { current: raw.lastDate ? 1 : 0, best: raw.lastDate ? 1 : 0, lastDate: raw.lastDate || '' },
      days: raw.lastDate ? { [raw.lastDate]: words } : {}
    };
  }
  if (raw.today?.date !== today) raw.today = emptyDayStats(today);
  if (!raw.days) raw.days = {};
  // A streak survives only if the last dictation was today or yesterday
  const yesterday = localDateString(new Date(Date.now() - 86400000));
  if (raw.streak && raw.streak.lastDate && raw.streak.lastDate !== today && raw.streak.lastDate !== yesterday) raw.streak.current = 0;
  return raw;
}

function updateDashboardStats() {
  const stats = normalizeStats(settings.stats);
  settings.stats = stats;
  countUp($('statWords'), stats.today.words);
  const t = $('statTime'); if (t) t.textContent = formatDuration(stats.today.savedSec);
  countUp($('statStreak'), stats.streak.current);
  countUp($('statSessions'), stats.today.sessions);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('statWordsAll', `${stats.lifetime.words.toLocaleString()} all time`);
  set('statTimeAll', `${formatDuration(stats.lifetime.savedSec)} all time`);
  set('statStreakBest', `best ${stats.streak.best}`);
  set('statAvg', `${stats.lifetime.sessions ? Math.round(stats.lifetime.words / stats.lifetime.sessions) : 0} words avg`);
  renderActivity(stats);
}

function renderActivity(stats) {
  const host = $('activity');
  if (!host) return;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = localDateString(d);
    days.push({ key, d, words: stats.days?.[key] || (key === stats.today.date ? stats.today.words : 0) });
  }
  const max = Math.max(1, ...days.map((d) => d.words));
  host.replaceChildren(...days.map((d, i) => {
    const bar = h('span.activity-bar', {
      class: `activity-bar${d.words ? ' has' : ''}${i === 29 ? ' today' : ''}`,
      'data-tip': `${d.d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.words.toLocaleString()} words`
    });
    requestAnimationFrame(() => setTimeout(() => { bar.style.height = `${d.words ? Math.max(8, (d.words / max) * 100) : 5}%`; }, i * 14));
    return bar;
  }));
  const total = days.reduce((s, d) => s + d.words, 0);
  const tot = $('activityTotal'); if (tot) tot.textContent = `${total.toLocaleString()} words`;
  const start = $('activityStart'); if (start) start.textContent = days[0].d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function incrementStats(wordCount, recordSeconds = 0) {
  const stats = normalizeStats(settings.stats);
  const today = localDateString();
  const savedSec = Math.max(0, (wordCount / TYPING_WPM) * 60 - recordSeconds);
  for (const bucket of [stats.today, stats.lifetime]) {
    bucket.words += wordCount; bucket.sessions += 1; bucket.recordSec += recordSeconds; bucket.savedSec += savedSec;
  }
  stats.days[today] = (stats.days[today] || 0) + wordCount;
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 90) delete stats.days[keys.shift()];
  if (stats.streak.lastDate !== today) {
    const yesterday = localDateString(new Date(Date.now() - 86400000));
    stats.streak.current = stats.streak.lastDate === yesterday ? stats.streak.current + 1 : 1;
    stats.streak.best = Math.max(stats.streak.best, stats.streak.current);
    stats.streak.lastDate = today;
  }
  await saveSetting('stats', stats);
  updateDashboardStats();
}

// ==========================================================
// Microphone
// ==========================================================
function buildAudioConstraints(deviceId) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

async function loadMicrophones() {
  const selects = [$('selectMicrophone'), $('obMic')].filter(Boolean);
  if (!selects.length || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const selectedId = settings.microphoneId || '';
    const available = !selectedId || devices.some((d) => d.deviceId === selectedId);
    for (const select of selects) {
      select.replaceChildren(new Option('Windows default', ''));
      devices.forEach((d, i) => select.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
      if (!available) select.add(new Option('Previous microphone (unplugged)', selectedId));
      select.value = selectedId;
    }
  } catch (e) {
    logError('loadMicrophones', e);
  }
}

// The microphone stays open for a while after a dictation (Settings → "Keep the
// microphone ready"): opening it can take half a second or more on a laptop,
// and words spoken in that time were lost.
const MIC_READY_MS = 120000;
let readyMic = null; // { stream, deviceId, timer }

function closeReadyMic() {
  if (!readyMic) return;
  clearTimeout(readyMic.timer);
  readyMic.stream.getTracks().forEach((t) => t.stop());
  readyMic = null;
}

function releaseMicrophone(stream) {
  const live = stream?.getAudioTracks?.().length && stream.getAudioTracks().every((t) => t.readyState === 'live');
  if (settings.keepMicReady === false || !live) { stream?.getTracks().forEach((t) => t.stop()); return; }
  if (readyMic && readyMic.stream !== stream) closeReadyMic();
  clearTimeout(readyMic?.timer);
  readyMic = { stream, deviceId: settings.microphoneId || '', timer: setTimeout(closeReadyMic, MIC_READY_MS) };
}

async function openMicrophoneStream() {
  const selectedId = settings.microphoneId || '';
  if (readyMic) {
    const r = readyMic;
    if (r.deviceId === selectedId && r.stream.getAudioTracks().every((t) => t.readyState === 'live')) {
      clearTimeout(r.timer);
      readyMic = null;
      return r.stream;
    }
    closeReadyMic();
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints(selectedId) });
  } catch (e) {
    const unavailable = selectedId && ['NotFoundError', 'OverconstrainedError'].includes(e?.name);
    if (!unavailable) throw e;
    await saveSetting('microphoneId', '');
    loadMicrophones();
    toast('Your selected microphone is unplugged. Using the Windows default.', 'info');
    return navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints('') });
  }
}

function micErrorMessage(e) {
  if (e?.name === 'NotFoundError') return 'No microphone found. Plug one in and try again.';
  if (e?.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it in Windows Settings → Privacy → Microphone.';
  if (e?.name === 'NotReadableError') return 'Another app is using the microphone exclusively.';
  return 'Could not start the microphone.';
}

// ==========================================================
// Recording
// ==========================================================
function startTimer() {
  recordingStartTime = Date.now();
  const el = $('recordingTime');
  if (el) el.textContent = '0:00';
  recordingTimer = setInterval(() => {
    const t = clock((Date.now() - recordingStartTime) / 1000);
    if (el) el.textContent = t;
    api.overlayTimer?.(t);
  }, 250);
}
function stopTimer() { clearInterval(recordingTimer); recordingTimer = null; }
function recordingSeconds() { return recordingStartTime ? Math.max(0, (Date.now() - recordingStartTime) / 1000) : 0; }

let pendingSelection = '';

async function startRecording(mode = 'dictate-inject', { selection = '' } = {}) {
  if (isProcessingAudio || isRecording || isStartingRecording || isStoppingRecording) return;
  mediaRecorder = null;
  isStartingRecording = true;
  pendingSelection = selection;
  api.recordingState?.('recording');
  const session = ++recordingSession;
  let stream;
  try {
    const styleReady = mode === 'test' ? Promise.resolve() : detectAndApplyAutoStyle();
    const opening = performance.now();
    stream = await openMicrophoneStream();
    if (session !== recordingSession) { stream.getTracks().forEach((t) => t.stop()); return; }

    // Record first, everything else after: the chime, the timer and the level meter
    // (a new AudioContext alone can take hundreds of ms on a laptop) used to come
    // before the recorder started, so the first words were cut off.
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    mediaRecorder = recorder;
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      releaseMicrophone(stream);
      clearInterval(meterTimer);
      api.overlayAudioLevel?.(0);
      stopTimer();
      document.body.classList.remove('is-recording');
      const icn2 = $('orbIcon'); if (icn2) icn2.innerHTML = '<use href="#i-mic"/>';
      try {
        if (recorder.discard || !chunks.length) {
          api.recordingState?.('idle');
          api.overlayHide?.();
          homeOrb?.setState('idle');
          setOrbCaption('Tap the bloom to try it here');
          if (recorder.discard && chunks.length) await keepCancelledRecording(new Blob(chunks, { type: 'audio/webm' }), mode, recordingSeconds());
          return;
        }
        if (settings.sounds !== false) window.FreesiaAudio?.chime('stop');
        await styleReady;
        await processAudio(new Blob(chunks, { type: 'audio/webm' }), mode, { selection: pendingSelection, durationSec: recordingSeconds() });
      } catch (error) {
        logError('recording:stop', error);
        api.recordingFailed?.('Something went wrong');
      } finally {
        isStoppingRecording = false;
        recordingStartTime = null;
      }
    };
    // 1 s slices: a crash loses at most a second of audio
    recorder.start(1000);
    isRecording = true;
    startTimer();
    api.recordingLive?.();
    if (settings.sounds !== false) window.FreesiaAudio?.chime('start');
    api.logToFile?.('INFO', 'recording', `Recording started ${Math.round(performance.now() - opening)} ms after the microphone was requested`);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (!isRecording) return;
      toast('Microphone disconnected. Transcribing what was captured.', 'info');
      stopRecording();
    });
    document.body.classList.add('is-recording');
    loadMicrophones();
    homeOrb?.setState('listening');
    setOrbCaption(mode === 'test' ? 'Listening… tap to finish' : mode === 'command' ? 'Listening for your edit…' : 'Listening… press the shortcut again to finish');
    const icn = $('orbIcon'); if (icn) icn.innerHTML = '<use href="#i-stop"/>';

    // The level meter: only the visuals wait for it now
    try {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      await audioContext.resume();
      if (session === recordingSession && isRecording) runMeter();
    } catch (meterError) {
      if (session === recordingSession && isRecording) logError('recording:meter', meterError);
    }
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    if (session !== recordingSession) return;
    clearInterval(meterTimer);
    audioContext?.close().catch(() => {});
    audioContext = null;
    analyser = null;
    document.body.classList.remove('is-recording');
    homeOrb?.setState('error');
    setTimeout(() => homeOrb?.setState('idle'), 1200);
    api.overlayAudioLevel?.(0);
    logError('startRecording', e);
    const msg = micErrorMessage(e);
    toast(msg, 'error');
    setOrbCaption(msg);
    stopTimer();
    isRecording = false;
    if (settings.sounds !== false) window.FreesiaAudio?.chime('error');
    api.recordingFailed?.(msg);
  } finally {
    if (session === recordingSession) isStartingRecording = false;
  }
}

function runMeter() {
  const buf = new Float32Array(analyser.fftSize);
  const meter = window.createAudioMeter();
  clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buf);
    const level = meter.sample(buf);
    homeOrb?.setLevel(level);
    const now = performance.now();
    if (now - lastOverlayLevelAt >= 35) { api.overlayAudioLevel?.(level); lastOverlayLevelAt = now; }
  }, 33);
}

function stopRecording(discard = false) {
  ++recordingSession;
  isStartingRecording = false;
  isRecording = false;
  clearInterval(meterTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    isStoppingRecording = true;
    mediaRecorder.discard = discard;
    api.recordingState?.(discard ? 'idle' : 'processing');
    mediaRecorder.stop();
  } else {
    api.recordingState?.('idle');
    api.overlayHide?.();
    stopTimer();
    document.body.classList.remove('is-recording');
    homeOrb?.setState('idle');
  }
  audioContext?.close().catch(() => {});
  audioContext = null;
  analyser = null;
  api.overlayAudioLevel?.(0);
}

// ==========================================================
// Transcription pipeline
// ==========================================================
function isEngineReady(id, state = engineState) {
  if (id === 'cloud') return !!state.cloud?.configured;
  if (id === 'local') return !!state.local?.configured;
  if (id === 'gemini') return !!state.gemini?.configured;
  return false;
}

// Primary engine first; then, if allowed, every other engine that is set up.
function engineOrder(state = engineState, fallback = settings.engineFallback !== false) {
  const primary = state.engine || 'cloud';
  const order = [primary];
  if (fallback) for (const id of FALLBACK_ORDER) if (id !== primary && isEngineReady(id, state)) order.push(id);
  return order;
}

function pickFormatter(state = engineState) {
  const f = state.formatter || 'auto';
  if (f === 'off') return null;
  if (f === 'cloud') return isEngineReady('cloud', state) ? 'cloud' : null;
  if (f === 'gemini') return isEngineReady('gemini', state) ? 'gemini' : null;
  return isEngineReady('cloud', state) ? 'cloud' : isEngineReady('gemini', state) ? 'gemini' : null;
}

function spokenLanguage(style = getActiveStyle()) {
  if (style.id === 'native') return settings.nativeLanguage || style.language || 'fa';
  return settings.language || 'auto';
}

function languageName(code) {
  return (LANGUAGES.find(([c]) => c === code)?.[1] || code).replace(/\s*\(.*\)$/, '');
}

function geminiInstruction(style = getActiveStyle()) {
  const lang = spokenLanguage(style);
  if (style.id === 'native') {
    return `The user is speaking ${languageName(lang)}. Transcribe their speech and translate it into fluent, natural English. Do NOT drop any meaning. Do NOT summarize. Return ONLY the English translation.`;
  }
  const words = (settings.dictionary || []).join(', ');
  return `Transcribe this audio exactly${lang !== 'auto' ? ` (language: ${languageName(lang)})` : ''}.${words ? ` These names and terms may appear: ${words}.` : ''} Return ONLY the transcribed text.`;
}

async function processAudio(audioBlob, mode, { existingBase = null, selection = '', durationSec = 0 } = {}) {
  if (isProcessingAudio) return;
  isProcessingAudio = true;
  api.recordingState?.('processing');
  homeOrb?.setState('processing');
  setOrbCaption('Transcribing…');
  setOutput('working', 'Saving your recording…');
  const style = getActiveStyle();
  const audio = await audioBlob.arrayBuffer();
  const sizeMB = (audio.byteLength / 1048576).toFixed(1);
  const duration = durationSec ? clock(durationSec) : '';

  // 1. Save first so nothing is ever lost
  let savedBase = existingBase;
  try {
    savedBase = await api.saveFailedAudio(existingBase ? null : audio, {
      timestamp: new Date().toISOString(), mode, sizeMB, duration, durationSec, error: 'Pending transcription', style: style.id
    }, existingBase);
  } catch (e) {
    logError('processAudio:safetySave', e);
  }

  // 2. Transcribe, falling back between engines
  const order = engineOrder();
  let result = null;
  const failures = [];
  let wavCache = null;
  for (const id of order) {
    if (!isEngineReady(id)) { failures.push({ engine: id, code: 'config', message: `${ENGINE_LABELS[id]} is not set up` }); continue; }
    setOutput('working', `Transcribing${duration ? ` ${duration}` : ''} with ${ENGINE_LABELS[id]}…`);
    api.overlayProgress?.({ label: ENGINE_LABELS[id] });
    try {
      const payload = { engine: id, audio, mime: 'audio/webm', language: spokenLanguage(style), prompt: (settings.dictionary || []).join(', '), durationSec };
      if (id === 'local') {
        wavCache = wavCache || await window.FreesiaAudio.toWav16k(audioBlob);
        payload.wav = wavCache.wav;
        payload.durationSec = wavCache.durationSec;
      }
      if (id === 'gemini') payload.instruction = geminiInstruction(style);
      // Speak another language, get English: the server translates with a dedicated model
      if (id === 'cloud' && style.id === 'native' && mode !== 'command') payload.task = 'translate';
      const res = await api.transcribe(payload);
      if (res?.error) { failures.push({ engine: id, ...res.error }); if (res.error.code === 'audio') break; continue; }
      result = res;
      break;
    } catch (e) {
      failures.push({ engine: id, code: 'audio', message: e.message });
      logError(`processAudio:${id}`, e);
    }
  }

  if (!result) {
    const last = failures.filter((f) => f.code !== 'config').pop() || failures[0] || { message: 'No engine is set up' };
    const summary = failures.map((f) => `${ENGINE_LABELS[f.engine] || f.engine}: ${f.message}`).join(' · ');
    if (savedBase) {
      try {
        await api.saveFailedAudio(null, { timestamp: new Date().toISOString(), mode, sizeMB, duration, durationSec, error: summary, style: style.id }, savedBase);
      } catch { /* already saved */ }
    }
    logError('processAudio', new Error(summary));
    finishWithError(last.code === 'config' && failures.every((f) => f.code === 'config')
      ? 'Set up a transcription engine first.'
      : `${last.message}${savedBase ? ' Your recording is saved in History.' : ''}`, last.code === 'config');
    loadFailedRecordings();
    return;
  }

  const raw = applyVocabulary(String(result.text || '').trim());
  if (!raw) {
    if (savedBase) {
      if (durationSec && durationSec < 4) await api.deleteFailedRecording(savedBase).catch(() => {});
      else await api.saveFailedAudio(null, { timestamp: new Date().toISOString(), mode, sizeMB, duration, durationSec, error: 'No speech detected', style: style.id }, savedBase).catch(() => {});
    }
    finishWithError('No speech detected. Try again a little closer to the mic.');
    loadFailedRecordings();
    return;
  }

  // 3. Format with the chosen style
  setOutput('working', 'Shaping your words…');
  api.overlayProgress?.({ label: 'Formatting' });
  const formatted = await formatText(raw, mode, { selection, engineUsed: result.engine, translated: !!result.translated });
  // Second pass: the formatter may reintroduce a spelling the speech model produced
  const finalText = applyVocabulary(formatted.text);

  // 4. Deliver
  let delivered = 'shown';
  if (mode === 'dictate-inject' || mode === 'command') {
    const ok = await api.injectText(finalText);
    delivered = ok === false ? 'clipboard' : 'typed';
    if (ok === false) toast('Could not type into that app. The text is on your clipboard: press Ctrl+V.', 'error', 5000);
  } else if (mode === 'retry') {
    await api.copyText(finalText);
    delivered = 'clipboard';
  }

  const words = finalText.split(/\s+/).filter(Boolean).length;
  setOutput('text', finalText, [
    { text: ENGINE_LABELS[result.engine] || result.engine },
    result.model ? { text: result.model } : null,
    duration ? { text: duration } : null,
    { text: `${words} words` },
    formatted.formatter ? { text: `${style.icon} ${style.name}` } : null,
    delivered === 'clipboard' ? { text: 'On clipboard', kind: 'warn' } : null,
    order[0] !== result.engine ? { text: 'Fallback', kind: 'warn' } : null
  ].filter(Boolean));

  try {
    await incrementStats(words, durationSec);
    await addToHistory({ text: finalText, mode, engine: result.engine, durationSec, words, style: style.id });
  } catch (e) {
    logError('processAudio:history', e);
  }

  if (savedBase && !settings.keepSuccessRecordings) {
    await api.deleteFailedRecording(savedBase).catch(() => {});
  } else if (savedBase) {
    await api.saveFailedAudio(null, { timestamp: new Date().toISOString(), mode, sizeMB, duration, durationSec, error: null, status: 'success', transcription: finalText.slice(0, 200), style: style.id }, savedBase).catch(() => {});
  }
  loadFailedRecordings();

  api.overlayDone?.({ words, label: delivered === 'clipboard' ? 'Copied: press Ctrl+V' : `${words} words` });
  homeOrb?.setState('done');
  setOrbCaption(mode === 'retry' ? 'Recovered and copied to your clipboard' : 'Done. Tap to go again');
  setTimeout(() => { if (homeOrb?.state === 'done') homeOrb.setState('idle'); }, 1500);
  if (mode === 'retry') toast('Recovered. The text is on your clipboard.', 'success');
  isProcessingAudio = false;
}

function finishWithError(message, setup = false) {
  setOutput('error', message);
  setOrbCaption(message);
  homeOrb?.setState('error');
  setTimeout(() => homeOrb?.setState('idle'), 1400);
  api.overlayError?.(message);
  if (settings.sounds !== false) window.FreesiaAudio?.chime('error');
  toast(message, 'error', 5000);
  if (setup) $('setupBanner')?.removeAttribute('hidden');
  isProcessingAudio = false;
}

// ---------------------------------------------------------- vocabulary
function applyVocabulary(text) {
  try { return window.FreesiaVocab ? window.FreesiaVocab.apply(text, settings.dictionary || [], settings.corrections || []) : text; }
  catch (e) { logError('applyVocabulary', e); return text; }
}

// "Teach Freesia": the user marks what was written and what they said.
// The correction applies to every future dictation, and the right term also
// becomes a vocabulary hint for the speech model.
async function teachCorrection({ from = '', to = '', historyId = null } = {}) {
  const body = h('div', {}, [
    h('p.hint', { text: 'Freesia will fix this automatically from now on, and the correct term becomes a hint for the speech model.' }),
    h('div.field.mt-12', {}, [h('label', { text: 'Freesia wrote' }), h('input.input', { id: 'teachFrom', value: from, maxlength: 80, placeholder: 'cloud opus', spellcheck: 'false' })]),
    h('div.field', {}, [h('label', { text: 'I actually said' }), h('input.input', { id: 'teachTo', value: to, maxlength: 80, placeholder: 'Claude Opus', spellcheck: 'false', list: 'teachTerms' }),
      h('datalist', { id: 'teachTerms' }, (settings.dictionary || []).map((w) => h('option', { value: w })))])
  ]);
  let values = null;
  const ok = await dialog({
    title: 'Teach a correction', body,
    actions: [{ label: 'Cancel', kind: 'ghost', value: false }, {
      label: 'Save correction', kind: 'primary', value: true,
      validate: (box) => {
        const f = box.querySelector('#teachFrom').value.trim();
        const t = box.querySelector('#teachTo').value.trim();
        if (!f || !t || f.toLowerCase() === t.toLowerCase()) { toast('Fill in both, and make them different', 'error'); return false; }
        values = { from: f, to: t };
        return true;
      }
    }]
  });
  if (!ok || !values) return;
  const list = (settings.corrections || []).filter((c) => c.from.toLowerCase() !== values.from.toLowerCase());
  list.push(values);
  await saveSetting('corrections', list);
  const dict = settings.dictionary || [];
  if (!dict.some((d) => d.toLowerCase() === values.to.toLowerCase())) { dict.push(values.to); await saveSetting('dictionary', dict); }
  if (historyId != null) {
    const hist = settings.history || [];
    const item = hist.find((x) => String(x.id) === String(historyId));
    if (item) { item.text = applyVocabulary(item.text); await saveSetting('history', hist); }
  }
  renderDictionary();
  renderCorrections();
  renderHistory();
  toast(`Learned: “${values.from}” → “${values.to}”`, 'success');
}

async function removeCorrection(from) {
  await saveSetting('corrections', (settings.corrections || []).filter((c) => c.from !== from));
  renderCorrections();
}

function renderCorrections() {
  const list = $('correctionList');
  if (!list) return;
  const items = settings.corrections || [];
  list.replaceChildren(...(items.length ? items.map((c) => h('span.chip', {}, [
    h('span', { class: 'muted', text: c.from }), h('span', { class: 'snippet-arrow', text: '→' }), h('b', { text: c.to }),
    h('button.x', { title: 'Forget this correction', html: icon('x'), onclick: () => removeCorrection(c.from) })
  ])) : [h('span.hint', { text: 'None yet. Use “Fix a word” on any History item, or the button above.' })]));
}

// ---------------------------------------------------------- formatting
function buildSnippetInstructions() {
  const snippets = settings.snippets || [];
  if (snippets.length === 0) return '';
  const list = snippets.map((s) => `- Trigger: "${s.trigger}" -> Expansion: "${s.expansion}"`).join('\n');
  return `\n\nThe user has personal text snippets (voice shortcuts):\n${list}\n` +
    'Snippet rules — follow them strictly:\n' +
    '1. Apply an expansion ONLY when the speaker deliberately dictated the trigger phrase as a shortcut, for example explicitly closing a formal message with a sign-off trigger.\n' +
    '2. If similar words occur naturally in speech (a casual "thank you", mentioning the phrase in passing, or talking ABOUT the snippet), leave the words exactly as spoken and do NOT expand.\n' +
    '3. Never apply an expansion because YOUR formatting introduced words resembling a trigger. Expansions may only be justified by the speaker\'s own words.\n' +
    '4. When in doubt, do not expand.';
}

function anyToolEnabled() {
  return !!(settings.toolTrimSpelling || settings.toolSpokenEmoji || settings.toolPolish);
}

function buildToolInstructions() {
  const parts = [];
  if (settings.toolTrimSpelling) parts.push('SPELLING CLEANUP: When the speaker says a word or name and then spells it out letter by letter (for example "Arash Ahmadi, A R A S H A H M A D I" or "A-R-A-S-H"), use the spelling ONLY to get that word right, then REMOVE the spelled-out letters. Never leave the individual letters in the text.');
  if (settings.toolSpokenEmoji) parts.push('SPOKEN EMOJI: When the speaker names an emoji (for example "smiley face", "heart emoji", "thumbs up", "fire emoji"), replace that phrase with the emoji character (🙂, ❤️, 👍, 🔥, etc.). Only replace clear emoji references, not ordinary words.');
  if (settings.toolPolish) parts.push('POLISH & REPHRASE: The speech may be rough, with false starts, repetitions, or grammatical errors. Rewrite it into clear, natural writing while preserving the speaker\'s meaning, intent, and key details exactly. Do not add new information.');
  if (parts.length === 0) return '';
  return '\n\nEnabled tools — apply all of these:\n- ' + parts.join('\n- ');
}

function buildFormatPrompt(rawText, mode, { selection = '', style = getActiveStyle() } = {}) {
  const dictWords = (settings.dictionary || []).join(', ');
  const dictInstructions = dictWords ? `\nPreserve these custom words exactly: ${dictWords}` : '';
  if (mode === 'command') {
    if (selection) {
      return `You are a precise text editor. The user selected some text and spoke an instruction for changing it.\n\nSelected text:\n"""\n${selection}\n"""\n\nSpoken instruction: "${rawText}"\n\nApply the instruction to the selected text.${dictInstructions}\nReturn ONLY the resulting text, with no quotes, labels or commentary.`;
    }
    return `The user spoke an instruction asking you to write something. Instruction: "${rawText}"${dictInstructions}\nWrite exactly what was requested. Return ONLY that text, with no commentary.`;
  }
  const toolInstructions = buildToolInstructions();
  const stylePrompt = style.id === 'verbatim'
    ? 'Return the dictation exactly as spoken, changing nothing except what the enabled tools below require.'
    : (style.prompt || 'Clean up this dictation into polished text.');
  const langNote = style.id === 'native' ? '\nIMPORTANT: The transcript may be in another language. The output must be fluent, natural English that keeps every idea.' : '';
  const noInventions = '\nDo NOT invent content the speaker did not say: no added greetings, sign-offs, names or signatures unless the speaker dictated them or deliberately used a snippet trigger. Never answer questions in the transcript; just format them.';
  return `${stylePrompt}${langNote}${noInventions}${dictInstructions}${buildSnippetInstructions()}${toolInstructions}\n\nRaw transcript: "${rawText}"\n\nReturn ONLY the formatted text, nothing else.`;
}

async function formatText(rawText, mode, { selection = '', engineUsed = '', translated = false } = {}) {
  const style = getActiveStyle();
  const formatter = settings.aiFormatting === false && mode !== 'command' ? null : pickFormatter();
  const needsModel = mode === 'command' || style.id !== 'verbatim' || anyToolEnabled();
  // Gemini already translated native speech during transcription
  if (!needsModel) return { text: rawText, formatter: null };
  if (!formatter) {
    return { text: mode === 'command' ? rawText : expandSnippets(rawText), formatter: null };
  }
  // Already translated into English (Gemini, or the cloud translation model)
  if (style.id === 'native' && (engineUsed === 'gemini' || translated) && !anyToolEnabled() && mode !== 'command') {
    return { text: rawText, formatter: null };
  }
  const prompt = buildFormatPrompt(rawText, mode, { selection, style });
  try {
    const res = await api.format({ engine: formatter, prompt, temperature: 0.2 });
    if (res?.text) return { text: stripWrapping(res.text, rawText), formatter };
    if (res?.error) logError('formatText', new Error(`${formatter}: ${res.error.message}`));
  } catch (e) {
    logError('formatText', e);
  }
  // Formatting failed: never lose the words
  return { text: mode === 'command' ? rawText : expandSnippets(rawText), formatter: null };
}

// Models sometimes wrap the answer in quotes or a label; peel that off.
function stripWrapping(text, raw) {
  let t = String(text).trim();
  t = t.replace(/^(formatted text|output|result)\s*:\s*/i, '');
  if (/^["“].*["”]$/s.test(t) && !/^["“]/.test(String(raw).trim())) t = t.slice(1, -1).trim();
  return t;
}

function expandSnippets(text) {
  let result = text;
  for (const s of settings.snippets || []) {
    const escaped = s.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\b${escaped}\\b`, 'i'), s.expansion);
  }
  return result;
}

// ==========================================================
// History
// ==========================================================
function bindHistory() {
  $('historySearch')?.addEventListener('input', () => renderHistory());
  $('btnClearHistory')?.addEventListener('click', async () => {
    if (!(settings.history || []).length) return;
    if (!(await confirmDialog('Clear history?', 'Every saved transcript will be deleted from this PC. Stats are kept.', { ok: 'Clear history', danger: true }))) return;
    await saveSetting('history', []);
    renderHistory();
    toast('History cleared', 'info');
  });
  $('btnOpenRecordings')?.addEventListener('click', () => api.openRecordingsFolder?.());
}

async function addToHistory({ text, mode, engine, durationSec, words, style }) {
  const history = settings.history || [];
  history.unshift({ id: Date.now(), text, mode, engine, durationSec: Math.round(durationSec || 0), words, style, timestamp: new Date().toISOString() });
  if (history.length > 300) history.length = 300;
  await saveSetting('history', history);
  renderHistory();
}

function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const re = new RegExp(`(${escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function renderHistory() {
  const list = $('historyList');
  if (!list) return;
  const q = ($('historySearch')?.value || '').trim();
  const items = (settings.history || []).filter((h0) => !q || h0.text.toLowerCase().includes(q.toLowerCase()));
  if (!items.length) {
    list.innerHTML = `<div class="empty"><svg class="empty-art" viewBox="0 0 32 32"><use href="#i-flower"/></svg><div class="empty-title">${q ? 'Nothing matches' : 'Nothing here yet'}</div><p>${q ? 'Try another word.' : 'Everything you dictate will appear here.'}</p></div>`;
    return;
  }
  const groups = new Map();
  for (const it of items) {
    const key = dayLabel(it.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  let i = 0;
  list.replaceChildren(...[...groups].map(([label, entries]) => h('div.day-group', {}, [
    h('div.section-title', { text: label }),
    h('div.history-list', {}, entries.map((it) => {
      const time = new Date(it.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const textEl = h('div.history-text', { html: highlight(it.text, q), dir: isRtl(it.text) ? 'rtl' : 'ltr', title: 'Click to expand' });
      const card = h('div.history-item.list-enter', { style: { '--i': Math.min(i++, 20) } }, [
        h('div.history-time', { text: time }),
        h('div', {}, [
          textEl,
          h('div.history-foot', {}, [
            h('span.pill-tag', { text: it.mode === 'command' ? 'Edit' : it.mode === 'test' ? 'In app' : it.mode === 'retry' ? 'Recovered' : 'Dictation' }),
            it.engine ? h('span.pill-tag', { text: ENGINE_LABELS[it.engine] || it.engine }) : null,
            it.words ? h('span.pill-tag', { text: `${it.words} words` }) : null,
            it.durationSec ? h('span.pill-tag', { text: clock(it.durationSec) }) : null
          ])
        ]),
        h('div.history-actions', {}, [
          h('button.icon-btn', { title: 'Copy', html: icon('copy'), onclick: async () => { await api.copyText(it.text); toast('Copied', 'success'); } }),
          h('button.icon-btn', { title: 'Fix a word Freesia got wrong', html: icon('edit'), onclick: () => {
            const sel = String(window.getSelection?.() || '').trim();
            teachCorrection({ from: sel && it.text.includes(sel) ? sel : '', historyId: it.id });
          } }),
          h('button.icon-btn', { title: 'Delete', html: icon('trash'), onclick: () => deleteHistoryItem(it.id, card) })
        ])
      ]);
      textEl.addEventListener('click', () => card.classList.toggle('expanded'));
      return card;
    }))
  ])));
}

async function deleteHistoryItem(id, card) {
  card?.classList.add('list-leave');
  await new Promise((r) => setTimeout(r, 200));
  await saveSetting('history', (settings.history || []).filter((x) => String(x.id) !== String(id)));
  renderHistory();
}

// ---------------------------------------------------------- recoveries
const CANCELLED_NOTE = 'Cancelled with Esc. Not transcribed.';
const MIN_KEPT_CANCEL_SECONDS = 1.5;

// Esc cancels a dictation, but by default the audio is kept (History → Recordings)
// so pressing it by mistake never loses minutes of speech. Off in Settings.
async function keepCancelledRecording(blob, mode, durationSec) {
  if (settings.keepCancelledRecordings === false || mode === 'test' || durationSec < MIN_KEPT_CANCEL_SECONDS) return null;
  try {
    const audio = await blob.arrayBuffer();
    const base = await api.saveFailedAudio(audio, {
      timestamp: new Date().toISOString(), mode, sizeMB: (audio.byteLength / 1048576).toFixed(1),
      duration: clock(durationSec), durationSec, error: CANCELLED_NOTE, style: getActiveStyle().id
    });
    loadFailedRecordings();
    api.overlayKept?.();
    toast('Cancelled. The recording is kept in History in case you need it.', 'info', 5000);
    return base;
  } catch (e) {
    logError('keepCancelledRecording', e);
    return null;
  }
}

async function loadFailedRecordings() {
  try { renderFailedRecordings(await api.getFailedRecordings()); } catch (e) { logError('loadFailedRecordings', e); }
}

function renderFailedRecordings(recordings = []) {
  const failed = recordings.filter((r) => r.status !== 'success' && r.error !== 'Pending transcription');
  const badge = $('navRecoveryBadge');
  if (badge) { badge.hidden = !failed.length; badge.textContent = failed.length; }
  const banner = $('recoveryBanner');
  if (banner) {
    banner.hidden = !failed.length;
    const t = $('recoveryBannerTitle');
    if (t) t.textContent = `${failed.length} recording${failed.length === 1 ? '' : 's'} waiting to be transcribed`;
  }
  const section = $('recoverySection');
  const list = $('failedRecordingsList');
  if (!section || !list) return;
  const visible = recordings.filter((r) => r.error !== 'Pending transcription' || !isProcessingAudio);
  section.hidden = !visible.length;
  const cb = $('failedCountBadge'); if (cb) cb.textContent = visible.length;
  list.replaceChildren(...visible.map((r, i) => {
    const ok = r.status === 'success';
    return h(`div.recovery-item.list-enter${ok ? '.ok' : ''}`, { style: { '--i': i } }, [
      h('button.recovery-play', { title: ok ? 'Process again' : 'Retry now', html: icon('play'), onclick: () => retryFailedRecording(r.baseName) }),
      h('div.recovery-body', {}, [
        h('div.recovery-meta', { text: `${r.duration || '?'} · ${r.sizeMB || '?'} MB · ${r.timestamp ? new Date(r.timestamp).toLocaleString() : 'unknown time'}` }),
        h('div.recovery-err', { text: ok ? (r.transcription || 'Transcribed') : (r.error || 'Not transcribed yet'), title: r.error || '' })
      ]),
      h('button.icon-btn', { title: 'Show in folder', html: icon('folder'), onclick: () => api.showRecordingInFolder(r.baseName) }),
      h('button.icon-btn', { title: 'Delete', html: icon('trash'), onclick: () => deleteFailedRecording(r.baseName) })
    ]);
  }));
}

async function retryFailedRecording(baseName) {
  if (isRecording || isStartingRecording || isStoppingRecording || isProcessingAudio) {
    toast('Finish the current dictation first.', 'info');
    return;
  }
  try {
    const data = await api.getFailedRecordingData(baseName);
    if (!data) { toast('That recording file is gone.', 'error'); loadFailedRecordings(); return; }
    const meta = (await api.getFailedRecordings()).find((r) => r.baseName === baseName) || {};
    showView('home');
    // Retries go to the clipboard: the app you dictated into is long gone
    await processAudio(new Blob([data], { type: 'audio/webm' }), 'retry', { existingBase: baseName, durationSec: meta.durationSec || 0 });
  } catch (e) {
    logError('retryFailedRecording', e);
    toast(`Retry failed: ${e.message}`, 'error');
  }
}

async function deleteFailedRecording(baseName) {
  if (!(await confirmDialog('Delete this recording?', 'The audio file will be removed from this PC. This cannot be undone.', { ok: 'Delete', danger: true }))) return;
  await api.deleteFailedRecording(baseName);
  loadFailedRecordings();
}

// ==========================================================
// Styles
// ==========================================================
function getAllStyles() {
  return [...(window.BUILT_IN_STYLES || []), ...(settings.customStyles || [])];
}
function getActiveStyle() {
  const all = getAllStyles();
  return all.find((s) => s.id === activeStyleId) || all[0] || { id: 'normal', name: 'Normal', icon: '🗣️', prompt: null };
}

function bindStyles() {
  $('toggleAutoStyle')?.addEventListener('change', (e) => { saveSetting('autoStyleSwitch', e.target.checked); renderAppRules(); });
  $('btnNewStyle')?.addEventListener('click', () => openStyleEditor());
  $('appSearch')?.addEventListener('input', () => renderAppRules());
  $('btnAddApp')?.addEventListener('click', addAppDialog);
  $('btnRescanApps')?.addEventListener('click', () => { toast('Looking for apps…', 'info'); loadAppScan(true); });
  $('btnImportStyle')?.addEventListener('click', importStyleFile);
  $('btnOpenStylesFolder')?.addEventListener('click', () => api.openStylesFolder?.());
  $('nativeLangSelect')?.addEventListener('change', async (e) => {
    await saveSetting('nativeLanguage', e.target.value);
    renderStyleGrid();
    toast(`Speaking ${languageName(e.target.value)}`, 'success');
  });
}

function renderStyleGrid() {
  const grid = $('styleGrid');
  const active = getActiveStyle();
  if (grid) {
    const cards = getAllStyles().map((s, i) => {
      const card = h(`button.style-card.list-enter${s.id === activeStyleId ? '.active' : ''}`, { style: { '--accent': s.color || '#b69cff', '--i': i }, onclick: () => selectStyle(s.id) }, [
        h('span.style-icon', { text: s.icon || '✨' }),
        h('span.style-name', { text: s.name }),
        h('span.style-desc', { text: s.description || '' }),
        h('span.style-check', { html: icon('check') }),
        s.custom ? h('span.style-edit', {}, [h('span.icon-btn', { role: 'button', title: 'Edit style', html: icon('edit'), onclick: (e) => { e.stopPropagation(); openStyleEditor(s); } })]) : null
      ]);
      return card;
    });
    cards.push(h('button.style-card.add', { onclick: () => openStyleEditor() }, [h('span.style-icon', { html: icon('plus') }), h('span.style-name', { text: 'New style' })]));
    grid.replaceChildren(...cards);
  }
  const nameEl = $('homeStyleName');
  if (nameEl) {
    nameEl.textContent = active.id === 'native' ? `${active.icon} ${languageName(settings.nativeLanguage || active.language || 'fa')} → English` : `${active.icon} ${active.name}`;
  }
  const sw = $('homeStyleSwatch'); if (sw) sw.style.background = active.color || 'var(--bloom-2)';
  const row = $('nativeLangRow');
  const sel = $('nativeLangSelect');
  if (row && sel) {
    row.hidden = active.id !== 'native';
    if (active.languageOptions && !sel.options.length) active.languageOptions.forEach((l) => sel.add(new Option(l.name, l.code)));
    sel.value = settings.nativeLanguage || active.language || 'fa';
  }
  const t = $('toggleAutoStyle'); if (t) t.checked = !!settings.autoStyleSwitch;
}

async function selectStyle(id) {
  activeStyleId = id;
  await saveSetting('activeStyle', id);
  renderStyleGrid();
}

const STYLE_EMOJI = ['✨', '🗣️', '📧', '🎓', '⌨️', '✍️', '📋', '📱', '⚕️', '📌', '💬', '📝', '🌸', '🎨', '🧠', '⚡', '📣', '🪄'];
const STYLE_COLORS = ['#7CC4FF', '#B69CFF', '#FF9EC7', '#FFD48A', '#5EE4A6', '#FF7A85', '#A1A1AA', '#F59E0B'];

async function openStyleEditor(existing = null) {
  const s = existing || { icon: '✨', color: '#B69CFF', name: '', description: '', prompt: '' };
  let emoji = s.icon || '✨';
  let color = s.color || '#B69CFF';
  const body = h('div', {}, [
    h('div.field', {}, [h('label', { text: 'Name' }), h('input.input', { id: 'styleName', maxlength: 40, placeholder: 'e.g. Slack replies', value: s.name })]),
    h('div.field', {}, [h('label', { text: 'Icon' }), h('div.emoji-grid', {}, STYLE_EMOJI.map((e) => h(`button.emoji-choice${e === emoji ? '.selected' : ''}`, {
      type: 'button', text: e, onclick: (ev) => { emoji = e; $$('.emoji-choice', body).forEach((b) => b.classList.toggle('selected', b === ev.currentTarget)); }
    })))]),
    h('div.field', {}, [h('label', { text: 'Accent' }), h('div.color-row', {}, STYLE_COLORS.map((c) => h(`button.color-choice${c.toLowerCase() === color.toLowerCase() ? '.selected' : ''}`, {
      type: 'button', style: { background: c }, title: c, onclick: (ev) => { color = c; $$('.color-choice', body).forEach((b) => b.classList.toggle('selected', b === ev.currentTarget)); }
    })))]),
    h('div.field', {}, [h('label', { text: 'When to use it (optional)' }), h('input.input', { id: 'styleDesc', maxlength: 120, placeholder: 'Short, friendly team chat', value: s.description || '' })]),
    h('div.field', {}, [h('label', { text: 'Instructions for the formatter' }), h('textarea.textarea', { id: 'stylePrompt', rows: 5, maxlength: 4000, placeholder: 'Format this dictation as… Keep… Remove…' }, [s.prompt || '']),
      h('span.hint', { text: 'Be specific about tone, punctuation, length, and what to keep or drop.' })])
  ]);
  const actions = [];
  if (existing) actions.push({ label: 'Delete', kind: 'danger', value: 'delete' }, { spacer: true });
  actions.push({ label: 'Cancel', kind: 'ghost', value: null }, {
    label: existing ? 'Save' : 'Create style', kind: 'primary', value: 'save',
    validate: (box) => {
      const ok = box.querySelector('#styleName').value.trim() && box.querySelector('#stylePrompt').value.trim();
      if (!ok) toast('Give the style a name and instructions', 'error');
      return ok;
    }
  });
  let values = null;
  const result = await dialog({
    title: existing ? 'Edit style' : 'New style', body, actions,
    onOpen: (box) => box.addEventListener('input', () => {
      values = { name: box.querySelector('#styleName').value.trim(), description: box.querySelector('#styleDesc').value.trim(), prompt: box.querySelector('#stylePrompt').value.trim() };
    })
  });
  values = values || { name: body.querySelector('#styleName').value.trim(), description: body.querySelector('#styleDesc').value.trim(), prompt: body.querySelector('#stylePrompt').value.trim() };
  if (result === 'delete') return deleteCustomStyle(existing.id);
  if (result !== 'save') return;
  await saveCustomStyle({ id: existing?.id, ...values, icon: emoji, color });
}

async function saveCustomStyle(style) {
  const list = settings.customStyles || [];
  const id = style.id || `custom-${Date.now()}`;
  const record = { ...style, id, custom: true };
  const idx = list.findIndex((x) => x.id === id);
  if (idx !== -1) list[idx] = record; else list.push(record);
  await saveSetting('customStyles', list);
  activeStyleId = id;
  await saveSetting('activeStyle', id);
  renderStyleGrid();
  toast(`Style “${record.name}” saved`, 'success');
}

async function deleteCustomStyle(id) {
  if (!(await confirmDialog('Delete this style?', 'This custom style will be removed.', { ok: 'Delete', danger: true }))) return;
  await saveSetting('customStyles', (settings.customStyles || []).filter((x) => x.id !== id));
  if (activeStyleId === id) { activeStyleId = 'normal'; await saveSetting('activeStyle', 'normal'); }
  renderStyleGrid();
}

async function mergeImportedStyles(incoming, label) {
  if (!incoming?.length) return 0;
  const byId = new Map((settings.customStyles || []).map((x) => [x.id, x]));
  let added = 0;
  for (const st of incoming) { if (!byId.has(st.id)) added++; byId.set(st.id, { ...st, custom: true }); }
  await saveSetting('customStyles', [...byId.values()]);
  renderStyleGrid();
  if (added && label) toast(`Imported ${added} style${added === 1 ? '' : 's'}`, 'success');
  return added;
}

async function loadStylesFromDisk() {
  try { const found = await api.importStylesFromDisk?.(); if (found?.length) await mergeImportedStyles(found, null); } catch (e) { logError('loadStylesFromDisk', e); }
}

async function importStyleFile() {
  try { await mergeImportedStyles(await api.importStyleFile?.(), 'file'); } catch (e) { logError('importStyleFile', e); toast('Import failed', 'error'); }
}

async function detectAndApplyAutoStyle() {
  if (!settings.autoStyleSwitch) return;
  try {
    const raw = await api.getForegroundApp();
    if (!raw) return;
    const appName = APP_ALIASES[raw] || raw;
    const override = (settings.styleOverrides || {})[appName];
    const mapped = (window.APP_STYLE_MAP || {})[appName]?.styleId;
    if (override || mapped) { activeStyleId = override || mapped; renderStyleGrid(); }
  } catch (e) {
    logError('detectAndApplyAutoStyle', e);
  }
}

// Real process names that differ from the rule keys
const APP_ALIASES = { olk: 'outlook', 'ms-teams': 'teams', msteams: 'teams', 'code - insiders': 'code' };
// Brand colours for apps whose logos are not freely available
const APP_COLORS = { slack: '#4A154B', outlook: '#0078D4', winword: '#2B579A', excel: '#217346', powerpnt: '#D24726', teams: '#6264A7', msedge: '#0C59A4',
  code: '#007ACC', devenv: '#5C2D91', linkedin: '#0A66C2', chatgpt: '#10A37F', windowsterminal: '#3A3A3A', powershell: '#012456', onenote: '#7719AA', skype: '#00AFF0' };
let appScan = [];
let appScanLoaded = false;
let appScanLoading = false;
let showAllApps = false;

async function loadAppScan(force = false) {
  if (appScanLoading) return;
  appScanLoading = true;
  const wanted = [...Object.keys(window.APP_STYLE_MAP || {}), ...Object.keys(settings.customApps || {}), ...Object.keys(APP_ALIASES)];
  try { appScan = (await api.scanApps?.(force, wanted)) || []; } catch (e) { logError('scanApps', e); }
  appScanLoading = false;
  appScanLoaded = true;
  renderAppRules();
}

function appIconEl(row) {
  const mono = () => h('span.app-mono', { style: { background: APP_COLORS[row.key] || 'var(--raise-3)' }, text: String(row.name || row.key).replace(/^(Microsoft|Google)\s+/, '').slice(0, 1).toUpperCase() });
  if (row.icon) return h('img.app-icon', { src: row.icon, alt: '' });
  if (row.si && !APP_COLORS[row.key]) {
    const img = h('img.app-icon.si', { src: window.getAppIconUrl?.(row.si, 'ffffff') || '', alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(mono()));
    return img;
  }
  return mono();
}

function appRuleRows() {
  const map = window.APP_STYLE_MAP || {};
  const overrides = settings.styleOverrides || {};
  const custom = settings.customApps || {};
  const found = new Map(appScan.map((a) => [APP_ALIASES[a.key] || a.key, a]));
  const keys = new Set([...Object.keys(map), ...Object.keys(custom), ...Object.keys(overrides)]);
  return [...keys].map((key) => {
    const hit = found.get(key);
    return {
      key, name: custom[key]?.name || map[key]?.name || hit?.name || key,
      installed: !!hit, icon: hit?.icon || custom[key]?.icon || '', si: map[key]?.icon,
      styleId: overrides[key] || map[key]?.styleId || 'normal', overridden: key in overrides, custom: key in custom, builtIn: key in map
    };
  }).sort((a, b) => (b.installed - a.installed) || (b.custom - a.custom) || a.name.localeCompare(b.name));
}

function renderAppRules() {
  const list = $('appRulesList');
  if (!list) return;
  if (!appScanLoaded) {
    if (!list.children.length) list.innerHTML = '<p class="hint"><span class="spin"></span> Finding the apps on this PC…</p>';
    loadAppScan();
    return;
  }
  const q = ($('appSearch')?.value || '').trim().toLowerCase();
  const styles = getAllStyles();
  const all = appRuleRows();
  let rows = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.key.includes(q)) : all;
  const hidden = !q && !showAllApps ? rows.filter((r) => !r.installed && !r.custom) : [];
  if (hidden.length) rows = rows.filter((r) => r.installed || r.custom);
  list.classList.toggle('dim', !settings.autoStyleSwitch);
  const count = $('appRulesCount');
  if (count) count.textContent = `${all.filter((r) => r.installed).length} on this PC`;
  const nameCount = {};
  for (const r of rows) nameCount[r.name] = (nameCount[r.name] || 0) + 1;
  list.replaceChildren(...rows.map((r, i) => {
    const select = h('select.select.select-sm', { 'aria-label': `Style for ${r.name}` }, styles.map((st) => new Option(`${st.icon}  ${st.name}`, st.id)));
    select.value = r.styleId;
    select.addEventListener('change', async () => {
      const o = { ...(settings.styleOverrides || {}) };
      if (r.builtIn && !r.custom && select.value === window.APP_STYLE_MAP[r.key]?.styleId) delete o[r.key]; else o[r.key] = select.value;
      await saveSetting('styleOverrides', o);
      renderAppRules();
      toast(`${r.name} now uses ${styles.find((st) => st.id === select.value)?.name}`, 'success');
    });
    const actions = [];
    if (r.custom) actions.push(h('button.icon-btn', { title: 'Remove app', html: icon('x'), onclick: () => removeCustomApp(r.key) }));
    else if (r.overridden) actions.push(h('button.icon-btn', { title: 'Back to the default style', html: icon('refresh'), onclick: async () => {
      const o = { ...(settings.styleOverrides || {}) }; delete o[r.key]; await saveSetting('styleOverrides', o); renderAppRules();
    } }));
    return h(`div.app-row.list-enter${r.installed ? '' : '.absent'}`, { style: { '--i': Math.min(i, 24) } }, [
      appIconEl(r),
      h('span.app-row-text', {}, [h('span.app-row-name', { text: r.name }),
        h('span.app-row-meta', { text: `${r.custom ? 'Added by you' : r.installed ? (r.overridden ? 'On this PC · your choice' : 'On this PC') : 'Not installed'}${nameCount[r.name] > 1 ? ` · ${r.key}.exe` : ''}` })]),
      select, ...actions
    ]);
  }));
  if (hidden.length) {
    list.append(h('button.btn.btn-ghost.btn-sm.app-more', { text: `Show ${hidden.length} more apps that aren't on this PC`, onclick: () => { showAllApps = true; renderAppRules(); } }));
  }
  if (!rows.length) list.append(h('p.hint', { text: q ? 'No app matches. Use “Add app” to pick one that is open right now.' : 'No apps found yet.' }));
}

async function addAppDialog() {
  const listEl = h('div.app-pick', {}, [h('p.hint', { html: '<span class="spin"></span> Looking at open windows…' })]);
  let picked = null;
  const result = await dialog({
    title: 'Add an app', text: 'Open the app you want, then pick it here. Freesia uses the chosen style whenever you dictate into it.', body: listEl,
    actions: [{ label: 'Cancel', kind: 'ghost', value: null }],
    onOpen: async (box, close) => {
      const apps = (await api.runningApps?.()) || [];
      listEl.replaceChildren(...(apps.length ? apps.map((a) => h('button.app-row.pick', { type: 'button', onclick: () => { picked = a; close('pick'); } }, [
        appIconEl({ ...a, name: a.name || a.key }), h('span.app-row-text', {}, [h('span.app-row-name', { text: a.name || a.key }), h('span.app-row-meta', { text: a.title || a.key })])
      ])) : [h('p.hint', { text: 'No open windows found.' })]));
    }
  });
  if (result !== 'pick' || !picked) return;
  const custom = { ...(settings.customApps || {}) };
  custom[picked.key] = { name: picked.name || picked.key, icon: picked.icon || '' };
  await saveSetting('customApps', custom);
  const o = { ...(settings.styleOverrides || {}) };
  if (!o[picked.key]) o[picked.key] = activeStyleId;
  await saveSetting('styleOverrides', o);
  if (!settings.autoStyleSwitch) { await saveSetting('autoStyleSwitch', true); renderStyleGrid(); }
  renderAppRules();
  toast(`${picked.name || picked.key} added`, 'success');
}

async function removeCustomApp(key) {
  const custom = { ...(settings.customApps || {}) }; delete custom[key];
  const o = { ...(settings.styleOverrides || {}) }; delete o[key];
  await saveSetting('customApps', custom);
  await saveSetting('styleOverrides', o);
  renderAppRules();
}

// ==========================================================
// Vocabulary
// ==========================================================
let currentEditSnippetId = null;

function bindVocabulary() {
  const tabs = $('vocabTabs');
  if (tabs) segmented(tabs, { onChange: (tab) => { $('tabDictionary').hidden = tab !== 'dictionary'; $('tabSnippets').hidden = tab !== 'snippets'; } });
  $('btnSaveWord')?.addEventListener('click', addWord);
  $('newWordInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addWord(); });
  $('btnAddSnippet')?.addEventListener('click', () => openSnippetForm());
  $('btnTeach')?.addEventListener('click', () => teachCorrection());
  renderCorrections();
  $('btnCancelSnippet')?.addEventListener('click', () => { $('snippetForm').hidden = true; $('btnAddSnippet').hidden = false; });
  $('btnSaveSnippet')?.addEventListener('click', saveSnippet);
}

async function addWord() {
  const input = $('newWordInput');
  const words = input.value.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) return;
  const dict = settings.dictionary || [];
  let added = 0;
  for (const w of words) if (!dict.some((d) => d.toLowerCase() === w.toLowerCase())) { dict.push(w); added++; }
  await saveSetting('dictionary', dict);
  input.value = '';
  renderDictionary(true);
  if (added) toast(`Added ${added === 1 ? `“${words[0]}”` : `${added} words`}`, 'success');
}

async function removeWord(word) {
  await saveSetting('dictionary', (settings.dictionary || []).filter((w) => w !== word));
  renderDictionary();
}

function renderDictionary(animateLast = false) {
  const list = $('dictionaryList');
  if (!list) return;
  const dict = settings.dictionary || [];
  if (!dict.length) {
    list.innerHTML = '<div class="empty" style="width:100%"><div class="empty-title">No words yet</div><p>Add names, acronyms and jargon you use often.</p></div>';
    return;
  }
  list.replaceChildren(...dict.map((w, i) => h(`span.chip${animateLast && i === dict.length - 1 ? '.pop' : ''}`, {}, [
    h('span', { text: w }),
    // Closure, not an inline handler: 2.x broke on words with apostrophes
    h('button.x', { title: `Remove ${w}`, html: icon('x'), onclick: () => removeWord(w) })
  ])));
}

function openSnippetForm(s = null) {
  currentEditSnippetId = s?.id ?? null;
  $('snippetTrigger').value = s?.trigger || '';
  $('snippetExpansion').value = s?.expansion || '';
  $('snippetForm').hidden = false;
  $('btnAddSnippet').hidden = true;
  $('snippetTrigger').focus();
}

async function saveSnippet() {
  const trigger = $('snippetTrigger').value.trim();
  const expansion = $('snippetExpansion').value.trim();
  if (!trigger || !expansion) return toast('Fill in both fields', 'error');
  const snippets = settings.snippets || [];
  if (currentEditSnippetId != null) {
    const s = snippets.find((x) => x.id === currentEditSnippetId);
    if (s) Object.assign(s, { trigger, expansion });
  } else {
    snippets.push({ id: Date.now(), trigger, expansion });
  }
  await saveSetting('snippets', snippets);
  currentEditSnippetId = null;
  $('snippetForm').hidden = true;
  $('btnAddSnippet').hidden = false;
  renderSnippets();
  toast(`Snippet “${trigger}” saved`, 'success');
}

async function removeSnippet(id) {
  await saveSetting('snippets', (settings.snippets || []).filter((s) => s.id !== id));
  renderSnippets();
}

function renderSnippets() {
  const list = $('snippetList');
  if (!list) return;
  const snippets = settings.snippets || [];
  if (!snippets.length) {
    list.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-title">No snippets yet</div><p>Say “my signature” and get your full sign-off.</p></div>';
    return;
  }
  list.replaceChildren(...snippets.map((s, i) => h('div.snippet.list-enter', { style: { '--i': i } }, [
    h('div.snippet-trigger', { text: s.trigger }),
    h('div.snippet-expansion', { text: s.expansion }),
    h('div.snippet-actions', {}, [
      h('button.btn.btn-ghost.btn-sm', { html: `${icon('edit')}Edit`, onclick: () => openSnippetForm(s) }),
      h('button.btn.btn-ghost.btn-sm', { html: `${icon('trash')}Delete`, onclick: () => removeSnippet(s.id) })
    ])
  ])));
}

// ==========================================================
// Engines
// ==========================================================
function bindEngines() {
  $$('[data-select-engine]').forEach((b) => b.addEventListener('click', () => setEngine(b.dataset.selectEngine)));
  $('toggleFallback')?.addEventListener('change', (e) => saveSetting('engineFallback', e.target.checked));
  $('selectFormatter')?.addEventListener('change', async (e) => { engineState = await api.setEngine('formatter', e.target.value); renderEngines(); });
  const lang = $('selectLanguage');
  if (lang) {
    LANGUAGES.forEach(([c, n]) => lang.add(new Option(n, c)));
    lang.addEventListener('change', (e) => saveSetting('language', e.target.value));
  }
  api.onLocalStatus?.((s) => { engineState.local = s; renderLocalBody(); renderEngineStatus(); renderEnginePill(); if (obStep === 1 && obEngine === 'local') renderObEngineForm(); });
  api.onEngineRetry?.(({ model }) => setOutput('working', `Gemini is busy. Trying ${model}…`));
}

async function refreshEngines() {
  try { engineState = await api.engineStatus(); } catch (e) { logError('refreshEngines', e); }
  renderEngines();
  renderEnginePill();
}

async function setEngine(id, quiet = false) {
  engineState = await api.setEngine('engine', id);
  $$('.engine').forEach((el) => el.classList.toggle('open', el.dataset.engine === id));
  renderEngines();
  renderEnginePill();
  if (!quiet) toast(`${ENGINE_LABELS[id]} selected`, 'success');
}

function renderEngines() {
  const sel = engineState.engine;
  $$('.engine').forEach((el) => {
    el.classList.toggle('selected', el.dataset.engine === sel);
    if (!$$('.engine.open').length && el.dataset.engine === sel) el.classList.add('open');
  });
  renderEngineStatus();
  renderCloudBody();
  renderLocalBody();
  renderGeminiBody();
  const f = $('toggleFallback'); if (f) f.checked = settings.engineFallback !== false;
  const fm = $('selectFormatter'); if (fm) fm.value = engineState.formatter || 'auto';
  const lang = $('selectLanguage'); if (lang) lang.value = settings.language || 'auto';
  const banner = $('setupBanner');
  if (banner) banner.hidden = FALLBACK_ORDER.some((id) => isEngineReady(id));
}

function statusHtml(dot, text) {
  return `<span class="dot ${dot}"></span>${escapeHtml(text)}`;
}

function renderEngineStatus() {
  const c = engineState.cloud || {};
  const l = engineState.local || {};
  const g = engineState.gemini || {};
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  set('cloudStatus', c.configured ? statusHtml('ok', c.username) : statusHtml('', c.signedOut ? 'Signed out' : 'Not signed in'));
  set('localStatus', l.downloading ? statusHtml('busy', `Downloading ${Math.round((l.downloading.received / Math.max(1, l.downloading.total)) * 100)}%`)
    : l.running ? statusHtml('ok', `Loaded · ${l.device || 'CPU'}`)
      : l.starting ? statusHtml('busy', 'Loading…')
        : l.configured ? statusHtml('warn', 'Ready · loads on demand') : statusHtml('', 'Not installed'));
  set('geminiStatus', g.configured ? statusHtml('ok', g.model || 'Key saved') : statusHtml('', 'No key'));
}

function renderEnginePill() {
  const id = engineState.engine || 'cloud';
  const name = $('enginePillName'); if (name) name.textContent = ENGINE_LABELS[id];
  const dot = $('enginePillDot');
  if (dot) {
    const l = engineState.local || {};
    dot.className = `dot ${!isEngineReady(id) ? 'bad' : id === 'local' && !l.running ? (l.starting ? 'busy' : 'warn') : 'ok'}`;
  }
}

function cloudLoginForm(onDone) {
  const server = engineState.cloud?.server || '';
  const form = h('form', { autocomplete: 'on' }, [
    h('div.field', {}, [h('label', { text: 'Server' }), h('input.input', { name: 'server', value: server, required: true, spellcheck: 'false', placeholder: 'https://voice.example.com', autocomplete: 'url' })]),
    h('div.grid-2.mt-12', {}, [
      h('div.field', {}, [h('label', { text: 'Username' }), h('input.input', { name: 'username', autocomplete: 'username', required: true, spellcheck: 'false', value: engineState.cloud?.username || '' })]),
      h('div.field', {}, [h('label', { text: 'Password' }), h('input.input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })])
    ]),
    h('div.btn-row', {}, [
      h('button.btn.btn-primary', { type: 'submit', html: `${icon('lock')}Sign in` }),
      h('span.hint', { html: 'No account? Ask whoever runs your Freesia Voice server for an invite.' })
    ])
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Signing in…';
    const res = await api.cloudLogin(form.server.value, form.username.value.trim(), form.password.value);
    btn.disabled = false;
    btn.innerHTML = `${icon('lock')}Sign in`;
    if (res?.error) { toast(res.error.message, 'error', 5000); return; }
    form.password.value = '';
    engineState.cloud = res;
    toast(`Signed in as ${res.username}`, 'success');
    renderEngines();
    renderEnginePill();
    onDone?.();
    if (settings.onboarded) checkContribution();
  });
  return form;
}

function renderCloudBody() {
  const host = $('cloudBody');
  if (!host) return;
  const c = engineState.cloud || {};
  host.replaceChildren();
  if (!c.configured) { host.append(cloudLoginForm()); return; }
  const facts = h('div.engine-facts', {}, [
    fact('Account', c.username), fact('Server', (c.server || '').replace(/^https:\/\//, '')), fact('Speech model', c.model || 'Chosen by your server'), fact('Formatting', c.formattingModel || 'Chosen by your server')
  ]);
  const latency = h('span.hint');
  host.append(facts, h('div.btn-row', {}, [
    h('button.btn.btn-secondary.btn-sm', { html: `${icon('bolt')}Test connection`, onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true; latency.textContent = 'Testing…';
      const r = await api.cloudHealth(); b.disabled = false;
      if (r?.error) { latency.textContent = r.error.message; toast(r.error.message, 'error'); refreshEngines(); return; }
      latency.innerHTML = `${icon('check')} Connected in ${r.latencyMs} ms`;
      engineState.cloud = { ...engineState.cloud, model: r.model, formattingModel: r.formattingModel };
    } }),
    h('button.btn.btn-ghost.btn-sm', { html: `${icon('external')}Account & devices`, onclick: () => api.cloudOpenAccount() }),
    h('button.btn.btn-ghost.btn-sm', { text: 'Sign out', onclick: async () => {
      if (!(await confirmDialog('Sign out of Freesia Cloud?', 'This device\'s token is revoked on the server.', { ok: 'Sign out' }))) return;
      contribState = null;
      engineState.cloud = await api.cloudLogout(); renderEngines(); renderEnginePill();
    } }),
    latency
  ]), h('div', { id: 'contribBlock' }));
  renderContribBlock();
  if (!contribState) checkContribution({ prompt: false });
}

// ==========================================================
// Voice contributions: off by default. Only servers that support them
// (InquireLab's Freesia Voice) answer /api/contribute; the server keeps the
// choice and the terms, so each account is asked once per version of the terms.
// ==========================================================
let contribState = null;
let contribAsked = false;
let contribDialogOpen = false;

async function checkContribution({ prompt = true } = {}) {
  if (!engineState.cloud?.configured || !api.cloudContribution) return;
  const res = await api.cloudContribution();
  if (!res || res.error || !res.available) { contribState = null; renderContribBlock(); return; }
  contribState = res;
  renderContribBlock();
  if (prompt && !res.decided && !contribAsked) {
    contribAsked = true;
    showContributionTerms({ firstTime: true });
  }
}

function contribTermsBody(terms) {
  return h('div.contrib-terms', {}, terms.paragraphs.map((t, i) => h('p', { text: t, style: { '--i': i } })));
}

// The terms dialog is the only way to turn sharing on, so nobody agrees to text they did not see
async function showContributionTerms({ firstTime = false } = {}) {
  const st = contribState;
  if (!st || contribDialogOpen) return false;
  contribDialogOpen = true;
  const actions = st.enabled && !firstTime
    ? [{ label: 'Close', kind: 'secondary', value: null }]
    : [{ label: 'No thanks', kind: 'ghost', value: false }, { spacer: true }, { label: 'Share my recordings', kind: 'primary', value: true }];
  const body = h('div', {}, [
    firstTime ? h('div.contrib-badge', { html: `${icon('flower')}New in this version` }) : null,
    contribTermsBody(st.terms),
    h('p.hint.mt-12', { text: 'You can change this at any time in Engines, under Freesia Cloud.' })
  ]);
  const choice = await dialog({ title: st.terms.title, text: st.terms.summary, body, actions });
  contribDialogOpen = false;
  // Closed without answering: nothing changes, and the question comes back next launch
  if (choice === null || choice === undefined) return false;
  if (choice === st.enabled && st.decided) return choice;
  await setContribution(choice);
  return choice;
}

async function setContribution(enabled) {
  const res = await api.cloudSetContribution(enabled, contribState?.version);
  if (res?.error) { toast(res.error.message, 'error', 5000); checkContribution({ prompt: false }); return; }
  contribState = res;
  renderContribBlock();
  toast(enabled ? 'Thank you. Your recordings now help train Freesia Voice.' : 'Sharing is off. Nothing new is kept.', 'success', 4000);
  if (!enabled && res.shared?.recordings) {
    const n = res.shared.recordings;
    if (await confirmDialog(`Also delete the ${n} recording${n === 1 ? '' : 's'} you shared?`,
      'They are removed from the server right away and never used again.', { ok: 'Delete them', cancel: 'Keep them', danger: true })) {
      await deleteContributions();
    }
  }
}

async function deleteContributions() {
  const res = await api.cloudDeleteContributions();
  if (res?.error) { toast(res.error.message, 'error', 5000); return; }
  contribState = res;
  renderContribBlock();
  toast(`Deleted ${res.deleted} clip${res.deleted === 1 ? '' : 's'} from the server`, 'success');
}

function renderContribBlock() {
  const host = $('contribBlock');
  if (!host) return;
  const st = contribState;
  host.replaceChildren();
  if (!st || !engineState.cloud?.configured) return;
  const n = st.shared?.recordings || 0;
  const mins = (st.shared?.seconds || 0) / 60;
  const amount = n
    ? `You have shared ${n} recording${n === 1 ? '' : 's'} (${mins < 1 ? 'under a minute' : `${Math.round(mins)} min`}).`
    : 'You have not shared any recordings.';
  const input = h('input', { type: 'checkbox', 'aria-label': 'Share my recordings to train Freesia Voice' });
  input.checked = !!st.enabled;
  input.addEventListener('change', async () => {
    if (input.checked) {
      input.checked = false;
      await showContributionTerms();
    } else {
      await setContribution(false);
    }
    input.checked = !!contribState?.enabled;
  });
  host.append(h('div.contrib-block' + (st.enabled ? '.on' : ''), {}, [
    h('div.contrib-head', {}, [
      h('span.engine-glyph', { html: icon('flower') }),
      h('span.row-text', {}, [
        h('span.row-title', { text: 'Help improve the voice engine' }),
        h('span.row-desc', { style: { display: 'block' }, text: (st.enabled ? 'On. Recordings Freesia Cloud transcribes help train its speech model. ' : 'Off. Freesia Cloud keeps none of your audio. ') + amount })
      ]),
      h('span.switch', {}, [input, h('span.switch-track')])
    ]),
    h('div.btn-row', {}, [
      h('button.btn.btn-ghost.btn-sm', { text: 'Read the terms', onclick: () => showContributionTerms() }),
      n ? h('button.btn.btn-ghost.btn-sm', { text: 'Delete my shared recordings', onclick: async () => {
        if (await confirmDialog('Delete every recording you shared?', 'They are removed from the server right away. This cannot be undone.', { ok: 'Delete', danger: true })) deleteContributions();
      } }) : null
    ])
  ]));
}

function fact(k, v) { return h('div.fact', {}, [h('div.fact-k', { text: k }), h('div.fact-v', { text: v || '—' })]); }

function localInstallBlock(compact = false) {
  const l = engineState.local || {};
  const models = Object.values(l.models || {});
  const wrap = h('div');
  if (l.downloading) {
    const pct = Math.round((l.downloading.received / Math.max(1, l.downloading.total)) * 100);
    wrap.append(
      h('div.hint', { text: `Downloading ${l.models?.[l.downloading.modelId]?.label || 'model'} · ${bytes(l.downloading.received)} of ${bytes(l.downloading.total)}` }),
      h('div.progress', {}, [h('span', { style: { width: `${pct}%` } })]),
      h('div.btn-row', {}, [h('button.btn.btn-ghost.btn-sm', { text: 'Cancel', onclick: () => api.localCancel() })])
    );
    return wrap;
  }
  wrap.append(h('div.model-list', {}, models.map((m) => h(`button.model-opt${l.selected === m.id ? '.selected' : ''}`, {
    type: 'button', onclick: async () => { engineState.local = await api.localSelect(m.id); renderLocalBody(); if (compact) renderObEngineForm(); }
  }, [
    h('span.engine-radio'),
    h('span.grow', {}, [h('div', { html: `<b>${escapeHtml(m.label)}</b> ${m.installed ? '<span class="pill-tag ok">Installed</span>' : ''}` }), h('div.hint', { text: `${m.blurb} ${bytes(m.sizeBytes)} download, about ${m.vramGB} GB of GPU memory.` })])
  ]))));
  const sel = l.models?.[l.selected];
  if (sel && !sel.installed) {
    wrap.append(h('div.btn-row', {}, [
      h('button.btn.btn-primary', { html: `${icon('download')}Download ${escapeHtml(sel.label)} (${bytes(sel.sizeBytes + (l.runtimeInstalled ? 0 : 32e6))})`, onclick: async () => {
        const r = await api.localInstall(l.selected);
        if (r?.error) toast(r.error.message, r.error.message === 'Download cancelled' ? 'info' : 'error', 5000);
        else { toast('The model is installed on this PC', 'success'); engineState.local = r; api.localStart(); }
        refreshEngines();
      } }),
      h('span.hint', { text: 'Verified with SHA-256. Stored in your Freesia folder.' })
    ]));
  }
  if (l.error) wrap.append(h('p.hint.mt-8', { style: { color: 'var(--bad)' }, text: l.error }));
  return wrap;
}

function renderLocalBody() {
  const host = $('localBody');
  if (!host) return;
  const l = engineState.local || {};
  host.replaceChildren();
  if (l.configured && !l.downloading) {
    host.append(h('div.engine-facts', {}, [
      fact('Model', l.models?.[l.selected]?.label), fact('Status', l.running ? 'Loaded' : l.starting ? 'Loading…' : 'Idle'), fact('Runs on', l.device || (l.running ? 'CPU' : 'Picked at load')), fact('Privacy', 'Audio never leaves this PC')
    ]));
  }
  host.append(localInstallBlock());
  if (l.configured && !l.downloading) {
    host.append(h('div.btn-row', {}, [
      l.running
        ? h('button.btn.btn-secondary.btn-sm', { text: 'Unload from memory', onclick: async () => { engineState.local = await api.localStop(); renderLocalBody(); } })
        : h('button.btn.btn-secondary.btn-sm', { html: `${icon('bolt')}Load now`, onclick: async () => { const r = await api.localStart(); if (r?.error) toast(r.error.message, 'error', 5000); refreshEngines(); } }),
      h('button.btn.btn-ghost.btn-sm', { html: `${icon('folder')}Folder`, onclick: () => api.localOpenFolder() }),
      h('button.btn.btn-ghost.btn-sm', { html: `${icon('trash')}Remove model`, onclick: async () => {
        if (!(await confirmDialog('Remove the model from this PC?', 'This frees the disk space. You can download it again later.', { ok: 'Remove', danger: true }))) return;
        engineState.local = await api.localRemove(l.selected); refreshEngines();
      } })
    ]));
    const unload = h('select.select', { style: { width: '200px' } }, [['0', 'Keep loaded'], ['5', 'After 5 minutes idle'], ['20', 'After 20 minutes idle'], ['60', 'After 1 hour idle']].map(([v, t]) => new Option(t, v)));
    unload.value = String(settings.localUnloadMinutes ?? 20);
    unload.addEventListener('change', () => saveSetting('localUnloadMinutes', Number(unload.value)));
    const gpu = h('input', { type: 'checkbox' });
    gpu.checked = settings.localUseGpu !== false;
    gpu.addEventListener('change', async () => { await saveSetting('localUseGpu', gpu.checked); await api.localStop(); toast('Takes effect the next time the model loads', 'info'); });
    host.append(h('div.rows.mt-16', {}, [
      h('div.row', {}, [h('span.row-text', {}, [h('span.row-title', { text: 'Free GPU memory' }), h('span.row-desc', { style: { display: 'block' }, text: 'Unload the model when idle. The next dictation reloads it in a few seconds.' })]), unload]),
      h('label.row', {}, [h('span.row-text', {}, [h('span.row-title', { text: 'Use the graphics card' }), h('span.row-desc', { style: { display: 'block' }, text: 'Picks your strongest GPU. Turn off to run on the CPU.' })]), h('span.switch', {}, [gpu, h('span.switch-track')])])
    ]));
  }
}

function geminiKeyForm(onDone) {
  const g = engineState.gemini || {};
  const input = h('input.input', { type: 'password', placeholder: g.configured ? `Saved key ${g.keyPreview}` : 'AIza…', autocomplete: 'off', spellcheck: 'false' });
  const eye = h('button.icon-btn', { type: 'button', title: 'Show', html: icon('eye'), onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; } });
  const save = h('button.btn.btn-primary', { text: g.configured ? 'Replace key' : 'Save key', onclick: async () => {
    if (!input.value.trim()) return;
    save.disabled = true; save.innerHTML = '<span class="spin"></span>Checking…';
    const res = await api.geminiSetKey(input.value.trim());
    save.disabled = false; save.textContent = 'Save key';
    if (res?.error) { toast(res.error.message, 'error', 5000); return; }
    input.value = '';
    engineState.gemini = res;
    toast('Gemini key saved and encrypted', 'success');
    renderEngines(); renderEnginePill(); onDone?.();
  } });
  return h('div', {}, [
    h('div.inline-form', {}, [h('div.input-wrap.grow', {}, [input, eye]), save]),
    h('p.hint.mt-8', { html: 'Get a key at <a data-href="https://aistudio.google.com/app/apikey">Google AI Studio</a>. It is encrypted with your Windows account and only sent to Google.' })
  ]);
}

function renderGeminiBody() {
  const host = $('geminiBody');
  if (!host) return;
  const g = engineState.gemini || {};
  host.replaceChildren(geminiKeyForm());
  if (g.configured) {
    const list = h('div.model-list', {}, (g.models || []).slice(0, 12).map((m) => h(`button.model-opt${g.model === m.id ? '.selected' : ''}`, {
      type: 'button', onclick: async () => { await saveSetting('geminiModel', m.id); engineState.gemini.model = m.id; renderGeminiBody(); renderEngineStatus(); }
    }, [h('span.engine-radio'), h('span.grow', {}, [h('div', { text: m.name }), h('div.model-id', { text: m.id })])])));
    host.append(h('div.btn-row', {}, [
      h('span.hint', { text: `Model: ${g.model}` }),
      h('button.btn.btn-ghost.btn-sm', { html: `${icon('refresh')}Refresh models`, onclick: async () => { await api.geminiRefreshModels(); refreshEngines(); } }),
      h('button.btn.btn-ghost.btn-sm', { text: 'Remove key', onclick: async () => { engineState.gemini = await api.geminiSetKey(''); refreshEngines(); } })
    ]), list);
  }
}

// External links rendered as data-href (no inline handlers under the CSP)
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('[data-href]');
  if (a) { e.preventDefault(); api.openExternal(a.dataset.href); }
});

// ==========================================================
// Settings
// ==========================================================
let themeSeg = null;
let shortcutRecorder = null;
let settingsMicStream = null;
let settingsMicTimer = null;

function bindSettings() {
  const seg = $('themeSeg');
  if (seg) themeSeg = segmented(seg, { attr: 'data-theme-choice', onChange: (v) => setTheme(v) });
  $('selectMicrophone')?.addEventListener('change', (e) => { saveSetting('microphoneId', e.target.value); if (settingsMicStream) { stopSettingsMic(); toggleSettingsMic(); } });
  $('btnMicTest')?.addEventListener('click', toggleSettingsMic);
  window.FreesiaAudio?.createMeter($('settingsMeter'), 18).reset();
  window.FreesiaAudio?.createMeter($('obMeter'), 26).reset();
  const toggles = { toggleOverlay: 'showOverlay', toggleSounds: 'sounds', toggleKeepRecordings: 'keepSuccessRecordings', toggleKeepCancelled: 'keepCancelledRecordings', toggleKeepMicReady: 'keepMicReady', toolTrimSpelling: 'toolTrimSpelling', toolSpokenEmoji: 'toolSpokenEmoji', toolPolish: 'toolPolish' };
  for (const [id, key] of Object.entries(toggles)) $(id)?.addEventListener('change', (e) => { saveSetting(key, e.target.checked); if (key === 'sounds' && e.target.checked) window.FreesiaAudio?.chime('start'); });
  $('toggleAutoLaunch')?.addEventListener('change', (e) => api.setAutoLaunch(e.target.checked));
  $('toggleErrorReporting')?.addEventListener('change', (e) => {
    saveSetting('errorReporting', e.target.checked);
    if ($('onboardingErrorReporting')) $('onboardingErrorReporting').checked = e.target.checked;
    toast(e.target.checked ? 'Error reports on. Thank you.' : 'Error reports off', 'info');
  });
  $$('.shortcut-rec').forEach((b) => b.addEventListener('click', () => beginShortcutRecording(b)));
  $('btnCheckUpdates')?.addEventListener('click', checkForUpdates);
  $('btnDownloadUpdate')?.addEventListener('click', downloadUpdate);
  $('btnInstallUpdate')?.addEventListener('click', installUpdate);
  $('btnGitHub')?.addEventListener('click', () => api.openExternal('https://github.com/arash-san/freesia'));
  $('btnViewLog')?.addEventListener('click', () => api.openLog?.());
  $('btnResetSettings')?.addEventListener('click', resetAllSettings);
  window.addEventListener('online', checkForUpdates);
}

function updateSettingsUI() {
  const check = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  check('toggleOverlay', settings.showOverlay !== false);
  check('toggleSounds', settings.sounds !== false);
  check('toggleAutoLaunch', settings.autoLaunch);
  check('toggleKeepRecordings', settings.keepSuccessRecordings);
  check('toggleKeepCancelled', settings.keepCancelledRecordings !== false);
  check('toggleKeepMicReady', settings.keepMicReady !== false);
  check('toolTrimSpelling', settings.toolTrimSpelling);
  check('toolSpokenEmoji', settings.toolSpokenEmoji);
  check('toolPolish', settings.toolPolish);
  check('toggleErrorReporting', settings.errorReporting);
  check('onboardingErrorReporting', settings.errorReporting);
  const mic = $('selectMicrophone'); if (mic) mic.value = settings.microphoneId || '';
  themeSeg?.set(settings.theme || 'system', true);
}

function renderShortcuts() {
  const map = { dictationShortcut: settings.dictationShortcut || 'Ctrl+Shift+Space', commandShortcut: settings.commandShortcut || 'Ctrl+Shift+Alt+Space' };
  $$('[data-kbd]').forEach((el) => { el.innerHTML = kbdHtml(map[el.dataset.kbd]); });
  $$('.shortcut-rec').forEach((b) => { if (!b.classList.contains('recording')) b.innerHTML = `<span class="kbd-group">${kbdHtml(map[b.dataset.shortcut])}</span>`; });
}

const KEY_NAMES = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };

function keyFromEvent(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  if (/^Numpad\d$/.test(e.code)) return `num${e.code.slice(6)}`;
  return KEY_NAMES[e.code] || null;
}

async function beginShortcutRecording(button) {
  if (shortcutRecorder) return;
  await api.suspendShortcuts?.();
  button.classList.add('recording');
  button.innerHTML = '<span class="rec-hint">Press the new shortcut… (Esc to cancel)</span>';
  const finish = async (combo) => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    shortcutRecorder = null;
    button.classList.remove('recording');
    if (combo) {
      const res = await api.setShortcut(button.dataset.shortcut, combo);
      if (res?.ok) { settings[button.dataset.shortcut] = combo; toast(`Shortcut set to ${combo}`, 'success'); }
      else toast(res?.message || 'That shortcut could not be used.', 'error', 5000);
    } else {
      await api.registerShortcuts();
    }
    settings = { ...settings, ...(await api.getSettings()) };
    renderShortcuts();
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return finish(null);
    const key = keyFromEvent(e);
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!key) { button.innerHTML = `<span class="kbd-group">${kbdHtml(mods.join('+'))}</span><span class="rec-hint">+ …</span>`; return; }
    if (!mods.length && !/^F\d/.test(key)) { button.innerHTML = '<span class="rec-hint">Add Ctrl, Alt or Shift</span>'; return; }
    finish([...mods, key].join('+'));
  };
  const onBlur = () => finish(null);
  shortcutRecorder = { finish };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
}

async function toggleSettingsMic() {
  if (settingsMicStream) return stopSettingsMic();
  const meter = window.FreesiaAudio?.createMeter($('settingsMeter'), 18);
  try {
    settingsMicStream = await openMicrophoneStream();
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(settingsMicStream).connect(an);
    settingsMicStream._ctx = ctx;
    const buf = new Float32Array(an.fftSize);
    const m = window.createAudioMeter();
    settingsMicTimer = setInterval(() => { an.getFloatTimeDomainData(buf); meter.set(m.sample(buf)); }, 50);
    $('btnMicTest').textContent = 'Stop';
    setTimeout(stopSettingsMic, 20000);
    loadMicrophones();
  } catch (e) {
    toast(micErrorMessage(e), 'error');
  }
}

function stopSettingsMic() {
  clearInterval(settingsMicTimer);
  if (settingsMicStream) {
    settingsMicStream.getTracks().forEach((t) => t.stop());
    settingsMicStream._ctx?.close().catch(() => {});
    settingsMicStream = null;
  }
  window.FreesiaAudio?.createMeter($('settingsMeter'), 18).reset();
  const b = $('btnMicTest'); if (b) b.textContent = 'Test';
}

async function resetAllSettings() {
  const ok = await confirmDialog('Reset Freesia?', 'This signs you out, forgets your Gemini key and clears every setting, word, snippet, style and your history. The on-device model stays downloaded.', { ok: 'Reset everything', danger: true });
  if (!ok) return;
  await api.cloudLogout?.();
  await api.geminiSetKey?.('');
  const keys = ['onboarded', 'geminiModel', 'microphoneId', 'aiFormatting', 'language', 'theme', 'autoLaunch', 'showOverlay', 'sounds', 'keepSuccessRecordings',
    'dictionary', 'snippets', 'history', 'stats', 'customStyles', 'toolTrimSpelling', 'toolSpokenEmoji', 'toolPolish', 'errorReporting', 'activeStyle',
    'autoStyleSwitch', 'styleOverrides', 'engine', 'engineFallback', 'formatter', 'nativeLanguage', 'dictationShortcut', 'commandShortcut'];
  for (const k of keys) await api.setSetting(k, undefined);
  location.reload();
}

// ---------------------------------------------------------- updates
async function initAppMetadata() {
  try {
    const version = await api.getAppVersion?.();
    if (version) {
      const v = $('appVersionLabel'); if (v) v.textContent = `Freesia ${version}`;
      const b = $('brandVersion'); if (b) b.textContent = version.split('.').slice(0, 2).join('.');
    }
    const s = await api.getUpdateStatus?.();
    if (s) renderUpdateStatus(s);
  } catch (e) {
    logError('initAppMetadata', e);
  }
  api.onUpdateStatus?.((s) => renderUpdateStatus(s));
}

function renderUpdateStatus(state = {}) {
  updateStatus = state;
  const status = state.status || 'idle';
  const busy = ['checking', 'downloading', 'installing'].includes(status);
  const pct = Math.max(0, Math.min(100, Math.round(state.progress?.percent || 0)));
  const txt = $('updateStatusText'); if (txt) txt.textContent = state.message || 'Update checks are ready.';
  const check = $('btnCheckUpdates'); if (check) check.disabled = busy;
  const dl = $('btnDownloadUpdate'); if (dl) dl.hidden = status !== 'available';
  const inst = $('btnInstallUpdate'); if (inst) inst.hidden = status !== 'downloaded';
  const prog = $('updateProgress');
  if (prog) { prog.hidden = !(status === 'downloading' || status === 'downloaded'); const bar = $('updateProgressBar'); if (bar) bar.style.width = `${status === 'downloaded' ? 100 : pct}%`; }
  const banner = $('updateBanner');
  if (banner) {
    banner.hidden = !['available', 'downloading', 'downloaded', 'installing'].includes(status);
    const v = state.updateInfo?.version || '';
    const title = $('updateBannerTitle');
    if (title) title.textContent = status === 'downloaded' ? `Freesia ${v} is ready` : status === 'downloading' ? `Downloading Freesia ${v}` : `Freesia ${v} is available`;
    const desc = $('updateBannerDesc'); if (desc) desc.textContent = state.message || '';
    const bp = $('updateBannerProgress');
    if (bp) { bp.hidden = status !== 'downloading'; bp.firstElementChild.style.width = `${pct}%`; }
  }
  renderReleaseNotes($('updateBannerNotes'), state, banner ? banner.hidden : true);
  renderReleaseNotes($('settingsUpdateNotes'), state, !['available', 'downloading', 'downloaded', 'installing'].includes(status));
  const hb = $('btnHomeUpdate');
  if (hb) {
    hb.disabled = busy || status === 'disabled';
    hb.textContent = status === 'available' ? 'Download update' : status === 'downloaded' ? 'Restart to update'
      : status === 'downloading' ? `Downloading ${pct}%` : status === 'installing' ? 'Installing…' : 'Check for updates';
  }
}

// "What's new" under an available update, rendered from the release's Markdown
function renderReleaseNotes(el, state, hide) {
  if (!el) return;
  const md = state.updateInfo?.notes || '';
  if (el.dataset.src !== md) {
    el.dataset.src = md;
    el.querySelector('.md').replaceChildren(md && window.FreesiaMarkdown ? window.FreesiaMarkdown.render(md) : '');
  }
  const v = state.updateInfo?.version || '';
  el.querySelector('summary').textContent = v ? `What's new in ${v}` : "What's new";
  el.hidden = hide || !md;
}

async function checkForUpdates() {
  try {
    renderUpdateStatus({ ...updateStatus, status: 'checking', message: 'Checking for updates…' });
    const s = await api.checkForUpdates?.();
    if (s) renderUpdateStatus(s);
  } catch (e) {
    logError('checkForUpdates', e);
    renderUpdateStatus({ status: 'error', message: e.message || 'Update check failed.' });
  }
}

async function downloadUpdate() {
  try {
    renderUpdateStatus({ ...updateStatus, status: 'downloading', message: 'Starting download…' });
    const s = await api.downloadUpdate?.();
    if (s) renderUpdateStatus(s);
  } catch (e) {
    logError('downloadUpdate', e);
    renderUpdateStatus({ status: 'error', message: e.message || 'Update download failed.' });
  }
}

async function installUpdate() {
  if (isRecording || isStartingRecording || isProcessingAudio) { toast('Finish dictating before restarting.', 'info'); return; }
  if (updateStatus.status !== 'downloaded') return;
  const ok = await confirmDialog(`Install Freesia ${updateStatus.updateInfo?.version || ''}?`, 'Freesia closes, installs quietly and reopens in a few seconds.', { ok: 'Restart and update' });
  if (!ok) return;
  try {
    const s = await api.installUpdate?.();
    if (s) renderUpdateStatus(s);
  } catch (e) {
    logError('installUpdate', e);
    renderUpdateStatus({ status: 'error', message: e.message || 'Update install failed.' });
  }
}

// ==========================================================
// IPC from the main process
// ==========================================================
function setupIpcListeners() {
  api.onDictationStart?.(() => startRecording('dictate-inject'));
  api.onDictationStop?.(() => stopRecording());
  api.onCommandStart?.((info) => startRecording('command', { selection: info?.selection || '' }));
  api.onDictationCancel?.(() => stopRecording(true));
}

// Test hooks (pure helpers and state setters; harmless in production)
window.__freesiaTest = {
  normalizeStats, localDateString, formatDuration, buildSnippetInstructions, buildToolInstructions, anyToolEnabled, expandSnippets,
  buildFormatPrompt, stripWrapping, getAllStyles, engineOrder, pickFormatter, isEngineReady, buildAudioConstraints, openMicrophoneStream,
  startRecording, stopRecording, processAudio, renderUpdateStatus, installUpdate, keyFromEvent, spokenLanguage, geminiInstruction,
  applyVocabulary, teachCorrection,
  setSettings: (s) => { settings = s; }, setEngineState: (s) => { engineState = s; }, getSettings: () => settings,
  rewindRecording: (ms) => { if (recordingStartTime) recordingStartTime -= ms; },
  closeReadyMic
};
