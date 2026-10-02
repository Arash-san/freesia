// Shared jsdom bootstrap for the renderer tests.
// Loads the REAL index.html and renderer scripts with a stubbed preload
// bridge, so tests exercise the same code that ships.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsdomPkg from 'jsdom';

const { JSDOM } = jsdomPkg;
const dir = path.dirname(fileURLToPath(import.meta.url));
export const rendererDir = path.join(dir, '..', 'src', 'renderer');

export function readRenderer(file) {
  return readFileSync(path.join(rendererDir, file), 'utf8');
}

export async function boot(overrides = {}, apiOverrides = {}) {
  const html = readRenderer('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.HTMLCanvasElement.prototype.getContext = () => null;

  const settings = Object.assign({
    onboarded: true, seenV3: true, theme: 'dark', aiFormatting: true, engine: 'cloud', engineFallback: true,
    dictionary: [], snippets: [], history: [], stats: null,
    activeStyle: 'normal', styleOverrides: {}, autoStyleSwitch: false,
    showOverlay: true, sounds: false, microphoneId: ''
  }, overrides);
  const engine = { engine: settings.engine, formatter: 'auto', cloud: { configured: true, username: 'tester', server: 'https://voice.example' }, local: { models: {}, configured: false }, gemini: { configured: false } };
  const calls = { setSetting: [], transcribe: [], format: [], inject: [], copy: [] };
  const noop = () => {};
  window.freesia = {
    getSettings: async () => JSON.parse(JSON.stringify(settings)),
    setSetting: async (k, v) => { calls.setSetting.push([k, v]); return true; },
    getSetting: async (k) => settings[k],
    getThemeInfo: async () => ({ source: 'dark', shouldUseDarkColors: true }),
    setAppTheme: async () => ({ source: 'dark', shouldUseDarkColors: true }),
    getAppVersion: async () => '3.0.0',
    getUpdateStatus: async () => ({ status: 'idle', message: '' }),
    getForegroundApp: async () => '',
    getFailedRecordings: async () => [],
    saveFailedAudio: async () => 'recording-1-test',
    deleteFailedRecording: async () => true,
    logToFile: async () => true,
    sendErrorReport: async () => true,
    injectText: async (t) => { calls.inject.push(t); return true; },
    copyText: async (t) => { calls.copy.push(t); return true; },
    engineStatus: async () => JSON.parse(JSON.stringify(engine)),
    setEngine: async (k, v) => { engine[k] = v; return JSON.parse(JSON.stringify(engine)); },
    transcribe: async (p) => { calls.transcribe.push(p); return { text: 'hello world', engine: p.engine, model: 'Test' }; },
    format: async (p) => { calls.format.push(p); return { text: 'Hello, world.' }; },
    importStylesFromDisk: async () => [],
    recordingState: noop, recordingFailed: noop, overlayTimer: noop, overlayAudioLevel: noop, overlayDone: noop, overlayError: noop, overlayProgress: noop, overlayHide: noop,
    onDictationStart: noop, onDictationStop: noop, onDictationCancel: noop, onCommandStart: noop,
    onUpdateStatus: noop, onThemeUpdated: noop, onLocalStatus: noop, onEngineRetry: noop,
    ...apiOverrides
  };
  window.navigator.mediaDevices = {
    enumerateDevices: async () => [],
    addEventListener: noop,
    getUserMedia: async () => { throw new Error('getUserMedia is not available in unit tests'); }
  };
  for (const f of ['styles-data.js', 'audio-meter.js', 'js/orb.js', 'js/ui.js', 'js/audio.js', 'js/vocab.js', 'js/markdown.js', 'app.js']) window.eval(readRenderer(f));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 80));
  // Let in-flight renderer promises settle before tearing the window down
  const realClose = window.close.bind(window);
  const handle = { window: { close: () => setTimeout(realClose, 250) } };
  return { dom: handle, window, document: window.document, settings, calls, t: window.__freesiaTest };
}
