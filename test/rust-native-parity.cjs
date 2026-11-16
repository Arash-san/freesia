const fs = require("node:fs"),
  path = require("node:path"),
  { spawn, execFileSync } = require("node:child_process"),
  assert = require("node:assert/strict");
const { connect, ready, sleep } = require("./desktop-cdp.cjs");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, ".tmp", "rust-native-parity");
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(out, "profile-"));
const models = path.join(profile, "engines/models/qwen3-asr-1.7b"),
  runtime = path.join(profile, "engines/llama-b11182");
fs.mkdirSync(models, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });
for (const file of fs.readdirSync(path.join(root, ".tmp/localasr/vk")))
  if (fs.statSync(path.join(root, ".tmp/localasr/vk", file)).isFile())
    fs.linkSync(
      path.join(root, ".tmp/localasr/vk", file),
      path.join(runtime, file),
    );
for (const file of [
  "Qwen3-ASR-1.7B-Q8_0.gguf",
  "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
])
  fs.linkSync(path.join(root, ".tmp/localasr", file), path.join(models, file));
fs.writeFileSync(
  path.join(profile, "config.json"),
  JSON.stringify({
    onboarded: true,
    seenV3: true,
    engine: "cloud",
    formatter: "off",
    sounds: false,
    errorReporting: false,
    keepMicReady: false,
    localUseGpu: true,
    softwareRendering: process.env.FREESIA_TEST_SOFTWARE_RENDERING === "1",
    localUnloadMinutes: 1,
  }),
);
const child = spawn(
  process.env.FREESIA_RUST_EXE ||
    path.join(root, "src-tauri/target/debug/freesia-desktop.exe"),
  ["--profile", profile, "--no-shortcuts"],
  {
    env: {
      ...process.env,
      FREESIA_DEBUG_PORT: "9439",
      FREESIA_TEST_AUDIO: path.join(root, ".tmp/localasr/audio/long.wav"),
    },
    windowsHide: true,
    stdio: "ignore",
  },
);
let cdp;
const report = { checks: [] };
const api = (name, ...args) =>
  cdp.js(`freesia[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
async function main() {
  cdp = await connect(9439);
  await ready(cdp);
  await cdp.js(
    `__TAURI__.core.invoke('ipc',{channel:'native:test',args:['show']})`,
  );
  await sleep(300);
  report.frameRate = await cdp.js(
    `new Promise(resolve=>{let n=0,start=performance.now();function count(){n++;const elapsed=performance.now()-start;if(elapsed>2000)resolve(n*1000/elapsed);else requestAnimationFrame(count)}requestAnimationFrame(count)})`,
  );
  console.log("Animation callbacks/sec", report.frameRate);
  // Never send real keystrokes until the test window owns the foreground.
  const foreground = await api("getForegroundApp");
  if (
    foreground === "freesia-desktop" &&
    process.env.FREESIA_TEST_LOCAL_ONLY !== "1"
  ) {
    await cdp.js(
      `window.testField=document.createElement('textarea');testField.style='position:fixed;z-index:999999;left:300px;top:100px;width:500px;height:150px';document.body.append(testField);testField.value='Existing selection';testField.focus();testField.select();`,
    );
    assert.equal(await api("injectText", "Freesia native paste 5.6"), true);
    await sleep(300);
    assert.equal(await cdp.js("testField.value"), "Freesia native paste 5.6");
    report.checks.push("Native scan-code paste replaces selection");
    await cdp.js(
      `testField.value='Capture this selection';testField.select();window.capturedSelection=null;freesia.onCommandStart(v=>capturedSelection=v.selection);`,
    );
    await sleep(1000);
    assert.equal(await api("getForegroundApp"), "freesia-desktop");
    await cdp.js(
      `__TAURI__.core.invoke('ipc',{channel:'native:test',args:['command']})`,
    );
    for (let i = 0; i < 40; i++) {
      if (await cdp.js("capturedSelection !== null")) break;
      await sleep(100);
    }
    assert.equal(await cdp.js("capturedSelection"), "Capture this selection");
    await cdp.js(
      `__TAURI__.core.invoke('ipc',{channel:'native:test',args:['cancel']})`,
    );
    await sleep(300);
    report.checks.push(
      "Voice command captures selected text without losing focus",
    );
  } else {
    report.keyboard =
      process.env.FREESIA_TEST_LOCAL_ONLY === "1"
        ? "Not attempted: local model check only."
        : "Blocked: test window could not obtain foreground ownership; no real keystrokes sent.";
    console.log(report.keyboard);
  }
  const state = await api("engineStatus");
  assert.equal(state.local.configured, true);
  // Local startup explicitly permits up to 120 seconds for a cold model load.
  cdp.timeoutMs = 150000;
  const started = Date.now();
  const local = await api("localStart");
  assert.equal(local.running, true, JSON.stringify(local));
  const bytes = fs
    .readFileSync(path.join(root, ".tmp/localasr/audio/l1.wav"))
    .toString("base64");
  const result = await cdp.js(
    `freesia.transcribe({engine:'local',audio:new ArrayBuffer(0),wav:Uint8Array.from(atob('${bytes}'),c=>c.charCodeAt(0)).buffer,mime:'audio/wav',language:'en',durationSec:4.8})`,
  );
  assert(!result.error, JSON.stringify(result));
  const ref = JSON.parse(
    fs.readFileSync(path.join(root, ".tmp/localasr/audio/refs.json"), "utf8"),
  ).l1;
  const normalize = (s) =>
    s
      .toUpperCase()
      .replace(/[^A-Z' ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const r = normalize(ref),
    h = normalize(result.text),
    d = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= h.length; j++) {
      let t = d[j];
      d[j] = Math.min(
        d[j] + 1,
        d[j - 1] + 1,
        prev + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
      prev = t;
    }
  }
  const wer = d[h.length] / r.length;
  assert(wer < 0.2, `${wer}: ${result.text}`);
  report.local = {
    device: local.device,
    text: result.text,
    wer,
    loadAndInferMs: Date.now() - started,
  };
  report.checks.push("Pinned local Qwen model performs real WAV inference");
  assert.equal((await api("localStop")).running, false);
  report.checks.push("Local runtime stops cleanly");
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
}
main()
  .catch((e) => {
    report.passed = false;
    report.error = e.stack;
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(report, null, 2),
    );
    if (cdp) {
      try {
        await api("localStop");
        await cdp.js(
          `__TAURI__.core.invoke('ipc',{channel:'native:test',args:['quit']})`,
        );
      } catch {}
      cdp.close();
    }
    if (child.exitCode === null) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {}
    }
  });
