/* ============================================================================
 * Z-LAG TOOLBOX — shared API core
 * ----------------------------------------------------------------------------
 * Every feature of the toolbox lives here as a plain async function and is
 * exposed through one `dispatch(method, pathname, query, body)` entry point.
 *
 * This module has NO knowledge of HTTP. That is deliberate:
 *
 *   • electron/main.js  calls dispatch() directly over IPC  → native app,
 *     no port, no localhost, no browser.
 *   • server/server.js  wraps dispatch() in an HTTP server  → optional
 *     headless / dev mode.
 *
 * On Windows every action runs the real winget / PowerShell command.
 * On macOS / Linux actions are simulated so the UI can be explored.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const storeCatalog = require('./store/catalog');
const storeJobs = require('./store/jobs');
const driverCenter = require('./drivers');

const IS_WINDOWS = process.platform === 'win32';
const VERSION = require('../package.json').version;

// ---------------------------------------------------------------- data files
/**
 * Resolve the data directory. Works when running from source, from a pkg
 * binary, and from inside an Electron asar (electron-builder also copies
 * server/data to resources/server/data as a fallback).
 */
function dataDir() {
  const candidates = [
    path.join(__dirname, 'data'),
    process.resourcesPath ? path.join(process.resourcesPath, 'server', 'data') : null,
    path.join(path.dirname(process.execPath), 'server', 'data')
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'apps.json'))) return dir; } catch (_) {}
  }
  return candidates[0];
}

const DATA = dataDir();

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  } catch (e) {
    console.error('[core] failed to load ' + file + ': ' + e.message);
    return [];
  }
}

const APPS = loadJson('apps.json');
const TWEAKS = loadJson('tweaks.json');
const PRESETS = loadJson('presets.json');

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function ok(body) { return { status: 200, body: Object.assign({ ok: true }, body) }; }
function fail(status, error) { return { status, body: { ok: false, error } }; }

function runProcess(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: timeout || 120000,
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code == null ? 1 : err.code) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.message) || '')
      });
    });
  });
}

/** Execute WinGet without cmd.exe so catalog text can never become a command. */
function runWinget(args, timeout) {
  return runProcess('winget.exe', Array.isArray(args) ? args.map(String) : [], timeout);
}

function runPwsh(script, timeout) {
  // -EncodedCommand avoids every quoting/escaping pitfall with multi-line
  // PowerShell and registry paths containing quotes or backslashes.
  const b64 = Buffer.from(String(script), 'utf16le').toString('base64');
  const exe = IS_WINDOWS
    ? path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell';
  return runProcess(exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
    timeout);
}

async function simAction(label, ms) {
  await sleep(ms || 700);
  return {
    ok: true,
    code: 0,
    taskId: uid(),
    output: '[demo] ' + label + ' completed successfully.\n' +
      'Mode: DEMO — nothing was changed. Run Z-LAG Toolbox on Windows to apply for real.'
  };
}

// ---------------------------------------------------------------- apps
async function installApp(body) {
  const app = APPS.find((a) => a.id === body.id);
  if (!app) return fail(404, 'App not found');
  if (IS_WINDOWS) {
    const r = await runWinget([
      'install', '--id', app.winget, '--exact', '--accept-source-agreements',
      '--accept-package-agreements', '--silent', '--disable-interactivity'
    ], 1800000);
    return ok({ ok: r.ok, app: app.name, winget: app.winget, code: r.code, output: r.stdout || r.stderr });
  }
  const r = await simAction("Install '" + app.name + "' (winget install " + app.winget + ')');
  return ok(Object.assign({ app: app.name, winget: app.winget }, r));
}

async function uninstallApp(body) {
  const app = APPS.find((a) => a.id === body.id);
  if (!app) return fail(404, 'App not found');
  if (IS_WINDOWS) {
    const r = await runWinget([
      'uninstall', '--id', app.winget, '--exact', '--silent', '--disable-interactivity'
    ], 600000);
    return ok({ ok: r.ok, app: app.name, code: r.code, output: r.stdout || r.stderr });
  }
  return ok(await simAction("Uninstall '" + app.name + "'"));
}

async function upgradeAllApps() {
  if (IS_WINDOWS) {
    const r = await runWinget([
      'upgrade', '--all', '--accept-source-agreements', '--accept-package-agreements',
      '--silent', '--disable-interactivity'
    ], 3600000);
    return ok({ ok: r.ok, mode: 'real', code: r.code, output: r.stdout || r.stderr });
  }
  return ok(Object.assign({ mode: 'demo' }, await simAction('Upgrade all apps (winget upgrade --all)', 1200)));
}

function parseWingetSearch(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let start = lines.findIndex((l) => /\bId\b.*\bName\b|\bName\b.*\bId\b/.test(l));
  if (start === -1) start = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s{2,}/).filter(Boolean);
    if (parts.length < 2) continue;
    const id = parts[0];
    if (/^-+$/.test(id) || id.includes('|')) continue;
    out.push({ id, name: parts[1], winget: id, version: parts[parts.length - 1], publisher: '' });
    if (out.length >= 25) break;
  }
  return out;
}

// ---------------------------------------------------------------- drivers
/**
 * The scanner, the Windows Update driver search and the bulk installer all
 * live in server/drivers.js. core.js only routes to them.
 */
async function scanDrivers() {
  return driverCenter.scanDrivers();
}

// ---------------------------------------------------------------- tweaks
/**
 * Tweaks are applied *directly* — the toolbox never writes a .ps1/.bat for the
 * user to run. Each tweak's `script` is piped straight into PowerShell through
 * -EncodedCommand, and `revert` (when present) undoes it.
 *
 * Every tweak that touches the shell needs Explorer restarted before the
 * change is visible, so per the product spec we restart Explorer after each
 * one. Restarting Explorer 40 times during a preset would be unusable, so a
 * batch coalesces it into a single restart at the end — the user-visible
 * result ("Explorer restarted, tweak is live") is identical.
 */

/** Kill + relaunch explorer.exe, preserving the desktop. */
const EXPLORER_RESTART = [
  '$ErrorActionPreference =' + "'SilentlyContinue'",
  'Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force',
  'Start-Sleep -Milliseconds 700',
  "if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {",
  "  Start-Process ([System.IO.Path]::Combine($env:SystemRoot,'explorer.exe'))",
  '}',
  "Write-Output 'explorer-restarted'"
].join('\n');

/** Broadcast WM_SETTINGCHANGE so live windows pick up the change too. */
const SETTINGS_BROADCAST = `
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
public class ZlagBroadcast {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam,
    string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
"@
$r = [UIntPtr]::Zero
[ZlagBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 1000, [ref]$r) | Out-Null
[ZlagBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Policy", 2, 1000, [ref]$r) | Out-Null
`;

let explorerRestarts = 0;

/** Restart Explorer. Returns a short status string for the activity log. */
async function restartExplorer() {
  if (!IS_WINDOWS) {
    await sleep(250);
    return { ok: true, restarted: false, message: '[demo] Explorer would restart here' };
  }
  const r = await runPwsh(SETTINGS_BROADCAST + '\n' + EXPLORER_RESTART, 60000);
  explorerRestarts++;
  return {
    ok: r.ok,
    restarted: r.ok,
    message: r.ok ? 'Explorer restarted' : ('Explorer restart failed: ' + (r.stderr || '').slice(0, 160))
  };
}

/**
 * Run one tweak body (apply or revert) and return a normalised result.
 * `restart` controls whether Explorer is bounced afterwards.
 */
async function runTweakBody(tw, mode, restart) {
  const script = mode === 'revert' ? (tw.revert || '') : tw.script;
  if (mode === 'revert' && !script) {
    return { id: tw.id, tweak: tw.name, ok: false, skipped: true, output: 'This tweak has no automatic revert.' };
  }

  if (!IS_WINDOWS) {
    await sleep(220);
    const res = {
      id: tw.id, tweak: tw.name, ok: true, mode: 'demo',
      output: '[demo] ' + (mode === 'revert' ? 'reverted' : 'applied') + ' — ' + tw.name
    };
    if (restart) {
      const ex = await restartExplorer();
      res.explorer = ex.message;
    }
    return res;
  }

  const wrapped = [
    '$ErrorActionPreference = ' + "'Continue'",
    '$ProgressPreference = ' + "'SilentlyContinue'",
    script
  ].join('\n');
  const r = await runPwsh(wrapped, 300000);
  const res = {
    id: tw.id,
    tweak: tw.name,
    ok: r.ok,
    mode: 'real',
    code: r.code,
    output: (r.stdout || r.stderr || '').trim().slice(0, 400)
  };
  if (restart) {
    const ex = await restartExplorer();
    res.explorer = ex.message;
  }
  return res;
}

async function applyTweak(body) {
  const tw = TWEAKS.find((t) => t.id === body.id);
  if (!tw) return fail(404, 'Tweak not found');
  const mode = body.mode === 'revert' ? 'revert' : 'apply';
  // Single tweak → always restart Explorer right after, as specified.
  const res = await runTweakBody(tw, mode, body.restartExplorer !== false);
  return ok({
    ok: res.ok,
    tweak: res.tweak,
    id: tw.id,
    action: mode,
    code: res.code,
    output: res.output,
    explorer: res.explorer || '',
    skipped: !!res.skipped,
    mode: res.mode || (IS_WINDOWS ? 'real' : 'demo')
  });
}

/**
 * Apply a list of tweaks. Explorer is restarted once at the end of the batch
 * instead of after each item — 40 restarts in a row would leave the desktop
 * unusable for a minute.
 */
async function applyTweakList(targets, label, mode) {
  const action = mode === 'revert' ? 'revert' : 'apply';
  const results = [];
  for (const t of targets) {
    results.push(await runTweakBody(t, action, false));
  }
  const ex = targets.length ? await restartExplorer() : { message: '' };
  const okCount = results.filter((r) => r.ok).length;
  return ok({
    mode: IS_WINDOWS ? 'real' : 'demo',
    action,
    preset: label,
    total: results.length,
    succeeded: okCount,
    failed: results.length - okCount,
    explorer: ex.message,
    results
  });
}

// ---------------------------------------------------------------- system
async function getSystemInfo() {
  if (IS_WINDOWS) {
    const script = [
      '$os = Get-CimInstance Win32_OperatingSystem;',
      '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1;',
      '$gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1;',
      '$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1);',
      '$up = 0; if ($os.LastBootUpTime) { $up = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1) }',
      '[PSCustomObject]@{',
      '  OS = $os.Caption; Version = $os.Version; Build = $os.BuildNumber;',
      '  CPU = $cpu.Name; Cores = $cpu.NumberOfCores; Threads = $cpu.NumberOfLogicalProcessors;',
      '  GPU = $gpu.Name; RAM_GB = $ram; Uptime_Days = $up',
      '} | ConvertTo-Json -Compress'
    ].join('\n');
    const r = await runPwsh(script);
    try { return Object.assign({ ok: true, mode: 'real' }, JSON.parse(r.stdout || '{}')); }
    catch (_) { return { ok: true, mode: 'real', OS: 'Windows', Version: 'n/a' }; }
  }
  await sleep(200);
  return {
    ok: true, mode: 'demo',
    OS: 'Windows 11 Pro (Demo)', Version: '10.0.22631', Build: '22631',
    CPU: 'AMD Ryzen 7 7800X3D (simulated)', Cores: 8, Threads: 16,
    GPU: 'NVIDIA GeForce RTX 4070 (simulated)', RAM_GB: 32, Uptime_Days: 3.4
  };
}

async function createRestorePoint() {
  if (IS_WINDOWS) {
    const script = [
      "Enable-ComputerRestore -Drive 'C:\\';",
      "Checkpoint-Computer -Description 'Z-LAG Toolbox' -RestorePointType MODIFY_SETTINGS"
    ].join('\n');
    const r = await runPwsh(script);
    return { ok: r.ok, mode: 'real', output: r.stdout || r.stderr };
  }
  return Object.assign({ mode: 'demo' },
    await simAction('Create system restore point (Checkpoint-Computer)', 800));
}

// ---------------------------------------------------------------- dispatch
/**
 * Single entry point shared by the Electron IPC bridge and the HTTP server.
 *
 * @param {string} method  'GET' | 'POST'
 * @param {string} pathname e.g. '/api/store/search'
 * @param {object} query    parsed query string params
 * @param {object} body     parsed JSON body
 * @returns {Promise<{status:number, body:object}>}
 */
async function dispatch(method, pathname, query, body) {
  method = String(method || 'GET').toUpperCase();
  pathname = String(pathname || '/');
  query = query || {};
  body = body || {};

  const get = (k) => (query[k] == null ? '' : String(query[k]));

  // ---- status ----
  if (method === 'GET' && pathname === '/api/status') {
    return ok({
      mode: IS_WINDOWS ? 'real' : 'demo',
      platform: process.platform,
      arch: storeCatalog.osArch(),
      app: 'Z-LAG Toolbox',
      version: VERSION,
      isDesktop: !!process.versions.electron,
      note: IS_WINDOWS
        ? 'Real mode — Universal Store method (all catalogs, all FE3 rings, licensed fallback).'
        : 'Demo mode — actions are simulated on this platform.'
    });
  }

  // ---- local catalog apps ----
  if (method === 'GET' && pathname === '/api/apps') {
    const q = get('q').toLowerCase().trim();
    const cat = get('category');
    let list = APPS;
    if (cat && cat !== 'All') list = list.filter((a) => a.category === cat);
    if (q) {
      list = list.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        a.publisher.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.tags || []).some((t) => String(t).includes(q)));
    }
    return ok({ count: list.length, apps: list });
  }
  if (method === 'GET' && pathname === '/api/apps/categories') {
    return ok({ categories: [...new Set(APPS.map((a) => a.category))] });
  }
  if (method === 'POST' && pathname === '/api/apps/install') return installApp(body);
  if (method === 'POST' && pathname === '/api/apps/uninstall') return uninstallApp(body);
  if (method === 'POST' && pathname === '/api/apps/upgrade-all') return upgradeAllApps();

  if (method === 'POST' && pathname === '/api/apps/install-live') {
    const id = body.wingetId;
    if (!id) return fail(400, 'No winget id');
    if (IS_WINDOWS) {
      const r = await runWinget([
        'install', '--id', String(id), '--exact', '--accept-source-agreements',
        '--accept-package-agreements', '--silent', '--disable-interactivity'
      ], 1800000);
      return ok({ ok: r.ok, name: body.name || id, winget: id, output: r.stdout || r.stderr });
    }
    return ok(Object.assign({ name: body.name || id, winget: id },
      await simAction("Install live package '" + (body.name || id) + "'")));
  }

  if (method === 'POST' && pathname === '/api/apps/install-bulk') {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const targets = APPS.filter((a) => ids.includes(a.id));
    if (IS_WINDOWS) {
      const results = [];
      for (const app of targets) {
        const r = await runWinget([
          'install', '--id', app.winget, '--exact', '--accept-source-agreements',
          '--accept-package-agreements', '--silent', '--disable-interactivity'
        ], 1800000);
        results.push({ app: app.name, winget: app.winget, ok: r.ok, code: r.code });
      }
      return ok({ mode: 'real', installed: results.filter((r) => r.ok).length, results });
    }
    await sleep(ids.length * 300 + 400);
    return ok({
      mode: 'demo', installed: targets.length,
      results: targets.map((a) => ({ app: a.name, winget: a.winget, ok: true, code: 0, demo: true }))
    });
  }

  if (method === 'GET' && pathname === '/api/apps/search-live') {
    const q = get('q').trim();
    if (!q) return ok({ results: [] });
    if (IS_WINDOWS) {
      const r = await runWinget([
        'search', '--query', q, '--accept-source-agreements', '--disable-interactivity'
      ]);
      return ok({ mode: 'real', results: parseWingetSearch(r.stdout || '') });
    }
    return ok({
      mode: 'demo',
      results: [{ name: q, id: q, winget: q, publisher: '(live winget search works on Windows)', version: '' }]
    });
  }

  // ---- Microsoft Store pipeline ----
  if (method === 'GET' && pathname === '/api/store/chips') {
    return ok({ chips: storeCatalog.STORE_CHIPS });
  }
  if (method === 'GET' && (pathname === '/api/store/search' || pathname === '/api/store/featured')) {
    const r = await storeCatalog.searchProducts(get('q').trim(), {
      kind: get('kind') || 'all',
      category: get('category')
    });
    return { status: 200, body: Object.assign({ mode: IS_WINDOWS ? 'real' : 'demo' }, r) };
  }
  if (method === 'GET' && pathname.startsWith('/api/store/product/')) {
    const id = pathname.split('/').pop();
    try {
      return ok({ product: await storeCatalog.fetchProduct(id) });
    } catch (e) {
      const demo = storeCatalog.demoSearch(id)[0] ||
        { productId: String(id || '').toUpperCase(), name: id, publisher: 'Microsoft Store', desc: '', icon: '' };
      return ok({ product: demo, demo: true, reason: e.message });
    }
  }
  if (method === 'POST' && pathname === '/api/store/resolve') {
    const input = body.url || body.productId || body.id;
    if (!input) return fail(400, 'Paste a Store website URL or product id');
    try {
      const resolved = await storeCatalog.resolveFromStore(input, {
        ignoreVer: !!body.ignoreVer, allDeps: !!body.allDeps
      });
      return ok({ resolved });
    } catch (e) { return fail(400, e.message); }
  }
  if (method === 'POST' && (pathname === '/api/store/install' || pathname === '/api/apps/install-store')) {
    const input = body.url || body.productId || body.id || body.wingetId;
    if (!input) return fail(400, 'No Store URL or product id');
    const job = storeJobs.startJob(input, {
      ignoreVer: !!body.ignoreVer,
      allDeps: !!body.allDeps,
      downloadOnly: !!body.downloadOnly
    });
    return ok({ jobId: job.id, job: storeJobs.publicJob(job) });
  }
  if (method === 'POST' && /^\/api\/store\/jobs\/[^/]+\/cancel$/.test(pathname)) {
    return { status: 200, body: { ok: storeJobs.cancelJob(pathname.split('/')[4]) } };
  }
  if (method === 'POST' && /^\/api\/store\/jobs\/[^/]+\/retry$/.test(pathname)) {
    const job = storeJobs.retryJob(pathname.split('/')[4]);
    if (!job) return fail(409, 'This install cannot be retried');
    return ok({ jobId: job.id, job: storeJobs.publicJob(job) });
  }
  if (method === 'GET' && pathname.startsWith('/api/store/jobs/')) {
    const job = storeJobs.getJob(pathname.split('/').pop());
    if (!job) return fail(404, 'Job not found');
    return ok({ job: storeJobs.publicJob(job) });
  }
  if (method === 'GET' && pathname === '/api/apps/search-store') {
    const r = await storeCatalog.searchProducts(get('q').trim(), {});
    return ok({ mode: IS_WINDOWS ? 'real' : 'demo', source: r.source, results: r.results });
  }

  // ---- drivers ----
  // The Driver Center is a scanner: scan first, then act on what was found.
  // There is no static vendor catalog any more.
  if (method === 'GET' && pathname === '/api/drivers') {
    const scan = await scanDrivers();
    return ok({ mode: scan.mode, scan });
  }
  if (method === 'POST' && pathname === '/api/drivers/scan') {
    return { status: 200, body: await scanDrivers() };
  }
  // Can this machine install drivers at all? The UI calls this before showing
  // the update button so a standard user is told up front, not after a
  // 400 MB download fails at the last step.
  if (method === 'GET' && pathname === '/api/drivers/preflight') {
    return ok({ preflight: await driverCenter.preflight({ checkNetwork: true }) });
  }
  // Install / update every missing or outdated driver in one background job.
  if (method === 'POST' && pathname === '/api/drivers/update-all') {
    const job = driverCenter.startUpdateAll({
      onlyMissing: !!body.onlyMissing,
      // Callers may opt out of the backup, but it is on by default.
      backup: body.backup !== false,
      // Explicit device selection from the UI ("install just this one").
      targets: Array.isArray(body.targets) ? body.targets : undefined,
      runtimes: Array.isArray(body.runtimes) ? body.runtimes : undefined
    });
    return ok({ jobId: job.id, job: driverCenter.publicDriverJob(job) });
  }
  if (method === 'POST' && /^\/api\/drivers\/jobs\/[^/]+\/cancel$/.test(pathname)) {
    return { status: 200, body: { ok: driverCenter.cancelDriverJob(pathname.split('/')[4]) } };
  }
  if (method === 'POST' && /^\/api\/drivers\/jobs\/[^/]+\/retry$/.test(pathname)) {
    const job = driverCenter.retryDriverJob(pathname.split('/')[4]);
    if (!job) return fail(409, 'This driver job cannot be retried');
    return ok({ jobId: job.id, job: driverCenter.publicDriverJob(job) });
  }
  if (method === 'GET' && pathname.startsWith('/api/drivers/jobs/')) {
    const job = driverCenter.getDriverJob(pathname.split('/').pop());
    if (!job) return fail(404, 'Driver job not found');
    return ok({ job: driverCenter.publicDriverJob(job) });
  }

  // ---- tweaks ----
  if (method === 'GET' && pathname === '/api/tweaks') {
    const section = query && query.section;
    const list = section ? TWEAKS.filter((t) => t.section === section) : TWEAKS;
    return ok({ tweaks: list, total: TWEAKS.length, explorerRestarts });
  }
  if (method === 'GET' && pathname === '/api/tweaks/presets') return ok({ presets: PRESETS });
  if (method === 'POST' && pathname === '/api/tweaks/apply') return applyTweak(body);
  if (method === 'POST' && pathname === '/api/tweaks/revert') {
    return applyTweak(Object.assign({}, body, { mode: 'revert' }));
  }
  if (method === 'POST' && pathname === '/api/tweaks/apply-preset') {
    const preset = PRESETS.find((p) => p.id === body.id);
    if (!preset) return fail(404, 'Preset not found');
    const targets = preset.tweakIds
      .map((id) => TWEAKS.find((t) => t.id === id))
      .filter(Boolean);
    return applyTweakList(targets, preset.name, body.mode);
  }
  if (method === 'POST' && pathname === '/api/tweaks/apply-all') {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    // Preserve the order the user selected them in.
    const targets = ids.map((id) => TWEAKS.find((t) => t.id === id)).filter(Boolean);
    if (!targets.length) return fail(400, 'No tweaks selected');
    const label = body.mode === 'revert' ? 'Revert selection' : 'Selected tweaks';
    return applyTweakList(targets, label, body.mode);
  }
  if (method === 'POST' && pathname === '/api/tweaks/restart-explorer') {
    const r = await restartExplorer();
    return ok({ ok: r.ok, message: r.message });
  }

  // ---- system ----
  if (method === 'GET' && pathname === '/api/system') {
    return { status: 200, body: await getSystemInfo() };
  }
  if (method === 'POST' && pathname === '/api/restorepoint') {
    return { status: 200, body: await createRestorePoint() };
  }


  return fail(404, 'Unknown endpoint: ' + method + ' ' + pathname);
}

module.exports = {
  dispatch,
  IS_WINDOWS,
  VERSION,
  APPS, TWEAKS, PRESETS,
  runPwsh, runWinget, runProcess,
  downloadsRoot: storeJobs.downloadsRoot
};
