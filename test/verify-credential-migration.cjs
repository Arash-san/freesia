const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  temporary = path.join(root, ".tmp", "credential-migration");
fs.mkdirSync(temporary, { recursive: true });
const profile = fs.mkdtempSync(path.join(temporary, "copy-"));
try {
  for (const file of ["config.json", "Local State"])
    fs.copyFileSync(
      path.join(process.env.APPDATA, "freesia", file),
      path.join(profile, file),
    );
  const run = spawnSync(
    path.join(root, "src-tauri/target/debug/freesia-desktop.exe"),
    ["--profile", profile, "--verify-migration"],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.equal(
    run.status,
    0,
    "Rust could not open the isolated credential copy",
  );
  const env = { ...process.env, FREESIA_MIGRATION_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawnSync(
    require("electron"),
    [path.join(__dirname, "electron-credential-audit.cjs")],
    { env, encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.equal(
    electron.status,
    0,
    "Electron could not read the Rust credential envelopes",
  );
  const line = electron.stdout
    .trim()
    .split(/\r?\n/)
    .find((s) => s.startsWith("{"));
  const report = JSON.parse(line);
  assert(report.passed);
  fs.writeFileSync(
    path.join(temporary, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  const resolved = fs.realpathSync(profile),
    allowed = fs.realpathSync(temporary) + path.sep;
  if (!resolved.startsWith(allowed))
    throw Error("Refusing to delete outside the isolated test folder");
  fs.rmSync(resolved, { recursive: true, force: true });
}
