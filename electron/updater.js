/* ============================================================================
 * Z-LAG TOOLBOX — GitHub release updater
 * ----------------------------------------------------------------------------
 * Installed (NSIS) builds check the public GitHub Releases feed, download a
 * verified electron-builder update in the background, and offer a one-click
 * restart when it is ready. Portable builds check the same feed but never turn
 * themselves into an installed copy; they direct the user to the release page.
 *
 * This module has no hard dependency on Electron at load time. Dependencies are
 * injected by main.js, which also makes the state machine straightforward to
 * unit test without opening a desktop window.
 * ========================================================================== */
'use strict';

const RELEASES_URL = 'https://github.com/MrPcGamerYT/Z-LAG-TOOLBOX/releases/latest';
const STATUS_CHANNEL = 'zlag:update-status';

function cleanError(error) {
  const raw = String((error && error.message) || error || 'Update check failed');
  // Keep renderer messages useful but avoid leaking headers/tokens from a
  // provider error. GitHub's public feed does not need credentials at runtime.
  return raw
    .replace(/(token|authorization)\s*(=|:)\s*[^\r\n,;]+/ig, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function createUpdater(options) {
  const opts = options || {};
  const app = opts.app;
  const autoUpdater = opts.autoUpdater;
  const dialog = opts.dialog;
  const shell = opts.shell;
  const getWindow = typeof opts.getWindow === 'function' ? opts.getWindow : () => null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const platform = opts.platform || process.platform;
  const portable = !!opts.portable;
  const packaged = !!(app && app.isPackaged);
  const currentVersion = app && typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0';

  let initialized = false;
  let checking = false;
  let readyPromptShown = false;
  let startupTimer = null;
  let state = {
    status: 'idle',
    currentVersion,
    version: '',
    percent: 0,
    transferred: 0,
    total: 0,
    portable,
    supported: platform === 'win32' && packaged,
    releaseUrl: RELEASES_URL,
    message: 'Updates are provided by GitHub Releases.'
  };

  function snapshot() {
    return Object.assign({}, state);
  }

  function send() {
    const win = getWindow();
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
    try { win.webContents.send(STATUS_CHANNEL, snapshot()); } catch (_) {}
  }

  function setState(patch) {
    state = Object.assign({}, state, patch || {});
    send();
    return snapshot();
  }

  function disabled(reason, message) {
    return setState({
      status: 'disabled',
      supported: false,
      reason,
      message,
      percent: 0,
      transferred: 0,
      total: 0
    });
  }

  async function downloadInstalledUpdate() {
    if (portable || !autoUpdater) return;
    try {
      setState({ status: 'downloading', message: 'Downloading the update from GitHub…' });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = cleanError(error);
      log('updater download failed: ' + message);
      setState({ status: 'error', message });
    }
  }

  async function promptReady() {
    if (readyPromptShown || portable || !dialog) return;
    readyPromptShown = true;
    const win = getWindow();
    try {
      const messageOptions = {
        type: 'info',
        title: 'Z-LAG Toolbox update ready',
        message: 'Z-LAG Toolbox ' + (state.version || 'update') + ' is ready.',
        detail: 'Restart now to finish installing the update. You can also choose Later and restart from the Dashboard.',
        buttons: ['Restart and install', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      };
      const result = win
        ? await dialog.showMessageBox(win, messageOptions)
        : await dialog.showMessageBox(messageOptions);
      if (result.response === 0) install();
    } catch (error) {
      log('updater ready prompt failed: ' + cleanError(error));
    }
  }

  function bindEvents() {
    if (!autoUpdater || initialized) return;
    initialized = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = !portable;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = {
      info: (...args) => log('[updater] ' + args.join(' ')),
      warn: (...args) => log('[updater:warn] ' + args.join(' ')),
      error: (...args) => log('[updater:error] ' + args.join(' ')),
      debug: (...args) => log('[updater:debug] ' + args.join(' '))
    };

    autoUpdater.on('checking-for-update', () => {
      checking = true;
      setState({ status: 'checking', message: 'Checking GitHub Releases…', percent: 0 });
    });

    autoUpdater.on('update-available', (info) => {
      checking = false;
      const version = String((info && info.version) || '');
      log('update available: ' + version + (portable ? ' (portable notification)' : ''));
      setState({
        status: 'available',
        version,
        message: portable
          ? 'Version ' + version + ' is available. Download the new portable build from GitHub.'
          : 'Version ' + version + ' is available and will download in the background.'
      });
      if (!portable) void downloadInstalledUpdate();
    });

    autoUpdater.on('update-not-available', (info) => {
      checking = false;
      setState({
        status: 'current',
        version: String((info && info.version) || currentVersion),
        message: 'You have the latest version.',
        percent: 100
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      setState({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Number(progress && progress.percent) || 0)),
        transferred: Number(progress && progress.transferred) || 0,
        total: Number(progress && progress.total) || 0,
        message: 'Downloading version ' + (state.version || '') + ' from GitHub…'
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      const version = String((info && info.version) || state.version || '');
      log('update downloaded: ' + version);
      setState({
        status: 'ready',
        version,
        percent: 100,
        message: 'Version ' + version + ' is ready. Restart to install it.'
      });
      void promptReady();
    });

    autoUpdater.on('error', (error) => {
      checking = false;
      const message = cleanError(error);
      log('updater error: ' + message);
      setState({ status: 'error', message });
    });
  }

  function init() {
    if (platform !== 'win32') {
      return disabled('platform', 'Automatic updates are available in the Windows app.');
    }
    if (!packaged) {
      return disabled('development', 'Update checks are enabled in published builds.');
    }
    if (!autoUpdater) {
      return disabled('unavailable', 'The update service could not be loaded.');
    }

    bindEvents();
    setState({
      status: 'idle',
      supported: true,
      message: portable
        ? 'Portable edition: checks GitHub and notifies you about new portable downloads.'
        : 'Automatic updates are enabled through GitHub Releases.'
    });
    return snapshot();
  }

  async function check() {
    if (!state.supported || !autoUpdater) return snapshot();
    if (checking || state.status === 'downloading') return snapshot();
    checking = true;
    setState({ status: 'checking', message: 'Checking GitHub Releases…', percent: 0 });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      checking = false;
      const message = cleanError(error);
      log('updater check failed: ' + message);
      setState({ status: 'error', message });
    }
    return snapshot();
  }

  function scheduleCheck(delayMs) {
    if (!state.supported || startupTimer) return;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void check();
    }, Math.max(0, Number(delayMs) || 0));
    if (startupTimer && typeof startupTimer.unref === 'function') startupTimer.unref();
  }

  function install() {
    if (portable) {
      void openRelease();
      return { ok: false, portable: true, error: 'Portable builds are replaced from the GitHub release page.' };
    }
    if (!autoUpdater || state.status !== 'ready') {
      return { ok: false, error: 'No downloaded update is ready.' };
    }
    log('installing downloaded update');
    setImmediate(() => {
      try { autoUpdater.quitAndInstall(false, true); }
      catch (error) {
        const message = cleanError(error);
        log('updater install failed: ' + message);
        setState({ status: 'error', message });
      }
    });
    return { ok: true };
  }

  async function openRelease() {
    try {
      if (!shell || typeof shell.openExternal !== 'function') throw new Error('Shell service unavailable');
      await shell.openExternal(RELEASES_URL);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: cleanError(error) };
    }
  }

  function dispose() {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
  }

  return {
    init,
    check,
    install,
    openRelease,
    scheduleCheck,
    status: snapshot,
    dispose,
    _setState: setState
  };
}

module.exports = { createUpdater, cleanError, RELEASES_URL, STATUS_CHANNEL };
