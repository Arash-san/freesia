# AGENTS.md — Creating Freesia dictation styles

This guide is for **AI coding agents** (Claude Code, Codex, Copilot CLI, Cursor, etc.)
that a Freesia user asks to "make me a dictation style." Follow it to produce a
style file that Freesia imports automatically. No build step, no code changes.

**Freesia** is a Windows voice‑dictation app. A *style* is a named instruction set
that tells Gemini how to format the user's speech (tone, punctuation, length, what
to keep or drop). Users pick the active style on the Home screen.

## What you produce

A single JSON file describing one or more styles. Write it into the user's Freesia
**styles folder**, and Freesia imports it on the next launch. The user can also
import it from the app (Settings → Your Styles → Import).

### Styles folder (Windows)

```
%APPDATA%\freesia\styles\
```

which resolves to:

```
C:\Users\<username>\AppData\Roaming\freesia\styles\
```

Create the folder if it does not exist, then write a `*.json` file into it
(any filename, e.g. `slack-replies.freesia.json`).

> The exact path is also shown in the app at **Settings → Your Styles → Folder**.
> If you cannot resolve `%APPDATA%`, ask the user to click that **Folder** button
> and paste the path.

## File format

A style file is JSON. It may be **one** of:

1. a single style object, or
2. an array of style objects, or
3. `{ "styles": [ ... ] }`.

### Style object fields

| Field         | Required | Notes |
|---------------|----------|-------|
| `name`        | ✅ yes   | ≤ 40 chars. Shown on the style chip. |
| `prompt`      | ✅ yes   | The instructions sent to Gemini. Be specific and imperative. ≤ 4000 chars. |
| `icon`        | no       | A single emoji. Defaults to `✨`. |
| `color`       | no       | Hex accent, e.g. `#8B5CF6`. Defaults to violet. |
| `description` | no       | ≤ 120 chars. One line about when to use it. |
| `id`          | no       | Stable id for updates. Defaults to a slug of `name`. Reuse the same `id` to overwrite a style on re-import. |

Unknown fields are ignored. `name` and `prompt` are the only ones that matter.

### Example — single style

```json
{
  "name": "Slack replies",
  "icon": "💬",
  "color": "#611f69",
  "description": "Short, friendly team-chat messages",
  "prompt": "Format this dictation as a concise Slack message. Friendly, lowercase-leaning, minimal punctuation, contractions welcome. Keep it to 1–3 short sentences. Remove filler words. Do not add greetings or sign-offs unless dictated."
}
```

### Example — multiple styles in one file

```json
{
  "styles": [
    {
      "name": "Bug report",
      "icon": "🐛",
      "prompt": "Format this dictation as a structured bug report with sections: Summary, Steps to reproduce (numbered), Expected, Actual. Keep the user's technical terms exactly."
    },
    {
      "name": "Poetic",
      "icon": "🌷",
      "color": "#EC4899",
      "prompt": "Rewrite this dictation as short free-verse poetry, preserving the speaker's imagery and meaning. Keep it under 8 lines."
    }
  ]
}
```

## Writing a good `prompt`

- Address the model directly and imperatively ("Format this dictation as…").
- Say what to **keep** (meaning, technical terms, the speaker's voice) and what to
  **drop** (filler words, false starts).
- Specify tone, capitalization, punctuation, and length.
- End by implying the model should return **only** the formatted text (Freesia
  already appends "Return ONLY the formatted text" and rules against inventing
  content, so you don't need to repeat those).
- Do **not** put secrets, personal data, or API keys in the file.

## Verifying

1. Write the `.json` file into `%APPDATA%\freesia\styles\`.
2. Tell the user to restart Freesia (or, if already open, Settings → Your Styles →
   **Import** and pick the file for an immediate load).
3. The new style appears as a chip on the Home screen and in the style grid. The
   user can edit or delete it in-app; edits are stored in the app's settings.

## Notes for agents

- Re-importing a file with the same `id` (or same `name`-derived slug) **updates**
  that style rather than duplicating it.
- Freesia sanitizes on import: overly long fields are truncated, invalid colors
  fall back to the default, and files missing `name`/`prompt` are skipped.
- This is a local, offline mechanism — there is no network API to call. The
  contract is just this JSON file in the styles folder.
