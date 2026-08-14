'use strict';

/**
 * Microsoft Store catalog + FE3 delivery (Alt App Installer pipeline).
 *
 *  1. Parse product id from a Store *website* URL (never ms-windows-store:)
 *  2. Display Catalog / storeedgefd → WuCategoryId + PackageFamilyName
 *  3. FE3 Delivery Optimization SOAP → package list + download URLs
 *  4. Keep latest build for the user's arch, preferring decrypted
 *     types (appx / msix / *bundle) that install without admin.
 */

const fs = require('fs');
const path = require('path');
const { requestJson, requestText } = require('./http');
const { parseXml } = require('./xmlparse');

const XML_DIR = path.join(__dirname, 'xml');
const FAV_TYPES = new Set(['appx', 'msix', 'msixbundle', 'appxbundle']);
const MARKET = 'US';
const LOCALE = 'en-us';

/**
 * Every FE3 FlightRing we know Microsoft will answer for. Retail first;
 * Insider / preview rings unlock packages that Retail SyncUpdates hides.
 * Used for both SyncUpdates (package list) and GetExtendedUpdateInfo2 (CDN).
 */
const FE3_RINGS = ['Retail', 'RP', 'WIS', 'WIF', 'Beta', 'Canary', 'Dev', 'External'];
const SEARCH_LIMIT = 160;

function uniqueRings(preferred) {
  const first = preferred && String(preferred).trim();
  return [first].concat(FE3_RINGS).filter((r, i, a) => r && a.indexOf(r) === i);
}

/** Pull WuCategoryId / PackageFamilyName out of any Microsoft catalog shape. */
function parseFulfillmentBlob(raw) {
  if (!raw) return null;
  let fd = raw;
  if (typeof fd === 'string') {
    try { fd = JSON.parse(fd); } catch (_) { return null; }
  }
  if (typeof fd !== 'object') return null;
  const wu = fd.WuCategoryId || fd.wuCategoryId || fd.WuCategoryID || null;
  const fam = fd.PackageFamilyName || fd.packageFamilyName || fd.PackageFamily || null;
  if (!wu && !fam) return null;
  return { WuCategoryId: wu || null, PackageFamilyName: fam || null };
}

function extractFulfillment(product) {
  if (!product || typeof product !== 'object') return null;
  const direct = parseFulfillmentBlob(product.FulfillmentData || product.fulfillment);
  if (direct && direct.WuCategoryId) return direct;
  const skus = [];
  if (Array.isArray(product.DisplaySkuAvailabilities)) {
    for (const row of product.DisplaySkuAvailabilities) {
      if (row && row.Sku) skus.push(row.Sku);
    }
  }
  if (Array.isArray(product.Skus)) skus.push.apply(skus, product.Skus);
  if (product.Sku) skus.push(product.Sku);
  for (const sku of skus) {
    if (!sku) continue;
    const hit = parseFulfillmentBlob(sku.FulfillmentData || sku.Fulfillment || sku.fulfillmentData);
    if (hit && (hit.WuCategoryId || hit.PackageFamilyName)) return hit;
  }
  return direct;
}

const FEATURED = [
  { productId: '9NCBCSZSJRSB', name: 'Spotify', publisher: 'Spotify AB', icon: '🎵', category: 'Music', isGame: false },
  { productId: '9NKSQGP7F2NH', name: 'WhatsApp', publisher: 'WhatsApp Inc', icon: '💬', category: 'Social', isGame: false },
  { productId: '9WZDNCRFJ3TJ', name: 'Netflix', publisher: 'Netflix, Inc.', icon: '🎬', category: 'Entertainment', isGame: false },
  { productId: '9N0DX20HK701', name: 'Windows Terminal', publisher: 'Microsoft', icon: '⌨️', category: 'Developer', isGame: false },
  { productId: '9MZ1SNWT0N5D', name: 'PowerToys', publisher: 'Microsoft', icon: '🧰', category: 'Utilities', isGame: false },
  { productId: '9P1J8S7CCWWT', name: 'Clipchamp', publisher: 'Microsoft', icon: '✂️', category: 'Photo & video', isGame: false },
  { productId: '9WZDNCRFJBH4', name: 'Calculator', publisher: 'Microsoft', icon: '🧮', category: 'Utilities', isGame: false },
  { productId: '9NBLGGH4NNS1', name: 'Ubuntu', publisher: 'Canonical', icon: '🐧', category: 'Developer', isGame: false },
  { productId: '9WZDNCRFHVQL', name: 'OneNote', publisher: 'Microsoft', icon: '📓', category: 'Productivity', isGame: false },
  { productId: '9NBLGGH537BL', name: 'Telegram Desktop', publisher: 'Telegram FZ-LLC', icon: '✈️', category: 'Social', isGame: false },
  { productId: '9N4P75DXL6FG', name: 'Discord', publisher: 'Discord Inc.', icon: '🎮', category: 'Social', isGame: false },
  { productId: '9WZDNCRFJBMP', name: 'Movies & TV', publisher: 'Microsoft', icon: '🎞️', category: 'Entertainment', isGame: false },
  { productId: '9NBLGGH4V46H', name: 'Instagram', publisher: 'Instagram', icon: '📷', category: 'Social', isGame: false },
  { productId: '9WZDNCRFHWKN', name: 'Mail and Calendar', publisher: 'Microsoft', icon: '✉️', category: 'Productivity', isGame: false },
  { productId: '9NBLGGH5L9XT', name: 'Adobe Photoshop Express', publisher: 'Adobe', icon: '🖼️', category: 'Photo & video', isGame: false },
  { productId: '9WZDNCRFJ3P2', name: 'Microsoft Solitaire', publisher: 'Microsoft', icon: '🃏', category: 'Card & board', isGame: true },
  { productId: '9PGW18NPBZV5', name: 'Minecraft Launcher', publisher: 'Mojang / Microsoft', icon: '🧱', category: 'Action & adventure', isGame: true },
  { productId: '9NXP44L49SHJ', name: 'Minecraft: Java & Bedrock', publisher: 'Mojang / Microsoft', icon: '⛏️', category: 'Action & adventure', isGame: true },
  { productId: '9P2N57MC619K', name: 'Sea of Thieves', publisher: 'Rare / Xbox', icon: '🏴‍☠️', category: 'Action & adventure', isGame: true },
  { productId: '9NBLGGH42THS', name: 'Asphalt 9: Legends', publisher: 'Gameloft', icon: '🏎️', category: 'Racing & flying', isGame: true },
  { productId: '9NBLGGH18846', name: 'Candy Crush Soda Saga', publisher: 'King', icon: '🍬', category: 'Puzzle', isGame: true },
  { productId: '9NBLGGH4R32N', name: 'Forza Horizon 4', publisher: 'Playground Games', icon: '🚗', category: 'Racing & flying', isGame: true },
  { productId: '9N2Z14PQ8G67', name: 'Roblox', publisher: 'Roblox Corporation', icon: '🧩', category: 'Family & kids', isGame: true },
  { productId: '9NBLGGH537C8', name: 'Age of Empires', publisher: "Xbox Game Studios", icon: '🏰', category: 'Strategy', isGame: true },
  { productId: '9N1F50D1B0B5', name: 'Microsoft Flight Simulator', publisher: 'Asobo / Xbox', icon: '✈️', category: 'Simulation', isGame: true },
  { productId: '9N9M2SQB55L6', name: 'Fortnite', publisher: 'Epic Games', icon: '🪂', category: 'Shooter', isGame: true },
  { productId: '9NBLGGH1ZLX6', name: 'Halo', publisher: '343 Industries', icon: '🪖', category: 'Shooter', isGame: true },
  { productId: '9WZDNCRFHWKN', name: 'Mail and Calendar', publisher: 'Microsoft', icon: '📨', category: 'Productivity', isGame: false }
];

const STORE_CHIPS = [
  { id: 'all', label: 'All', kind: 'all' },
  { id: 'apps', label: 'Apps', kind: 'apps' },
  { id: 'games', label: 'Games', kind: 'games' },
  { id: 'Productivity', label: 'Productivity', kind: 'apps', category: 'Productivity' },
  { id: 'Social', label: 'Social', kind: 'apps', category: 'Social' },
  { id: 'Entertainment', label: 'Entertainment', kind: 'apps', category: 'Entertainment' },
  { id: 'Utilities', label: 'Utilities', kind: 'apps', category: 'Utilities & tools' },
  { id: 'Developer', label: 'Developer', kind: 'apps', category: 'Developer tools' },
  { id: 'Photo & video', label: 'Photo & video', kind: 'apps', category: 'Photo & video' },
  { id: 'Music', label: 'Music', kind: 'apps', category: 'Music' },
  { id: 'Action & adventure', label: 'Action', kind: 'games', category: 'Action & adventure' },
  { id: 'Racing & flying', label: 'Racing', kind: 'games', category: 'Racing & flying' },
  { id: 'Sports', label: 'Sports', kind: 'games', category: 'Sports' },
  { id: 'Puzzle', label: 'Puzzle', kind: 'games', category: 'Puzzle' },
  { id: 'Strategy', label: 'Strategy', kind: 'games', category: 'Strategy' },
  { id: 'Shooter', label: 'Shooter', kind: 'games', category: 'Shooter' }
];

function osArch() {
  const a = String(process.arch || '').toLowerCase();
  if (a === 'x64' || a === 'amd64') return 'x64';
  if (a === 'ia32' || a === 'x32' || a === 'x86') return 'x86';
  if (a === 'arm64') return 'arm64';
  if (a === 'arm') return 'arm';
  return 'x64';
}

function storeUrl(productId) {
  return 'https://apps.microsoft.com/detail/' + String(productId).toLowerCase();
}

/** Pull a Store product id out of a website URL, ms-windows-store link, or raw id. */
function parseProductId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^(9[0-9A-Z]{11}|XP[0-9A-Z]{10,})$/i.test(raw)) return raw.toUpperCase();
  const fromQuery = raw.match(/[?&](?:productid|productId|id)=([0-9A-Z]+)/i);
  if (fromQuery) return fromQuery[1].toUpperCase();
  const fromPath = raw.match(/\/(?:detail|productid|p|store\/detail\/[^/]+)\/([0-9A-Z]{12}|XP[0-9A-Z]+)/i)
    || raw.match(/\/([9][0-9A-Z]{11}|XP[0-9A-Z]{10,})(?:[/?#]|$)/i);
  if (fromPath) return fromPath[1].toUpperCase();
  const tail = raw.match(/\/([^/?#]+)(?:[?#]|$)/);
  if (tail && /^(9[0-9A-Z]{11}|XP[0-9A-Z]{10,})$/i.test(tail[1])) return tail[1].toUpperCase();
  return null;
}

function cleanName(bad) {
  return String(bad || '').replace(/[^A-Za-z]/g, '').toLowerCase();
}

/**
 * winget `InstallerType` → the extension the downloaded file must have ON DISK.
 *
 * This map is the fix for the "installed app does not open" bug. The manifest
 * type is a *technology* name (`nullsoft`, `inno`, `wix`, `burn`, `portable`),
 * NOT a file extension. Writing it verbatim produced files called
 * `rufus.portable` / `notepadplusplus.nullsoft`; Windows has no association for
 * those, so double-clicking them (or Start-Process) fails and the shell reports
 * "There's a problem with <app>. Reinstall the application from its original
 * install location…". Every Win32 technology below is delivered as a plain
 * .exe, MSI-based ones as .msi, and archives as .zip.
 *
 * Enum source: winget manifest schema `InstallerType`.
 */
const INSTALLER_TYPE_EXT = {
  exe: 'exe',
  inno: 'exe',
  nullsoft: 'exe',
  burn: 'exe',      // WiX Burn bundles ship as .exe, not .msi
  portable: 'exe',
  pwa: 'exe',
  msstore: 'exe',
  msi: 'msi',
  wix: 'msi',       // WiX (non-burn) emits a plain MSI database
  zip: 'zip',
  font: 'ttf',
  msix: 'msix',
  appx: 'appx',
  msixbundle: 'msixbundle',
  appxbundle: 'appxbundle'
};

/** Extensions we accept when sniffing one out of a CDN URL. */
const KNOWN_EXT = new Set([
  'exe', 'msi', 'msp', 'zip', '7z', 'msix', 'appx', 'msixbundle', 'appxbundle',
  'eappx', 'emsix', 'eappxbundle', 'emsixbundle', 'ttf', 'otf'
]);

/**
 * The real extension of the payload behind an installer URL, if it has one.
 * Preferred over the manifest type because it is what the bytes actually are —
 * e.g. a `portable` entry whose URL ends in `.zip` really is a zip.
 */
function extFromUrl(url) {
  const raw = String(url || '');
  // Strip query/fragment before looking at the last path segment.
  const pathOnly = raw.split(/[?#]/)[0];
  const seg = pathOnly.split('/').pop() || '';
  const m = seg.match(/\.([A-Za-z0-9]{2,12})$/);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  return KNOWN_EXT.has(ext) ? ext : '';
}

/** Resolve the on-disk extension for one manifest installer entry. */
function installerExt(installer) {
  const declared = String((installer && installer.InstallerType) || '').toLowerCase();
  const nested = String((installer && installer.NestedInstallerType) || '').toLowerCase();
  // A URL that names a real package type wins — it cannot be wrong.
  const fromUrl = extFromUrl(installer && installer.InstallerUrl);
  if (fromUrl) return fromUrl;
  if (INSTALLER_TYPE_EXT[declared]) return INSTALLER_TYPE_EXT[declared];
  if (INSTALLER_TYPE_EXT[nested]) return INSTALLER_TYPE_EXT[nested];
  return 'exe';
}

/**
 * A human-readable, filesystem-safe base name for a downloaded installer.
 *
 * `cleanName()` throws away digits, dots and separators, which is fine for the
 * fuzzy package-family matching it was written for but destroys real file
 * names ("Notepad++ 8.6" → "notepad"). Downloads keep their identity here.
 */
function fileBaseName(name, fallback) {
  let s = String(name || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')   // path-illegal characters
    .replace(/[.\s]+$/g, '')                   // Windows drops trailing dot/space
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) s = String(fallback || 'installer').replace(/[^A-Za-z0-9._-]/g, '') || 'installer';
  return s.slice(0, 120);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlAttr(tag, name) {
  const m = String(tag).match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : '';
}

function fillTemplate(tpl, a, b, c) {
  return tpl
    .replace(/\{0\}/g, a)
    .replace(/\{1\}/g, b)
    .replace(/\{2\}/g, c);
}

function parseIso(iso) {
  if (!iso) return new Date(0);
  let s = String(iso);
  if (s.endsWith('Z')) s = s.slice(0, -1) + '+00:00';
  s = s.replace(/(\.\d{6})\d+/, '$1');
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function parseVer(v) {
  return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
}

function cmpVer(a, b) {
  const aa = parseVer(a), bb = parseVer(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const d = (aa[i] || 0) - (bb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function selectLatest(list, currArch, ignoreVer) {
  const score = (item) => {
    const [arch, ext, modified, version] = item;
    const archScore = arch === currArch ? 2 : (arch === 'neutral' ? 1 : 0);
    const typeScore = FAV_TYPES.has(ext) ? 1 : 0;
    if (ignoreVer) return [archScore, typeScore, 0, 0];
    return [archScore, typeScore, parseIso(modified).getTime(), parseVer(version)];
  };
  const cmp = (a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (Array.isArray(sa[i])) {
        const d = cmpVer(a[3], b[3]);
        if (d) return d;
      } else if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return 0;
  };
  let candidates = list.filter((it) => it[0] === currArch || it[0] === 'neutral');
  if (!candidates.length) candidates = list.slice();
  return candidates.reduce((best, cur) => (cmp(cur, best) > 0 ? cur : best));
}

function parseFileKey(key) {
  const temp = String(key).split('_');
  const last = temp[temp.length - 1] || '';
  // Take the LAST dot-segment. `split('.')[1]` used to grab the wrong piece on
  // names with several dots (e.g. "…_VCLibs.140.00.appx" → "140"), which then
  // travelled all the way down to the file on disk and to isBundle().
  const dot = last.lastIndexOf('.');
  const ext = (dot === -1 ? '' : last.slice(dot + 1)).toLowerCase();
  return {
    pkg: cleanName(temp[0]),
    version: temp[1] || '0',
    arch: String(temp[2] || 'neutral').toLowerCase(),
    ext
  };
}

function pickPackages(nameModified, familyPrefix, currArch, ignoreVer, allDeps) {
  const full = {};
  const blockMap = /\.BlockMap/i;
  for (const [key, modified] of Object.entries(nameModified)) {
    if (blockMap.test(key)) continue;
    const p = parseFileKey(key);
    const tuple = [p.pkg, p.arch, p.ext, modified, p.version];
    full[tuple.join('\u0001')] = { key, tuple: [p.arch, p.ext, modified, p.version], pkg: p.pkg };
  }
  const byPkg = {};
  for (const rec of Object.values(full)) {
    (byPkg[rec.pkg] = byPkg[rec.pkg] || []).push(rec);
  }
  const want = cleanName(familyPrefix);
  let mainPkg = null;
  for (const pkg of Object.keys(byPkg)) {
    if (want && pkg.includes(want)) { mainPkg = pkg; break; }
  }
  if (!mainPkg) mainPkg = Object.keys(byPkg)[0];
  const chosen = [];
  let mainKey = null;
  let fileArch = currArch;
  if (mainPkg && byPkg[mainPkg]) {
    const best = selectLatest(byPkg[mainPkg].map((r) => r.tuple), currArch, ignoreVer);
    const rec = byPkg[mainPkg].find((r) => r.tuple.every((v, i) => v === best[i]));
    if (rec) {
      mainKey = rec.key;
      fileArch = rec.tuple[0] === 'neutral' ? currArch : rec.tuple[0];
      chosen.push(rec.key);
    }
    delete byPkg[mainPkg];
  }
  for (const pkg of Object.keys(byPkg)) {
    if (allDeps) {
      for (const rec of byPkg[pkg]) chosen.push(rec.key);
    } else {
      const best = selectLatest(byPkg[pkg].map((r) => r.tuple), fileArch, ignoreVer);
      const rec = byPkg[pkg].find((r) => r.tuple.every((v, i) => v === best[i]));
      if (rec) chosen.push(rec.key);
    }
  }
  if (mainKey) {
    const rest = chosen.filter((k) => k !== mainKey);
    rest.push(mainKey);
    return { files: rest, mainFile: mainKey };
  }
  return { files: chosen, mainFile: chosen[0] || null };
}

/**
 * Parse a SyncUpdates response into { fileName -> Modified } and
 * { fileName -> {updateId, revision} }.
 *
 * Response shape (namespaces and noise removed):
 *
 *   <SyncUpdatesResult>
 *     <NewUpdates>
 *       <UpdateInfo>
 *         <ID>3000</ID>                     ← the join key
 *         <Xml>  (escaped)
 *           <UpdateIdentity UpdateID="…" RevisionNumber="…"/>
 *           <Properties><SecuredFragment/></Properties>
 *         </Xml>
 *       </UpdateInfo>
 *     </NewUpdates>
 *     <ExtendedUpdateInfo>
 *       <Updates>
 *         <Update>
 *           <ID>3000</ID>                   ← same key
 *           <Xml> (escaped)
 *             <Files><File FileName="…" InstallerSpecificIdentifier="…"
 *                          Modified="…"/></Files>
 *           </Xml>
 *         </Update>
 *       </Updates>
 *     </ExtendedUpdateInfo>
 *   </SyncUpdatesResult>
 *
 * The file names and the update identities therefore live in two *different*
 * subtrees and are related only through <ID>. The previous implementation
 * chopped the document on "<UpdateInfo" and read whichever UpdateID/FileName
 * happened to fall in the same chunk, which paired a package with the wrong
 * update. GetExtendedUpdateInfo2 was then asked for the link of an update
 * that carries no payload and dutifully answered with an empty
 * <FileLocation> list on every ring — the reported
 * "Microsoft did not return a download link for this package … Tried rings
 * Retail, RP, WIS, WIF" error. Joining on <ID>, like Alt App Installer and
 * StoreLib do, is what makes the lookup return a real CDN url.
 */
function parseFe3Sync(xml) {
  // The interesting fragments are XML-escaped inside <Xml> elements, so a
  // single unescape turns the whole answer into one walkable tree.
  const doc = parseXml(unescapeXml(String(xml || '')));

  // ---- 1. id -> {fileName, modified} from every <File> we can see ---------
  const filesById = new Map();
  for (const file of doc.getElementsByTagName('File')) {
    const ident = file.attr('InstallerSpecificIdentifier');
    const fileName = file.attr('FileName');
    if (!ident || !fileName) continue;
    // A package and its .BlockMap side file share one update. Keep the
    // package: the BlockMap is only an integrity manifest and installing it
    // is meaningless, but it would otherwise claim the update's slot.
    if (/\.blockmap$/i.test(fileName)) continue;
    const owner = file.closest('Update') || file.closest('UpdateInfo');
    if (!owner) continue;
    const idNode = owner.firstChild('ID');
    const id = idNode ? idNode.ownText : '';
    if (!id) continue;
    filesById.set(id, {
      name: ident + '_' + fileName,
      modified: file.attr('Modified') || ''
    });
  }

  // ---- 2. id -> {updateId, revision} for updates that can yield a url ----
  // Only updates carrying <SecuredFragment> have a downloadable payload;
  // that is exactly the filter StoreLib applies.
  const identsById = new Map();
  const collect = (idNode, identity) => {
    if (!idNode || !identity) return;
    const id = idNode.ownText;
    const updateId = identity.attr('UpdateID');
    const revision = identity.attr('RevisionNumber');
    if (!id || !updateId || !revision) return;
    if (!identsById.has(id)) identsById.set(id, { updateId, revision });
  };
  for (const frag of doc.getElementsByTagName('SecuredFragment')) {
    const owner = frag.closest('UpdateInfo') || frag.closest('Update');
    if (!owner) continue;
    collect(owner.firstChild('ID'), owner.getElementsByTagName('UpdateIdentity')[0]);
  }
  // Fallback for responses that omit <SecuredFragment>: take any update that
  // still exposes an <UpdateIdentity>.
  for (const owner of doc.getElementsByTagName('UpdateInfo')) {
    collect(owner.firstChild('ID'), owner.getElementsByTagName('UpdateIdentity')[0]);
  }

  // ---- 3. join ------------------------------------------------------------
  const nameModified = {};
  const identities = {};
  for (const [id, file] of filesById) {
    const ident = identsById.get(id);
    if (!ident) continue;
    nameModified[file.name] = file.modified;
    identities[file.name] = ident;
  }
  return { nameModified, identities };
}

/**
 * Pull every <FileLocation><Url> out of a GetExtendedUpdateInfo2 response and
 * pick the one that is an actual package payload.
 *
 * A response typically carries several locations for one update:
 *   • the package itself on a Delivery-Optimization / Windows Update CDN
 *   • the .BlockMap and app catalog side files
 *   • short opaque "emd" tokens used for encrypted delivery
 *
 * The old code kept "the first url whose length is not exactly 99", which is
 * a brittle heuristic copied from a Python script: any CDN change in the URL
 * layout made it return a BlockMap link or, when every URL happened to be 99
 * chars, `null` — surfacing as "FE3 returned no file URL for <guid>".
 * We now score candidates instead, so we always return the best real payload.
 */
const PAYLOAD_HOSTS = [
  'tlu.dl.delivery.mp.microsoft.com',
  'dl.delivery.mp.microsoft.com',
  'download.windowsupdate.com',
  'catalog.update.microsoft.com',
  'au.download.windowsupdate.com',
  'assets1.xboxlive.com',
  'assets2.xboxlive.com'
];

function scoreFileUrl(u) {
  let score = 0;
  const lower = u.toLowerCase();
  if (/^https?:\/\//i.test(u)) score += 2;
  if (PAYLOAD_HOSTS.some((h) => lower.includes(h))) score += 6;
  // Side files are never what we want to install.
  if (/\.blockmap(\?|$)/i.test(lower)) score -= 12;
  if (/\.cat(\?|$)/i.test(lower)) score -= 8;
  if (/appxsignature|\.p7x(\?|$)/i.test(lower)) score -= 8;
  // Real package payloads carry a signed query string and are long.
  if (lower.includes('?')) score += 2;
  if (u.length > 120) score += 2;
  // The historical 99-char token is an encrypted-metadata link, not a payload.
  if (u.length === 99) score -= 5;
  return score;
}

function parseFileUrls(xml) {
  const doc = parseXml(unescapeXml(String(xml || '')));
  const urls = [];
  const seen = new Set();
  const push = (raw) => {
    const u = String(raw || '').trim();
    if (!u || seen.has(u) || !/^https?:\/\//i.test(u)) return;
    seen.add(u);
    urls.push(u);
  };
  // Preferred shape: <FileLocation><Url>…</Url></FileLocation>
  for (const loc of doc.getElementsByTagName('FileLocation')) {
    const url = loc.firstChild('Url');
    if (url) push(url.text);
  }
  // Fallback: some responses inline <Url> without a FileLocation wrapper.
  if (!urls.length) {
    for (const url of doc.getElementsByTagName('Url')) push(url.text);
  }
  if (!urls.length) return null;
  let best = urls[0];
  let bestScore = scoreFileUrl(best);
  for (const u of urls.slice(1)) {
    const s = scoreFileUrl(u);
    if (s > bestScore) { best = u; bestScore = s; }
  }
  return best;
}

/** Read the human-readable reason out of a SOAP fault so errors are useful. */
function parseSoapFault(xml) {
  if (!xml) return '';
  const text = unescapeXml(String(xml));
  const reason = text.match(/<(?:s:)?Text[^>]*>([\s\S]*?)<\/(?:s:)?Text>/i) ||
    text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i) ||
    text.match(/<ErrorCode>([\s\S]*?)<\/ErrorCode>/i);
  return reason ? reason[1].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

const FE3_HOSTS = [
  'https://fe3cr.delivery.mp.microsoft.com',
  'https://fe3.delivery.mp.microsoft.com',
  'https://fe2cr.update.microsoft.com'
];

function uuid() {
  const b = require('crypto').randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
    h.slice(16, 20) + '-' + h.slice(20);
}

/**
 * WS-Addressing and WS-Security are strict: the <a:To> in the envelope must
 * match the endpoint we actually POST to, the <a:MessageID> must be unique,
 * and the security <Timestamp> must be current. The stored templates were
 * hardcoded to the fe3cr host with a MessageID and a 2017 timestamp, so every
 * request to the fallback host — and any request once the clock skew check
 * kicked in — came back as a SOAP fault with no <FileLocation> at all.
 */
function prepareEnvelope(xml, endpoint) {
  let out = String(xml);
  out = out.replace(/(<a:To[^>]*>)[\s\S]*?(<\/a:To>)/i, '$1' + endpoint + '$2');
  out = out.replace(/(<a:MessageID>)[\s\S]*?(<\/a:MessageID>)/i, '$1urn:uuid:' + uuid() + '$2');
  const now = new Date();
  const created = new Date(now.getTime() - 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const expires = new Date(now.getTime() + 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  out = out.replace(/(<Created>)[\s\S]*?(<\/Created>)/i, '$1' + created + '$2');
  out = out.replace(/(<Expires>)[\s\S]*?(<\/Expires>)/i, '$1' + expires + '$2');
  return out;
}

async function fe3Post(pathSuffix, body) {
  const errors = [];
  for (const host of FE3_HOSTS) {
    const endpoint = host + pathSuffix;
    try {
      return await requestText(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'User-Agent': 'Windows-Update-Agent/10.0.10011.16384 Client-Protocol/2.71'
        },
        body: prepareEnvelope(body, endpoint),
        timeout: 60000,
        limit: 40 * 1024 * 1024
      });
    } catch (e) {
      const fault = parseSoapFault(e && e.body);
      errors.push(host.replace(/^https:\/\//, '') + ': ' + (fault || (e && e.message) || 'failed'));
    }
  }
  throw new Error('FE3 Delivery Optimization unreachable — ' + errors.join(' | '));
}

async function fe3Cookie() {
  const body = fs.readFileSync(path.join(XML_DIR, 'GetCookie.xml'), 'utf8');
  const r = await fe3Post('/ClientWebService/client.asmx', body);
  const m = r.text.match(/<EncryptedData>([^<]+)<\/EncryptedData>/);
  if (!m) {
    const fault = parseSoapFault(r.text);
    throw new Error('FE3 refused to issue a cookie' + (fault ? ' — ' + fault : ''));
  }
  return m[1];
}

async function fe3Sync(cookie, catId, releaseType) {
  const tpl = fs.readFileSync(path.join(XML_DIR, 'WUIDRequest.xml'), 'utf8');
  const body = fillTemplate(tpl, xmlEscape(cookie), xmlEscape(catId), xmlEscape(releaseType));
  const r = await fe3Post('/ClientWebService/client.asmx', body);
  const parsed = parseFe3Sync(r.text);
  if (!Object.keys(parsed.nameModified).length) {
    parsed.fault = parseSoapFault(r.text);
  }
  parsed.ring = releaseType;
  return parsed;
}

/**
 * SyncUpdates on Retail often returns an empty package list for titles that
 * only publish to Insider rings. Walk every FlightRing until one answers.
 */
async function fe3SyncAnyRing(cookie, catId, preferred) {
  const rings = uniqueRings(preferred);
  const problems = [];
  for (const ring of rings) {
    let sync;
    try {
      sync = await fe3Sync(cookie, catId, ring);
    } catch (e) {
      problems.push(ring + ': ' + ((e && e.message) || 'sync failed'));
      continue;
    }
    if (Object.keys(sync.nameModified).length) return sync;
    problems.push(ring + ': ' + (sync.fault || 'no packages'));
  }
  const err = new Error('Microsoft returned no packages for this product across FE3 rings ' +
    rings.join(', ') + '. ' + problems.join(' | '));
  err.code = 'FE3_NO_PACKAGES';
  throw err;
}

/**
 * Ask FE3 for the CDN download link of one update.
 *
 * Retries across release rings because a package published only to Retail
 * returns an empty FileLocation list when queried on the ring the caller
 * guessed — the old code treated that empty list as a hard failure and threw
 * "FE3 returned no file URL for <updateId>".
 */
/**
 * Full Windows-Update client attribute string, as sent by StoreLib. Some
 * updates are only handed out when the caller looks like a real WU client;
 * the bare `FlightRing=…;` string Alt App Installer sends is enough for the
 * common case, so we try that first and keep this as the fallback.
 */
function deviceAttributes(ring) {
  return [
    'BranchReadinessLevel=CB', 'CurrentBranch=rs_prerelease',
    'OEMModel=Virtual Machine', 'FlightRing=' + ring, 'AttrDataVer=21',
    'SystemManufacturer=Microsoft Corporation', 'InstallLanguage=en-US',
    'OSUILocale=en-US', 'InstallationType=Client',
    'FlightingBranchName=external', 'FirmwareVersion=Hyper-V UEFI Release v2.5',
    'SystemProductName=Virtual Machine', 'OSSkuId=48', 'FlightContent=Branch',
    'App=WU', 'OEMName_Uncleaned=Microsoft Corporation',
    'AppVer=10.0.16184.1001', 'OSArchitecture=AMD64', 'SystemSKU=None',
    'UpdateManagementGroup=2', 'IsFlightingEnabled=1', 'IsDeviceRetailDemo=0',
    'TelemetryLevel=3', 'OSVersion=10.0.16184.1001', 'DeviceFamily=Windows.Desktop'
  ].join(';') + ';';
}

async function fe3FileUrl(updateId, revision, releaseType) {
  const tpl = fs.readFileSync(path.join(XML_DIR, 'FE3FileUrl.xml'), 'utf8');
  const rings = uniqueRings(releaseType);
  const problems = [];
  for (const ring of rings) {
    // Attempt 1 mirrors Alt App Installer byte for byte (`FlightRing=<ring>;`);
    // attempt 2 upgrades deviceAttributes to a full WU client fingerprint,
    // which unlocks updates the short form is refused for.
    for (const full of [false, true]) {
      let body = fillTemplate(tpl, xmlEscape(updateId), xmlEscape(revision), xmlEscape(ring));
      if (full) {
        body = body.replace(
          /(<deviceAttributes>)[\s\S]*?(<\/deviceAttributes>)/i,
          '$1' + xmlEscape(deviceAttributes(ring)) + '$2'
        );
      }
      const tag = ring + (full ? '+attrs' : '');
      let r;
      try {
        r = await fe3Post('/ClientWebService/client.asmx/secured', body);
      } catch (e) {
        problems.push(tag + ': ' + e.message);
        continue;
      }
      const url = parseFileUrls(r.text);
      if (url) return url;
      problems.push(tag + ': ' + (parseSoapFault(r.text) || 'no FileLocation in response'));
    }
  }
  const err = new Error('Microsoft did not return a download link for this package (update ' +
    String(updateId).slice(0, 8) + '…). Tried rings ' + rings.join(', ') + '. ' + problems.join(' | '));
  err.code = 'FE3_NO_URL';
  err.updateId = updateId;
  throw err;
}

function pickImage(images) {
  if (!Array.isArray(images)) return '';
  const order = ['logo', 'Logo', 'tile', 'Poster', 'BoxArt', 'screenshot'];
  for (const t of order) {
    const hit = images.find((i) => String(i.imageType || i.ImageType || '').toLowerCase() === t.toLowerCase() && i.url);
    if (hit) return hit.url;
  }
  return (images[0] && (images[0].url || images[0].Url)) || '';
}

function normalizeSearchHit(p) {
  const id = String(p.productId || p.ProductId || p.PackageIdentifier || '').toUpperCase();
  if (!id) return null;
  const isGame = !!(p.isGame || p.isCoreGame || p.isGamingAppOnly ||
    String(p.productFamilyName || '').toLowerCase() === 'games');
  return {
    productId: id,
    name: p.title || p.Title || p.PackageName || id,
    publisher: p.publisherName || p.PublisherName || p.Publisher || 'Microsoft Store',
    icon: p.iconUrl || p.posterArtUrl || p.boxArtUrl || pickImage(p.images || p.Images) || '',
    desc: String(p.description || p.Description || '').replace(/\s+/g, ' ').slice(0, 220),
    category: (p.categories && p.categories[0]) || p.productFamilyName || (isGame ? 'Games' : 'Apps'),
    isGame,
    price: p.displayPrice || p.DisplayPrice || (p.price === 0 ? 'Free' : ''),
    rating: p.averageRating || p.AverageRating || null,
    url: storeUrl(id)
  };
}

const DEMO_POOL = FEATURED.map((f) => Object.assign({
  desc: f.name + ' — available from the Microsoft catalog.',
  price: 'Free',
  rating: 4.4,
  url: storeUrl(f.productId)
}, f));

function filterDemo(q, opts) {
  opts = opts || {};
  const ql = String(q || '').toLowerCase().trim();
  let hits = DEMO_POOL.slice();
  if (opts.kind === 'games') hits = hits.filter((a) => a.isGame);
  if (opts.kind === 'apps') hits = hits.filter((a) => !a.isGame);
  if (opts.category) {
    const c = String(opts.category).toLowerCase();
    hits = hits.filter((a) => String(a.category).toLowerCase().includes(c.split(' ')[0]));
  }
  if (ql) {
    hits = hits.filter((a) =>
      a.name.toLowerCase().includes(ql) ||
      a.publisher.toLowerCase().includes(ql) ||
      a.category.toLowerCase().includes(ql) ||
      a.productId.toLowerCase().includes(ql));
  }
  return hits;
}

function demoSearch(q, opts) {
  const hits = filterDemo(q, opts);
  return (hits.length ? hits : filterDemo('', opts)).slice(0, 60);
}

function mergeHits(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      const hit = item && item.productId ? item : normalizeSearchHit(item);
      if (!hit || !hit.productId || seen.has(hit.productId)) continue;
      seen.add(hit.productId);
      out.push(hit);
    }
  }
  return out;
}

/** Official Store search engine — same endpoint Revision Tool uses. */
async function storeSearchEngine(query, mediaType, category) {
  const params = new URLSearchParams({
    query: query || (mediaType === 'games' ? 'game' : 'app'),
    gl: MARKET,
    hl: LOCALE,
    mediaType: mediaType || 'all',
    age: 'all',
    price: 'all',
    category: category || 'all',
    subscription: 'all'
  });
  const data = await requestJson(
    'https://apps.microsoft.com/api/products/search?' + params.toString(),
    { timeout: 22000, accept: 'application/json' }
  );
  const raw = [].concat(data.highlightedList || [], data.productsList || []);
  return raw.map(normalizeSearchHit).filter(Boolean);
}

/** storeedgefd manifestSearch — backend the Store / winget msstore source uses. */
async function storeedgeSearch(query) {
  const data = await requestJson('https://storeedgefd.dsx.mp.microsoft.com/v9.0/manifestSearch', {
    method: 'POST',
    body: {
      Query: { KeyWord: query, MatchType: 'Substring' },
      MaximumResults: 50
    },
    timeout: 20000
  });
  return ((data && data.Data) || []).map((p) => normalizeSearchHit({
    productId: p.PackageIdentifier,
    title: p.PackageName || p.PackageIdentifier,
    publisherName: p.Publisher,
    description: (p.Tags || []).join(' ')
  })).filter(Boolean);
}

/** Display Catalog autosuggest — Microsoft product-family search. */
async function displayCatalogSuggest(query) {
  const data = await requestJson(
    'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=' +
    MARKET + '&languages=en-US&query=' + encodeURIComponent(query),
    { timeout: 15000 }
  );
  const names = data && (data.Results || data.results || data.Suggestions || data);
  const list = Array.isArray(names) ? names : [];
  const hits = [];
  for (const item of list.slice(0, 12)) {
    const id = item.ProductId || item.productId || item.BigId || item.bigId;
    const title = item.Title || item.title || item.Query || item.query || '';
    if (id) hits.push(normalizeSearchHit({ productId: id, title, publisherName: item.PublisherName }));
  }
  return hits.filter(Boolean);
}

async function searchProducts(q, opts) {
  opts = opts || {};
  const query = String(q || '').trim();
  const kind = opts.kind || 'all';
  const category = opts.category || '';
  const types = kind === 'all' ? ['apps', 'games'] : [kind === 'games' ? 'games' : 'apps'];
  const seed = query || (kind === 'games' ? 'game' : 'app');
  const engines = [];
  let collected = [];

  try {
    const batches = await Promise.all(types.map((t) =>
      storeSearchEngine(seed, t, category).catch(() => [])));
    collected = mergeHits(batches);
    if (query && kind === 'all') {
      try { collected = mergeHits([collected, await storeSearchEngine(query, 'all', category)]); } catch (_) {}
    }
    if (collected.length) engines.push('store-search');
  } catch (_) {}

  // Universal search: every query hits all three catalogs. New apps that
  // only exist in storeedgefd or Display Catalog used to be invisible.
  const extraQ = query || seed;
  try {
    const extra = await storeedgeSearch(extraQ);
    if (extra.length) {
      collected = mergeHits([collected, extra]);
      engines.push('storeedgefd');
    }
  } catch (_) {}
  try {
    const extra = await displayCatalogSuggest(extraQ);
    if (extra.length) {
      collected = mergeHits([collected, extra]);
      engines.push('displaycatalog');
    }
  } catch (_) {}

  if (collected.length) {
    return {
      ok: true,
      source: engines.join('+') || 'catalog',
      engine: engines.join(' + ') || 'Microsoft Store API',
      kind, category,
      results: collected.slice(0, SEARCH_LIMIT)
    };
  }
  return { ok: true, source: 'demo', engine: 'offline catalog', kind, category, results: demoSearch(query, opts) };
}

async function fetchProductWeb(productId) {
  const id = String(productId).toUpperCase();
  const web = await requestJson(
    'https://apps.microsoft.com/api/ProductsDetails/GetProductDetailsById/' +
    encodeURIComponent(id) + '?gl=US&hl=en-us',
    { timeout: 20000 }
  );
  const hit = normalizeSearchHit(web);
  if (!hit) throw new Error('Store product page returned no listing');
  return hit;
}

/**
 * Display Catalog (DCAT) — the same catalog winget / StoreLib query for
 * WuCategoryId when storeedgefd omits FulfillmentData.
 */
async function fetchDisplayCatalog(productId) {
  const id = String(productId).toUpperCase();
  const urls = [
    'https://displaycatalog.mp.microsoft.com/v7.0/products/' + encodeURIComponent(id) +
      '?market=' + MARKET + '&languages=en-US,en,neutral&fieldsTemplate=details',
    'https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=' + encodeURIComponent(id) +
      '&market=' + MARKET + '&languages=en-US,en,neutral&fieldsTemplate=details',
    'https://displaycatalog.mp.microsoft.com/v7.0/products/' + encodeURIComponent(id) +
      '?market=' + MARKET + '&languages=en-US&fieldsTemplate=details&catalogIds=4'
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await requestJson(url, { timeout: 20000 });
      const product = (data && data.Products && data.Products[0]) || data;
      if (!product || typeof product !== 'object') continue;
      const loc = (product.LocalizedProperties && product.LocalizedProperties[0]) || {};
      const fulfillment = extractFulfillment(product);
      const images = product.LocalizedProperties
        ? [].concat.apply([], product.LocalizedProperties.map((p) => p.Images || []))
        : (product.Images || []);
      return {
        productId: id,
        name: loc.ProductTitle || loc.Title || product.ProductTitle || id,
        publisher: loc.PublisherName || loc.Publisher || 'Microsoft Store',
        desc: String(loc.ProductDescription || loc.ShortDescription || '').replace(/\s+/g, ' ').slice(0, 400),
        icon: pickImage(images.map((i) => ({
          imageType: i.ImagePurpose || i.imageType,
          url: i.Uri || i.url
        }))),
        url: storeUrl(id),
        fulfillment,
        catalog: 'displaycatalog'
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Display Catalog returned no product');
}

async function fetchProduct(productId) {
  const id = String(productId).toUpperCase();
  const settled = await Promise.allSettled([
    fetchProductWeb(id),
    fetchProductEdge(id),
    fetchDisplayCatalog(id)
  ]);
  const web = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const edge = settled[1].status === 'fulfilled' ? settled[1].value : null;
  const dcat = settled[2].status === 'fulfilled' ? settled[2].value : null;
  if (!web && !edge && !dcat) {
    const err = settled.find((s) => s.status === 'rejected');
    throw (err && err.reason) || new Error('Every Microsoft catalog refused this product');
  }
  const merged = Object.assign({}, dcat || {}, edge || {}, web || {});
  merged.productId = id;
  merged.fulfillment = (edge && edge.fulfillment && edge.fulfillment.WuCategoryId && edge.fulfillment)
    || (dcat && dcat.fulfillment && dcat.fulfillment.WuCategoryId && dcat.fulfillment)
    || (edge && edge.fulfillment)
    || (dcat && dcat.fulfillment)
    || (web && web.fulfillment)
    || null;
  merged.catalogs = ['store-web', 'storeedgefd', 'displaycatalog']
    .filter((_, i) => settled[i].status === 'fulfilled');
  if (!merged.name) merged.name = id;
  return merged;
}

async function fetchProductEdge(productId) {
  const id = String(productId).toUpperCase();
  const url = 'https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/' +
    encodeURIComponent(id) + '?market=' + MARKET + '&locale=' + LOCALE + '&deviceFamily=Windows.Desktop';
  const data = await requestJson(url, { timeout: 25000 });
  const payload = (data && data.Payload) || {};
  const sku = (payload.Skus && payload.Skus[0]) || {};
  const fulfillment = extractFulfillment(sku) || extractFulfillment(payload);
  const images = payload.Images || payload.Icon || [];
  return {
    productId: id,
    name: payload.Title || payload.ShortTitle || id,
    publisher: payload.PublisherName || payload.Publisher || 'Microsoft Store',
    desc: String(payload.Description || payload.ShortDescription || '').replace(/\s+/g, ' ').slice(0, 400),
    icon: pickImage(images),
    platforms: payload.Platforms || [],
    lastUpdate: payload.LastUpdateDateUtc || null,
    url: storeUrl(id),
    fulfillment
  };
}

async function fetchNonUwp(productId, currArch) {
  const url = 'https://storeedgefd.dsx.mp.microsoft.com/v9.0/packageManifests/' +
    encodeURIComponent(productId) + '?market=' + MARKET + '&locale=' + LOCALE + '&deviceFamily=Windows.Desktop';
  const data = await requestJson(url, { timeout: 25000 });
  const versions = data && data.Data && data.Data.Versions;
  if (!versions || !versions[0]) throw new Error('server returned a empty list');
  const ver = versions[0];
  const fileName = (ver.DefaultLocale && ver.DefaultLocale.PackageName) || productId;
  const installers = ver.Installers || [];
  let best = installers[0];
  for (const d of installers) {
    const arch = String(d.Architecture || '').toLowerCase();
    const locale = String(d.InstallerLocale || '').toLowerCase();
    const bArch = String((best && best.Architecture) || '').toLowerCase();
    const bLoc = String((best && best.InstallerLocale) || '').toLowerCase();
    if (bArch !== 'neutral' && bArch !== currArch && (arch === 'neutral' || arch === currArch)) {
      best = d;
    } else if (arch === bArch && locale !== bLoc && (locale.includes('us') || locale.includes('en'))) {
      best = d;
    }
  }
  if (!best || !best.InstallerUrl) throw new Error('No installer URL for this product');

  // The on-disk extension must be a REAL extension, not the manifest's
  // technology name — see INSTALLER_TYPE_EXT. Getting this wrong is what made
  // installed apps refuse to open.
  const installerType = String(best.InstallerType || ver.InstallerType || '').toLowerCase();
  const ext = installerExt({
    InstallerType: installerType,
    NestedInstallerType: best.NestedInstallerType || ver.NestedInstallerType,
    InstallerUrl: best.InstallerUrl
  });
  const version = ver.PackageVersion || '';
  const base = fileBaseName(fileName, productId);
  const name = base + (version ? ' ' + version : '') + '.' + ext;

  return {
    uwp: false,
    mainFile: name,
    files: [{
      name,
      url: best.InstallerUrl,
      arch: best.Architecture || currArch,
      type: ext,
      installerType: installerType || ext,
      // Silent switches let the install actually complete unattended instead
      // of leaving a wizard open that nobody sees.
      switches: (best.InstallerSwitches || ver.InstallerSwitches || null),
      sha256: String(best.InstallerSha256 || '').toLowerCase() || null,
      scope: best.Scope || null,
      version,
      kind: 'app'
    }]
  };
}

async function resolveFromStore(input, opts) {
  opts = opts || {};
  const productId = parseProductId(input);
  if (!productId) {
    throw new Error('No Data Found: you selected the wrong page. Open an app/game detail on apps.microsoft.com and try again.');
  }
  const currArch = opts.arch || osArch();
  const releaseType = opts.releaseType || 'Retail';
  const allowDemo = process.platform !== 'win32';
  let meta;
  try {
    meta = await fetchProduct(productId);
  } catch (e) {
    if (!allowDemo) throw e;
    const demo = DEMO_POOL.find((a) => a.productId === productId) || {
      productId, name: productId, publisher: 'Microsoft Store', desc: '', icon: '', url: storeUrl(productId)
    };
    return demoResolve(demo, currArch, e.message);
  }

  const fulfillment = meta.fulfillment;
  if (!fulfillment || !fulfillment.WuCategoryId) {
    try {
      const nu = await fetchNonUwp(productId, currArch);
      return Object.assign({ product: meta, categoryId: null, packageFamily: null, arch: currArch }, nu);
    } catch (e) {
      if (!allowDemo) throw e;
      return demoResolve(meta, currArch, e.message);
    }
  }

  const catId = fulfillment.WuCategoryId;
  const family = String(fulfillment.PackageFamilyName || '').split('_')[0];
  try {
    const cookie = await fe3Cookie();
    const sync = await fe3SyncAnyRing(cookie, catId, releaseType);
    const picked = pickPackages(sync.nameModified, family, currArch, !!opts.ignoreVer, !!opts.allDeps);
    if (!picked.files.length) throw new Error('No matching packages for this architecture');

    // Resolve every file's CDN link. A dependency that Microsoft won't hand
    // out a URL for (already shipped in-box, superseded, ring-restricted) must
    // NOT abort the install — we only hard-fail if the main package is missing.
    const files = [];
    const skipped = [];
    for (const fname of picked.files) {
      const ident = sync.identities[fname];
      if (!ident) continue;
      const isMain = fname === picked.mainFile;
      let url;
      try {
        url = await fe3FileUrl(ident.updateId, ident.revision, releaseType);
      } catch (urlErr) {
        if (isMain) throw urlErr;
        skipped.push({ name: fname, reason: urlErr.message });
        continue;
      }
      const parsed = parseFileKey(fname);
      files.push({
        name: fname,
        url,
        updateId: ident.updateId,
        revision: ident.revision,
        arch: parsed.arch,
        type: parsed.ext,
        version: parsed.version,
        kind: isMain ? 'app' : 'dep'
      });
    }
    if (!files.some((f) => f.kind === 'app')) {
      throw new Error('Microsoft returned no installable main package for this product');
    }
    return {
      product: meta,
      uwp: true,
      categoryId: catId,
      packageFamily: fulfillment.PackageFamilyName,
      arch: currArch,
      mainFile: picked.mainFile,
      files,
      skipped,
      method: 'fe3',
      ring: sync.ring || releaseType,
      catalogs: meta.catalogs || []
    };
  } catch (e) {
    try {
      const nu = await fetchNonUwp(productId, currArch);
      return Object.assign({
        product: meta,
        categoryId: catId,
        packageFamily: fulfillment.PackageFamilyName,
        arch: currArch,
        method: 'manifest'
      }, nu);
    } catch (_) {
      if (!allowDemo) throw e;
      return demoResolve(Object.assign({}, meta, { categoryId: catId, packageFamily: fulfillment.PackageFamilyName }), currArch, e.message);
    }
  }
}

function demoResolve(product, arch, reason) {
  const base = cleanName(product.name || product.productId) || 'app';
  const ver = '1.0.0.0';
  const main = base + '_' + ver + '_' + arch + '__demo.msixbundle';
  const dep = 'Microsoft.VCLibs.140.00_' + ver + '_' + arch + '__8wekyb3d8bbwe.appx';
  return {
    product,
    uwp: true,
    demo: true,
    reason: reason || 'demo',
    categoryId: product.categoryId || 'demo-category',
    packageFamily: product.packageFamily || (base + '_demo'),
    arch,
    mainFile: main,
    files: [
      { name: dep, url: 'demo://' + dep, arch, type: 'appx', version: ver, kind: 'dep' },
      { name: main, url: 'demo://' + main, arch, type: 'msixbundle', version: ver, kind: 'app' }
    ]
  };
}

async function refreshFileUrl(input, fileName, opts) {
  const resolved = await resolveFromStore(input, opts);
  const hit = (resolved.files || []).find((f) => f.name === fileName);
  if (!hit || !hit.url || hit.url.startsWith('demo:')) throw new Error('Could not refresh download URL');
  return hit.url;
}

module.exports = {
  FEATURED,
  STORE_CHIPS,
  osArch,
  storeUrl,
  parseProductId,
  searchProducts,
  fetchProduct,
  resolveFromStore,
  refreshFileUrl,
  demoSearch,
  demoResolve,
  FE3_RINGS,
  SEARCH_LIMIT,
  uniqueRings,
  extractFulfillment,
  parseFulfillmentBlob,
  // Internals exposed for the unit tests in test/.
  __test: {
    parseFe3Sync, parseFileUrls, pickPackages, parseFileKey, selectLatest,
    installerExt, extFromUrl, fileBaseName, INSTALLER_TYPE_EXT,
    FE3_RINGS, SEARCH_LIMIT, uniqueRings, extractFulfillment, parseFulfillmentBlob
  }
};
