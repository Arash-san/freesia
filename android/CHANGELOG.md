# Changelog: Freesia for Android

Each `## <version>` section becomes the notes of the GitHub release `android-v<version>`
(see `.github/workflows/android.yml` at the repository root).

## 3.0.1

This release makes sure no dictation is ever lost, and adds updates from inside the app.

**Recordings are never lost**
- Every take is written to the phone's storage while you speak, not kept in memory. If
  Freesia is closed or crashes mid-take, the recording is still there at the next start.
- A take that cannot be transcribed stays in **History → Saved recordings** with the
  reason. From there you can Retry it, share it, save it to a file or delete it. Retry
  copies the text to the clipboard and adds it to History.
- Uploads are retried automatically when the connection drops, the server is busy or it
  takes too long. After that, Freesia keeps retrying in the background once a network is
  available, and shows a notification when the text is ready.
- Instead of an error, the bubble shows a calm "saved" state. Tap it to open the saved
  recording.
- Recordings are now uploaded as AAC in ADTS, a streamable format that the server can
  decode even for long takes. The old M4A files failed on long recordings.

**Vocabulary**
- Freesia now fixes dictionary words that the recognizer split up or spelled out, such as
  "Py Torch" or "P Y T O R C H" for "PyTorch". It uses the same rules as the desktop app.
- Teach corrections ("Freesia wrote" → "I actually said") on the Vocabulary screen, or use
  **Fix a word** on any History item.

**Other changes**
- The sign-in screen asks for your server, username and password. There is no built-in
  server any more.
- In-app updates: Freesia checks for new versions and shows an Update card. It downloads
  an update only when you tap, checks it against its published SHA-256, and Android asks
  you to confirm the install.
- Optional anonymous error reports (version, device and error text only; never audio,
  transcripts or passwords), and a Diagnostics list in Settings.
- The processing animation is now a slow change of shape, the same as on the desktop,
  instead of spinning.
- New app icon: the iridescent five-petal bloom, with a themed (monochrome) version.
- The package name is now `com.freesia.app`. This version installs next to 3.0.0 rather
  than updating it, so uninstall 3.0.0 first.
