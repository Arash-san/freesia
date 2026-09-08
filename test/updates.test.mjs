import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdateController } from '../src/main/update-controller.js';

function fixture() {
  const updater = new EventEmitter();
  let latest = '2.4.0', checks = 0, downloads = 0, installs = [], before = 0, busy = false;
  updater.checkForUpdates = async () => { checks++; updater.emit('update-available', { version: latest }); };
  updater.downloadUpdate = async () => { downloads++; updater.emit('update-downloaded', { version: latest }); };
  updater.quitAndInstall = (...args) => installs.push(args);
  const scheduled = [];
  const controller = createUpdateController({ updater, publish() {}, packaged: true,
    beforeInstall: () => before++, canInstall: () => !busy,
    timers: { setTimeout(fn, ms) { scheduled.push({ fn, ms }); }, setInterval(fn, ms) { scheduled.push({ fn, ms }); }, clearTimeout() {}, clearInterval() {} }
  });
  return { updater, controller, scheduled, latest: v => latest = v, busy: b => busy = b,
    stats: () => ({ checks, downloads, installs, before }) };
}

test('download stays ready after checking the same release; install is silent and relaunches', async () => {
  const f = fixture();
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  await f.controller.check(true);
  await f.controller.download();
  assert.equal(f.controller.getState().status, 'downloaded');
  assert.equal(f.stats().checks, 2, 'rechecks after download');
  await f.controller.check(true);
  assert.equal(f.controller.getState().status, 'downloaded');
  assert.deepEqual(f.stats().installs, []);
  await f.controller.install();
  assert.deepEqual(f.stats().installs, [[true, true]]);
  assert.equal(f.stats().before, 1);
});

test('a newer release replaces the old downloaded offer and requires another download', async () => {
  const f = fixture();
  await f.controller.check(true); await f.controller.download();
  f.latest('2.5.0');
  await f.controller.install();
  assert.equal(f.controller.getState().status, 'available');
  assert.equal(f.controller.getState().updateInfo.version, '2.5.0');
  assert.equal(f.stats().installs.length, 0);
  await f.controller.download();
  assert.equal(f.controller.getState().status, 'downloaded');
});

test('concurrent checks are deduplicated; checks cannot overlap a download', async () => {
  const f = fixture();
  let release;
  f.updater.checkForUpdates = () => new Promise(resolve => { release = resolve; });
  const first = f.controller.check(true);
  const waiting = f.controller.check(true);
  await waiting;
  assert.equal(f.controller.getState().status, 'checking');
  release(); await first;
  f.updater.emit('update-available', { version: '2.4.0' });
  f.updater.downloadUpdate = () => new Promise(resolve => { release = resolve; });
  const download = f.controller.download();
  await f.controller.check(true);
  assert.equal(f.controller.getState().status, 'downloading');
  release(); await download;
});

test('offline checks preserve the downloaded installer and active dictation blocks install', async () => {
  const f = fixture();
  await f.controller.check(true); await f.controller.download();
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  await f.controller.check(true);
  assert.equal(f.controller.getState().status, 'downloaded');
  f.busy(true); await f.controller.install();
  assert.equal(f.stats().installs.length, 0);
  f.busy(false); await f.controller.install();
  assert.equal(f.stats().installs.length, 1);
});

test('startup and recurring update checks are scheduled', () => {
  const f = fixture(); f.controller.start();
  assert.deepEqual(f.scheduled.map(x => x.ms), [10000, 300000]);
});
