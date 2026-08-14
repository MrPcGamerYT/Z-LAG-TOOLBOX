'use strict';

/**
 * Driver Center — scanner and self-sufficient bulk updater.
 *
 * The page is a driver *scanner* first: it inventories the machine, then
 * offers a single "update / install all" action for everything that is
 * missing or outdated.
 *
 * IMPORTANT — this toolbox deliberately does NOT depend on Windows Update:
 * Z-LAG OS and many debloated Windows installs block the WU service/policy,
 * and the previous Driver Center (built on the Microsoft.Update.Session COM
 * API) silently had nothing to offer there. Instead we use two engines that
 * always work:
 *
 *   ENGINE 1 · LOCAL REPAIR (offline): pnputil re-enumeration plus a sweep of
 *     the inbox driver store (C:\Windows\System32\DriverStore\FileRepository)
 *     resurrects most "driver not installed" (code 28/31…) devices without
 *     any network at all.
 *
 *   ENGINE 2 · MICROSOFT UPDATE CATALOG (server/drivercatalog.js): the web
 *     catalog searched by hardware ID over plain HTTPS — the Windows Update
 *     *service* stays out of the picture. Matching driver packages are
 *     downloaded as raw .cab files, expanded with expand.exe and installed
 *     with pnputil, exactly like an IT pro would do it by hand.
 *
 * Windows Update is only consulted during the scan (when it happens to be
 * alive) as a bonus source of "this driver is outdated" signals.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const muc = require('./drivercatalog');

const IS_WINDOWS = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// -------------------------------------------------------------- powershell
function powershellPath() {
  if (!IS_WINDOWS) return 'powershell';
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Run a PowerShell script. Uses -EncodedCommand so multi-line scripts with
 * quotes, COM calls and registry paths survive untouched.
 */
function runPwsh(script, timeoutMs, onStdout) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(String(script), 'utf16le').toString('base64');
    const child = spawn(powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) {} },
      timeoutMs || 300000);
    child.stdout.on('data', (d) => {
      const s = String(d);
      stdout += s;
      if (onStdout) onStdout(s);
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, code: 1, stdout, stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({
        ok: code === 0 && !timedOut,
        code: code == null ? 1 : code,
        stdout,
        stderr: timedOut ? stderr + '\nTimed out.' : stderr
      });
    });
  });
}

function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // PowerShell may emit warnings before the JSON payload; take the first
  // balanced JSON value in the stream.
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  try { return JSON.parse(s.slice(start)); } catch (_) {}
  const lastArr = s.lastIndexOf(']');
  const lastObj = s.lastIndexOf('}');
  const end = Math.max(lastArr, lastObj);
  if (end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// -------------------------------------------------------------- scan script
/**
 * Inventory (always) + optional Windows Update "outdated" hints.
 *
 * The WU part is wrapped in try/catch because it fails on machines with WU
 * disabled by policy (Z-LAG OS) or no network; then we still return the
 * inventory and mark wuAvailable=false, and the UI leans on the Update
 * Catalog instead.
 *
 * Hardware IDs (and compatible IDs) are exported per device — they are the
 * exact key the Microsoft Update Catalog indexes drivers by.
 */
const SCAN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# ---- installed driver inventory -----------------------------------------
# Every signed driver on the machine, keyed by device id. This is the full
# driver store view, not just the devices currently enumerated.
$signed = @{}
foreach ($d in Get-CimInstance Win32_PnPSignedDriver) {
  if ($d.DeviceID) { $signed[$d.DeviceID] = $d }
}

$devices = @()
$seen = @{}

# CPU/GPU identity is collected separately as a recovery signal. A machine
# using Microsoft Basic Display Adapter can hide the real vendor in the
# friendly name, but its PNP id / Win32_VideoController entry still identifies
# the physical GPU. CPU identity is only a last-resort hint; it is never used
# to install a package without a matching hardware id.
$cpus = @(Get-CimInstance Win32_Processor | ForEach-Object {
  [PSCustomObject]@{ Name = $_.Name; Manufacturer = $_.Manufacturer; ProcessorId = $_.ProcessorId }
})
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [PSCustomObject]@{
    Name = $_.Name
    PNPDeviceID = $_.PNPDeviceID
    AdapterCompatibility = $_.AdapterCompatibility
    DriverVersion = $_.DriverVersion
    VideoProcessor = $_.VideoProcessor
  }
})

# Gaming prerequisites are not PnP drivers, so Device Manager cannot report
# them. Check the actual side-by-side DLLs and VC runtime registry keys used by
# games. Modern DirectX remains part of Windows; this specifically detects the
# legacy D3DX/XInput libraries that Windows 10/11 do not include by default.
$legacyNames = @('d3dx9_43.dll', 'd3dcompiler_43.dll', 'xinput1_3.dll', 'xaudio2_7.dll')
$legacyOk = $true
foreach ($n in $legacyNames) {
  if (-not (Test-Path (Join-Path $env:SystemRoot ('System32\\' + $n)))) { $legacyOk = $false }
  if ([Environment]::Is64BitOperatingSystem -and
      -not (Test-Path (Join-Path $env:SystemRoot ('SysWOW64\\' + $n)))) { $legacyOk = $false }
}
function Get-VcRuntime($arch) {
  $paths = @(
    ('HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\' + $arch),
    ('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\' + $arch)
  )
  foreach ($p in $paths) {
    $v = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
    if ($v -and [int]$v.Installed -eq 1) {
      return [PSCustomObject]@{ Installed = $true; Version = [string]$v.Version }
    }
  }
  return [PSCustomObject]@{ Installed = $false; Version = '' }
}
$vc64 = Get-VcRuntime 'x64'
$vc86 = Get-VcRuntime 'x86'
$dxVersion = ''
try { $dxVersion = [string](Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\DirectX').Version } catch {}

# Pass 1: every PnP device Windows knows about, present or not.
foreach ($e in Get-CimInstance Win32_PnPEntity) {
  if (-not $e.DeviceID) { continue }
  $drv = $signed[$e.DeviceID]
  $err = [int]$e.ConfigManagerErrorCode
  $seen[$e.DeviceID] = $true
  $hw = @($e.HardwareID | Select-Object -First 6)
  $ci = @($e.CompatibleID | Select-Object -First 4)
  $devices += [PSCustomObject]@{
    Name       = if ($e.Name) { $e.Name } elseif ($e.Caption) { $e.Caption } else { $e.DeviceID }
    DeviceID   = $e.DeviceID
    Class      = if ($drv -and $drv.DeviceClass) { $drv.DeviceClass } else { $e.PNPClass }
    Vendor     = if ($drv -and $drv.DriverProviderName) { $drv.DriverProviderName } else { $e.Manufacturer }
    Manufacturer = $e.Manufacturer
    Version    = if ($drv) { $drv.DriverVersion } else { $null }
    DriverDate = if ($drv -and $drv.DriverDate) { $drv.DriverDate.ToString('yyyy-MM-dd') } else { $null }
    InfName    = if ($drv) { $drv.InfName } else { $null }
    Service    = $e.Service
    Present    = [bool]$e.Present
    Status     = $e.Status
    ErrorCode  = $err
    Problem    = ($err -ne 0)
    HardwareIDs = $hw
    CompatIDs   = $ci
  }
}

# Pass 2: signed drivers whose device did not appear above (hidden, detached
# or non-present hardware). Without this the list is only ever partial.
foreach ($k in $signed.Keys) {
  if ($seen[$k]) { continue }
  $d = $signed[$k]
  if (-not $d.DeviceName -and -not $d.FriendlyName) { continue }
  $devices += [PSCustomObject]@{
    Name       = if ($d.FriendlyName) { $d.FriendlyName } else { $d.DeviceName }
    DeviceID   = $d.DeviceID
    Class      = $d.DeviceClass
    Vendor     = $d.DriverProviderName
    Manufacturer = $d.Manufacturer
    Version    = $d.DriverVersion
    DriverDate = if ($d.DriverDate) { $d.DriverDate.ToString('yyyy-MM-dd') } else { $null }
    InfName    = $d.InfName
    Service    = $null
    Present    = $false
    Status     = 'Not present'
    ErrorCode  = 0
    Problem    = $false
    HardwareIDs = @()
    CompatIDs   = @()
  }
}

[PSCustomObject]@{
  Devices = $devices
  SystemInfo = [PSCustomObject]@{
    CPUs = $cpus
    GPUs = $gpus
    Is64Bit = [Environment]::Is64BitOperatingSystem
    DirectXVersion = $dxVersion
    DirectXLegacy = [bool]$legacyOk
    VCRedistX64 = $vc64
    VCRedistX86 = $vc86
  }
} | ConvertTo-Json -Depth 5 -Compress
`;

/**
 * Bonus "newer driver exists" hints from Windows Update — ONLY if that
 * service is alive. Everything still works when it is not.
 */
const WU_HINT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$wuAvailable = $false
$wuError = ''
$updates = @()
try {
  $session  = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $searcher.ServerSelection = 3
  $searcher.ServiceID = '7971f918-a847-4430-9279-4a52d1efe18d'
  $result = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")
  $wuAvailable = $true
  foreach ($u in $result.Updates) {
    $size = 0
    try { $size = [int64]$u.MaxDownloadSize } catch {}
    $updates += [PSCustomObject]@{
      Title       = $u.Title
      UpdateID    = $u.Identity.UpdateID
      DriverClass = $u.DriverClass
      Model       = $u.DriverModel
      Provider    = $u.DriverProvider
      DriverDate  = if ($u.DriverVerDate) { $u.DriverVerDate.ToString('yyyy-MM-dd') } else { $null }
      Size        = $size
      Mandatory   = [bool]$u.IsMandatory
    }
  }
} catch {
  $wuError = $_.Exception.Message
}
[PSCustomObject]@{ Updates = $updates; WuAvailable = $wuAvailable; WuError = $wuError } | ConvertTo-Json -Depth 4 -Compress
`;

/** Human label for the ConfigManager error codes that mean "no driver". */
const CM_PROBLEMS = {
  1: 'Device is not configured correctly',
  10: 'Device cannot start',
  18: 'Drivers need to be reinstalled',
  19: 'Registry configuration is corrupt',
  22: 'Device is disabled',
  28: 'Drivers are not installed',
  31: 'Windows cannot load the required drivers',
  37: 'Driver returned a failure',
  39: 'Driver is corrupted or missing',
  43: 'Windows stopped this device (reported problem)',
  45: 'Device is not currently connected',
  52: 'Driver signature could not be verified'
};

const MISSING_CODES = new Set([1, 18, 28, 31, 39, 52]);

// -------------------------------------------------------- pseudo devices
/**
 * Windows enumerates a LOT of things that are not hardware and can never have
 * a vendor driver:
 *
 *   HTREE\ROOT\0            the root of the device tree itself
 *   SWD\… / SW\…            software enumerated nodes (audio endpoints, MMDEVAPI)
 *   STORAGE\Volume…         volumes, snapshots, volume manager children
 *   ROOT\…                  software bus nodes (composite bus, UMBus, vdrvroot…)
 *   DISPLAY\…               monitors (they use the inbox monitor driver)
 *
 * None of them expose a DriverVersion in Win32_PnPSignedDriver, so the old
 * `missing = !version` rule flagged them all as "No driver installed" — that
 * is exactly the phantom `HTREE\ROOT\0 · Unknown · Other` row users kept
 * seeing, and it can never be fixed by any install because there is nothing
 * to install. They are filtered out of the scan entirely.
 */
const PSEUDO_ID = new RegExp([
  '^HTREE\\\\',                       // the device-tree root itself
  '^SWD\\\\',                          // software device enumerator
  '^SW\\\\',                           // software bus
  '^STORAGE\\\\VOLUME',                // volumes
  '^STORAGE\\\\VOLUMESNAPSHOT',
  '^VOLUMESNAPSHOT',
  '^VOLUME\\\\',
  '^UMB\\\\',                          // user-mode bus children
  '^DISPLAY\\\\',                      // monitors
  '^ROOT\\\\(SYSTEM|BASICRENDER|COMPOSITEBUS|UMBUS|VDRVROOT|SPACEPORT|VOLMGR|MSSMBIOS|RDPBUS|KDNIC|SWENUM|NDISVIRTUALBUS|WPD|DISPLAYLINK)'
].join('|'), 'i');

const PSEUDO_NAME = /^(composite bus enumerator|umbus (root )?bus enumerator|microsoft (windows )?management interface|plug and play software device enumerator|volume|generic volume|volume shadow copy|generic non-pnp monitor|generic pnp monitor|microsoft virtual drive enumerator|microsoft system management bios driver|remote desktop device redirector bus|microsoft kernel debug network adapter|microsoft basic render driver|numeric data processor|system (timer|speaker|cmos\/real time clock|board)|motherboard resources|programmable interrupt controller|direct memory access controller|high precision event timer|pci (bus|express root complex|standard host cpu bridge)|acpi (fixed feature button|lid|power button|sleep button|thermal zone|processor aggregator)|composite device|usb composite device|generic usb hub|usb root hub)/i;

/**
 * True when this entry is a software / bookkeeping node rather than a real
 * piece of hardware a driver could be installed for.
 */
function isPseudoDevice(d) {
  const id = String(d.deviceId || d.id || '');
  const name = String(d.name || '');
  if (!id && !name) return true;
  if (PSEUDO_ID.test(id)) return true;
  if (PSEUDO_NAME.test(name.trim())) return true;
  // A nameless entry whose "name" is just its device path is a tree node.
  if (id && name && name.replace(/\s+/g, '') === id.replace(/\s+/g, '')) return true;
  return false;
}

/**
 * True when there is any realistic way to install a driver for this device:
 * we need at least one hardware / compatible ID to look one up, and the
 * device must not be a pseudo node.
 */
function isInstallable(d) {
  if (isPseudoDevice(d)) return false;
  const ids = (d.hwids || []).concat(d.compatIds || []);
  if (!ids.length) return false;
  // PCI / USB / HDAUDIO / ACPI\VEN / SCSI style IDs are what the catalog
  // indexes. Anything else (ROOT\…, SWD\…) has no catalog presence.
  return ids.some((h) => /^(pci|usb|hdaudio|hid|acpi\\ven|scsi|sd|mmc|bth|1394|dot4|umb\\um)/i.test(String(h)));
}

// ----------------------------------------------------- hardware identity
const PCI_VENDOR_NAMES = {
  '10de': 'NVIDIA',
  '1002': 'AMD',
  '1022': 'AMD',
  '8086': 'Intel',
  '1414': 'Microsoft',
  // Extra silicon vendors. Recognising these is what lets the scanner say
  // "an Intel/Realtek/Qualcomm package exists" instead of accepting whatever
  // inbox Microsoft driver Windows happened to bind.
  '10ec': 'Realtek',
  '168c': 'Qualcomm Atheros',
  '17cb': 'Qualcomm',
  '14e4': 'Broadcom',
  '11ab': 'Marvell',
  '1b21': 'ASMedia',
  '1b4b': 'Marvell',
  '144d': 'Samsung',
  '1cc1': 'ADATA',
  '15b7': 'Western Digital',
  '1c5c': 'SK hynix',
  '1e0f': 'KIOXIA',
  '1987': 'Phison',
  '126f': 'Silicon Motion',
  '1179': 'Toshiba',
  '1106': 'VIA',
  '1969': 'Qualcomm Atheros',
  '1d6a': 'Aquantia'
};

/**
 * Vendors that ship their own Windows driver packages. When the hardware
 * belongs to one of these, a Microsoft-provided inbox driver is only ever a
 * placeholder — the vendor package must win.
 */
const SILICON_VENDORS = /^(nvidia|amd|intel|realtek|qualcomm|qualcomm atheros|broadcom|marvell|asmedia|samsung|western digital|sk hynix|kioxia|phison|silicon motion|adata|toshiba|via|aquantia|mediatek|killer)$/i;

/** True when this driver provider string is really "Windows' own driver". */
function isMicrosoftProvider(vendor) {
  const v = String(vendor || '').trim();
  if (!v) return false;
  return /^(microsoft|microsoft corporation|standard|\(standard|generic|unknown)/i.test(v);
}

/** True when a vendor name belongs to a chip maker that ships real drivers. */
function isSiliconVendor(vendor) {
  return SILICON_VENDORS.test(String(vendor || '').trim());
}

/** Recover the physical vendor hidden behind a generic Microsoft driver. */
function vendorFromHardwareIds(ids) {
  for (const id of ids || []) {
    const m = /(?:VEN_|VID_|SUBSYS_[0-9a-f]{4})([0-9a-f]{4})/i.exec(String(id));
    if (m && PCI_VENDOR_NAMES[m[1].toLowerCase()]) return PCI_VENDOR_NAMES[m[1].toLowerCase()];
  }
  return '';
}

function normaliseSystemInfo(raw) {
  raw = raw || {};
  const cpus = asArray(raw.CPUs || raw.cpus).map((c) => ({
    name: String(c.Name || c.name || ''),
    manufacturer: String(c.Manufacturer || c.manufacturer || ''),
    processorId: String(c.ProcessorId || c.processorId || '')
  })).filter((c) => c.name || c.manufacturer);
  const gpus = asArray(raw.GPUs || raw.gpus).map((g) => ({
    name: String(g.Name || g.name || ''),
    deviceId: String(g.PNPDeviceID || g.deviceId || ''),
    vendor: String(g.AdapterCompatibility || g.vendor || ''),
    version: String(g.DriverVersion || g.version || ''),
    processor: String(g.VideoProcessor || g.processor || '')
  })).filter((g) => g.name || g.deviceId);
  return {
    cpus,
    gpus,
    is64Bit: raw.Is64Bit == null
      ? (raw.is64Bit == null ? true : !!raw.is64Bit)
      : !!raw.Is64Bit,
    directXVersion: String(raw.DirectXVersion || raw.directXVersion || ''),
    directXLegacy: raw.DirectXLegacy == null
      ? (raw.directXLegacy == null ? null : !!raw.directXLegacy)
      : !!raw.DirectXLegacy,
    vcRedistX64: raw.VCRedistX64 || raw.vcRedistX64 || null,
    vcRedistX86: raw.VCRedistX86 || raw.vcRedistX86 || null
  };
}

/**
 * Identify a generic display adapter from its PCI id first, then from the
 * matching VideoController record. CPU manufacturer is returned only as a
 * visible hint when Windows exposes no GPU id; it never makes a package
 * installable by itself.
 */
function graphicsIdentity(device, systemInfo) {
  const ids = (device.hwids || []).concat(device.compatIds || [], [device.deviceId || '']);
  const fromId = vendorFromHardwareIds(ids);
  if (fromId && fromId !== 'Microsoft') return { vendor: fromId, source: 'hardware ID' };

  // An Intel/AMD CPU with integrated graphics still exposes the iGPU through
  // Win32_VideoController even when the display device itself sits behind the
  // Microsoft Basic Display Adapter. Match on the video controller BEFORE
  // falling back to a CPU-only guess.

  const system = normaliseSystemInfo(systemInfo);
  const id = String(device.deviceId || '').toLowerCase();
  const gpu = system.gpus.find((g) => id && String(g.deviceId).toLowerCase() === id) ||
    (system.gpus.length === 1 ? system.gpus[0] : null);
  if (gpu) {
    const v = vendorFromHardwareIds([gpu.deviceId]) ||
      (/(nvidia)/i.test(gpu.vendor + ' ' + gpu.name) ? 'NVIDIA'
        : (/(advanced micro devices|\bamd\b|radeon)/i.test(gpu.vendor + ' ' + gpu.name) ? 'AMD'
          : (/(intel)/i.test(gpu.vendor + ' ' + gpu.name) ? 'Intel' : '')));
    if (v) return { vendor: v, source: 'GPU inventory', model: gpu.name };
  }

  const cpuText = system.cpus.map((c) => c.manufacturer + ' ' + c.name).join(' ');
  if (/intel/i.test(cpuText) && !/\b[0-9]+f\b/i.test(cpuText)) {
    return { vendor: 'Intel', source: 'CPU hint', hintOnly: true };
  }
  if (/advanced micro devices|\bamd\b|ryzen/i.test(cpuText)) {
    return { vendor: 'AMD', source: 'CPU hint', hintOnly: true };
  }
  return { vendor: '', source: '' };
}

// ------------------------------------------------------- gaming driver rules
/**
 * The drivers that actually decide whether games run well. Each rule knows
 * how to recognise its device class, which vendor driver *should* be there,
 * and what it means when the generic Microsoft driver is loaded instead.
 *
 * `genericVendors` is the tell: a GPU running on "Microsoft" means Windows
 * fell back to the Basic Display Adapter and the machine cannot game at all
 * until the real driver is installed.
 */
/**
 * The `match` regex on each rule is ONLY the *name fallback* used when a
 * device's class is unknown or empty. When Windows reports a real device
 * class it is authoritative (see CLASS_CATEGORY below), so these patterns are
 * deliberately narrow and unambiguous — a bare "realtek", "nvidia" or
 * "controller" here is exactly what mis-filed Realtek NICs as Audio, NVIDIA
 * HDMI audio as the GPU, and "PCI Simple Communications Controller" as a game
 * controller. Those phantom entries are what turned a healthy machine into a
 * permanent "3 problems" verdict.
 */
const GAMING_RULES = [
  {
    key: 'gpu',
    label: 'Graphics (GPU)',
    critical: true,
    classes: ['display'],
    match: /geforce|quadro|radeon|rtx\b|gtx\b|arc\s?[a]\d|iris xe|vega|uhd graphics|hd graphics|intel.*graphics|amd.*graphics|nvidia.*(graphics|gpu|display)|graphics card|display adapter|\bgpu\b/i,
    genericNames: /^(microsoft )?basic display|standard vga|basic render/i,
    genericVendors: /^(microsoft|\(standard)/i,
    advice: 'Install the vendor GPU driver (NVIDIA / AMD / Intel). Games cannot use hardware acceleration on the Microsoft Basic Display Adapter.',
    vendorHint: 'NVIDIA, AMD or Intel'
  },
  {
    key: 'audio',
    label: 'Audio',
    critical: false,
    classes: ['media', 'audioendpoint', 'sound'],
    match: /audio|sound blaster|nahimic|hdaudio|high definition audio|headset/i,
    genericNames: /^high definition audio device$/i,
    genericVendors: null,
    advice: 'Install your motherboard or headset audio driver for positional audio and low-latency mixing.',
    vendorHint: 'Realtek / motherboard vendor'
  },
  {
    key: 'network',
    label: 'Network',
    critical: true,
    classes: ['net'],
    match: /ethernet|wi-?fi|wlan|wireless lan|gbe|gigabit|network adapter|killer|\bnic\b/i,
    genericNames: /^(microsoft )?(kernel debug|wan miniport|teredo|virtual)/i,
    genericVendors: /^microsoft$/i,
    advice: 'A vendor NIC driver (Intel / Realtek / Killer) gives noticeably better latency than the Microsoft fallback.',
    vendorHint: 'Intel, Realtek or Killer'
  },
  {
    key: 'chipset',
    label: 'Chipset',
    critical: false,
    // `classIsEnough: false` — the "System" class is shared with dozens of
    // non-chipset devices (ACPI system, root ports…) so the name must also
    // confirm the device really is chipset hardware.
    classIsEnough: false,
    classes: ['system'],
    match: /chipset|sm ?bus|smbus|pci express root|host bridge|platform security processor|management engine|isa bridge|lpc controller|memory controller/i,
    genericNames: null,
    genericVendors: null,
    advice: 'Install the AMD or Intel chipset package — it enables the correct power plan and PCIe behaviour for gaming.',
    vendorHint: 'AMD or Intel'
  },
  {
    key: 'storage',
    label: 'Storage (NVMe/SATA)',
    critical: false,
    classes: ['scsiadapter', 'hdc'],
    match: /nvm express|nvme|sata|ahci|raid/i,
    genericNames: /^standard (nvm express|sata ahci) controller$/i,
    genericVendors: null,
    advice: 'A vendor NVMe driver can cut game level-load times versus the inbox Microsoft controller driver.',
    vendorHint: 'Samsung, WD or Intel'
  },
  {
    key: 'input',
    label: 'Controller & Input',
    critical: false,
    classes: ['hidclass', 'xnacomposite', 'xboxcomposite', 'mouse', 'keyboard'],
    match: /xbox|gamepad|joystick|dualshock|dualsense|razer|logitech|corsair|steelseries|gaming (mouse|keyboard)|game controller|wireless controller/i,
    genericNames: null,
    genericVendors: null,
    advice: 'Controller drivers are optional but enable rumble, triggers and per-device polling rates.',
    vendorHint: 'Microsoft / peripheral vendor'
  }
];

/** The device class is the primary signal — Windows' own class enum is far
 * more reliable than guessing from a name string. */
const CLASS_CATEGORY = {
  display: 'gpu',
  media: 'audio', audioendpoint: 'audio', sound: 'audio',
  net: 'network',
  system: 'chipset',
  scsiadapter: 'storage', hdc: 'storage',
  hidclass: 'input', xnacomposite: 'input', xboxcomposite: 'input',
  mouse: 'input', keyboard: 'input'
};
const RULE_BY_KEY = {};
GAMING_RULES.forEach((r) => { RULE_BY_KEY[r.key] = r; });

/**
 * Names that are never gaming hardware regardless of what the class says.
 * These are the exact devices that kept showing up as phantom problems:
 * Bluetooth radios read as "Network", USB/comms host controllers read as a
 * game "controller", and the various virtual/software adapters.
 */
const NEVER_GAMING = /virtual|remote desktop|loopback|teredo|wan miniport|kernel debug|bluetooth|communications? controller|host controller|smart ?card/i;

/** Brands that prove a real vendor driver is loaded, whatever the provider says. */
const VENDOR_BRANDS = /(nvidia|geforce|rtx|gtx|quadro|amd|radeon|ryzen|intel|realtek|killer|qualcomm|mediatek|broadcom|marvell|aquantia|asmedia|samsung|western digital|sandisk|kingston|crucial|micron|phison|silicon motion|creative|sound blaster|nahimic|logitech|razer|corsair|steelseries|asus|msi|gigabyte|aorus)/i;

/**
 * Classify one device against the gaming rules.
 * Returns `{ key, label, generic, critical }` or null when the device is not
 * gaming-relevant.
 */
function gamingRole(device) {
  if (device.pseudo) return null;
  const cls = String(device.class || '').toLowerCase();
  const name = String(device.name || '');
  const vendor = String(device.vendor || '');

  // Software nodes and non-gaming hardware are rejected up front, whatever
  // their class claims — this is what stops "PCI Simple Communications
  // Controller" being filed under Controller & Input.
  if (NEVER_GAMING.test(name)) return null;

  let rule = null;
  let classHit = false;
  const byClass = CLASS_CATEGORY[cls];
  if (byClass) {
    rule = RULE_BY_KEY[byClass];
    classHit = true;
    // A broad class (System) needs the name to confirm the device before it
    // is accepted as chipset hardware.
    if (rule.classIsEnough === false && !(rule.match && rule.match.test(name))) {
      rule = null;
      classHit = false;
    }
  } else {
    // Unknown / non-standard class — fall back to an unambiguous name match.
    for (const r of GAMING_RULES) {
      if (r.match && r.match.test(name)) { rule = r; break; }
    }
  }
  if (!rule) return null;

  // "Generic" only when Windows really fell back to its own stack. A device
  // whose NAME carries a vendor brand (Intel UHD Graphics, Realtek Audio…)
  // is a vendor device even if Win32_PnPSignedDriver reports the provider
  // as Microsoft for an inbox-signed package — treating those as generic is
  // what produced permanent phantom "4 problems".
  const brandInName = VENDOR_BRANDS.test(name);
  const nameIsGeneric = !!(rule.genericNames && rule.genericNames.test(name));
  const vendorIsGeneric = !!(rule.genericVendors && rule.genericVendors.test(vendor) &&
    classHit && !brandInName);
  const generic = nameIsGeneric || vendorIsGeneric;
  return { key: rule.key, label: rule.label, generic, critical: rule.critical, rule };
}

/**
 * Build the "gaming readiness" report: one entry per gaming-relevant driver
 * category with its state — ok / outdated / generic / missing.
 */
function gamingReport(devices) {
  const categories = GAMING_RULES.map((rule) => {
    const members = devices.filter((d) => d.gaming && d.gaming.key === rule.key);
    let state = 'absent';
    let detail = 'No device of this type was detected.';
    let device = null;

    if (members.length) {
      // The most interesting member decides the verdict.
      const rank = (d) => (d.missing ? 0
        : (d.gaming.generic ? 1 : (d.vendorDriverWanted ? 2 : (d.needsUpdate ? 3 : 4))));
      const sorted = members.slice().sort((a, b) => rank(a) - rank(b));
      device = sorted[0];
      if (device.missing) {
        state = 'missing';
        detail = 'No driver is installed for ' + device.name + '.';
      } else if (device.gaming.generic) {
        state = 'generic';
        detail = device.name + ' is running on the generic Windows driver.';
      } else if (device.vendorDriverWanted) {
        // Works, but on Microsoft's inbox driver while the silicon vendor
        // ships a real one — the fresh-Windows case.
        state = 'inbox';
        detail = device.name + ' is using the built-in Microsoft driver; the ' +
          (device.hardwareVendor || 'vendor') + ' driver is available and performs better.';
      } else if (device.needsUpdate) {
        state = 'outdated';
        detail = 'A newer driver is available for ' + device.name + '.';
      } else {
        state = 'ok';
        detail = device.name + ' — ' + (device.vendor || 'vendor') +
          ' driver ' + (device.version || '') + (device.driverDate ? ' (' + device.driverDate + ')' : '');
      }
    } else {
      // No device of this type was enumerated. That is NOT a missing driver —
      // plenty of machines have no discrete audio, no NVMe, no controller.
      // Reporting it as "missing" is what produced the permanent
      // "Not game ready — a critical driver is missing" verdict with problems
      // the user could never fix.
      state = 'absent';
      detail = 'Not present on this system — nothing to do.';
    }

    return {
      key: rule.key,
      label: rule.label,
      critical: rule.critical,
      state,
      detail,
      advice: state === 'outdated'
        ? 'A driver update is available — run "Update all" to install it.'
        : (state === 'inbox'
          ? 'Run "Update all" to replace the Microsoft driver with the ' +
            ((device && device.hardwareVendor) || rule.vendorHint) + ' package.'
          : ((state === 'ok' || state === 'absent') ? '' : rule.advice)),
      vendorHint: (device && device.hardwareVendor) || rule.vendorHint,
      deviceName: device ? device.name : '',
      version: device ? device.version : '',
      count: members.length
    };
  });

  const problems = categories.filter((c) => c.state === 'missing' || c.state === 'generic');
  // "inbox" is not a fault — the machine works — but it IS actionable work,
  // so it is counted with the updates rather than the problems.
  const outdated = categories.filter((c) => c.state === 'outdated' || c.state === 'inbox');
  const inbox = categories.filter((c) => c.state === 'inbox');
  const blocking = problems.filter((c) => c.critical);

  // 100 minus a weighted penalty per problem category.
  let score = 100;
  for (const c of categories) {
    if (c.state === 'missing') score -= c.critical ? 40 : 12;
    else if (c.state === 'generic') score -= c.critical ? 30 : 8;
    else if (c.state === 'inbox') score -= c.critical ? 15 : 5;
    else if (c.state === 'outdated') score -= c.critical ? 12 : 4;
  }
  score = Math.max(0, Math.min(100, score));

  const plural = (n, s) => n + ' ' + s + (n === 1 ? '' : 's');

  let verdict;
  if (blocking.length) verdict = 'Not game ready — a critical driver is missing or generic.';
  else if (problems.length) verdict = 'Playable — ' + plural(problems.length, 'driver') + ' run on a generic or missing stack.';
  else if (inbox.length) {
    verdict = 'Playable — ' + plural(inbox.length, 'device') +
      ' still use the built-in Microsoft driver instead of the vendor one.';
  } else if (outdated.length) verdict = 'Game ready — ' + plural(outdated.length, 'optional driver update') + ' available.';
  else verdict = 'Game ready — all gaming drivers are present and current.';

  return {
    score,
    verdict,
    ready: blocking.length === 0,
    problemCount: problems.length,
    outdatedCount: outdated.length,
    inboxCount: inbox.length,
    categories
  };
}

// ---------------------------------------------------- gaming prerequisites
const GAMING_RUNTIME_DEFS = [
  {
    id: 'directx-legacy',
    name: 'DirectX legacy game runtimes',
    description: 'D3DX9/10/11, XInput 1.3 and XAudio 2.7 used by many games.',
    fileName: 'dxwebsetup.exe',
    url: 'https://download.microsoft.com/download/1/7/1/1718CCC4-6315-4D8E-9543-8E28A4E18C4C/dxwebsetup.exe',
    args: ['/Q']
  },
  {
    id: 'vcredist-x64',
    name: 'Visual C++ 2015–2022 runtime (x64)',
    description: 'Latest supported Microsoft C/C++ libraries for 64-bit games.',
    fileName: 'vc_redist.x64.exe',
    url: 'https://aka.ms/vc14/vc_redist.x64.exe',
    args: ['/install', '/quiet', '/norestart']
  },
  {
    id: 'vcredist-x86',
    name: 'Visual C++ 2015–2022 runtime (x86)',
    description: '32-bit C/C++ libraries still required by many games on 64-bit Windows.',
    fileName: 'vc_redist.x86.exe',
    url: 'https://aka.ms/vc14/vc_redist.x86.exe',
    args: ['/install', '/quiet', '/norestart']
  }
];
const RUNTIME_BY_ID = Object.fromEntries(GAMING_RUNTIME_DEFS.map((r) => [r.id, r]));

function runtimeRegistryValue(v) {
  if (!v) return { installed: false, version: '' };
  return {
    installed: !!(v.Installed == null ? v.installed : v.Installed),
    version: String(v.Version || v.version || '')
  };
}

/** Turn PowerShell's prerequisite checks into stable public scan rows. */
function gamingRuntimesFromSystem(raw) {
  if (!raw || raw.DirectXLegacy == null && raw.directXLegacy == null) return [];
  const system = normaliseSystemInfo(raw);
  const vc64 = runtimeRegistryValue(system.vcRedistX64);
  const vc86 = runtimeRegistryValue(system.vcRedistX86);
  const states = {
    'directx-legacy': {
      installed: system.directXLegacy === true,
      version: system.directXLegacy === true ? 'legacy DLL set present' : ''
    },
    'vcredist-x64': vc64,
    'vcredist-x86': vc86
  };
  return GAMING_RUNTIME_DEFS
    .filter((r) => r.id !== 'vcredist-x64' || system.is64Bit)
    .map((def) => {
      const state = states[def.id] || {};
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        installed: !!state.installed,
        version: state.version || '',
        status: state.installed ? 'installed' : 'missing',
        needsInstall: !state.installed,
        source: 'Microsoft'
      };
    });
}

function addRuntimesToGamingReport(report, runtimes) {
  const missing = (runtimes || []).filter((r) => r.needsInstall);
  report.runtimeProblemCount = missing.length;
  report.runtimesReady = missing.length === 0;
  if (missing.length) {
    report.score = Math.max(0, report.score - Math.min(18, missing.length * 6));
    if (report.ready && report.problemCount === 0) {
      report.verdict = 'Game drivers ready — ' + missing.length +
        ' gaming runtime' + (missing.length === 1 ? ' is' : 's are') + ' missing.';
    }
  }
  return report;
}

/** Normalise a device name for fuzzy matching against a WU update title. */
function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|\(c\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w));
}
const STOP = new Set(['the', 'and', 'for', 'inc', 'ltd', 'corporation', 'corp',
  'driver', 'drivers', 'device', 'controller', 'standard', 'generic', 'system']);

/** Score how well a WU update title matches a device name. */
function matchScore(deviceName, update) {
  const a = tokens(deviceName);
  const b = tokens([update.Title, update.Model, update.Provider].filter(Boolean).join(' '));
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const w of a) if (setB.has(w)) hits++;
  return hits / a.length;
}

// -------------------------------------------------------------- demo data
const DEMO_DEVICES = [
  ['NVIDIA GeForce RTX 4070', 'NVIDIA', 'Display', '32.0.15.5976', true],
  ['Intel(R) Wi-Fi 6E AX210 160MHz', 'Intel', 'Net', '23.30.0.4', true],
  ['Realtek PCIe GbE Family Controller', 'Realtek', 'Net', '10.68.601.2023', false],
  ['Realtek(R) Audio', 'Realtek', 'MEDIA', '6.0.9616.1', true],
  ['AMD Platform Security Processor', 'AMD', 'SecurityDevices', '5.17.0.0', false],
  ['Standard NVM Express Controller', 'Microsoft', 'SCSIAdapter', '10.0.22621.1', false],
  ['USB xHCI Compliant Host Controller', 'Microsoft', 'USB', '10.0.22621.1', false],
  ['Intel(R) UHD Graphics 770', 'Intel', 'Display', '31.0.101.4502', true],
  ['High Definition Audio Device', 'Microsoft', 'MEDIA', '10.0.22621.1', false],
  ['Intel(R) Wireless Bluetooth(R)', 'Intel', 'Bluetooth', '23.20.0.3', false],
  ['Logitech G502 HERO Gaming Mouse', 'Logitech', 'HIDClass', '6.0.532.12', false],
  // The fresh-Windows case, 6th field = the real silicon vendor behind a
  // working Microsoft inbox driver (Intel i3 6th gen iGPU + chipset).
  ['Intel(R) HD Graphics 530', 'Microsoft Corporation', 'Display', '10.0.19041.1', false, 'Intel'],
  ['Intel(R) 100 Series Chipset Family SMBus Controller', 'Microsoft Corporation', 'System',
    '10.0.19041.1', false, 'Intel'],
  ['Base System Device', 'Unknown', 'Unknown', null, false],
  ['PCI Simple Communications Controller', 'Unknown', 'Unknown', null, false]
];

function demoScan() {
  const devices = DEMO_DEVICES.map(([name, vendor, cls, version, outdated, siliconVendor]) => {
    const missing = version == null;
    // Working, but on Microsoft's own driver while the chip maker ships a real
    // package — actionable even though nothing looks broken.
    const vendorDriverWanted = !missing && !!siliconVendor && isMicrosoftProvider(vendor);
    const actionable = missing || outdated || vendorDriverWanted;
    const dev = {
      id: 'demo-' + tokens(name).join('-'),
      name,
      vendor,
      class: cls || 'Other',
      version: missing ? 'None' : version,
      driverDate: missing ? null : '2024-08-01',
      hwids: ['PCI\\VEN_DEMO&DEV_0001'],
      compatIds: [],
      pseudo: false,
      catalogEligible: true,
      installable: actionable,
      missing,
      problem: missing,
      problemText: missing ? CM_PROBLEMS[28] : '',
      hardwareVendor: siliconVendor || '',
      hardwareIdentitySource: siliconVendor ? 'hardware ID' : '',
      driverProviderIsMicrosoft: !missing && isMicrosoftProvider(vendor),
      vendorDriverWanted,
      vendorDriverHint: vendorDriverWanted
        ? siliconVendor + ' ships its own driver for this device — ' +
          'Windows is currently using the built-in Microsoft driver.'
        : '',
      needsUpdate: actionable,
      status: missing ? 'missing'
        : (vendorDriverWanted ? 'vendor_available' : (outdated ? 'update_available' : 'up_to_date')),
      update: actionable
        ? {
          title: (vendorDriverWanted ? siliconVendor + ' Corporation - ' + name : name) +
            ' - Driver Update',
          updateId: 'demo-' + uid(),
          size: 24 * 1024 * 1024,
          provider: vendorDriverWanted ? siliconVendor : vendor,
          driverDate: '2026-05-12',
          source: 'catalog',
          replacesMicrosoft: vendorDriverWanted
        }
        : null
    };
    dev.gaming = gamingRole(dev);
    dev.priority = devicePriority(dev);
    return dev;
  });
  // Same install order the real pipeline uses: graphics and chipset first.
  const ordered = sortByInstallPriority(devices);
  devices.length = 0;
  devices.push(...ordered);
  const systemInfo = {
    CPUs: [{ Name: 'Intel(R) Core(TM) i7-13700K', Manufacturer: 'GenuineIntel' }],
    GPUs: [{ Name: 'NVIDIA GeForce RTX 4070', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2786', AdapterCompatibility: 'NVIDIA' }],
    Is64Bit: true,
    DirectXVersion: '4.09.00.0904',
    DirectXLegacy: false,
    VCRedistX64: { Installed: true, Version: 'v14.40' },
    VCRedistX86: { Installed: true, Version: 'v14.40' }
  };
  return buildSummary(devices, {
    mode: 'demo', source: 'update-catalog', wuAvailable: false, wuError: '', systemInfo
  });
}

function buildSummary(allDevices, extra) {
  // Software / bookkeeping nodes (HTREE\ROOT\0, volumes, ACPI buttons…) are
  // never shown: they cannot have a driver, so listing them as "No driver
  // installed" was pure noise the user could never clear.
  const hidden = allDevices.filter((d) => d.pseudo).length;
  const devices = filterRealDevices(allDevices);

  // Tag every device with its gaming role before anything is counted, so the
  // report and the device list can never disagree.
  for (const d of devices) d.gaming = gamingRole(d);

  const missing = devices.filter((d) => d.missing);
  const updatable = devices.filter((d) => d.needsUpdate && !d.missing);
  const systemInfo = normaliseSystemInfo(extra && extra.systemInfo);
  const gamingRuntimes = (extra && extra.gamingRuntimes) ||
    gamingRuntimesFromSystem(extra && extra.systemInfo);
  const gaming = addRuntimesToGamingReport(gamingReport(devices), gamingRuntimes);

  // One entry per device class, for the class filter in the UI.
  const classCounts = {};
  for (const d of devices) {
    const key = d.class || 'Other';
    classCounts[key] = (classCounts[key] || 0) + 1;
  }
  const classes = Object.keys(classCounts)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, count: classCounts[name] }));

  const fixable = missing.filter((d) => d.installable !== false);
  const fixableUpdates = updatable.filter((d) => d.installable !== false);
  const manualOnly = devices.filter((d) => d.needsUpdate && d.installable === false);
  // Devices still on a Microsoft inbox driver where the silicon vendor ships
  // a real package. Surfaced separately so the UI can say exactly why an
  // apparently healthy Intel iGPU or chipset device is in the update list.
  const vendorWaiting = devices.filter((d) => d.vendorDriverWanted && d.installable !== false);
  const runtimeMissing = gamingRuntimes.filter((r) => r.needsInstall);
  const summaryExtra = Object.assign({}, extra || {});
  delete summaryExtra.systemInfo;
  delete summaryExtra.gamingRuntimes;

  return Object.assign({
    ok: true,
    count: devices.length,
    hiddenPseudoCount: hidden,
    missingCount: missing.length,
    // Only what an engine can genuinely act on drives the action bar.
    fixableCount: fixable.length + fixableUpdates.length + runtimeMissing.length,
    unresolvableCount: manualOnly.length,
    updatableCount: updatable.length,
    upToDateCount: devices.filter((d) => !d.needsUpdate).length,
    // Everything the combined update button will act on.
    actionableCount: fixable.length + fixableUpdates.length + runtimeMissing.length,
    driverActionableCount: fixable.length + fixableUpdates.length,
    runtimeMissingCount: runtimeMissing.length,
    vendorDriverWaitingCount: vendorWaiting.length,
    gamingCount: devices.filter((d) => d.gaming).length,
    gaming,
    gamingRuntimes,
    systemInfo,
    classes,
    devices
  }, summaryExtra);
}

// ------------------------------------------------------------ real scanning
/** Pure inventory — no WU, no network. Used by the job to verify repairs. */
async function runInventory(timeoutMs) {
  const r = await runPwsh(SCAN_SCRIPT, timeoutMs || 240000);
  const data = parseJsonLoose(r.stdout) || {};
  return {
    ok: r.ok && !!data.Devices,
    raw: asArray(data.Devices),
    systemInfo: data.SystemInfo || {},
    stderr: r.stderr
  };
}

function normaliseDevice(d, rawSystemInfo) {
  const err = Number(d.ErrorCode) || 0;
  const version = d.Version && d.Version !== 'n/a' ? String(d.Version) : null;
  const dev = {
    id: String(d.DeviceID || d.Name || uid()),
    name: String(d.Name || 'Unknown device'),
    vendor: String(d.Vendor || d.Manufacturer || 'Unknown'),
    manufacturer: String(d.Manufacturer || ''),
    driverProvider: String(d.Vendor || 'Unknown'),
    class: String(d.Class || 'Other'),
    version: version || 'None',
    driverDate: d.DriverDate || null,
    deviceId: String(d.DeviceID || ''),
    hwids: asArray(d.HardwareIDs).map(String).filter(Boolean),
    compatIds: asArray(d.CompatIDs).map(String).filter(Boolean),
    problem: err !== 0,
    problemText: err !== 0 ? (CM_PROBLEMS[err] || ('Device problem code ' + err)) : '',
    update: null
  };

  dev.pseudo = isPseudoDevice(dev);

  // Recover NVIDIA / AMD / Intel from PCI ids before classifying a generic
  // display adapter. DriverProviderName can legitimately be "Microsoft" while
  // the physical GPU vendor is still encoded in VEN_xxxx.
  const displayLike = String(dev.class).toLowerCase() === 'display' ||
    /basic display|graphics|\bgpu\b/i.test(dev.name);
  if (displayLike) {
    const identity = graphicsIdentity(dev, rawSystemInfo);
    if (identity.vendor) {
      dev.hardwareVendor = identity.vendor;
      dev.hardwareIdentitySource = identity.source;
      dev.hardwareModel = identity.model || '';
      dev.hardwareIdentityHintOnly = !!identity.hintOnly;
      if (/^(microsoft|unknown|\(standard\))$/i.test(dev.vendor)) dev.vendor = identity.vendor;
    }
  } else {
    // Every other device gets the same treatment from its PCI/USB ids alone:
    // the chipset, NIC, audio and storage silicon vendor is what decides
    // whether a real vendor package exists for it.
    const fromId = vendorFromHardwareIds(
      (dev.hwids || []).concat(dev.compatIds || [], [dev.deviceId || '']));
    if (fromId && fromId !== 'Microsoft') {
      dev.hardwareVendor = fromId;
      dev.hardwareIdentitySource = 'hardware ID';
    }
  }

  // "Missing" means real hardware Windows reports as broken/driverless.
  const brokenByWindows = MISSING_CODES.has(err);
  const catalogEligible = isInstallable(dev);
  const noDriverLoaded = !version && !dev.pseudo && catalogEligible;
  dev.missing = !dev.pseudo && (brokenByWindows || noDriverLoaded);

  const role = gamingRole(dev);
  dev.gaming = role;
  dev.genericDriver = !!(role && role.generic);
  dev.catalogEligible = catalogEligible;

  // ---- Microsoft inbox driver on vendor silicon --------------------------
  // THE FRESH-WINDOWS CASE: Windows binds its own inbox driver (provider
  // "Microsoft" / "Microsoft Corporation") to an Intel iGPU, an Intel/AMD
  // chipset device, a Realtek NIC… The device *works*, so it is neither
  // "missing" nor the Basic Display Adapter, and the old scanner therefore
  // called it up to date and never looked for the real Intel/AMD/Realtek
  // package that is sitting on the catalog. Flag it here so the catalog probe
  // prioritises it and Update All installs the vendor driver first.
  dev.driverProviderIsMicrosoft = !dev.missing && isMicrosoftProvider(dev.driverProvider);
  dev.vendorDriverWanted = !dev.pseudo && catalogEligible && !dev.missing &&
    dev.driverProviderIsMicrosoft && isSiliconVendor(dev.hardwareVendor);
  if (dev.vendorDriverWanted) {
    dev.vendorDriverHint = dev.hardwareVendor + ' ships its own driver for this device — ' +
      'Windows is currently using the built-in Microsoft driver.';
  }

  // A generic Microsoft GPU/audio/storage stack is just as actionable as a
  // code-28 device when it has a real hardware id. In particular this makes
  // Microsoft Basic Display Adapter trigger a vendor driver lookup.
  dev.needsUpdate = dev.missing || dev.genericDriver;
  dev.installable = dev.needsUpdate && catalogEligible;
  if (dev.needsUpdate && !dev.installable) {
    dev.unresolvable = true;
    if (dev.missing) {
      dev.problemText = dev.problemText ||
        'Windows has no driver for this device and it has no hardware ID to search with';
    }
  }

  dev.priority = devicePriority(dev);
  dev.status = dev.missing ? 'missing' : (dev.genericDriver ? 'generic' : 'up_to_date');
  return dev;
}

/**
 * Install order. Lower sorts first.
 *
 * The user-visible rule: the display/chipset silicon that everything else
 * hangs off must be handled BEFORE peripheral odds and ends, and a device
 * still running the Microsoft inbox driver outranks a merely outdated vendor
 * driver. On a fresh install that means the Intel iGPU and the chipset go
 * first, and the Microsoft placeholder never survives the run.
 */
const CATEGORY_ORDER = { gpu: 0, chipset: 1, network: 2, storage: 3, audio: 4, input: 5 };

function devicePriority(dev) {
  const cat = dev.gaming && CATEGORY_ORDER[dev.gaming.key] != null
    ? CATEGORY_ORDER[dev.gaming.key] : 6;
  // Class-band: missing driver → generic Microsoft stack → Microsoft inbox
  // driver over vendor silicon → plain update → everything else.
  let band = 4;
  if (dev.missing) band = 0;
  else if (dev.genericDriver) band = 1;
  else if (dev.vendorDriverWanted) band = 2;
  else if (dev.needsUpdate) band = 3;
  return band * 10 + cat;
}

/** Order a device list the way it should be installed. */
function sortByInstallPriority(devices) {
  return devices.slice().sort((a, b) => {
    const pa = a.priority == null ? devicePriority(a) : a.priority;
    const pb = b.priority == null ? devicePriority(b) : b.priority;
    if (pa !== pb) return pa - pb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/** Drop the software / bookkeeping nodes from a normalised device list. */
function filterRealDevices(devices) {
  return devices.filter((d) => !d.pseudo);
}

/** Windows Update "this driver is outdated" hints, when that service lives. */
async function runWuHints() {
  const r = await runPwsh(WU_HINT_SCRIPT, 180000);
  const data = parseJsonLoose(r.stdout) || {};
  return {
    available: !!data.WuAvailable,
    error: String(data.WuError || r.stderr || '').slice(0, 300),
    updates: asArray(data.Updates)
  };
}

/**
 * Microsoft Update Catalog offers for devices with NO driver. This keeps the
 * "missing drivers have a download waiting" feature alive when Windows
 * Update is blocked. Bounded: at most MAX_CATALOG devices, one quick search
 * each, and results are cached for the process lifetime so the "update all"
 * job re-uses them without a second round trip.
 */
const catalogCache = new Map(); // query -> offers[]
const MAX_CATALOG_SCAN = 12;
let lastScan = null;

/**
 * Circuit breaker: the first network-level failure (offline PC, blocked
 * egress) trips it for the rest of the scan/job, so a dozen devices don't
 * each wait out a 45-second timeout against an unreachable host.
 */
let catalogDead = false;
function catalogDownReason() {
  return 'Microsoft Update Catalog is unreachable — check the internet connection';
}

async function searchCatalogCached(query) {
  if (catalogDead) return null;            // null = "catalog down", [] = "no offers"
  const key = String(query).toLowerCase();
  if (catalogCache.has(key)) return catalogCache.get(key);
  try {
    const offers = await muc.searchCatalog(query);
    catalogCache.set(key, offers || []);
    return offers || [];
  } catch (_) {
    catalogDead = true;                    // network error ≠ "no driver found"
    return null;
  }
}

function compareVersion(a, b) {
  const aa = String(a || '').match(/\d+/g) || [];
  const bb = String(b || '').match(/\d+/g) || [];
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const av = Number(aa[i] || 0);
    const bv = Number(bb[i] || 0);
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

/** Is this catalog result newer than a working installed driver? */
function isNewerDriverOffer(offer, device) {
  if (!offer || !device) return false;
  if (offer.version && device.version && device.version !== 'None') {
    return compareVersion(offer.version, device.version) > 0;
  }
  const offered = Date.parse(offer.lastUpdated || '') || 0;
  const installed = Date.parse(device.driverDate || '') || 0;
  return offered > installed + 24 * 60 * 60 * 1000;
}

async function attachCatalogOffers(devices) {
  const candidates = sortByInstallPriority(devices
    // Missing/generic devices come first. Every physical GPU is also probed,
    // even when Windows Update is disabled, so an already-working display
    // driver can still be compared with the newest compatible catalog offer.
    //
    // `vendorDriverWanted` is the fresh-install case: an Intel iGPU or a
    // chipset device that Windows bound to its own inbox driver. It works, so
    // nothing else marks it — but the real Intel/AMD/Realtek package is on the
    // catalog and must be found and preferred.
    .filter((d) => !d.update && d.catalogEligible && !d.pseudo &&
      (d.missing || d.genericDriver || d.vendorDriverWanted ||
        (d.gaming && d.gaming.key === 'gpu'))))
    .slice(0, MAX_CATALOG_SCAN);
  let used = 0;
  for (const dev of candidates) {
    if (catalogDead) break;
    const queries = muc.deviceQueries(dev);
    let best = null;
    for (const q of queries) {
      const offers = await searchCatalogCached(q);
      if (offers === null) break;          // catalog down — stop probing
      if (offers && offers.length) {
        best = muc.pickBestOffer(offers, dev);
        break;
      }
    }
    // A vendor package for silicon currently running the Microsoft inbox
    // driver is always an improvement, whatever the version numbers say:
    // Microsoft's inbox version scheme (10.0.x = the Windows build) is not
    // comparable with Intel's (31.0.101.x), so a plain version comparison
    // would silently reject the real driver.
    const vendorReplacesMicrosoft = !!(best && dev.vendorDriverWanted &&
      offerIsFromVendor(best, dev.hardwareVendor));
    const shouldOffer = best &&
      (dev.missing || dev.genericDriver || vendorReplacesMicrosoft ||
        isNewerDriverOffer(best, dev));
    if (shouldOffer) {
      used++;
      dev.update = {
        title: String(best.title || 'Driver update'),
        updateId: String(best.updateId || ''),
        version: String(best.version || ''),
        size: Number(best.sizeBytes) || 0,
        provider: (best.title || '').split(' - ')[0] || '',
        driverDate: best.lastUpdated || null,
        source: 'catalog',
        replacesMicrosoft: vendorReplacesMicrosoft
      };
      dev.needsUpdate = true;
      dev.installable = true;
      if (!dev.missing) {
        dev.status = dev.genericDriver ? 'generic'
          : (vendorReplacesMicrosoft ? 'vendor_available' : 'update_available');
      }
      dev.priority = devicePriority(dev);
    }
    await sleep(250); // be polite to the catalog
  }
  return used;
}

/**
 * Does this catalog offer actually come from the silicon vendor (Intel, AMD,
 * NVIDIA, Realtek…) rather than being another Microsoft inbox package?
 * Catalog titles read like "Intel Corporation - Display - 31.0.101.2115".
 */
function offerIsFromVendor(offer, vendor) {
  if (!offer || !vendor) return false;
  const title = String(offer.title || '');
  const publisher = title.split(' - ')[0] || title;
  // Never swap one Microsoft driver for another Microsoft driver.
  if (isMicrosoftProvider(publisher)) return false;
  const v = String(vendor).toLowerCase();
  const alias = {
    amd: /(amd|advanced micro devices|ati)/i,
    intel: /intel/i,
    nvidia: /nvidia/i,
    realtek: /realtek/i,
    'qualcomm atheros': /(qualcomm|atheros)/i
  }[v] || new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return alias.test(title);
}

// -------------------------------------------------------------- scan
async function scanDrivers() {
  if (!IS_WINDOWS) {
    await sleep(900);
    lastScan = demoScan();
    return lastScan;
  }
  catalogDead = false; // retry the catalog on every manual scan

  const inv = await runInventory();
  if (!inv.ok) {
    return {
      ok: false,
      mode: 'real',
      error: 'Could not read the Windows device inventory. ' + String(inv.stderr || '').trim().slice(0, 240),
      devices: [],
      gamingRuntimes: []
    };
  }
  const devices = inv.raw.map((d) => normaliseDevice(d, inv.systemInfo));

  const wu = await runWuHints();
  const updates = wu.updates;

  // Pair each Windows Update driver offer with the device it belongs to
  // (purely a "this one is outdated" hint; installs never go through WU).
  const takenUpdates = new Set();
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    let best = null;
    let bestScore = 0.34; // require a meaningful overlap, not one stray word
    for (const dev of devices) {
      if (dev.update) continue;
      const s = matchScore(dev.name, u);
      if (s > bestScore) { best = dev; bestScore = s; }
    }
    const info = {
      title: String(u.Title || 'Driver update'),
      updateId: String(u.UpdateID || ''),
      size: Number(u.Size) || 0,
      provider: u.Provider || '',
      driverDate: u.DriverDate || null,
      source: 'windows-update'
    };
    if (best) {
      best.update = info;
      best.needsUpdate = true;
      // A WU hint has a real catalog GUID. Prefer hardware-id matching when
      // available, but keep the item actionable even if the inventory entry
      // itself did not expose ids.
      best.installable = best.catalogEligible || !!info.updateId;
      if (!best.missing) best.status = 'update_available';
      takenUpdates.add(i);
    }
  }

  // Driver offers that match no inventory entry are still installable — list
  // them so "update all" really covers everything Windows Update has.
  const orphans = updates
    .map((u, i) => ({ u, i }))
    .filter(({ i }) => !takenUpdates.has(i))
    .map(({ u }) => ({
      id: 'wu-' + String(u.UpdateID || uid()),
      name: String(u.Title || 'Driver update'),
      vendor: String(u.Provider || 'Windows Update'),
      class: String(u.DriverClass || 'Other'),
      version: 'None',
      driverDate: u.DriverDate || null,
      deviceId: '',
      hwids: [],
      compatIds: [],
      pseudo: false,
      catalogEligible: false,
      installable: true,
      missing: false,
      problem: false,
      problemText: '',
      needsUpdate: true,
      status: 'update_available',
      update: {
        title: String(u.Title || 'Driver update'),
        updateId: String(u.UpdateID || ''),
        size: Number(u.Size) || 0,
        provider: u.Provider || '',
        driverDate: u.DriverDate || null,
        source: 'windows-update'
      }
    }));

  const all = devices.concat(orphans);

  // The catalog is where missing drivers actually come from — attach a real
  // downloadable offer to every bare "missing" entry it knows.
  let catalogUsed = 0;
  try { catalogUsed = await attachCatalogOffers(all); } catch (_) {}

  // Actionable items first, in the order they should actually be installed:
  // missing drivers, then the Microsoft generic stacks, then vendor packages
  // waiting to replace a Microsoft inbox driver (GPU and chipset first), then
  // ordinary updates.
  const ordered = sortByInstallPriority(all);
  all.length = 0;
  all.push(...ordered);

  lastScan = buildSummary(all, {
    mode: 'real',
    source: wu.available ? 'windows-update+catalog' : (catalogUsed ? 'update-catalog' : 'inventory'),
    wuAvailable: wu.available,
    wuError: wu.available ? '' : wu.error,
    updatesOffered: updates.length,
    catalogOffered: catalogUsed,
    systemInfo: inv.systemInfo
  });
  return lastScan;
}

// =====================================================================
// UPDATE / INSTALL ALL — the self-sufficient pipeline
// =====================================================================

const JOBS = new Map();

function publicDriverJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    current: job.current,
    total: job.total,
    installed: job.installed,
    failed: job.failed,
    driverTotal: job.driverTotal,
    runtimeTotal: job.runtimeTotal,
    runtimeInstalled: job.runtimeInstalled,
    networkFailed: job.networkFailed,
    retryable: !!job.retryable,
    retryLabel: job.networkFailed ? 'Retry failed downloads' : 'Retry failed items',
    reboot: job.reboot,
    error: job.error,
    warning: job.failed > 0,
    mode: job.mode,
    items: job.items.slice(-100),
    log: job.log.slice(-120)
  };
}

function jlog(job, line) {
  job.log.push('[' + new Date().toISOString().slice(11, 19) + '] ' + line);
  if (job.log.length > 300) job.log.shift();
}

function getDriverJob(id) { return JOBS.get(id) || null; }

function cancelDriverJob(id) {
  const job = JOBS.get(id);
  if (!job) return false;
  job.cancelled = true;
  jlog(job, 'Cancel requested — the current driver will finish first.');
  if (job.child) { try { job.child.kill(); } catch (_) {} }
  return true;
}

/**
 * Start a background "install every missing / outdated driver" job.
 * @param {{onlyMissing?:boolean}} [opts]
 */
function scanDriverTargets(scan, onlyMissing) {
  if (!scan) return null;
  return (scan.devices || []).filter((d) => {
    if (onlyMissing && !d.missing) return false;
    return d.needsUpdate && d.installable !== false;
  }).map((d) => JSON.parse(JSON.stringify(d)));
}

function scanRuntimeTargets(scan) {
  if (!scan) return null;
  return (scan.gamingRuntimes || []).filter((r) => r.needsInstall)
    .map((r) => Object.assign({}, r));
}

function startUpdateAll(opts) {
  opts = opts || {};
  const targetSnapshot = Array.isArray(opts.targets)
    ? opts.targets.map((d) => JSON.parse(JSON.stringify(d)))
    : scanDriverTargets(lastScan, !!opts.onlyMissing);
  const runtimeSnapshot = Array.isArray(opts.runtimes)
    ? opts.runtimes.map((r) => Object.assign({}, r))
    : scanRuntimeTargets(lastScan);
  const job = {
    id: uid(),
    status: 'running',
    stage: 'repairing',
    percent: 3,
    current: '',
    total: 0,
    driverTotal: 0,
    runtimeTotal: 0,
    installed: 0,
    runtimeInstalled: 0,
    failed: 0,
    networkFailed: 0,
    retryable: false,
    reboot: false,
    error: null,
    mode: IS_WINDOWS ? 'real' : 'demo',
    items: [],
    log: [],
    cancelled: false,
    child: null,
    targetSnapshot,
    runtimeSnapshot,
    failedDevices: [],
    failedRuntimes: [],
    options: { onlyMissing: !!opts.onlyMissing },
    retryOf: opts.retryOf || null
  };
  JOBS.set(job.id, job);
  jlog(job, 'Self-sufficient pipeline: identify CPU/GPU hardware, repair local drivers, fetch compatible packages, then repair missing game runtimes.');
  jlog(job, 'Driver packages come directly from the Microsoft Update Catalog; Windows Update is not required.');
  if (job.retryOf) jlog(job, 'Retrying only the items that failed in the previous job.');

  (IS_WINDOWS ? realUpdateAll(job) : demoUpdateAll(job)).catch((e) => {
    job.error = (e && e.message) || String(e);
    job.status = 'error';
    job.stage = 'error';
    if (!job.cancelled) {
      job.failedDevices = job.failedDevices.length ? job.failedDevices : (job.targetSnapshot || []);
      job.failedRuntimes = job.failedRuntimes.length ? job.failedRuntimes : (job.runtimeSnapshot || []);
      job.retryable = job.failedDevices.length > 0 || job.failedRuntimes.length > 0;
    }
    jlog(job, 'ERROR ' + job.error);
  });
  return job;
}

function retryDriverJob(id) {
  const old = JOBS.get(id);
  if (!old || !['done', 'error'].includes(old.status) || !old.retryable) return null;
  return startUpdateAll({
    onlyMissing: old.options && old.options.onlyMissing,
    targets: old.failedDevices || [],
    runtimes: old.failedRuntimes || [],
    retryOf: old.id
  });
}

/**
 * Verify a set of DeviceIDs: which ones have a working driver NOW.
 * Returns a Map deviceId → { present, error, version }.
 */
async function verifyDevices(devs) {
  const ids = devs.map((d) => d.deviceId || d.id).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const quoted = ids.map((i) => "'" + i.replace(/'/g, "''") + "'").join(', ');
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$ids = @(' + quoted + ')',
    '$signed = @{}',
    'foreach ($d in Get-CimInstance Win32_PnPSignedDriver) { if ($d.DeviceID) { $signed[$d.DeviceID] = $d } }',
    '$out = foreach ($id in $ids) {',
    '  $e = Get-CimInstance Win32_PnPEntity -Filter ("DeviceID=\'" + $id + "\'") -ErrorAction SilentlyContinue',
    '  $drv = $signed[$id]',
    '  [PSCustomObject]@{',
    '    DeviceID = $id',
    '    Present  = [bool]($e -ne $null)',
    '    Error    = if ($e) { [int]$e.ConfigManagerErrorCode } else { -1 }',
    "    Version  = if ($drv -and $drv.DriverVersion) { [string]$drv.DriverVersion } else { '' }",
    "    Provider = if ($drv -and $drv.DriverProviderName) { [string]$drv.DriverProviderName } else { '' }",
    '  }',
    '}',
    '$out | ConvertTo-Json -Depth 3 -Compress'
  ].join('\n');
  const r = await runPwsh(script, 120000);
  for (const row of asArray(parseJsonLoose(r.stdout))) {
    if (row && row.DeviceID) {
      map.set(String(row.DeviceID), {
        present: !!row.Present,
        error: Number(row.Error),
        version: row.Version ? String(row.Version) : '',
        provider: row.Provider ? String(row.Provider) : ''
      });
    }
  }
  return map;
}

function driverUpdateIsActive(device, after) {
  if (!after || !after.present || after.error !== 0 || !after.version) return false;
  if (device.missing) return true;
  // The Microsoft inbox driver was replaced by a real vendor one — the whole
  // point of the fresh-install case. Version numbers are not comparable
  // across publishers (Microsoft 10.0.x vs Intel 31.0.101.x), so the provider
  // change is the signal.
  if (device.vendorDriverWanted && after.provider && !isMicrosoftProvider(after.provider)) return true;
  const expected = device.update && device.update.version;
  if (expected && compareVersion(after.version, expected) >= 0) return true;
  if (device.version && device.version !== 'None' && compareVersion(after.version, device.version) > 0) return true;
  if (device.genericDriver && after.provider && !isMicrosoftProvider(after.provider)) return true;
  return false;
}

function finishJob(job) {
  if (job.cancelled) {
    job.status = 'error';
    job.stage = 'error';
    job.error = 'Stopped by user';
    jlog(job, 'Stopped by user');
    return;
  }
  job.status = 'done';
  job.stage = 'done';
  job.percent = 100;
  job.current = '';
  job.retryable = !!(job.failed > 0 &&
    ((job.failedDevices && job.failedDevices.length) || (job.failedRuntimes && job.failedRuntimes.length)));
  jlog(job, 'Finished — ' + job.installed + ' driver(s) and ' + job.runtimeInstalled +
    ' gaming runtime(s) installed, ' + job.failed + ' unresolved' +
    (job.reboot ? ' · restart required' : '') +
    (job.retryable ? ' · failed items can be retried' : ''));
}

function isDriverNetworkFailure(code, message) {
  if (['catalog-down', 'search-failed', 'links-failed', 'download-failed'].includes(String(code))) return true;
  return /network|internet|download|timed? ?out|enotfound|econn|eai_again|http (?:408|429|5\d\d)/i.test(String(message || ''));
}

async function verifyMicrosoftInstaller(file) {
  const safe = String(file).replace(/'/g, "''");
  const script = [
    "$s = Get-AuthenticodeSignature -LiteralPath '" + safe + "'",
    '[PSCustomObject]@{',
    '  Status = [string]$s.Status',
    "  Subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' }",
    '} | ConvertTo-Json -Compress'
  ].join('\n');
  const r = await runPwsh(script, 60000);
  const sig = parseJsonLoose(r.stdout) || {};
  return {
    ok: r.ok && /^valid$/i.test(String(sig.Status || '')) && /microsoft/i.test(String(sig.Subject || '')),
    status: String(sig.Status || r.stderr || 'signature unavailable'),
    subject: String(sig.Subject || '')
  };
}

async function installGamingRuntime(runtime, job) {
  const def = RUNTIME_BY_ID[runtime.id];
  if (!def) return { ok: false, code: 'unknown-runtime', error: 'Unknown gaming runtime ' + runtime.id };
  const folder = path.join(muc.downloadRoot(), 'gaming-runtimes');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, def.fileName);
  job.stage = 'runtimes';
  job.current = def.name + ' — downloading from Microsoft';
  jlog(job, 'Downloading ' + def.name + ' from Microsoft…');
  try {
    await muc.downloadFile({ url: def.url }, folder, {
      fileName: def.fileName,
      timeout: 15 * 60 * 1000,
      onProgress: (got, total) => {
        job.current = def.name + ' — ' + Math.round(got / 1048576) + ' MB' +
          (total ? ' / ' + Math.round(total / 1048576) + ' MB' : '');
      }
    });
  } catch (e) {
    return { ok: false, code: 'download-failed', error: 'Download failed: ' + e.message };
  }

  job.current = def.name + ' — verifying Microsoft signature';
  const sig = await verifyMicrosoftInstaller(file);
  if (!sig.ok) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
    return {
      ok: false,
      code: 'signature-failed',
      error: 'The downloaded installer did not have a valid Microsoft signature (' + sig.status + '). It was deleted.'
    };
  }

  job.current = def.name + ' — installing';
  jlog(job, 'Verified Microsoft signature; installing ' + def.name + '…');
  const result = await muc.runExe(file, def.args, { timeout: 30 * 60 * 1000, job });
  const code = Number(result.code);
  const ok = result.ok || [0, 1638, 1641, 3010].includes(code);
  return {
    ok,
    code: ok ? 'installed' : 'install-failed',
    rebootRequired: code === 1641 || code === 3010,
    error: ok ? '' : String(result.stderr || result.stdout || ('Installer exit code ' + result.code)).trim().slice(0, 300)
  };
}

async function installRuntimeTargets(job, runtimes, startPercent) {
  if (!runtimes.length || job.cancelled) return;
  jlog(job, 'Gaming prerequisites · installing missing DirectX and Visual C++ components…');
  const span = 98 - startPercent;
  for (let i = 0; i < runtimes.length; i++) {
    if (job.cancelled) break;
    const runtime = runtimes[i];
    job.percent = Math.round(startPercent + (span * i / runtimes.length));
    const result = await installGamingRuntime(runtime, job);
    if (result.rebootRequired) job.reboot = true;
    if (result.ok) {
      job.runtimeInstalled++;
      job.items.push({ title: runtime.name, ok: true, engine: 'gaming-runtime', detail: 'installed from Microsoft' });
      jlog(job, '✓ ' + runtime.name + ' — installed');
    } else {
      job.failed++;
      job.failedRuntimes.push(runtime);
      if (isDriverNetworkFailure(result.code, result.error)) job.networkFailed++;
      job.items.push({ title: runtime.name, ok: false, engine: 'gaming-runtime', detail: result.error });
      jlog(job, '✕ ' + runtime.name + ' — ' + result.error);
    }
  }
}

/**
 * The real self-sufficient pipeline.
 *
 * Phase 1 (repairing): pnputil re-enumeration + inbox driver store sweep —
 *   pure local recovery, no internet, works on a fresh Z-LAG OS install where
 *   half the devices sit at code 28.
 * Phase 2 (searching→downloading→installing): for whatever is left, query
 *   the Microsoft Update Catalog by hardware ID, download the .cab directly
 *   and install it with pnputil.
 * Phase 3 (runtimes): install any missing Microsoft DirectX legacy and Visual
 *   C++ game prerequisites after verifying each installer's signature.
 */
async function realUpdateAll(job) {
  job.stage = 'repairing';
  job.percent = 4;
  catalogDead = false; // a fresh job may retry the catalog connection

  // ---- target list from the live inventory ------------------------------
  jlog(job, 'Reading the device inventory…');
  const inv = await runInventory(180000);
  if (!inv.ok) {
    job.status = 'error';
    job.stage = 'error';
    job.error = 'Could not read the device inventory. ' + (inv.stderr || '').trim().slice(0, 200);
    jlog(job, 'ERROR ' + job.error);
    return;
  }
  const all = filterRealDevices(inv.raw.map((d) => normaliseDevice(d, inv.systemInfo)));

  // Use the completed scan as the install plan. A second plain inventory loses
  // WU/catalog "newer version" hints, which was why Update All previously
  // ignored already-working but outdated graphics drivers.
  let planned = job.targetSnapshot;
  let runtimeTargets = job.runtimeSnapshot;
  if (planned == null || runtimeTargets == null) {
    jlog(job, 'No recent scan plan is available — running a complete driver and gaming-runtime scan now…');
    const fresh = await scanDrivers();
    planned = planned == null ? scanDriverTargets(fresh, job.options.onlyMissing) : planned;
    runtimeTargets = runtimeTargets == null ? scanRuntimeTargets(fresh) : runtimeTargets;
  }
  planned = planned || [];
  runtimeTargets = runtimeTargets || [];

  const currentById = new Map(all.map((d) => [String(d.deviceId || d.id).toLowerCase(), d]));
  let targets = planned.map((p) => {
    const current = currentById.get(String(p.deviceId || p.id).toLowerCase());
    // Current hardware identity wins, scan-time availability metadata stays.
    return current ? Object.assign(current, {
      missing: !!p.missing,
      needsUpdate: !!p.needsUpdate,
      installable: p.installable !== false,
      catalogEligible: current.catalogEligible || p.catalogEligible,
      update: p.update || null,
      genericDriver: !!p.genericDriver,
      vendorDriverWanted: !!p.vendorDriverWanted,
      hardwareVendor: p.hardwareVendor || current.hardwareVendor,
      gaming: p.gaming || current.gaming
    }) : p;
  }).filter((d) => d && d.needsUpdate && d.installable !== false);

  // Install in the order that matters: missing drivers, then Microsoft
  // generic stacks, then vendor packages replacing a Microsoft inbox driver —
  // graphics and chipset ahead of peripherals in every band.
  targets = sortByInstallPriority(targets);
  const inboxTargets = targets.filter((d) => d.vendorDriverWanted);
  if (inboxTargets.length) {
    jlog(job, inboxTargets.length + ' device(s) run the built-in Microsoft driver while the ' +
      'silicon vendor ships a real one — those are installed first: ' +
      inboxTargets.slice(0, 4).map((d) => (d.hardwareVendor || '') + ' ' + d.name).join(', '));
  }

  job.driverTotal = targets.length;
  job.runtimeTotal = runtimeTargets.length;
  job.total = targets.length + runtimeTargets.length;
  job.percent = 8;
  if (targets.length) jlog(job, targets.length + ' device(s) need attention');
  else jlog(job, 'Every detected device already has a working current driver');
  if (runtimeTargets.length) {
    jlog(job, runtimeTargets.length + ' gaming prerequisite(s) are missing (DirectX / Visual C++).');
  }

  if (!targets.length && !runtimeTargets.length) { finishJob(job); return; }
  if (!targets.length) {
    await installRuntimeTargets(job, runtimeTargets, 15);
    finishJob(job);
    return;
  }

  // ---- phase 1a: pure re-enumeration fixes a lot of code 28s -------------
  if (job.cancelled) return finishJob(job);
  job.current = 'Re-enumerating devices (pnputil /scan-devices)';
  jlog(job, 'Phase 1/3 · local repair — re-enumerating devices…');
  await muc.runExe('pnputil.exe', ['/scan-devices'], { timeout: 3 * 60 * 1000, job });
  job.percent = 14;

  let states = await verifyDevices(targets);
  let remaining = [];
  for (const t of targets) {
    const after = states.get(t.deviceId);
    if (t.missing && after && after.present && after.error === 0 && after.version) {
      job.installed++;
      job.items.push({ title: t.name, ok: true, engine: 'repair', detail: 'driver restored from the local store' });
      jlog(job, '✓ ' + t.name + ' — repaired from the local driver store');
    } else remaining.push(t);
  }
  job.current = '';

  // ---- phase 1b: sweep the inbox driver store for the rest ---------------
  const stillMissing = remaining.filter((t) => t.missing);
  if (stillMissing.length && !job.cancelled) {
    job.current = 'Searching the built-in Windows driver store…';
    jlog(job, 'Sweeping the built-in driver store for ' + stillMissing.length + ' driverless device(s)…');
    await muc.runExe('pnputil.exe',
      ['/add-driver', 'C:\\Windows\\System32\\DriverStore\\FileRepository\\*.inf', '/subdirs', '/install'],
      { timeout: 8 * 60 * 1000, job });
    job.percent = 24.5;
    states = await verifyDevices(remaining);
    remaining = remaining.filter((t) => {
      const after = states.get(t.deviceId);
      if (t.missing && after && after.present && after.error === 0 && after.version) {
        job.installed++;
        job.items.push({ title: t.name, ok: true, engine: 'repair', detail: 'inbox driver store driver installed' });
        jlog(job, '✓ ' + t.name + ' — driver found in the Windows driver store');
        return false;
      }
      return true;
    });
  }
  job.current = '';
  job.percent = 26;

  if (!remaining.length) {
    await installRuntimeTargets(job, runtimeTargets, 30);
    finishJob(job);
    return;
  }

  // ---- phase 2: Microsoft Update Catalog --------------------------------
  jlog(job, 'Phase 2/3 · Microsoft Update Catalog — ' + remaining.length +
    ' device(s) to fetch. This downloads driver packages directly from Microsoft (no Windows Update).');
  const driverEnd = runtimeTargets.length ? 82 : 96;
  const span = driverEnd - job.percent;
  const step = span / Math.max(1, remaining.length);
  let done = 0;
  let catalogBusted = false;

  for (const dev of remaining) {
    if (job.cancelled) break;
    const base = 26 + step * done;
    job.percent = Math.round(base);
    job.current = dev.name;
    job.stage = 'searching';

    // Once the catalog proves unreachable, the rest of the devices fail fast
    // instead of each waiting out a network timeout.
    const acq = catalogBusted
      ? { ok: false, code: 'catalog-down', error: catalogDownReason() }
      : await muc.acquireDriver(dev, {
        job,
        onProgress: (stage, d, detail) => {
          if (job.cancelled) return;
          job.stage = stage === 'downloading' ? 'downloading' : 'searching';
          job.current = d.name + (stage === 'downloading' ? ' — ' + detail : '');
        }
      });
    if (!acq.ok && (acq.code === 'search-failed' || acq.code === 'links-failed' ||
      acq.code === 'download-failed')) {
      catalogBusted = true;
      jlog(job, catalogDownReason());
    }

    if (!acq.ok) {
      job.failed++;
      job.failedDevices.push(dev);
      if (isDriverNetworkFailure(acq.code, acq.error)) job.networkFailed++;
      job.items.push({ title: dev.name, ok: false, engine: 'catalog', detail: acq.error });
      jlog(job, '✕ ' + dev.name + ' — ' + acq.error);
      done++;
      job.percent = Math.round(26 + step * done);
      continue;
    }

    jlog(job, 'Installing: ' + (acq.offer ? acq.offer.title : dev.name));
    job.stage = 'installing';
    job.current = dev.name + ' — installing';
    const inst = await muc.pnputilInstall(acq.folder, { job });
    if (inst.rebootRequired) job.reboot = true;

    if (inst.ok) {
      job.installed++;
      job.items.push({
        title: dev.name, ok: true, engine: 'catalog',
        detail: acq.offer ? acq.offer.title : 'installed from the Update Catalog'
      });
      jlog(job, '✓ ' + dev.name + ' — installed');
    } else {
      // pnputil said no; verify by looking at the device — a staged driver can
      // still have attached even when the console output is ambiguous.
      const after = (await verifyDevices([dev])).get(dev.deviceId);
      if (driverUpdateIsActive(dev, after)) {
        job.installed++;
        job.items.push({ title: dev.name, ok: true, engine: 'catalog', detail: 'verified active after install' });
        jlog(job, '✓ ' + dev.name + ' — verified after install');
      } else {
        job.failed++;
        job.failedDevices.push(dev);
        job.items.push({ title: dev.name, ok: false, engine: 'catalog', detail: (inst.output || 'install failed').slice(0, 200) });
        jlog(job, '✕ ' + dev.name + ' — pnputil did not confirm the install');
      }
    }

    done++;
    job.percent = Math.round(26 + step * done);
  }

  await installRuntimeTargets(job, runtimeTargets, runtimeTargets.length ? 84 : 98);
  finishJob(job);
}

async function demoUpdateAll(job) {
  const scan = lastScan || demoScan();
  const targets = job.targetSnapshot == null ? scanDriverTargets(scan, job.options.onlyMissing) : job.targetSnapshot;
  const runtimes = job.runtimeSnapshot == null ? scanRuntimeTargets(scan) : job.runtimeSnapshot;
  job.driverTotal = targets.length;
  job.runtimeTotal = runtimes.length;
  job.total = targets.length + runtimes.length;
  job.stage = 'repairing';
  jlog(job, '[demo] Local repair first, then Microsoft Update Catalog (Windows Update is not required).');
  await sleep(500);
  job.stage = 'searching';
  jlog(job, '[demo] Matching GPU and device hardware IDs with compatible catalog packages…');
  await sleep(500);
  job.stage = 'downloading'; job.percent = 22;
  jlog(job, '[demo] Downloading driver packages…');
  await sleep(600);
  job.stage = 'installing'; job.percent = 55;
  for (const d of targets) {
    if (job.cancelled) return finishJob(job);
    job.current = d.name;
    await sleep(250);
    job.installed++;
    job.items.push({ title: d.update ? d.update.title : d.name, ok: true, code: 2, engine: 'catalog' });
    jlog(job, '✓ ' + d.name);
  }
  if (runtimes.length) {
    job.stage = 'runtimes';
    for (const runtime of runtimes) {
      if (job.cancelled) return finishJob(job);
      job.current = runtime.name;
      await sleep(250);
      job.runtimeInstalled++;
      job.items.push({ title: runtime.name, ok: true, engine: 'gaming-runtime' });
      jlog(job, '✓ ' + runtime.name);
    }
  }
  finishJob(job);
  jlog(job, '[demo] Simulation only — run the toolbox on Windows to install for real.');
}

module.exports = {
  scanDrivers,
  startUpdateAll,
  retryDriverJob,
  getDriverJob,
  cancelDriverJob,
  publicDriverJob,
  runPwsh,
  // exported for tests
  isPseudoDevice,
  isInstallable,
  normaliseDevice,
  normaliseSystemInfo,
  vendorFromHardwareIds,
  isMicrosoftProvider,
  isSiliconVendor,
  offerIsFromVendor,
  devicePriority,
  sortByInstallPriority,
  graphicsIdentity,
  gamingRole,
  gamingReport,
  gamingRuntimesFromSystem,
  isNewerDriverOffer,
  compareVersion,
  buildSummary,
  isDriverNetworkFailure,
  driverUpdateIsActive
};
