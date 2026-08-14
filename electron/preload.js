/* ============================================================================
 * Z-LAG TOOLBOX — preload bridge
 * ----------------------------------------------------------------------------
 * The only surface exposed to the renderer. contextIsolation stays on and the
 * renderer never gets Node, fs or child_process — it can only send a request
 * down the single 'zlag:api' channel, which server/core.js validates.
 * ========================================================================== */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Split '/api/x?a=1&b=2' into a pathname plus a plain query object. */
function splitUrl(url) {
  const raw = String(url || '');
  const qi = raw.indexOf('?');
  if (qi === -1) return { pathname: raw, query: {} };
  const pathname = raw.slice(0, qi);
  const query = {};
  for (const [k, v] of new URLSearchParams(raw.slice(qi + 1))) query[k] = v;
  return { pathname, query };
}

contextBridge.exposeInMainWorld('zlag', {
  isDesktop: true,
  platform: process.platform,

  /**
   * Drop-in replacement for fetch() against the old HTTP API.
   * @param {string} url  e.g. '/api/store/search?q=spotify'
   * @param {{method?:string, body?:string}} [opts]
   */
  api(url, opts) {
    const { pathname, query } = splitUrl(url);
    let body = {};
    if (opts && opts.body) {
      try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body; }
      catch (_) { body = {}; }
    }
    return ipcRenderer.invoke('zlag:api', {
      method: (opts && opts.method) || 'GET',
      pathname,
      query,
      body
    });
  },

  window: {
    minimize: () => ipcRenderer.invoke('zlag:window', 'minimize'),
    maximize: () => ipcRenderer.invoke('zlag:window', 'maximize'),
    close: () => ipcRenderer.invoke('zlag:window', 'close'),
    onState: (cb) => ipcRenderer.on('window:state', (_e, s) => cb(s))
  },

  shell: {
    openDownloads: () => ipcRenderer.invoke('zlag:shell', { action: 'downloads' }),
    openPath: (target) => ipcRenderer.invoke('zlag:shell', { action: 'openPath', target }),
    showItem: (target) => ipcRenderer.invoke('zlag:shell', { action: 'showItem', target })
  },

  updates: {
    status: () => ipcRenderer.invoke('zlag:update', 'status'),
    check: () => ipcRenderer.invoke('zlag:update', 'check'),
    install: () => ipcRenderer.invoke('zlag:update', 'install'),
    openRelease: () => ipcRenderer.invoke('zlag:update', 'open-release'),
    onStatus(callback) {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('zlag:update-status', listener);
      return () => ipcRenderer.removeListener('zlag:update-status', listener);
    }
  }
});
