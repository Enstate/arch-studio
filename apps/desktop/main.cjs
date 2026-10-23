const { app, BrowserWindow, session, shell, ipcMain, Menu, dialog, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopUpdates } = require('./updates.cjs');
const { menuLabels, menuLocale } = require('./menu-labels.cjs');
const { createAgentSetup } = require('./agent-setup.cjs');
app.setName('Arch Studio');
let server;
let quitting = false;
let updates;
let agentSetup;
const windows = process.platform === 'win32';
const executable = name => windows ? `${name}.exe` : name;
function stopServer() {
  if (!server) return;
  // Windows has no process groups; taskkill /T stops the server and the builds it started.
  if (windows) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  server = undefined;
}
// The user's own agent CLI configuration and network settings. API keys stay out: agents use local logins.
const agentKeys = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const mergePaths = (separator, ...lists) => [...new Set(lists.flatMap(list => (list ?? '').split(separator)).filter(Boolean))].join(separator);
// Apps opened from Finder or the Dock get launchd's minimal PATH, so `claude` and `codex` from
// ~/.local/bin, Homebrew or nvm are missing. Read PATH and the agent settings from the login shell.
async function loginShellEnvironment() {
  const keys = ['PATH', ...agentKeys];
  // printenv and `;` work in POSIX shells, fish and nushell alike.
  const script = keys.map(key => `echo __ARCH_${key}__; printenv ${key}; echo __ARCH_${key}__`).join('; ');
  const shells = [...new Set([process.env.SHELL, os.userInfo().shell, process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'])].filter(value => value && path.isAbsolute(value));
  for (const shell of shells) {
    try {
      const { stdout } = await execFile(shell, ['-ilc', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, env: process.env });
      const values = Object.fromEntries(keys.flatMap(key => {
        const value = stdout.match(new RegExp(`__ARCH_${key}__\\r?\\n([\\s\\S]*?)\\r?\\n?__ARCH_${key}__`))?.[1]?.trim();
        return value ? [[key, value]] : [];
      }));
      if (values.PATH) return values;
    } catch {}
  }
  return {};
}
// Per-user installers that a stale Explorer PATH can miss.
function windowsCliDirectories() {
  const { APPDATA, LOCALAPPDATA, USERPROFILE } = process.env;
  return [
    APPDATA && path.join(APPDATA, 'npm'),
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'pnpm'),
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Volta', 'bin'),
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    USERPROFILE && path.join(USERPROFILE, '.local', 'bin'),
    USERPROFILE && path.join(USERPROFILE, '.bun', 'bin'),
    USERPROFILE && path.join(USERPROFILE, 'scoop', 'shims'),
  ].filter(directory => directory && existsSync(directory)).join(';');
}
// Claude Code's native installer puts `claude` here. It stays on PATH even before it exists,
// so an install from Settings is found by the running server without a restart.
const claudeInstallDirectory = () => path.join(os.homedir(), '.local', 'bin');
// PATH and agent settings shared by the server, the Claude Code installer and its sign-in.
async function userEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'windir', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'ComSpec', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', ...agentKeys]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (windows) env.PATH = mergePaths(';', env.PATH, windowsCliDirectories(), claudeInstallDirectory());
  else {
    const shell = await loginShellEnvironment();
    for (const key of agentKeys) if (!env[key] && shell[key]) env[key] = shell[key];
    env.PATH = mergePaths(':', shell.PATH, env.PATH, claudeInstallDirectory());
  }
  return env;
}
let userEnvironmentReady;
const sharedUserEnvironment = () => userEnvironmentReady ??= userEnvironment();
async function serverEnvironment(resources) {
  const env = await sharedUserEnvironment();
  if (process.env.ARCH_HOME && !path.isAbsolute(process.env.ARCH_HOME)) throw new Error('ARCH_HOME must be absolute');
  return { ...env, ...(process.env.ARCH_HOME ? { ARCH_HOME: process.env.ARCH_HOME } : {}), ARCH_VIEWER_ROOT: path.join(resources, 'viewer'), ARCH_BUN: path.join(resources, executable('bun')), ARCH_CLIENT_ROOT: path.join(resources, 'client'), ARCH_STUDIO_PORT: '0', ARCH_STUDIO_PARENT_PIPE: '1' };
}
function validBootstrapUrl(value) { return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/#studio=[a-f0-9]{64}$/.test(value); }
async function startServer() {
  const resources = process.resourcesPath;
  const env = await serverEnvironment(resources);
  if (quitting) throw new Error('Arch Studio is quitting');
  // A detached Windows child would open its own console window.
  server = spawn(path.join(resources, executable('arch-server')), [], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: !windows, windowsHide: true });
  return new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => reject(new Error('Studio server startup timed out')), 30000);
    const fail = error => { clearTimeout(timer); reject(error); };
    server.once('error', fail);
    const child = server;
    server.once('exit', code => { if (server === child && !quitting) { fail(new Error(`Studio server exited (${code})`)); app.quit(); } });
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
// Project files opened from Finder, Explorer or the command line wait here until Studio's page takes them.
const projectFiles = [];
let deliverProjectFile;
function receiveProjectFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.archproject$/i.test(file)) return;
  if (deliverProjectFile) deliverProjectFile(file); else projectFiles.push(file);
}
// macOS reports opened documents through open-file, also before the app is ready.
app.on('open-file', (event, file) => { event.preventDefault(); receiveProjectFile(file); });
// Windows and Linux start a second process with the file. It hands the file to the first and quits.
if (process.platform !== 'darwin') {
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('second-instance', (_event, argv) => { for (const file of argv.slice(1)) receiveProjectFile(file); });
  for (const file of process.argv.slice(1)) receiveProjectFile(file);
}
app.on('before-quit', () => { quitting = true; updates?.dispose(); agentSetup?.dispose(); stopServer(); });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  // Every permission is refused except pointer lock for Studio's own page: walk mode and the
  // dollhouse's free look keep the mouse inside the viewer while it turns the camera.
  const studioPage = url => { try { return !!origin && new URL(url).origin === origin; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permission === 'pointerLock' && studioPage(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permission === 'pointerLock' && studioPage(requestingOrigin));
  const dev = !app.isPackaged && process.env.ARCH_STUDIO_DEV_URL;
  const bootstrapUrl = dev || await startServer();
  if (!validBootstrapUrl(bootstrapUrl)) throw new Error('Invalid local Studio bootstrap URL');
  let origin = new URL(bootstrapUrl).origin;
  const backgroundColor = () => nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff';
  const developmentIcon = !app.isPackaged ? path.join(app.getAppPath(), 'icon.png') : undefined;
  if (developmentIcon) app.dock?.setIcon(developmentIcon);
  const window = new BrowserWindow({
    width: 1440, height: 960, backgroundColor: backgroundColor(), icon: developmentIcon,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 19 } } : {}),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(app.getAppPath(), 'preload.cjs') },
  });
  const trustedFrame = event => {
    try { return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin; }
    catch { return false; }
  };
  const windowState = () => ({ fullscreen: window.isFullScreen() });
  ipcMain.handle('desktop:window-state', event => {
    if (!trustedFrame(event)) throw new Error('Window state requires the local Studio main frame');
    return windowState();
  });
  ipcMain.handle('desktop:choose-project-directory', async (event, ...args) => {
    if (!trustedFrame(event) || args.length) throw new Error('Directory selection requires the local Studio main frame and no arguments');
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    if (!trustedFrame(event)) throw new Error('Directory selection requires the local Studio main frame');
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
  ipcMain.handle('desktop:take-project-files', event => {
    if (!trustedFrame(event)) throw new Error('Project files require the local Studio main frame');
    return projectFiles.splice(0);
  });
  deliverProjectFile = file => {
    if (window.isDestroyed()) { projectFiles.push(file); return; }
    if (window.isMinimized()) window.restore();
    window.focus();
    try {
      if (new URL(window.webContents.mainFrame.url).origin === origin) { window.webContents.send('desktop:project-file', file); return; }
    } catch {}
    projectFiles.push(file);
  };
  const publishWindowState = () => {
    if (window.isDestroyed()) return;
    try {
      if (new URL(window.webContents.mainFrame.url).origin === origin) window.webContents.send('desktop:window-state', windowState());
    } catch {}
  };
  window.on('enter-full-screen', publishWindowState);
  window.on('leave-full-screen', () => {
    if (window.isDestroyed()) return;
    if (process.platform === 'darwin') window.setWindowButtonPosition({ x: 16, y: 19 });
    publishWindowState();
  });
  const syncAppearance = () => { if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor()); };
  nativeTheme.on('updated', syncAppearance);
  window.once('closed', () => nativeTheme.removeListener('updated', syncAppearance));
  const { autoUpdater } = require('electron-updater');
  updates = createDesktopUpdates({
    app, updater: autoUpdater,
    publish: state => { if (!window.isDestroyed()) window.webContents.send('desktop:update-state', state); },
    beforeInstall: () => {
      // Keep ownership of the loopback port until Squirrel actually quits us.
      // Block renderer commands while native installation is being prepared.
      origin = undefined;
      window.setEnabled(false);
    },
    recoverInstall: async () => {
      origin = new URL(bootstrapUrl).origin;
      window.setEnabled(true);
    },
  });
  for (const [name, method] of [['state', 'getState'], ['check', 'check'], ['download', 'download'], ['install', 'install']]) {
    ipcMain.handle(`desktop:update-${name}`, event => {
      if (!trustedFrame(event)) throw new Error('Update request requires the local Studio main frame');
      return updates[method]();
    });
  }
  agentSetup = createAgentSetup({
    environment: sharedUserEnvironment,
    publish: state => {
      if (window.isDestroyed()) return;
      try { if (new URL(window.webContents.mainFrame.url).origin === origin) window.webContents.send('desktop:agent-setup', state); } catch {}
    },
    openExternal: url => shell.openExternal(url),
    openPath: file => shell.openPath(file),
  });
  const agentRequest = (event, args, count, valid = () => true) => {
    if (!trustedFrame(event) || args.length !== count || !valid(...args)) throw new Error('Agent setup requires the local Studio main frame and valid arguments');
  };
  const supportedAgent = provider => provider === 'claude';
  ipcMain.handle('desktop:agent-setup-state', (event, ...args) => { agentRequest(event, args, 0); return agentSetup.getState(); });
  ipcMain.handle('desktop:agent-install', (event, ...args) => { agentRequest(event, args, 1, supportedAgent); return agentSetup.install(args[0]); });
  ipcMain.handle('desktop:agent-sign-in', (event, ...args) => { agentRequest(event, args, 1, supportedAgent); return agentSetup.signIn(args[0]); });
  ipcMain.handle('desktop:agent-sign-in-code', (event, ...args) => { agentRequest(event, args, 1, code => typeof code === 'string' && code.length <= 4096); return agentSetup.submitCode(args[0]); });
  ipcMain.handle('desktop:agent-sign-in-open', (event, ...args) => { agentRequest(event, args, 0); return agentSetup.openSignInPage(); });
  ipcMain.handle('desktop:agent-sign-in-cancel', (event, ...args) => { agentRequest(event, args, 0); return agentSetup.cancelSignIn(); });
  const systemLanguages = [...app.getPreferredSystemLanguages(), app.getLocale()];
  // Windows and Linux spell-check in the chosen languages. macOS detects the language itself.
  const spellingLanguages = { en: ['en-US', 'en-GB', 'en'], de: ['de-DE', 'de'], es: ['es-ES', 'es-419', 'es-MX', 'es'], pt: ['pt-BR', 'pt-PT', 'pt'] };
  const applySpellingLanguage = locale => {
    if (process.platform === 'darwin') return;
    const available = new Set(session.defaultSession.availableSpellCheckerLanguages);
    const language = spellingLanguages[locale].find(code => available.has(code));
    if (language) session.defaultSession.setSpellCheckerLanguages([language]);
  };
  let currentLocale;
  let currentMenuLabels;
  const applyMenuLocale = locale => {
    if (locale === currentLocale || window.isDestroyed()) return;
    currentLocale = locale;
    currentMenuLabels = menuLabels(locale);
    const labels = currentMenuLabels;
    applySpellingLanguage(locale);
    const checkForUpdates = { label: labels.checkForUpdates, click: () => { void updates.check(); } };
    const settings = { label: labels.settings, accelerator: 'CmdOrCtrl+,', click: () => { if (!window.isDestroyed()) window.webContents.send('desktop:open-settings'); } };
    const appMenu = process.platform === 'darwin' ? [
      { label: labels.about, role: 'about' },
      checkForUpdates,
      { type: 'separator' },
      settings,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] : [settings, checkForUpdates, { type: 'separator' }, { role: 'quit' }];
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Arch Studio', submenu: appMenu },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  };
  const localeUrl = new URL(bootstrapUrl).origin;
  const cookies = session.defaultSession.cookies;
  let localeRevision = 0;
  const refreshMenuLocale = async () => {
    const revision = ++localeRevision;
    const preferences = await cookies.get({ url: `${localeUrl}/`, name: 'arch-locale' }).catch(() => []);
    if (revision === localeRevision) applyMenuLocale(menuLocale(preferences[0]?.value, systemLanguages));
  };
  const localeChanged = (_event, cookie) => {
    if (cookie.name === 'arch-locale' && cookie.domain.replace(/^\./, '') === new URL(localeUrl).hostname && cookie.path === '/') {
      void refreshMenuLocale();
    }
  };
  cookies.on('changed', localeChanged);
  window.once('closed', () => { ++localeRevision; cookies.removeListener('changed', localeChanged); });
  applyMenuLocale(menuLocale(undefined, systemLanguages));
  await refreshMenuLocale();
  // Spelling suggestions and editing commands for Studio's own page. Other frames, such as the
  // PDF viewer, keep no menu. A page that handles right-click itself never reaches this.
  window.webContents.on('context-menu', (_event, params) => {
    try { if (!origin || new URL(params.pageURL).origin !== origin || new URL(params.frameURL || params.pageURL).origin !== origin) return; }
    catch { return; }
    const labels = currentMenuLabels;
    const { editFlags } = params;
    const items = [];
    if (params.isEditable && params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 6)) items.push({ label: suggestion, click: () => { if (!window.isDestroyed()) window.webContents.replaceMisspelling(suggestion); } });
      if (!items.length) items.push({ label: labels.noSuggestions, enabled: false });
      items.push({ type: 'separator' }, { label: labels.addToDictionary, click: () => session.defaultSession.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    }
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: labels.cut, enabled: editFlags.canCut },
        { role: 'copy', label: labels.copy, enabled: editFlags.canCopy },
        { role: 'paste', label: labels.paste, enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: labels.selectAll, enabled: editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) items.push({ role: 'copy', label: labels.copy, enabled: editFlags.canCopy });
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({url}) => {
    try {
      const target = new URL(url);
      if (target.origin === origin && /^\/api\/(references|artifacts|exports)\//.test(target.pathname)) window.webContents.downloadURL(target.href);
    } catch {}
    return { action: 'deny' };
  });
  ipcMain.on('open-external-link', (event, url) => {
    if (!trustedFrame(event)) return;
    try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {}
  });
  // Chromium's built-in PDF viewer renders inside its own extension frame. Allow only that
  // extension, so reference PDFs display while every other foreign frame stays blocked.
  // Extension URLs have an opaque "null" origin, so match the scheme and extension ID.
  const pdfViewer = url => url.protocol === 'chrome-extension:' && url.host === 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
  window.webContents.on('will-frame-navigate', event => { const target = new URL(event.url); if (target.origin !== origin && !pdfViewer(target)) event.preventDefault(); });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol === 'https:') { event.preventDefault(); }
  });
  // A page that runs out of memory, such as on a model too heavy to open, reloads with its session.
  // A second crash within a minute asks first, so a page that keeps crashing cannot loop.
  let lastCrash = -Infinity;
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (quitting || window.isDestroyed() || details.reason === 'clean-exit') return;
    const repeated = Date.now() - lastCrash < 60_000;
    lastCrash = Date.now();
    if (repeated) {
      const labels = currentMenuLabels;
      const { response } = await dialog.showMessageBox(window, { type: 'warning', message: labels.pageCrashed, detail: labels.pageCrashedDetail, buttons: [labels.reopen, labels.quit], defaultId: 0, cancelId: 1 });
      if (response === 1) { app.quit(); return; }
    }
    if (!window.isDestroyed()) window.webContents.reload();
  });
  await window.loadURL(bootstrapUrl);
  void updates.start();
}).catch(error => { console.error(error.message); stopServer(); app.quit(); });
