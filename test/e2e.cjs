// End-to-end check on real audio. Needs the local test assets in
// .tmp/localasr (LibriSpeech clips, llama.cpp build, Qwen3-ASR GGUF) and a
// Freesia Voice test token in .tmp/localasr/.tok. Run under Electron:
//   node test/run-e2e.cjs
const { app, BrowserWindow, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const assets = path.resolve(__dirname, '../.tmp/localasr');
const profile = fs.mkdtempSync(path.join(path.resolve(__dirname, '../.tmp'), 'e2e-profile-'));
app.setPath('userData', profile);
// Server and token of a test account: .tmp/e2e-config.json {"server", "token"} (never committed)
const { server, token } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.tmp/e2e-config.json'), 'utf8'));

// Pre-seed the on-device engine with the already-verified files (hard links, no copy)
const runtime = path.join(profile, 'engines', 'llama-b11182');
const modelDir = path.join(profile, 'engines', 'models', 'qwen3-asr-1.7b');
fs.mkdirSync(runtime, { recursive: true });
fs.mkdirSync(modelDir, { recursive: true });
for (const f of fs.readdirSync(path.join(assets, 'vk'))) fs.copyFileSync(path.join(assets, 'vk', f), path.join(runtime, f));
for (const f of ['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf']) fs.linkSync(path.join(assets, f), path.join(modelDir, f));

fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  onboarded: true, seenV3: true, theme: 'dark', engine: 'cloud', errorReporting: false, activeStyle: 'normal', sounds: false,
  dictionary: ['Quilter', 'Linnell'], localUnloadMinutes: 0,
  cloud: { server, username: 'test' }, secrets: { cloud: `plain:${token}` }
}));

globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
globalShortcut.unregister = () => {};
const mainModule = require('../src/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail ? `| ${String(detail).slice(0, 160)}` : ''}`); };

app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 100; i++) {
    main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    if (main && !main.webContents.isLoading()) break;
    await sleep(100);
  }
  await sleep(1500);
  const js = (code) => main.webContents.executeJavaScript(code);
  const clip = (name) => fs.readFileSync(path.join(assets, 'audio', name)).toString('base64');
  const runClip = async (name, durationSec) => {
    const t = Date.now();
    await js(`(async () => { const b = Uint8Array.from(atob('${clip(name)}'), c => c.charCodeAt(0)); await processAudio(new Blob([b], { type: 'audio/webm' }), 'test', { durationSec: ${durationSec} }); })()`);
    return { text: await js(`window.__freesiaTest.getSettings().history?.[0]?.text || ''`), engine: await js(`window.__freesiaTest.getSettings().history?.[0]?.engine || ''`), ms: Date.now() - t };
  };
  const refs = JSON.parse(fs.readFileSync(path.join(assets, 'audio', 'refs.json'), 'utf8'));
  const wer = (ref, hyp) => {
    const n = (s) => s.toUpperCase().replace(/MR\./g, 'MISTER').replace(/[^A-Z' ]/g, ' ').split(/\s+/).filter(Boolean);
    const r = n(ref); const h = n(hyp);
    const d = Array.from({ length: h.length + 1 }, (_, j) => j);
    for (let i = 1; i <= r.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= h.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] !== h[j - 1])); prev = t; } }
    return d[h.length] / r.length;
  };
  // WebM versions of the clips, as MediaRecorder would produce
  const { execFileSync } = require('child_process');
  for (const n of ['l1', 'long']) {
    const out = path.join(assets, 'audio', `${n}.webm`);
    if (!fs.existsSync(out)) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(assets, 'audio', `${n}.wav`), '-c:a', 'libopus', '-b:a', '64k', out], { windowsHide: true });
  }
  const longRef = Object.values(refs).join(' ');

  try {
    // 1. Cloud engine + cloud formatting (Normal style)
    let r = await runClip('l1.webm', 4.8);
    check('cloud: short clip transcribed + formatted', r.engine === 'cloud' && wer(refs.l1, r.text) < 0.15, `${r.ms} ms: ${r.text}`);
    r = await runClip('long.webm', 130);
    check('cloud: 130 s clip', r.engine === 'cloud' && wer(longRef, r.text) < 0.12, `${r.ms} ms, WER ${(wer(longRef, r.text) * 100).toFixed(1)}%`);
    const meta = await js(`[...document.querySelectorAll('#outputMeta .pill-tag')].map(e => e.textContent).join(' | ')`);
    check('home output shows engine + words', /Freesia Cloud/.test(meta), meta);

    // 2. Styles: Professional Email via cloud formatter
    await js(`selectStyle('bullets')`);
    r = await runClip('long.webm', 130);
    check('cloud formatter applies Bullet Points style', /^\s*[-•*]/m.test(r.text), r.text.slice(0, 160));
    await js(`selectStyle('normal')`);

    // 3. On-device engine (loads llama-server, WebM -> WAV in renderer)
    await js(`setEngine('local', true)`);
    r = await runClip('l1.webm', 4.8);
    const local = await js(`api.engineStatus().then(s => s.local)`);
    check('local: short clip', r.engine === 'local' && wer(refs.l1, r.text) < 0.15, `${r.ms} ms on ${local.device || 'CPU'}: ${r.text}`);
    r = await runClip('long.webm', 130);
    check('local: 130 s clip', r.engine === 'local' && wer(longRef, r.text) < 0.12, `${r.ms} ms, WER ${(wer(longRef, r.text) * 100).toFixed(1)}%`);

    // 4. Engine fallback: primary Gemini has no key -> cloud answers
    await js(`setEngine('gemini', true)`);
    r = await runClip('l1.webm', 4.8);
    check('fallback: unconfigured Gemini falls back to cloud', r.engine === 'cloud', r.text);
    await js(`setEngine('cloud', true)`);

    // 5/6. Keyboard tests send real keystrokes, so they only run when this
    // window verifiably owns the foreground; otherwise they are skipped.
    await js(`obGo(3); showScreen('screenOnboarding'); document.getElementById('obPractice').value = ''; 1`);
    main.setAlwaysOnTop(true);
    main.minimize(); main.restore(); main.show(); main.focus();
    await sleep(700);
    await js(`document.getElementById('obPractice').focus(); 1`);
    if (!main.isFocused()) {
      check('keyboard tests (skipped: window not in foreground)', true, 'skipped');
    } else {
      const injected = await mainModule.injectText('Freesia paste test');
      await sleep(600);
      const val = await js(`document.getElementById('obPractice').value`);
      check('scan-code paste lands in the focused field', injected && val.includes('Freesia paste test'), JSON.stringify(val));
      await js(`const el = document.getElementById('obPractice'); el.value = 'the selected sentence'; el.focus(); el.select(); 1`);
      await sleep(300);
      const { clipboard } = require('electron');
      clipboard.writeText('clipboard before capture');
      const sel = main.isFocused() ? await mainModule.captureSelection() : null;
      check('selection capture reads the highlighted text', sel === 'the selected sentence', JSON.stringify(sel));
      check('clipboard restored after capture', clipboard.readText() === 'clipboard before capture', clipboard.readText());
    }
    main.setAlwaysOnTop(false);
  } catch (e) {
    check('harness', false, e.stack);
  }
  fs.writeFileSync(path.resolve(__dirname, '../.tmp/e2e-result.json'), JSON.stringify(results, null, 2));
  await mainModule.engines.local.stop();
  app.isQuitting = true;
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
