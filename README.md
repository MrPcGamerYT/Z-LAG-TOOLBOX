# Z-LAG Toolbox

A Windows 10/11 desktop toolbox for installing Microsoft Store apps, finding
missing or outdated drivers, and applying performance, privacy, gaming, and
customization tweaks.

[Download the latest release](https://github.com/MrPcGamerYT/Z-LAG-TOOLBOX/releases/latest)
· [Report a problem](https://github.com/MrPcGamerYT/Z-LAG-TOOLBOX/issues)
· [License](LICENSE)

## What is included

### Microsoft Store alternative

- Searches the Microsoft Store, Store Edge, and Display Catalog sources.
- Opens product details and installs without launching the Microsoft Store app.
- Uses licensed fulfillment when required, then FE3 delivery rings and WinGet
  fallbacks where appropriate.
- Downloads packages with resume support and installs AppX/MSIX, MSI, and Win32
  packages through their correct Windows installer paths.
- Keeps failed installs in the job window with a one-click retry that requests
  fresh Store/CDN links after the network connection returns.

### Driver Center

- Enumerates installed hardware and detects missing and outdated drivers.
- Recovers the physical NVIDIA, AMD, or Intel GPU identity from PCI IDs and
  `Win32_VideoController`; CPU identity is shown only as a safe vendor hint
  when Windows exposes no usable GPU hardware ID.
- **Replaces Microsoft inbox drivers with the real vendor package.** On a fresh
  Windows install, Windows binds its own driver (provider “Microsoft
  Corporation”) to integrated graphics, chipset, network and storage devices.
  The device works, so it is neither missing nor a generic fallback — but the
  genuine Intel/AMD/Realtek package is available. Those devices are detected,
  prioritised, and the vendor package is preferred over any Microsoft one.
- Vendor packages always outrank Microsoft packages in catalog selection, even
  when the Microsoft entry is dated newer, because inbox version numbers
  (`10.0.x`, the Windows build) are not comparable with vendor schemes
  (`31.0.101.x`).
- Compares physical display adapters with the newest compatible Microsoft
  Update Catalog package, even when Windows Update is disabled.
- Filters Windows bookkeeping/software nodes so they are not reported as
  impossible “missing driver” problems.
- Detects and installs missing Microsoft DirectX legacy game libraries and the
  current Visual C++ 2015–2022 x64/x86 gaming runtimes.
- Repairs from the local driver store first, then searches and downloads from
  the Microsoft Update Catalog over HTTPS.
- Does not require the Windows Update service, which makes it suitable for
  hardened Windows installations.
- Shows per-device progress, a gaming-readiness summary, and a retry action for
  failed network downloads.

#### Safety and reliability

- **Preflight checks** run before anything is downloaded: administrator
  rights, free disk space, and catalog reachability. Missing administrator
  rights is reported as a clear message up front instead of an install failure
  after a long download. A missing network is a warning only — local repair
  from the Windows driver store still runs offline.
- **Backup before install.** Every job exports the current third-party drivers
  with `pnputil /export-driver` to
  `%ProgramData%\Z-LAG Toolbox\driver-backups\<timestamp>` and creates a system
  restore point before the first change.
- **Post-install health verification with automatic rollback.** A driver that
  installs “successfully” but leaves the device in an error state is detected
  and rolled back automatically, rather than being reported as a success. This
  matters most for graphics drivers, where a bad install means no display.
- **Install ordering.** Missing drivers first, then generic Microsoft stacks,
  then Microsoft-inbox-to-vendor replacements, then ordinary updates — with
  graphics and chipset ahead of peripherals in every band.
- **Per-device installs.** Any single device can be updated on its own instead
  of running the full batch.

### 151 tweaks and presets

- Gaming, performance, networking, privacy, visual, and system categories.
- One-click presets such as Gaming Boost, Privacy Max, Balanced, Clean & Speed
  Up, and Z-LAG Look.
- Apply and revert actions run directly in the app. Explorer is restarted once
  after a batch when needed.
- Restore-point shortcut and clear demo mode on non-Windows systems.

## Desktop runtime and startup reliability

Z-LAG Toolbox is an Electron desktop application. **Chromium is bundled inside
every build**, so Microsoft Edge WebView2 is not a prerequisite and there is no
external web runtime to download before the first window can open. This avoids
the common “missing WebView” bootstrap failure entirely.

The shipped app loads its interface from `file://` and does not start a local
web server. It also includes:

- a stable per-user data directory for installed and portable editions;
- an elevation decision before the single-instance lock;
- elevation through the real portable launcher instead of its temporary inner
  executable;
- a parent/child handoff that waits for the elevated window to become visible;
- automatic removal of obsolete `RUNASADMIN` compatibility flags;
- readable fallback pages and logs instead of silent startup exits;
- automatic software-rendering recovery after a pre-paint GPU crash;
- a lightweight, opaque UI without continuous decorative animation, blur, or
  shimmer, so integrated GPUs and software rendering stay responsive;
- on-demand loading for Store/tweak pages, batched Store results, and renderer
  throttling while the window is hidden;
- renderer sandboxing, a strict Content Security Policy, denied device
  permissions, and blocked in-app navigation.

Startup and renderer logs are written to:

```text
%LOCALAPPDATA%\Z-LAG Toolbox\logs\zlag-main.log
```

## GitHub automatic updates

The recommended NSIS installer checks this repository's GitHub Releases feed
after startup. A new version downloads in the background and the Dashboard
offers **Restart & install** when it is ready.

The portable edition checks the same feed and shows an update notification, but
does not silently replace the executable the user placed on disk. Its update
button opens the matching GitHub release for a new portable download.

Updater releases require these assets, all produced and published by the
release workflow:

- `latest.yml`
- `Z-LAG-Toolbox-Setup-<version>.exe`
- `Z-LAG-Toolbox-Setup-<version>.exe.blockmap`
- `Z-LAG-Toolbox-Portable-<version>.exe`

## Install

Download one of the Windows x64 files from
[Releases](https://github.com/MrPcGamerYT/Z-LAG-TOOLBOX/releases/latest):

| File | Recommended for |
| --- | --- |
| `Z-LAG-Toolbox-Setup-2.1.0.exe` | Start menu/desktop shortcuts, uninstaller, and automatic updates |
| `Z-LAG-Toolbox-Portable-2.1.0.exe` | A removable single-file copy with update notifications |

The application requests administrator access because driver installation and
system-wide tweaks require it. If UAC is declined, the window still opens in
limited mode for browsing and scanning.

> Unsigned community builds can trigger Microsoft SmartScreen until they build
> reputation. Official CI supports Authenticode signing when the repository
> secrets described below are configured.

## Run from source

Requirements:

- Node.js 22.12 or newer
- npm
- Windows for real system changes (Linux/macOS run the safe demo mode)

```bash
npm ci
npm run check
npm start
```

For browser-only UI development, run the optional local development server:

```bash
npm run dev:web
```

The packaged desktop application never runs this server.

## Build Windows releases

```bash
npm run build:installer  # NSIS installer and updater metadata
npm run build:portable   # portable executable
npm run build:all        # both release formats
```

Artifacts are written to `dist-installer/`.

### Automated release

The publish-ready workflow is provided as [`WORKFLOW-UPDATE.yml`](WORKFLOW-UPDATE.yml)
because automation accounts without GitHub's Workflows permission cannot modify
`.github/workflows/` directly. A repository maintainer must manually copy it over
`.github/workflows/build-release.yml` once. The template runs tests, syntax
checks and a production audit, builds both Windows targets, verifies
`latest.yml`, uploads the updater metadata, and creates a GitHub Release.

After installing the workflow, use either method:

1. **Actions → Build & Release Windows App → Run workflow**, optionally entering
   a semantic version such as `2.1.0`; or
2. push a semantic version tag:

```bash
git tag v2.1.0
git push origin v2.1.0
```

For Authenticode-signed builds, configure these optional repository secrets:

- `WINDOWS_CSC_LINK` — base64 certificate or secure certificate URL
- `WINDOWS_CSC_KEY_PASSWORD` — certificate password

Never commit signing certificates or passwords to this repository.

## Architecture

```text
electron/main.js       BrowserWindow, startup lifecycle, IPC, updater
  ├─ electron/launch.js       elevation, portable paths, crash recovery
  ├─ electron/updater.js      GitHub/NSIS update state machine
  └─ electron/preload.js      sandboxed renderer bridge
            │
            ▼
server/core.js          shared request dispatcher
  ├─ server/store/             Store catalog/download/install pipeline
  ├─ server/drivers.js         device scan and driver update jobs
  └─ server/data/              apps, presets, and 151 tweaks
            │
            ▼
public/                 local HTML, CSS, SVG assets, and renderer logic
```

`server/server.js` is only an HTTP wrapper for development. Desktop requests go
through context-isolated IPC directly to `server/core.js`.

## Safety

System tweaks can make aggressive machine-wide changes. Create a restore point,
review the selected actions, and keep backups before applying a large preset.
Driver packages should be reviewed when working with unusual or unsupported
hardware. Use this software at your own risk.

## License

Copyright © 2026 MrPcGamerYT. All rights reserved.

Permission is granted to use and run this software as-is. Modification, redistribution, and reuse of any portion of the source code, assets, or binaries are strictly prohibited without express prior written permission. See [LICENSE](LICENSE) for the full license agreement.
