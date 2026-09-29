import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const md = require('../src/renderer/js/markdown.js');
const { createReleaseNotes } = require('../src/main/release-notes.js');

const NOTES = `## 3.0.2

**Native Language translates much better**
- Speaking Persian now uses a \`dedicated\` model,
  then a translation model.
- See [the README](https://example.com).

Plain paragraph with *emphasis*.`;

test('release notes parse into headings, lists and inline styles', () => {
  const b = md.parse(NOTES);
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'p']);
  assert.equal(b[2].items.length, 2);
  assert.deepEqual(b[2].items[0].map((n) => n.t), ['text', 'code', 'text', 'text', 'text']);
  assert.equal(b[2].items[1][1].t, 'link');
});

test('release notes render as DOM text, never as HTML', () => {
  const { window } = new JSDOM('<!doctype html><div id="x"></div>');
  const el = window.document.getElementById('x');
  el.appendChild(md.render(NOTES + '\n\n<img src=x onerror=alert(1)> <script>bad()</script>', window.document));
  assert.equal(el.querySelector('h4').textContent, '3.0.2');
  assert.equal(el.querySelector('strong').textContent, 'Native Language translates much better');
  assert.equal(el.querySelectorAll('li').length, 2);
  assert.equal(el.querySelector('img'), null);
  assert.equal(el.querySelector('script'), null);
  assert.match(el.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('update notes are fetched once per version from the GitHub release', async () => {
  const calls = [];
  const notes = createReleaseNotes({ fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ body: ' ## Hi \n' }) }; } });
  assert.equal(await notes('3.0.2'), '## Hi');
  assert.equal(await notes('v3.0.2'), '## Hi');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /releases\/tags\/v3\.0\.2$/);
  const failing = createReleaseNotes({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await failing('3.0.2'), '');
});
