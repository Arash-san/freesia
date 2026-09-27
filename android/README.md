# Freesia for Android

Freesia for Android brings the desktop app's dictation to every text field on the phone.
When you tap into a text field in any app, a small floating "bloom" bubble appears at the
edge of the screen. You tap the bubble and speak. You tap it again (or pause) to stop.
Freesia sends the recording to your Freesia Cloud server, formats the transcript in the
style you picked, and types the result into that field at the cursor.

Version 3.0.1 · package `com.freesia.app` · minSdk 26 (Android 8.0) · targetSdk and compileSdk 37 (Android 17, the newest stable release in September 2026).

## How it works

| Piece | File | What it does |
|---|---|---|
| Accessibility service | `service/FreesiaAccessibilityService.kt` | Watches focus, window and selection events. When an editable, non-password field has input focus and the keyboard window is up, it shows the bubble. The focused field is confirmed with `refresh()` (the service's node cache can be stale), re-checked a few times after every event and every 1.5 s while the bubble is up. If the focus cannot be confirmed, or the input focus is a password field, the bubble stays hidden. |
| Bubble and style picker | `service/BubbleOverlay.kt` | Draws two `TYPE_ACCESSIBILITY_OVERLAY` windows, the bubble and the long-press style picker. Both are `FLAG_NOT_FOCUSABLE`, so they never take focus or the keyboard away from the field. The bubble is draggable, snaps to the nearest edge with a spring and stays above the keyboard. |
| Dictation pipeline | `dictation/DictationController.kt`, `dictation/TranscriptPipeline.kt` | Runs record (WAV, on disk) → register → AAC/ADTS compression → `/v1/audio/transcriptions` with automatic retries → vocabulary corrector → style formatting via `/v1/chat/completions` → vocabulary corrector → delivery. The bubble, the in-app orb, Retry and background recovery share this one pipeline. |
| Saved recordings | `data/RecordingStore.kt`, `dictation/Recovery.kt` | Every take lives in app storage from its first second and is deleted only after its text is delivered. Temporary failures are retried in the background by WorkManager. See "Saved recordings" below. |
| Updates | `update/Releases.kt`, `update/UpdateManager.kt`, `ui/UpdateUi.kt` | In-app updates from the GitHub releases. See "Updates and releases" below. |
| Error reports | `diag/Reports.kt`, `diag/ErrorReporter.kt` | Optional anonymous error reports, a local Diagnostics list and a crash handler. See "Error reports" below. |
| Vocabulary corrector | `core/Vocab.kt` | A port of the desktop's `src/renderer/js/vocab.js`. See "Vocabulary" below. |
| Recorder | `audio/AudioCapture.kt`, `core/Audio.kt` | Records 16 kHz mono PCM from the `VOICE_RECOGNITION` source straight into a WAV file in `files/recordings/`, and reports the level for the orb. It stops by itself after a configurable silence, ends the take (keeping the audio) if Android takes the microphone away, and detects when Android has silenced the microphone. |
| Encoder | `audio/AacEncoder.kt` | After the take, encodes the WAV to AAC-LC at 32 kbps in an ADTS stream (`.aac`, about 4 KB/s). If the device codec misbehaves, the WAV is uploaded instead. See "Recording format" below. |
| Text insertion | `service/TextInserter.kt`, `core/TextSplice.kt` | See "Text insertion" below. |
| API client | `core/FreesiaApi.kt` | OkHttp client for the Freesia Cloud API. There is no built-in server: the user types it on the sign-in screen (Server, Username, Password). It must be `https://`; plain `http://` is accepted only for `localhost` and `127.0.0.1` (the network security config allows cleartext for those two hosts only). On HTTP 401 it clears the token and the app returns to sign-in. |
| Styles and prompt | `core/Styles.kt`, `core/PromptBuilder.kt` | All 12 desktop styles, with the same ids, names, icons and prompts. The formatting prompt matches the desktop `buildFormatPrompt` (without the desktop-only snippets and tools). |
| Token storage | `data/TokenStore.kt` | The device token is encrypted with AES-256-GCM. The key is generated inside the Android Keystore and cannot be exported. |
| UI | `ui/…` | Jetpack Compose screens: onboarding, Home (orb, scratch pad, engine status, words today), History, Styles, Vocabulary and Settings. The orb (`ui/orb/BloomOrb.kt`) ports `src/renderer/js/orb.js` to Compose Canvas, including the slow processing morph (below). |

### Text insertion

Freesia remembers the target field (its `AccessibilityNodeInfo`) when recording starts, so
the text still lands in that field if focus moves while the server works. It tries three
methods in order:

1. It computes the new value by splicing the transcript into the field's current text at
   `textSelectionStart/End`, replacing any selection and adding a joining space when needed.
   It writes that value with `ACTION_SET_TEXT`, then moves the cursor to the end of the
   inserted text with `ACTION_SET_SELECTION`. Fields that are showing their hint count as empty.
2. If the field refuses `SET_TEXT`, or reports success but keeps its old value, Freesia puts
   the text on the clipboard and sends `ACTION_PASTE`.
3. Otherwise the text stays on the clipboard and a "Copied, paste it" toast appears.

Freesia never drops a transcript. If formatting fails for any reason, including an expired
session, the raw transcript is inserted instead. If insertion itself throws, the text goes
to the clipboard. Every result is also saved in local History.

### Recording format

A take is written as **WAV, progressively, straight into app storage** (`files/recordings/`).
While it records, the header carries the "unknown length" sizes (`0xFFFFFFFF`) that decoders
read as "play to the end"; the real sizes are written when the take stops. The file is
flushed to disk about once a second. If the process dies mid-take, the next start finds the
file, fixes its header and lists it in Saved recordings: at most about a second is lost.

For the upload, the finished WAV is encoded to **AAC-LC in ADTS** (`.aac`, 32 kbps, about
4 KB/s, 8 times smaller than WAV). In ADTS every AAC frame carries its own 7-byte header,
so the stream is decodable from a pipe and also when it is cut off mid-way. That is the
reason for the choice. Until 3.0.0 the app uploaded `.m4a` (MediaMuxer, MPEG-4). MPEG-4
stores its index (the `moov` atom) at the end, so a server that decodes from a
non-seekable pipe could not read longer recordings, and a cut-off file cannot be decoded
at all. Opus in Ogg would also stream but needs API 29, and the app supports API 26. Plain
WAV for the upload would be 8 times larger on mobile data. The compressed copy replaces
the WAV only after it is complete: it is written under a temporary name, the sidecar is
updated, and then the WAV is deleted. A crash at any step leaves exactly one complete file.

The live test `truncatedAdtsAndStreamingWavStillDecodeAndTranscribe` cuts an ADTS file and
a streaming-header WAV at 60 %. It checks that ffmpeg still decodes both and that the live
server transcribes both.

### Saved recordings

Freesia never loses a recording. The take is on disk from its first second (above). It is
registered as a saved recording (a small JSON sidecar next to the audio) before the upload
starts. It is deleted only after its text has been delivered and written to History, or
kept if **Settings → Keep recordings** is on. The recording stays, with its error message,
after any failure: network, timeout, HTTP 4xx or 5xx, an expired session, a crash, process
death, or the microphone being taken away. At the next start, a recording that was still
uploading or recording becomes a failed one with a note that Freesia stopped.

**Upload.** Timeouts scale with the take: connect 15 s, then write and read each 60 s plus
1 s per second of audio, and the whole call up to connect + write + read. A network error,
a timeout, HTTP 429 or a 5xx response is retried automatically after 2 s, 6 s and 15 s.
HTTP 400, 401, 403 and 413 are not retried, because repeating them cannot help. While
retrying, Home shows "Connection trouble. Trying again…".

**After that**, the take is kept and the bubble and Home show a calm "saved" state
instead of an error: a tray icon on the bloom and a message like "Couldn't reach the
server. Saved; Freesia will retry." For 10 seconds a tap on the bubble opens Freesia at
Saved recordings.

**Background recovery.** A failure that may pass (network, timeout, 429, 5xx, or an
interrupted upload) also schedules a WorkManager job (`dictation/Recovery.kt`). It needs a
network connection, starts a minute later and backs off exponentially from 30 s. It
survives the app being closed and the phone restarting, and gives up after 10 runs; the
recording then waits for a manual Retry. When it recovers a take, the text goes to the
clipboard and into History, and a "Dictation recovered" notification appears. The
original text field is gone by then, so the text cannot be inserted.

* **History → Saved recordings** lists each one with its time, duration, format and size
  and its error. It offers **Retry**, **Share**, **Save to a file** and **Delete**. Retry
  re-transcribes with the current style, language and vocabulary; the result goes to the
  clipboard and into History (marked "Recovered").
* **Home** shows a banner, and the History tab a badge, while any recording waits.
* Not kept: takes under 0.35 s, pure digital silence from a microphone Android muted, and
  (as on the desktop) a take shorter than 4 s in which the server heard no speech.

### Vocabulary

`core/Vocab.kt` ports the desktop corrector exactly. It runs on the raw transcript before
formatting and again on the formatted text, with no model involved:

1. **Taught corrections** ("Freesia wrote" → "I actually said"), longest first, on word
   boundaries, case-insensitive.
2. **Dictionary terms**, matched even when the recognizer split them with spaces, hyphens,
   underscores, dots or apostrophes ("Py Torch", "py-torch" → "PyTorch"), or spelled them
   letter by letter for terms of 4+ letters ("P Y T O R C H"). Case-only fixes happen only
   for distinctive terms (several tokens, a digit, all caps, or an inner capital), so a plain
   word like "Lab" never recapitalizes an ordinary "lab".

The dictionary also goes to the recognizer as the `prompt` field and into the formatting
prompt. The Vocabulary screen lists corrections, deletes them and has **Teach one**. Every
History item has **Fix a word**, which saves the correction, adds the right term to the
dictionary and fixes that item.

### Styles

Freesia has 12 built-in styles: Normal, Native Language, Casual Chat, Professional Email,
Academic Writing, Technical / Code, Creative Writing, Meeting Notes, Social Media,
Medical / Legal, Bullet Points and Verbatim. Verbatim skips formatting. For Native Language,
Freesia sends the chosen language (Persian by default) as the `language` hint and the
formatter translates into English. Vocabulary words go to the recognizer as the `prompt`
field, which is comma separated and capped at 800 characters. They are also added to the
formatting prompt as "Preserve these custom words exactly", like the desktop.

### Error reports

**Settings → Send anonymous error reports** (also on the first onboarding screen, on by
default for new installs) uses the desktop's wording: "Version, device and error text only.
Never audio, transcripts or passwords." Every caught error, and any crash, is recorded in
**Settings → Diagnostics** (the last 50, on this phone, with **Copy**). If the switch is
on, the error is also sent as JSON to `https://freesia.arash-ahmadi.com/report` in the
desktop's shape: `installId` (a random UUID made on first start), `appVersion`,
`platform` (`android <SDK_INT> <manufacturer> <model>`), `osRelease`, `engine: "cloud"`,
`level`, `context`, `message`, `stack` and `ts` (ISO 8601).

* Redaction (`diag/Reports.kt`, unit tested): device tokens (`fv_…`), `Bearer …` headers,
  Google keys (`AIza…`), every URL, and the configured server address, username and token.
  Reports never contain audio, transcripts, field contents or credentials.
* Reports wait in a queue on disk while offline and go out later. At most 30 are accepted
  per hour, and an identical error only once per 10 minutes.
* A default `UncaughtExceptionHandler` writes the crash to the queue before the process
  dies. It is sent on the next start.

### Updates and releases

**In the app.** At start (at most every 6 hours) and on **Settings → About → Check for
updates**, Freesia reads `https://api.github.com/repos/Arash-san/freesia/releases?per_page=30`
without authentication. It keeps only releases that are not drafts or pre-releases, are
tagged `android-v<x.y.z>`, and carry both `Freesia-Android-<x.y.z>.apk` and
`Freesia-Android-<x.y.z>.apk.sha256`. It offers the highest version (compared number by
number, so 3.0.10 is newer than 3.0.9) that is newer than the installed one. The
desktop's `v…` releases are ignored. An anonymous-API rate limit (HTTP 403 or 429) is
treated quietly as "try again later".

When a newer version exists, an **Update available** card with the release notes appears
on Home and in Settings → About. **Update** downloads the APK to the app's cache and checks
it against the SHA-256 in the `.sha256` asset; a mismatch deletes the file. Then
**Install** opens Android's package installer through a `FileProvider` URI, and the user
confirms there. If Freesia is not yet allowed to "Install unknown apps", the card explains
that in one line and opens that settings screen. Nothing is installed without a tap.
Android installs the update only if it is signed with the same key as the installed app.

**Publishing** (`.github/workflows/android.yml` at the repository root). Pushing a tag
`android-vX.Y.Z` (or running the workflow by hand with a tag) does the following on
`ubuntu-latest`:

1. Fails unless the tag equals `versionName` in `app/build.gradle.kts`.
2. Sets up JDK 21 (Temurin), the Android SDK (platform 37, build-tools 37.0.0) and the
   Gradle cache.
3. Writes the keystore from secrets, runs the unit tests and release lint, and builds the
   signed release APK. Live-server tests skip themselves because CI has no test account.
4. Publishes `Freesia-Android-X.Y.Z.apk` and its `.sha256` as the release
   `Freesia for Android X.Y.Z`, with `--latest=false`, and uses that version's section of
   `CHANGELOG.md` as the notes.

Repository secrets it needs:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 ~/.freesia-android/release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | `storePassword` from `~/.freesia-android/keystore.properties` |
| `ANDROID_KEY_ALIAS` | `keyAlias` (`freesia`) |
| `ANDROID_KEY_PASSWORD` | `keyPassword` |

The workflow writes these into a `keystore.properties` with the same keys the local build
uses: `storeFile` (relative to the properties file), `storePassword`, `keyAlias` and
`keyPassword`. It points `FREESIA_KEYSTORE_PROPS` at that file.

### Processing animation

As on the desktop, the processing state is a slow shape morph and never a spinner. A
separate motion clock runs at 30 % speed (`clock += dt * (1 - procMix * 0.7)`). The petal
amplitude breathes (`0.55 + 0.3 * sin(wall * 0.9)`), each petal layer blends between `lobes`
and `lobes + 2` petals (`morph = procMix * (0.5 + 0.5 * sin(wall * 0.55 + phase))`), and the
bloom turns only at `clock * 0.04` rad/s. The comet arcs and the rotating level ring of
3.0.0 are gone. While listening, the bubble's level ring swells with the voice without
turning.

## Permissions and why

| Permission | Why |
|---|---|
| Accessibility service (user-enabled) | Needed to show the bubble over other apps, to know which field is focused and to write the transcript into it. The disclosure screen in onboarding explains this before sending the user to Settings. The config requests only `typeViewFocused`, `typeViewTextSelectionChanged`, `typeWindowStateChanged`, `typeWindowsChanged`, `flagRetrieveInteractiveWindows` (to see whether the keyboard window is showing and where) and `canRetrieveWindowContent` (to act on the focused field). |
| `RECORD_AUDIO` | Needed to record your voice, and only while the bloom is active. |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` | For a short-lived `microphone` foreground service that runs only during a take. It shows the "Freesia is listening" notification with a Stop button and keeps the microphone working if the screen turns off mid-take. |
| `POST_NOTIFICATIONS` | Needed to show that notification, and "Dictation recovered", on Android 13 and later. It is optional. |
| `INTERNET` | Needed to reach your Freesia Cloud server (and, if you allow it, the error-report endpoint). |
| `REQUEST_INSTALL_PACKAGES` | Lets Freesia hand a downloaded, checksum-verified update to Android's installer. Android still asks the user to allow it once and to confirm every install. |
| `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` | Added by WorkManager, so background recovery can wait for a network and survive a restart. |
| `<queries>` for launcher apps | Needed to show app names in the "Hidden in apps" list. Freesia does not request `QUERY_ALL_PACKAGES`. |

Freesia does **not** use `SYSTEM_ALERT_WINDOW`, because the accessibility service's own
overlay window type needs no extra permission.

**Privacy.** The service never reads what you type. It skips password fields (`isPassword`)
entirely and shows no bubble on them. It reads the focused field's text only once, when a
dictation finishes, to splice the transcript in at the cursor. Field contents never leave
the phone. Audio goes only to the server you signed in to. Backups and device transfer are
disabled (`allowBackup=false` plus `data_extraction_rules.xml`).

## Recording audio while another app is in the foreground (Android 14 to 17)

The problem: `RECORD_AUDIO` is a *while-in-use* permission. Since Android 14 an app cannot
start a `microphone` foreground service from the background. It gets a `SecurityException`,
even when it qualifies for one of the general background-start exemptions ([Android docs: restrictions on starting FGS that need while-in-use permissions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions)).
With the bubble, the app in front is always someone else's (Messages, Chrome and so on), never Freesia.

Why an accessibility service can still record, according to AOSP source:

1. **The system binds accessibility services with `BIND_INCLUDE_CAPABILITIES`.**
   `AccessibilityServiceConnection.bindLocked()` binds with
   `BIND_AUTO_CREATE | BIND_FOREGROUND_SERVICE_WHILE_AWAKE | BIND_ALLOW_BACKGROUND_ACTIVITY_STARTS | BIND_INCLUDE_CAPABILITIES`
   ([source](https://android.googlesource.com/platform/frameworks/base/+/master/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)).
   `BIND_INCLUDE_CAPABILITIES` passes the binder's (system_server's) process capabilities,
   including the foreground-microphone capability, to the bound process. So while the service
   is enabled and the screen is on, Freesia's process can open an `AudioRecord` directly,
   the same way Voice Access and Wispr Flow do.
2. **Freesia may also start a `microphone` FGS.**
   `ActiveServices.shouldAllowFgsWhileInUsePermissionLocked()` allows while-in-use FGS when
   the caller's process "allows background activity starts", and a comment there notes that
   "the binding flag BIND_ALLOW_BACKGROUND_ACTIVITY_STARTS is also allowed by the check here"
   ([source](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/am/ActiveServices.java)).
   The bind above includes that flag, and the user has just tapped Freesia's own overlay.

What Freesia does with this:

* It records inside the accessibility service's process with `AudioRecord` and does not
  depend on the FGS.
* When a take starts, it asks for the `microphone` FGS with plain `startService()` and
  `startForeground(…, FOREGROUND_SERVICE_TYPE_MICROPHONE)`. It deliberately avoids
  `startForegroundService()`: a refusal then costs only the notification and cannot crash
  the process, which would also kill the accessibility service. The FGS stops as soon as
  recording ends.
* If Android still silences the microphone (an OEM policy, or the screen turning off without
  the FGS), `AudioRecord` delivers pure zeros instead of throwing. Freesia detects this and
  says so ("Android muted the microphone…") instead of uploading silence.
* Android 17's "background audio hardening" covers playback, audio focus and volume, not
  capture ([Android 17 behavior changes](https://developer.android.com/about/versions/17/behavior-changes-all)).
  Freesia plays no sounds and uses haptics instead, so this does not affect it.

Samsung Galaxy S25 Edge (One UI 8, Android 16) notes:

* Apps installed from a file are "restricted" and cannot turn on an accessibility service at
  first. Try once, then open **Settings → Apps → Freesia → ⋮ → Allow restricted settings**,
  confirm with your fingerprint or PIN, and turn the service on
  ([Google help](https://support.google.com/android/answer/12623953),
  [One UI 8.5 report](https://github.com/rustdesk/rustdesk/discussions/15725)).
  Installing with `adb install` avoids the restriction. Onboarding shows these steps and has an App info button.
* **Auto Blocker** (Settings → Security and privacy) blocks installing APKs from outside
  the store. Turn it off to install, then turn it back on if you like.
* Set Freesia's battery usage to "Unrestricted" (App info → Battery) so One UI does not stop
  the accessibility service in the background.

## Build

The build runs inside Docker. Nothing Android-related is installed on the Windows host.

```bash
cd android
./build.sh keystore   # once: creates ~/.freesia-android/release.jks + keystore.properties (random password)
./build.sh            # unit tests + lint + signed, minified release APK
./build.sh test       # unit tests only
./build.sh apk        # APK only
./build.sh smoke      # install on a headless Android 16 emulator in Docker and run the smoke test
./build.sh shell      # a shell in the build container
```

* `docker/Dockerfile` contains Temurin JDK 21, Android cmdline-tools, `platforms;android-37.0`,
  `build-tools;37.0.0`, ffmpeg (for the truncated-file tests) and a system Gradle that was used
  once to generate the wrapper. Builds use `./gradlew` (Gradle 9.8.0), AGP 9.4.1 with built-in
  Kotlin 2.4.20, Compose BOM 2026.09.00 and WorkManager 2.12.0.
* The Gradle cache lives in the named volume `freesia-gradle-cache`. Sources are copied to the
  volume `freesia-android-work` for speed, because Windows bind mounts are slow.
* The keystore directory is mounted **read-only** at `/keys`. Neither the keystore nor its
  password is ever in the repo or the image. `.gitignore` also blocks `*.jks` and `keystore.properties`.
* Output: `dist/Freesia-Android-3.0.1.apk`, plus lint and test reports in `dist/reports/`.
* **Live tests.** They run only when `../.tmp/android-test.json` exists: a temporary test account,
  `{"server": "...", "token": "..."}`, kept outside the repository. `build.sh` mounts it and
  `../.tmp/localasr/audio/l1.wav` read-only. The tests read the server address from that file,
  never print it or the token, and never call logout, because that would revoke the token.
  `FREESIA_SEND_SELFTEST_REPORT=1 ./build.sh test` also posts one error report with context
  `android:selftest`.
* **Smoke test** (`docker/Dockerfile.emulator`, `docker/smoke.sh`). With the account file present,
  the emulator signs in through the real sign-in screen against `docker/smoke_server.py`. That
  small stand-in server hands out the test token and forwards every other request to the live
  server; stopping it is the "server down" case. Speech is fed to the emulator's microphone
  with the emulator's gRPC `injectAudio` (`docker/inject_audio.py`). The emulator runs with
  `-gpu swangle_indirect`, because the default `swiftshader_indirect` renderer segfaults on
  Compose offscreen layers.

## What has been verified (2026-09-27)

* **Unit tests (JVM, 90; 89 run by default):** vocabulary corrector (the desktop's three
  vocabulary tests ported assertion for assertion, plus 9 more), prompt building, styles,
  text splicing, server-address rules, API error mapping, upload timeouts, retry and backoff
  against a mock server (503/429 retried after 2 s, 6 s and 15 s; 400/401/403/413 not
  retried), the transcript pipeline (corrector before and after formatting, dictionary sent
  as `prompt`, formatting failure and an expired session still deliver the raw text), saved
  recordings (save before upload, survive restarts, pending → failed, crash in mid-take and
  in mid-compression), WAV streaming header and finalize, ADTS header bits, error-report
  redaction, payload shape, offline queue, de-duplication and hourly cap, the Diagnostics
  log, the WorkManager request, and update selection (desktop `v…` releases, drafts,
  pre-releases and incomplete releases ignored; 3.0.10 > 3.0.9; SHA-256 files).
* **Live tests (6, against the test server):** `/api/me`; transcription of `l1.wav`;
  formatting with the Normal prompt; a revoked token signing out; a failed upload saved, then
  "restart", then Retry against the live server with real speech; and an ADTS file and a
  streaming-header WAV, both cut at 60 %, decoding in ffmpeg and transcribing on the live
  server. One real `android:selftest` error report was accepted (HTTP 200). This test is
  opt-in.
* **Android lint (release):** no issues.
* **Workflow:** `actionlint` (with shellcheck) passes on `.github/workflows/android.yml`. It
  has not run on GitHub yet.
* **Emulator smoke test (Android 16 / API 36, 34 checks, all passed; screenshots in
  `dist/smoke/`):** onboarding shows the error-report switch; the sign-in screen shows empty
  Server, Username and Password fields; the bubble appears on a normal field and not on a
  password field; style picker, drag and snap. Then, with the stand-in server: sign-in; a Home
  take with the server down is retried automatically and ends in the calm saved state with a
  Home banner; a bubble take fails the same way, and tapping the saved bubble opens Saved
  recordings. Both recordings survive a force-stop and restart, and are stored as AAC. Share
  opens the share sheet. Retry reaches the live server. WorkManager retries the other
  recording without a tap and posts "Dictation recovered". Delete works. Check for updates
  answers ("up to date"). Diagnostics lists the failures. No crashes.
* **Not verified:**
  * A real phone: its microphone, recording with the screen off, and the Samsung One UI
    restrictions.
  * A process killed during a real recording on a device. The unit tests cover the recovery
    code.
  * Installing an update end to end: no `android-v…` release exists yet.
  * The CI workflow on GitHub (it needs the secrets).
  * The feel of the orb animation. It matches the desktop's numbers in code, but nobody has
    looked at it on a phone.
  * The emulator's injected microphone is unreliable: a take sometimes carries no speech,
    and the live server then answers "No speech detected". A Retry that recovers real
    speech is proven by the live JVM test.

Install on the phone: `adb install -r dist/Freesia-Android-3.0.1.apk`, or copy the file over
and open it. The package name changed in 3.0.1 (`com.freesia.app`), so it installs next to
3.0.0 rather than over it. Uninstall 3.0.0 first; its history and settings do not carry over.

## Known limitations

* **Insertion depends on the target app.** Standard `EditText`, Compose text fields and
  Chrome inputs accept `ACTION_SET_TEXT`. Some custom editors, such as rich web editors,
  terminals and games, reject it or behave oddly. In those Freesia falls back to paste or
  the clipboard. With `SET_TEXT` the app sees one value change, not typed keystrokes, so
  undo history in the target app may treat the dictation as a single edit.
* **Clipboard.** The paste fallback leaves the transcript on the clipboard. Android 10 and
  later do not let a background app read the clipboard, so Freesia cannot restore what was
  there before.
* The bubble shows only while the keyboard window is up. With a hardware keyboard and no
  on-screen keyboard it may not appear.
* A recovered recording cannot be typed into its original field, which is gone by then. Its
  text goes to the clipboard and History instead.
* The release certificate still carries the organisation name it was created with in 3.0.0.
  Changing that would need a new keystore, and then the APK could not update installs signed
  with the old one.
* Custom styles and snippets from the desktop app are not synced. The 12 built-in styles are
  identical to the desktop ones.
* Local-network servers (for example `https://192.168.x.x`) need Android 17's
  `ACCESS_LOCAL_NETWORK` permission, which this build does not request. Public https
  servers are unaffected.
* Google Play: publishing an app that uses the Accessibility API for something other than
  helping people with disabilities needs a Play Console declaration and review, plus the
  in-app prominent disclosure (this build includes that). This APK is meant for direct install.
