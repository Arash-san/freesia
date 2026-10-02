import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function clickDialog(document, label) {
  // Skip dialogs that are still playing their exit animation
  const live = () => document.querySelector('.dialog-backdrop:not(.closing) .dialog');
  for (let i = 0; i < 20 && !live(); i++) await settle(10);
  const btn = [...live().querySelectorAll('.btn')].find((b) => b.textContent === label);
  assert.ok(btn, `dialog button "${label}" missing`);
  btn.click();
}

test('dictation pipeline: transcribe, format, inject, record history', async () => {
  const { t, dom, calls, window } = await boot();
  await t.processAudio(new window.Blob(['x'], { type: 'audio/webm' }), 'dictate-inject', { durationSec: 3 });
  assert.equal(calls.transcribe[0].engine, 'cloud');
  assert.equal(calls.format[0].engine, 'cloud');
  assert.deepEqual(calls.inject, ['Hello, world.']);
  assert.equal(t.getSettings().history[0].text, 'Hello, world.');
  assert.equal(t.getSettings().history[0].engine, 'cloud');
  dom.window.close();
});

test('a failing engine falls back to the next configured one', async () => {
  const { t, dom, calls, window } = await boot({ engine: 'cloud' }, {
    engineStatus: async () => ({ engine: 'cloud', formatter: 'off', cloud: { configured: true }, local: { configured: true, models: {} }, gemini: { configured: false } }),
    transcribe: async (p) => { calls.transcribe.push(p.engine); return p.engine === 'cloud' ? { error: { code: 'network', message: 'offline' } } : { text: 'from local', engine: 'local' }; }
  });
  window.FreesiaAudio.toWav16k = async () => ({ wav: new ArrayBuffer(8), durationSec: 1 });
  const calls2 = calls;
  await t.processAudio(new window.Blob(['x']), 'test', { durationSec: 1 });
  assert.deepEqual(calls2.transcribe, ['cloud', 'local']);
  assert.equal(window.document.getElementById('testOutput').textContent.trim(), 'from local');
  dom.window.close();
});

test('when every engine fails the recording is kept and the error is shown', async () => {
  let saved = null;
  const { t, dom, window } = await boot({}, {
    transcribe: async () => ({ error: { code: 'server', message: 'The speech model failed.' } }),
    saveFailedAudio: async (audio, meta) => { saved = meta; return 'recording-1-x'; }
  });
  await t.processAudio(new window.Blob(['x']), 'dictate-inject', { durationSec: 5 });
  assert.match(saved.error, /speech model failed/);
  assert.match(window.document.getElementById('testOutput').textContent, /saved in History/);
  dom.window.close();
});

test('retried recordings go to the clipboard, never pasted into a random app', async () => {
  const { t, dom, calls, window } = await boot();
  await t.processAudio(new window.Blob(['x']), 'retry', { existingBase: 'recording-1-x', durationSec: 2 });
  assert.equal(calls.inject.length, 0);
  assert.deepEqual(calls.copy, ['Hello, world.']);
  dom.window.close();
});

test('formatting failure never loses the transcript', async () => {
  const { t, dom, calls, window } = await boot({}, { format: async () => ({ error: { code: 'timeout', message: 'slow' } }) });
  await t.processAudio(new window.Blob(['x']), 'dictate-inject', { durationSec: 2 });
  assert.deepEqual(calls.inject, ['hello world']);
  dom.window.close();
});

test('Gemini gets a translation instruction for the Native Language style', async () => {
  const { t, dom } = await boot({ activeStyle: 'native', nativeLanguage: 'fa' });
  assert.match(t.geminiInstruction(t.getAllStyles().find((s) => s.id === 'native')), /Persian.*translate it into fluent, natural English/s);
  assert.equal(t.spokenLanguage(t.getAllStyles().find((s) => s.id === 'native')), 'fa');
  dom.window.close();
});

test('unplugged microphone falls back; denied permission does not retry', async () => {
  const { t, dom, window } = await boot({ microphoneId: 'usb' });
  let calls = 0;
  const stream = { getTracks: () => [] };
  window.navigator.mediaDevices.getUserMedia = async ({ audio }) => { calls++; if (audio.deviceId) throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); return stream; };
  assert.equal(await t.openMicrophoneStream(), stream);
  assert.equal(calls, 2);
  t.setSettings({ microphoneId: 'usb' }); calls = 0;
  window.navigator.mediaDevices.getUserMedia = async () => { calls++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  await assert.rejects(t.openMicrophoneStream(), /denied/);
  assert.equal(calls, 1);
  dom.window.close();
});

test('update button reflects state and install asks first in a dialog', async () => {
  let installs = 0;
  const { t, dom, document } = await boot({}, { installUpdate: async () => { installs++; return null; } });
  t.renderUpdateStatus({ status: 'downloaded', updateInfo: { version: '3.1.0' } });
  assert.equal(document.getElementById('btnHomeUpdate').textContent, 'Restart to update');
  const first = t.installUpdate();
  await clickDialog(document, 'Cancel');
  await first;
  assert.equal(installs, 0);
  const second = t.installUpdate();
  await clickDialog(document, 'Restart and update');
  await second;
  assert.equal(installs, 1);
  t.renderUpdateStatus({ status: 'downloading', progress: { percent: 42 } });
  assert.equal(document.getElementById('btnHomeUpdate').disabled, true);
  assert.match(document.getElementById('btnHomeUpdate').textContent, /42/);
  dom.window.close();
});

test('onboarding and settings share the error-report choice', async () => {
  const { dom, document, window } = await boot({ onboarded: false, errorReporting: true });
  const toggle = document.getElementById('onboardingErrorReporting');
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change'));
  assert.equal(document.getElementById('toggleErrorReporting').checked, false);
  dom.window.close();
});

test('a dictionary word with an apostrophe can be removed (2.x could not)', async () => {
  const { dom, document } = await boot({ dictionary: ["O'Brien", 'GRPO'] });
  const chip = [...document.querySelectorAll('#dictionaryList .chip')].find((c) => c.textContent.includes("O'Brien"));
  chip.querySelector('.x').click();
  await settle();
  assert.ok(![...document.querySelectorAll('#dictionaryList .chip')].some((c) => c.textContent.includes("O'Brien")));
  dom.window.close();
});

test('stopping during microphone permission releases the late stream', async () => {
  const { t, dom, window } = await boot();
  let release;
  let stopped = 0;
  window.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { release = r; });
  const starting = t.startRecording('test');
  t.stopRecording(true);
  release({ getTracks: () => [{ stop: () => stopped++ }], getAudioTracks: () => [] });
  await starting;
  assert.equal(stopped, 1);
  dom.window.close();
});

test('Native Language on the cloud asks the server to translate and skips reformatting', async () => {
  const { t, dom, calls, window } = await boot({ activeStyle: 'native', nativeLanguage: 'fa' }, {
    transcribe: async (p) => { calls.transcribe.push(p); return { text: 'Hello from Persian.', engine: 'cloud', translated: true }; }
  });
  await t.processAudio(new window.Blob(['x']), 'dictate-inject', { durationSec: 3 });
  assert.equal(calls.transcribe[0].task, 'translate');
  assert.equal(calls.transcribe[0].language, 'fa');
  assert.equal(calls.format.length, 0);
  assert.deepEqual(calls.inject, ['Hello from Persian.']);
  dom.window.close();
});

// A fake microphone + MediaRecorder: one chunk of audio, stopped on demand
function fakeRecorder(window) {
  window.AudioContext = class {
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
  window.MediaRecorder = class {
    constructor() { this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new window.Blob(['opus']) }); setTimeout(() => this.onstop(), 0); }
  };
  window.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ addEventListener() {} }] });
}

async function cancelAfter(seconds, settingsOverride = {}) {
  const saved = [];
  const { t, dom, window } = await boot(settingsOverride, { saveFailedAudio: async (audio, meta) => { saved.push(meta); return 'recording-esc'; } });
  fakeRecorder(window);
  await t.startRecording('dictate-inject');
  t.rewindRecording(seconds * 1000); // as if the take had run this long
  t.stopRecording(true); // what Esc does
  await settle(60);
  dom.window.close();
  return saved;
}

test('Esc keeps the recording in History by default (nothing is transcribed or typed)', async () => {
  const saved = await cancelAfter(95);
  assert.equal(saved.length, 1);
  assert.match(saved[0].error, /Cancelled with Esc/);
  assert.equal(saved[0].duration, '1:35');
});

test('Esc discards the recording when the user turned keeping off, and ignores a tiny slip', async () => {
  assert.equal((await cancelAfter(30, { keepCancelledRecordings: false })).length, 0);
  assert.equal((await cancelAfter(0.5)).length, 0);
});
