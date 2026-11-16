// Signing key stays in the build account's credential folder, never in a release.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const [installer, version] = process.argv.slice(2);
if (!installer || !version)
  throw Error("Usage: node scripts/sign-rust-update.cjs <installer> <version>");
const keyFile =
  process.env.FREESIA_SIGNING_KEY ||
  path.join(process.env.LOCALAPPDATA, "FreesiaBuild", "update-ed25519.pem");
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const actualPublic = crypto
  .createPublicKey(key)
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("base64");
if (
  actualPublic !==
  fs
    .readFileSync(
      path.join(__dirname, "../src-tauri/src/update-public-key.txt"),
      "utf8",
    )
    .trim()
)
  throw Error("The signing key does not match this app.");
const sha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(installer))
  .digest("hex");
const url = `https://github.com/arash-san/freesia/releases/download/rust-v${version}/${path.basename(installer)}`;
const signature = crypto
  .sign(null, Buffer.from(`${version}\n${url}\n${sha256}\n`), key)
  .toString("base64");
const notesPath = path.join(__dirname, "../RELEASE_NOTES_RUST.md");
const notes =
  process.env.FREESIA_RELEASE_NOTES ||
  (fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : "");
const manifest = {
  version,
  url,
  sha256,
  signature,
  releaseDate: new Date().toISOString(),
  notes,
};
const out = path.join(path.dirname(installer), "freesia-rust-update.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(out);
