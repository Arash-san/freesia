const { app, safeStorage } = require("electron"),
  fs = require("node:fs"),
  path = require("node:path");
const profile = process.env.FREESIA_MIGRATION_PROFILE;
if (!profile) throw Error("An isolated migration profile is required");
app.setPath("userData", profile);
app.whenReady().then(() => {
  try {
    const before = JSON.parse(
        fs.readFileSync(path.join(profile, "config.before-rust.json"), "utf8"),
      ),
      after = JSON.parse(
        fs.readFileSync(path.join(profile, "config.json"), "utf8"),
      );
    const unpack = (value) => {
      if (!value) return "";
      if (value.startsWith("plain:")) return value.slice(6);
      if (value.startsWith("enc:"))
        return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
      return value;
    };
    let count = 0;
    for (const name of ["cloud", "gemini", "localServer"]) {
      const a = unpack(before.secrets?.[name]),
        b = unpack(after.secrets?.[name]);
      if (a !== b) throw Error(`Credential mismatch: ${name}`);
      if (a) count++;
    }
    console.log(
      JSON.stringify({
        passed: true,
        credentialsChecked: count,
        electronReadsRustEnvelope: true,
      }),
    );
    app.exit(0);
  } catch {
    console.error(
      "Credential migration comparison failed (no credentials printed).",
    );
    app.exit(1);
  }
});
