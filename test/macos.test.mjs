import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { macAppKey, MAC_ALIASES } = require('../src/main/mac-apps.js');
const { pickDevice, RUNTIMES } = require('../src/main/local-engine.js');

test('macOS bundle names map onto the per-app style keys', () => {
  assert.equal(macAppKey('/Applications/Google Chrome.app'), 'chrome');
  assert.equal(macAppKey('/Applications/Microsoft Outlook.app'), 'outlook');
  assert.equal(macAppKey('/Applications/Visual Studio Code.app'), 'code');
  assert.equal(macAppKey('/Applications/Slack.app'), 'slack');
  assert.equal(macAppKey('Safari'), 'safari');
  assert.equal(macAppKey(''), '');
});

test('macOS aliases only point at keys the style map knows', () => {
  globalThis.window = {};
  require('../src/renderer/styles-data.js');
  const known = new Set(Object.keys(globalThis.window.APP_STYLE_MAP));
  for (const [name, key] of Object.entries(MAC_ALIASES)) assert.ok(known.has(key), `${name} → ${key}`);
  delete globalThis.window;
});

test('local engine picks the Metal device on Apple silicon', () => {
  const out = 'Available devices:\n  MTL0: Apple M3 Pro (27648 MiB, 27647 MiB free)';
  assert.equal(pickDevice(out).best.id, 'MTL0');
});

test('every on-device runtime is pinned to a checksum and archive type', () => {
  for (const key of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
    const r = RUNTIMES[key];
    assert.match(r.sha256, /^[0-9a-f]{64}$/, key);
    assert.ok(r.size > 1e6, key);
    assert.ok(['zip', 'tar.gz'].includes(r.archive), key);
    assert.ok(r.url.endsWith(r.archive), key);
  }
  assert.equal(RUNTIMES['darwin-arm64'].exe, 'llama-server');
});
