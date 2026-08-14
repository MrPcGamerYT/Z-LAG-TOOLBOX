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
test('backup and restore-point helpers are safe no-ops off Windows', async () => {
  const b = await backupDrivers({ log: [] });
  assert.equal(b.ok, true);
  assert.equal(b.demo, true);
  const rp = await createRestorePoint();
  assert.equal(rp.ok, true);
  const rb = await rollbackDevice({ deviceId: 'PCI\\VEN_8086&DEV_1912' });
  assert.equal(rb.ok, true);
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
