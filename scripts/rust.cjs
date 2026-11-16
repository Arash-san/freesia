const path = require("node:path"),
  { spawnSync } = require("node:child_process");
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "4",
  PATH:
    path.join(process.env.USERPROFILE, ".cargo", "bin") +
    path.delimiter +
    process.env.PATH,
};
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, ".."),
  env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
