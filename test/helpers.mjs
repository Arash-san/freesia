// Shared jsdom bootstrap for the renderer tests.
// Loads the REAL index.html + styles-data.js + app.js with a stubbed
// preload bridge, so tests exercise the same code that ships.
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

export async function boot(overrides = {}) {
  const html = readRenderer('index.html');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

  const settings = Object.assign({
    onboarded: true, apiKey: '', theme: 'dark', aiFormatting: true,
    dictionary: [], snippets: [], history: [], stats: null,
    activeStyle: 'normal', styleOverrides: {}, autoStyleSwitch: false,
    showOverlay: true, sounds: true
  }, overrides);

  const noop = () => {};
  window.freesia = {
    getSettings: async () => JSON.parse(JSON.stringify(settings)),
    setSetting: async () => true,
    getSetting: async (k) => settings[k],
    getThemeInfo: async () => ({ source: 'dark', shouldUseDarkColors: true }),
    setAppTheme: async () => ({ source: 'dark', shouldUseDarkColors: true }),
    getAppVersion: async () => '2.1.0',
    getUpdateStatus: async () => ({ status: 'idle', message: '' }),
    getForegroundApp: async () => '',
    getFailedRecordings: async () => [],
    logToFile: async () => true,
    injectText: async () => true,
    copyText: async () => true,
    overlayTimer: noop,
    onDictationStart: noop, onDictationStop: noop, onDictationCancel: noop,
    onCommandStart: noop, onOverlayState: noop, onOverlayTimer: noop,
    onUpdateStatus: noop, onThemeUpdated: noop
  };

  window.eval(readRenderer('styles-data.js'));
  window.eval(readRenderer('app.js'));

  // Fire the load event and let the async init settle
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 60));

  return { dom, window, document: window.document, settings };
}
