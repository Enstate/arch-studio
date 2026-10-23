const { ipcRenderer, contextBridge } = require('electron');
const platform = process.platform;
let fullscreen = false;
let receivedWindowState = false;
const applyWindowState = () => {
  if (!document.documentElement) return;
  document.documentElement.dataset.archPlatform = platform;
  document.documentElement.dataset.archFullscreen = String(fullscreen);
};
const receiveWindowState = state => {
  if (!state || typeof state.fullscreen !== 'boolean') return;
  fullscreen = state.fullscreen;
  applyWindowState();
};
ipcRenderer.on('desktop:window-state', (_event, state) => {
  receivedWindowState = true;
  receiveWindowState(state);
});
window.addEventListener('DOMContentLoaded', applyWindowState, { once: true });
void ipcRenderer.invoke('desktop:window-state').then(state => {
  // A fullscreen transition can arrive before this initial read resolves.
  if (!receivedWindowState) receiveWindowState(state);
}).catch(() => {});
// Project files opened from Finder or Explorer. Files that arrive before the page listens wait here,
// and files that arrived before this page loaded wait in the main process.
const projectFileListeners = new Set();
const projectFileBacklog = [];
const receiveProjectFile = file => {
  if (typeof file !== 'string') return;
  if (projectFileListeners.size) for (const listener of projectFileListeners) listener(file);
  else projectFileBacklog.push(file);
};
ipcRenderer.on('desktop:project-file', (_event, file) => receiveProjectFile(file));
void ipcRenderer.invoke('desktop:take-project-files').then(files => { for (const file of files) receiveProjectFile(file); }).catch(() => {});
contextBridge.exposeInMainWorld('archDesktop', {
  chooseProjectDirectory: () => ipcRenderer.invoke('desktop:choose-project-directory'),
  getUpdateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkForUpdate: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  onOpenSettings: listener => {
    const receive = () => listener();
    ipcRenderer.on('desktop:open-settings', receive);
    return () => ipcRenderer.removeListener('desktop:open-settings', receive);
  },
  onProjectFile: listener => {
    projectFileListeners.add(listener);
    for (const file of projectFileBacklog.splice(0)) listener(file);
    return () => projectFileListeners.delete(listener);
  },
  // Claude Code install and sign-in. The provider is the only choice; main owns the commands.
  getAgentSetup: () => ipcRenderer.invoke('desktop:agent-setup-state'),
  installAgent: provider => ipcRenderer.invoke('desktop:agent-install', provider),
  signInAgent: provider => ipcRenderer.invoke('desktop:agent-sign-in', provider),
  submitAgentSignInCode: code => ipcRenderer.invoke('desktop:agent-sign-in-code', code),
  openAgentSignInPage: () => ipcRenderer.invoke('desktop:agent-sign-in-open'),
  cancelAgentSignIn: () => ipcRenderer.invoke('desktop:agent-sign-in-cancel'),
  onAgentSetup: listener => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('desktop:agent-setup', receive);
    return () => ipcRenderer.removeListener('desktop:agent-setup', receive);
  },
  onUpdateState: listener => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('desktop:update-state', receive);
    return () => ipcRenderer.removeListener('desktop:update-state', receive);
  },
});
window.addEventListener('click', event => {
  if (!event.isTrusted) return;
  const anchor = event.target.closest?.('a[href]');
  if (!anchor) return;
  try {
    const url = new URL(anchor.href);
    if (url.protocol === 'https:') { event.preventDefault(); ipcRenderer.send('open-external-link', url.href); }
  } catch {}
}, true);
