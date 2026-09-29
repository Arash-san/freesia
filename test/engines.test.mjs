import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCloudEngine, createGeminiEngine, deadlineFor, normalizeServer, buildTranscribeModels, classifyGemini, responseText } = require('../src/main/engines.js');
const { pickDevice, cleanText, MODELS } = require('../src/main/local-engine.js');
const { parseWav, encodeWav, splitAtPauses } = require('../src/main/wav.js');

function memoryStore(init = {}) {
  const data = { ...init };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; }, data };
}
function memorySecrets() {
  const s = {};
  return { get: (k) => s[k] || '', set: (k, v) => { if (v) s[k] = v; else delete s[k]; }, s };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('deadlines grow with recording length (fixed 25 s broke long dictation)', () => {
  assert.ok(deadlineFor('gemini', 300) > 150000);
  assert.ok(deadlineFor('cloud', 0) >= 20000);
  assert.ok(deadlineFor('local', 600) <= 600000);
});

test('cloud servers must use https except on localhost', () => {
  assert.equal(normalizeServer('https://voice.example.com/'), 'https://voice.example.com');
  assert.equal(normalizeServer('voice.example.com'), 'https://voice.example.com');
  assert.throws(() => normalizeServer(''), /server address/);
  assert.equal(normalizeServer('http://127.0.0.1:8798'), 'http://127.0.0.1:8798');
  assert.throws(() => normalizeServer('http://voice.example.com'), /https/);
});

test('cloud login stores the token as a secret and sends it as a bearer', async () => {
  const store = memoryStore();
  const secrets = memorySecrets();
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    if (url.endsWith('/api/auth/login')) return json(200, { username: 'arash', token: 'fv_abc' });
    return json(200, { text: ' hello ', model: 'Qwen3-ASR-1.7B' });
  };
  const cloud = createCloudEngine({ store, secrets, fetchImpl });
  const st = await cloud.login('https://voice.example', 'arash', 'pw', 'dev');
  assert.equal(st.configured, true);
  assert.equal(secrets.s.cloud, 'fv_abc');
  assert.equal(store.data.cloud.token, undefined, 'token never stored in plain settings');
  const out = await cloud.transcribe({ audio: Buffer.from('x'), language: 'en', prompt: 'GRPO', durationSec: 3 });
  assert.equal(out.text, 'hello');
  assert.equal(seen[1].opts.headers.Authorization, 'Bearer fv_abc');
});

test('a revoked cloud token signs the device out', async () => {
  const store = memoryStore({ cloud: { server: 'https://voice.example', username: 'a' } });
  const secrets = memorySecrets();
  secrets.set('cloud', 'fv_old');
  const cloud = createCloudEngine({ store, secrets, fetchImpl: async () => json(401, { error: { message: 'Session expired' } }) });
  await assert.rejects(cloud.transcribe({ audio: Buffer.from('x') }), (e) => e.code === 'auth');
  assert.equal(secrets.get('cloud'), '');
  assert.equal(cloud.status().configured, false);
});

test('Gemini errors are classified so the app reacts correctly', () => {
  assert.equal(classifyGemini(429, 'Your prepayment credits are depleted.').code, 'quota');
  assert.equal(classifyGemini(503, 'This model is currently experiencing high demand.').code, 'busy');
  assert.equal(classifyGemini(404, 'models/gemini-2.0-flash is no longer available').code, 'model');
  assert.equal(classifyGemini(400, 'API key not valid').code, 'auth');
});

test('Gemini sends the key in a header, never in the URL', async () => {
  const store = memoryStore({ geminiModel: 'gemini-3.5-flash-lite' });
  const secrets = memorySecrets();
  secrets.set('gemini', 'AIzaTESTKEY1234567890');
  let seen;
  const gemini = createGeminiEngine({ store, secrets, fetchImpl: async (url, opts) => { seen = { url, opts }; return json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }); } });
  await gemini.transcribe({ audio: Buffer.from('x'), instruction: 'Transcribe', durationSec: 2 });
  assert.doesNotMatch(seen.url, /key=/);
  assert.equal(seen.opts.headers['x-goog-api-key'], 'AIzaTESTKEY1234567890');
});

test('Gemini rotates to another model when one is overloaded', async () => {
  const store = memoryStore({ geminiModel: 'gemini-3.5-flash-lite' });
  const secrets = memorySecrets();
  secrets.set('gemini', 'k');
  const tried = [];
  const gemini = createGeminiEngine({ store, secrets, fetchImpl: async (url) => {
    tried.push(url.match(/models\/([^:]+)/)[1]);
    return tried.length === 1 ? json(503, { error: { message: 'high demand' } }) : json(200, { candidates: [{ content: { parts: [{ text: 'done' }] } }] });
  } });
  const out = await gemini.transcribe({ audio: Buffer.from('x'), instruction: 'T' });
  assert.equal(out.text, 'done');
  assert.equal(tried.length, 2);
  assert.notEqual(tried[0], tried[1]);
});

test('Gemini quota errors stop immediately instead of hammering fallbacks', async () => {
  const store = memoryStore({});
  const secrets = memorySecrets();
  secrets.set('gemini', 'k');
  let n = 0;
  const gemini = createGeminiEngine({ store, secrets, fetchImpl: async () => { n++; return json(429, { error: { message: 'Your prepayment credits are depleted.' } }); } });
  await assert.rejects(gemini.transcribe({ audio: Buffer.from('x'), instruction: 'T' }), (e) => e.code === 'quota');
  assert.equal(n, 1);
});

test('transcription model list prefers discovered stable Flash models', () => {
  const models = buildTranscribeModels('gemini-3.5-flash-lite', [{ id: 'gemini-3.6-flash' }, { id: 'gemini-3-flash-preview' }, { id: 'gemini-3.1-flash-lite' }]);
  assert.deepEqual(models, ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite']);
  assert.equal(responseText({ candidates: [{ content: { parts: [{ text: 'a', thought: true }, { text: 'b' }] } }] }), 'b');
});

test('local engine picks the strongest discrete GPU and ignores integrated graphics', () => {
  const out = `Available devices:
  Vulkan0: Intel(R) UHD Graphics 770 (16264 MiB, 16000 MiB free)
  Vulkan1: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 7400 MiB free)`;
  assert.equal(pickDevice(out).best.id, 'Vulkan1');
  assert.equal(pickDevice('Available devices:\n  Vulkan0: Intel(R) Iris(R) Xe Graphics (8000 MiB, 7000 MiB free)').best, null);
});

test('local engine strips the Qwen3-ASR language prefix', () => {
  assert.equal(cleanText('language English<asr_text>Hello there.'), 'Hello there.');
  assert.equal(cleanText('Plain text'), 'Plain text');
  for (const m of Object.values(MODELS)) for (const f of m.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test('long audio is split at the quietest moment, never mid-word', () => {
  const rate = 16000;
  const total = rate * 700;
  const samples = new Int16Array(total);
  for (let i = 0; i < total; i++) samples[i] = Math.round(8000 * Math.sin(i / 7));
  // a silent gap at 290 s
  samples.fill(0, rate * 290, rate * 291);
  const chunks = splitAtPauses(samples, rate, 300);
  assert.ok(chunks.length >= 2);
  const firstCut = chunks[0].length / rate;
  assert.ok(firstCut > 290 && firstCut < 291, `cut at ${firstCut}`);
  assert.equal(chunks.reduce((s, c) => s + c.length, 0), total);
  const round = parseWav(encodeWav(chunks[1], rate));
  assert.equal(round.samples.length, chunks[1].length);
  assert.equal(round.sampleRate, rate);
});

const vocab = require('../src/renderer/js/vocab.js');
test('vocabulary fixes split, hyphenated and spelled-out terms', () => {
  const dict = ['PyTorch', 'Qwen3-ASR', 'Claude Opus', 'GRPO'];
  assert.equal(vocab.apply('The Py Torch model', dict), 'The PyTorch model');
  assert.equal(vocab.apply('install p y t o r c h', dict), 'install PyTorch');
  assert.equal(vocab.apply('we deployed qwen 3 asr', dict), 'we deployed Qwen3-ASR');
  assert.equal(vocab.apply('ask C L A U D E O P U S', dict), 'ask Claude Opus');
  assert.equal(vocab.apply('the grpo run', dict), 'the GRPO run');
});

test('taught corrections apply, longest first, on word boundaries only', () => {
  const corr = [{ from: 'clodopus', to: 'Claude Opus' }, { from: 'cloud opus five', to: 'Claude Opus 5' }];
  assert.equal(vocab.apply('compare Clodopus', [], corr), 'compare Claude Opus');
  assert.equal(vocab.apply('use cloud opus five', [], corr), 'use Claude Opus 5');
  assert.equal(vocab.apply('xclodopusx stays', [], corr), 'xclodopusx stays');
});

test('plain dictionary words do not recapitalize ordinary text', () => {
  assert.equal(vocab.apply('the lab is open', ['Lab']), 'the lab is open');
  assert.equal(vocab.apply('Persian: سلام دنیا', ['Lab']), 'Persian: سلام دنیا');
});

test('Native Language uses the server translation endpoint and falls back on older servers', async () => {
  const store = memoryStore({ cloud: { server: 'https://voice.example', username: 'a' } });
  const secrets = memorySecrets();
  secrets.set('cloud', 'fv_tok');
  const paths = [];
  const cloud = createCloudEngine({ store, secrets, fetchImpl: async (url) => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/v1/audio/translations')) return json(200, { text: 'Hello there.', source_text: 'سلام', model: 'Whisper + MiLMMT' });
    return json(200, { text: 'plain' });
  } });
  const out = await cloud.transcribe({ audio: Buffer.from('x'), language: 'fa', task: 'translate' });
  assert.equal(out.text, 'Hello there.');
  assert.equal(out.translated, true);
  assert.deepEqual(paths, ['/v1/audio/translations']);

  const old = createCloudEngine({ store, secrets, fetchImpl: async (url) => url.endsWith('/translations') ? json(404, { error: { message: 'Not Found' } }) : json(200, { text: 'سلام' }) });
  const fb = await old.transcribe({ audio: Buffer.from('x'), language: 'fa', task: 'translate' });
  assert.equal(fb.text, 'سلام');
  assert.equal(fb.translated, undefined);

  // Spoken in English: the server says it did not translate, so the app formats it as usual
  const en = createCloudEngine({ store, secrets, fetchImpl: async () => json(200, { text: 'I said this in English.', translated: false, language: 'en' }) });
  const eo = await en.transcribe({ audio: Buffer.from('x'), language: 'fa', task: 'translate' });
  assert.equal(eo.text, 'I said this in English.');
  assert.equal(eo.translated, false);
});
