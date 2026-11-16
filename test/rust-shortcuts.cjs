// Use the production WM_HOTKEY callback, rather than native:test's async IPC path.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { connect, ready, sleep } = require("./desktop-cdp.cjs");
const root = path.resolve(__dirname, "..");
const out = path.join(root, ".tmp", "rust-shortcuts");
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(out, "profile-"));
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
    showOverlay: true,
    softwareRendering: process.env.FREESIA_TEST_SOFTWARE_RENDERING === "1",
    dictationShortcut: "Ctrl+Alt+Shift+F24",
    commandShortcut: "Ctrl+Alt+Shift+F23",
    keepCancelledRecordings: false,
  }),
);
let child, cdp;
const report = { checks: [] };
let uploads = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) {
  }
  let value = {};
  if (req.url === "/api/auth/login")
    value = {
      token: "fv_shortcut_fixture_not_a_real_token",
      username: "shortcut-test",
    };
  else if (req.url === "/api/me")
    value = { username: "shortcut-test", asrModel: "fixture" };
  else if (req.url === "/api/contribute") value = { available: false };
  else if (req.url === "/v1/audio/transcriptions") {
    uploads++;
    value = { text: "Shortcut regression test." };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
});
const api = (name, ...args) =>
  cdp.js(`freesia[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
const windows = (...args) =>
  JSON.parse(
    execFileSync(
      "python",
      [
        path.join(__dirname, "windows-hotkey.py"),
        "--pid",
        String(child.pid),
        ...args,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
const hotkey = (key) => windows(...(key ? ["--key", key] : []));
async function until(expression, timeout = 7000) {
  const end = Date.now() + timeout;
  do {
    if (await cdp.js(expression)) return;
    await sleep(100);
  } while (Date.now() < end);
  throw Error("Timed out: " + expression);
}
async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const exe =
    process.env.FREESIA_RUST_EXE ||
    path.join(root, "src-tauri", "target", "debug", "freesia-desktop.exe");
  child = spawn(exe, ["--profile", profile], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      FREESIA_DEBUG_PORT: "9442",
      FREESIA_TEST_AUDIO: path.join(
        root,
        ".tmp",
        "localasr",
        "audio",
        "long.wav",
      ),
    },
  });
  cdp = await connect(9442);
  await ready(cdp);
  await api(
    "cloudLogin",
    `http://127.0.0.1:${server.address().port}`,
    "shortcut-test",
    "fixture",
  );
  await cdp.js(
    "freesia.engineStatus().then(s=>__freesiaTest.setEngineState(s))",
  );
  for (let n = 0; n < 10; n++) {
    await api("toggleMaximize");
    await sleep(300);
    const probe = hotkey();
    assert.equal(
      probe.responsive,
      true,
      "Windows message loop hung after maximize/restore",
    );
  }
  report.checks.push(
    "Maximize and restore keep the Windows message loop responsive",
  );
  for (const action of ["minimize", "restore", "close", "restore"]) {
    assert.equal(windows("--window", action).posted, true);
    await sleep(400);
    assert.equal(
      hotkey().responsive,
      true,
      `Windows message loop hung after ${action}`,
    );
  }
  report.checks.push(
    "Native minimize, close to tray and restore remain responsive",
  );
  // Deliberately avoid desktop paste while exercising the recording lifecycle.
  await cdp.js(
    `window.__shortcutStarts=0;window.__shortcutCancels=0;window.__shortcutPastes=0;freesia.injectText=async()=>{__shortcutPastes++;return true;};freesia.onDictationStart(()=>__shortcutStarts++);freesia.onDictationCancel(()=>__shortcutCancels++);`,
  );
  await api("close");
  await sleep(400);
  const start = Date.now();
  assert.equal(hotkey("F24").posted, true);
  await until("__shortcutStarts===1");
  report.firstShortcutMs = Date.now() - start;
  assert.equal(hotkey().responsive, true);
  report.checks.push(
    "Real Windows shortcut opens lazy overlay and starts hidden recording without hanging",
  );
  await sleep(1200);
  assert.equal(hotkey("F24").posted, true);
  await until("__shortcutPastes===1");
  assert.equal(uploads, 1);
  report.checks.push(
    "Second shortcut stops and transcribes, with desktop paste stubbed",
  );
  await sleep(2300);
  for (let n = 2; n <= 4; n++) {
    hotkey("F24");
    await until(`__shortcutStarts===${n}`);
    await sleep(600);
    hotkey("Escape");
    await until(`__shortcutCancels===${n - 1}`);
    await sleep(600);
    assert.equal(hotkey().responsive, true);
  }
  report.checks.push(
    "Overlay teardown and recreation survive repeated shortcut and Escape cycles",
  );
  assert.deepEqual(cdp.errors, []);
  report.passed = true;
}
main()
  .catch((e) => {
    report.passed = false;
    report.error = e.stack;
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(out, process.env.FREESIA_TEST_LABEL || "results.json"),
      JSON.stringify(report, null, 2),
    );
    if (cdp) cdp.close();
    if (child && child.exitCode === null)
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {}
    server.close();
  });
