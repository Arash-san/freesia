const fs = require("node:fs"),
  path = require("node:path"),
  { spawn, execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const { connect, ready, sleep } = require("./desktop-cdp.cjs"),
  execute = promisify(execFile),
  root = path.resolve(__dirname, ".."),
  out = path.join(root, ".tmp", "renderer-profile");
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(out, "profile-"));
fs.writeFileSync(
  path.join(profile, "config.json"),
  JSON.stringify({
    onboarded: true,
    seenV3: true,
    engine: "cloud",
    sounds: false,
    errorReporting: false,
  }),
);
const child = spawn(
  path.join(root, "src-tauri/target/debug/freesia-desktop.exe"),
  ["--profile", profile, "--no-shortcuts"],
  {
    env: { ...process.env, FREESIA_DEBUG_PORT: "9436" },
    windowsHide: true,
    stdio: "ignore",
  },
);
let cdp;
const data = [];
async function sample(name) {
  const { stdout } = await execute(
    "pwsh.exe",
    [
      "-NoProfile",
      "-File",
      path.join(__dirname, "measure-process-tree.ps1"),
      "-RootProcess",
      String(child.pid),
      "-Seconds",
      "12",
    ],
    { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
  );
  const r = JSON.parse(stdout);
  data.push({ name, ...r });
  console.log(
    name,
    "CPU",
    r.meanCpuPercent.toFixed(3),
    "WS",
    r.meanWorkingMiB.toFixed(1),
  );
}
async function main() {
  cdp = await connect(9436);
  await ready(cdp);
  await sleep(10000);
  await sample("original rendering");
  await cdp.js(
    `window.optimization=document.createElement('style');optimization.textContent='.ambient-glow {will-change:transform}.orb-btn canvas {will-change:transform;transform:translateZ(0)}.grain{transform:translateZ(0)}';document.head.append(optimization);`,
  );
  await sleep(1200);
  await sample("compositor layers");
  await cdp.js(`optimization.remove()`);
  await sleep(1200);
  await sample("original rendering repeat");
  await cdp.js(`freesia.close()`);
  await sleep(20000);
  await sample("hidden and suspended");
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(data, null, 2),
    );
    if (cdp) {
      try {
        await cdp.js(
          `__TAURI__.core.invoke('ipc',{channel:'native:test',args:['quit']})`,
        );
      } catch {}
      cdp.close();
    }
    child.kill();
  });
