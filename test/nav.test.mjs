import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, readRenderer } from './helpers.mjs';

test('every nav item has a matching view', async () => {
  const { document, dom } = await boot();
  const items = [...document.querySelectorAll('.nav-item[data-view]')];
  assert.equal(items.length, 6);
  for (const item of items) {
    const view = document.querySelector(`.view[data-view="${item.dataset.view}"]`);
    assert.ok(view, `missing view for ${item.dataset.view}`);
  }
  dom.window.close();
});

test('clicking a nav item shows exactly one view and highlights the item', async () => {
  const { window, document, dom } = await boot();
  for (const name of ['history', 'engines', 'settings', 'home']) {
    document.querySelector(`.nav-item[data-view="${name}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
    const active = [...document.querySelectorAll('.view.active')];
    assert.equal(active.length, 1);
    assert.equal(active[0].dataset.view, name);
    assert.ok(document.querySelector(`.nav-item[data-view="${name}"]`).classList.contains('active'));
  }
  dom.window.close();
});

test('CSS hides inactive views and screens (guards the 2.1.0 regression)', () => {
  const css = readRenderer('styles/app.css');
  assert.match(css, /\.view\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.view\.active\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.screen\s*\{[^}]*display:\s*none/);
});

test('overlay pill follows the real microphone level, not a looping animation', () => {
  const overlay = readRenderer('overlay.html');
  assert.match(overlay, /onOverlayAudioLevel/);
  assert.doesNotMatch(overlay, /@keyframes\s+waveBar/);
});

test('onboarding shows for new users and main screen for onboarded users', async () => {
  const fresh = await boot({ onboarded: false });
  assert.ok(fresh.document.getElementById('screenOnboarding').classList.contains('active'));
  fresh.dom.window.close();
  const done = await boot({ onboarded: true });
  assert.ok(done.document.getElementById('screenMain').classList.contains('active'));
  done.dom.window.close();
});

test('the renderer never uses inline event handlers (CSP forbids them)', () => {
  const html = readRenderer('index.html');
  assert.doesNotMatch(html, /\son[a-z]+="/i);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(readRenderer('app.js'), /onclick="/);
});
