const { ipcRenderer } = require('electron');
window.addEventListener('click', event => {
  if (!event.isTrusted) return;
  const anchor = event.target.closest?.('a[href]');
  if (!anchor) return;
  try {
    const url = new URL(anchor.href);
    if (url.protocol === 'https:') { event.preventDefault(); ipcRenderer.send('open-external-link', url.href); }
  } catch {}
}, true);
