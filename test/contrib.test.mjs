// Voice contributions: off by default, asked once after the update, only on
// servers that support it, and turned on only through the terms dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { boot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createCloudEngine } = require('../src/main/engines.js');

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const terms = { version: 1, title: 'Help Freesia Voice understand you better', summary: 'It stays off unless you turn it on.', paragraphs: ['First.', 'Second.'] };
const state = (o = {}) => ({ available: true, version: 1, enabled: false, decided: false, terms, shared: { recordings: 0, seconds: 0, labeled: 0 }, ...o });

function fakeServer(initial) {
  const calls = { get: 0, set: [], del: 0 };
  let st = initial;
  return {
    calls,
    api: {
      cloudContribution: async () => { calls.get++; return st; },
      cloudSetContribution: async (enabled, version) => { calls.set.push([enabled, version]); st = { ...st, enabled, decided: true }; return st; },
      cloudDeleteContributions: async () => { calls.del++; st = { ...st, shared: { recordings: 0, seconds: 0, labeled: 0 } }; return { ...st, deleted: 3 }; }
    }
  };
}

async function liveDialog(document, ms = 3000) {
  const live = () => document.querySelector('.dialog-backdrop:not(.closing) .dialog');
  for (let i = 0; i < ms / 20 && !live(); i++) await settle(20);
  return live();
}
async function clickDialog(document, label) {
  const box = await liveDialog(document);
  assert.ok(box, 'no dialog open');
  const btn = [...box.querySelectorAll('.btn')].find((b) => b.textContent === label);
  assert.ok(btn, `dialog button "${label}" missing`);
  btn.click();
  await settle(60);
}

test('cloud engine: contribution calls, and servers without the feature report it unavailable', async () => {
  const seen = [];
  const store = { data: { cloud: { server: 'https://voice.example', username: 'a' } }, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
  const secrets = { get: () => 'fv_tok', set() {} };
  const routes = { 'GET /api/contribute': json(200, state()), 'POST /api/contribute': json(200, state({ enabled: true })), 'DELETE /api/contribute/recordings': json(200, state({ deleted: 2 })) };
  const cloud = createCloudEngine({ store, secrets, fetchImpl: async (url, opts) => { seen.push([opts.method, url, opts.body]); return routes[`${opts.method} ${new URL(url).pathname}`]; } });
  assert.equal((await cloud.contribution()).available, true);
  await cloud.setContribution(true, 1);
  assert.deepEqual(JSON.parse(seen[1][2]), { enabled: true, version: 1, client: 'desktop' });
  assert.equal((await cloud.deleteContributions()).deleted, 2);
  const old = createCloudEngine({ store, secrets, fetchImpl: async () => json(404, { detail: 'Not Found' }) });
  assert.deepEqual(await old.contribution(), { available: false });
});

test('after the update, a signed-in user is asked once, and "No thanks" is sent to the server', async () => {
  const server = fakeServer(state());
  const { document, window, dom } = await boot({}, server.api);
  const box = await liveDialog(document);
  assert.ok(box, 'the contribution question was not shown');
  assert.match(box.textContent, /Help Freesia Voice understand you better/);
  assert.equal(box.querySelectorAll('.contrib-terms p').length, 2, 'the full terms are in the dialog');
  await clickDialog(document, 'No thanks');
  assert.deepEqual(server.calls.set, [[false, 1]]);
  await window.checkContribution();
  await settle(60);
  assert.equal(await liveDialog(document, 200), null, 'not asked again after answering');
  dom.window.close();
});

test('closing the question without answering changes nothing', async () => {
  const server = fakeServer(state());
  const { document, window, dom } = await boot({}, server.api);
  assert.ok(await liveDialog(document));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await settle(300);
  assert.deepEqual(server.calls.set, []);
  dom.window.close();
});

test('no question for people who already answered, or on servers without the feature, or when signed out', async () => {
  for (const [st, overrides] of [[state({ decided: true }), {}], [{ available: false }, {}]]) {
    const server = fakeServer(st);
    const { document, dom } = await boot(overrides, server.api);
    assert.equal(await liveDialog(document, 2600), null);
    dom.window.close();
  }
  const server = fakeServer(state());
  const { document, window, dom } = await boot({}, { ...server.api, engineStatus: async () => ({ engine: 'cloud', formatter: 'auto', cloud: { configured: false }, local: { models: {} }, gemini: {} }) });
  assert.equal(await liveDialog(document, 2600), null);
  assert.equal(server.calls.get, 0, 'nothing is asked of a server the user is not signed in to');
  dom.window.close();
});

test('the switch in Engines turns sharing on only through the terms, and off directly', async () => {
  const server = fakeServer(state({ decided: true }));
  const { document, window, dom } = await boot({}, server.api);
  window.showView('engines');
  await settle(150);
  window.renderCloudBody();
  await settle(150);
  const block = document.querySelector('#contribBlock .contrib-block');
  assert.ok(block, 'contribution block missing from the Freesia Cloud card');
  const sw = block.querySelector('input[type=checkbox]');
  assert.equal(sw.checked, false);
  sw.checked = true;
  sw.dispatchEvent(new window.Event('change'));
  await settle(60);
  assert.equal(sw.checked, false, 'stays off while the terms are open');
  await clickDialog(document, 'Share my recordings');
  assert.deepEqual(server.calls.set, [[true, 1]]);
  const on = document.querySelector('#contribBlock .contrib-block');
  assert.ok(on.classList.contains('on'));
  const sw2 = on.querySelector('input[type=checkbox]');
  assert.equal(sw2.checked, true);
  sw2.checked = false;
  sw2.dispatchEvent(new window.Event('change'));
  await settle(80);
  assert.deepEqual(server.calls.set[1], [false, 1]);
  dom.window.close();
});

test('turning off offers to delete what was shared', async () => {
  const server = fakeServer(state({ decided: true, enabled: true, shared: { recordings: 3, seconds: 40, labeled: 1 } }));
  const { document, window, dom } = await boot({}, server.api);
  window.renderCloudBody();
  await settle(150);
  const sw = document.querySelector('#contribBlock input[type=checkbox]');
  sw.checked = false;
  sw.dispatchEvent(new window.Event('change'));
  await clickDialog(document, 'Delete them');
  await settle(60);
  assert.equal(server.calls.del, 1);
  dom.window.close();
});
