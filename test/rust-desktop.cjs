const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict"),
  vm = require("node:vm");
const { spawn } = require("node:child_process");
const { connect, ready, sleep, screenshot } = require("./desktop-cdp.cjs");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, ".tmp", "rust-desktop");
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, "profile-"));
const results = [];
let cdp, child, overlay;
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, ok: true, detail });
      console.log("PASS " + name);
    });
const api = (name, ...args) =>
  cdp.js(`window.freesia[${JSON.stringify(name)}](...${JSON.stringify(args)})`);
const native = (action) =>
  cdp.js(
    `window.__TAURI__.core.invoke('ipc',{channel:'native:test',args:[${JSON.stringify(action)}]})`,
  );
let translating = true,
  contribution = false;
const calls = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  calls.push({ path: req.url, method: req.method, bytes: body.length });
  let status = 200,
    v = {};
  if (req.url === "/api/auth/login") {
    assert.equal(JSON.parse(body).username, "native-test");
    v = { token: "fv_native_test_not_a_real_token", username: "native-test" };
  } else if (
    req.headers.authorization !== "Bearer fv_native_test_not_a_real_token"
  ) {
    status = 401;
    v = { error: { message: "Sign in" } };
  } else if (req.url === "/api/me")
    v = {
      username: "native-test",
      asrModel: "fixture-asr",
      formattingModel: "fixture-format",
    };
  else if (req.url === "/api/contribute" && req.method === "GET")
    v = {
      available: true,
      enabled: contribution,
      version: 1,
      terms: {
        version: 1,
        title: "Test-only terms",
        summary: "Test-only server",
        paragraphs: [],
      },
      decided: true,
    };
  else if (req.url === "/api/contribute" && req.method === "POST") {
    contribution = JSON.parse(body).enabled;
    v = { available: true, enabled: contribution, version: 1 };
  } else if (req.url === "/api/contribute/recordings") v = { deleted: 0 };
  else if (req.url === "/v1/audio/transcriptions")
    v = {
      text: "Open Claude on Yorha and test GPT 5.6 SOL.",
      model: "fixture-asr",
    };
  else if (req.url === "/v1/audio/translations") {
    if (translating)
      v = {
        text: "Translated fixture.",
        source_text: "Persian fixture.",
        translated: true,
        model: "fixture-translation",
      };
    else {
      status = 404;
      v = { error: { message: "No translation endpoint" } };
    }
  } else if (req.url === "/v1/chat/completions")
    v = {
      choices: [
        { message: { content: "Open Claude on Yorha and test GPT 5.6 SOL." } },
      ],
    };
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(v));
});
async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const address = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      onboarded: true,
      seenV3: true,
      theme: "dark",
      engine: "cloud",
      sounds: false,
      errorReporting: false,
      keepMicReady: false,
      keepCancelledRecordings: true,
    }),
  );
  fs.mkdirSync(path.join(profile, "styles"));
  fs.writeFileSync(
    path.join(profile, "styles", "example.json"),
    JSON.stringify({
      name: "Native test style",
      prompt: "Return concise text",
      icon: "🌸",
    }),
  );
  const exe =
    process.env.FREESIA_RUST_EXE ||
    path.join(root, "src-tauri", "target", "debug", "freesia-desktop.exe");
  child = spawn(exe, ["--profile", profile, "--no-shortcuts"], {
    env: {
      ...process.env,
      FREESIA_DEBUG_PORT: "9437",
      FREESIA_TEST_AUDIO: path.join(
        root,
        ".tmp",
        "localasr",
        "audio",
        "long.wav",
      ),
    },
    windowsHide: true,
      cwd: path.dirname(exe),
    stdio: "ignore",
  });
  cdp = await connect(9437);
  await ready(cdp);
  await sleep(800);
  await check("all preload methods retained", async () => {
    let original;
    vm.runInNewContext(
      fs.readFileSync(path.join(root, "src/main/preload.js"), "utf8"),
      {
        require: () => ({
          contextBridge: {
            exposeInMainWorld: (_, value) => (original = value),
          },
          ipcRenderer: {},
        }),
      },
    );
    const names = await cdp.js("Object.keys(window.freesia).sort()");
    assert.deepEqual(names, Object.keys(original).sort());
    return `${names.length} methods and events`;
  });
  await check("settings persistence and secret boundary", async () => {
    await api("setSetting", "dictionary", ["Yorha", "Claude"]);
    assert.deepEqual(await api("getSetting", "dictionary"), [
      "Yorha",
      "Claude",
    ]);
    assert.equal(
      await api("setSetting", "secrets.cloud", "should-not-save"),
      false,
    );
    const settings = await api("getSettings");
    for (const k of ["cloud", "secrets", "apiKey", "installId"])
      assert.equal(settings[k], undefined);
  });
  await check("cloud login uses encrypted storage", async () => {
    const state = await api("cloudLogin", address, "native-test", "test-only");
    assert.equal(state.configured, true);
    assert(
      !fs
        .readFileSync(path.join(profile, "config.json"), "utf8")
        .includes("fv_native_test_not_a_real_token"),
    );
    await cdp.js("engineState=await api.engineStatus();");
  });
  await check("cloud health and opt-in contribution controls", async () => {
    assert.equal((await api("cloudHealth")).model, "fixture-asr");
    assert.equal((await api("cloudContribution")).enabled, false);
    assert.equal((await api("cloudSetContribution", true, 1)).enabled, true);
    assert.equal((await api("cloudSetContribution", false, 1)).enabled, false);
    assert.equal((await api("cloudDeleteContributions")).deleted, 0);
  });
  await check(
    "binary audio upload, formatting, translation and old-server fallback",
    async () => {
      const audio = fs
        .readFileSync(path.join(root, ".tmp/localasr/audio/l1.webm"))
        .toString("base64");
      const run = (task) =>
        cdp.js(
          `api.transcribe({engine:'cloud',audio:Uint8Array.from(atob('${audio}'),c=>c.charCodeAt(0)).buffer,mime:'audio/webm',language:'en',prompt:'Claude, Yorha',durationSec:4.8,task:${JSON.stringify(task)}})`,
        );
      assert.equal(
        (await run("transcribe")).text,
        "Open Claude on Yorha and test GPT 5.6 SOL.",
      );
      assert.equal(
        (await api("format", { engine: "cloud", prompt: "Format fixture" }))
          .text,
        "Open Claude on Yorha and test GPT 5.6 SOL.",
      );
      assert.equal((await run("translate")).translated, true);
      translating = false;
      assert.equal(
        (await run("translate")).text,
        "Open Claude on Yorha and test GPT 5.6 SOL.",
      );
    },
  );
  await check(
    "saved audio roundtrip, metadata, retry list and deletion",
    async () => {
      const id = await cdp.js(
        `api.saveFailedAudio(new Uint8Array([1,2,3,4]).buffer,{timestamp:new Date().toISOString(),error:'Fixture'})`,
      );
      assert.equal((await api("getFailedRecordings"))[0].baseName, id);
      assert.deepEqual(
        await cdp.js(
          `api.getFailedRecordingData('${id}').then(b=>Array.from(new Uint8Array(b)))`,
        ),
        [1, 2, 3, 4],
      );
      assert.equal(await api("deleteFailedRecording", "../config"), false);
      assert.equal(await api("deleteFailedRecording", id), true);
    },
  );
  await check("styles, themes, version and updates", async () => {
    assert.equal(
      (await api("importStylesFromDisk"))[0].name,
      "Native test style",
    );
    assert.equal(
      (await api("setAppTheme", "light")).shouldUseDarkColors,
      false,
    );
    await screenshot(cdp, path.join(artifacts, "home-light.png"));
    await api("setAppTheme", "dark");
    assert.equal(await api("getAppVersion"), "4.0.0-beta.1");
    const status = await api("checkForUpdates");
    assert(["disabled", "current", "error"].includes(status.status));
  });
  await check("all interface views render without overflow", async () => {
    for (const view of [
      "home",
      "history",
      "styles",
      "vocabulary",
      "engines",
      "settings",
    ]) {
      await cdp.js(`showView('${view}')`);
      await sleep(600);
      assert.equal(
        await cdp.js("document.documentElement.scrollWidth<=innerWidth"),
        true,
        view,
      );
      await screenshot(cdp, path.join(artifacts, `${view}.png`));
    }
    return "Six original views captured";
  });
  await check(
    "real MediaRecorder, hidden recording, overlay audio levels and cancellation",
    async () => {
      await native("dictate");
      overlay = await connect(9437, "overlay.html");
      for (let i = 0; i < 80; i++) {
        if (await overlay.js(`typeof window.freesia==='object'`)) break;
        await sleep(100);
      }
      await overlay.js(
        `window.levels=[];freesia.onOverlayAudioLevel(v=>levels.push(v));`,
      );
      await sleep(1100);
      assert.equal(await cdp.js("isRecording"), true);
      await api("close");
      const before = await overlay.js("levels.length");
      await sleep(1300);
      const after = await overlay.js("levels.length");
      assert(
        after - before > 15,
        `Only ${after - before} hidden meter samples`,
      );
      await native("cancel");
      await sleep(700);
      const saved = await api("getFailedRecordings");
      assert(saved.some((r) => (r.error || "").includes("Cancelled with Esc")));
      overlay.close();
      overlay = null;
      await native("show");
      return { hiddenMeterSamples: after - before };
    },
  );
  await check(
    "real recording completes transcription and history delivery",
    async () => {
      await cdp.js(
        `settings.keepMicReady=false;settings.engineFallback=true;engineState=await api.engineStatus();showView('home');await startRecording('test');`,
      );
      await sleep(2000);
      await cdp.js("stopRecording()");
      for (let i = 0; i < 120; i++) {
        if (
          await cdp.js(
            "!isProcessingAudio && !isStoppingRecording && settings.history?.length>0",
          )
        )
          break;
        await sleep(100);
      }
      assert.equal(
        await cdp.js("settings.history[0].text"),
        "Open Claude on Yorha and test GPT 5.6 SOL.",
      );
      assert(
        calls
          .filter((c) => c.path === "/v1/audio/transcriptions")
          .some((c) => c.bytes > 10000),
      );
    },
  );
  await check(
    "Gemini selection retains configured Cloud fallback",
    async () => {
      await cdp.js(`engineState.engine='gemini';settings.engineFallback=true;`);
      const audio = fs
        .readFileSync(path.join(root, ".tmp/localasr/audio/l1.webm"))
        .toString("base64");
      await cdp.js(
        `processAudio(new Blob([Uint8Array.from(atob('${audio}'),c=>c.charCodeAt(0))],{type:'audio/webm'}),'test',{durationSec:4.8})`,
      );
      assert.equal(await cdp.js("settings.history[0].engine"), "cloud");
      await cdp.js(`engineState.engine='cloud'`);
    },
  );
  await check("application discovery and icons", async () => {
    const apps = await api("scanApps", false, ["notepad", "chrome"]);
    assert(apps.length > 0);
    return `${apps.length} installed/running apps`;
  });
  await check("window controls and close-to-tray", async () => {
    await api("toggleMaximize");
    await sleep(200);
    await api("toggleMaximize");
    await api("close");
    await sleep(200);
    await native("show");
    await sleep(300);
  });
  await check(
    "deep idle resumes natively and starts a fresh hidden recording",
    async () => {
      await api("close");
      await cdp.js(
        `void __TAURI__.core.invoke('ipc',{channel:'native:suspend',args:[]})`,
      );
      await sleep(700);
      const wake = spawn(exe, ["--profile", profile, "--no-shortcuts"], {
        env: process.env,
        windowsHide: true,
        stdio: "ignore",
      });
      await Promise.race([
        new Promise((r) => wake.once("exit", r)),
        sleep(5000).then(() => {
          wake.kill();
          throw Error("Second instance did not wake the main view");
        }),
      ]);
      await sleep(300);
      await api("close");
      const recording = await cdp.js(
        `(async()=>{await startRecording('test');return isRecording;})()`,
      );
      assert.equal(recording, true);
      await sleep(600);
      await cdp.js("stopRecording(true)");
      await sleep(500);
    },
  );
  assert.deepEqual(cdp.errors, []);
  return true;
}
main()
  .then(() => {
    fs.writeFileSync(
      path.join(artifacts, "results.json"),
      JSON.stringify({ passed: true, results }, null, 2),
    );
  })
  .catch((e) => {
    console.error(e);
    fs.writeFileSync(
      path.join(artifacts, "results.json"),
      JSON.stringify({ passed: false, results, error: e.stack }, null, 2),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    overlay?.close();
    if (cdp) {
      try {
        await native("quit");
      } catch {}
      cdp.close();
    }
    child?.kill();
    server.close();
  });
