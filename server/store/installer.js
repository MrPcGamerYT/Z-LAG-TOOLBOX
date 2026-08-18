'use strict';

/**
 * Package installer.
 *
 * Originally this was a 1:1 port of Alt App Installer's install step:
 *
 *     if uwp: Add-AppPackage "<path>"
 *     else:   Start-Process  "<path>"
 *
 * That is fine for UWP packages but it is wrong for Win32 installers, and it
 * is the reason apps installed through the toolbox "did not open":
 *
 *   1. `Start-Process` without `-Wait` returns the instant the process is
 *      SPAWNED. The job flipped to "Installation completed!" while the setup
 *      wizard was still on its first page — or while it was silently failing.
 *      Nothing was installed, so there was nothing to open.
 *   2. No exit code was ever inspected, so a setup that aborted (declined UAC,
 *      1603, corrupt payload) still reported success.
 *   3. Portable apps (Rufus) are not installers at all — the download IS the
 *      program. Launching it straight out of `…\Z-LAG-Toolbox\downloads\…`
 *      leaves it with no Start-menu entry and breaks the moment that folder is
 *      cleaned, which is exactly what produces
 *      "There's a problem with Rufus. Reinstall the application from its
 *       original install location or contact your administrator."
 *
 * The installer now waits, checks exit codes, passes the manifest's silent
 * switches, elevates on demand, and gives portable/zip apps a real home plus
 * Start-menu and desktop shortcuts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function powershellPath() {
  if (process.platform !== 'win32') return 'powershell';
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
}

/**
 * Run one PowerShell command. The command is passed as a single argv entry
 * with CREATE_NO_WINDOW (`windowsHide`); spawn() (not a shell) keeps quoting
 * intact.
 */
function runPwsh(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, timeoutMs || 1800000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, code: 1, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({
        ok: code === 0 && !timedOut,
        code: code == null ? 1 : code,
        stdout,
        stderr: timedOut ? (stderr + '\nInstaller timed out.') : stderr
      });
    });
  });
}

/** PowerShell double-quoted string — backtick escapes " ` and $. */
function psQuote(p) {
  return '"' + String(p).replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$') + '"';
}

function extOf(file) {
  return String(file.type || path.extname(file.path || file.name || ''))
    .replace(/^\./, '')
    .toLowerCase();
}

/** Decrypted Store package types — these install per-user, without admin. */
function isBundle(ext) {
  return /^(appx|msix|appxbundle|msixbundle|eappx|emsix|eappxbundle|emsixbundle)$/.test(ext);
}

/**
 * DRM-encrypted Store packages. Microsoft ships some titles only as `.eappx` /
 * `.emsix`; the bytes are sealed and Add-AppxPackage can stage them, but the
 * app cannot start without a Store licence issued to the signed-in account.
 * That is a silent "installs fine, never opens" — so we say so up front rather
 * than reporting success.
 */
function isEncrypted(ext) {
  return /^(eappx|emsix|eappxbundle|emsixbundle)$/.test(String(ext).toLowerCase());
}

/**
 * The UWP runtimes every Store app links against. If even one of these is
 * missing at the right version, the package still INSTALLS — Windows only
 * checks dependencies when the app is launched, then silently kills the
 * process because it cannot load the runtime DLLs. This is the single most
 * common reason a sideloaded Store app "does nothing" when clicked.
 */
const UWP_RUNTIME_RE =
  /^(microsoft\.vclibs|microsoft\.net\.native\.(framework|runtime)|microsoft\.ui\.xaml|microsoft\.services\.store\.engagement|microsoft\.directxruntime)/i;

function isUwpRuntime(file) {
  const n = String((file && file.name) || '');
  return UWP_RUNTIME_RE.test(n.split('_')[0]);
}

/** Archives we unpack ourselves rather than hand to a setup program. */
function isArchive(ext) {
  return /^(zip)$/.test(ext);
}

/**
 * An app that ships as a single runnable executable with no setup routine.
 * Rufus is the canonical example: rufus.exe IS the application.
 */
function isPortable(file) {
  const t = String(file.installerType || '').toLowerCase();
  return t === 'portable' || t === 'zip';
}

/**
 * Silent switches per installer technology — the same defaults WinGet applies.
 * The manifest's own `InstallerSwitches.Silent` always wins when present.
 */
const SILENT_SWITCHES = {
  inno: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'],
  nullsoft: ['/S'],
  burn: ['/quiet', '/norestart'],
  wix: ['/quiet', '/norestart'],
  msi: ['/quiet', '/norestart']
};

/**
 * Split a manifest switch string into argv entries.
 *
 * Quoted runs stay glued to their token, so `/DIR="C:\Program Files\App"`
 * survives as ONE argument instead of being torn in half at the space — which
 * would have made the installer treat "Files\App" as a separate flag.
 */
function splitSwitches(s) {
  return String(s || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

function silentArgsFor(file) {
  const sw = file.switches || {};
  const fromManifest = sw.Silent || sw.silent || sw.SilentWithProgress || sw.silentWithProgress;
  if (fromManifest) return splitSwitches(fromManifest);
  const t = String(file.installerType || extOf(file)).toLowerCase();
  return SILENT_SWITCHES[t] || [];
}

/**
 * Exit codes that mean "the install worked".
 *   0     success
 *   1641  success, installer initiated a reboot
 *   3010  success, reboot required to finish
 *   1638  this exact version is already installed
 */
function isSuccessCode(code, file) {
  if (code === 0) return true;
  if (code === 3010 || code === 1641) return true;
  if (code === 1638) return true;
  const extra = (file && file.successCodes) || [];
  return extra.indexOf(code) !== -1;
}

/** Exit codes that mean "this needed administrator rights". */
function needsElevation(code) {
  // 1625 policy-blocked, 1260 blocked by policy, 740 elevation required,
  // 5 access denied, 1603 fatal (very often an ACL failure), 3 path denied.
  return code === 1625 || code === 1260 || code === 740 || code === 5 || code === 1603;
}

function codeMeaning(code) {
  const map = {
    1602: 'the user cancelled the installation',
    1603: 'a fatal error occurred during installation (often needs admin rights)',
    1618: 'another installation is already in progress — finish it and retry',
    1619: 'the installer package could not be opened (corrupt or truncated download)',
    1620: 'the installer package could not be opened (corrupt download)',
    1625: 'system policy blocked this installation',
    1638: 'this version is already installed',
    740: 'the installer requires administrator rights',
    1: 'the installer reported a generic failure'
  };
  return map[code] || null;
}

// --------------------------------------------------------------- app folders

/** Where portable apps and unpacked archives are installed. */
function programsRoot() {
  if (process.env.ZLAG_PROGRAMS) return process.env.ZLAG_PROGRAMS;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Programs', 'Z-LAG Toolbox');
}

/**
 * Where app shortcuts go in the Start menu.
 *
 * Straight into Programs, NOT a "Z-LAG Toolbox" subfolder. Apps installed
 * through the Store are the user's apps, not accessories of this toolbox, so
 * they belong next to everything else they installed — that is also where
 * Windows' own installers put them, and where Search expects to find them.
 * Grouping them under a vendor folder made every installed app look like it
 * came from Z-LAG Toolbox and left an empty folder behind after uninstalls.
 */
function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

/**
 * The legacy per-vendor folder previous builds created. Only used to clean it
 * up; nothing is ever written here again.
 */
function legacyStartMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Z-LAG Toolbox');
}

function desktopDir() {
  return path.join(os.homedir(), 'Desktop');
}

/**
 * Where shortcuts for installed apps go.
 *
 * Desktop shortcuts are OFF by default: installing a handful of apps used to
 * carpet the desktop with icons the user never asked for. Everything lands in
 * the Start menu (searchable, tidy) instead. Set ZLAG_DESKTOP_SHORTCUTS=1 to
 * bring the old behaviour back.
 */
function shortcutDirs() {
  const dirs = [startMenuDir()];
  if (process.env.ZLAG_DESKTOP_SHORTCUTS === '1') dirs.push(desktopDir());
  return dirs;
}

/**
 * Move shortcuts out of the old "Programs\Z-LAG Toolbox" folder and delete it.
 *
 * Earlier builds nested every installed app in that folder. Simply changing
 * the destination would strand those shortcuts in a folder the user does not
 * want, so migrate once: move each .lnk up into Programs (never overwriting a
 * shortcut that is already there), then remove the folder if it is empty.
 *
 * Best-effort by design — a locked file or missing folder must never break an
 * install. Returns a small summary for logging and tests.
 */
function migrateLegacyStartMenuFolder() {
  const legacy = legacyStartMenuDir();
  const target = startMenuDir();
  const result = { moved: 0, skipped: 0, removed: false, folder: legacy };
  let entries;
  try { entries = fs.readdirSync(legacy, { withFileTypes: true }); }
  catch (_) { return result; }            // nothing to migrate

  for (const entry of entries) {
    if (!entry.isFile() || !/\.lnk$/i.test(entry.name)) { result.skipped++; continue; }
    const from = path.join(legacy, entry.name);
    const to = path.join(target, entry.name);
    try {
      // Never clobber a shortcut the user already has in Programs.
      if (fs.existsSync(to)) { fs.rmSync(from, { force: true }); result.skipped++; continue; }
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(from, to);
      result.moved++;
    } catch (_) { result.skipped++; }
  }

  try {
    if (!fs.readdirSync(legacy).length) {
      fs.rmdirSync(legacy);
      result.removed = true;
    }
  } catch (_) {}
  return result;
}

/**
 * Delete the duplicate UWP shortcuts earlier builds left in the Start menu.
 *
 * Those .lnk files target explorer.exe with a shell:AppsFolder argument, so
 * they sit next to the real entry Windows publishes and render with a blank
 * document icon. They are identifiable with certainty — a normal app shortcut
 * never points at explorer.exe with an AppsFolder argument — so they can be
 * removed safely.
 *
 * Reads each .lnk as bytes and looks for the marker rather than shelling out
 * to PowerShell per file: a Start menu can hold hundreds of shortcuts.
 */
function cleanupDuplicateUwpShortcuts() {
  const dir = startMenuDir();
  const result = { removed: 0, inspected: 0, folder: dir };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return result; }

  for (const entry of entries) {
    if (!entry.isFile() || !/\.lnk$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      result.inspected++;
      // .lnk stores strings as UTF-16LE; latin1 still exposes the ASCII run
      // with NUL padding, so strip NULs before matching.
      const raw = fs.readFileSync(file).toString('latin1').replace(/\0/g, '');
      if (/shell:AppsFolder/i.test(raw) && /explorer\.exe/i.test(raw)) {
        fs.rmSync(file, { force: true });
        result.removed++;
      }
    } catch (_) { /* locked or unreadable — leave it alone */ }
  }
  return result;
}

function safeFolder(name) {
  return String(name || 'App').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[.\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'App';
}

/**
 * PowerShell that creates a .lnk. WScript.Shell is present on every supported
 * Windows build and needs no elevation for per-user shortcuts.
 */
function shortcutCommand(target, linkPath, workDir) {
  return [
    '$w = New-Object -ComObject WScript.Shell;',
    '$s = $w.CreateShortcut(' + psQuote(linkPath) + ');',
    '$s.TargetPath = ' + psQuote(target) + ';',
    '$s.WorkingDirectory = ' + psQuote(workDir || path.dirname(target)) + ';',
    // Point the icon at the executable itself. Without this the shell falls
    // back to a generic document icon whenever it cannot infer one.
    '$s.IconLocation = ' + psQuote(target + ',0') + ';',
    '$s.Save();'
  ].join(' ');
}

// NOTE: there is deliberately no uwpShortcutCommand() any more. Windows
// already publishes an All-apps entry for every installed UWP package, so
// creating a second .lnk that targets explorer.exe duplicated every Store app
// in the Start menu — and the duplicate showed a blank document icon, because
// a bare "explorer.exe" TargetPath gives the shell no icon to read. UWP apps
// are launched through rec.launch (shell:AppsFolder\<family>!<appId>) instead.

function unblockCommand(filePath) {
  return 'try { Unblock-File -LiteralPath ' + psQuote(filePath) + ' -ErrorAction SilentlyContinue } catch {}';
}

// ------------------------------------------------------------- install steps

/**
 * The PowerShell command used to install one downloaded file.
 *
 * UWP package → Add-AppPackage "<path>"
 * MSI         → msiexec /i "<path>" /quiet /norestart   (waited on)
 * EXE setup   → the setup, with silent switches         (waited on)
 *
 * Portable apps and archives never reach this function — they are placed by
 * installPortable()/installArchive() instead.
 *
 * @param {object} file
 * @param {boolean} uwp
 * @param {{elevate?:boolean, interactive?:boolean}} [opts]
 */
function installCommand(file, uwp, opts) {
  opts = opts || {};
  const p = psQuote(file.path);
  const ext = extOf(file);

  if (uwp || isBundle(ext)) {
    // Revision Tool (meetrevision/revision-tool) installs every package with
    // exactly this command, dependencies first, then the app. Bundling
    // -DependencyPath made Windows reject the whole transaction when a
    // newer in-box runtime was already present — the app never landed.
    return [
      'try { Unblock-File -LiteralPath ' + p + ' -ErrorAction SilentlyContinue } catch {};',
      'try {',
      '  Add-AppxPackage -Path ' + p + ' -ForceApplicationShutdown;',
      '  exit 0',
      '} catch {',
      '  $m = [string]$_.Exception.Message;',
      '  if ($m -match "0x80073D06|0x80073CFB|0x80073D02|already installed|higher version") { exit 0 };',
      '  Write-Output $m;',
      '  exit 1',
      '}'
    ].join(' ');
  }

  const verb = opts.elevate ? ' -Verb RunAs' : '';
  const args = opts.interactive ? [] : silentArgsFor(file);

  if (ext === 'msi' || ext === 'msp') {
    const msiArgs = ['/i', file.path].concat(args.length ? args : ['/quiet', '/norestart']);
    return '$p = Start-Process -FilePath "msiexec.exe" -ArgumentList @(' +
      msiArgs.map(psQuote).join(',') + ') -Wait -PassThru' + verb + '; exit $p.ExitCode';
  }

  const argList = args.length
    ? ' -ArgumentList @(' + args.map(psQuote).join(',') + ')'
    : '';
  return '$p = Start-Process -FilePath ' + p + argList +
    ' -Wait -PassThru' + verb + '; exit $p.ExitCode';
}

/** Copy a single portable executable into place and wire up shortcuts. */
async function installPortable(file, appName) {
  const folder = path.join(programsRoot(), safeFolder(appName || file.name));
  const target = path.join(folder, path.basename(file.path));
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(file.path, target);
  await runPwsh(unblockCommand(target), 30000);

  const links = [];
  const lnkName = safeFolder(appName || path.parse(file.path).name) + '.lnk';
  for (const dir of shortcutDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const link = path.join(dir, lnkName);
      const r = await runPwsh(shortcutCommand(target, link, folder), 60000);
      if (r.ok) links.push(link);
    } catch (_) { /* a missing Desktop folder must not fail the install */ }
  }
  return { ok: true, code: 0, target, folder, links };
}

/** Unpack an archive, then point shortcuts at the most likely main exe. */
async function installArchive(file, appName) {
  const folder = path.join(programsRoot(), safeFolder(appName || file.name));
  fs.mkdirSync(folder, { recursive: true });
  const cmd = 'Expand-Archive -LiteralPath ' + psQuote(file.path) +
    ' -DestinationPath ' + psQuote(folder) + ' -Force';
  const r = await runPwsh(cmd, 600000);
  if (!r.ok) return { ok: false, code: r.code, output: r.stderr || r.stdout, folder };

  const exe = findMainExe(folder, appName);
  const links = [];
  if (exe) {
    const lnkName = safeFolder(appName || path.parse(exe).name) + '.lnk';
    for (const dir of shortcutDirs()) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const link = path.join(dir, lnkName);
        const s = await runPwsh(shortcutCommand(exe, link, path.dirname(exe)), 60000);
        if (s.ok) links.push(link);
      } catch (_) {}
    }
  }
  return { ok: true, code: 0, target: exe, folder, links };
}

/** Best-effort guess at the executable a user wants from an unpacked archive. */
function findMainExe(folder, appName) {
  const wanted = String(appName || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  let best = null;
  let bestScore = -1;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.exe$/i.test(e.name)) continue;
      const stem = e.name.replace(/\.exe$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      let score = 10 - depth;
      if (wanted && stem === wanted) score += 100;
      else if (wanted && (stem.includes(wanted) || wanted.includes(stem))) score += 50;
      if (/^(un)?install|^setup|^update|^vcredist|^crash/i.test(e.name)) score -= 80;
      if (score > bestScore) { bestScore = score; best = full; }
    }
  };
  walk(folder, 0);
  return best;
}

// ------------------------------------------------------- UWP preflight/verify

/**
 * Services a UWP app needs in order to install AND to start. On debloated or
 * "privacy-scripted" Windows builds these are routinely set to Disabled, and
 * the symptom is an app that installs cleanly and then does nothing at all:
 *
 *   AppXSVC  — AppX Deployment Service: stages and starts packaged apps
 *   ClipSVC  — Client License Service: issues the licence the app validates
 *   StateRepository — the package database the shell reads
 *   TokenBroker / wlidsvc — Store account auth, needed by licensed titles
 *
 * We repair the two that are safe to repair automatically (AppXSVC, ClipSVC
 * are demand-start by design) and report anything else we cannot fix.
 */
const UWP_SERVICES = ['AppXSvc', 'ClipSVC', 'StateRepository'];

function servicePreflightCommand() {
  // Emits one `name=starttype:status` line per service.
  return UWP_SERVICES.map((s) =>
    '$s = Get-Service -Name "' + s + '" -ErrorAction SilentlyContinue; ' +
    'if ($s) { $st = (Get-CimInstance Win32_Service -Filter "Name=\'' + s + '\'").StartMode; ' +
    'Write-Output ("' + s + '=" + $st + ":" + $s.Status) } ' +
    'else { Write-Output "' + s + '=absent:absent" };'
  ).join(' ');
}

function parseServiceReport(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z]+)=([^:]+):(.+)$/);
    if (!m) continue;
    const startMode = m[2].trim().toLowerCase();
    out.push({
      name: m[1],
      startMode,
      status: m[3].trim().toLowerCase(),
      disabled: startMode === 'disabled'
    });
  }
  return out;
}

/** Re-enable a disabled UWP service (demand start — Windows' own default). */
function repairServiceCommand(name) {
  return 'sc.exe config ' + name + ' start= demand; sc.exe start ' + name + ' 2>$null; exit 0';
}

/**
 * Sideloading / Developer Mode gate. Packages that are not installed by the
 * Store client itself are blocked when AllowAllTrustedApps is 0, which again
 * looks like "it installed but won't run" to the user.
 */
function sideloadCheckCommand() {
  const k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock';
  return '$v = Get-ItemProperty -Path "' + k + '" -ErrorAction SilentlyContinue; ' +
    'Write-Output ("sideload=" + $(if ($v -and $v.AllowAllTrustedApps -ne $null) ' +
    '{ $v.AllowAllTrustedApps } else { "unset" })); ' +
    'Write-Output ("devmode=" + $(if ($v -and $v.AllowDevelopmentWithoutDevLicense -ne $null) ' +
    '{ $v.AllowDevelopmentWithoutDevLicense } else { "unset" }));';
}

/**
 * After a UWP install, ask Windows whether the package is actually in a
 * runnable state. `Status` is "Ok" only when every dependency resolved; a
 * staged-but-broken package reports a modified/tampered status and its
 * Dependencies list is what tells us which runtime is missing.
 */
function verifyUwpCommand(familyOrName) {
  // CAREFUL: `Get-AppxPackage <x>` binds to -Name, and Name is the family
  // WITHOUT the publisher hash — "SpotifyAB.SpotifyMusic", not
  // "SpotifyAB.SpotifyMusic_zpdnekdrzrea0". Passing a PackageFamilyName here
  // matches nothing, so we split it and confirm the family afterwards.
  return [
    '$fam = ' + psQuote(familyOrName) + ';',
    '$name = $fam.Split("_")[0];',
    'try {',
    '  $all = @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue);',
    '  $p = $all | Where-Object { $_.PackageFamilyName -eq $fam } | Select-Object -First 1;',
    '  if (-not $p) { $p = $all | Select-Object -First 1 };',
    '  if (-not $p) { Write-Output "state=absent"; exit 0 };',
    '  Write-Output ("state=" + $p.Status);',
    '  Write-Output ("full=" + $p.PackageFullName);',
    '  Write-Output ("installloc=" + $p.InstallLocation);',
    '  foreach ($d in $p.Dependencies) {',
    '    Write-Output ("dep=" + $d.Name + "|" + $d.Version + "|" + $d.Status) };',
    '  $m = Get-AppxPackageManifest $p.PackageFullName;',
    '  $id = $m.Package.Applications.Application.Id | Select-Object -First 1;',
    '  if ($id) { Write-Output ("appid=" + $p.PackageFamilyName + "!" + $id) };',
    '  exit 0',
    '} catch {',
    // Never let a verification hiccup fail an install that actually worked.
    '  Write-Output "state=unknown"; exit 0',
    '}'
  ].join(' ');
}

/**
 * Wire launch for a UWP app.
 *
 * We deliberately do NOT create a Start-menu .lnk here. Windows registers an
 * All-apps entry for every UWP package at install time (unless its manifest
 * opts out with AppListEntry="none"), so writing our own produced TWO entries
 * per app: the real one with the app's icon, and ours showing a blank
 * document icon because a bare "explorer.exe" TargetPath does not resolve to
 * an icon source.
 *
 * `rec.launch` still carries shell:AppsFolder\<family>!<appId>, which is what
 * the in-app Launch button uses — that path never needed a shortcut file.
 */
async function attachUwpLaunch(rec, info, appName) {
  rec.appId = info.appId || null;
  rec.launch = info.appId ? 'shell:AppsFolder\\' + info.appId : null;
  rec.installFolder = startMenuDir();
  // Windows owns the Start-menu entry for UWP packages; nothing to add.
  rec.shortcuts = rec.shortcuts || [];
}

function parseUwpVerify(stdout) {
  const info = { state: null, full: null, installLocation: null, appId: null, deps: [] };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq);
    const val = t.slice(eq + 1).trim();
    if (key === 'state') info.state = val;
    else if (key === 'full') info.full = val;
    else if (key === 'installloc') info.installLocation = val;
    else if (key === 'appid') info.appId = val;
    else if (key === 'dep') {
      const [name, version, status] = val.split('|');
      info.deps.push({ name, version, status: status || '' });
    }
  }
  info.ok = /^ok$/i.test(info.state || '');
  // We could not read the state (query error, locked package DB). Not proof
  // of anything — must never be treated as a failed install.
  info.inconclusive = !info.state || /^unknown$/i.test(info.state);
  info.brokenDeps = info.deps.filter((d) => d.status && !/^ok$/i.test(d.status));
  return info;
}

// ------------------------------------------------------------------- the run

/**
 * Install the downloaded packages, dependencies first.
 *
 * @param {Array} files    entries with {name, kind:'app'|'dep', path, type, …}
 * @param {boolean} uwp    true when this came from the FE3 / UWP pipeline
 * @param {(file)=>void} [onItem] progress callback per file
 * @param {{appName?:string}} [opts]
 */
async function installPackages(files, uwp, onItem, opts) {
  opts = opts || {};
  const appName = opts.appName || '';
  const ordered = files.slice().sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === 'dep' ? -1 : 1;
  });

  const results = [];
  const notes = [];
  let services = [];
  let sideload = null;

  // ---- UWP preflight: services + sideloading ---------------------------
  // Done BEFORE the first Add-AppxPackage so we can repair the machine
  // instead of installing into a state where nothing can ever launch.
  const anyBundle = uwp || ordered.some((f) => isBundle(extOf(f)));
  if (anyBundle && process.platform === 'win32') {
    const svc = await runPwsh(servicePreflightCommand(), 60000);
    services = parseServiceReport(svc.stdout);
    for (const s of services.filter((x) => x.disabled)) {
      if (s.name === 'StateRepository') {
        notes.push('StateRepository is disabled — Store apps cannot run until it is re-enabled.');
        continue;
      }
      const fix = await runPwsh(repairServiceCommand(s.name), 60000);
      s.repaired = fix.code === 0;
      notes.push(s.repaired
        ? s.name + ' was disabled and has been re-enabled (this blocks Store apps from starting).'
        : s.name + ' is disabled and could not be re-enabled — run the toolbox as administrator.');
    }
    const sl = await runPwsh(sideloadCheckCommand(), 30000);
    const m = /sideload=(\S+)/.exec(sl.stdout || '');
    sideload = m ? m[1] : 'unset';

    // IMPORTANT: "unset" is the DEFAULT on every retail Windows 10/11 —
    // sideloading is already allowed there. The old code treated unset as
    // broken, silently wrote the key and then reported "Sideloading was
    // enabled…" on literally every single install, which is the spurious
    // warning users kept seeing. Only an explicit 0 actually blocks anything.
    if (sideload === '0') {
      const en = await runPwsh(
        'try { $k = \"HKLM:\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\AppModelUnlock\"; ' +
        'New-Item -Path $k -Force | Out-Null; ' +
        'New-ItemProperty -Path $k -Name AllowAllTrustedApps -Value 1 -PropertyType DWord -Force | Out-Null; exit 0 } catch { exit 1 }',
        30000);
      if (en.ok) {
        sideload = '1';
        notes.push('Sideloading was blocked on this PC and has been enabled, ' +
          'so Store packages can start outside the Microsoft Store.');
      } else {
        notes.push('Sideloading is disabled by policy (AllowAllTrustedApps=0) and could not ' +
          'be changed. Enable Developer Mode in Settings → Privacy & security → For developers.');
      }
    }
  }

  for (const f of ordered) {
    if (onItem) onItem(f);
    const ext = extOf(f);
    const bundle = uwp || isBundle(ext);

    // Revision Tool skips Advertising.XAML — it is not needed to launch apps
    // and often fails on debloated / LTSC images.
    if (/microsoft\.advertising\.xaml/i.test(String(f.name || ''))) {
      results.push({
        name: f.name, kind: f.kind, path: f.path, ok: true, code: 0,
        command: '(skipped Advertising.XAML)',
        output: '', method: 'Skip'
      });
      continue;
    }

    // ---- portable app: place it, don't "run" it -----------------------
    if (!bundle && f.kind === 'app' && (isPortable(f) || isArchive(ext))) {
      let r;
      try {
        r = isArchive(ext)
          ? await installArchive(f, appName || path.parse(f.name).name)
          : await installPortable(f, appName || path.parse(f.name).name);
      } catch (e) {
        r = { ok: false, code: 1, output: String(e && e.message) };
      }
      results.push({
        name: f.name,
        kind: f.kind,
        path: f.path,
        ok: !!r.ok,
        code: r.code || 0,
        command: isArchive(ext) ? 'Expand-Archive' : 'Copy-Item',
        output: String(r.output || '').slice(0, 800),
        method: isArchive(ext) ? 'Unpack archive' : 'Portable app',
        installPath: r.target || null,
        installFolder: r.folder || null,
        shortcuts: r.links || [],
        launch: r.target || null
      });
      continue;
    }

    // ---- normal installer ---------------------------------------------
    if (f.path && !bundle) {
      await runPwsh(unblockCommand(f.path), 30000);
    }
    let cmd = installCommand(f, uwp, {});
    let r = await runPwsh(cmd, 1800000);
    let elevated = false;

    // A missing-framework error on the MAIN package: install succeeded for
    // deps that were already on the PC; retry once after a short wait so
    // AppXSVC can register them (Revision Tool's order is dep → app).
    if (bundle && f.kind === 'app' && !r.ok &&
        /dependenc|0x80073CF3|framework/i.test((r.stdout || '') + (r.stderr || ''))) {
      notes.push('Main package needed frameworks to finish registering — retrying Add-AppxPackage.');
      r = await runPwsh(cmd, 1800000);
    }

    // A silent install that failed for a permission-ish reason is retried
    // once with elevation — this is where "nothing happened" used to come
    // from, because the exit code was never looked at.
    if (!bundle && !isSuccessCode(r.code, f) && needsElevation(r.code)) {
      elevated = true;
      cmd = installCommand(f, uwp, { elevate: true });
      r = await runPwsh(cmd, 1800000);
    }

    let success = bundle ? r.ok : isSuccessCode(r.code, f);
    const meaning = success ? null : codeMeaning(r.code);
    const rec = {
      name: f.name,
      kind: f.kind,
      path: f.path,
      ok: success,
      code: r.code,
      command: cmd,
      elevated,
      rebootRequired: r.code === 3010 || r.code === 1641,
      alreadyInstalled: r.code === 1638,
      output: ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 800) ||
        (meaning ? 'Installer exit code ' + r.code + ' — ' + meaning : ''),
      method: bundle ? 'Add-AppxPackage' : (extOf(f) === 'msi' ? 'msiexec' : 'Setup')
    };

    // ---- did it actually become runnable? ------------------------------
    // "Exit code 0" only means the package was staged. Ask Windows whether
    // the package is in an Ok state and whether every dependency resolved;
    // this is what turns a silent launch failure into an actionable message.
    if (bundle && success && f.kind === 'app' && process.platform === 'win32') {
      const family = opts.packageFamily || String(f.name).split('_')[0];
      const v = await runPwsh(verifyUwpCommand(family), 120000);
      const info = parseUwpVerify(v.stdout);
      rec.verified = info;
      // Verification only ever DOWNGRADES on hard evidence. Add-AppxPackage
      // exiting 0 is strong evidence the install worked, so an inconclusive
      // or unexpected query result must not manufacture a failure — that
      // would break working installs, which is worse than the bug we fixed.
      if (info.inconclusive) {
        notes.push('Installed, but Windows could not confirm the package state. ' +
          'If the app does not start, restart Windows and try it again.');
        rec.launch = null;
        rec.installFolder = null;
      } else if (info.state === 'absent') {
        success = false;
        rec.ok = false;
        rec.output = 'Windows reports the package is not installed even though the ' +
          'installer succeeded — AppX Deployment Service may be blocked.';
      } else if (info.brokenDeps.length) {
        // The definitive silent-launch-failure signal: a named runtime that
        // did not resolve. The app WILL start and immediately close.
        success = false;
        rec.ok = false;
        rec.output = 'The package installed but these runtimes did not resolve: ' +
          info.brokenDeps.map((d) => d.name).join(', ') +
          '. The app would start and immediately close.';
      } else if (!info.ok) {
        // A non-Ok status with no broken dependency named (Modified, Staged,
        // LicenseIssue…). Suspicious, not proof — warn, keep the install.
        notes.push('Windows marks this package "' + info.state + '". It should still ' +
          'start; if it does not, restart Windows or reinstall it from the Microsoft Store.');
        await attachUwpLaunch(rec, info, appName);
      } else {
        // Launchable identity: shell:AppsFolder\<family>!<appId>
        await attachUwpLaunch(rec, info, appName);
      }
      if (isEncrypted(ext)) {
        notes.push('This title ships as a DRM-encrypted Store package. It needs a Store ' +
          'licence on the signed-in Microsoft account — if it will not start, install it ' +
          'once from the Microsoft Store app to claim the licence.');
      }
    }

    results.push(rec);
  }

  // Only a failing MAIN package is fatal; a dependency error usually just
  // means that dependency is already present on the machine.
  const mainFail = results.some((r) => r.kind === 'app' && !r.ok);
  const depFail = results.some((r) => r.kind === 'dep' && !r.ok);
  const main = results.find((r) => r.kind === 'app');
  const reboot = results.some((r) => r.rebootRequired);

  let message;
  if (mainFail) {
    const bad = results.find((r) => r.kind === 'app' && !r.ok);
    const why = (bad && bad.output) || (bad && codeMeaning(bad.code));
    message = 'Failed To Install The Application!' + (why ? ' — ' + why : '');
  } else if (depFail) {
    message = 'Installed, but a runtime dependency reported a problem. If the app does ' +
      'not start, it is usually a missing framework package.';
  } else if (reboot) {
    message = 'Installation completed — restart Windows to finish.';
  } else {
    message = 'Installation completed!';
  }

  return {
    ok: !mainFail,
    warning: !mainFail && (depFail || notes.length > 0),
    rebootRequired: reboot,
    launch: (main && main.launch) || null,
    installFolder: (main && main.installFolder) || null,
    shortcuts: (main && main.shortcuts) || [],
    appId: (main && main.appId) || null,
    verified: (main && main.verified) || null,
    services,
    sideload,
    notes,
    message,
    results
  };
}

module.exports = {
  installPackages,
  runPwsh,
  installCommand,
  isBundle,
  isEncrypted,
  isUwpRuntime,
  isPortable,
  isArchive,
  silentArgsFor,
  isSuccessCode,
  needsElevation,
  findMainExe,
  programsRoot,
  startMenuDir,
  legacyStartMenuDir,
  migrateLegacyStartMenuFolder,
  cleanupDuplicateUwpShortcuts,
  __test: {
    splitSwitches, codeMeaning, safeFolder, shortcutCommand,
    servicePreflightCommand, parseServiceReport, repairServiceCommand,
    sideloadCheckCommand, verifyUwpCommand, parseUwpVerify, UWP_SERVICES,
    unblockCommand
  }
};
