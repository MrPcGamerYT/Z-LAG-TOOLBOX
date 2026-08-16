/* ============================================================================
 * Z-LAG TOOLBOX — native desktop application (Electron main process)
 * ----------------------------------------------------------------------------
 * This is a REAL app, not a browser pointed at localhost:
 *
 *   • The UI is loaded from disk with loadFile() → the address is file://,
 *     there is no HTTP server, no port is opened and nothing is reachable
 *     from outside the machine.
 *   • The renderer talks to the backend through a single contextIsolated IPC
 *     channel (see preload.js) that forwards to server/core.js.
 *   • The window is frameless with a custom title bar so it looks and behaves
 *     like a native Windows 11 app.
 *
 * ----------------------------------------------------------------------------
 * LAUNCH ORDER — do not reorder:
 *
 *   1. Pin a writable, stable userData directory before Electron uses it.
 *   2. Resolve elevation before taking the single-instance lock. The original
 *      process waits for a visible-window acknowledgement from the elevated
 *      copy instead of exiting as soon as ShellExecute returns.
 *   3. Take the lock, create and reveal the local window, then run maintenance
 *      and update checks in the background so they cannot delay first paint.
 *   4. A failed prior first paint automatically enables software rendering;
 *      fatal load paths show a recovery page or error dialog, never silence.
 * ========================================================================== */
'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, dialog, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const launch = require('./launch');
const { createUpdater } = require('./updater');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const IS_WINDOWS = process.platform === 'win32';

let mainWindow = null;
let core = null;              // required lazily so a backend error cannot
                              // stop the window from appearing
let updateService = null;
let stateDir = IS_WINDOWS ? launch.portableStateDir() : null;
const handoffFile = IS_WINDOWS ? launch.flagValue('--zlag-handoff') : '';

// ============================================================================
// 0 · STATE DIRECTORY — must be settled before Electron touches userData
// ============================================================================
/**
 * A portable exe extracts to a fresh temp folder on every run, so the default
 * userData (derived from the exe path) moves around and can land somewhere
 * unwritable. Pinning it to LOCALAPPDATA makes portable and installed builds
 * behave identically and keeps settings/logs across runs.
 */
(function pinUserData() {
  if (!IS_WINDOWS) return;
  const r = launch.ensureStateDir(stateDir);
  if (r.ok) {
    stateDir = r.dir;
    try { app.setPath('userData', r.dir); } catch (_) {}
    // Keep Chromium's cache isolated from settings and repair reports.
    try {
      const sessions = path.join(r.dir, 'Session Data');
      fs.mkdirSync(sessions, { recursive: true });
      app.setPath('sessionData', sessions);
    } catch (_) {}
  }
})();

// ---------------------------------------------------------------- file log
function logDir() {
  try { return path.join(app.getPath('userData'), 'logs'); } catch (_) { return ROOT; }
}
function mainLogPath() {
  return path.join(logDir(), 'zlag-main.log');
}
function log(line) {
  const msg = '[' + new Date().toISOString() + '] ' + line;
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(mainLogPath(), msg + '\n');
  } catch (_) {}
  try { console.log(msg); } catch (_) {}
}

log('=== starting Z-LAG Toolbox ' + (app.getVersion ? app.getVersion() : '') +
  ' packaged=' + app.isPackaged +
  ' portable=' + launch.isPortableBuild() +
  ' exe=' + process.execPath + ' ===');

// Clean our own unused extraction folders from interrupted portable runs.
try { launch.cleanPortableLeftovers(log); } catch (e) { log('portable cleanup: ' + e.message); }

// ============================================================================
// 1 · ELEVATION — decided before the single-instance lock
// ============================================================================
/**
 * The packaged exe is manifested `asInvoker` on purpose (see package.json).
 * The portable launcher must finish its normal extraction before the app asks
 * Windows for a high-integrity token. Relaunching then uses the stable outer
 * executable and waits for a visible-window acknowledgement. Declining UAC
 * keeps this process alive in clearly labelled limited mode.
 *
 * @returns {Promise<'continue'|'handoff'>}
 */
async function resolveElevation() {
  if (!IS_WINDOWS) {
    global.__zlagElevated = true;
    return 'continue';
  }

  const elevated = await launch.isElevated();
  global.__zlagElevated = elevated;

  // Source builds deliberately do not relaunch themselves. Their actions run
  // in demo/developer mode and a UAC bounce would restart the Electron binary
  // without the project path.
  if (!app.isPackaged) return 'continue';

  if (elevated) {
    log('elevation: already administrator');
    return 'continue';
  }

  if (launch.hasFlag('--no-elevate') || process.env.ZLAG_NO_ELEVATE === '1') {
    log('elevation: skipped by flag — continuing in limited mode');
    global.__zlagLimited = true;
    return 'continue';
  }

  // A relay that comes back un-elevated means UAC was declined or the token
  // could not be raised. Never bounce a second time.
  if (launch.hasFlag('--zlag-relayed')) {
    log('elevation: relay returned un-elevated — continuing in limited mode');
    global.__zlagLimited = true;
    return 'continue';
  }

  const relayFile = launch.createHandoffPath(stateDir);
  const args = launch.argv()
    .filter((a) => a !== '--zlag-relayed' && !String(a).startsWith('--zlag-handoff='))
    .concat('--zlag-relayed', '--zlag-handoff=' + relayFile);
  const target = launch.relaunchTarget();

  log('elevation: requesting administrator via stable launcher ' + target);
  const r = await launch.relaunchElevated(target, args, launch.relaunchWorkingDir());

  if (r.ok) {
    // Do not disappear merely because ShellExecute accepted the request. Wait
    // until the elevated renderer actually paints and acknowledges the handoff.
    const relay = await launch.waitForHandoff(relayFile, stateDir, 30000);
    if (relay.phase === 'ready') {
      log('elevation: elevated window ready via ' + r.method + ' pid=' + relay.pid);
      return 'handoff';
    }
    if (relay.phase === 'error') {
      log('elevation: elevated child reported an error: ' + (relay.detail || 'unknown'));
      global.__zlagElevationError = relay.detail || 'elevated child failed';
    } else {
      log('elevation: child did not confirm a visible window (phase=' + relay.phase + ')');
      global.__zlagElevationError = 'The administrator copy did not finish starting.';
    }
    // The original process remains available as a reliable limited-mode
    // fallback. If the child still owns the singleton lock, the visible error
    // path in bootstrap below explains that instead of silently vanishing.
    global.__zlagLimited = true;
    return 'continue';
  }

  // Could not elevate. Keep running with what we have — a limited window is
  // infinitely better than nothing at all.
  log('elevation: FAILED (' + (r.error || 'unknown') + ') — continuing in limited mode');
  global.__zlagLimited = true;
  global.__zlagElevationError = r.cancelled ? 'declined' : (r.error || 'unknown');
  return 'continue';
}

// ============================================================================
// 2 · WINDOW
// ============================================================================
function restartWithSoftwareRendering() {
  const args = launch.argv()
    .filter((a) => a !== '--disable-gpu' && a !== '--zlag-relayed' &&
      !String(a).startsWith('--zlag-handoff='))
    .concat('--disable-gpu');
  try {
    launch.beginStartup(stateDir, 'safe-mode-restart');
    app.relaunch({ execPath: launch.relaunchTarget(), args });
    app.exit(0);
  } catch (error) {
    log('safe-mode restart failed: ' + error.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: 'Z-LAG Toolbox',
    backgroundColor: '#03040d',
    show: false,
    frame: false,                 // custom title bar — native app feel
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    icon: path.join(PUBLIC, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,          // Chromium is bundled; no external WebView runtime
      webSecurity: true,
      safeDialogs: true,
      spellcheck: false,
      // Let Chromium pause timers and rendering while the window is hidden.
      // Server-side installs continue in the main process, so keeping the
      // renderer at full speed only wastes CPU on low-end machines.
      backgroundThrottling: true,
      devTools: !app.isPackaged
    }
  });

  Menu.setApplicationMenu(null);
  nativeTheme.themeSource = 'dark';

  // file:// — the app never points at a web server. If the packaged UI is
  // damaged, render an internal recovery page rather than leaving a blank,
  // invisible process.
  const uiFile = path.join(PUBLIC, 'index.html');
  mainWindow.loadFile(uiFile).catch((error) => {
    const detail = String((error && error.message) || error || 'Unknown load error');
    log('loadFile failed: ' + detail);
    const html = '<!doctype html><meta charset="utf-8"><title>Z-LAG Toolbox recovery</title>' +
      '<style>body{margin:0;background:#050816;color:#eef2ff;font:16px Segoe UI,sans-serif;padding:48px}' +
      'main{max-width:760px;margin:auto;background:#111936;border:1px solid #37406b;border-radius:18px;padding:30px}' +
      'h1{margin-top:0;color:#a78bfa}code{color:#67e8f9;word-break:break-all}</style>' +
      '<main><h1>Z-LAG Toolbox could not load its interface</h1>' +
      '<p>The application stayed open so this error is visible. Reinstall the latest GitHub release.</p>' +
      '<p><b>Details:</b> <code>' + detail.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) + '</code></p>' +
      '<p><b>Log:</b> <code>' + mainLogPath().replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></p></main>';
    return mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }).catch((fallbackError) => log('recovery page failed: ' + fallbackError.message));

  // Safety net: if ready-to-show never fires (a GPU stall, a renderer that
  // dies during first paint) the window used to stay invisible forever and
  // the process lingered with no UI — the classic "it just doesn't open".
  let shown = false;
  const reveal = (why) => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    log('window shown (' + why + ')');
    mainWindow.show();
    mainWindow.focus();
    if (IS_WINDOWS) launch.markStartupHealthy(stateDir, why);
    if (handoffFile) launch.signalHandoff(handoffFile, stateDir, 'ready', why);
    if (global.__zlagLimited) warnLimitedMode();
  };
  mainWindow.once('ready-to-show', () => reveal('ready-to-show'));
  mainWindow.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  setTimeout(() => reveal('timeout-fallback'), 9000);

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone reason=' + (details && details.reason) +
      ' exitCode=' + (details && details.exitCode));
    launch.beginStartup(stateDir, 'renderer-' + ((details && details.reason) || 'crash'));
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Z-LAG Toolbox',
      message: 'The app window crashed (' + ((details && details.reason) || 'unknown') + ').',
      detail: 'Restart with software rendering to bypass graphics-driver startup failures.\n\nLog: ' + mainLogPath(),
      buttons: ['Restart safely', 'Reload', 'Quit'],
      defaultId: 0,
      cancelId: 2
    });
    if (choice === 0) restartWithSoftwareRendering();
    else if (choice === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    else app.quit();
  });

  mainWindow.webContents.on('unresponsive', () => {
    log('renderer unresponsive');
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Z-LAG Toolbox',
      message: 'Z-LAG Toolbox is not responding.',
      buttons: ['Wait', 'Reload']
    });
    if (choice === 1 && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log('did-fail-load ' + code + ' ' + desc);
  });
  mainWindow.webContents.on('console-message', (_event, levelOrDetails, oldMessage) => {
    // Electron 32+ passes a details object; older releases used positional args.
    const message = levelOrDetails && typeof levelOrDetails === 'object'
      ? levelOrDetails.message
      : oldMessage;
    if (/error|failed/i.test(String(message || ''))) {
      log('[renderer] ' + String(message).slice(0, 400));
    }
  });

  const sendState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);

  const openSafeExternal = (raw) => {
    try {
      const target = new URL(String(raw));
      if (target.protocol === 'https:') void shell.openExternal(target.toString());
    } catch (_) {}
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternal(url);
    return { action: 'deny' };
  });
  const allowedUiUrl = pathToFileURL(uiFile).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localUi = url === allowedUiUrl || url.startsWith(allowedUiUrl + '#');
    const recoveryPage = url.startsWith('data:text/html');
    if (!localUi && !recoveryPage) {
      event.preventDefault();
      openSafeExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

let warnedLimited = false;
function warnLimitedMode() {
  if (warnedLimited) return;
  warnedLimited = true;
  const why = global.__zlagElevationError === 'declined'
    ? 'You chose "No" on the Windows administrator prompt.'
    : (global.__zlagElevationError
      ? 'The administrator copy did not start: ' + global.__zlagElevationError
      : 'This process does not have administrator rights.');
  dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Z-LAG Toolbox — limited mode',
    message: 'Running without administrator rights.',
    detail: why + '\n\nBrowsing, scanning and the Store catalog all work. ' +
      'Applying tweaks, installing drivers and installing Store packages need admin — ' +
      'close the app and start it again, choosing "Yes" on the prompt.',
    buttons: ['Continue']
  });
}

// ============================================================================
// 3 · IPC BRIDGE
// ============================================================================
function getCore() {
  if (!core) core = require('../server/core');
  return core;
}

ipcMain.handle('zlag:api', async (_event, payload) => {
  const { method, pathname, query, body } = payload || {};
  try {
    const r = await getCore().dispatch(method, pathname, query, body);
    return r.body;
  } catch (e) {
    log('IPC error ' + pathname + ': ' + ((e && e.stack) || e));
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('zlag:window', (_event, action) => {
  if (!mainWindow) return { ok: false };
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
  return { ok: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle('zlag:update', async (_event, action) => {
  if (!updateService) {
    return {
      status: 'disabled', supported: false, currentVersion: app.getVersion(),
      message: 'The update service is still starting.'
    };
  }
  if (action === 'check') return updateService.check();
  if (action === 'install') return updateService.install();
  if (action === 'open-release') return updateService.openRelease();
  return updateService.status();
});

/** Environment facts the UI needs to explain itself (limited mode banner). */
ipcMain.handle('zlag:env', () => ({
  ok: true,
  elevated: !!global.__zlagElevated,
  portable: launch.isPortableBuild(),
  packaged: app.isPackaged,
  version: app.getVersion(),
  logPath: mainLogPath()
}));

function isAllowedLocalTarget(target) {
  if (!IS_WINDOWS || !path.isAbsolute(String(target || ''))) return false;
  const roots = [
    getCore().downloadsRoot(),
    // Driver package downloads and driver backups — the Driver Center offers
    // "open folder" for both, so they must be openable like Store downloads.
    require('../server/drivers').driverDownloadRoot(),
    require('../server/drivers').backupRoot(),
    process.env.ZLAG_PROGRAMS ||
      path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'),
        'Programs', 'Z-LAG Toolbox'),
    path.join(process.env.APPDATA || app.getPath('appData'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Z-LAG Toolbox')
  ];
  const candidate = path.resolve(String(target)).toLowerCase();
  return roots.some((root) => {
    const allowed = path.resolve(root).toLowerCase();
    return candidate === allowed || candidate.startsWith(allowed + path.sep.toLowerCase());
  });
}

ipcMain.handle('zlag:shell', async (_event, payload) => {
  const { action, target } = payload || {};
  try {
    if (action === 'openPath') {
      if (/^shell:AppsFolder\\[A-Za-z0-9._!\-]+$/i.test(String(target))) {
        require('child_process').spawn(
          'powershell.exe',
          ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
            'Start-Process explorer.exe -ArgumentList ' + JSON.stringify(target)],
          { detached: true, stdio: 'ignore', windowsHide: true }
        ).unref();
        return { ok: true };
      }
      if (!isAllowedLocalTarget(target)) return { ok: false, error: 'Blocked local path' };
      const err = await shell.openPath(target);
      if (err) {
        log('openPath failed for ' + target + ': ' + err);
        return { ok: false, error: err };
      }
      return { ok: true };
    }
    if (action === 'showItem') {
      if (!isAllowedLocalTarget(target)) return { ok: false, error: 'Blocked local path' };
      shell.showItemInFolder(target);
      return { ok: true };
    }
    if (action === 'openLog') { await shell.openPath(mainLogPath()); return { ok: true }; }
    if (action === 'downloads') { await shell.openPath(getCore().downloadsRoot()); return { ok: true }; }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: false, error: 'Unknown shell action' };
});

// ============================================================================
// 4 · LIFECYCLE
// ============================================================================
app.setAppUserModelId('com.zlag.toolbox');

// Electron includes its own Chromium runtime (there is no WebView2 dependency).
// If the prior attempt failed before first paint, retry once with software
// rendering so a damaged GPU stack cannot create a permanent startup loop.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const automaticSafeMode = IS_WINDOWS && launch.previousStartupFailed(stateDir);
if (automaticSafeMode || launch.hasFlag('--disable-gpu') || process.env.ZLAG_NO_GPU === '1') {
  app.disableHardwareAcceleration();
  log('hardware acceleration disabled (' + (automaticSafeMode ? 'previous startup failed' : 'requested') + ')');
}

/**
 * THE launch sequence. Elevation first, THEN the single-instance lock.
 * Getting this order wrong is what made the app exit without a window.
 */
async function bootstrap() {
  let decision = 'continue';
  try {
    decision = await resolveElevation();
  } catch (e) {
    log('elevation check threw (' + e.message + ') — continuing unelevated');
    global.__zlagLimited = true;
  }

  if (decision === 'handoff') {
    app.exit(0);
    return;
  }

  // Only now do we compete for the lock — no parent/child deadlock.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    log('another instance owns the lock — focusing it and exiting');
    if (handoffFile) {
      launch.signalHandoff(handoffFile, stateDir, 'error', 'Another instance already owns the app lock.');
    }
    if (global.__zlagElevationError) {
      try {
        dialog.showErrorBox('Z-LAG Toolbox startup handoff failed',
          global.__zlagElevationError + '\n\nAn administrator process is still running. ' +
          'Close it in Task Manager, then launch Z-LAG Toolbox again.\n\nLog: ' + mainLogPath());
      } catch (_) {}
    }
    app.exit(0);
    return;
  }
  if (IS_WINDOWS) launch.beginStartup(stateDir, 'app-ready');
  if (handoffFile) launch.signalHandoff(handoffFile, stateDir, 'claimed', 'single-instance lock acquired');

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  await app.whenReady();

  // Use Windows' real localized Downloads known-folder instead of guessing
  // that the directory is literally named "Downloads".
  if (IS_WINDOWS && !process.env.ZLAG_DOWNLOADS) {
    process.env.ZLAG_DOWNLOADS = path.join(app.getPath('downloads'), 'Z-LAG Toolbox');
  }

  // The local renderer has no reason to request camera, microphone, location,
  // notifications, MIDI, USB or serial access. Deny those capabilities at the
  // session boundary even if future UI content is compromised.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  // The window is created FIRST so the user sees the app immediately; repair
  // and release checks are background work and can never delay first paint.
  createWindow();

  try {
    const { autoUpdater } = require('electron-updater');
    updateService = createUpdater({
      app,
      autoUpdater,
      dialog,
      shell,
      getWindow: () => mainWindow,
      log,
      platform: process.platform,
      portable: launch.isPortableBuild()
    });
    updateService.init();
    updateService.scheduleCheck(12000);
  } catch (error) {
    log('update service unavailable: ' + ((error && error.message) || error));
    updateService = createUpdater({
      app, dialog, shell, getWindow: () => mainWindow, log,
      platform: process.platform, portable: launch.isPortableBuild()
    });
    updateService.init();
  }



  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

bootstrap().catch((e) => {
  const detail = String((e && e.stack) || e);
  log('FATAL bootstrap error: ' + detail);
  if (handoffFile) launch.signalHandoff(handoffFile, stateDir, 'error', detail);
  try {
    dialog.showErrorBox('Z-LAG Toolbox could not start',
      detail + '\n\nThe next launch will automatically use software rendering.\nLog: ' + mainLogPath());
  } catch (_) {}
  app.exit(1);
});

app.on('before-quit', () => {
  if (updateService) updateService.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  const detail = String((err && err.stack) || err);
  log('Uncaught exception: ' + detail);
  // An exception before a window exists must end visibly instead of leaving a
  // headless process in an unknown state.
  if (!mainWindow) {
    if (handoffFile) launch.signalHandoff(handoffFile, stateDir, 'error', detail);
    try { dialog.showErrorBox('Z-LAG Toolbox error', detail + '\n\nLog: ' + mainLogPath()); } catch (_) {}
    app.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection: ' + ((reason && reason.stack) || reason));
});
