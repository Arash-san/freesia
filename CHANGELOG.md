# Changelog

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
