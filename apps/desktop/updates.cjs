const { existsSync } = require('node:fs');
const { readFile, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');

// Only main chooses the feed. The renderer can request these fixed operations.
function createDesktopUpdates({ app, updater, publish, beforeInstall, recoverInstall, timers = globalThis, resourcesPath = process.resourcesPath }) {
  let state = { currentVersion: app.getVersion(), status: 'idle' };
  let busy = false;
  let downloaded;
  let available;
  let timeout;
  let interval;
  let installTimeout;
  let disposed = false;
  let serverStopped = false;
  let recovering = false;
  const marker = path.join(app.getPath('userData'), 'update-install.json');
  const subscriptions = [];
  const emit = patch => {
    if (disposed) return;
    state = { currentVersion: app.getVersion(), ...patch };
    publish(state);
  };
  const on = (event, listener) => { updater.on(event, listener); subscriptions.push([event, listener]); };
  const message = error => error instanceof Error ? error.message : String(error);
  const failed = (operation, error) => emit({ status: downloaded ? 'downloaded' : available && operation === 'download' ? 'available' : 'error', version: downloaded ?? available, operation, message: message(error) });
  const enabled = app.isPackaged && !!resourcesPath && existsSync(path.join(resourcesPath, 'app-update.yml'));
  if (!enabled) emit({ status: 'disabled', message: 'Updates require an installed release build.' });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.channel = 'latest';
  // A Rosetta installation must download the complete native payload.
  updater.disableDifferentialDownload = process.platform === 'darwin';
  on('update-available', info => {
    available = info.version;
    emit({ status: downloaded ? 'downloaded' : 'available', version: downloaded ?? available });
  });
  on('update-not-available', () => { available = undefined; emit({ status: downloaded ? 'downloaded' : 'up-to-date', version: downloaded }); });
  on('download-progress', progress => emit({ status: 'downloading', version: available, percent: Math.max(0, Math.min(100, Math.floor(progress.percent / 10) * 10)) }));
  on('update-downloaded', info => { downloaded = info.version; emit({ status: 'downloaded', version: downloaded, percent: 100 }); });
  // electron-updater emits errors as well as rejecting operations. Always listen.
  on('error', error => {
    if (state.status === 'installing') void restoreInstall(error);
    else if (!busy) failed('check', error);
  });
  async function restoreInstall(error) {
    if (recovering) return;
    recovering = true;
    timers.clearTimeout(installTimeout);
    if (serverStopped) {
      try { await recoverInstall(); }
      catch { app.relaunch(); app.quit(); return; }
    }
    serverStopped = false;
    await rm(marker, { force: true }).catch(() => {});
    failed('install', error);
    busy = false;
    recovering = false;
  }
  async function check(reason = 'manual') {
    if (!enabled || busy || downloaded || (reason === 'background' && available)) return state;
    const previous = state;
    busy = true;
    emit({ status: 'checking' });
    try { await updater.checkForUpdates(); }
    catch (error) { if (reason === 'background') emit(previous); else failed('check', error); }
    finally { busy = false; }
    return state;
  }
  async function download() {
    if (!enabled || busy || !available || downloaded) return state;
    busy = true;
    emit({ status: 'downloading', version: available, percent: 0 });
    try { await updater.downloadUpdate(); } catch (error) { failed('download', error); }
    finally { busy = false; }
    return state;
  }
  async function install() {
    if (!enabled || busy || !downloaded || state.status !== 'downloaded') return state;
    busy = true;
    emit({ status: 'installing', version: downloaded });
    try {
      await writeFile(marker, JSON.stringify({ fromVersion: app.getVersion(), targetVersion: downloaded }), { mode: 0o600 });
      await beforeInstall();
      serverStopped = true;
      // Squirrel has no cancellation API. Relaunch this process if it stalls,
      // instead of leaving a late native installer callback in a recovered app.
      installTimeout = timers.setTimeout(() => { app.relaunch(); app.quit(); }, 60_000);
      installTimeout.unref?.();
      updater.quitAndInstall(true, true);
    } catch (error) {
      await restoreInstall(error);
    }
    return state;
  }
  async function start() {
    if (!enabled) return;
    try {
      const pending = JSON.parse(await readFile(marker, 'utf8'));
      if (pending.fromVersion === app.getVersion()) emit({ status: 'error', operation: 'check', message: 'The update did not finish. Check for updates and try again.' });
      await rm(marker, { force: true });
    } catch (error) { if (error.code !== 'ENOENT') emit({ status: 'error', operation: 'check', message: 'The previous update status could not be read. Check for updates again.' }); }
    if (disposed) return;
    timeout = timers.setTimeout(() => { void check('background'); }, 15_000);
    interval = timers.setInterval(() => { void check('background'); }, 4 * 60_000);
    timeout.unref?.(); interval.unref?.();
  }
  function dispose() {
    disposed = true;
    timers.clearTimeout(timeout); timers.clearInterval(interval); timers.clearTimeout(installTimeout);
    for (const [event, listener] of subscriptions) updater.removeListener(event, listener);
  }
  return { getState: () => state, check, download, install, start, dispose };
}
module.exports = { createDesktopUpdates };
