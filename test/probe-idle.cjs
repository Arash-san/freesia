const fs = require("node:fs"),
  path = require("node:path"),
  { spawn, execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const { connect, ready, sleep } = require("./desktop-cdp.cjs");
const root = path.resolve(__dirname, ".."),
  base = path.join(root, ".tmp", "idle-probe");
fs.mkdirSync(base, { recursive: true });
const profile = fs.mkdtempSync(path.join(base, "profile-"));
fs.writeFileSync(
  path.join(profile, "config.json"),
  JSON.stringify({
    onboarded: true,
    seenV3: true,
    sounds: false,
    errorReporting: false,
    keepMicReady: true,
  }),
);
const exe = path.join(root, "src-tauri/target/release/freesia-desktop.exe"),
  env = {
    ...process.env,
    FREESIA_DEBUG_PORT: "9435",
    FREESIA_TEST_AUDIO: path.join(root, ".tmp/localasr/audio/long.wav"),
  };
const child = spawn(exe, ["--profile", profile, "--no-shortcuts"], {
  env,
  stdio: "ignore",
  windowsHide: true,
});
let cdp, fresh;
const limited = (p) =>
  Promise.race([
    p,
    sleep(3500).then(() => {
      throw Error("3.5s probe timeout");
    }),
  ]);
async function main() {
  cdp = await connect(9435);
  await ready(cdp);
  await sleep(1000);
  await cdp.js("freesia.close()");
  await cdp.js(
    "void __TAURI__.core.invoke('ipc',{channel:'native:suspend',args:[]})",
  );
  console.log("suspend requested");
  await sleep(21000);
  const wake = spawn(exe, ["--profile", profile, "--no-shortcuts"], {
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  await limited(new Promise((r) => wake.once("exit", r)));
  console.log("second instance exited");
  const { stdout } = await promisify(execFile)(
    "pwsh.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${child.pid} | Select-Object MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true },
  );
  console.log(stdout.trim());
  try {
    console.log("old CDP", await limited(cdp.js("1+1")));
  } catch (e) {
    console.log("old CDP", e.message);
  }
  fresh = await connect(9435);
  console.log("fresh CDP enabled");
  console.log("new CDP", await limited(fresh.js("1+1")));
  await limited(fresh.js("freesia.close()"));
  console.log("hidden again");
  console.log(
    "start dispatched",
    await limited(fresh.js("void startRecording('test')")),
  );
  await sleep(1800);
  console.log(
    "state",
    await limited(
      fresh.js(
        "({isRecording,isStartingRecording,hidden:document.hidden,nativeVisible:window.__freesiaVisible,errors:errorLog})",
      ),
    ),
  );
  await fresh.js("stopRecording(true)");
}
main()
  .catch(console.error)
  .finally(async () => {
    if (fresh) {
      try {
        await limited(
          fresh.js(
            "__TAURI__.core.invoke('ipc',{channel:'native:test',args:['quit']})",
          ),
        );
      } catch {}
      fresh.close();
    }
    cdp?.close();
    child.kill();
  });
