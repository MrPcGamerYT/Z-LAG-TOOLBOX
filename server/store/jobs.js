'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveFromStore, refreshFileUrl, parseProductId } = require('./catalog');
const { downloadFile, sanitizeName, ensureDir } = require('./downloader');
const { installPackages } = require('./installer');
const { installOfficial, needsLicensedFallback, looksEncrypted } = require('./official');

const IS_WINDOWS = process.platform === 'win32';
const JOBS = new Map();

function downloadsRoot() {
  if (process.env.ZLAG_DOWNLOADS) return process.env.ZLAG_DOWNLOADS;
  if (process.pkg) return path.join(path.dirname(process.execPath), 'downloads');
  return path.join(os.homedir(), 'Z-LAG-Toolbox', 'downloads');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function classifyFailure(error, stage) {
  const message = String((error && error.message) || error || '');
  const network = /network|internet|download|fetch|socket|timed? ?out|enotfound|econn|eai_again|dns|http (?:408|429|5\d\d)|cdn/i.test(message) ||
    stage === 'downloading';
  return network ? 'network' : (stage === 'installing' ? 'install' : 'catalog');
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    filePercent: job.filePercent,
    currentFile: job.currentFile,
    error: job.error,
    warning: job.warning,
    failureKind: job.failureKind || null,
    retryable: !!job.retryable,
    retryLabel: job.failureKind === 'network' ? 'Retry download' : 'Retry install',
    demo: job.demo,
    product: job.product,
    categoryId: job.categoryId,
    packageFamily: job.packageFamily,
    arch: job.arch,
    uwp: job.uwp,
    files: (job.files || []).map((f) => ({
      name: f.name,
      kind: f.kind,
      arch: f.arch,
      type: f.type,
      version: f.version,
      downloaded: f.downloaded || 0,
      total: f.total || 0,
      percent: f.percent || 0,
      path: f.path || null
    })),
    launch: job.launch || null,
    installFolder: job.installFolder || null,
    rebootRequired: !!job.rebootRequired,
    notes: job.notes || [],
    log: job.log.slice(-80),
    result: job.result || null
  };
}

function log(job, line) {
  const msg = '[' + new Date().toISOString().slice(11, 19) + '] ' + line;
  job.log.push(msg);
  if (job.log.length > 200) job.log.shift();
}

function setStage(job, stage, percent) {
  job.stage = stage;
  job.status = stage === 'done' ? 'done' : (stage === 'error' ? 'error' : 'running');
  if (typeof percent === 'number') job.percent = Math.max(0, Math.min(100, Math.round(percent)));
}

function getJob(id) { return JOBS.get(id) || null; }

function cancelJob(id) {
  const job = JOBS.get(id);
  if (!job) return false;
  job.cancelled = true;
  log(job, 'Cancel requested');
  if (job.child) { try { job.child.kill(); } catch (_) {} }
  return true;
}

function retryJob(id) {
  const job = JOBS.get(id);
  if (!job || job.status !== 'error' || !job.retryable) return null;
  return startJob(job.input, Object.assign({}, job.options, { retryOf: job.id }));
}

function startJob(input, opts) {
  opts = opts || {};
  const id = uid();
  const job = {
    id,
    status: 'running',
    stage: 'resolving',
    percent: 2,
    filePercent: 0,
    currentFile: '',
    error: null,
    warning: false,
    failureKind: null,
    retryable: false,
    demo: false,
    product: null,
    categoryId: null,
    packageFamily: null,
    arch: null,
    uwp: true,
    files: [],
    log: [],
    result: null,
    launch: null,
    installFolder: null,
    rebootRequired: false,
    cancelled: false,
    input: String(input || '').trim(),
    options: {
      ignoreVer: !!opts.ignoreVer,
      allDeps: !!opts.allDeps,
      downloadOnly: !!opts.downloadOnly
    },
    retryOf: opts.retryOf || null
  };
  JOBS.set(id, job);
  log(job, 'Selected product: ' + job.input);
  if (job.retryOf) log(job, 'Retrying failed job ' + job.retryOf + ' with a fresh catalog/CDN request.');
  runJob(job, job.options).catch((e) => {
    const raw = (e && e.message) || String(e);
    if (job.cancelled) {
      job.error = 'Stopped by user';
      job.status = 'cancelled';
      job.stage = 'cancelled';
      log(job, 'Install cancelled');
      return;
    }
    job.failureKind = classifyFailure(raw, job.stage);
    job.retryable = true;
    job.error = job.failureKind === 'network'
      ? 'Download failed — check your internet connection, then press Retry. ' + raw
      : raw;
    setStage(job, 'error');
    log(job, 'ERROR ' + job.error);
  });
  return job;
}

async function runJob(job, opts) {
  const stop = () => job.cancelled;
  setStage(job, 'resolving', 5);
  log(job, 'Resolving product via Microsoft Store APIs…');
  const productId = parseProductId(job.input);
  if (!productId) throw new Error('Could not resolve a Store product id from that search.');
  log(job, 'Product key: ' + productId);

  log(job, 'Universal Store method — querying every Microsoft catalog…');
  const resolved = await resolveFromStore(job.input, {
    ignoreVer: !!opts.ignoreVer,
    allDeps: !!opts.allDeps
  });
  if (stop()) throw new Error('Stopped By User!');

  job.product = resolved.product;
  job.categoryId = resolved.categoryId;
  job.packageFamily = resolved.packageFamily;
  job.arch = resolved.arch;
  job.uwp = resolved.uwp;
  job.demo = !!resolved.demo;
  job.files = resolved.files.map((f) => Object.assign({ downloaded: 0, total: 0, percent: 0, path: null }, f));
  log(job, (resolved.demo ? '[demo] ' : '') +
    (resolved.product && resolved.product.name ? resolved.product.name : productId) +
    ' · ' + (resolved.uwp ? 'UWP' : 'Win32') +
    ' · arch ' + resolved.arch);
  if (resolved.categoryId) log(job, 'WuCategoryId: ' + resolved.categoryId);
  if (resolved.packageFamily) log(job, 'PackageFamilyName: ' + resolved.packageFamily);
  log(job, 'Install method: Revision Tool pipeline (Add-AppxPackage, deps first) · ' +
    (resolved.method || (resolved.uwp ? 'fe3' : 'manifest')) +
    (resolved.ring ? ' · FE3 ring ' + resolved.ring : '') +
    (resolved.catalogs && resolved.catalogs.length ? ' · catalogs ' + resolved.catalogs.join('+') : '') +
    ' · ' + job.files.length + ' file(s)');
  for (const s of resolved.skipped || []) {
    log(job, 'Skipped optional dependency ' + s.name + ' — ' + s.reason);
  }

  // ------------------------------------------------------------------
  // Universal install — one ordered pipeline, stop at the first success.
  //
  //   1. Encrypted / DRM payload  → licensed Store installer first
  //   2. FE3 download (Retail → RP → WIS → WIF → …)
  //   3. Add-AppxPackage per file, deps first (Revision Tool)
  //   4. If that fails or the app has no licence / Start-menu id
  //      → WinGet / AppInstallManager
  // ------------------------------------------------------------------
  const appName = (resolved.product && resolved.product.name) || productId;

  async function tryOfficial(reason) {
    log(job, reason);
    const official = await installOfficial(productId, {
      appName,
      packageFamily: job.packageFamily,
      licenseRepair: true,
      shouldStop: stop,
      onLog: (line) => log(job, line),
      onProgress: (pct) => {
        job.percent = Math.max(job.percent, Math.min(99, 12 + Math.round(pct * 0.8)));
      },
      onChild: (child) => { job.child = child; }
    });
    job.child = null;
    return official;
  }

  function finishOfficial(official, extraNotes) {
    job.launch = official.launch || null;
    job.installFolder = official.installFolder || null;
    job.notes = (extraNotes || []).concat(official.notes || []);
    job.result = { ok: true, method: official.method, official: true };
    setStage(job, 'done', 100);
    log(job, 'Installation completed via ' + official.method);
    if (job.launch) log(job, 'Ready to launch: ' + job.launch);
  }

  if (IS_WINDOWS && !opts.downloadOnly && looksEncrypted(job.files)) {
    setStage(job, 'installing', 12);
    const official = await tryOfficial(
      'Encrypted/DRM package — using the licensed Store installer first (Add-AppxPackage cannot run these).');
    if (official.ok) {
      finishOfficial(official, []);
      return;
    }
    log(job, 'Licensed installer did not take this product — falling through to FE3 download.');
  }

  setStage(job, 'downloading', 20);
  const folder = path.join(downloadsRoot(), sanitizeName(appName));
  ensureDir(folder);
  log(job, 'Download folder: ' + folder);

  const n = Math.max(1, job.files.length);
  for (let i = 0; i < job.files.length; i++) {
    if (stop()) throw new Error('Stopped By User!');
    const file = job.files[i];
    job.currentFile = file.name;
    job.filePercent = 0;
    const dest = path.join(folder, sanitizeName(file.name));
    log(job, 'Downloading ' + file.kind + ': ' + file.name);
    await downloadFile({
      url: file.url,
      dest,
      sha256: file.sha256 || null,
      segments: 10,
      resume: true,
      shouldStop: stop,
      refreshUrl: async () => {
        log(job, 'CDN link expired — requesting a fresh URL…');
        return refreshFileUrl(job.input, file.name, opts);
      },
      onProgress: (p) => {
        file.downloaded = p.downloaded;
        file.total = p.total;
        file.percent = p.percent;
        job.filePercent = p.percent;
        job.percent = 20 + Math.round(((i + p.percent / 100) / n) * 55);
      }
    });
    file.path = dest;
    file.percent = 100;
    log(job, 'Saved ' + dest);
    job.percent = 20 + Math.round(((i + 1) / n) * 55);
  }

  if (opts.downloadOnly) {
    setStage(job, 'done', 100);
    job.result = { downloaded: job.files.length, folder };
    log(job, 'Download complete (install skipped)');
    return;
  }

  setStage(job, 'installing', 80);
  job.currentFile = '';
  if (!IS_WINDOWS) {
    for (const f of job.files) {
      if (stop()) throw new Error('Stopped By User!');
      job.currentFile = f.name;
      log(job, '[demo] ' + (job.uwp ? 'Add-AppPackage' : 'Start-Process') + ' ' + f.name);
      await new Promise((r) => setTimeout(r, 450));
    }
    job.result = { ok: true, demo: true, installed: job.files.length };
    setStage(job, 'done', 100);
    log(job, 'Demo install finished — run the toolbox on Windows to apply for real.');
    return;
  }

  const inst = await installPackages(
    job.files,
    job.uwp,
    (f) => {
      job.currentFile = f.name;
      log(job, 'Installing ' + f.name + ' — waiting for it to finish…');
    },
    { appName, packageFamily: job.packageFamily || null }
  );
  job.result = inst;
  job.warning = !!inst.warning;

  for (const n of inst.notes || []) log(job, n);
  for (const r of inst.results || []) {
    if (r.ok) {
      if (r.elevated) log(job, 'Re-ran ' + r.name + ' as administrator');
      if (r.alreadyInstalled) log(job, r.name + ' is already installed at this version');
      if (r.installFolder) log(job, 'Installed to ' + r.installFolder);
      for (const l of r.shortcuts || []) log(job, 'Shortcut created: ' + l);
    } else {
      log(job, (r.kind === 'app' ? 'FAILED ' : 'dependency failed ') + r.name +
        ' (exit ' + r.code + ') ' + String(r.output || '').split('\n')[0]);
    }
  }

  if (needsLicensedFallback(inst, job.files)) {
    const official = await tryOfficial(inst.ok
      ? 'Sideload landed but the app is not licensed / not in the Start menu — trying WinGet / Store installer…'
      : 'Add-AppxPackage failed — trying WinGet / Store installer…');
    if (official.ok) {
      finishOfficial(official, inst.notes || []);
      return;
    }
    if (!inst.ok) throw new Error(inst.message || 'Failed To Install The Application!');
    log(job, 'Licensed fallback did not take this product — keeping the sideload result.');
  }

  if (inst.warning) log(job, inst.message);
  job.launch = inst.launch || null;
  job.installFolder = inst.installFolder || null;
  job.rebootRequired = !!inst.rebootRequired;
  job.notes = inst.notes || [];
  setStage(job, 'done', 100);
  log(job, inst.message || 'Installation completed');
  if (inst.launch) log(job, 'Ready to launch: ' + inst.launch);
}

module.exports = {
  startJob,
  retryJob,
  getJob,
  cancelJob,
  publicJob,
  downloadsRoot,
  classifyFailure
};
