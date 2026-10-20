const { ipcRenderer, contextBridge } = require('electron');
contextBridge.exposeInMainWorld('archDesktop', {
  getUpdateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkForUpdate: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
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
