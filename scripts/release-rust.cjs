const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  config = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
const cargoVersion = fs
  .readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8")
  .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVersion !== config.version)
  throw Error(
    "Cargo and Tauri application versions must match before release.",
  );
function run(file, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, file), ...args],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run("rust.cjs", ["build"]);
const dir = path.join(root, "src-tauri/target/release/bundle/nsis");
const installer = fs
  .readdirSync(dir)
  .find((name) => name.includes(config.version) && name.endsWith("-setup.exe"));
if (!installer) throw Error("The Rust installer is missing.");
run("sign-rust-update.cjs", [path.join(dir, installer), config.version]);
console.log(
  "Rust release artifacts are ready. The rust-v tag workflow publishes a signed prerelease when its signing secret is configured.",
);
