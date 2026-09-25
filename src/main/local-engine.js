// On-device transcription: Qwen3-ASR (GGUF) served by a bundled llama.cpp
// Vulkan build. Nothing is installed system-wide; the runtime and model live
// in %APPDATA%\freesia\engines and are verified by SHA-256 after download.
// The server listens on 127.0.0.1 with a random API key, so neither other
// local programs nor web pages can use it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { EngineError, deadlineFor } = require('./engines');
const { parseWav, encodeWav, splitAtPauses } = require('./wav');

const RUNTIME = {
  version: 'b11182',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11182/llama-b11182-bin-win-vulkan-x64.zip',
  sha256: 'aceb42215efc1c85acb3e10e5cb9d9d2bf9e49541b21873e54d66ddb9f97cd0a',
  size: 32460984
};

const HF = 'https://huggingface.co/ggml-org';
const MODELS = {
  'qwen3-asr-1.7b': {
    label: 'Qwen3-ASR 1.7B',
    blurb: 'Best accuracy. Wants a GPU with 4 GB or more; runs on CPU too.',
    vramGB: 3.6,
    files: [
      { name: 'Qwen3-ASR-1.7B-Q8_0.gguf', url: `${HF}/Qwen3-ASR-1.7B-GGUF/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf`, sha256: '58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57', size: 2165034944 },
      { name: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', url: `${HF}/Qwen3-ASR-1.7B-GGUF/resolve/main/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf`, sha256: '46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d', size: 355709344 }
    ]
  },
  'qwen3-asr-0.6b': {
    label: 'Qwen3-ASR 0.6B',
    blurb: 'Lighter and faster. Good for older laptops or CPU-only PCs.',
    vramGB: 1.6,
    files: [
      { name: 'Qwen3-ASR-0.6B-Q8_0.gguf', url: `${HF}/Qwen3-ASR-0.6B-GGUF/resolve/main/Qwen3-ASR-0.6B-Q8_0.gguf`, sha256: 'bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971', size: 804749248 },
      { name: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf', url: `${HF}/Qwen3-ASR-0.6B-GGUF/resolve/main/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`, sha256: '41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d', size: 214392480 }
    ]
  }
};

const ASR_PREFIX = /^\s*language\s+[A-Za-z_-]+\s*<asr_text>\s*/i;
const CONTEXT_TOKENS = 12288;   // ~12 minutes of audio per request
const CHUNK_SECONDS = 300;

// Pick the discrete GPU with the most memory from `llama-server --list-devices`.
function pickDevice(listOutput) {
  const devices = [];
  for (const line of String(listOutput).split(/\r?\n/)) {
    const m = /^\s*(Vulkan\d+):\s*(.+?)\s*\((\d+)\s*MiB/.exec(line);
    if (m) devices.push({ id: m[1], name: m[2], mib: Number(m[3]) });
  }
  const integrated = /(Intel\(R\) (UHD|Iris|HD)|Radeon\(TM\) Graphics|Microsoft Basic)/i;
  const usable = devices.filter((d) => !integrated.test(d.name) && d.mib >= 3000);
  usable.sort((a, b) => b.mib - a.mib);
  return { devices, best: usable[0] || null };
}

function cleanText(text) {
  return String(text || '').replace(ASR_PREFIX, '').trim();
}

function createLocalEngine({ userDataDir, store, secrets, log = () => {}, onStatus = () => {}, fetchImpl = (...a) => fetch(...a) }) {
  const root = path.join(userDataDir, 'engines');
  const runtimeDir = path.join(root, `llama-${RUNTIME.version}`);
  const exe = path.join(runtimeDir, 'llama-server.exe');
  let proc = null;
  let port = 0;
  let device = null;
  let runningModel = '';
  let starting = null;
  let download = null;       // { modelId, received, total, file, controller }
  let lastError = '';
  let idleTimer = null;

  const modelDir = (id) => path.join(root, 'models', id);
  const modelInstalled = (id) => MODELS[id]?.files.every((f) => {
    try { return fs.statSync(path.join(modelDir(id), f.name)).size === f.size; } catch { return false; }
  });
  const runtimeInstalled = () => fs.existsSync(exe);
  const selectedModel = () => (MODELS[store.get('localModel')] ? store.get('localModel') : 'qwen3-asr-1.7b');

  function status() {
    return {
      runtimeInstalled: runtimeInstalled(),
      models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, {
        id, label: m.label, blurb: m.blurb, vramGB: m.vramGB,
        sizeBytes: m.files.reduce((s, f) => s + f.size, 0), installed: modelInstalled(id)
      }])),
      selected: selectedModel(),
      configured: runtimeInstalled() && modelInstalled(selectedModel()),
      running: !!proc && !!port,
      starting: !!starting,
      device: device ? `${device.name}` : (proc ? 'CPU' : ''),
      downloading: download ? { modelId: download.modelId, received: download.received, total: download.total } : null,
      error: lastError
    };
  }
  const emit = () => { try { onStatus(status()); } catch { /* window may be gone */ } };

  // ---------------------------------------------------------- downloads
  async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
    });
    return hash.digest('hex');
  }

  async function fetchFile(spec, dest, progress) {
    const part = dest + '.part';
    let have = 0;
    try { have = fs.statSync(part).size; } catch { /* fresh */ }
    if (have > spec.size) { fs.rmSync(part, { force: true }); have = 0; }
    if (have < spec.size) {
      const res = await fetchImpl(spec.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: download.controller.signal });
      if (!(res.ok || res.status === 206)) throw new EngineError('network', `Download failed (${res.status}) for ${spec.name}`);
      if (have && res.status !== 206) have = 0; // server ignored the range; start over
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      let got = have;
      await new Promise((resolve, reject) => {
        const body = Readable.fromWeb(res.body);
        body.on('data', (chunk) => { got += chunk.length; progress(got); });
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
    } else {
      progress(have);
    }
    const digest = await sha256File(part);
    if (digest !== spec.sha256) {
      fs.rmSync(part, { force: true });
      throw new EngineError('network', `${spec.name} failed its checksum. Try the download again.`);
    }
    fs.renameSync(part, dest);
  }

  function extractZip(zip, dir) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(dir, { recursive: true });
      // tar.exe ships with Windows 10+ and reads zip archives
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 120000 },
        (err) => (err ? reject(new EngineError('config', `Could not unpack the runtime: ${err.message}`)) : resolve()));
    });
  }

  async function install(modelId = selectedModel()) {
    if (!MODELS[modelId]) throw new EngineError('config', 'Unknown model');
    if (download) throw new EngineError('config', 'A download is already running.');
    const needed = [];
    if (!runtimeInstalled()) needed.push({ ...RUNTIME, name: `llama-${RUNTIME.version}.zip`, runtime: true });
    for (const f of MODELS[modelId].files) {
      try { if (fs.statSync(path.join(modelDir(modelId), f.name)).size === f.size) continue; } catch { /* missing */ }
      needed.push(f);
    }
    const total = needed.reduce((s, f) => s + f.size, 0);
    download = { modelId, received: 0, total, controller: new AbortController() };
    lastError = '';
    emit();
    let lastEmit = 0;
    try {
      fs.mkdirSync(modelDir(modelId), { recursive: true });
      let base = 0;
      for (const f of needed) {
        const dest = f.runtime ? path.join(root, f.name) : path.join(modelDir(modelId), f.name);
        await fetchFile(f, dest, (fileBytes) => {
          download.received = base + fileBytes;
          if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); emit(); }
        });
        base += f.size;
        download.received = base;
        if (f.runtime) {
          await extractZip(dest, runtimeDir);
          fs.rmSync(dest, { force: true });
        }
      }
      store.set('localModel', modelId);
      log('INFO', 'local', `Installed ${modelId}`);
    } catch (e) {
      lastError = download.controller.signal.aborted ? '' : e.message;
      if (!download.controller.signal.aborted) log('ERROR', 'local', `Install failed: ${e.message}`);
      throw download.controller.signal.aborted ? new EngineError('config', 'Download cancelled') : e;
    } finally {
      download = null;
      emit();
    }
    return status();
  }

  function cancelInstall() {
    download?.controller.abort();
  }

  async function remove(modelId) {
    if (runningModel === modelId) await stop();
    fs.rmSync(modelDir(modelId), { recursive: true, force: true });
    emit();
    return status();
  }

  // ---------------------------------------------------------- server
  function listDevices() {
    return new Promise((resolve) => {
      execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 20000, cwd: runtimeDir }, (err, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
    });
  }

  function freePort() {
    return new Promise((resolve, reject) => {
      const srv = require('net').createServer();
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
      srv.on('error', reject);
    });
  }

  async function start(modelId = selectedModel()) {
    if (proc && runningModel === modelId) return port;
    if (starting) return starting;
    starting = (async () => {
      if (proc) await stop();
      if (!runtimeInstalled() || !modelInstalled(modelId)) throw new EngineError('config', 'Download the on-device model first.');
      const picked = pickDevice(await listDevices());
      device = store.get('localUseGpu') === false ? null : picked.best;
      let key = secrets.get('localServer');
      if (!key) { key = crypto.randomBytes(24).toString('hex'); secrets.set('localServer', key); }
      port = await freePort();
      const [model, mmproj] = MODELS[modelId].files.map((f) => path.join(modelDir(modelId), f.name));
      const args = ['-m', model, '--mmproj', mmproj, '-c', String(CONTEXT_TOKENS), '-np', '1', '--no-webui',
        '--host', '127.0.0.1', '--port', String(port), '--api-key', key];
      args.push(...(device ? ['--device', device.id, '-ngl', '99'] : ['--device', 'none', '-ngl', '0']));
      const logFile = fs.openSync(path.join(root, 'llama-server.log'), 'w');
      proc = spawn(exe, args, { cwd: runtimeDir, windowsHide: true, stdio: ['ignore', logFile, logFile] });
      runningModel = modelId;
      proc.on('exit', (code) => {
        log(code ? 'WARN' : 'INFO', 'local', `llama-server exited (${code})`);
        proc = null; port = 0; runningModel = ''; emit();
      });
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (!proc) throw new EngineError('server', 'The on-device engine stopped while loading. See Settings → Logs.');
        try {
          const r = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) { log('INFO', 'local', `Ready on ${device ? device.name : 'CPU'}`); lastError = ''; return port; }
        } catch { /* still loading */ }
        await new Promise((r) => setTimeout(r, 400));
      }
      await stop();
      throw new EngineError('timeout', 'The on-device engine took too long to load.');
    })();
    try { return await starting; } catch (e) { lastError = e.message; throw e; } finally { starting = null; emit(); }
  }

  async function stop() {
    clearTimeout(idleTimer);
    if (!proc) return;
    const p = proc;
    proc = null; port = 0; runningModel = '';
    try { p.kill(); } catch { /* already gone */ }
    emit();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    const minutes = Number(store.get('localUnloadMinutes') ?? 0);
    if (minutes > 0) idleTimer = setTimeout(() => { log('INFO', 'local', 'Unloading after idle'); stop(); }, minutes * 60000);
  }

  async function transcribe({ wav, language, prompt, durationSec }) {
    const p = await start();
    const key = secrets.get('localServer');
    const { samples, sampleRate } = parseWav(Buffer.from(wav));
    const chunks = splitAtPauses(samples, sampleRate, CHUNK_SECONDS);
    const texts = [];
    for (const chunk of chunks) {
      const form = new FormData();
      form.append('file', new Blob([encodeWav(chunk, sampleRate)], { type: 'audio/wav' }), 'audio.wav');
      if (language && language !== 'auto') form.append('language', language);
      if (prompt) form.append('prompt', prompt.slice(0, 800));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineFor('local', chunk.length / sampleRate));
      try {
        const res = await fetchImpl(`http://127.0.0.1:${p}/v1/audio/transcriptions`, {
          method: 'POST', body: form, headers: { Authorization: `Bearer ${key}` }, signal: controller.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new EngineError('server', data.error?.message || `On-device engine error ${res.status}`);
        texts.push(cleanText(data.text));
      } catch (e) {
        if (controller.signal.aborted) throw new EngineError('timeout', 'The on-device engine took too long.');
        throw e instanceof EngineError ? e : new EngineError('server', e.message);
      } finally { clearTimeout(timer); }
    }
    armIdle();
    return { text: texts.filter(Boolean).join(' ').trim(), model: MODELS[runningModel || selectedModel()].label };
  }

  return { id: 'local', status, install, cancelInstall, remove, start, stop, transcribe, listDevices };
}

module.exports = { createLocalEngine, pickDevice, cleanText, MODELS, RUNTIME };
