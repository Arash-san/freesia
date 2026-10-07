# Changelog

## 3.1.1

**Spelled names become words.** Freesia now joins names and words dictated letter by letter even when they are absent from your dictionary. For example, "H A M I D" becomes "Hamid". The cleanup runs after recognition and again after formatting, including when AI formatting is off. Common acronyms such as GPT, API and NAS retain their capitals, and dictionary entries keep their preferred spelling. Ordinary dotted initials such as "J. R. R. Tolkien" remain intact.

## 3.1.0

**Help train Freesia Voice, if you want to.** If you are signed in to InquireLab's Freesia Voice server, you can now share your recordings so its speech model gets better at the names, courses and terms you actually say. It stays off unless you turn it on. After this update Freesia asks you once, shows exactly what is shared and who can see it, and remembers your answer for your account on every device. You can change your mind at any time in Engines, under Freesia Cloud, where you can also see how much you have shared and delete all of it with one button. Other Freesia Voice servers and the other engines never show this and are not affected.

## 3.0.3

**Esc no longer throws away what you said.** Esc still stops a dictation and types nothing, but the recording is now kept in History, where you can transcribe it or delete it. The floating pill confirms it with "Cancelled · Recording kept in History". This is on by default; turn off "Keep recordings cancelled with Esc" in Settings if you want Esc to discard, as before. Takes shorter than a second and a half are not kept.

**No more lost first words on slower PCs.** Recording now starts the moment the microphone opens. Before, the start chime, the timer and the level meter were set up first, which on a laptop could take long enough to cut off the beginning of what you said. The floating pill says "Starting" until recording has really begun, and the start chime now means "recording". The microphone also stays ready for 2 minutes after a dictation, so the next one begins instantly. Windows shows the microphone as in use during that time; turn off "Keep the microphone ready" in Settings if you prefer.

## 3.0.2

**What's new is shown with each update.** When a new version is available, the update banner and Settings have a "What's new" section with that version's changes, formatted.

**Native Language understands English.** If you speak English while the Native Language style is on, Freesia now formats what you said instead of running it through the translator, which could garble it. The server notices which language you actually spoke.

**Persian in the other styles.** With the language set to Auto, Persian speech is recognised by a speech model made for Persian and stays in Persian.

## 3.0.1

Native Language translates much better on Freesia Cloud. Instead of a general chat model rewriting the transcript, the server now runs a speech model trained for your language and a dedicated translation model, and returns English directly. On a Persian test set this cut speech errors roughly in half and made the English noticeably more faithful. Servers without the translation path keep working as before.

Fixed: the voice bloom kept animating while Freesia was hidden in the tray, which used CPU for nothing.

## 3.0.0

Freesia no longer needs a paid API. Three speech engines are available and Freesia falls back between them automatically. Freesia Cloud sends audio to a Freesia Voice server you have an account on, running Qwen3-ASR 1.7B. On this PC downloads a verified llama.cpp Vulkan runtime and Qwen3-ASR weights and transcribes locally on your graphics card or CPU. Google Gemini keeps working with your own key. Your dictionary is now sent to the speech model as vocabulary hints, and a corrector fixes dictionary terms that come out split up or spelled letter by letter. You can teach it corrections from History.

The interface was rebuilt from scratch: a sidebar layout, a voice reactive bloom that replaces the waveform, a new floating pill, word by word transcript reveal, view transitions, an activity chart for the last thirty days, searchable history grouped by day, a new style editor, an Engines page, a shortcut recorder and a new onboarding flow. Everything follows the light and dark themes.

Secrets moved out of plain text. The Gemini key and the cloud token are encrypted with your Windows account and never reach the interface process, and the Gemini key is sent in a header instead of the URL.

Fixed: the Sounds switch did nothing. Command mode never read the selected text, so it could not edit anything; it now copies the selection first and waits for you to release the shortcut keys. Retrying a saved recording pasted into whatever window had focus; it now copies to the clipboard. A fixed 25 second deadline made long recordings fail; deadlines now scale with length. Gemini credit and quota errors stopped being retried against other models. Dictionary words with an apostrophe could not be removed. Images and rich text on the clipboard were lost after dictation. Every paste started a new PowerShell and compiled C#; a single helper now stays running.

## 2.4.0

The microphone display now adjusts to quiet and loud input. Both the Home waveform and shortcut overlay use the same normalized level, and the overlay stays responsive while the app is hidden in the tray.

API requests now have deadlines, unavailable models temporarily leave the retry order, and formatting reuses the model that successfully transcribed the audio. Recording writes and folder scans no longer block the main process. Retries update the original saved recording instead of creating duplicate files or deleting the original after failure. Microphone cancellation and device loss now release recording resources consistently.

The Home screen now includes an update control. Freesia checks repeatedly, detects releases published after an earlier download, and asks before installation. Confirmed updates install silently and reopen the app. Updates wait until dictation finishes.

Diagnostic reporting is enabled for new installations with a visible switch on the first setup screen and in Settings. Existing preferences are preserved.

## 2.3.0

- Confirmed Gemini 3.5 Flash-Lite as the new-install default and preferred dictation model.
- Added a microphone device selector in Settings. The choice applies to both global-shortcut dictation and the microphone test, and safely falls back to the system default if the saved device is disconnected.
- Replaced the Ctrl+Shift+Space overlay's decorative looping bars with a noise-gated waveform driven by the real microphone input level.
- Added automated coverage for the model default, microphone constraints, audio-level behavior, device selector, and non-animated shortcut overlay.

## 2.2.3

- Fixed transcription retries forcing Gemini 2.5/2.0 models that may be unavailable to the user's API key. Freesia now chooses fallback models from the models that Google reports as available for that key, with a current stable emergency list when discovery is unavailable.
- Saved recording errors now distinguish the user's selected model from a fallback model, so a fallback failure is no longer presented as though the user selected it.
- Updated the new-install default to Gemini 3.5 Flash-Lite and the preferred model order to current stable Gemini 3 models.

## 2.2.2

- Fixed dictation not pasting into AnyDesk (and other remote-desktop clients like RDP/TeamViewer, plus some games): these capture keyboard at the hardware scan-code level and ignore the virtual-key Ctrl+V the app used to send, so their remote session never received the paste and you had to press Ctrl+V yourself. Freesia now sends a hardware scan-code Ctrl+V via SendInput, which is forwarded like a real keystroke (and still works for ordinary local apps). A short delay before pasting also lets the remote client sync the clipboard first, and the old method remains as a fallback.

## 2.2.1

- Fixed transcription hard-failing when the selected Gemini model returns repeated `Internal error encountered.` (HTTP 500) — commonly a preview model. Transcription now automatically falls back through stable models (gemini-2.5-flash → gemini-2.0-flash → gemini-2.5-flash-lite) instead of retrying the same failing model, so a flaky model no longer stops you from dictating.
- Error reports and the saved-recording error now include the model, HTTP status, and audio size (e.g. `[model=…, http=500, audio=1.2MB]`) so future issues are diagnosable at a glance.

## 2.2.0

- Saved recordings now have a **Show in folder** button that opens Windows Explorer with the file selected.
- Added opt-in **Smart Tools** that shape your dictation: trim spelled-out words (say a name then spell it to help accuracy, and the letters are dropped), spoken emojis → real emoji, and polish & rephrase rough speech. Each is an independent on/off switch in Settings.
- You can now **create your own dictation styles** (name, icon, color, and AI instructions) alongside the built-ins, and edit or delete them.
- Styles can be **imported**: drop a JSON style file into the styles folder (Settings → Your Styles → Folder) or use Import. A new `AGENTS.md` documents the format so an AI agent can generate a style for you and Freesia will pick it up.
- Added **opt-in, redacted error reporting** (off by default). When enabled, only diagnostics are sent when something breaks — app version, OS, and error details — never your transcribed text or API key. This gives a central place to diagnose issues users hit.

## 2.1.0

- Fundamentally redesigned the interface around a single voice "bloom": the microphone is now a large glowing centrepiece with a radial waveform that blooms outward as you speak. Replaced the left sidebar with a centered segmented top navigation, added capsule stat pods, a lifetime ribbon, and faint botanical corner art.
- Fixed left navigation not switching sections. The rebuilt stylesheet had dropped the rule that hides inactive sections, so all views rendered stacked and the buttons appeared to do nothing. Added a test that loads the real page and asserts navigation swaps the visible section.
- Added a prominent light/dark theme toggle in the top bar; light and dark themes are both fully styled.
- Added a `npm test` suite (navigation, stats math, snippet-intent instructions, and a guard that the CSS hides inactive views) so this class of regression is caught automatically.
- New README banner: microphone, keyboard, and a soundwave blooming into freesia flowers, cropped to a wide strip and compressed (down from 1536x1024/1.7 MB to 1200x534/0.28 MB).

## 2.0.1

- Text injection failures are no longer silent: they are written to the log file, the transcript is left in the clipboard so it can be pasted manually with Ctrl+V, and a toast explains what happened.
- Added a timeout to the paste helper so a hung PowerShell can no longer stall dictation.

## 2.0.0 - Freesia

- Renamed the project from Dictaloom to Freesia across the app, package metadata, documentation, release publishing config, and GitHub repository target. Settings, dictionary, snippets, history, and saved recordings are migrated automatically from existing Dictaloom installs on first launch.
- Rebuilt the entire UI from scratch with a botanical-modern design: petal gradient accents, soft glass cards, staggered entrance animations, and refreshed light and dark themes.
- Added new brand artwork: app icon, installer imagery, and README header.
- Fixed the recording overlay sometimes not appearing on the dictation shortcut: the overlay window is recreated if it ever crashes, re-asserts screen-saver-level always-on-top on every show, follows the cursor's display, and background throttling is disabled so the tray-resident app keeps responding after long idle periods.
- Fixed a state-machine issue where a failed microphone start or a stale processing flag could silently swallow dictation shortcut presses.
- Made snippet expansion context-aware: the AI now judges whether a trigger phrase was deliberately dictated, so a casual "thank you" no longer inserts a full formal signature, and formatting can no longer invent sign-offs that fire snippets.
- Corrected the time-saved statistic (short dictations no longer round down to zero) and added lifetime stats: total words, total time saved, total sessions, average words per session, and a day streak.
- Stats now roll over at local midnight instead of UTC.

## 1.1.0 - Dictaloom

- Renamed the project from OpenVoice to Dictaloom across the app, package metadata, documentation, release publishing config, and GitHub repository target.
- Added a refreshed README with clearer download buttons and release guidance.
- Added the new README header artwork, transparent app icon, and NSIS installer artwork.
- Added light and dark themes with the default set to the user's system appearance.
- Added copy buttons for history entries.
- Kept Gemini 3.1 Flash-Lite as the default model and filtered non-dictation models from model selection.

## 1.0.1

- Set Gemini 3.1 Flash-Lite as the default model preference.
- Removed non-dictation model categories from the selectable model list, including Nano Banana, TTS, Live, and computer-use models.

## 1.0.0

- Added GitHub Releases based update checks and installer publishing.
- Added the initial Windows release workflow.
