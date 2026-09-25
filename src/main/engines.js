// Transcription and formatting engines that run in the main process, so
// API keys and tokens never reach the renderer.
//   cloud  - a Freesia Voice server the user signs in to (Freesia Cloud)
//   gemini - Google Gemini with the user's own key
// The on-device engine lives in local-engine.js.

class EngineError extends Error {
  // code: auth | quota | busy | model | timeout | network | server | config | audio
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Long recordings need proportionally longer deadlines; the fixed 25 s
// deadline in 2.x made every recording over ~3 minutes fail.
function deadlineFor(engine, durationSec = 0) {
  const d = Math.max(0, Number(durationSec) || 0);
  if (engine === 'gemini') return Math.min(300000, 30000 + d * 600);
  if (engine === 'local') return Math.min(600000, 30000 + d * 400);
  return Math.min(300000, 20000 + d * 250);
}

async function fetchWithDeadline(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new EngineError('timeout', `No answer after ${Math.round(timeoutMs / 1000)} seconds`);
    throw new EngineError('network', 'Could not reach the server. Check your connection.', { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

// ------------------------------------------------------------------ cloud
const DEFAULT_CLOUD_SERVER = '';

function normalizeServer(url) {
  let u;
  const raw = String(url || '').trim();
  if (!raw) throw new EngineError('config', 'Enter your server address, for example https://voice.example.com');
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new EngineError('config', 'That server address is not a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new EngineError('config', 'The server must use https://');
  return u.origin;
}

function createCloudEngine({ store, secrets, fetchImpl = (...a) => fetch(...a), log = () => {} }) {
  const account = () => store.get('cloud') || {};
  const token = () => {
    const acct = account();
    return acct.server ? secrets.get('cloud') : '';
  };

  async function call(path, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
    const acct = account();
    const tok = token();
    if (!acct.server || !tok) throw new EngineError('config', 'Sign in to Freesia Cloud first.');
    const res = await fetchWithDeadline(fetchImpl, acct.server + path, {
      method, body, headers: { Authorization: `Bearer ${tok}`, ...headers }
    }, timeoutMs);
    const data = await readJson(res);
    if (res.ok) return data;
    const msg = data.error?.message || `Server error (${res.status})`;
    if (res.status === 401) {
      secrets.set('cloud', '');
      store.set('cloud', { ...acct, username: acct.username, signedOut: true });
      throw new EngineError('auth', 'Your Freesia Cloud session ended. Sign in again.');
    }
    if (res.status === 429) throw new EngineError('busy', msg);
    if (res.status === 413 || res.status === 400) throw new EngineError('audio', msg);
    throw new EngineError('server', msg, { httpStatus: res.status });
  }

  return {
    id: 'cloud',
    status() {
      const acct = account();
      return { configured: !!token(), server: acct.server || DEFAULT_CLOUD_SERVER, username: acct.username || '', signedOut: !!acct.signedOut };
    },
    async login(serverUrl, username, password, deviceName) {
      const server = normalizeServer(serverUrl);
      const res = await fetchWithDeadline(fetchImpl, `${server}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, device: deviceName || 'Freesia desktop' })
      }, 20000);
      const data = await readJson(res);
      if (!res.ok || !data.token) {
        throw new EngineError(res.status === 429 ? 'busy' : 'auth', data.error?.message || `Sign-in failed (${res.status})`);
      }
      secrets.set('cloud', data.token);
      store.set('cloud', { server, username: data.username });
      log('INFO', 'cloud', `Signed in to ${server} as ${data.username}`);
      return this.status();
    },
    async logout() {
      try { await call('/api/auth/logout', { method: 'POST', timeoutMs: 6000 }); } catch { /* token may already be gone */ }
      secrets.set('cloud', '');
      const acct = account();
      store.set('cloud', { server: acct.server || DEFAULT_CLOUD_SERVER, username: '' });
      return this.status();
    },
    async health() {
      const t = Date.now();
      const me = await call('/api/me', { timeoutMs: 8000 });
      return { ok: true, latencyMs: Date.now() - t, username: me.username, model: me.asrModel, formattingModel: me.formattingModel };
    },
    async transcribe({ audio, mime = 'audio/webm', language, prompt, durationSec }) {
      const form = new FormData();
      const ext = mime.includes('wav') ? 'wav' : 'webm';
      form.append('file', new Blob([audio], { type: mime }), `dictation.${ext}`);
      if (language && language !== 'auto') form.append('language', language);
      if (prompt) form.append('prompt', prompt.slice(0, 800));
      const data = await call('/v1/audio/transcriptions', { method: 'POST', body: form, timeoutMs: deadlineFor('cloud', durationSec) });
      return { text: String(data.text || '').trim(), model: data.model || 'Qwen3-ASR-1.7B' };
    },
    async format(prompt, { temperature = 0.3, timeoutMs = 30000 } = {}) {
      const data = await call('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature }),
        timeoutMs
      });
      return String(data.choices?.[0]?.message?.content || '').trim();
    }
  };
}

// ------------------------------------------------------------------ gemini
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const PREFERRED_GEMINI_MODELS = [DEFAULT_GEMINI_MODEL, 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash'];
const TRANSCRIBE_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const BLOCKED_MODEL = /embedding|aqa|imagen|veo|image|tts|live|computer|learnlm|nano.?banana|robotics/i;

function normalizeModelId(id) { return String(id || '').replace(/^models\//, '').toLowerCase(); }

// Selected model first, then stable Flash models this key can actually use.
function buildTranscribeModels(primary, discovered = [], cooldowns = new Map(), now = Date.now()) {
  const found = discovered.map((m) => normalizeModelId(typeof m === 'string' ? m : m?.id))
    .filter((id) => id.startsWith('gemini-3') && id.includes('flash') && !/preview|experimental|latest/.test(id) && !BLOCKED_MODEL.test(id));
  const fallbacks = discovered.length ? found : TRANSCRIBE_FALLBACK_MODELS;
  const models = [...new Set([normalizeModelId(primary), ...fallbacks].filter(Boolean))];
  const healthy = models.filter((id) => !(cooldowns.get(id) > now));
  return (healthy.length ? healthy : models).slice(0, 3);
}

function responseText(data) {
  return (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text).join('').trim();
}

function classifyGemini(status, message) {
  const m = String(message || '').toLowerCase();
  if (/credits are depleted|billing|quota|exceeded your current/.test(m)) {
    return new EngineError('quota', 'Your Gemini credits or quota are used up. Switch engines or check Google AI Studio.');
  }
  if (status === 400 && /api key/.test(m)) return new EngineError('auth', 'Gemini rejected the API key.');
  if (status === 401 || status === 403) return new EngineError('auth', 'Gemini rejected the API key.');
  if (status === 404 || /no longer available|not found/.test(m)) return new EngineError('model', message, { httpStatus: status });
  if (status === 429 || status === 503 || /high demand|overloaded/.test(m)) return new EngineError('busy', 'Gemini is overloaded right now.', { httpStatus: status });
  if (status >= 500) return new EngineError('server', message || 'Gemini had an internal error.', { httpStatus: status });
  return new EngineError('server', message || `Gemini error ${status}`, { httpStatus: status });
}

function createGeminiEngine({ store, secrets, fetchImpl = (...a) => fetch(...a), log = () => {} }) {
  const cooldowns = new Map();
  let discovered = [];

  async function generate(model, parts, timeoutMs, generationConfig) {
    const key = secrets.get('gemini');
    if (!key) throw new EngineError('config', 'Add a Gemini API key first.');
    const res = await fetchWithDeadline(fetchImpl, `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], ...(generationConfig ? { generationConfig } : {}) })
    }, timeoutMs);
    const data = await readJson(res);
    if (!res.ok) throw classifyGemini(res.status, data.error?.message);
    return responseText(data);
  }

  return {
    id: 'gemini',
    status() {
      const key = secrets.get('gemini');
      return { configured: !!key, keyPreview: key ? `${key.slice(0, 6)}••••${key.slice(-3)}` : '', model: store.get('geminiModel') || DEFAULT_GEMINI_MODEL, models: discovered };
    },
    async setKey(key) {
      key = String(key || '').trim();
      if (!key) { secrets.set('gemini', ''); discovered = []; return this.status(); }
      const res = await fetchWithDeadline(fetchImpl, `${GEMINI_BASE}/models?pageSize=100`, { headers: { 'x-goog-api-key': key } }, 12000);
      const data = await readJson(res);
      if (!res.ok) throw classifyGemini(res.status, data.error?.message || 'Invalid API key');
      secrets.set('gemini', key);
      discovered = parseModels(data);
      const current = store.get('geminiModel');
      if (!current || !discovered.some((m) => m.id === current)) {
        const best = PREFERRED_GEMINI_MODELS.find((id) => discovered.some((m) => m.id === id)) || discovered[0]?.id || DEFAULT_GEMINI_MODEL;
        store.set('geminiModel', best);
      }
      return this.status();
    },
    async refreshModels() {
      const key = secrets.get('gemini');
      if (!key) return [];
      const res = await fetchWithDeadline(fetchImpl, `${GEMINI_BASE}/models?pageSize=100`, { headers: { 'x-goog-api-key': key } }, 12000);
      if (res.ok) discovered = parseModels(await readJson(res));
      return discovered;
    },
    async transcribe({ audio, mime = 'audio/webm', instruction, durationSec, onRetry }) {
      const models = buildTranscribeModels(store.get('geminiModel') || DEFAULT_GEMINI_MODEL, discovered, cooldowns);
      const parts = [{ inlineData: { mimeType: mime.split(';')[0], data: Buffer.from(audio).toString('base64') } }, { text: instruction }];
      let last;
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        try {
          if (i > 0) onRetry?.(model);
          const text = await generate(model, parts, deadlineFor('gemini', durationSec));
          cooldowns.delete(model);
          return { text, model };
        } catch (e) {
          last = e;
          log('WARN', 'gemini', `${model}: ${e.code} ${e.message}`);
          if (['model', 'busy', 'server', 'timeout'].includes(e.code)) {
            cooldowns.set(model, Date.now() + (e.code === 'model' ? 3600000 : 120000));
            continue;
          }
          throw e;
        }
      }
      throw last;
    },
    async format(prompt, { temperature = 0.3, timeoutMs = 20000 } = {}) {
      const model = store.get('geminiModel') || DEFAULT_GEMINI_MODEL;
      return generate(model, [{ text: prompt }], timeoutMs, { temperature });
    }
  };
}

function parseModels(data) {
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: normalizeModelId(m.name), name: m.displayName || normalizeModelId(m.name), description: m.description || '' }))
    .filter((m) => m.id.startsWith('gemini') && !BLOCKED_MODEL.test(`${m.id} ${m.name} ${m.description}`))
    .sort((a, b) => {
      const pa = PREFERRED_GEMINI_MODELS.indexOf(a.id); const pb = PREFERRED_GEMINI_MODELS.indexOf(b.id);
      if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      const va = parseFloat((a.id.match(/(\d+\.\d+)/) || [])[1] || 0); const vb = parseFloat((b.id.match(/(\d+\.\d+)/) || [])[1] || 0);
      return vb - va;
    });
}

module.exports = {
  EngineError, deadlineFor, createCloudEngine, createGeminiEngine, normalizeServer,
  buildTranscribeModels, responseText, classifyGemini, parseModels,
  DEFAULT_CLOUD_SERVER, DEFAULT_GEMINI_MODEL, TRANSCRIBE_FALLBACK_MODELS
};
