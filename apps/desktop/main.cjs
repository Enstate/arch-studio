const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
app.setName('Arch Studio');
let server;
let quitting = false;
function stopServer() {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  server = undefined;
}
function serverEnvironment(resources) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.env.ARCH_HOME && !path.isAbsolute(process.env.ARCH_HOME)) throw new Error('ARCH_HOME must be absolute');
  return { ...env, ...(process.env.ARCH_HOME ? { ARCH_HOME: process.env.ARCH_HOME } : {}), ARCH_VIEWER_ROOT: path.join(resources, 'viewer'), ARCH_BUN: path.join(resources, 'bun'), ARCH_CLIENT_ROOT: path.join(resources, 'client'), ARCH_STUDIO_PORT: '0', ARCH_STUDIO_PARENT_PIPE: '1' };
}
function validBootstrapUrl(value) { return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/#studio=[a-f0-9]{64}$/.test(value); }
function startServer() {
  const resources = process.resourcesPath;
  server = spawn(path.join(resources, 'arch-server'), [], { env: serverEnvironment(resources), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  return new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => reject(new Error('Studio server startup timed out')), 30000);
    const fail = error => { clearTimeout(timer); reject(error); };
    server.once('error', fail);
    server.once('exit', code => { if (!quitting) { fail(new Error(`Studio server exited (${code})`)); app.quit(); } });
    server.stderr.on('data', data => process.stderr.write(data));
    server.stdout.on('data', data => {
      pending += data.toString();
      if (pending.length > 65536) return fail(new Error('Invalid server readiness output'));
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n');
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.archStudioReady && validBootstrapUrl(message.bootstrapUrl)) { clearTimeout(timer); resolve(message.bootstrapUrl); }
        } catch {}
      }
    });
  });
}
app.on('before-quit', () => { quitting = true; stopServer(); });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const dev = !app.isPackaged && process.env.ARCH_STUDIO_DEV_URL;
  const bootstrapUrl = dev || await startServer();
  if (!validBootstrapUrl(bootstrapUrl)) throw new Error('Invalid local Studio bootstrap URL');
  const origin = new URL(bootstrapUrl).origin;
  const window = new BrowserWindow({ width: 1440, height: 960, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') } });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({url}) => {
    try {
      const target = new URL(url);
      if (target.origin === origin && /^\/api\/(references|artifacts)\//.test(target.pathname)) window.webContents.downloadURL(target.href);
    } catch {}
    return { action: 'deny' };
  });
  ipcMain.on('open-external-link', (event, url) => {
    if (event.sender !== window.webContents || !event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return;
    try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {}
  });
  window.webContents.on('will-frame-navigate', event => { if (new URL(event.url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol === 'https:') { event.preventDefault(); }
  });
  await window.loadURL(bootstrapUrl);
}).catch(error => { console.error(error.message); stopServer(); app.quit(); });
