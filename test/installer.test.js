'use strict';

/**
 * Install-step contract.
 *
 * UWP packages deliberately DIVERGE from Alt App Installer. It runs a bare
 * `Add-AppPackage "<path>"` per file, which lets the main package succeed
 * while a runtime dependency silently failed — Windows only resolves
 * dependencies at LAUNCH time, so the app installs and then dies instantly
 * when clicked. We install the whole set as one -DependencyPath transaction.
 * Win32 installers also diverge from Alt App Installer: a
 * bare `Start-Process "<path>"` returns the moment the process is spawned, so
 * the job reported success while setup was still running (or silently
 * failing) and the user found nothing installed to open.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  installCommand, isBundle, isPortable, isArchive,
  silentArgsFor, isSuccessCode, needsElevation
} = require('../server/store/installer');

test('UWP packages install exactly like Revision Tool (Add-AppxPackage -ForceApplicationShutdown)', () => {
  const cmd = installCommand(
    { path: 'C:\\dl\\Spotify.msixbundle', type: 'msixbundle', kind: 'app' }, true);
  assert.ok(cmd.includes('Add-AppxPackage -Path "C:\\dl\\Spotify.msixbundle"'), cmd);
  assert.match(cmd, /-ForceApplicationShutdown/);
  assert.ok(!cmd.includes('-DependencyPath'), cmd);
  assert.match(cmd, /0x80073D06|already installed/);
  assert.match(cmd, /exit 1/);
});

test('UWP install never bundles -DependencyPath (Revision installs each file itself)', () => {
  const cmd = installCommand(
    { path: 'C:\\dl\\Spotify.msixbundle', type: 'msixbundle', kind: 'app' }, true,
    { dependencies: ['C:\\dl\\VCLibs.appx', 'C:\\dl\\NetNative.appx'] });
  assert.ok(!cmd.includes('-DependencyPath'), cmd);
  assert.match(cmd, /Add-AppxPackage -Path/);
});

test('appx dependencies are recognised even when uwp is unset', () => {
  const cmd = installCommand(
    { path: 'C:\\dl\\Microsoft.VCLibs.appx', type: 'appx', kind: 'dep' }, false);
  assert.ok(cmd.includes('Add-AppxPackage -Path "C:\\dl\\Microsoft.VCLibs.appx"'), cmd);
});

test('Win32 installers are WAITED on and their exit code is propagated', () => {
  const cmd = installCommand({ path: 'C:\\dl\\setup.exe', type: 'exe', kind: 'app' }, false);
  // -Wait is the whole fix: without it the job "completed" before setup did.
  assert.match(cmd, /-Wait/);
  assert.match(cmd, /-PassThru/);
  assert.match(cmd, /exit \$p\.ExitCode/);
  assert.match(cmd, /"C:\\dl\\setup\.exe"/);
});

test('MSI packages go through msiexec quietly instead of being shell-opened', () => {
  const cmd = installCommand({ path: 'C:\\dl\\app.msi', type: 'msi', kind: 'app' }, false);
  assert.match(cmd, /msiexec\.exe/);
  assert.match(cmd, /"\/i"/);
  assert.match(cmd, /"\/quiet"/);
  assert.match(cmd, /-Wait/);
  assert.match(cmd, /exit \$p\.ExitCode/);
});

test('silent switches come from the manifest, else from the installer technology', () => {
  assert.deepStrictEqual(silentArgsFor({ installerType: 'nullsoft' }), ['/S']);
  assert.deepStrictEqual(silentArgsFor({ installerType: 'burn' }), ['/quiet', '/norestart']);
  assert.ok(silentArgsFor({ installerType: 'inno' }).includes('/VERYSILENT'));
  // A manifest-provided switch always wins.
  assert.deepStrictEqual(
    silentArgsFor({ installerType: 'inno', switches: { Silent: '/qn /norestart' } }),
    ['/qn', '/norestart']);
  // Quoted arguments survive splitting.
  assert.deepStrictEqual(
    silentArgsFor({ switches: { Silent: '/DIR="C:\\Program Files\\App"' } }),
    ['/DIR="C:\\Program Files\\App"']);
  assert.deepStrictEqual(silentArgsFor({ installerType: 'exe' }), []);
});

test('a silent install is retried elevated, and only then uses RunAs', () => {
  const plain = installCommand({ path: 'C:\\dl\\s.exe', type: 'exe', kind: 'app' }, false);
  const admin = installCommand({ path: 'C:\\dl\\s.exe', type: 'exe', kind: 'app' }, false,
    { elevate: true });
  assert.ok(!/RunAs/.test(plain));
  assert.match(admin, /-Verb RunAs/);
});

test('installer exit codes are judged, not ignored', () => {
  assert.ok(isSuccessCode(0));       // success
  assert.ok(isSuccessCode(3010));    // success, reboot required
  assert.ok(isSuccessCode(1641));    // success, installer rebooting
  assert.ok(isSuccessCode(1638));    // this version already installed
  assert.ok(!isSuccessCode(1));
  assert.ok(!isSuccessCode(1602));   // user cancelled
  assert.ok(!isSuccessCode(1603));   // fatal error
  assert.ok(isSuccessCode(9009, { successCodes: [9009] }));

  assert.ok(needsElevation(740));
  assert.ok(needsElevation(1603));
  assert.ok(!needsElevation(1602));
});

test('portable apps and archives are not treated as setup programs', () => {
  // Rufus: the download IS the app. Running it from the downloads folder is
  // what produced "There's a problem with Rufus. Reinstall the application
  // from its original install location…".
  assert.ok(isPortable({ installerType: 'portable' }));
  assert.ok(isPortable({ installerType: 'zip' }));
  assert.ok(!isPortable({ installerType: 'nullsoft' }));
  assert.ok(isArchive('zip'));
  assert.ok(!isArchive('exe'));
});

test('paths containing quotes, backticks or $ are escaped for PowerShell', () => {
  const cmd = installCommand(
    { path: 'C:\\dl\\we`ird "app"$x.appx', type: 'appx', kind: 'app' }, true);
  assert.ok(cmd.includes('"C:\\dl\\we``ird `"app`"`$x.appx"'),
    'quote/backtick/$ must be backtick-escaped, got: ' + cmd);
});

test('every decrypted Store package type is recognised', () => {
  for (const ext of ['appx', 'msix', 'appxbundle', 'msixbundle',
    'eappx', 'emsix', 'eappxbundle', 'emsixbundle']) {
    assert.ok(isBundle(ext), ext + ' should be treated as a Store package');
  }
  assert.ok(!isBundle('exe'));
  assert.ok(!isBundle('msi'));
});

// ============================================================================
// Filename / extension mapping — the root cause of "the installed app does
// not open".
//
// storeedgefd returns InstallerType as a *technology* name. The old code did
// `cleanName(fileName) + '.' + InstallerType`, producing files literally named
// "rufus.portable" and "notepadplusplus.nullsoft". Windows has no association
// for those extensions, so nothing launched them and the shell reported
// "There's a problem with <app>."
// ============================================================================

const {
  __test: { installerExt, extFromUrl, fileBaseName }
} = require('../server/store/catalog');

test('every winget InstallerType maps to an extension Windows can execute', () => {
  const expected = {
    exe: 'exe', inno: 'exe', nullsoft: 'exe', burn: 'exe', portable: 'exe',
    msi: 'msi', wix: 'msi', zip: 'zip',
    msix: 'msix', appx: 'appx', msixbundle: 'msixbundle', appxbundle: 'appxbundle'
  };
  for (const [type, ext] of Object.entries(expected)) {
    assert.strictEqual(
      installerExt({ InstallerType: type, InstallerUrl: 'https://cdn.example/pkg' }),
      ext, type + ' must download as .' + ext);
  }
});

test('a technology name is never used as a file extension', () => {
  for (const bad of ['nullsoft', 'inno', 'wix', 'burn', 'portable', 'pwa', 'msstore']) {
    const ext = installerExt({ InstallerType: bad, InstallerUrl: 'https://cdn.example/setup' });
    assert.ok(!['nullsoft', 'inno', 'wix', 'burn', 'portable', 'pwa', 'msstore'].includes(ext),
      bad + ' leaked into the filename as .' + ext);
  }
});

test('an unknown installer type still yields a runnable .exe', () => {
  assert.strictEqual(installerExt({ InstallerType: 'somethingnew' }), 'exe');
  assert.strictEqual(installerExt({}), 'exe');
});

test('the real extension in the CDN url wins over the declared type', () => {
  // Rufus is declared "portable" but is served as a plain .exe.
  assert.strictEqual(installerExt({
    InstallerType: 'portable',
    InstallerUrl: 'https://github.com/pbatard/rufus/releases/download/v4.5/rufus-4.5.exe'
  }), 'exe');
  // A "portable" that is really an archive must keep .zip so we unpack it.
  assert.strictEqual(installerExt({
    InstallerType: 'portable',
    InstallerUrl: 'https://cdn.example/tool-1.2-win64.zip'
  }), 'zip');
  // Query strings and signatures must not confuse the sniffing.
  assert.strictEqual(
    extFromUrl('https://cdn.example/files/Setup.msi?P1=1730000000&P2=404&sig=abc'), 'msi');
  assert.strictEqual(extFromUrl('https://cdn.example/download?id=99'), '');
  assert.strictEqual(extFromUrl('https://cdn.example/app.unknownthing'), '');
});

test('download names keep the app identity and stay filesystem-safe', () => {
  // cleanName() would reduce these to "notepad" and "".
  assert.strictEqual(fileBaseName('Notepad++ 8.6'), 'Notepad++ 8.6');
  assert.strictEqual(fileBaseName('7-Zip 23.01'), '7-Zip 23.01');
  // Path-illegal characters are removed rather than the whole name.
  assert.ok(!/[<>:"/\\|?*]/.test(fileBaseName('My/App: "v2"')));
  // Windows silently drops trailing dots and spaces — never emit them.
  assert.ok(!/[.\s]$/.test(fileBaseName('Trailing dot.')));
  // An empty or symbol-only name still produces something usable.
  assert.ok(fileBaseName('', 'Rufus.Rufus').length > 0);
  assert.ok(fileBaseName('   ').length > 0);
});

// ------------------------------------------------------- UWP launch failures
//
// A Store app that installs and then silently closes is nearly always one of:
// a missing runtime dependency, a disabled AppX/licence service, blocked
// sideloading, or a DRM-encrypted package with no licence. These parsers are
// what turn each of those into a message the user can act on.

const {
  isEncrypted, isUwpRuntime,
  __test: {
    parseServiceReport, parseUwpVerify, sideloadCheckCommand,
    verifyUwpCommand, repairServiceCommand, UWP_SERVICES
  }
} = require('../server/store/installer');

test('DRM-encrypted Store packages are identified', () => {
  for (const e of ['eappx', 'emsix', 'eappxbundle', 'emsixbundle']) {
    assert.ok(isEncrypted(e), e + ' is encrypted');
  }
  for (const e of ['appx', 'msix', 'msixbundle', 'exe']) {
    assert.ok(!isEncrypted(e), e + ' is not encrypted');
  }
});

test('UWP runtime frameworks are recognised by package name', () => {
  const runtimes = [
    'Microsoft.VCLibs.140.00_14.0.33728.0_x64__8wekyb3d8bbwe.appx',
    'Microsoft.NET.Native.Framework.2.2_2.2.29512.0_x64__8wekyb3d8bbwe.appx',
    'Microsoft.NET.Native.Runtime.2.2_2.2.28604.0_x64__8wekyb3d8bbwe.appx',
    'Microsoft.UI.Xaml.2.8_8.2306.22001.0_x64__8wekyb3d8bbwe.appx'
  ];
  for (const n of runtimes) assert.ok(isUwpRuntime({ name: n }), n);
  assert.ok(!isUwpRuntime({ name: 'SpotifyAB.SpotifyMusic_1.260.0_neutral_~_zpd.appxbundle' }));
});

test('disabled AppX/licence services are detected from the preflight output', () => {
  const rep = parseServiceReport([
    'AppXSvc=Disabled:Stopped',
    'ClipSVC=Manual:Running',
    'StateRepository=Auto:Running'
  ].join('\r\n'));
  assert.strictEqual(rep.length, 3);
  assert.strictEqual(rep[0].name, 'AppXSvc');
  assert.strictEqual(rep[0].disabled, true);
  assert.strictEqual(rep[1].disabled, false);
  assert.strictEqual(rep[2].disabled, false);
});

test('an absent service is reported rather than crashing the preflight', () => {
  const rep = parseServiceReport('ClipSVC=absent:absent');
  assert.strictEqual(rep[0].startMode, 'absent');
  assert.strictEqual(rep[0].disabled, false);
});

test('the service repair uses demand start, matching the Windows default', () => {
  const cmd = repairServiceCommand('AppXSvc');
  assert.match(cmd, /start= demand/);
  assert.ok(UWP_SERVICES.includes('ClipSVC'));
  assert.ok(UWP_SERVICES.includes('AppXSvc'));
});

test('sideloading policy is read from AppModelUnlock', () => {
  const cmd = sideloadCheckCommand();
  assert.match(cmd, /AppModelUnlock/);
  assert.match(cmd, /AllowAllTrustedApps/);
});

test('a healthy package yields a launchable AppsFolder identity', () => {
  const info = parseUwpVerify([
    'state=Ok',
    'full=SpotifyAB.SpotifyMusic_1.260.1006.0_x64__zpdnekdrzrea0',
    'installloc=C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_1.260',
    'dep=Microsoft.VCLibs.140.00|14.0.33728.0|Ok',
    'appid=SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'
  ].join('\n'));
  assert.strictEqual(info.ok, true);
  assert.strictEqual(info.appId, 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify');
  assert.strictEqual(info.deps.length, 1);
  assert.strictEqual(info.brokenDeps.length, 0);
});

test('a package with an unresolved runtime is flagged as NOT launchable', () => {
  // This is the exact "installed fine, opens nothing" case.
  const info = parseUwpVerify([
    'state=Modified',
    'full=SpotifyAB.SpotifyMusic_1.260.1006.0_x64__zpdnekdrzrea0',
    'dep=Microsoft.VCLibs.140.00|14.0.33728.0|Ok',
    'dep=Microsoft.NET.Native.Framework.2.2|2.2.29512.0|NotInstalled'
  ].join('\n'));
  assert.strictEqual(info.ok, false);
  assert.strictEqual(info.brokenDeps.length, 1);
  assert.strictEqual(info.brokenDeps[0].name, 'Microsoft.NET.Native.Framework.2.2');
});

test('a package Windows does not know about is reported absent', () => {
  const info = parseUwpVerify('state=absent');
  assert.strictEqual(info.state, 'absent');
  assert.strictEqual(info.ok, false);
});

test('verification asks for status, dependencies and the launch id', () => {
  const cmd = verifyUwpCommand('SpotifyAB.SpotifyMusic_zpdnekdrzrea0');
  assert.match(cmd, /Get-AppxPackage/);
  assert.match(cmd, /\$p\.Dependencies/);
  assert.match(cmd, /PackageFamilyName/);
});

// --- regressions found by reading the generated PowerShell, not by testing ---

test('verification queries by NAME, since Get-AppxPackage cannot match a family', () => {
  // `Get-AppxPackage <x>` binds to -Name, and Name has no publisher hash.
  // Passing "SpotifyAB.SpotifyMusic_zpdnekdrzrea0" matches nothing, which
  // would have reported every healthy UWP install as absent/failed.
  const cmd = verifyUwpCommand('SpotifyAB.SpotifyMusic_zpdnekdrzrea0');
  assert.match(cmd, /\$fam\.Split\("_"\)\[0\]/);
  assert.match(cmd, /Get-AppxPackage -Name \$name/);
  assert.match(cmd, /PackageFamilyName -eq \$fam/);
  // A verification error must not fail an install that worked.
  assert.match(cmd, /state=unknown/);
});

test('an unreadable package state is inconclusive, never a failure', () => {
  const info = parseUwpVerify('state=unknown');
  assert.strictEqual(info.inconclusive, true);
  assert.strictEqual(info.ok, false);
  const empty = parseUwpVerify('');
  assert.strictEqual(empty.inconclusive, true);
});

test('a healthy package is not inconclusive', () => {
  const info = parseUwpVerify('state=Ok\nappid=A_b!App');
  assert.strictEqual(info.inconclusive, false);
  assert.strictEqual(info.ok, true);
});

const { __test: extra } = require('../server/store/installer');

test('UWP Start-menu shortcuts never point at WindowsApps', () => {
  const cmd = extra.uwpShortcutCommand('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'C:\\Users\\me\\App.lnk');
  assert.match(cmd, /explorer\.exe/);
  assert.match(cmd, /shell:AppsFolder/);
  assert.ok(!/WindowsApps/.test(cmd), cmd);
});

test('downloaded payloads are unblocked before they are run', () => {
  assert.match(extra.unblockCommand('C:\\dl\\app.exe'), /Unblock-File/);
});
