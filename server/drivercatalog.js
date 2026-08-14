/* ============================================================================
 * Z-LAG TOOLBOX — self-sufficient driver engine
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * --------------------
 * On Z-LAG OS (and many debloated Windows installs) the Windows Update
 * service is blocked or removed, so the old Driver Center — which asked the
 * Windows Update Agent COM API for driver packages — simply had nothing to
 * offer. This engine fetches drivers WITHOUT touching Windows Update:
 *
 *   1. It queries the Microsoft Update Catalog (catalog.update.microsoft.com)
 *      directly over plain HTTPS, like a browser would. That site does not
 *      need the wuauserv service, any Windows Update policy, or the Store —
 *      only an internet connection.
 *   2. It extracts the real download links from the catalog's download
 *      dialog and downloads the raw .cab driver packages.
 *   3. Installation is done by pnputil (built into Windows), the same tool
 *      IT pros use to stage drivers offline.
 *
 * The HTTP client here is dependency-free Node (https + zlib). The HTML
 * parsers are exported so the test suite can pin them against fixtures.
 * ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SEARCH_URL = 'https://www.catalog.update.microsoft.com/Search.aspx?q=';
const DIALOG_URL = 'https://www.catalog.update.microsoft.com/DownloadDialog.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZLAGToolbox/' +
  require('../package.json').version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Directory that holds downloaded driver packages for this run. */
function downloadRoot() {
  return path.join(os.tmpdir(), 'zlag-toolbox', 'drivers');
}

// ----------------------------------------------------------------- HTTP core
/**
 * GET/POST wrapper: redirects, gzip/deflate/br, cookies in & out, timeouts.
 * Returns { status, headers, body(Buffer), finalUrl, text, cookies }.
 * `opts.cookies` is a Map-like plain object of cookies we already hold.
 */
function request(url, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const maxRedirects = opts.maxRedirects == null ? 5 : opts.maxRedirects;
  const timeoutMs = opts.timeout || 45000;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const bodyBuf = opts.body == null ? null : Buffer.from(opts.body);

    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'close'
    }, opts.headers || {});
    if (opts.cookies) {
      const jar = Object.entries(opts.cookies).map(([k, v]) => k + '=' + v).join('; ');
      if (jar) headers['Cookie'] = jar;
    }
    if (bodyBuf) {
      headers['Content-Length'] = bodyBuf.length;
      headers['Content-Type'] = headers['Content-Type'] ||
        'application/x-www-form-urlencoded';
    }

    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
      timeout: timeoutMs
    }, (res) => {
      // Follow redirects with method downgrade to GET for 301/302/303/307/308.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        const jar = mergeCookies(opts.cookies, res.headers['set-cookie']);
        resolve(request(next, Object.assign({}, opts, {
          method: 'GET', body: null, cookies: jar,
          maxRedirects: maxRedirects - 1, timeout: timeoutMs
        })));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) body = zlib.gunzipSync(body);
          else if (enc.includes('deflate')) body = zlib.inflateSync(body);
          else if (enc.includes('br')) body = zlib.brotliDecompressSync(body);
        } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          finalUrl: url,
          text: isTextish(res.headers['content-type']) ? body.toString('utf8') : null,
          cookies: mergeCookies(opts.cookies, res.headers['set-cookie'])
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function isTextish(ct) {
  const s = String(ct || '').toLowerCase();
  return !s || /text|html|xml|json|javascript/.test(s);
}

function mergeCookies(existing, setCookie) {
  const jar = Object.assign({}, existing || {});
  for (const line of (setCookie || [])) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

// --------------------------------------------------------------- HTML parse
const GUID_RE = /\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?/;

/**
 * Parse the catalog search results page into offers:
 *   { updateId, title, products, classification, lastUpdated, version, size, sizeBytes }
 *
 * Real markup (Jan-2020s era): one <tr> per result; the title anchor calls
 * goToDetails('{guid}'); columns are <td> cells — checkbox, title, products,
 * classification, last updated, version, size. The parser only relies on the
 * GUID + td order, so it survives cosmetic markup changes.
 */
function parseSearchPage(html) {
  const offers = [];
  const rows = String(html || '').split(/<tr[\s>]/i);
  for (const row of rows) {
    const g = row.match(/goToDetails\(['"]?({[^'")]+}|[0-9a-fA-F-]{36})/i);
    if (!g) continue;
    const idm = g[1].match(GUID_RE);
    if (!idm) continue;
    const updateId = idm[1].toLowerCase();

    const tdm = row.match(/<a[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    const title = tdm ? stripTags(tdm[1]) : '';

    const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      .map((m) => stripTags(m[1]));
    // cells[0] = checkbox column; title follows; then the meta columns:
    // Products, Classification, Last Updated, Version, Size. Identify each by
    // shape rather than position so a re-ordered layout still parses.
    const meta = cells.filter((c) => c && c !== title);
    const isDate = (c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c.trim());
    const isSize = (c) => /^[\d.]+\s*(KB|MB|GB|B)$/i.test(c.trim());
    const lastUpdated = (meta.find(isDate) || '').trim();
    const size = (meta.find(isSize) || '').trim();
    // Products mention Windows; classification reads like "Drivers (…)".
    const products = (meta.find((c) => /windows/i.test(c)) || '').trim();
    const classification = (meta.find((c) =>
      !isDate(c) && !isSize(c) && c !== products &&
      /driver|security update|critical update|feature pack|service pack|update/i.test(c)) || '').trim();
    const sizeIdx = meta.findIndex(isSize);
    const version = sizeIdx > 0 && /\d/.test(meta[sizeIdx - 1] || '') && !isDate(meta[sizeIdx - 1])
      ? meta[sizeIdx - 1].trim() : '';

    offers.push({
      updateId,
      title,
      products,
      classification,
      lastUpdated,
      version,
      size,
      sizeBytes: parseSize(size)
    });
  }
  return dedupe(offers, (o) => o.updateId);
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSize(s) {
  const m = /([\d.]+)\s*(GB|MB|KB|B)/i.exec(String(s || ''));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'GB') return Math.round(n * 1073741824);
  if (unit === 'MB') return Math.round(n * 1048576);
  if (unit === 'KB') return Math.round(n * 1024);
  return Math.round(n);
}

function dedupe(list, keyFn) {
  const seen = new Set();
  return list.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Parse the download dialog page into direct file URLs. The page assigns
 * `downloadInformation[i].files[j].url = '<url>'` per update, plus a plain
 * list of links. We collect both shapes; .cab/.exe/.msi/.zip all allowed.
 */
function parseDownloadPage(html) {
  const urls = [];
  const assignRe = /\.files\[\d+\]\.url\s*=\s*'([^']+)'/gi;
  let m;
  while ((m = assignRe.exec(String(html || '')))) urls.push(m[1]);
  if (!urls.length) {
    const anyRe = /https?:\/\/[^\s'"<>]+?\.(?:cab|exe|msi|msu|zip)(?:\?[^\s'"<>]*)?/gi;
    while ((m = anyRe.exec(String(html || '')))) urls.push(m[0]);
  }
  return dedupe(urls, (u) => u.toLowerCase()).map((u) => ({ url: u, fileName: fileNameFromUrl(u) }));
}

function fileNameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const base = p.split('/').filter(Boolean).pop() || 'driver.bin';
    return base.replace(/[^\w.\-+() ]/g, '_');
  } catch (_) { return 'driver-' + Date.now() + '.cab'; }
}

// ------------------------------------------------------------- catalog API
let cookieJar = {};

/** Search the catalog. Returns an array of offers (may be empty on failure). */
async function searchCatalog(query, opts) {
  opts = opts || {};
  const url = SEARCH_URL + encodeURIComponent(query);
  const res = await request(url, { cookies: cookieJar, timeout: 40000 });
  cookieJar = res.cookies || cookieJar;
  if (res.status !== 200 || !res.text) throw new Error('Catalog search failed (HTTP ' + res.status + ')');
  let offers = parseSearchPage(res.text);
  if (opts.osFilter !== false) {
    const filtered = offers.filter((o) => matchesOs(o) && isDriverOffer(o));
    if (filtered.length) offers = filtered; // keep unfiltered as graceful fallback
  }
  return offers;
}

function matchesOs(o) {
  const p = String(o.products || '').toLowerCase();
  if (!p) return true;
  return /windows 11|windows 10|windows 8.1|windows 7|windows server|windows 8\b/.test(p);
}

function isDriverOffer(o) {
  const c = String(o.classification || '').toLowerCase();
  if (!c) return true; // classification column not always parsed — title is enough
  return c.includes('driver');
}

/** Get the direct download URLs for one or more update GUIDs. */
async function downloadLinks(updateId, opts) {
  opts = opts || {};
  const payload = [{
    size: 0,
    languages: '',
    uidInfo: '{' + updateId + '}',
    updateID: '{' + updateId + '}'
  }];
  const form = 'updateIDs=' + encodeURIComponent(JSON.stringify(payload));
  const res = await request(DIALOG_URL, {
    method: 'POST',
    body: form,
    cookies: cookieJar,
    headers: { 'Referer': SEARCH_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 40000
  });
  cookieJar = res.cookies || cookieJar;
  if (res.status !== 200 || !res.text) throw new Error('Download dialog failed (HTTP ' + res.status + ')');
  return parseDownloadPage(res.text);
}

/** Download a file to folder; resolves the absolute saved path. */
function downloadFile(entry, folder, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeout || 15 * 60 * 1000;
  const maxRedirects = 5;
  const url = typeof entry === 'string' ? entry : entry.url;
  const name = opts.fileName || fileNameFromUrl(url);
  fs.mkdirSync(folder, { recursive: true });
  const dest = path.join(folder, name);

  return new Promise((resolve, reject) => {
    (function go(currentUrl, redirects) {
      let u;
      try { u = new URL(currentUrl); } catch (e) { return reject(e); }
      const lib = u.protocol === 'http:' ? http : https;
      const started = Date.now();
      const req = lib.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers: {
          'User-Agent': UA,
          'Accept': 'application/octet-stream,*/*',
          'Accept-Encoding': 'identity',
          'Connection': 'close'
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < maxRedirects) {
          res.resume();
          const next = new URL(res.headers.location, currentUrl).toString();
          fs.rmSync(dest, { force: true });
          return go(next, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('Download failed (HTTP ' + res.statusCode + ')'));
        }
        const total = Number(res.headers['content-length']) || 0;
        const file = fs.createWriteStream(dest);
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (opts.onProgress) {
            opts.onProgress(got, total, Date.now() - started);
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ path: dest, bytes: got })));
        file.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('Download timed out')); });
      req.on('error', reject);
    })(url, 0);
  });
}

// --------------------------------------------------------------- install
/** Run a console tool; resolves { ok, code, stdout, stderr }. */
function runTool(exe, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = execFile(exe, args, {
      windowsHide: true,
      timeout: opts.timeout || 300000,
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code == null ? 1 : err.code) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.message) || '')
      });
    });
    if (opts.job) opts.job.child = child;
  });
}

/** Extract a .cab with the builtin expand.exe. Returns the output dir. */
async function extractCab(cabPath, jobsCtx) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'expand.exe is only available on Windows' };
  }
  const out = cabPath.replace(/\.cab$/i, '') + '-x';
  fs.mkdirSync(out, { recursive: true });
  const r = await runTool('expand.exe', [cabPath, '-F:*', out], {
    timeout: 5 * 60 * 1000, job: jobsCtx && jobsCtx.job
  });
  // expand.exe returns 0 on success; some builds use partial-success codes,
  // so also require that something actually landed on disk.
  let files = [];
  try { files = fs.readdirSync(out); } catch (_) {}
  if (!r.ok && !files.length) {
    return { ok: false, error: (r.stderr || 'expand failed').trim().slice(0, 300) };
  }
  return { ok: true, dir: out, files };
}

/**
 * Stage + install every INF under a folder with pnputil (Windows built-in).
 * Returns { ok, rebootRequired, output }.
 */
async function pnputilInstall(dir, opts) {
  opts = opts || {};
  if (process.platform !== 'win32') return { ok: false, demo: true, output: 'pnputil (demo)' };
  const args = ['/add-driver', path.join(dir, '*.inf'), '/subdirs', '/install'];
  const r = await runTool('pnputil.exe', args, { timeout: 10 * 60 * 1000, job: opts.job });
  const out = (r.stdout + '\n' + r.stderr);
  const reboot = /reboot required|restart required|restart the system|3010/.test(out.toLowerCase());
  // "Total attempted: N" + "Number of successful" appear in newer builds;
  // in older ones success is exit code 0. Honour both.
  const attempted = /Total\s+number\s+of\s+drivers\s+attempted[^:]*:\s*(\d+)/i.exec(out);
  const succeeded = /Number\s+of\s+drivers\s+successfully\s+imported\s*:\s*(\d+)/i.exec(out) ||
    /Number\s+of\s+successfully\s+staged\s*:\s*(\d+)/i.exec(out);
  const attemptedN = attempted ? Number(attempted[1]) : null;
  const succeededN = succeeded ? Number(succeeded[1]) : null;
  const success = r.ok || (succeededN != null && succeededN > 0);
  return { ok: success, rebootRequired: reboot, attempted: attemptedN, imported: succeededN, output: out.trim().slice(0, 600) };
}

// --------------------------------------------------------------- orchestrate
/**
 * Full acquisition for one device: search → pick best offer → links →
 * download → extract. Resolves:
 *   { ok, folder, offer, files, error }
 * Progress callbacks let the job ticker stay alive:
 *   onProgress('searching'|'downloading', device, detail)
 */
async function acquireDriver(device, opts) {
  opts = opts || {};
  const progress = opts.onProgress || (() => {});
  const queries = deviceQueries(device);
  let offers = [];
  let lastErr = null;
  let offer = null;

  // A completed scan may already have the exact catalog GUID (including WU
  // hints that could not be paired with a PnP id). Reuse it instead of doing a
  // fuzzy title search and potentially selecting a different device package.
  const known = device && device.update;
  if (known && /^[0-9a-f-]{36}$/i.test(String(known.updateId || ''))) {
    offer = {
      updateId: String(known.updateId),
      title: String(known.title || device.name || 'Driver update'),
      version: String(known.version || ''),
      lastUpdated: known.driverDate || '',
      sizeBytes: Number(known.size) || 0
    };
    progress('searching', device, 'using exact catalog update ' + offer.updateId);
  }

  if (!offer) {
    for (const q of queries) {
      progress('searching', device, q);
      try {
        offers = await searchCatalog(q);
      } catch (e) { lastErr = e; }
      if (offers && offers.length) break;
      await sleep(400); // be gentle with the catalog between queries
    }
    if (!offers || !offers.length) {
      return {
        ok: false,
        code: lastErr ? 'search-failed' : 'no-offers',
        error: lastErr ? lastErr.message : 'No driver found on the Microsoft Update Catalog'
      };
    }
    offer = pickBestOffer(offers, device);
  }
  if (!offer) return { ok: false, code: 'no-match', error: 'Catalog results did not match this device' };

  let links = [];
  try { links = await downloadLinks(offer.updateId); }
  catch (e) { return { ok: false, code: 'links-failed', error: 'Could not get download link: ' + e.message, offer }; }
  if (!links.length) return { ok: false, code: 'no-links', error: 'The catalog gave no downloadable files', offer };

  // Prefer the .cab driver package; fall back to any file.
  const chosen = links.find((l) => /\.cab$/i.test(l.fileName)) || links[0];
  const folder = path.join(downloadRoot(), device.id.replace(/[^\w.-]+/g, '_').slice(0, 60));
  progress('downloading', device, chosen.fileName);
  try {
    const dl = await downloadFile(chosen, folder, {
      onProgress: (got, total) => progress('downloading', device, chosen.fileName +
        ' ' + Math.round(got / 1048576) + ' MB' + (total ? ' / ' + Math.round(total / 1048576) + ' MB' : ''))
    });
    device._downloadedBytes = dl.bytes;
  } catch (e) { return { ok: false, code: 'download-failed', error: 'Download failed: ' + e.message, offer }; }

  const cabPath = path.join(folder, chosen.fileName);
  let extractDir = folder;
  if (/\.cab$/i.test(chosen.fileName)) {
    const ex = await extractCab(cabPath, opts);
    if (!ex.ok) return { ok: false, code: 'extract-failed', error: 'Could not extract driver package: ' + ex.error, offer };
    extractDir = ex.dir;
  }
  return { ok: true, folder: extractDir, offer, fileName: chosen.fileName };
}

/** Best catalog offer for a device: newest driver for the right OS that also
 *  textually matches the device reasonably well. */
function pickBestOffer(offers, device) {
  if (!offers.length) return null;
  const deviceTokens = tokens(device.name + ' ' + (device.vendor || ''));
  const scored = offers.map((o) => {
    let s = 0;
    const titleTokens = new Set(tokens(o.title + ' ' + o.products));
    let hits = 0;
    for (const t of deviceTokens) if (titleTokens.has(t)) hits++;
    s += deviceTokens.length ? (hits / deviceTokens.length) * 100 : 0;
    if (/windows 11|windows 10/i.test(o.products || '')) s += 18;
    if (/driver/i.test(o.classification || '')) s += 12;
    if (/x64|amd64|64-bit/i.test(o.title || '')) s += 8;
    if (/^windows$|^windows xp|^windows 7$/i.test((o.products || '').trim())) s -= 15;
    const when = Date.parse(o.lastUpdated || '') || 0;
    // Newer years add up to 10 points so fresh drivers win ties.
    s += Math.max(0, Math.min(10, ((when - Date.UTC(2015, 0, 1)) / (365.25 * 864e5))));
    return { o, s, when };
  }).sort((a, b) => {
    const scoreDiff = b.s - a.s;
    // Scores within a few points represent the same compatible family. In
    // that case choose the genuinely newest package rather than whichever row
    // Microsoft happened to return first.
    if (Math.abs(scoreDiff) > 4) return scoreDiff;
    if (b.when !== a.when) return b.when - a.when;
    return compareCatalogVersion(b.o.version, a.o.version);
  });
  // Always return the best-scoring offer; the score only orders candidates.
  return scored[0].o;
}

function compareCatalogVersion(a, b) {
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

const STOPWORDS = new Set(['the', 'and', 'for', 'inc', 'ltd', 'corporation', 'corp',
  'driver', 'drivers', 'device', 'controller', 'standard', 'pci', 'usb', 'acpi', 'root']);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|\(c\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Query plan for a device: the exact hardware id first, then name. */
function deviceQueries(device) {
  const out = [];
  const hw = (device.hwids || [])[0];
  if (hw) {
    // Driver packs on the catalog index by HardwareID — the most precise hit.
    out.push(hw);
    const short = String(hw).split('&').slice(0, 2).join('&');
    if (short && short !== hw) out.push(short);
  }
  const vendor = String(device.vendor || '')
    .replace(/\(standard\)/i, '').trim();
  if (vendor && !/^unknown$/i.test(vendor)) out.push(String(device.name) + ' ' + vendor);
  out.push(String(device.name));
  return dedupe(out.filter((q) => q && q.length >= 3), (q) => q.toLowerCase());
}

module.exports = {
  searchCatalog,
  downloadLinks,
  downloadFile,
  acquireDriver,
  extractCab,
  pnputilInstall,
  pickBestOffer,
  deviceQueries,
  downloadRoot,
  runExe: runTool,
  // exported for tests
  parseSearchPage,
  parseDownloadPage,
  parseSize,
  stripTags
};
