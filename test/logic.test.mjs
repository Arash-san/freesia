import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('normalizeStats seeds a fresh profile', async () => {
  const { t, dom } = await boot();
  const s = t.normalizeStats(null);
  assert.equal(s.today.words, 0);
  assert.equal(s.lifetime.sessions, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.days)), {});
  assert.equal(s.today.date, t.localDateString());
  dom.window.close();
});

test('normalizeStats migrates the legacy flat shape', async () => {
  const { t, dom } = await boot();
  const today = t.localDateString();
  const s = t.normalizeStats({ wordsToday: 40, sessions: 3, timeSaved: 5, lastDate: today });
  assert.equal(s.today.words, 40);
  assert.equal(s.lifetime.words, 40);
  assert.equal(s.lifetime.savedSec, 300);
  assert.equal(s.days[today], 40);
  dom.window.close();
});

test('a streak resets when a day was skipped', async () => {
  const { t, dom } = await boot();
  const s = t.normalizeStats({ today: { date: '2000-01-01', words: 5 }, lifetime: { words: 5, sessions: 1, recordSec: 0, savedSec: 0 }, streak: { current: 9, best: 9, lastDate: '2000-01-01' } });
  assert.equal(s.streak.current, 0);
  assert.equal(s.streak.best, 9);
  assert.equal(s.today.words, 0);
  dom.window.close();
});

test('formatDuration never loses short dictations', async () => {
  const { t, dom } = await boot();
  assert.equal(t.formatDuration(22), '22s');
  assert.equal(t.formatDuration(90), '2m');
  assert.equal(t.formatDuration(3720), '1h 2m');
  dom.window.close();
});

test('snippet rules warn against over-expansion and vanish when empty', async () => {
  const { t, dom } = await boot({ snippets: [{ trigger: 'thank you', expansion: 'Best regards' }] });
  assert.match(t.buildSnippetInstructions(), /When in doubt, do not expand/);
  t.setSettings({ snippets: [] });
  assert.equal(t.buildSnippetInstructions(), '');
  dom.window.close();
});

test('fallback snippet expansion only fires on whole words', async () => {
  const { t, dom } = await boot();
  t.setSettings({ snippets: [{ trigger: 'regards', expansion: 'REGARDS' }] });
  assert.equal(t.expandSnippets('disregards this'), 'disregards this');
  assert.equal(t.expandSnippets('kind regards'), 'kind REGARDS');
  dom.window.close();
});

test('processing tools add instructions only when enabled', async () => {
  const { t, dom } = await boot();
  t.setSettings({});
  assert.equal(t.anyToolEnabled(), false);
  assert.equal(t.buildToolInstructions(), '');
  t.setSettings({ toolSpokenEmoji: true });
  assert.match(t.buildToolInstructions(), /SPOKEN EMOJI/);
  dom.window.close();
});

test('command mode gives the formatter the selected text (2.x never did)', async () => {
  const { t, dom } = await boot();
  const withSel = t.buildFormatPrompt('make it friendlier', 'command', { selection: 'Send the report now.' });
  assert.match(withSel, /Send the report now\./);
  assert.match(withSel, /make it friendlier/);
  const noSel = t.buildFormatPrompt('write a thank you note', 'command', { selection: '' });
  assert.match(noSel, /write a thank you note/);
  assert.doesNotMatch(noSel, /Selected text/);
  dom.window.close();
});

test('dictionary words reach the formatter prompt and the speech model', async () => {
  const { t, dom, calls, window } = await boot({ dictionary: ['Qwen3-ASR', "O'Brien"] });
  assert.match(t.buildFormatPrompt('hi', 'dictate-inject'), /Qwen3-ASR, O'Brien/);
  await t.processAudio(new window.Blob(['x'], { type: 'audio/webm' }), 'test', { durationSec: 2 });
  assert.equal(calls.transcribe[0].prompt, "Qwen3-ASR, O'Brien");
  dom.window.close();
});

test('formatter wrapping quotes and labels are removed', async () => {
  const { t, dom } = await boot();
  assert.equal(t.stripWrapping('"Hello there."', 'hello there'), 'Hello there.');
  assert.equal(t.stripWrapping('Formatted text: Hi.', 'hi'), 'Hi.');
  assert.equal(t.stripWrapping('"Quoted" she said.', '"quoted" she said'), '"Quoted" she said.');
  dom.window.close();
});

test('engine order: primary first, then configured fallbacks only', async () => {
  const { t, dom } = await boot();
  const state = { engine: 'gemini', cloud: { configured: true }, local: { configured: true }, gemini: { configured: false } };
  const order = (...a) => JSON.parse(JSON.stringify(t.engineOrder(...a)));
  assert.deepEqual(order(state, true), ['gemini', 'cloud', 'local']);
  assert.deepEqual(order(state, false), ['gemini']);
  assert.deepEqual(order({ ...state, engine: 'local' }, true), ['local', 'cloud']);
  dom.window.close();
});

test('formatter choice respects availability', async () => {
  const { t, dom } = await boot();
  const s = (formatter, cloud, gemini) => t.pickFormatter({ formatter, cloud: { configured: cloud }, gemini: { configured: gemini } });
  assert.equal(s('auto', true, true), 'cloud');
  assert.equal(s('auto', false, true), 'gemini');
  assert.equal(s('auto', false, false), null);
  assert.equal(s('gemini', true, false), null);
  assert.equal(s('off', true, true), null);
  dom.window.close();
});

test('custom styles merge with the built-ins', async () => {
  const { t, dom } = await boot();
  t.setSettings({ customStyles: [{ id: 'custom-x', name: 'X', prompt: 'p', custom: true }] });
  const all = t.getAllStyles();
  assert.ok(all.some((s) => s.id === 'normal'));
  assert.ok(all.some((s) => s.id === 'custom-x'));
  dom.window.close();
});

test('shortcut recorder maps physical keys to Electron accelerators', async () => {
  const { t, dom } = await boot();
  assert.equal(t.keyFromEvent({ code: 'KeyD' }), 'D');
  assert.equal(t.keyFromEvent({ code: 'Space' }), 'Space');
  assert.equal(t.keyFromEvent({ code: 'F9' }), 'F9');
  assert.equal(t.keyFromEvent({ code: 'ShiftLeft' }), null);
  dom.window.close();
});
