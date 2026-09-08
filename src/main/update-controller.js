// Keep a downloaded installer usable while checking for a newer release.
// Dependency injection lets the full lifecycle run in tests without installing.
function createUpdateController({ updater, publish, packaged, beforeInstall, installFailed = () => {}, canInstall = () => true,
  now = Date.now, timers = globalThis }) {
  let state = { status: 'idle', message: 'Check for updates.' };
  let downloaded = null;
  let operation = null;
  let lastCheck = 0;
  let interval, startup;
  const emit = (status, extra = {}) => {
    state = { ...state, ...extra, status };
    publish(status, state);
    return state;
  };
  const infoOnly = info => ({ version: info.version, releaseDate: info.releaseDate });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false; // Installation requires the user's confirmation.
  updater.on('update-available', info => {
    const ready = downloaded?.version === info.version;
    if (!ready) downloaded = null;
    emit(ready ? 'downloaded' : 'available', {
      updateInfo: infoOnly(info), progress: ready ? { percent: 100 } : null,
      message: ready ? `Version ${info.version} is ready. Restart to install.` : `Version ${info.version} is available.`
    });
  });
  updater.on('update-not-available', () => {
    downloaded = null;
    emit('current', { updateInfo: null, progress: null, message: 'Freesia is up to date.' });
  });
  updater.on('download-progress', progress => emit('downloading', {
    progress: { percent: Math.round(progress.percent || 0) },
    message: `Downloading update (${Math.round(progress.percent || 0)}%).`
  }));
  updater.on('update-downloaded', info => {
    downloaded = infoOnly(info);
    emit('downloaded', { updateInfo: downloaded, progress: { percent: 100 },
      message: `Version ${info.version} is ready. Restart to install.` });
  });
  const failed = error => {
    const installing = state.status === 'installing';
    if (installing) installFailed();
    return emit(downloaded ? 'downloaded' : 'error', {
      message: installing ? `Installation failed: ${String(error?.message || error)}`
        : downloaded ? `Version ${downloaded.version} is ready. Latest check failed; try again when online.` : String(error?.message || error),
      updateInfo: downloaded || state.updateInfo, progress: downloaded ? { percent: 100 } : null
    });
  };
  updater.on('error', failed);
  async function check(force = false) {
    if (!packaged) return emit('disabled', { message: 'Updates are enabled in installed builds.' });
    if (operation || state.status === 'installing') return state;
    if (!force && lastCheck && now() - lastCheck < 60000) return state;
    operation = 'check';
    lastCheck = now();
    const previous = state;
    emit('checking', { message: 'Checking for updates.' });
    try {
      await updater.checkForUpdates();
      if (state.status === 'checking') emit(previous.status, previous);
    } catch (error) { failed(error); }
    finally { operation = null; }
    return state;
  }
  async function download() {
    if (!packaged || operation || state.status !== 'available') return state;
    operation = 'download';
    emit('downloading', { message: 'Downloading update.', progress: { percent: 0 } });
    try { await updater.downloadUpdate(); }
    catch (error) { failed(error); }
    finally { operation = null; }
    // Immediately discover releases published during the download.
    if (state.status === 'downloaded') await check(true);
    return state;
  }
  async function install() {
    if (operation || state.status !== 'downloaded' || !downloaded) return state;
    if (!canInstall()) return emit('downloaded', { message: 'Finish dictation before restarting to update.' });
    const confirmedVersion = downloaded.version;
    await check(true);
    if (state.status !== 'downloaded' || downloaded?.version !== confirmedVersion) return state;
    if (!canInstall()) return emit('downloaded', { message: 'Finish dictation before restarting to update.' });
    emit('installing', { message: 'Installing update. Freesia will reopen shortly.' });
    beforeInstall();
    try { updater.quitAndInstall(true, true); } // v6 API: silent, then relaunch.
    catch (error) { failed(error); }
    return state;
  }
  function start() {
    if (!packaged) return emit('disabled', { message: 'Updates are enabled in installed builds.' });
    startup = timers.setTimeout(() => check(), 10000);
    interval = timers.setInterval(() => check(), 5 * 60 * 1000);
    startup?.unref?.(); interval?.unref?.();
  }
  function stop() { timers.clearTimeout(startup); timers.clearInterval(interval); }
  return { check, download, install, start, stop, getState: () => state };
}
module.exports = { createUpdateController };
