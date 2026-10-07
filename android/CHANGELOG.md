# Changelog: Freesia for Android

Each `## <version>` section becomes the notes of the GitHub release `android-v<version>`
(see `.github/workflows/android.yml` at the repository root).

## 3.1.1

**Spelled names become words.** Freesia now joins names and words dictated letter by letter even when they are absent from your dictionary. For example, "H A M I D" becomes "Hamid". The cleanup runs after recognition and again after formatting. Common acronyms such as GPT, API and NAS retain their capitals, and dictionary entries keep their preferred spelling. Ordinary dotted initials such as "J. R. R. Tolkien" remain intact.

## 3.1.0

**Help train Freesia Voice, if you want to.** If you are signed in to InquireLab's Freesia
Voice server, you can now share your recordings so its speech model gets better at the
names, courses and terms you actually say. It stays off unless you turn it on. After this
update Freesia asks you once, shows exactly what is shared and who can see it, and
remembers your answer for your account on every device. You can change your mind at any
time in Settings, under Account, where you can also see how much you have shared and
delete all of it. Other servers never show this.

## 3.0.3

**Retry and Undo right next to the bubble**
- When a take can't be transcribed, a **Retry** button appears beside the bubble. It
  sends the saved recording again and puts the text into the same field.
- Just after text is inserted, **Undo** appears for a few seconds and takes it back out.
- While recording, the bubble shows the time, a **✕** to cancel, and a
  **Translate** switch: turn it on to get English, off to keep what you said in your
  own language.

**Better with other languages**
- Speaking English with the Native Language style no longer produces a strange
  "translation". Freesia now notices the language you actually spoke.
- In the other styles, Persian stays Persian and uses a speech model made for Persian.

**Fixes**
- Telegram (and apps like it): the word "Message" no longer appears in front of your text.
- Update notes are shown formatted instead of as raw text.

**Tablets**
- A side navigation rail on large screens, a two-column Home in landscape, and
  content kept to a comfortable reading width.

## 3.0.2

**Native Language translates much better**
- Speaking Persian (or another language) with the Native Language style now uses the
  server's dedicated translation path: a speech model trained for that language, then a
  translation model, instead of a general chat model rewriting the transcript. On a
  Persian test set this cut speech errors roughly in half and made the English
  noticeably more faithful.
- Servers that do not have the translation path yet keep working as before.

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
