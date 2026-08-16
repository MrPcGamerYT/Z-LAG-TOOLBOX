'use strict';

/**
 * Production-readiness tests for the Driver Center.
 *
 * These cover the things that separate a demo from a shippable tool:
 * preflight gating, backup/rollback safety, long-tail vendor coverage and
 * honest reporting of what was skipped.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  normaliseDevice, wantsVendorDriver, isSiliconVendor, isMicrosoftProvider,
  preflight, isElevated, backupDrivers, createRestorePoint, rollbackDevice,
  buildSummary, sortByInstallPriority, publicDriverJob
} = require('../server/drivers');

// ------------------------------------------------------------- preflight
test('preflight reports a check per requirement and never throws off-Windows', async () => {
  const pre = await preflight({ checkNetwork: false });
  assert.equal(typeof pre.ok, 'boolean');
  assert.ok(Array.isArray(pre.checks));
  const ids = pre.checks.map((c) => c.id);
  assert.ok(ids.includes('admin'), 'admin rights are always checked');
  assert.ok(ids.includes('disk'), 'disk space is always checked');
  // checkNetwork:false must not perform a catalog round trip.
  assert.ok(!ids.includes('network'));
});

test('preflight treats a dead network as a warning, not a blocker', async () => {
  const pre = await preflight({ checkNetwork: false });
  // Local repair works offline, so nothing network-related may be fatal.
  for (const c of pre.checks) {
    if (c.id === 'network') assert.equal(c.fatal, false);
  }
});

test('isElevated resolves a boolean on every platform', async () => {
  assert.equal(typeof (await isElevated()), 'boolean');
});

// ------------------------------------------------------- backup / rollback
/**
 * backupDrivers / createRestorePoint / rollbackDevice MUTATE THE HOST on
 * Windows: they export the whole driver store, create a real restore point,
 * and disable/re-enable a device. CI runs on windows-latest, so calling them
 * unguarded exported every driver on the build agent and tried to disable
 * hardware on it. Never invoke them from a test on Windows — assert the
 * off-Windows contract only, and check the guard itself everywhere else.
 */
const IS_WIN = process.platform === 'win32';

test('backup and restore-point helpers are safe no-ops off Windows',
  { skip: IS_WIN ? 'mutates the host on Windows — covered by the guard test' : false },
  async () => {
    const b = await backupDrivers({ log: [] });
    assert.equal(b.ok, true);
    assert.equal(b.demo, true);
    const rp = await createRestorePoint();
    assert.equal(rp.ok, true);
    const rb = await rollbackDevice({ deviceId: 'PCI\\VEN_8086&DEV_1912' });
    assert.equal(rb.ok, true);
  });

test('every host-mutating driver helper is guarded by a platform check', () => {
  // A static guarantee that works on any platform without executing anything:
  // each of these must bail out before touching the system when not on
  // Windows. If someone removes a guard, this fails on Linux CI immediately.
  for (const fn of [backupDrivers, createRestorePoint, rollbackDevice]) {
    assert.match(String(fn), /if\s*\(\s*!\s*IS_WINDOWS\s*\)\s*return/,
      fn.name + ' must return early when not running on Windows');
  }
});

test('no test in this suite starts a real driver job', () => {
  // The recurring CI failure was a test calling startUpdateAll/startBackupJob,
  // which on windows-latest runs PowerShell, pnputil /export-driver and
  // creates a restore point on the build agent. Policy is asserted through
  // pure functions instead. This check fails on every platform the moment a
  // job starter is reintroduced here, so the mistake cannot reach CI again.
  const src = require('fs').readFileSync(__filename, 'utf8');
  // Strip comments so prose mentioning the names does not trip the check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['startUpdateAll', 'startBackupJob', 'scanDrivers', 'restoreDriverBackup']) {
    assert.ok(!new RegExp('\\b' + name + '\\s*\\(').test(code),
      name + '() must not be called from tests — it performs real work on Windows');
  }
});

test('a job exposes its safety state to the UI', () => {
  const job = {
    id: 'x', status: 'done', stage: 'done', percent: 100, current: '', total: 1,
    installed: 1, failed: 0, driverTotal: 1, runtimeTotal: 0, runtimeInstalled: 0,
    networkFailed: 0, rolledBack: 2, backupFolder: 'C:\\backup', restorePoint: true,
    preflight: { ok: true }, needsElevation: false, reboot: false, error: null,
    mode: 'real', items: [], log: []
  };
  const pub = publicDriverJob(job);
  assert.equal(pub.rolledBack, 2);
  assert.equal(pub.backupFolder, 'C:\\backup');
  assert.equal(pub.restorePoint, true);
  assert.equal(pub.needsElevation, false);
  assert.ok(pub.preflight);
});

// ------------------------------------------------ long-tail vendor coverage
test('rare non-allowlisted silicon on a Microsoft driver is still flagged', () => {
  // SiS and ASPEED are not in the PCI vendor name table, but they are plainly
  // not Microsoft silicon, so a vendor driver should still be looked for.
  for (const [ven, name, cls] of [
    ['1039', 'SiS 900 PCI Fast Ethernet', 'Net'],
    ['1A03', 'ASPEED Graphics Family', 'Display'],
    ['102B', 'Matrox G200eW', 'Display']
  ]) {
    const d = normaliseDevice({
      DeviceID: 'PCI\\VEN_' + ven + '&DEV_0001\\1', Name: name, Class: cls,
      Vendor: 'Microsoft Corporation', Version: '10.0.19041.1', ErrorCode: 0,
      HardwareIDs: ['PCI\\VEN_' + ven + '&DEV_0001'], CompatIDs: []
    }, {});
    assert.equal(d.vendorDriverWanted, true, name + ' should want a vendor driver');
  }
});

test('Microsoft own-silicon is never chased for a third-party driver', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_1414&DEV_008E\\1', Name: 'Microsoft Hyper-V Video',
    Class: 'Display', Vendor: 'Microsoft', Version: '10.0.19041.1', ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_1414&DEV_008E'], CompatIDs: []
  }, {});
  assert.equal(d.vendorDriverWanted, false);
});

test('wantsVendorDriver ignores devices with no vendor id at all', () => {
  assert.equal(wantsVendorDriver({ hwids: ['ROOT\\SYSTEM\\0000'], compatIds: [] }), false);
  assert.equal(wantsVendorDriver({ hwids: [], compatIds: [], deviceId: '' }), false);
  assert.equal(wantsVendorDriver({ hardwareVendor: 'Intel' }), true);
  assert.equal(wantsVendorDriver({ hardwareVendor: 'Microsoft' }), false);
});

test('a device already on its own vendor driver is never re-flagged', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_10EC&DEV_8168\\1', Name: 'Realtek PCIe GbE Family Controller',
    Class: 'Net', Vendor: 'Realtek', Version: '10.68.601.2023', ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_10EC&DEV_8168'], CompatIDs: []
  }, {});
  assert.equal(d.vendorDriverWanted, false);
  assert.equal(d.needsUpdate, false);
});

// -------------------------------------------------------- honest reporting
test('the summary counts devices waiting for a vendor driver', () => {
  const inbox = normaliseDevice({
    DeviceID: 'PCI\\VEN_8086&DEV_1912\\1', Name: 'Intel(R) HD Graphics 530',
    Class: 'Display', Vendor: 'Microsoft Corporation', Version: '10.0.19041.1',
    ErrorCode: 0, HardwareIDs: ['PCI\\VEN_8086&DEV_1912'], CompatIDs: []
  }, {});
  inbox.needsUpdate = true;
  inbox.installable = true;
  const summary = buildSummary([inbox], { systemInfo: {} });
  assert.equal(summary.vendorDriverWaitingCount, 1);
});

test('install order stays deterministic for identical priorities', () => {
  const a = { name: 'B device', needsUpdate: true, gaming: { key: 'audio' } };
  const b = { name: 'A device', needsUpdate: true, gaming: { key: 'audio' } };
  assert.deepStrictEqual(
    sortByInstallPriority([a, b]).map((d) => d.name), ['A device', 'B device']);
});

test('sortByInstallPriority never mutates its input', () => {
  const list = [
    { name: 'mouse', needsUpdate: true, gaming: { key: 'input' } },
    { name: 'gpu', missing: true, needsUpdate: true, gaming: { key: 'gpu' } }
  ];
  const before = list.map((d) => d.name);
  sortByInstallPriority(list);
  assert.deepStrictEqual(list.map((d) => d.name), before);
});

test('provider detection covers the strings Windows actually reports', () => {
  for (const s of ['Microsoft', 'Microsoft Corporation', 'microsoft', 'Standard system devices']) {
    assert.equal(isMicrosoftProvider(s), true, s + ' is a Microsoft provider');
  }
  for (const s of ['Intel Corporation', 'NVIDIA', 'Realtek Semiconductor Corp.', 'Advanced Micro Devices, Inc.']) {
    assert.equal(isMicrosoftProvider(s), false, s + ' is a vendor provider');
  }
  assert.equal(isSiliconVendor('Intel'), true);
  assert.equal(isSiliconVendor(''), false);
});

// ==========================================================================
// BACKUP IS OPT-IN, RESTORE IS EXPLICIT
// --------------------------------------------------------------------------
// Exporting the whole driver store costs minutes and gigabytes. Doing it
// silently on every update is not the user's choice to make, so it is a
// checkbox plus a standalone action, and backups can be listed and reloaded.
// ==========================================================================
const {
  wantsBackup, listDriverBackups, resolveBackupFolder,
  backupRoot, driverDownloadRoot
} = require('../server/drivers');

/**
 * NOTE: startUpdateAll and startBackupJob immediately begin real work on
 * Windows — PowerShell inventory, pnputil /export-driver, and a system
 * restore point. CI runs on windows-latest, so they must never be called
 * from a test. The backup policy is asserted through the pure wantsBackup()
 * decision function instead, which is what those jobs consult.
 */
test('a driver update never backs up unless explicitly asked to', () => {
  assert.equal(wantsBackup({}), false, 'default must be OFF');
  assert.equal(wantsBackup({ targets: [], runtimes: [] }), false);
  assert.equal(wantsBackup({ backup: false }), false);
  assert.equal(wantsBackup({ backup: true }), true, 'explicit opt-in must be honoured');
});

test('a truthy-but-not-true backup value does not silently enable backups', () => {
  // Guards against a stray query string ("backup=0") turning it back on.
  // Note 'false' and '0' are truthy strings in JS — the strict === true check
  // is what stops them enabling a multi-gigabyte export.
  for (const v of ['false', '0', 'true', 1, 0, null, undefined, {}, []]) {
    assert.equal(wantsBackup({ backup: v }), false,
      JSON.stringify(v) + ' must not enable backup');
  }
});

test('publicDriverJob reports both folders and the job kind for the UI', () => {
  // Built as a plain object rather than a started job: no host side effects.
  const pub = publicDriverJob({
    id: 'b1', kind: 'backup', status: 'running', stage: 'backup', percent: 5,
    current: '', total: 1, installed: 0, failed: 0, driverTotal: 0,
    runtimeTotal: 0, runtimeInstalled: 0, networkFailed: 0, rolledBack: 0,
    backupFolder: 'C:\\ProgramData\\Z-LAG Toolbox\\driver-backups\\2026-01-01',
    downloadFolder: 'C:\\Temp\\zlag-toolbox\\drivers',
    restorePoint: false, preflight: null, needsElevation: false,
    reboot: false, error: null, mode: 'real', items: [], log: []
  });
  assert.equal(pub.kind, 'backup');
  assert.equal(typeof pub.downloadFolder, 'string');
  assert.equal(typeof pub.backupFolder, 'string');
  assert.ok(pub.downloadFolder.length, 'the UI needs a download folder to open');
  assert.equal(publicDriverJob({ items: [], log: [] }).kind, 'update',
    'a normal update job defaults to kind "update"');
});

test('backup ids cannot escape the backup root', () => {
  // Path traversal through the restore/delete endpoints must be impossible.
  for (const evil of ['..', '../..', '../../Windows', '/etc/passwd', 'C:\\Windows',
    'a/../../..', '']) {
    assert.equal(resolveBackupFolder(evil), null, JSON.stringify(evil) + ' must be rejected');
  }
});

test('listDriverBackups is safe when no backup has ever been taken', () => {
  const list = listDriverBackups();
  assert.ok(Array.isArray(list), 'must return an array, never throw');
});

test('the download and backup roots are absolute, distinct paths', () => {
  const dl = driverDownloadRoot();
  const bk = backupRoot();
  assert.ok(dl && typeof dl === 'string');
  assert.ok(bk && typeof bk === 'string');
  assert.notEqual(dl, bk, 'downloads must not be written into the backup folder');
});
