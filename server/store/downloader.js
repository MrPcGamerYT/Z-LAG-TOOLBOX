'use strict';

/**
 * pypdl-style downloader: concurrent multi-part Range requests, resume,
 * and a refreshUrl() hook when a CDN link expires (403/401/410).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('./http');

/** SHA-256 of a file on disk, lower-case hex. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Reject a download that cannot possibly be a working installer.
 *
 * The classic failure this catches: a CDN returns an HTML error page or an
 * expired-link stub with HTTP 200, we save it as "Rufus 4.5.exe", and Windows
 * later refuses to run it. Checking the magic bytes costs nothing and turns a
 * baffling "the app won't open" into a clear download error.
 */
async function verifyPayload(dest, expect) {
  expect = expect || {};
  const st = fs.statSync(dest);
  if (!st.size) throw new Error('The download is empty — the link may have expired.');
  if (expect.size && st.size !== expect.size) {
    throw new Error('The download is incomplete (' + st.size + ' of ' + expect.size +
      ' bytes). It was discarded so it cannot break the install.');
  }

  const ext = String(path.extname(dest) || '').replace('.', '').toLowerCase();
  const fd = fs.openSync(dest, 'r');
  const head = Buffer.alloc(Math.min(8, st.size));
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }

  const isPe = head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;          // MZ
  const isZip = head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b;         // PK
  const isMsi = head.length >= 8 && head.readUInt32BE(0) === 0xd0cf11e0;          // OLE2
  const looksHtml = /^\s*(<!doctype|<html|<\?xml)/i.test(head.toString('latin1'));

  if (looksHtml) {
    throw new Error('The server returned a web page instead of the installer — ' +
      'the download link expired. Try the install again.');
  }
  if ((ext === 'exe') && !isPe) {
    throw new Error('The downloaded file is not a valid Windows program. ' +
      'It was discarded — try the install again.');
  }
  if (ext === 'msi' && !isMsi && !isPe) {
    throw new Error('The downloaded file is not a valid MSI package. ' +
      'It was discarded — try the install again.');
  }
  if ((ext === 'zip' || /^(appx|msix|appxbundle|msixbundle)$/.test(ext)) && !isZip) {
    throw new Error('The downloaded package is corrupt. It was discarded — try again.');
  }

  if (expect.sha256) {
    const got = await hashFile(dest);
    if (got !== String(expect.sha256).toLowerCase()) {
      throw new Error('The download failed its integrity check (SHA-256 mismatch). ' +
        'It was discarded so a corrupt installer cannot be run.');
    }
  }
  return true;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name) {
  return String(name || 'package').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probeSize(url) {
  try {
    const res = await request(url, { method: 'HEAD', timeout: 20000 });
    res.resume();
    const len = parseInt(res.headers['content-length'], 10);
    const ranges = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
    if (len > 0) return { size: len, ranges };
  } catch (_) { /* fall through to ranged GET */ }
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      timeout: 20000
    });
    const cr = String(res.headers['content-range'] || '');
    const m = cr.match(/\/(\d+)\s*$/);
    res.resume();
    if (m) return { size: parseInt(m[1], 10), ranges: true };
  } catch (_) {}
  return { size: 0, ranges: false };
}

function pipeToFile(res, dest, flags) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: flags || 'w' });
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
}

async function downloadSimple(url, dest, onProgress, shouldStop) {
  const res = await request(url, { timeout: 120000 });
  if ((res.statusCode || 0) >= 400) {
    res.resume();
    const err = new Error('HTTP ' + res.statusCode);
    err.statusCode = res.statusCode;
    throw err;
  }
  const total = parseInt(res.headers['content-length'], 10) || 0;
  let got = 0;
  res.on('data', (c) => {
    got += c.length;
    if (onProgress) onProgress({ downloaded: got, total: total || got, percent: total ? Math.round(got * 100 / total) : 0 });
  });
  if (shouldStop && shouldStop()) { res.destroy(); throw new Error('Stopped By User!'); }
  await pipeToFile(res, dest, 'w');
  return dest;
}

async function downloadSegment(url, dest, start, end, shouldStop) {
  const res = await request(url, {
    timeout: 120000,
    headers: { Range: 'bytes=' + start + '-' + end }
  });
  const code = res.statusCode || 0;
  if (code !== 206 && code !== 200) {
    res.resume();
    const err = new Error('HTTP ' + code);
    err.statusCode = code;
    throw err;
  }
  if (shouldStop && shouldStop()) { res.destroy(); throw new Error('Stopped By User!'); }
  await pipeToFile(res, dest, 'w');
}

async function concatParts(parts, dest) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let i = 0;
    function next() {
      if (i >= parts.length) { out.end(); return; }
      const inp = fs.createReadStream(parts[i++]);
      inp.on('error', reject);
      inp.on('end', next);
      inp.pipe(out, { end: false });
    }
    out.on('finish', resolve);
    out.on('error', reject);
    next();
  });
}

/**
 * Download `url` to `dest`.
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.dest
 * @param {number} [opts.segments=8]
 * @param {(info)=>void} [opts.onProgress]
 * @param {()=>Promise<string>} [opts.refreshUrl]  called when the link expires
 * @param {()=>boolean} [opts.shouldStop]
 * @param {boolean} [opts.resume=true]
 */
async function downloadFile(opts) {
  const dest = opts.dest;
  const segments = Math.max(1, opts.segments || 8);
  const onProgress = opts.onProgress || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  ensureDir(path.dirname(dest));

  let url = opts.url;
  if (!url || url.startsWith('demo:')) {
    // Simulated payload so the UI can run off Windows.
    const size = 4 * 1024 * 1024;
    const fd = fs.openSync(dest, 'w');
    const chunk = Buffer.alloc(64 * 1024, 1);
    let written = 0;
    while (written < size) {
      if (shouldStop()) { fs.closeSync(fd); throw new Error('Stopped By User!'); }
      const n = Math.min(chunk.length, size - written);
      fs.writeSync(fd, chunk, 0, n);
      written += n;
      onProgress({ downloaded: written, total: size, percent: Math.round(written * 100 / size) });
      await sleep(40);
    }
    fs.closeSync(fd);
    return dest;
  }

  // Reuse a previous download ONLY when it is provably complete.
  //
  // This used to accept any file over 1 KB without asking the server how big
  // the payload really is, so a download that was interrupted half-way (or a
  // stray HTML error page saved under the .exe name) was handed straight to
  // the installer on every later attempt. A truncated executable is exactly
  // what makes Windows say "There's a problem with <app>. Reinstall the
  // application from its original install location…".
  if (opts.resume !== false && fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    const expected = await probeSize(url);
    if (shouldStop()) throw new Error('Stopped By User!');
    if (expected.size > 0 && st.size === expected.size) {
      try {
        await verifyPayload(dest, { size: expected.size, sha256: opts.sha256 });
        onProgress({ downloaded: st.size, total: st.size, percent: 100 });
        return dest;
      } catch (_) { /* cached copy is bad — fall through and re-download */ }
    }
    // Unknown remote size (no content-length) — a partial file cannot be
    // detected, so re-fetch rather than risk installing a broken payload.
    try { fs.unlinkSync(dest); } catch (_) {}
    for (let i = 0; i < segments; i++) {
      try { fs.unlinkSync(dest + '.part' + i); } catch (_) {}
    }
  }

  async function once(currentUrl) {
    const probe = await probeSize(currentUrl);
    if (shouldStop()) throw new Error('Stopped By User!');
    if (!probe.ranges || probe.size < 1.5 * 1024 * 1024 || segments === 1) {
      await downloadSimple(currentUrl, dest, onProgress, shouldStop);
      return;
    }
    const size = probe.size;
    const partSize = Math.ceil(size / segments);
    const parts = [];
    const got = new Array(segments).fill(0);
    const tick = () => {
      const downloaded = got.reduce((a, b) => a + b, 0);
      onProgress({ downloaded, total: size, percent: Math.round(downloaded * 100 / size) });
    };
    const jobs = [];
    for (let i = 0; i < segments; i++) {
      const start = i * partSize;
      if (start >= size) break;
      const end = Math.min(size - 1, start + partSize - 1);
      const part = dest + '.part' + i;
      parts.push(part);
      if (opts.resume !== false && fs.existsSync(part) && fs.statSync(part).size === (end - start + 1)) {
        got[i] = end - start + 1;
        continue;
      }
      jobs.push((async () => {
        await downloadSegment(currentUrl, part, start, end, shouldStop);
        got[i] = end - start + 1;
        tick();
      })());
    }
    tick();
    await Promise.all(jobs);
    await concatParts(parts, dest);
    for (const p of parts) try { fs.unlinkSync(p); } catch (_) {}
    onProgress({ downloaded: size, total: size, percent: 100 });
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (shouldStop()) throw new Error('Stopped By User!');
    try {
      await once(url);
      // Never hand a broken payload to the installer.
      await verifyPayload(dest, { sha256: opts.sha256 });
      return dest;
    } catch (e) {
      lastErr = e;
      const code = e && e.statusCode;
      if ((code === 401 || code === 403 || code === 404 || code === 410) && typeof opts.refreshUrl === 'function') {
        try { url = await opts.refreshUrl(); } catch (re) { lastErr = re; }
      }
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr || new Error('Download Error Occurred!');
}

module.exports = { downloadFile, sanitizeName, ensureDir, probeSize, verifyPayload, hashFile };
