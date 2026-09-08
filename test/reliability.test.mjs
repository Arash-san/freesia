import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('API deadline aborts stalled requests instead of waiting indefinitely', async () => {
  const { window, dom } = await boot();
  window.fetch = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(window.__freesiaTest.fetchJsonWithTimeout('https://example.test', {}, 15), /timed out/);
  dom.window.close();
});
test('text extraction skips thinking parts and joins all output parts', async () => {
  const { window, dom } = await boot();
  assert.equal(window.__freesiaTest.responseText({ candidates: [{ content: { parts: [
    { text: 'private reasoning', thought: true }, { text: 'Hello ' }, { text: 'world' }
  ] } }] }), 'Hello world'); dom.window.close();
});
test('formatting uses the successful fallback model; errors preserve the transcript', async () => {
  const { window, dom } = await boot(); let url;
  window.fetch = async u => { url = u; return { ok: false, status: 503, json: async () => ({}) }; };
  const text = await window.__freesiaTest.formatWithAI('Keep these words', 'dictate', 'gemini-3.5-flash-lite');
  assert.match(url, /gemini-3.5-flash-lite/); assert.equal(text, 'Keep these words'); dom.window.close();
});
test('unplugged microphone falls back, but denied permission does not retry another device', async () => {
  const { window, dom } = await boot({ microphoneId: 'usb' }); let calls = 0;
  const stream = {};
  window.navigator.mediaDevices.getUserMedia = async constraints => {
    calls++; if (calls === 1) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    assert.equal(constraints.audio, true); return stream;
  };
  assert.equal(await window.__freesiaTest.openMicrophoneStream(), stream); assert.equal(calls, 2);
  window.__freesiaTest.setSettings({ microphoneId: 'usb' }); calls = 0;
  window.navigator.mediaDevices.getUserMedia = async () => { calls++; throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  await assert.rejects(window.__freesiaTest.openMicrophoneStream(), /denied/); assert.equal(calls, 1); dom.window.close();
});
test('Home update action reflects status and asks for confirmation before installation', async () => {
  const { window, document, dom } = await boot(); let installs = 0;
  window.freesia.installUpdate = async () => { installs++; };
  window.__freesiaTest.renderUpdateStatus({ status: 'downloaded', updateInfo: { version: '2.4.0' } });
  assert.equal(document.getElementById('btnHomeUpdate').textContent, 'Restart to update');
  window.confirm = () => false; await window.__freesiaTest.installUpdate(); assert.equal(installs, 0);
  window.confirm = () => true; await window.__freesiaTest.installUpdate(); assert.equal(installs, 1);
  window.__freesiaTest.renderUpdateStatus({ status: 'downloading', progress: { percent: 42 } });
  assert.equal(document.getElementById('btnHomeUpdate').disabled, true);
  assert.match(document.getElementById('btnHomeUpdate').textContent, /42/); dom.window.close();
});
test('diagnostic choice is visible in onboarding and stays synchronized with Settings', async () => {
  const { window, document, dom } = await boot({ errorReporting: true });
  const toggle = document.getElementById('onboardingErrorReporting');
  assert.equal(toggle.checked, true); toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change'));
  assert.equal(document.getElementById('toggleErrorReporting').checked, false); dom.window.close();
  const existing = await boot({ errorReporting: false });
  assert.equal(existing.document.getElementById('onboardingErrorReporting').checked, false); existing.dom.window.close();
});

test('stopping during microphone permission releases the late stream without starting audio', async () => {
  const { window, dom } = await boot(); let resolve, stopped = 0;
  window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {} });
  window.navigator.mediaDevices.getUserMedia = () => new Promise(r => resolve = r);
  const starting = window.__freesiaTest.startRecording();
  window.__freesiaTest.stopRecording(true);
  resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await starting; assert.equal(stopped, 1); dom.window.close();
});

test('recorder construction failure releases the microphone and audio context', async () => {
  const { window, dom } = await boot(); let stopped = 0, closed = 0, failed = 0;
  window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {} });
  const track = { stop: () => stopped++ };
  window.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track] });
  window.AudioContext = class {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { frequencyBinCount: 1024, getFloatTimeDomainData(a) { a.fill(0); } }; }
    async resume() {} async close() { closed++; }
  };
  window.MediaRecorder = class { constructor() { throw new Error('recorder unavailable'); } };
  window.freesia.recordingFailed = () => failed++;
  await window.__freesiaTest.startRecording();
  assert.equal(stopped, 1); assert.equal(closed, 1); assert.equal(failed, 1); dom.window.close();
});

test('overloaded transcription falls back once and formatting reuses the working model', async () => {
  const { window, dom } = await boot(); let saves = [], urls = [], deleted = [];
  window.__freesiaTest.setSettings({apiKey:'test',geminiModel:'gemini-3.7-flash',dictionary:[],history:[],snippets:[]});
  window.freesia.saveFailedAudio = async (...args) => { saves.push(args); return 'recording-test'; };
  window.freesia.deleteFailedRecording = async base => deleted.push(base);
  window.freesia.overlayDone = () => {}; window.freesia.overlayError = () => {};
  window.fetch = async (url, options) => {
    urls.push(url); const first = urls.length === 1;
    return { ok: !first, status: first ? 503 : 200, json: async () => first
      ? { error: { message: 'High demand' } }
      : { candidates: [{ content: { parts: [{ text: 'Hello world' }] } }] } };
  };
  await window.__freesiaTest.processAudio({ arrayBuffer: async () => new Uint8Array([1,2,3]).buffer }, 'dictate');
  assert.equal(urls.length, 3);
  assert.equal(urls[1], urls[2], 'formatting reuses successful fallback');
  assert.equal(saves.length, 1); assert.deepEqual(deleted, ['recording-test']);
  assert.ok(!window.__freesiaTest.buildTranscribeModels('gemini-3.7-flash').includes('gemini-3.7-flash'), 'unhealthy primary cools down');
  dom.window.close();
});

test('quota failure preserves the existing recording and updates metadata without duplicating audio', async () => {
  const { window, dom } = await boot(); let saves = [], deleted = [], calls = 0;
  window.freesia.saveFailedAudio = async (...args) => { saves.push(args); return 'recording-original'; };
  window.freesia.deleteFailedRecording = async base => deleted.push(base);
  window.freesia.overlayError = () => {};
  window.fetch = async () => { calls++; return { ok:false,status:429,json:async()=>({error:{message:'Quota exceeded'}}) }; };
  await window.__freesiaTest.processAudio({ arrayBuffer: async () => new Uint8Array([1]).buffer }, 'dictate', 'recording-original');
  assert.equal(calls, 1); assert.equal(deleted.length, 0);
  assert.equal(saves.length, 2);
  for (const [audio,,base] of saves) { assert.equal(audio, null); assert.equal(base, 'recording-original'); }
  assert.match(saves[1][1].error, /Quota exceeded/); dom.window.close();
});
