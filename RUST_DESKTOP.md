# Freesia Rust desktop

The Windows runtime is implemented in Rust with Tauri 2 and the system WebView2 runtime. The existing HTML, CSS, JavaScript interface and animations are retained. Node and Electron are build and development dependencies; the installed Rust app does not run them. Windows application discovery and Office/Store icon extraction use temporary PowerShell helpers.

## Build and verify

Install the Rust MSVC toolchain, Visual Studio C++ Build Tools, Node and WebView2. Then run:

```powershell
npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml -j 4
npm run build:rust
```

The default start, development and build commands now use Rust. Previous commands remain available as `start:electron`, `dev:electron`, `build:electron`, `package:electron` and `release:electron`. `npm run release` builds and signs the local Rust release artifacts.

The installer is in `src-tauri/target/release/bundle/nsis/`. `npm run dev:rust` runs the development build. `test/rust-desktop.cjs` verifies the real WebView2 interface against a localhost test server and fake microphone input. Its public domain audio fixtures live in the local `.tmp/localasr/audio` test assets. `test/rust-native-parity.cjs` tests the installed local model and, when an interactive foreground window is available, scan code paste and selection capture. Tests use separate profiles and never upload audio to a real account.

## Migration and rollback

Quit the existing Freesia from its tray icon before opening the Rust version. Both use `%APPDATA%\freesia` for settings, history, recordings, styles and downloaded models. The Rust version refuses to start against that profile while the Electron app is running. The first migration creates `config.before-rust.json`. Existing encrypted credentials keep Electron's AES-GCM envelope and Windows DPAPI key, so both versions can read them. WebView2 browser files live in a separate `webview2` subdirectory. Electron's original `Local State` credential key stays available.

Rollback: quit the Rust app and launch the previous Electron installation. Current settings and credentials remain compatible; the original settings backup is available if needed. The previous installer and downloaded model files are not removed by this build. A legacy Dictaloom profile is imported when no Freesia profile exists.

An isolated profile can be used for evaluation:

```powershell
.\freesia-desktop.exe --profile C:\path\to\test-profile --no-shortcuts
```

`--background` starts in the tray. `--no-shortcuts` is for isolated automation. `FREESIA_DEBUG_PORT` enables loopback DevTools explicitly; normal launches do not enable it. `FREESIA_TEST_AUDIO` supplies a fake microphone fixture for automation. `--profile <copy> --verify-migration` checks and rewrites credentials in an isolated profile and prints presence/unlock booleans only.

## Preserved desktop behavior

| Feature | Rust implementation |
| --- | --- |
| Interface bridge | All 78 Electron preload methods and events, including settings, theme, window controls and diagnostics. |
| Freesia Cloud | Sign in, session handling, contribution terms, explicit consent and deletion, transcription, translation and formatting. |
| Gemini | Encrypted keys, model discovery and selection, retries, cooldowns, formatting and engine fallback. |
| Local models | Existing pinned Qwen models and runtime, verified resumable downloads, cancellation, GPU selection, loading, idle unloading, long WAV splitting and inference. A Windows job object ties model processes to the app. |
| Keyboard | Dictation and command shortcuts, Escape cancellation, conflict rollback, clipboard preservation, scan code paste and selection editing. |
| Windows integration | Animated transparent overlay, meter, timer, status messages, tray controls, autostart and single instance. |
| Writing tools | Vocabulary, corrections, snippets, styles, rules and icons for each app, history, statistics, recovery recordings, playback and retry. |
| Microphone | Selection, onboarding and the existing two minute readiness option. |
| Updates | Confirmed installation, progress and release notes. Downloaded installers remain available after an offline check. |

When hidden, animations stop, WebView2's controller is explicitly hidden, and an idle main view can suspend. Recording, processing and microphone readiness prevent suspension. The overlay is created on demand and destroyed after its exit animation.

## Update releases

Rust updates use `rust-v<version>` GitHub releases and `freesia-rust-update.json` assets. The manifest contains a SHA-256 and Ed25519 signature binding the version, installer URL and checksum. The app verifies both the signature and installer bytes before launching an update. Installation waits for dictation to finish and runs the NSIS installer with `/S /R` to reopen Freesia afterward.

The public verification key is checked in. The private signing key is outside this repository, under the local build account's `FreesiaBuild` folder, or supplied through `FREESIA_SIGNING_KEY`. Never include it in a release. Run:

```powershell
node scripts/sign-rust-update.cjs <installer.exe> <version>
```

The CI workflow requires the corresponding `FREESIA_SIGNING_KEY_PEM` GitHub Actions secret before publishing a tagged prerelease. Branch builds produce reviewable installers without publishing a release. Windows Authenticode signing is separate from update signature verification.

## Performance verification

`test/benchmark-desktop.cjs` compares a source snapshot of desktop 3.1.1 (`7a97aaa`) with the optimized Rust binary, using separate equivalent Cloud profiles, the same audio, and a deterministic localhost backend. `test/measure-process-tree.ps1` includes every descendant, including WebView2 and the Electron keyboard helper. It reports summed working set, private committed bytes and CPU normalized by the machine's logical processor count. Working sets include shared pages and are not a measure of unique physical memory.

The audio backend fixture isolates desktop cost; these measurements do not establish faster server inference or accuracy. Local model weights require additional memory. The 100 MiB request remains a target until the complete process tree measurements support it. See the delivered benchmark report for measured results and limitations.
