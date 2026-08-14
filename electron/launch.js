/* ============================================================================
 * Z-LAG TOOLBOX — launch hardening
 * ----------------------------------------------------------------------------
 * Everything that has to be right BEFORE a window can exist lives here.
 *
 * This module keeps startup deterministic across installed and portable
 * editions. It provides:
 *
 *   • a stable per-user data directory;
 *   • fast administrator-token detection and a two-path UAC relaunch;
 *   • the real outer executable path for portable relaunches;
 *   • a file acknowledgement proving that the elevated window became ready;
 *   • a first-paint crash marker for automatic software-rendering recovery;
 *   • conservative cleanup limited to this application's old unpack folders.
 *
 * Helpers return status objects instead of throwing wherever possible so a
 * failed repair cannot become another silent startup failure.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// --------------------------------------------------------------- utilities
function argv() {
  return process.argv.slice(1);
}

function hasFlag(name) {
  return argv().some((a) => a === name || a.startsWith(name + '='));
}

function flagValue(name) {
  const prefix = name + '=';
  const arg = argv().find((a) => String(a).startsWith(prefix));
  return arg ? String(arg).slice(prefix.length) : '';
}

/** electron-builder sets this only for the portable target. */
function isPortableBuild() {
  return !!process.env.PORTABLE_EXECUTABLE_FILE ||
    !!process.env.PORTABLE_EXECUTABLE_DIR;
}

/** Where both installed and portable builds keep stable per-user state. */
function portableStateDir() {
  const base = process.env.LOCALAPPDATA ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Z-LAG Toolbox');
}

/**
 * The stable executable the user launched. A portable build runs its real app
 * from a temporary extraction directory, so relaunching process.execPath would
 * start a throwaway inner executable. Always restart the outer portable file.
 */
function relaunchTarget() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function relaunchWorkingDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(relaunchTarget());
}

function quiet(fn, fallback) {
  try { return fn(); } catch (_) { return fallback; }
}

// -------------------------------------------------------------- elevation
/**
 * Is this process running with a high-integrity administrator token?
 *
 * Reading the integrity SID is fast and does not depend on the Server service
 * (`net session` could stall for several seconds on debloated Windows images).
 * `fltmc` remains a short fallback for unusual localized/security-policy cases.
 */
function isElevated() {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve(true);
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    execFile(whoami, ['/groups', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (!err && /S-1-16-(12288|16384|20480)\b/i.test(String(stdout || ''))) {
          return resolve(true);
        }
        execFile('fltmc.exe', [], { windowsHide: true, timeout: 4000 }, (fallbackError) => {
          resolve(!fallbackError);
        });
      });
  });
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function psArg(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Relaunch this exe elevated.
 *
 * Two independent methods, because a single one is not reliable across
 * hardened / debloated images:
 *   1. PowerShell Start-Process -Verb RunAs (works nearly everywhere)
 *   2. A tiny VBScript ShellExecute "runas" (works when PowerShell is
 *      blocked by policy — which is common on the exact OS builds this
 *      toolbox targets)
 *
 * Resolves { ok, method, error }.
 */
async function relaunchElevated(exePath, extraArgs, workDir) {
  const args = (extraArgs || []).slice();

  // ---- method 1: PowerShell -----------------------------------------
  const start = 'Start-Process -FilePath ' + psQuote(exePath) +
    ' -WorkingDirectory ' + psQuote(workDir) +
    (args.length ? ' -ArgumentList ' + psQuote(args.map(psArg).join(' ')) : '') +
    ' -Verb RunAs -ErrorAction Stop';
  const ps = 'try { ' + start +
    " } catch { if ($_.Exception.NativeErrorCode -eq 1223 -or ($_.Exception.HResult -band 0xffff) -eq 1223) { Write-Error 'ZLAG_UAC_CANCELLED' } " +
    "else { Write-Error $_ }; exit 1 }";
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');

  const viaPowershell = await new Promise((resolve) => {
    execFile(powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true, timeout: 120000 },
      (err, _stdout, stderr) => resolve(err
        ? { ok: false, error: (err.message || '') + ' ' + String(stderr || '') }
        : { ok: true }));
  });
  if (viaPowershell.ok) return { ok: true, method: 'powershell' };

  // A non-zero exit here is usually the user clicking "No" on the UAC prompt.
  if (/ZLAG_UAC_CANCELLED|canceled|cancelled|1223/i.test(viaPowershell.error || '')) {
    return { ok: false, cancelled: true, error: 'Elevation was declined' };
  }

  // ---- method 2: VBScript ShellExecute --------------------------------
  const vbs = [
    'Set sh = CreateObject("Shell.Application")',
    'sh.ShellExecute ' + JSON.stringify(exePath) + ', ' +
      JSON.stringify(args.map(psArg).join(' ')) + ', ' +
      JSON.stringify(workDir) + ', "runas", 1'
  ].join('\r\n');
  const vbsPath = path.join(os.tmpdir(),
    'zlag-elevate-' + process.pid + '-' + Date.now() + '.vbs');

  const viaVbs = await new Promise((resolve) => {
    try { fs.writeFileSync(vbsPath, vbs, 'utf8'); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe'),
      ['//nologo', '//B', vbsPath],
      { windowsHide: true, timeout: 120000 },
      (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
  quiet(() => fs.unlinkSync(vbsPath));
  if (viaVbs.ok) return { ok: true, method: 'vbscript' };

  return {
    ok: false,
    error: 'PowerShell: ' + (viaPowershell.error || '?') +
      ' | VBScript: ' + (viaVbs.error || '?')
  };
}

// ------------------------------------------------------ portable unpack dir
/**
 * The portable target self-extracts under %TEMP%. Interrupted runs can leave
 * old application trees behind. Remove only sibling directories that contain
 * this app's packaged marker; directories in use simply fail closed and are
 * left untouched.
 */
function cleanPortableLeftovers(log) {
  if (!IS_WINDOWS || !isPortableBuild()) return { ok: true, skipped: true };
  const here = path.dirname(process.execPath);           // …\Temp\<unpack>\
  const parent = path.dirname(here);
  let removed = 0;
  quiet(() => {
    for (const name of fs.readdirSync(parent)) {
      if (!/^[0-9A-Fa-f-]{8,}$/.test(name) && !/^zlag/i.test(name)) continue;
      const dir = path.join(parent, name);
      if (path.resolve(dir) === path.resolve(here)) continue;   // never ourselves
      quiet(() => {
        const st = fs.statSync(dir);
        if (!st.isDirectory()) return;
        // Only touch directories that look like OUR unpack leftovers.
        const marker = path.join(dir, 'resources', 'app.asar');
        const alt = path.join(dir, 'Z-LAG Toolbox.exe');
        if (!fs.existsSync(marker) && !fs.existsSync(alt)) return;
        // A directory still in use cannot be removed — rmSync just fails and
        // we move on, which is exactly the behaviour we want.
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      });
    }
  });
  if (removed && log) log('cleaned ' + removed + ' stale portable unpack folder(s)');
  return { ok: true, removed };
}

/**
 * Verify the per-user state directory is usable and writable. A read-only or
 * missing state dir is the other half of the silent-first-launch failures,
 * because Electron aborts when it cannot create userData.
 */
function ensureStateDir(dir, log) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    return { ok: true, dir };
  } catch (e) {
    if (log) log('state dir unusable (' + dir + '): ' + e.message);
    // Fall back to a location that is writable on any Windows install.
    const fallback = path.join(os.tmpdir(), 'Z-LAG Toolbox');
    try {
      fs.mkdirSync(fallback, { recursive: true });
      const probe = path.join(fallback, '.write-probe');
      fs.writeFileSync(probe, String(Date.now()));
      fs.unlinkSync(probe);
      return { ok: true, dir: fallback, fellBack: true };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }
}

// ------------------------------------------------------- startup crash guard
function startupStatePath(stateDir) {
  return path.join(stateDir || portableStateDir(), 'startup-state.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch (_) { return false; }
}

/**
 * If the previous process reached bootstrap but never painted a healthy window,
 * start this attempt with software rendering. This turns a GPU/driver startup
 * crash into one slower launch instead of an endless black-window loop.
 */
function previousStartupFailed(stateDir, maxAgeMs) {
  const previous = readJson(startupStatePath(stateDir));
  if (!previous || previous.healthy !== false) return false;
  const age = Date.now() - Number(previous.when || 0);
  return age >= 0 && age < (maxAgeMs || 7 * 24 * 60 * 60 * 1000);
}

function beginStartup(stateDir, detail) {
  return writeJsonAtomic(startupStatePath(stateDir), {
    healthy: false,
    when: Date.now(),
    pid: process.pid,
    exe: relaunchTarget(),
    detail: String(detail || 'bootstrap')
  });
}

function markStartupHealthy(stateDir, detail) {
  return writeJsonAtomic(startupStatePath(stateDir), {
    healthy: true,
    when: Date.now(),
    pid: process.pid,
    exe: relaunchTarget(),
    detail: String(detail || 'window-ready')
  });
}

// ---------------------------------------------------------- elevation handoff
function handoffDir(stateDir) {
  return path.join(stateDir || portableStateDir(), 'handoff');
}

function createHandoffPath(stateDir) {
  const dir = handoffDir(stateDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return path.join(dir, 'elevate-' + process.pid + '-' + Date.now() + '.json');
}

function safeHandoffPath(file, stateDir) {
  if (!file) return false;
  const allowed = path.resolve(handoffDir(stateDir)) + path.sep;
  const candidate = path.resolve(String(file));
  return candidate.startsWith(allowed) && path.extname(candidate).toLowerCase() === '.json';
}

function signalHandoff(file, stateDir, phase, detail) {
  if (!safeHandoffPath(file, stateDir)) return false;
  return writeJsonAtomic(path.resolve(file), {
    phase: String(phase || 'unknown'),
    detail: String(detail || '').slice(0, 500),
    pid: process.pid,
    when: Date.now()
  });
}

function waitForHandoff(file, stateDir, timeoutMs) {
  return new Promise((resolve) => {
    if (!safeHandoffPath(file, stateDir)) return resolve({ phase: 'invalid' });
    const started = Date.now();
    let last = null;
    const finish = (result) => {
      clearInterval(timer);
      try { fs.unlinkSync(file); } catch (_) {}
      resolve(result || last || { phase: 'timeout' });
    };
    const inspect = () => {
      const next = readJson(file);
      if (next) last = next;
      if (next && (next.phase === 'ready' || next.phase === 'error')) finish(next);
      else if (Date.now() - started >= (timeoutMs || 20000)) finish(last || { phase: 'timeout' });
    };
    const timer = setInterval(inspect, 150);
    inspect();
  });
}

module.exports = {
  IS_WINDOWS,
  argv,
  hasFlag,
  flagValue,
  isPortableBuild,
  portableStateDir,
  relaunchTarget,
  relaunchWorkingDir,
  isElevated,
  relaunchElevated,
  cleanPortableLeftovers,
  ensureStateDir,
  previousStartupFailed,
  beginStartup,
  markStartupHealthy,
  createHandoffPath,
  signalHandoff,
  waitForHandoff,
  _internals: { safeHandoffPath, startupStatePath, readJson, writeJsonAtomic }
};
