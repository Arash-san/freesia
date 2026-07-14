import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('normalizeStats seeds a fresh profile with zeroed today/lifetime/streak', async () => {
  const { window } = await boot();
  const s = window.__freesiaTest.normalizeStats(null);
  assert.equal(s.today.words, 0);
  assert.equal(s.lifetime.words, 0);
  assert.equal(s.streak.current, 0);
  assert.equal(s.today.date, window.__freesiaTest.localDateString());
});

test('normalizeStats migrates the legacy flat shape and seeds lifetime', async () => {
  const { window } = await boot();
  const today = window.__freesiaTest.localDateString();
  const s = window.__freesiaTest.normalizeStats({ wordsToday: 40, sessions: 3, timeSaved: 5, lastDate: today });
  assert.equal(s.lifetime.words, 40, 'lifetime words seeded from legacy counters');
  assert.equal(s.lifetime.sessions, 3);
  assert.equal(s.lifetime.savedSec, 300, '5 minutes -> 300 seconds');
  assert.equal(s.today.words, 40, 'today preserved because lastDate is today');
});

test('normalizeStats resets today but keeps lifetime when the day rolls over', async () => {
  const { window } = await boot();
  const s = window.__freesiaTest.normalizeStats({ wordsToday: 40, sessions: 3, timeSaved: 5, lastDate: '2000-01-01' });
  assert.equal(s.today.words, 0, 'stale day resets today');
  assert.equal(s.lifetime.words, 40, 'lifetime still seeded');
});

test('formatDuration is human and never loses short dictations', async () => {
  const { window } = await boot();
  const f = window.__freesiaTest.formatDuration;
  assert.equal(f(0), '0s');
  assert.equal(f(45), '45s');
  assert.equal(f(600), '10m');
  assert.equal(f(3600), '1h 0m');
  assert.equal(f(3660), '1h 1m');
});

test('buildSnippetInstructions tells the model not to over-expand casual phrases', async () => {
  const { window } = await boot();
  window.__freesiaTest.setSettings({
    snippets: [{ trigger: 'best regards', expansion: 'Best regards, Arash' }]
  });
  const text = window.__freesiaTest.buildSnippetInstructions();
  assert.match(text, /best regards/);
  assert.match(text, /do NOT expand/i);
  assert.match(text, /deliberately/i);
});

test('empty snippet list produces no instructions', async () => {
  const { window } = await boot();
  window.__freesiaTest.setSettings({ snippets: [] });
  assert.equal(window.__freesiaTest.buildSnippetInstructions(), '');
});

test('fallback expandSnippets only fires on whole-word triggers', async () => {
  const { window } = await boot();
  window.__freesiaTest.setSettings({ snippets: [{ trigger: 'regards', expansion: 'REGARDS' }] });
  const expand = window.__freesiaTest.expandSnippets;
  assert.equal(expand('kind regards to you'), 'kind REGARDS to you', 'whole word expands');
  assert.equal(expand('disregarding that'), 'disregarding that', 'substring inside a word must not expand');
});

test('processing tools only inject instructions when enabled', async () => {
  const { window } = await boot();
  const t = window.__freesiaTest;
  t.setSettings({});
  assert.equal(t.anyToolEnabled(), false);
  assert.equal(t.buildToolInstructions(), '');

  t.setSettings({ toolTrimSpelling: true });
  assert.equal(t.anyToolEnabled(), true);
  assert.match(t.buildToolInstructions(), /SPELLING CLEANUP/);
  assert.doesNotMatch(t.buildToolInstructions(), /SPOKEN EMOJI/);

  t.setSettings({ toolSpokenEmoji: true, toolPolish: true });
  const both = t.buildToolInstructions();
  assert.match(both, /SPOKEN EMOJI/);
  assert.match(both, /POLISH & REPHRASE/);
});

test('transcription falls back from a flaky model to stable ones', async () => {
  const { window } = await boot();
  const t = window.__freesiaTest;
  // A preview model (the crash Sara hit) must be tried first, then fall back
  const list = t.buildTranscribeModels('gemini-3.1-flash-lite-preview');
  assert.equal(list[0], 'gemini-3.1-flash-lite-preview', 'user model tried first');
  assert.ok(list.length > 1, 'has fallbacks so a broken model cannot hard-fail');
  for (const m of t.TRANSCRIBE_FALLBACK_MODELS) assert.ok(list.includes(m));

  // If the user already picked a stable model, it is not duplicated
  const list2 = t.buildTranscribeModels('gemini-2.5-flash');
  assert.equal(new Set(list2).size, list2.length, 'no duplicate models');
  assert.equal(list2[0], 'gemini-2.5-flash');
});

test('custom styles merge with the built-ins', async () => {
  const { window } = await boot();
  const t = window.__freesiaTest;
  const builtinCount = t.getAllStyles().length;
  t.setSettings({ customStyles: [{ id: 'custom-x', name: 'My Style', icon: '🌸', color: '#8B5CF6', prompt: 'do the thing', custom: true }] });
  const all = t.getAllStyles();
  assert.equal(all.length, builtinCount + 1);
  assert.ok(all.find(s => s.id === 'custom-x'));
});
