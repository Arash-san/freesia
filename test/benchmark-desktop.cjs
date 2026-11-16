const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  { spawn, execFileSync, execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const { connect, ready, sleep, screenshot } = require("./desktop-cdp.cjs");
const execute = promisify(execFile);
const root = path.resolve(__dirname, ".."),
  out = path.join(
    root,
    ".tmp",
    process.env.FREESIA_BENCH_NAME || "rust-benchmark",
  );
fs.mkdirSync(out, { recursive: true });
const baseline = path.join(out, "electron-source");
if (!fs.existsSync(path.join(baseline, "src/main/main.js"))) {
  fs.mkdirSync(baseline, { recursive: true });
  const archive = path.join(out, "baseline.tar");
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar",
      "-o",
      archive,
      "7a97aaa",
      "src/main",
      "src/renderer",
      "assets",
      "package.json",
    ],
    { cwd: root },
  );
  execFileSync("tar.exe", ["-xf", archive, "-C", baseline]);
}
fs.writeFileSync(
  path.join(baseline, "benchmark-entry.cjs"),
  `
const {app,globalShortcut,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',process.env.FREESIA_BENCH_PROFILE);
app.commandLine.appendSwitch('remote-debugging-port',process.env.FREESIA_DEBUG_PORT);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture',process.env.FREESIA_TEST_AUDIO);
globalShortcut.register=()=>true;globalShortcut.unregister=()=>{};globalShortcut.unregisterAll=()=>{};
const runtime=require('./src/main/main.js');
globalThis.benchRuntime=runtime;
ipcMain.handle('bench:show',()=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'));win.show();win.focus();return true;});
`,
);
const packagePath = path.join(baseline, "package.json"),
  metadata = JSON.parse(fs.readFileSync(packagePath));
metadata.main = "benchmark-entry.cjs";
fs.writeFileSync(packagePath, JSON.stringify(metadata));
const preloadPath = path.join(baseline, "src/main/preload.js");
let preload = fs.readFileSync(preloadPath, "utf8");
if (!preload.includes("__freesiaBench")) {
  preload += `\ncontextBridge.exposeInMainWorld('__freesiaBench',{show:()=>ipcRenderer.invoke('bench:show')});\n`;
  fs.writeFileSync(preloadPath, preload);
}
let bodyText = "Open Claude on Yorha and test GPT 5.6 SOL.";
const server = http.createServer(async (req, res) => {
  for await (const _ of req) {
  }
  let v = {};
  if (req.url === "/api/me") v = { username: "bench", asrModel: "fixture" };
  if (req.url === "/api/contribute") v = { available: false };
  if (req.url.includes("/audio/")) {
    await sleep(1000);
    v = { text: bodyText, model: "fixture" };
  }
  if (req.url === "/v1/chat/completions") {
    await sleep(500);
    v = { choices: [{ message: { content: bodyText } }] };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(v));
});
async function sample(pid, seconds) {
  const { stdout } = await execute(
    "pwsh.exe",
    [
      "-NoProfile",
      "-File",
      path.join(root, "test/measure-process-tree.ps1"),
      "-RootProcess",
      String(pid),
      "-Seconds",
      String(seconds),
    ],
    {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: (seconds + 20) * 1000,
    },
  );
  return JSON.parse(stdout.trim());
}
async function run(kind, runNumber) {
  const listener = require("node:net").createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  let cdp, child;
  const profile = fs.mkdtempSync(path.join(out, `${kind}-${runNumber}-`));
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      onboarded: true,
      seenV3: true,
      theme: "dark",
      engine: "cloud",
      formatter: "auto",
      sounds: false,
      errorReporting: false,
      keepMicReady: true,
      keepCancelledRecordings: false,
      cloud: {
        server: `http://127.0.0.1:${server.address().port}`,
        username: "bench",
      },
      secrets: { cloud: "plain:fv_fake_benchmark_token" },
    }),
  );
  const env = {
    ...process.env,
    FREESIA_TEST_AUDIO: path.join(root, ".tmp/localasr/audio/long.wav"),
    FREESIA_BENCH_PROFILE: profile,
    FREESIA_DEBUG_PORT: String(port),
  };
  const exe =
    kind === "electron"
      ? require("electron")
      : path.join(root, "src-tauri/target/release/freesia-desktop.exe");
  const args =
    kind === "electron" ? [baseline] : ["--profile", profile, "--no-shortcuts"];
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, args, { env, windowsHide: true, stdio: "ignore" });
  const result = { kind, run: runNumber, phases: {}, processingMs: [] };
  const api = (name, ...args) =>
    cdp.js(`freesia[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
  const show = async () => {
    if (kind === "electron") return cdp.js("__freesiaBench.show()");
    // A suspended view cannot run DevTools JavaScript. A second native
    // instance exercises the same Rust resume path as opening from the tray.
    const wake = spawn(exe, ["--profile", profile, "--no-shortcuts"], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    await Promise.race([
      new Promise((resolve) => wake.once("exit", resolve)),
      sleep(5000).then(() => {
        wake.kill();
        throw Error("Native resume did not complete");
      }),
    ]);
    await sleep(300);
    cdp.close();
    cdp = await connect(port);
    await ready(cdp);
  };
  try {
    cdp = await connect(port);
    await ready(cdp);
    await sleep(10000);
    await cdp.js(`showView('home')`);
    await sleep(1600);
    await screenshot(cdp, path.join(out, `${kind}-${runNumber}.png`));
    result.viewport = await cdp.js(
      "({width:innerWidth,height:innerHeight,scale:devicePixelRatio})",
    );
    result.phases.visible = await sample(child.pid, 20);
    console.log(
      `${kind} ${runNumber}: visible ${result.phases.visible.meanWorkingMiB.toFixed(1)} MiB`,
    );
    await cdp.js("void freesia.close()");
    await sleep(250);
    await sleep(20000);
    result.phases.tray = await sample(child.pid, 20);
    console.log(
      `${kind} ${runNumber}: tray ${result.phases.tray.meanWorkingMiB.toFixed(1)} MiB`,
    );
    await show();
    console.log(`${kind} ${runNumber}: native resume completed`);
    await cdp.js("void freesia.close()");
    await sleep(250);
    console.log(`${kind} ${runNumber}: hidden again`);
    await cdp.js(`void startRecording('test')`);
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await cdp.js("isRecording && !isStartingRecording")) break;
      await sleep(100);
    }
    if (!(await cdp.js("isRecording && !isStartingRecording")))
      throw Error("Hidden recording did not start");
    console.log(`${kind} ${runNumber}: hidden recording started`);
    await sleep(1200);
    result.phases.recording = await sample(child.pid, 20);
    await cdp.js("stopRecording()");
    await sleep(2500);
    result.phases.micReady = await sample(child.pid, 15);
    if (
      !JSON.parse(fs.readFileSync(path.join(profile, "config.json"), "utf8"))
        .history?.length
    )
      throw Error("Recording did not reach the measured profile");
    console.log(
      `${kind} ${runNumber}: microphone ready ${result.phases.micReady.meanWorkingMiB.toFixed(1)} MiB`,
    );
    const audio = fs
      .readFileSync(path.join(root, ".tmp/localasr/audio/long.webm"))
      .toString("base64");
    const task = cdp.js(
      `(async()=>{window.benchTimes=[];for(let i=0;i<5;i++){const start=performance.now();await processAudio(new Blob([Uint8Array.from(atob('${audio}'),c=>c.charCodeAt(0))],{type:'audio/webm'}),'test',{durationSec:130});benchTimes.push(performance.now()-start);}return benchTimes})()`,
    );
    result.phases.processing = await sample(child.pid, 10);
    result.processingMs = await task;
    await cdp.js(`__freesiaTest.closeReadyMic()`);
    await sleep(20000);
    result.phases.cooledTray = await sample(child.pid, 15);
    console.log(
      `${kind} ${runNumber}: cooled tray ${result.phases.cooledTray.meanWorkingMiB.toFixed(1)} MiB`,
    );
    await show();
    await sleep(500);
    result.resumed = await cdp.js(
      `!!document.querySelector('.screen.active') && !document.hidden`,
    );
    return result;
  } finally {
    if (cdp) {
      try {
        if (kind === "rust")
          await cdp.js(
            `__TAURI__.core.invoke('ipc',{channel:'native:test',args:['quit']})`,
          );
      } catch {}
      cdp.close();
    }
    if (child && child.exitCode === null) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {}
    }
  }
}
async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const data =
    process.env.FREESIA_BENCH_RESUME &&
    fs.existsSync(path.join(out, "results.json"))
      ? JSON.parse(fs.readFileSync(path.join(out, "results.json"))).data
      : [];
  const runs = Number(process.env.FREESIA_BENCH_RUNS || 2);
  for (let i = 1; i <= runs; i++)
    for (const kind of i % 2 ? ["electron", "rust"] : ["rust", "electron"]) {
      if (data.some((r) => r.kind === kind && r.run === i)) continue;
      data.push(await run(kind, i));
      fs.writeFileSync(
        path.join(out, "results.json"),
        JSON.stringify(
          {
            baseline: "7a97aaa / Electron 33.4.11",
            candidate: "Rust 4.0.0-beta.1 / WebView2",
            workload:
              "Same isolated Cloud profile, same real microphone fixture and audio buffers, deterministic localhost backend (1 s ASR + 0.5 s formatting), complete process trees",
            data,
          },
          null,
          2,
        ),
      );
    }
  console.log("Benchmark complete");
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => server.close());
