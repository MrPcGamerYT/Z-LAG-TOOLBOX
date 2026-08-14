'use strict';

/**
 * Official Microsoft install path — the same pipeline the Store / WinGet use.
 *
 * Sideloading (download .msix + Add-AppxPackage) is what made installed apps
 * fail to open: no Store licence, no Start-menu registration, no dependency
 * restore. This module asks Windows to install the product the way Settings
 * and the Store do:
 *
 *   1. winget --source msstore   (Store product ids 9…)
 *   2. winget --source winget    (Win32 / XP… ids, or msstore refused)
 *   3. AppInstallManager WinRT   (the Store's own installer COM API)
 *
 * After a successful official install the package is licensed, registered in
 * the Start menu, and launchable via Get-StartApps — identical to clicking
 * Install in the Microsoft Store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

function powershellPath() {
  if (!IS_WINDOWS) return 'powershell';
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPwsh(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs || 180000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, code: 1, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

function psQuote(p) {
  return '"' + String(p).replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$') + '"';
}

/** Locate winget.exe — App Execution Alias is often broken on debloated PCs. */
function findWinget() {
  const home = os.homedir();
  const candidates = [
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      'Microsoft', 'WindowsApps', 'winget.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files',
      'WindowsApps', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'winget.exe'),
    'winget'
  ];
  for (const c of candidates) {
    if (c === 'winget') return c;
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'winget';
}

/**
 * WinGet argv for a Store-style install.
 * `--disable-interactivity` + accept flags = silent, licensed Store install.
 */
function wingetArgs(productId, source) {
  const args = [
    'install',
    '--id', String(productId),
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
    '--silent'
  ];
  if (source) args.push('--source', source);
  return args;
}

function isStoreProductId(id) {
  return /^9[0-9A-Z]{11}$/i.test(String(id || ''));
}

/** Exit codes WinGet treats as "the package is on the machine". */
function wingetSuccess(code) {
  // 0 = installed
  // -1978335189 (0x8A15002B) already installed
  // -1978335212 (0x8A150014) no applicable upgrade (already current)
  return code === 0 || code === -1978335189 || code === -1978335212 ||
    code === 2316633107 || code === 2316633084;
}

function parseWingetProgress(chunk) {
  const s = String(chunk || '');
  const m = s.match(/(\d{1,3})\s*%/);
  if (m) return Math.min(99, parseInt(m[1], 10));
  const mb = s.match(/([\d.]+)\s*MB\s*\/\s*([\d.]+)\s*MB/i);
  if (mb) {
    const a = parseFloat(mb[1]), b = parseFloat(mb[2]);
    if (b > 0) return Math.min(99, Math.round(a * 100 / b));
  }
  return null;
}

function runWinget(args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const exe = findWinget();
    const child = spawn(exe, args, {
      windowsHide: true,
      env: Object.assign({}, process.env, { WINGET_DISABLE_INTERACTIVITY: '1' })
    });
    if (opts.onChild) opts.onChild(child);
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, opts.timeoutMs || 2400000);
    child.stdout.on('data', (d) => {
      const s = String(d);
      stdout += s;
      if (opts.onChunk) opts.onChunk(s);
    });
    child.stderr.on('data', (d) => {
      const s = String(d);
      stderr += s;
      if (opts.onChunk) opts.onChunk(s);
    });
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, code: 1, stdout, stderr: String(err.message), missing: /ENOENT/i.test(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: wingetSuccess(code), code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

/**
 * The Store's own installer. Issues a licence and registers the package the
 * same way the Store UI does. Used when WinGet is missing or refused the id.
 */
function appInstallManagerScript(productId) {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager,Windows.ApplicationModel.Store.Preview,ContentType=WindowsRuntime] | Out-Null',
    '  $mgr = New-Object Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager',
    '  $op = $mgr.StartAppInstallAsync(' + psQuote(productId) + ', "", $false, $false)',
    '  $item = $op.GetAwaiter().GetResult()',
    '  $guard = 0',
    '  while ($item.GetCurrentStatus().InstallState -lt 7 -and $guard -lt 720) {',
    '    $st = $item.GetCurrentStatus()',
    '    $pct = [int]$st.PercentComplete',
    '    Write-Output ("PCT=" + $pct + " STATE=" + [int]$st.InstallState)',
    '    if ($st.ErrorCode -ne 0) { throw ("Store installer error 0x{0:X8}" -f $st.ErrorCode) }',
    '    Start-Sleep -Seconds 2',
    '    $guard++',
    '  }',
    '  $final = $item.GetCurrentStatus()',
    '  if ($final.InstallState -eq 7 -or $final.InstallState -eq 8) { Write-Output "STATE=DONE"; exit 0 }',
    '  throw ("Store installer finished in state " + [int]$final.InstallState)',
    '} catch {',
    '  Write-Output $_.Exception.Message',
    '  exit 1',
    '}'
  ].join('; ');
}

/**
 * After an official install, ask the shell how to launch the app.
 * Get-StartApps is what the Start menu itself uses.
 */
function discoverLaunchCommand(productId, appName, packageFamily) {
  const name = String(appName || '').replace(/"/g, '');
  const fam = String(packageFamily || '').split('_')[0];
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$apps = @(Get-StartApps)',
    '$want = ' + psQuote(name),
    '$fam = ' + psQuote(fam),
    '$hit = $null',
    'if ($fam) { $hit = $apps | Where-Object { $_.AppID -like ($fam + "*") } | Select-Object -First 1 }',
    'if (-not $hit -and $want) { $hit = $apps | Where-Object { $_.Name -eq $want } | Select-Object -First 1 }',
    'if (-not $hit -and $want) { $hit = $apps | Where-Object { $_.Name -like ("*" + $want + "*") } | Select-Object -First 1 }',
    'if ($hit) {',
    '  Write-Output ("name=" + $hit.Name)',
    '  Write-Output ("appid=" + $hit.AppID)',
    '}',
    'if ($fam) {',
    '  $p = Get-AppxPackage -Name $fam | Select-Object -First 1',
    '  if ($p) { Write-Output ("family=" + $p.PackageFamilyName); Write-Output ("state=" + $p.Status) }',
    '}'
  ].join('; ');
}

function parseDiscover(stdout) {
  const info = { name: null, appId: null, family: null, state: null };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1).trim();
    if (k === 'name') info.name = v;
    else if (k === 'appid') info.appId = v;
    else if (k === 'family') info.family = v;
    else if (k === 'state') info.state = v;
  }
  info.launch = info.appId ? 'shell:AppsFolder\\' + info.appId : null;
  return info;
}

/**
 * After a sideload, decide whether we still need a licensed Store install.
 * Sideload can stage the package and still leave it unopenable (no licence,
 * no Start-menu registration, encrypted payload).
 */
function looksEncrypted(files) {
  return (files || []).some((f) =>
    /^e(appx|msix)/i.test(String(f.type || '')) ||
    /\.e(appx|msix)(bundle)?(\b|$)/i.test(String(f.name || '')));
}

function needsLicensedFallback(inst, files) {
  if (!inst || !inst.ok) return true;
  const notes = (inst.notes || []).join(' ');
  if (/licence|license|DRM|encrypted|sideload/i.test(notes)) return true;
  if (inst.verified && /license/i.test(String(inst.verified.state || ''))) return true;
  if (looksEncrypted(files)) return true;
  if (!inst.launch) return true;
  return false;
}

async function runAppInstallManager(id, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || (() => {});
  return new Promise((resolve) => {
    const child = spawn(powershellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', appInstallManagerScript(id)],
      { windowsHide: true });
    if (opts.onChild) opts.onChild(child);
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, 2400000);
    child.stdout.on('data', (d) => {
      const s = String(d);
      stdout += s;
      const m = /PCT=(\d+)/.exec(s);
      if (m) onProgress(Math.max(10, Math.min(90, parseInt(m[1], 10))));
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, stdout, stderr: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, stdout, stderr }); });
  });
}

/**
 * Install one Store product the official way.
 * @returns {{ok:boolean, method:string, launch?:string, notes:string[], output?:string}}
 */
async function installOfficial(productId, opts) {
  opts = opts || {};
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const notes = [];
  const id = String(productId || '').trim();
  if (!id) return { ok: false, method: 'none', notes, error: 'No product id' };
  if (!IS_WINDOWS) {
    return { ok: false, method: 'none', notes, error: 'Official Store install only runs on Windows' };
  }

  // After a sideload, WinGet reports "already installed" and never issues a
  // licence. AppInstallManager is what actually licenses the package.
  if (opts.licenseRepair && isStoreProductId(id)) {
    if (opts.shouldStop && opts.shouldStop()) {
      return { ok: false, method: 'store-api', notes, error: 'Stopped By User!' };
    }
    onLog('Acquiring a Microsoft Store licence (AppInstallManager)…');
    const r = await runAppInstallManager(id, opts);
    if (r.ok) {
      const disc = await discoverLaunch(id, opts.appName, opts.packageFamily);
      onLog('Store installer API finished (licensed).');
      return {
        ok: true,
        method: 'appinstallmanager',
        launch: disc.launch,
        appId: disc.appId,
        installFolder: startMenuDir(),
        notes,
        output: (r.stdout || '').slice(-600)
      };
    }
    onLog('Store licence API unavailable: ' +
      String(r.stdout || r.stderr || '').trim().split('\n').pop() +
      ' — trying WinGet.');
  }

  const attempts = [];
  if (isStoreProductId(id)) attempts.push({ source: 'msstore', label: 'Microsoft Store (WinGet)' });
  attempts.push({ source: 'winget', label: 'WinGet catalog' });
  attempts.push({ source: null, label: 'WinGet (auto source)' });

  for (const attempt of attempts) {
    if (opts.shouldStop && opts.shouldStop()) {
      return { ok: false, method: 'winget', notes, error: 'Stopped By User!' };
    }
    onLog('Installing via ' + attempt.label + '…');
    onProgress(8);
    const r = await runWinget(wingetArgs(id, attempt.source), {
      onChild: opts.onChild,
      onChunk: (s) => {
        const pct = parseWingetProgress(s);
        if (pct != null) onProgress(Math.max(10, Math.min(90, pct)));
        const line = s.replace(/\r/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).pop();
        if (line && line.length < 160 && !/^[-\\|\/]+$/.test(line)) onLog(line);
      }
    });
    if (r.missing) {
      onLog('WinGet is not installed — trying the Store installer API.');
      break;
    }
    const blob = (r.stdout || '') + '\n' + (r.stderr || '');
    if (r.ok) {
      onProgress(92);
      const disc = await discoverLaunch(id, opts.appName, opts.packageFamily);
      onLog('Installed the official Microsoft way (' + attempt.label + ').');
      return {
        ok: true,
        method: 'winget:' + (attempt.source || 'auto'),
        launch: disc.launch,
        appId: disc.appId,
        installFolder: startMenuDir(),
        notes,
        output: blob.slice(-600)
      };
    }
    onLog(attempt.label + ' did not take this package (' +
      (blob.split('\n').map((l) => l.trim()).filter(Boolean).pop() || ('exit ' + r.code)) +
      ') — trying the next official path.');
  }

  // AppInstallManager — Store product ids only
  if (isStoreProductId(id)) {
    if (opts.shouldStop && opts.shouldStop()) {
      return { ok: false, method: 'store-api', notes, error: 'Stopped By User!' };
    }
    onLog('Installing via the Microsoft Store installer API…');
    const r = await runAppInstallManager(id, opts);
    if (r.ok) {
      const disc = await discoverLaunch(id, opts.appName, opts.packageFamily);
      onLog('Store installer API finished.');
      return {
        ok: true,
        method: 'appinstallmanager',
        launch: disc.launch,
        appId: disc.appId,
        installFolder: startMenuDir(),
        notes,
        output: (r.stdout || '').slice(-600)
      };
    }
    onLog('Store installer API unavailable: ' +
      String(r.stdout || r.stderr || '').trim().split('\n').pop());
  }

  return {
    ok: false,
    method: 'none',
    notes,
    error: 'Official Microsoft installers could not take this product'
  };
}

async function discoverLaunch(productId, appName, packageFamily) {
  const r = await runPwsh(discoverLaunchCommand(productId, appName, packageFamily), 90000);
  return parseDiscover(r.stdout);
}

function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

module.exports = {
  installOfficial,
  discoverLaunch,
  findWinget,
  wingetArgs,
  wingetSuccess,
  isStoreProductId,
  parseWingetProgress,
  parseDiscover,
  discoverLaunchCommand,
  appInstallManagerScript,
  needsLicensedFallback,
  looksEncrypted
};
