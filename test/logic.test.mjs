import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('Gemini 3.5 Flash-Lite is the runtime default', async () => {
  const { window } = await boot();
  assert.equal(window.__freesiaTest.DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
});

test('microphone selection builds exact device constraints and supports system default', async () => {
  const { window } = await boot();
  const build = window.__freesiaTest.buildAudioConstraints;
  assert.equal(build(''), true);
  assert.equal(build('usb-mic-123').deviceId.exact, 'usb-mic-123');
});

test('settings expose a persisted microphone device list', async () => {
  const { document } = await boot();
  const select = document.getElementById('selectMicrophone');
  assert.ok(select);
  assert.equal(select.options[0].textContent, 'System default');
});

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

test('transcription uses stable models discovered for the user, not legacy forced fallbacks', async () => {
  const { window } = await boot();
  const t = window.__freesiaTest;
  const discovered = [
    { id: 'gemini-3.7-flash' },
    { id: 'gemini-3.6-flash' },
    { id: 'gemini-3.5-flash-lite' },
    { id: 'gemini-3.1-pro-preview' }
  ];
  const list = t.buildTranscribeModels('gemini-3.7-flash', discovered);
  assert.deepEqual(Array.from(list), ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.ok(!list.some(m => m.startsWith('gemini-2.')), 'does not inject inaccessible 2.x models');
  assert.ok(!list.some(m => m.includes('preview')), 'does not use preview models as fallbacks');
});

test('transcription has current stable emergency fallbacks when discovery is unavailable', async () => {
  const { window } = await boot();
  const t = window.__freesiaTest;
  const list = t.buildTranscribeModels('gemini-3.7-flash', []);
  assert.equal(list[0], 'gemini-3.7-flash');
  assert.equal(new Set(list).size, list.length, 'no duplicate models');
  assert.ok(list.length <= 4, 'retry count stays bounded');
  for (const m of t.TRANSCRIBE_FALLBACK_MODELS) assert.ok(list.includes(m));
  assert.ok(!list.some(m => m.startsWith('gemini-2.')), 'emergency list has no legacy 2.x model');
});

test('failed transcription labels fallback errors without implying the user selected them', async () => {
  const { window } = await boot();
  const summarize = window.__freesiaTest.summarizeTranscriptionFailure;
  const summary = summarize(
    new Error('Model unavailable [model=gemini-3.6-flash, http=404]'),
    'gemini-3.7-flash',
    ['gemini-3.7-flash', 'gemini-3.6-flash']
  );
  assert.match(summary, /Selected model gemini-3\.7-flash/);
  assert.match(summary, /1 fallback model failed/);
  assert.match(summary, /Last fallback error.*gemini-3\.6-flash/);
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
