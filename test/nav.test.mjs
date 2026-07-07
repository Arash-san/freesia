import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, readRenderer } from './helpers.mjs';

// This is the exact regression from 2.1.0: nav buttons appeared dead because
// inactive sections were never hidden. These tests load the real page.

test('every top-nav item has a matching view section', async () => {
  const { document } = await boot();
  const items = [...document.querySelectorAll('.topnav-item[data-page]')];
  assert.ok(items.length >= 4, 'expected at least 4 nav items');
  for (const item of items) {
    const view = document.getElementById(item.dataset.page + 'Page');
    assert.ok(view, `missing view for nav item "${item.dataset.page}"`);
  }
});

test('clicking a nav item activates its view and deactivates the others', async () => {
  const { window, document } = await boot();

  document.getElementById('navDictionary').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(document.getElementById('dictionaryPage').classList.contains('active'), 'dictionary view should be active');
  assert.ok(!document.getElementById('dashboardPage').classList.contains('active'), 'dashboard view should be inactive');

  document.getElementById('navHistory').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(document.getElementById('historyPage').classList.contains('active'), 'history view should be active');
  assert.ok(!document.getElementById('dictionaryPage').classList.contains('active'), 'dictionary view should be inactive');

  // Exactly one view is active at any time
  const active = [...document.querySelectorAll('.view.active')];
  assert.equal(active.length, 1, 'exactly one view must be active');
});

test('the nav item gets the active class so it is visually highlighted', async () => {
  const { window, document } = await boot();
  document.getElementById('navSnippets').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(document.getElementById('navSnippets').classList.contains('active'));
  assert.ok(!document.getElementById('navDashboard').classList.contains('active'));
});

test('CSS actually hides inactive views (guards the 2.1.0 regression)', () => {
  const css = readRenderer('styles/main.css');
  // A rule must hide .view by default and reveal .view.active — without this,
  // all sections stack and navigation looks broken even though JS works.
  assert.match(css, /\.view\s*\{[^}]*display:\s*none/, '.view must default to display:none');
  assert.match(css, /\.view\.active\s*\{[^}]*display:\s*block/, '.view.active must display:block');
});
