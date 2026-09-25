// Visual check: boots the real app on a throwaway profile seeded with sample
// data, visits every view in dark and light, and saves screenshots to
// .tmp/shots. Run with `npm run shots`.
const { app, BrowserWindow, globalShortcut, session } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.resolve(__dirname, '../.tmp/shots');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(path.resolve(__dirname, '../.tmp'), 'shots-profile-'));
const onboarding = process.env.SHOTS_ONBOARDING === '1';
app.setPath('userData', profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const day = (n) => { const d = new Date(Date.now() - n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const days = {};
for (let i = 0; i < 30; i++) if (i % 4 !== 3) days[day(i)] = Math.round(120 + 600 * Math.abs(Math.sin(i * 1.7)));
const now = Date.now();
const history = [
  ['So I was thinking we could move the GRPO training run to the new cluster tomorrow and then check the reward curves on Friday.', 'dictate-inject', 'cloud', 7],
  ['Hi Dr. Chen, thanks for the feedback on the draft. I have updated the methods section and re-run the ablations with three seeds.', 'dictate-inject', 'cloud', 11],
  ['سلام، امروز جلسه ساعت چهار برگزار می‌شود. لطفاً گزارش را قبل از جلسه بفرستید.', 'dictate-inject', 'local', 6],
  ['- Deploy Qwen3-ASR
- Wire up the gateway
- Redesign Freesia', 'command', 'cloud', 5],
  ['Let me know if Thursday at 3 works for the workshop, and I will book the room.', 'test', 'gemini', 6]
].map(([text, mode, engine, sec], i) => ({ id: now - i * 3600000 * (i > 2 ? 20 : 1), text, mode, engine, durationSec: sec, words: text.split(/\s+/).length, timestamp: new Date(now - i * 3600000 * (i > 2 ? 20 : 1)).toISOString() }));

fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  onboarded: !onboarding, seenV3: true, theme: process.env.SHOTS_THEME || 'dark', engine: 'cloud', errorReporting: false,
  dictionary: ['Qwen3-ASR', 'GRPO', 'PyTorch', 'Kubernetes', 'vLLM', 'Figma'],
  snippets: [{ id: 1, trigger: 'my signature', expansion: 'Best regards,\nAlex Rivera\nResearch Lab' }, { id: 2, trigger: 'meeting link', expansion: 'https://zoom.us/j/123456789' }],
  history, activeStyle: 'email',
  stats: { today: { date: day(0), words: 1284, sessions: 23, recordSec: 410, savedSec: 1520 }, lifetime: { words: 48210, sessions: 912, recordSec: 15400, savedSec: 57000 }, streak: { current: 12, best: 19, lastDate: day(0) }, days },
  cloud: { server: 'https://voice.example.com', username: 'alex' }, secrets: { cloud: 'plain:fv_demo_token_for_screenshots' }
}, null, 2));
fs.mkdirSync(path.join(profile, 'failed-recordings'), { recursive: true });
fs.writeFileSync(path.join(profile, 'failed-recordings', 'recording-1-demo.webm'), Buffer.alloc(2048));
fs.writeFileSync(path.join(profile, 'failed-recordings', 'recording-1-demo.json'), JSON.stringify({ timestamp: new Date(now - 7200000).toISOString(), duration: '1:42', durationSec: 102, sizeMB: '0.8', error: 'Freesia Cloud: Could not reach the server. Check your connection.' }));

globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
globalShortcut.unregister = () => {};
require('../src/main/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (d, cb) => cb({ cancel: !d.url.includes('cdn.simpleicons.org') }));
  let main, overlay;
  for (let i = 0; i < 100; i++) {
    const wins = BrowserWindow.getAllWindows();
    main = wins.find((w) => w.webContents.getURL().endsWith('index.html'));
    overlay = wins.find((w) => w.webContents.getURL().endsWith('overlay.html'));
    if (main && overlay && !main.webContents.isLoading() && !overlay.webContents.isLoading()) break;
    await sleep(100);
  }
  const errors = [];
  main.webContents.on('console-message', (e, level, message) => { if (level >= 3) errors.push(message); });
  const theme = process.env.SHOTS_THEME || 'dark';
  main.setSize(1180, 800);
  await sleep(1800);
  if (onboarding) {
    for (let s = 0; s < 4; s++) {
      await main.webContents.executeJavaScript(`obGo(${s})`);
      await sleep(1200);
      await snap(main, `${theme}-onboarding-${s}`);
    }
  } else {
    for (const view of ['home', 'history', 'styles', 'vocabulary', 'engines', 'settings']) {
      await main.webContents.executeJavaScript(`showView('${view}')`);
      await sleep(1300);
      await snap(main, `${theme}-${view}`);
    }
    await main.webContents.executeJavaScript(`showView('styles'); 1`);
    for (let i = 0; i < 60; i++) { if (await main.webContents.executeJavaScript('appScanLoaded')) break; await sleep(250); }
    await sleep(400);
    await main.webContents.executeJavaScript(`document.getElementById('appRulesList').scrollIntoView({ block: 'center' }); 1`);
    await sleep(900);
    await snap(main, `${theme}-app-rules`);
    await main.webContents.executeJavaScript(`document.querySelector('#vocabTabs [data-tab=snippets]').click()`);
    await main.webContents.executeJavaScript(`showView('vocabulary')`);
    await sleep(900);
    await snap(main, `${theme}-snippets`);
    await main.webContents.executeJavaScript(`showView('home'); setOutput('text', 'So I was thinking we could move the GRPO training run to the new cluster tomorrow and then check the reward curves on Friday.', [{text:'Freesia Cloud'},{text:'Qwen3-ASR-1.7B'},{text:'0:07'},{text:'21 words'}]); homeOrb.setState('listening'); homeOrb.setLevel(0.7); document.body.classList.add('is-recording')`);
    await sleep(1600);
    await snap(main, `${theme}-home-recording`);
    await main.webContents.executeJavaScript(`document.body.classList.remove('is-recording'); homeOrb.setState('processing')`);
    await sleep(900);
    await snap(main, `${theme}-home-processing`);
    await main.webContents.executeJavaScript(`void openStyleEditor({ id: 'custom-x', name: 'Slack replies', icon: '💬', color: '#7CC4FF', description: 'Short team chat', prompt: 'Format this as a concise Slack message.', custom: true }); 1`);
    await sleep(900);
    await snap(main, `${theme}-dialog`);
    // Overlay pill states
    overlay.showInactive();
    for (const [name, msg] of [['listening', { state: 'listening', mode: 'dictate' }], ['processing', { state: 'processing', label: 'Freesia Cloud' }], ['done', { state: 'done', label: '21 words' }], ['error', { state: 'error', message: 'Could not reach the server. Saved in History.' }]]) {
      overlay.webContents.send('overlay-state', msg);
      for (let i = 0; i < 12; i++) { overlay.webContents.send('overlay-audio-level', 0.3 + 0.5 * Math.abs(Math.sin(i))); await sleep(60); }
      await sleep(500);
      await snap(overlay, `${theme}-overlay-${name}`);
    }
  }
  fs.writeFileSync(path.join(out, `${theme}${onboarding ? '-onboarding' : ''}-console-errors.json`), JSON.stringify(errors, null, 2));
  app.isQuitting = true;
  app.exit(0);
});
