'use strict';

/**
 * Regression tests for the reported Driver Center bugs:
 *
 *   • a permanent "HTREE\ROOT\0 · Unknown · Other · No driver installed" row
 *     that no install could ever clear
 *   • "Not game ready — a critical driver is missing or generic · 4 problems"
 *     on a machine whose drivers were all fine
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  isPseudoDevice, isInstallable, normaliseDevice, gamingRole, gamingReport,
  vendorFromHardwareIds, graphicsIdentity, gamingRuntimesFromSystem,
  isNewerDriverOffer, buildSummary, isDriverNetworkFailure, driverUpdateIsActive
} = require('../server/drivers');

// ---------------------------------------------------------------- pseudo
test('HTREE\\ROOT\\0 is recognised as a pseudo device', () => {
  assert.equal(isPseudoDevice({ deviceId: 'HTREE\\ROOT\\0', name: 'HTREE\\ROOT\\0' }), true);
});

test('software / bookkeeping nodes are pseudo devices', () => {
  const nodes = [
    { deviceId: 'SWD\\MMDEVAPI\\{0.0.0}', name: 'Speakers' },
    { deviceId: 'STORAGE\\VOLUME\\{abc}', name: 'Generic volume' },
    { deviceId: 'ROOT\\COMPOSITEBUS\\0000', name: 'Composite Bus Enumerator' },
    { deviceId: 'ROOT\\UMBUS\\0000', name: 'UMBus Root Bus Enumerator' },
    { deviceId: 'DISPLAY\\ACR0123\\4&x', name: 'Generic PnP Monitor' },
    { deviceId: 'SW\\{eeab7790}', name: 'Microsoft GS Wavetable Synth' }
  ];
  for (const n of nodes) {
    assert.equal(isPseudoDevice(n), true, n.deviceId + ' should be pseudo');
  }
});

test('real hardware is never treated as a pseudo device', () => {
  const real = [
    { deviceId: 'PCI\\VEN_10DE&DEV_2704&SUBSYS_1', name: 'NVIDIA GeForce RTX 4080' },
    { deviceId: 'USB\\VID_046D&PID_C08B', name: 'Logitech G502 HERO' },
    { deviceId: 'HDAUDIO\\FUNC_01&VEN_10EC', name: 'Realtek(R) Audio' }
  ];
  for (const d of real) {
    assert.equal(isPseudoDevice(d), false, d.deviceId + ' must not be pseudo');
  }
});

// ------------------------------------------------------------ normalise
test('HTREE\\ROOT\\0 is never reported as a missing driver', () => {
  const d = normaliseDevice({
    DeviceID: 'HTREE\\ROOT\\0',
    Name: 'HTREE\\ROOT\\0',
    Class: null, Vendor: null, Version: null,
    ErrorCode: 0, HardwareIDs: [], CompatIDs: []
  });
  assert.equal(d.pseudo, true);
  assert.equal(d.missing, false, 'the device-tree root has no driver to miss');
  assert.equal(d.needsUpdate, false);
});

test('a real driverless PCI device IS reported as missing and installable', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_8086&DEV_1234\\3&11',
    Name: 'Base System Device',
    Class: 'Unknown', Vendor: 'Unknown', Version: null,
    ErrorCode: 28,
    HardwareIDs: ['PCI\\VEN_8086&DEV_1234&SUBSYS_00000000'],
    CompatIDs: []
  });
  assert.equal(d.missing, true);
  assert.equal(d.installable, true);
  assert.equal(d.status, 'missing');
});

test('a driverless device with no hardware ID is flagged unresolvable, not installable', () => {
  const d = normaliseDevice({
    DeviceID: 'ROOT\\MYSTERY\\0000',
    Name: 'Unknown device',
    Class: 'Other', Vendor: 'Unknown', Version: null,
    ErrorCode: 28, HardwareIDs: [], CompatIDs: []
  });
  assert.equal(d.installable, false);
  assert.equal(d.unresolvable, true);
});

test('isInstallable requires a catalog-indexable hardware ID', () => {
  const dev = (hwids) => ({
    deviceId: 'PCI\\VEN_0000&DEV_0000\\1', name: 'Some device', hwids, compatIds: []
  });
  assert.equal(isInstallable(dev(['PCI\\VEN_10DE&DEV_2704'])), true);
  assert.equal(isInstallable(dev(['USB\\VID_046D&PID_C08B'])), true);
  assert.equal(isInstallable(dev(['HDAUDIO\\FUNC_01&VEN_10EC'])), true);
  // ROOT\… enumerated software nodes have no catalog presence.
  assert.equal(isInstallable(dev(['ROOT\\SYSTEM\\0000'])), false);
  assert.equal(isInstallable(dev([])), false);
});

// --------------------------------------------------------------- gaming
test('a vendor-branded GPU is not called a generic Microsoft driver', () => {
  // Inbox-signed Intel graphics report DriverProviderName = Microsoft; that
  // used to be misread as "running on the basic display adapter".
  const role = gamingRole({
    name: 'Intel(R) UHD Graphics 770',
    vendor: 'Microsoft',
    class: 'Display'
  });
  assert.ok(role);
  assert.equal(role.key, 'gpu');
  assert.equal(role.generic, false);
});

test('the real Microsoft Basic Display Adapter IS generic', () => {
  const role = gamingRole({
    name: 'Microsoft Basic Display Adapter',
    vendor: 'Microsoft',
    class: 'Display'
  });
  assert.ok(role);
  assert.equal(role.generic, true);
});

test('pseudo devices get no gaming role at all', () => {
  assert.equal(gamingRole({ pseudo: true, name: 'HTREE\\ROOT\\0', class: 'Other' }), null);
});

test('absent hardware categories do not count as gaming problems', () => {
  // A laptop with only an iGPU, no discrete audio card, no NVMe vendor driver
  // and no controller plugged in must still be "game ready".
  const devices = [
    {
      name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', class: 'Display',
      version: '32.0.15.5976', missing: false, needsUpdate: false
    },
    {
      name: 'Intel(R) Wi-Fi 6E AX210', vendor: 'Intel', class: 'Net',
      version: '23.30.0.4', missing: false, needsUpdate: false
    }
  ];
  for (const d of devices) d.gaming = gamingRole(d);

  const report = gamingReport(devices);
  assert.equal(report.ready, true, report.verdict);
  assert.equal(report.problemCount, 0, 'no phantom problems: ' + report.verdict);
  assert.match(report.verdict, /Game ready/);
});

test('a genuinely missing GPU driver still blocks game readiness', () => {
  const devices = [{
    name: 'Microsoft Basic Display Adapter', vendor: 'Microsoft', class: 'Display',
    version: 'None', missing: true, needsUpdate: true
  }];
  for (const d of devices) d.gaming = gamingRole(d);

  const report = gamingReport(devices);
  assert.equal(report.ready, false);
  assert.match(report.verdict, /Not game ready/);
});

// ------------------------------------------------ false-positive regression
// The "3 problems" phantom verdict came from a handful of name-only matches
// that filed non-gaming devices under gaming categories. Each of these must
// now classify as nothing (or the *correct* category).
test('PCI Simple Communications Controller is NOT a game controller', () => {
  assert.equal(gamingRole({ name: 'PCI Simple Communications Controller', class: 'Unknown', vendor: 'Unknown' }), null);
});

test('USB host controllers are NOT game controllers', () => {
  assert.equal(gamingRole({ name: 'USB xHCI Compliant Host Controller', class: 'USB', vendor: 'Microsoft' }), null);
});

test('Bluetooth radios are NOT network adapters', () => {
  assert.equal(gamingRole({ name: 'Intel(R) Wireless Bluetooth(R)', class: 'Bluetooth', vendor: 'Intel' }), null);
});

test('a Realtek NIC stays in Network, never Audio', () => {
  const role = gamingRole({ name: 'Realtek PCIe GbE Family Controller', class: 'Net', vendor: 'Realtek' });
  assert.ok(role);
  assert.equal(role.key, 'network');
});

test('NVIDIA HDMI audio is Audio, not the GPU', () => {
  const role = gamingRole({ name: 'NVIDIA High Definition Audio', class: 'MEDIA', vendor: 'NVIDIA' });
  assert.ok(role);
  assert.equal(role.key, 'audio');
  assert.equal(role.generic, false);
});

test('virtual Wi-Fi adapters get no gaming role', () => {
  assert.equal(gamingRole({ name: 'Microsoft Wi-Fi Direct Virtual Adapter #2', class: 'Net', vendor: 'Microsoft' }), null);
});

test('the inbox NVMe and HD Audio fallbacks still count as generic', () => {
  const nvme = gamingRole({ name: 'Standard NVM Express Controller', class: 'SCSIAdapter', vendor: 'Microsoft' });
  assert.equal(nvme.key, 'storage');
  assert.equal(nvme.generic, true);

  const hda = gamingRole({ name: 'High Definition Audio Device', class: 'MEDIA', vendor: 'Microsoft' });
  assert.equal(hda.key, 'audio');
  assert.equal(hda.generic, true);
});

// ------------------------------------------------ GPU recovery regression
test('PCI vendor ids recover the physical GPU vendor behind Basic Display Adapter', () => {
  assert.equal(vendorFromHardwareIds(['PCI\\VEN_10DE&DEV_2704']), 'NVIDIA');
  assert.equal(vendorFromHardwareIds(['PCI\\VEN_1002&DEV_744C']), 'AMD');
  assert.equal(vendorFromHardwareIds(['PCI\\VEN_8086&DEV_46A6']), 'Intel');
});

test('Microsoft Basic Display Adapter is actionable when its GPU hardware id exists', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_10DE&DEV_2704\\4&123',
    Name: 'Microsoft Basic Display Adapter',
    Class: 'Display', Vendor: 'Microsoft', Manufacturer: 'Microsoft',
    Version: '10.0.22621.1', ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_10DE&DEV_2704&SUBSYS_00000000'], CompatIDs: []
  });
  assert.equal(d.pseudo, false);
  assert.equal(d.hardwareVendor, 'NVIDIA');
  assert.equal(d.genericDriver, true);
  assert.equal(d.needsUpdate, true);
  assert.equal(d.catalogEligible, true);
  assert.equal(d.installable, true);
  assert.equal(d.status, 'generic');
});

test('ROOT Basic Display is visible but CPU-only guessing never makes it installable', () => {
  const raw = {
    DeviceID: 'ROOT\\BASICDISPLAY\\0000', Name: 'Microsoft Basic Display Adapter',
    Class: 'Display', Vendor: 'Microsoft', Version: '10.0.22621.1', ErrorCode: 0,
    HardwareIDs: [], CompatIDs: []
  };
  const d = normaliseDevice(raw, {
    CPUs: [{ Name: 'Intel(R) Core(TM) i7-13700K', Manufacturer: 'GenuineIntel' }], GPUs: []
  });
  assert.equal(d.pseudo, false);
  assert.equal(d.hardwareVendor, 'Intel');
  assert.equal(d.hardwareIdentitySource, 'CPU hint');
  assert.equal(d.needsUpdate, true);
  assert.equal(d.installable, false, 'do not install a guessed GPU package without a hardware id');
});

test('GPU inventory is preferred over CPU hints', () => {
  const identity = graphicsIdentity({
    deviceId: 'PCI\\VEN_1002&DEV_744C', hwids: [], compatIds: []
  }, {
    CPUs: [{ Name: 'Intel Core i9', Manufacturer: 'GenuineIntel' }],
    GPUs: [{ Name: 'AMD Radeon RX 7900 XTX', PNPDeviceID: 'PCI\\VEN_1002&DEV_744C', AdapterCompatibility: 'AMD' }]
  });
  assert.equal(identity.vendor, 'AMD');
  assert.equal(identity.source, 'hardware ID');
});

test('catalog GPU versions are compared numerically, not lexically', () => {
  assert.equal(isNewerDriverOffer(
    { version: '32.0.15.6094', lastUpdated: '8/2/2025' },
    { version: '31.0.15.9999', driverDate: '2024-01-01' }
  ), true);
  assert.equal(isNewerDriverOffer(
    { version: '31.0.15.1000', lastUpdated: '8/2/2025' },
    { version: '32.0.15.100', driverDate: '2024-01-01' }
  ), false);
});

// ------------------------------------------------ gaming prerequisite scan
test('missing DirectX and VC++ game runtimes become actionable scan items', () => {
  const runtimes = gamingRuntimesFromSystem({
    Is64Bit: true,
    DirectXVersion: '4.09.00.0904', DirectXLegacy: false,
    VCRedistX64: { Installed: true, Version: 'v14.40' },
    VCRedistX86: { Installed: false, Version: '' }
  });
  assert.equal(runtimes.length, 3);
  assert.deepStrictEqual(
    runtimes.filter((r) => r.needsInstall).map((r) => r.id),
    ['directx-legacy', 'vcredist-x86']
  );

  const summary = buildSummary([], {
    systemInfo: {
      Is64Bit: true, DirectXLegacy: false,
      VCRedistX64: { Installed: true }, VCRedistX86: { Installed: false }
    }
  });
  assert.equal(summary.runtimeMissingCount, 2);
  assert.equal(summary.actionableCount, 2);
});

test('an already-working old driver is not mistaken for a successful update', () => {
  const device = {
    missing: false, genericDriver: false, version: '31.0.15.1000',
    update: { version: '32.0.15.6094' }
  };
  assert.equal(driverUpdateIsActive(device, {
    present: true, error: 0, version: '31.0.15.1000', provider: 'NVIDIA'
  }), false);
  assert.equal(driverUpdateIsActive(device, {
    present: true, error: 0, version: '32.0.15.6094', provider: 'NVIDIA'
  }), true);
  assert.equal(driverUpdateIsActive({
    missing: false, genericDriver: true, version: '10.0.22621.1', update: {}
  }, {
    present: true, error: 0, version: '10.0.22621.1', provider: 'Intel Corporation'
  }), true);
});

test('driver network failures are marked retryable', () => {
  assert.equal(isDriverNetworkFailure('download-failed', 'socket closed'), true);
  assert.equal(isDriverNetworkFailure('catalog-down', 'offline'), true);
  assert.equal(isDriverNetworkFailure('install-failed', 'pnputil rejected the INF'), false);
});

// ==========================================================================
// FRESH-WINDOWS REGRESSION — "it installs the Microsoft driver instead of the
// Intel/AMD one that is actually available"
// --------------------------------------------------------------------------
// Reported on an Intel Core i3 6th gen with no discrete GPU. On a clean
// install Windows binds its OWN inbox driver (provider "Microsoft
// Corporation") to the Intel HD Graphics 530 iGPU and to the chipset devices.
// The device works, so it was neither "missing" nor the Basic Display
// Adapter — and the scanner therefore called it up to date and never offered
// the real Intel package that the catalog has. These tests pin the fix.
// ==========================================================================
const {
  isMicrosoftProvider, isSiliconVendor, offerIsFromVendor,
  devicePriority, sortByInstallPriority
} = require('../server/drivers');

test('a Microsoft inbox driver on an Intel iGPU is flagged for the vendor package', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_8086&DEV_1912\\3&11583659&0&10',
    Name: 'Intel(R) HD Graphics 530',
    Class: 'Display',
    Vendor: 'Microsoft Corporation',   // inbox driver provider on a fresh install
    Manufacturer: 'Intel Corporation',
    Version: '10.0.19041.1',           // Microsoft's build-number scheme
    ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_8086&DEV_1912&SUBSYS_00000000'],
    CompatIDs: []
  });
  assert.equal(d.missing, false, 'the device works — it is not missing');
  assert.equal(d.hardwareVendor, 'Intel');
  assert.equal(d.driverProviderIsMicrosoft, true);
  assert.equal(d.vendorDriverWanted, true,
    'the Intel package must be offered even though the Microsoft driver works');
  assert.equal(d.catalogEligible, true);
});

test('an Intel chipset device on the Microsoft inbox driver is also flagged', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_8086&DEV_A123\\3&11583659&0&FC',
    Name: 'Intel(R) 100 Series Chipset Family SMBus Controller',
    Class: 'System', Vendor: 'Microsoft', Manufacturer: 'Intel',
    Version: '10.0.19041.1', ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_8086&DEV_A123&SUBSYS_00000000'], CompatIDs: []
  });
  assert.equal(d.hardwareVendor, 'Intel');
  assert.equal(d.vendorDriverWanted, true);
});

test('a device already on its vendor driver is NOT flagged again', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_8086&DEV_1912\\3&11583659&0&10',
    Name: 'Intel(R) HD Graphics 530',
    Class: 'Display', Vendor: 'Intel Corporation', Manufacturer: 'Intel',
    Version: '31.0.101.2115', ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_8086&DEV_1912&SUBSYS_00000000'], CompatIDs: []
  });
  assert.equal(d.vendorDriverWanted, false, 'the Intel driver is already loaded');
  assert.equal(d.needsUpdate, false);
});

test('a Microsoft driver on genuinely Microsoft hardware is left alone', () => {
  const d = normaliseDevice({
    DeviceID: 'PCI\\VEN_1414&DEV_008E\\1',
    Name: 'Microsoft Hyper-V Video',
    Class: 'Display', Vendor: 'Microsoft', Manufacturer: 'Microsoft',
    Version: '10.0.19041.1', ErrorCode: 0,
    HardwareIDs: ['PCI\\VEN_1414&DEV_008E'], CompatIDs: []
  });
  assert.equal(d.vendorDriverWanted, false,
    'Microsoft silicon has no third-party vendor package to prefer');
});

test('provider and silicon-vendor helpers agree with the fresh-install case', () => {
  assert.equal(isMicrosoftProvider('Microsoft'), true);
  assert.equal(isMicrosoftProvider('Microsoft Corporation'), true);
  assert.equal(isMicrosoftProvider('Intel Corporation'), false);
  assert.equal(isSiliconVendor('Intel'), true);
  assert.equal(isSiliconVendor('Realtek'), true);
  assert.equal(isSiliconVendor('Microsoft'), false);
});

test('only a genuine vendor catalog offer counts as replacing the Microsoft driver', () => {
  assert.equal(offerIsFromVendor(
    { title: 'Intel Corporation - Display - 31.0.101.2115' }, 'Intel'), true);
  assert.equal(offerIsFromVendor(
    { title: 'Advanced Micro Devices, Inc. - Display - 31.0.14051.5006' }, 'AMD'), true);
  // Another Microsoft inbox package is never an upgrade over the current one.
  assert.equal(offerIsFromVendor(
    { title: 'Microsoft - Display - 10.0.19041.1' }, 'Intel'), false);
});

test('graphics and chipset are installed before peripherals, vendor swap before updates', () => {
  const gpu = { name: 'Intel(R) HD Graphics 530', vendorDriverWanted: true, needsUpdate: true,
    gaming: { key: 'gpu' } };
  const chipset = { name: 'Intel SMBus Controller', vendorDriverWanted: true, needsUpdate: true,
    gaming: { key: 'chipset' } };
  const mouse = { name: 'Gaming Mouse', needsUpdate: true, gaming: { key: 'input' } };
  const missingNic = { name: 'Ethernet Controller', missing: true, needsUpdate: true,
    gaming: { key: 'network' } };

  const order = sortByInstallPriority([mouse, chipset, gpu, missingNic]).map((d) => d.name);
  assert.deepStrictEqual(order, [
    'Ethernet Controller',            // missing driver always first
    'Intel(R) HD Graphics 530',       // then the Microsoft-inbox graphics swap
    'Intel SMBus Controller',         // then the chipset swap
    'Gaming Mouse'                    // ordinary updates last
  ]);
  assert.ok(devicePriority(gpu) < devicePriority(mouse));
});

test('the gaming report reports an Intel iGPU on the Microsoft driver as "inbox"', () => {
  const devices = [{
    name: 'Intel(R) HD Graphics 530', vendor: 'Microsoft Corporation', class: 'Display',
    version: '10.0.19041.1', missing: false, needsUpdate: true,
    vendorDriverWanted: true, hardwareVendor: 'Intel'
  }];
  for (const d of devices) d.gaming = gamingRole(d);

  const report = gamingReport(devices);
  const gpu = report.categories.find((c) => c.key === 'gpu');
  assert.equal(gpu.state, 'inbox');
  assert.match(gpu.detail, /built-in Microsoft driver/);
  assert.match(gpu.advice, /Intel/);
  assert.equal(report.inboxCount, 1);
  // The machine still boots and plays — it is not a hard failure.
  assert.equal(report.ready, true);
  assert.equal(report.problemCount, 0);
});

test('a Microsoft inbox driver is a successful replacement once a vendor one is active', () => {
  const device = {
    missing: false, genericDriver: false, vendorDriverWanted: true,
    hardwareVendor: 'Intel', version: '10.0.19041.1', update: {}
  };
  assert.equal(driverUpdateIsActive(device, {
    present: true, error: 0, version: '31.0.101.2115', provider: 'Intel Corporation'
  }), true);
  // Still Microsoft's driver afterwards → the install did not take effect.
  assert.equal(driverUpdateIsActive(device, {
    present: true, error: 0, version: '10.0.19041.1', provider: 'Microsoft'
  }), false);
});
