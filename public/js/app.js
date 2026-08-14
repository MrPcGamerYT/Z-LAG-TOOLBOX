/* ============================================================================
 * Z-LAG TOOLBOX — frontend logic v3
 *
 * v3 changes:
 *   • All emoji icons replaced by an inline SVG set (see the sprite in
 *     index.html). icon('i-wrench') renders a crisp vector glyph that is
 *     immune to the broken/方块 emoji rendering some Windows builds have.
 *   • Store category chips actually reach the server now (kind/category were
 *     chosen but silently dropped, so the list looked like it "changed" after
 *     loading).
 *   • loadSection() has an in-flight guard — navigating fast no longer draws
 *     an empty grid that gets repopulated a beat later.
 *   • Driver update job UI understands the new self-sufficient pipeline
 *     stages (repair → search → download → install) which no longer need
 *     Windows Update.
 * ========================================================================== */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  mode: 'demo',
  liveResults: [],
  scanDevices: [],
  scanResult: null,
  driverFilter: { text: '', cls: 'all' },
  drvJobId: null,
  drvTimer: null,
  catalog: [],
  storeKind: 'all',
  storeCategory: '',
  storeChipId: 'all',
  // ---- tweak workbench -------------------------------------------------
  // One entry per section, holding the tweaks the backend returned plus the
  // ids the user has ticked. Everything the UI renders derives from here.
  tweaks: {
    gaming: { list: [], selected: new Set(), filter: '', loading: null, loaded: false },
    tweaks: { list: [], selected: new Set(), filter: '', loading: null, loaded: false },
    customize: { list: [], selected: new Set(), filter: '', loading: null, loaded: false }
  },
  presets: [],
  tweakStatus: {},         // id -> 'applied' | 'reverted'
  // ---- store install jobs ----------------------------------------------
  // Jobs keep running server-side; the tray mirrors whichever ones the user
  // pushed into the background. `jobId` is the one shown in the big modal.
  jobId: null,
  jobTimer: null,
  jobProduct: null,
  tray: new Map(),         // jobId -> { name, icon, job, timer }
  tweakView: { gaming: '', tweaks: '', customize: '' }, // selected sidebar subdivision
  updateStatus: null,      // GitHub updater state from the desktop main process
  env: null,               // { elevated, portable, … } from the main process
  dashboardLoaded: false,
  presetsLoaded: false,
  presetsLoading: null,
  storeLoaded: false,
  storeLoading: null,
  catalogRequestId: 0,
  catalogShown: 0,
  drvPolling: false,
  jobPolling: false
};

// Every job status we have already toasted, so a job that finishes while its
// window is closed is announced exactly once (and never re-announced when the
// tray poll and the modal poll overlap).
const announced = new Set();

// ---------------------------------------------------------------- utilities
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Progress polling often returns the same snapshot several times. Avoid
// invalidating layout/paint when a value did not actually change.
function setNodeText(el, value) {
  const next = String(value == null ? '' : value);
  if (el.textContent === next) return false;
  el.textContent = next;
  return true;
}
function setNodeHtml(el, value) {
  if (el.innerHTML === value) return false;
  el.innerHTML = value;
  return true;
}
function setNodeWidth(el, value) {
  if (el.style.width === value) return false;
  el.style.width = value;
  return true;
}

/** Render one of the inline SVG sprite symbols (no more emoji). */
function icon(name, cls) {
  return '<svg class="ico ' + (cls || '') + '" aria-hidden="true"><use href="#' + esc(name) + '"/></svg>';
}

/**
 * Talk to the backend.
 *
 * In the packaged desktop app there is no HTTP server at all: window.zlag is
 * injected by the Electron preload and forwards straight to server/core.js
 * over IPC. The fetch() path only runs in headless/dev browser mode.
 */
const IS_APP = typeof window.zlag !== 'undefined' && typeof window.zlag.api === 'function';

async function api(url, opts) {
  if (IS_APP) {
    try { return (await window.zlag.api(url, opts)) || {}; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch (_) { return {}; }
}
function showModal(title, lines) {
  $('#modalTitle').textContent = title;
  const log = $('#modalLog');
  log.innerHTML = '';
  (lines || []).forEach((l) => {
    const div = document.createElement('div');
    if (l.cmd) { div.className = 'cmd-line'; div.textContent = '$ ' + l.cmd; }
    else { div.className = l.ok ? 'ok-line' : ''; div.textContent = l.text || l; }
    log.appendChild(div);
  });
  $('#modalBackdrop').classList.add('open');
}
$('#modalClose').addEventListener('click', () => $('#modalBackdrop').classList.remove('open'));
$('#modalX').addEventListener('click', () => $('#modalBackdrop').classList.remove('open'));
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#modalBackdrop').classList.remove('open'); });

// ------------------------------------------------- native window chrome
if (IS_APP) {
  document.body.classList.add('desktop');
  $('#winControls').style.display = 'flex';
  $('#btnDownloads').style.display = '';
  $('#winMin').addEventListener('click', () => window.zlag.window.minimize());
  $('#winMax').addEventListener('click', () => window.zlag.window.maximize());
  $('#winClose').addEventListener('click', () => window.zlag.window.close());
  $('#btnDownloads').addEventListener('click', () => window.zlag.shell.openDownloads());
  // Swap the maximize glyph between "maximize" and "restore".
  window.zlag.window.onState(({ maximized }) => {
    $('#winMax').innerHTML = maximized ? '&#xE923;' : '&#xE922;';
    $('#winMax').title = maximized ? 'Restore' : 'Maximize';
  });
  // Double-clicking the title bar toggles maximize, like every native app.
  document.querySelector('.topbar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.no-drag')) window.zlag.window.maximize();
  });
}

// ---------------------------------------------------------------- navigation
$$('.nav-item').forEach((n) => n.addEventListener('click', () => navigate(n.dataset.page, n.dataset.category || '')));
$$('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav, b.dataset.category || '')));

function navigate(page, category = '') {
  if (state.tweakView[page] !== undefined) state.tweakView[page] = category;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page && (n.dataset.category || '') === category));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  if (page === 'dashboard') loadDashboard();
  if (page === 'drivers' && !state.scanDevices.length) renderScanPlaceholder();
  if (page === 'customize' || page === 'tweaks' || page === 'gaming') loadSection(page);
  if (page === 'store') loadStore();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---------------------------------------------------------------- boot
// Heavy pages are loaded only when first visited. On low-end machines this
// avoids constructing hundreds of hidden cards and decoding Store images
// before the user can interact with the dashboard.
function loadDashboard() {
  if (state.dashboardLoaded) return;
  state.dashboardLoaded = true;
  loadSystem();
  initUpdates();
}

function loadStore() {
  if (state.storeLoaded || state.storeLoading) return state.storeLoading;
  state.storeLoading = Promise.all([loadCategories(), loadFeatured()])
    .finally(() => {
      state.storeLoaded = true;
      state.storeLoading = null;
    });
  return state.storeLoading;
}

async function boot() {
  const st = await api('/api/status');
  state.mode = st.mode || 'demo';
  if (st.version && $('#appVersion')) $('#appVersion').textContent = 'v' + st.version;
  const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent || '');
  if ($('#runtimeVersion')) {
    $('#runtimeVersion').textContent = chrome ? 'Embedded Chromium ' + chrome[1] : 'Embedded Chromium ready';
  }
  const label = state.mode === 'real' ? '● Real mode' : '● Demo mode';
  const cls = 'mode-pill ' + state.mode;
  $('#modePill').textContent = label; $('#modePill').className = cls;
  $('#modePillTop').textContent = label; $('#modePillTop').className = cls;
  if (state.mode === 'demo') {
    $('#modeBanner').style.display = 'flex';
    $('#tweakBanner').style.display = 'flex';
    $('#gamingBanner').style.display = 'flex';
  }
  loadDashboard();
  // The Driver Center intentionally does nothing until the user scans. Store
  // data and tweak workbenches stay unloaded until their page is opened.
  renderScanPlaceholder();
}

// --------------------------------------------------------------- app updates
function paintUpdateStatus(update) {
  if (!update) return;
  state.updateStatus = update;
  const status = $('#updateStatus');
  const badge = $('#updateBadge');
  const progress = $('#updateProgress');
  const fill = $('#updateProgressFill');
  const check = $('#btnUpdateCheck');
  const install = $('#btnUpdateInstall');
  const release = $('#btnUpdateRelease');
  if (!status || !badge) return;

  const phase = update.status || 'idle';
  const percent = Math.max(0, Math.min(100, Number(update.percent) || 0));
  status.textContent = update.message || 'Updates are provided by GitHub Releases.';
  progress.hidden = phase !== 'downloading';
  fill.style.width = percent.toFixed(1) + '%';
  check.disabled = phase === 'checking' || phase === 'downloading';
  check.innerHTML = phase === 'checking'
    ? '<span class="spinner"></span> Checking…'
    : 'Check now';
  check.hidden = phase === 'disabled' || phase === 'ready' ||
    (phase === 'available' && update.portable);
  install.hidden = phase !== 'ready';
  release.hidden = !(update.portable && phase === 'available') && phase !== 'error' && phase !== 'disabled';

  if (phase === 'current') {
    badge.textContent = 'current'; badge.className = 'badge ok';
  } else if (phase === 'ready') {
    badge.textContent = 'ready'; badge.className = 'badge ok';
  } else if (phase === 'available') {
    badge.textContent = 'v' + (update.version || 'new'); badge.className = 'badge warn';
  } else if (phase === 'downloading') {
    badge.textContent = Math.round(percent) + '%'; badge.className = 'badge info';
  } else if (phase === 'checking') {
    badge.textContent = 'checking'; badge.className = 'badge info';
  } else if (phase === 'error') {
    badge.textContent = 'retry'; badge.className = 'badge danger';
  } else if (phase === 'disabled') {
    badge.textContent = 'manual'; badge.className = 'badge demo';
  } else {
    badge.textContent = 'GitHub'; badge.className = 'badge info';
  }
}

async function initUpdates() {
  const check = $('#btnUpdateCheck');
  const install = $('#btnUpdateInstall');
  const release = $('#btnUpdateRelease');
  if (!check || !install || !release) return;

  if (!IS_APP || !window.zlag.updates) {
    paintUpdateStatus({
      status: 'disabled',
      message: 'Automatic updates run in the published Windows desktop app.',
      releaseUrl: 'https://github.com/MrPcGamerYT/Z-LAG-TOOLBOX/releases/latest'
    });
    check.hidden = true;
    release.onclick = () => window.open(
      'https://github.com/MrPcGamerYT/Z-LAG-TOOLBOX/releases/latest', '_blank', 'noopener');
    return;
  }

  window.zlag.updates.onStatus(paintUpdateStatus);
  check.addEventListener('click', async () => {
    check.disabled = true;
    paintUpdateStatus(await window.zlag.updates.check());
  });
  install.addEventListener('click', async () => {
    install.disabled = true;
    const result = await window.zlag.updates.install();
    if (result && result.error) {
      install.disabled = false;
      toast(result.error, 'error');
    }
  });
  release.addEventListener('click', () => window.zlag.updates.openRelease());
  paintUpdateStatus(await window.zlag.updates.status());
}

// ---------------------------------------------------------------- system
async function loadSystem() {
  const info = await api('/api/system');
  const tile = (i, v) => { $('#sysGrid').children[i].querySelector('.value').textContent = v; };
  tile(0, info.OS + ' · Build ' + (info.Build || info.Version || ''));
  tile(1, info.CPU || 'n/a');
  tile(2, info.GPU || 'n/a');
  tile(3, info.RAM_GB ? info.RAM_GB + ' GB' : 'n/a');
  tile(4, (info.Cores || '?') + ' / ' + (info.Threads || '?'));
}

$('#btnRestore').addEventListener('click', async () => {
  $('#btnRestore').disabled = true;
  $('#btnRestore').innerHTML = '<span class="spinner"></span> Creating...';
  const r = await api('/api/restorepoint', { method: 'POST' });
  $('#btnRestore').disabled = false;
  $('#btnRestore').innerHTML = 'Create';
  if (r.ok) toast('Restore point created ✓', 'success');
  else toast('Could not create restore point', 'error');
});

// ---------------------------------------------------------------- store
async function loadCategories() {
  const data = await api('/api/store/chips');
  window.__storeChips = data.chips || [];
  const chips = $('#appChips');
  chips.innerHTML = '';
  (data.chips || []).forEach((c) => {
    const el = document.createElement('div');
    el.className = 'chip' + (c.id === state.storeChipId ? ' active' : '');
    el.textContent = c.label;
    el.addEventListener('click', () => {
      state.storeKind = c.kind || 'all';
      state.storeCategory = c.category || '';
      state.storeChipId = c.id;
      $$('#appChips .chip').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      const q = $('#appSearch').value.trim();
      if (q) searchStore(q);
      else loadFeatured();
    });
    chips.appendChild(el);
  });
}

/** Query params that make the current category chip actually filter results. */
function storeParams() {
  return '&kind=' + encodeURIComponent(state.storeKind || 'all') +
    '&category=' + encodeURIComponent(state.storeCategory || '');
}

let searchTimer = null;
$('#appSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('#appSearch').value.trim();
  searchTimer = setTimeout(() => {
    if (q) searchStore(q);
    else loadFeatured();
  }, 300);
});

function looksLikeProductId(q) {
  const s = String(q || '').trim();
  if (/^(9[0-9A-Za-z]{11}|XP[0-9A-Za-z]{10,})$/i.test(s)) return s.toUpperCase();
  const m = s.match(/\/(?:detail|productid|p)\/([0-9A-Za-z]{12}|XP[0-9A-Za-z]+)/i)
    || s.match(/[?&]productid=([0-9A-Za-z]+)/i);
  return m ? m[1].toUpperCase() : null;
}

async function loadFeatured() {
  // Respect the currently chosen chip — previously this always asked for the
  // unfiltered catalog, so the visible results "changed" right after the
  // page (re)loaded even though the chip stayed highlighted.
  const requestId = ++state.catalogRequestId;
  const r = await api('/api/store/search?x=1' + storeParams());
  if (requestId !== state.catalogRequestId) return;
  $('#storeSearchSpinner').style.display = 'none';
  renderCatalogGrid(r.results || [], chipLabel() || 'Featured', r.source);
}

async function searchStore(q) {
  const id = looksLikeProductId(q);
  if (id) {
    state.catalogRequestId++;
    $('#storeSearchSpinner').style.display = 'none';
    openProduct(id);
    return;
  }
  const requestId = ++state.catalogRequestId;
  const spin = $('#storeSearchSpinner');
  spin.style.display = 'inline-block';
  $('#storeList').innerHTML = '<div class="store-search-status"><span class="spinner"></span> Searching for "' + esc(q) + '"...</div>';
  const r = await api('/api/store/search?q=' + encodeURIComponent(q) + storeParams());
  if (requestId !== state.catalogRequestId) return;
  spin.style.display = 'none';
  renderCatalogGrid(r.results || [], 'Results for "' + q + '"' + (chipLabel() ? ' · ' + chipLabel() : ''), r.source);
}

function chipLabel() {
  if (state.storeChipId === 'all') return '';
  const chips = window.__storeChips || [];
  const c = chips.find((x) => x.id === state.storeChipId);
  return c ? c.label : '';
}

function iconHtml(a, cls) {
  if (a.icon && /^https?:\/\//i.test(a.icon)) {
    return '<img class="' + cls + '" src="' + esc(a.icon) + '" alt="" loading="lazy" decoding="async">';
  }
  // Real Store icons are URLs; anything else (offline catalog) gets a glyph.
  return '<div class="' + cls + ' ico-tile">' + icon(a.isGame ? 'i-gamepad' : 'i-box') + '</div>';
}

const STORE_PAGE = 32;

function appendCatalogPage(grid, more, results) {
  const start = state.catalogShown;
  const end = Math.min(start + STORE_PAGE, results.length);
  const fragment = document.createDocumentFragment();
  results.slice(start, end).forEach((a) => {
    const tile = document.createElement('div');
    tile.className = 'glass ptile';
    tile.innerHTML = iconHtml(a, 'pico') +
      '<div class="pname">' + esc(a.name) + '</div>' +
      '<div class="ppub">' + esc(a.publisher || '') + (a.price ? ' · ' + esc(a.price) : '') + '</div>' +
      (a.isGame ? '<span class="badge demo" style="width:max-content">Game</span>' : '');
    tile.onclick = () => openProduct(a.productId, a);
    fragment.appendChild(tile);
  });
  grid.appendChild(fragment);
  state.catalogShown = end;

  const remaining = results.length - end;
  more.hidden = remaining <= 0;
  if (remaining > 0) {
    more.querySelector('button').textContent = 'Show ' + Math.min(STORE_PAGE, remaining) +
      ' more of ' + remaining;
  }
}

function renderCatalogGrid(results, title, source) {
  const list = $('#storeList');
  list.innerHTML = '';
  state.catalog = results;
  state.catalogShown = 0;
  if (!results.length) {
    list.innerHTML = '<div class="empty"><svg class="ico big-ico" aria-hidden="true"><use href="#i-search"/></svg>No apps found. Try another name.</div>';
    return;
  }
  const header = document.createElement('div');
  header.className = 'section-title';
  header.style.marginTop = '4px';
  header.innerHTML = '<h2>' + esc(title) + '</h2><span class="small">' + results.length +
    (source === 'demo' ? ' · offline catalog' : ' · Microsoft Store API') + '</span>';
  list.appendChild(header);
  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  list.appendChild(grid);

  const more = document.createElement('div');
  more.className = 'store-more';
  more.innerHTML = '<button class="btn btn-sm" type="button"></button>';
  more.querySelector('button').onclick = () => appendCatalogPage(grid, more, results);
  list.appendChild(more);
  appendCatalogPage(grid, more, results);
}



// ---------------------------------------------------------------- drivers
/**
 * The Driver Center is a scanner. Nothing is offered until a scan has run;
 * afterwards a single button repairs from the local driver store and pulls
 * anything remaining straight off the Microsoft Update Catalog — it works
 * even on systems where Windows Update is blocked (Z-LAG OS).
 */
function renderScanPlaceholder() {
  $('#driverActionBar').style.display = 'none';
  $('#scanArea').innerHTML =
    '<div class="empty"><svg class="ico big-ico" aria-hidden="true"><use href="#i-search"/></svg>Click <b>Scan now</b> to check your drivers.</div>';
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 * 1024 * 1024) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return Math.round(n / 1048576) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

$('#btnScan').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';
  $('#driverActionBar').style.display = 'none';
  $('#scanArea').innerHTML =
    '<div class="empty"><span class="spinner" style="width:30px;height:30px"></span>' +
    '<div style="margin-top:12px">Scanning devices and matching drivers on the Microsoft Update Catalog…</div>' +
    '<div class="small" style="margin-top:6px">This can take up to a minute on the first run. Windows Update is not required.</div></div>';
  const r = await api('/api/drivers/scan', { method: 'POST' });
  btn.disabled = false;
  btn.innerHTML = icon('i-search') + ' Scan now';
  if (!r || r.ok !== true) {
    state.scanDevices = [];
    state.scanResult = null;
    $('#scanArea').innerHTML = '<div class="empty">' + icon('i-warn', 'big-ico') +
      '<div>Driver scan failed</div><div class="small">' + esc((r && r.error) || 'Could not read the device inventory.') + '</div></div>';
    toast((r && r.error) || 'Driver scan failed', 'error');
    return;
  }
  state.scanDevices = r.devices || [];
  state.scanResult = r;
  renderScan(r);
});

const GSTATE_LABEL = {
  ok: 'ok', outdated: 'update', generic: 'generic', missing: 'missing', absent: 'not found'
};

const GCAT_ICONS = {
  gpu: 'i-monitor',
  audio: 'i-audio',
  network: 'i-wifi',
  chipset: 'i-cpu',
  storage: 'i-disk',
  input: 'i-mouse'
};

function gamingPanelHtml(g) {
  if (!g) return '';
  const score = Math.max(0, Math.min(100, Number(g.score) || 0));
  const color = score >= 80 ? 'var(--success)' : (score >= 55 ? 'var(--warn)' : 'var(--danger)');
  const cats = (g.categories || []).map((c) => {
    const st = c.state || 'absent';
    return '<div class="gcat ' + st + '">' +
      '<div class="gc-top">' +
        icon(GCAT_ICONS[c.key] || 'i-cpu', 'gc-ico') +
        '<span class="gc-name">' + esc(c.label) + '</span>' +
        (c.critical ? '<span class="gc-critical" title="critical for gaming">*</span>' : '') +
        '<span class="gc-state">' + esc(GSTATE_LABEL[st] || st) + '</span>' +
      '</div>' +
      '<div class="gc-detail">' + esc(c.detail || c.deviceName || '—') + '</div>' +
      (c.advice ? '<div class="gc-advice">' + esc(c.advice) + '</div>' : '') +
    '</div>';
  }).join('');

  // A coherent one-liner. The old version picked the "everything is fine"
  // sentence from `g.ready` and then appended "· N problems" right after it,
  // so a machine with only non-critical generic drivers read as both "all
  // present" and "problems" at once. Now critical and optional issues are
  // counted separately and the words always match the numbers.
  const problems = (g.categories || []).filter((c) => c.state === 'missing' || c.state === 'generic');
  const critical = problems.filter((c) => c.critical).length;
  let summary;
  if (critical > 0) {
    summary = 'One or more gaming-critical drivers are missing or running on a Microsoft generic driver — that costs frames and adds input lag.';
  } else if (problems.length > 0) {
    summary = 'Every gaming-critical driver is present, but some optional drivers run on a generic or missing stack.';
  } else {
    summary = 'Every driver a game depends on is present and vendor-supplied.';
  }
  const bits = [];
  if (critical > 0) bits.push(critical + ' critical');
  else if (problems.length > 0) bits.push(problems.length + ' problem' + (problems.length === 1 ? '' : 's'));
  if (g.outdatedCount) bits.push(g.outdatedCount + ' update' + (g.outdatedCount === 1 ? '' : 's') + ' waiting');
  if (g.runtimeProblemCount) bits.push(g.runtimeProblemCount + ' gaming runtime' + (g.runtimeProblemCount === 1 ? '' : 's') + ' missing');
  const gs = summary +
    (bits.length ? ' · ' + bits.join(' · ') : '') +
    ' · <span class="small">* = critical for gaming</span>';

  return '<div class="gaming-panel">' +
    '<div class="gaming-head">' +
      '<div class="gaming-score" style="--score:' + score + ';--score-color:' + color + '"><span>' + score + '</span></div>' +
      '<div class="gaming-head-text">' +
        '<div class="gt with-ico">' + icon('i-gamepad') + ' Gaming driver readiness — ' + esc(g.verdict || '') + '</div>' +
        '<div class="gs">' + gs + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="gaming-cats">' + cats + '</div>' +
  '</div>';
}

function gamingRuntimePanelHtml(runtimes, system) {
  if (!runtimes || !runtimes.length) return '';
  const missing = runtimes.filter((r) => r.needsInstall).length;
  const cpu = system && system.cpus && system.cpus[0];
  const gpus = system && system.gpus || [];
  const hardware = [
    cpu && cpu.name ? 'CPU: ' + cpu.name : '',
    gpus.length ? 'GPU: ' + gpus.map((g) => g.name || g.vendor).filter(Boolean).join(', ') : ''
  ].filter(Boolean).join(' · ');
  const rows = runtimes.map((r) =>
    '<div class="runtime-row ' + (r.needsInstall ? 'missing' : 'ok') + '">' +
      '<div class="runtime-icon">' + icon(r.id === 'directx-legacy' ? 'i-gamepad' : 'i-cpu') + '</div>' +
      '<div class="runtime-info"><div class="nm">' + esc(r.name) + '</div>' +
        '<div class="sub">' + esc(r.description || '') +
          (r.version ? ' · ' + esc(r.version) : '') + '</div></div>' +
      '<span class="badge ' + (r.needsInstall ? 'danger' : 'ok') + '">' +
        (r.needsInstall ? 'missing' : 'installed') + '</span>' +
    '</div>').join('');
  return '<div class="gaming-runtime-panel">' +
    '<div class="runtime-head"><div><b>Gaming runtimes</b><div class="small">DirectX and Visual C++ are checked separately from Device Manager drivers.</div></div>' +
      '<span class="badge ' + (missing ? 'warn' : 'ok') + '">' +
        (missing ? missing + ' missing' : 'ready') + '</span></div>' +
    (hardware ? '<div class="runtime-hardware">' + esc(hardware) + '</div>' : '') +
    '<div class="runtime-list">' + rows + '</div></div>';
}

/** Does this device pass the current chip + text filter? */
function driverMatches(d) {
  const f = state.driverFilter;
  const t = (f.text || '').trim().toLowerCase();
  if (t) {
    const hay = [d.name, d.vendor, d.class, d.version, d.deviceId, d.update && d.update.title]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(t)) return false;
  }
  switch (f.cls) {
    case 'all': return true;
    case 'actionable': return !!(d.needsUpdate && d.installable !== false);
    case 'missing': return !!d.missing;
    case 'update': return !!(d.needsUpdate && !d.missing);
    case 'gaming': return !!d.gaming;
    case 'ok': return !d.missing && !d.needsUpdate;
    default: return (d.class || 'Unknown') === f.cls;
  }
}

function driverRowHtml(d) {
  let badge;
  let rowIcon;
  let rowCls;
  if (d.needsUpdate && d.installable === false) {
    badge = '<span class="badge danger">manual check</span>'; rowIcon = 'i-warn'; rowCls = 'missing';
  } else if (d.missing) { badge = '<span class="badge danger">missing</span>'; rowIcon = 'i-warn'; rowCls = 'missing'; }
  else if (d.needsUpdate) { badge = '<span class="badge warn">update</span>'; rowIcon = 'i-up'; rowCls = 'update'; }
  else if (d.gaming) { badge = '<span class="badge ok">up to date</span>'; rowIcon = 'i-gamepad'; rowCls = 'gaming'; }
  else { badge = '<span class="badge ok">up to date</span>'; rowIcon = 'i-check-circle'; rowCls = 'ok'; }
  const game = d.gaming ? '<span class="badge game" title="' + esc(d.gaming.label) + '">Gaming</span>' : '';

  const detail = d.missing
    ? '<span style="color:var(--danger)">' + esc(d.problemText || 'No driver installed') + '</span>'
    : 'v' + esc(d.version || 'n/a') + (d.driverDate ? ' · ' + esc(String(d.driverDate).slice(0, 10)) : '');

  // A device with no hardware ID can never be matched to a package. Say so,
  // instead of dangling an "install" that is guaranteed to fail.
  const unresolvable = d.needsUpdate && d.installable === false
    ? '<div class="sub offer ico-line">' + icon('i-info') +
      ' <span>Windows exposes no usable hardware ID for this device, so an automatic package cannot be selected safely. Check the PC/GPU manufacturer manually.</span></div>'
    : '';
  const identity = d.hardwareVendor
    ? '<div class="sub ico-line">' + icon('i-cpu') + '<span>Detected hardware: ' +
      esc(d.hardwareVendor) + (d.hardwareModel ? ' · ' + esc(d.hardwareModel) : '') +
      (d.hardwareIdentitySource ? ' (' + esc(d.hardwareIdentitySource) + ')' : '') + '</span></div>'
    : '';

  const updateSrc = d.update && d.update.source === 'catalog'
    ? ' · <span class="src">Update Catalog</span>'
    : (d.update && d.update.source === 'windows-update' ? ' · <span class="src">Windows Update hint</span>' : '');

  const offer = d.update
    ? '<div class="sub offer ico-line">' + icon('i-up') + ' <span>' + esc(d.update.title) +
      (d.update.size ? ' · ' + fmtSize(d.update.size) : '') + updateSrc + '</span></div>'
    : (d.gaming && d.gaming.generic
      ? '<div class="sub offer ico-line">' + icon('i-warn') + ' <span>Microsoft generic driver — install the ' + esc(d.gaming.vendorHint || 'vendor') + ' driver for full performance</span></div>'
      : '');

  return '<div class="driver-row">' +
    '<div class="driver-ico ' + rowCls + '">' + icon(rowIcon) + '</div>' +
    '<div class="driver-info">' +
      '<div class="nm">' + esc(d.name) + '</div>' +
      '<div class="sub">' + esc(d.vendor || 'Unknown vendor') + ' · ' + esc(d.class || 'Unknown') + ' · ' + detail + '</div>' +
      identity + offer + unresolvable +
    '</div>' +
    '<div class="tags">' + game + badge + '</div>' +
  '</div>';
}

const DRIVER_PAGE = 40;

/** Re-render only the filtered device list (chips/search never re-run the scan). */
function renderDriverList(reset) {
  const r = state.scanResult || {};
  const wrap = $('#driverList');
  if (!wrap) return;
  if (reset) state.driverShown = DRIVER_PAGE;
  const shown = state.driverShown || DRIVER_PAGE;
  const all = (r.devices || []).filter(driverMatches);
  const slice = all.slice(0, shown);

  $('#driverListCount').textContent = all.length
    ? all.length + ' of ' + (r.devices || []).length + ' devices'
    : 'no matches';

  if (!all.length) {
    wrap.innerHTML = '<div class="empty"><svg class="ico big-ico" aria-hidden="true"><use href="#i-search"/></svg>No devices match this filter.</div>';
    return;
  }
  wrap.innerHTML = slice.map(driverRowHtml).join('') +
    (all.length > slice.length
      ? '<div class="driver-more"><button class="btn btn-sm" id="btnDriverMore">Show ' +
        Math.min(DRIVER_PAGE, all.length - slice.length) + ' more of ' + (all.length - slice.length) + '</button></div>'
      : '');

  const more = $('#btnDriverMore');
  if (more) more.onclick = () => { state.driverShown = shown + DRIVER_PAGE; renderDriverList(false); };
}

function renderScan(r) {
  const area = $('#scanArea');
  const devices = r.devices || [];
  state.scanResult = r;
  area.innerHTML = '';
  if (!devices.length) {
    $('#driverActionBar').style.display = 'none';
    area.innerHTML = '<div class="empty"><svg class="ico big-ico" aria-hidden="true"><use href="#i-check-circle"/></svg>No devices found.</div>';
    return;
  }

  // Devices that genuinely have a driver waiting for them. Entries Windows
  // can never resolve (no hardware ID) are counted separately so the button
  // never promises work it cannot do.
  const missing = devices.filter((d) => d.missing && d.installable !== false);
  const unresolvable = devices.filter((d) => d.needsUpdate && d.installable === false);
  const updatable = devices.filter((d) => d.needsUpdate && !d.missing && d.installable !== false);
  const healthy = devices.filter((d) => !d.needsUpdate && !d.missing);
  const runtimeMissing = (r.gamingRuntimes || []).filter((x) => x.needsInstall);
  const driverActionable = missing.length + updatable.length;
  const actionable = driverActionable + runtimeMissing.length;

  // ---- the one action button, only after a scan and only if there is work
  const bar = $('#driverActionBar');
  bar.style.display = '';
  if (actionable > 0) {
    $('#driverActionTitle').textContent = actionable +
      ' driver / gaming component' + (actionable === 1 ? '' : 's') + ' need attention';
    const bits = [];
    if (missing.length) bits.push(missing.length + ' missing driver' + (missing.length === 1 ? '' : 's'));
    if (updatable.length) bits.push(updatable.length + ' driver update' + (updatable.length === 1 ? '' : 's'));
    if (runtimeMissing.length) bits.push(runtimeMissing.length + ' gaming runtime' + (runtimeMissing.length === 1 ? '' : 's'));
    const totalBytes = devices.reduce((sum, d) => sum + ((d.update && d.update.size) || 0), 0);
    $('#driverActionSub').textContent = bits.join(' · ') +
      (totalBytes ? ' · about ' + fmtSize(totalBytes) + ' in known driver downloads' : '') +
      ' · official Microsoft sources — Windows Update not required';
    $('#btnUpdateAllDrivers').disabled = false;
  } else {
    $('#driverActionTitle').textContent = 'Everything is up to date';
    $('#driverActionSub').textContent =
      devices.length + ' devices checked · no driver packages waiting' +
      (unresolvable.length
        ? ' · ' + unresolvable.length + ' item(s) require a manual manufacturer check'
        : '');
    $('#btnUpdateAllDrivers').disabled = true;
  }

  // ---- stats
  const stats = document.createElement('div');
  stats.className = 'stat-row';
  stats.innerHTML =
    '<div class="stat grad-violet"><span class="n">' + devices.length + '</span><span class="l">devices detected</span></div>' +
    '<div class="stat grad-blue"><span class="n">' + updatable.length + '</span><span class="l">updates available</span></div>' +
    '<div class="stat grad-pink"><span class="n">' + missing.length + '</span><span class="l">missing drivers</span></div>' +
    '<div class="stat grad-green"><span class="n">' + healthy.length + '</span><span class="l">up to date</span></div>';
  area.appendChild(stats);

  // Being unable to reach Windows Update is NORMAL on Z-LAG OS — the catalog
  // engine covers missing drivers regardless. This note is informational.
  if (r.wuAvailable === false) {
    const note = document.createElement('div');
    note.className = 'banner info-note';
    note.style.marginTop = '14px';
    note.innerHTML = icon('i-info', 'banner-ico') +
      '<span>Windows Update is disabled or blocked on this PC (expected on Z-LAG OS) — ' +
      'missing drivers are matched against the <b>Microsoft Update Catalog</b> instead, so installs still work. ' +
      'Outdated-version detection for already-working drivers is best-effort.</span>';
    area.appendChild(note);
  }

  // ---- gaming readiness
  if (r.gaming) {
    const panel = document.createElement('div');
    panel.innerHTML = gamingPanelHtml(r.gaming);
    area.appendChild(panel.firstElementChild);
  }
  if (r.gamingRuntimes && r.gamingRuntimes.length) {
    const panel = document.createElement('div');
    panel.innerHTML = gamingRuntimePanelHtml(r.gamingRuntimes, r.systemInfo || {});
    area.appendChild(panel.firstElementChild);
  }

  // ---- filters + list
  const chips = [
    { k: 'all', l: 'All drivers (' + devices.length + ')' },
    { k: 'actionable', l: 'Driver attention (' + driverActionable + ')' },
    { k: 'gaming', l: 'Gaming (' + (r.gamingCount || devices.filter((d) => d.gaming).length) + ')' },
    { k: 'missing', l: 'Missing (' + missing.length + ')' },
    { k: 'update', l: 'Updates (' + updatable.length + ')' },
    { k: 'ok', l: 'Up to date (' + healthy.length + ')' }
  ].concat((r.classes || []).map((c) => ({ k: c.name, l: c.name + ' (' + c.count + ')' })));

  // Keep the user's chosen filter across re-scans — only fall back to "All"
  // when the exact class chip genuinely disappeared.
  if (!chips.some((c) => c.k === state.driverFilter.cls)) state.driverFilter.cls = 'all';

  const tools = document.createElement('div');
  tools.className = 'driver-filters';
  tools.innerHTML =
    '<input class="filter-input" id="driverSearch" type="search" placeholder="Filter devices, vendors, classes…" value="' +
      esc(state.driverFilter.text || '') + '">' +
    '<span class="sel-count" id="driverListCount"></span>';
  const chipWrap = document.createElement('div');
  chipWrap.className = 'driver-filters';
  chipWrap.innerHTML = chips.map((c) =>
    '<button class="dchip' + (state.driverFilter.cls === c.k ? ' active' : '') +
    '" data-cls="' + esc(c.k) + '">' + esc(c.l) + '</button>').join('');
  area.appendChild(tools);
  area.appendChild(chipWrap);

  const list = document.createElement('div');
  list.className = 'driver-list-wrap';
  list.id = 'driverList';
  area.appendChild(list);

  chipWrap.querySelectorAll('.dchip').forEach((b) => {
    b.addEventListener('click', () => {
      state.driverFilter.cls = b.dataset.cls;
      chipWrap.querySelectorAll('.dchip').forEach((x) => x.classList.toggle('active', x === b));
      renderDriverList(true);
    });
  });
  let dt = null;
  tools.querySelector('#driverSearch').addEventListener('input', (e) => {
    state.driverFilter.text = e.target.value;
    clearTimeout(dt);
    dt = setTimeout(() => renderDriverList(true), 120);
  });

  renderDriverList(true);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = actionable
    ? icon('i-info', 'hint-ico') + ' Use <b>Update drivers &amp; gaming runtimes</b> above to install compatible GPU/device packages plus missing DirectX and Visual C++ components.'
    : 'Nothing to install — every device and checked gaming runtime is ready.';
  area.appendChild(hint);
}

// ---- bulk driver update job -------------------------------------------
function activateDriverJob(job) {
  state.drvJobId = job.id;
  // Driver jobs get the same background treatment as Store installs, so the
  // user can close the window and keep browsing while drivers install.
  trayRegister(job.id, { name: 'Driver & gaming components' }, {
    kind: 'driver', iconName: 'i-wrench', doneText: 'Drivers and runtimes updated'
  });
  $('#drvBackdrop').classList.add('open');
  $('#drvCancel').style.display = '';
  $('#drvBackground').style.display = '';
  $('#drvRetry').style.display = 'none';
  $('#drvHint').textContent = 'Closing keeps the update running in the background.';
  paintDriverJob(job);
  if (state.drvTimer) clearInterval(state.drvTimer);
  state.drvTimer = setInterval(pollDriverJob, 1000);
}

$('#btnUpdateAllDrivers').addEventListener('click', async () => {
  const btn = $('#btnUpdateAllDrivers');
  btn.disabled = true;
  const r = await api('/api/drivers/update-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  if (!r.ok || !r.job) {
    btn.disabled = false;
    toast(r.error || 'Could not start the driver update', 'error');
    return;
  }
  activateDriverJob(r.job);
});

/** Poll the driver job while its window is open. */
async function pollDriverJob() {
  if (!state.drvJobId || state.drvPolling) return;
  const id = state.drvJobId;
  state.drvPolling = true;
  try {
    const r = await api('/api/drivers/jobs/' + id);
    if (!r.ok || !r.job) return;
    trayUpdate(id, r.job);
    if (state.drvJobId !== id) return;
    paintDriverJob(r.job);
    if (r.job.status === 'done' || r.job.status === 'error') {
      clearInterval(state.drvTimer);
      state.drvTimer = null;
      $('#drvCancel').style.display = 'none';
      $('#drvBackground').style.display = 'none';
      $('#drvRetry').style.display = r.job.retryable ? '' : 'none';
      $('#drvRetry').textContent = r.job.retryLabel || 'Retry failed items';
      $('#drvHint').textContent = r.job.retryable
        ? (r.job.networkFailed ? 'A network download failed. Check your connection and retry only the failed items.' : 'Some items failed. Retry only the failed items.')
        : 'Update finished.';
      await finishDriverJob(r.job);
    }
  } finally {
    state.drvPolling = false;
  }
}

/** Shared completion handling for foreground and background driver jobs. */
async function finishDriverJob(job) {
  $('#btnUpdateAllDrivers').disabled = false;
  if (announced.has('drv:' + job.id + ':' + job.status)) return;
  announced.add('drv:' + job.id + ':' + job.status);

  if (job.status === 'done') {
    if (job.failed) {
      toast((job.installed + (job.runtimeInstalled || 0)) + ' item(s) installed · ' +
        job.failed + ' failed' + (job.networkFailed ? ' because the network was unavailable' : ''), 'error');
    } else {
      const totalInstalled = job.installed + (job.runtimeInstalled || 0);
      toast(totalInstalled
        ? totalInstalled + ' driver / gaming item(s) installed ✓' + (job.reboot ? ' — restart required' : '')
        : 'No updates were needed', 'success');
    }
    // Re-scan so the list reflects what was just installed. Filter state is
    // kept on purpose (this is what the user picked — do not reset it).
    const scan = await api('/api/drivers/scan', { method: 'POST' });
    state.scanDevices = scan.devices || [];
    renderScan(scan);
  } else {
    toast(job.error || 'Driver update failed', 'error');
  }
}

/**
 * Push the running driver job into the background tray. The job itself lives
 * on the server, so this is purely a UI move — installs keep going.
 */
function backgroundDriverJob() {
  const id = state.drvJobId;
  $('#drvBackdrop').classList.remove('open');
  if (!id) return;
  const entry = state.tray.get(id);
  if (entry && entry.job && ['done', 'error'].includes(entry.job.status)) {
    trayRemove(id);
  } else {
    trayShow(id);
    if (state.drvTimer) { clearInterval(state.drvTimer); state.drvTimer = null; }
    driverTrayPoll(id);
    toast('Driver update continues in the background', 'info');
  }
  state.drvJobId = null;
}

/** Independent poll once the driver job has been backgrounded. */
function driverTrayPoll(id) {
  const e = state.tray.get(id);
  if (!e || e.timer) return;
  e.timer = setInterval(async () => {
    if (e.polling) return;
    e.polling = true;
    try {
      const r = await api('/api/drivers/jobs/' + id);
      if (!r.ok || !r.job) return;
      trayUpdate(id, r.job);
      if (['done', 'error'].includes(r.job.status)) {
        clearInterval(e.timer); e.timer = null;
        await finishDriverJob(r.job);
        if (r.job.status === 'done' && !r.job.retryable) setTimeout(() => trayRemove(id), 6000);
      }
    } finally {
      e.polling = false;
    }
  }, 1500);
}

/** Bring a backgrounded driver job back into its window. */
function reopenDriverJob() {
  let id = null;
  state.tray.forEach((e) => { if (e.kind === 'driver') id = e.id; });
  const e = id && state.tray.get(id);
  if (!e) return;
  if (e.timer) { clearInterval(e.timer); e.timer = null; }
  e.visible = false;
  if (e.el) e.el.remove();
  renderTray();
  state.drvJobId = id;
  $('#drvBackdrop').classList.add('open');
  if (e.job) paintDriverJob(e.job);
  const finished = e.job && ['done', 'error'].includes(e.job.status);
  $('#drvCancel').style.display = finished ? 'none' : '';
  $('#drvBackground').style.display = finished ? 'none' : '';
  $('#drvRetry').style.display = finished && e.job.retryable ? '' : 'none';
  $('#drvRetry').textContent = e.job && e.job.retryLabel || 'Retry failed items';
  $('#drvHint').textContent = finished && e.job.retryable
    ? (e.job.networkFailed ? 'A download failed because the network was unavailable. Retry the failed items.' : 'Retry only the failed items.')
    : (finished ? 'Update finished.' : 'Closing keeps the update running in the background.');
  if (!finished) {
    if (state.drvTimer) clearInterval(state.drvTimer);
    state.drvTimer = setInterval(pollDriverJob, 1000);
  }
}

function paintDriverJob(job) {
  const stages = ['repairing', 'searching', 'downloading', 'installing', 'runtimes', 'done'];
  const labels = {
    repairing: 'Repair', searching: 'Find', downloading: 'Download', installing: 'Install',
    runtimes: 'Game runtimes', done: 'Done'
  };
  const stageHtml = stages.map((s) => {
    let cls = '';
    if (job.stage === s) cls = 'on';
    else if (stages.indexOf(job.stage) > stages.indexOf(s) || job.status === 'done') cls = 'ok';
    return '<span class="' + cls + '">' + labels[s] + '</span>';
  }).join('');
  setNodeHtml($('#drvStages'), stageHtml);
  setNodeText($('#drvMeta'), [
    job.driverTotal ? job.driverTotal + ' driver(s)' : '',
    job.runtimeTotal ? job.runtimeTotal + ' gaming runtime(s)' : '',
    job.installed ? job.installed + ' driver(s) installed' : '',
    job.runtimeInstalled ? job.runtimeInstalled + ' runtime(s) installed' : '',
    job.failed ? job.failed + ' unresolved' : '',
    job.networkFailed ? job.networkFailed + ' network failure(s)' : '',
    job.reboot ? 'restart required' : '',
    job.mode === 'demo' ? 'demo pipeline' : 'no Windows Update needed'
  ].filter(Boolean).join('  ·  '));
  setNodeWidth($('#drvBar'), (job.percent || 0) + '%');
  setNodeText($('#drvPct'), Math.round(job.percent || 0) + '%');
  setNodeText($('#drvFile'), job.current || (job.status === 'done' ? 'Finished' : '…'));
  const log = $('#drvLog');
  if (setNodeText(log, (job.log || []).join('\n'))) log.scrollTop = log.scrollHeight;
  setNodeText($('#drvTitle'), job.status === 'done'
    ? (job.failed ? 'Update finished with problems' : 'Drivers and gaming runtimes updated')
    : (job.status === 'error' ? 'Driver update failed' : 'Updating drivers and gaming runtimes…'));
}

// Closing the driver window never stops the work — it backgrounds it, exactly
// like the Store install window does.
$('#drvClose').addEventListener('click', backgroundDriverJob);
$('#drvCloseBtn').addEventListener('click', backgroundDriverJob);
$('#drvBackground').addEventListener('click', backgroundDriverJob);
$('#drvBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) backgroundDriverJob();
});
$('#drvRetry').addEventListener('click', async () => {
  const oldId = state.drvJobId;
  if (!oldId) return;
  const btn = $('#drvRetry');
  btn.disabled = true;
  btn.textContent = 'Retrying…';
  const r = await api('/api/drivers/jobs/' + oldId + '/retry', { method: 'POST' });
  btn.disabled = false;
  if (!r.ok || !r.job) {
    btn.textContent = 'Retry failed items';
    toast(r.error || 'Could not retry the driver downloads', 'error');
    return;
  }
  trayRemove(oldId);
  activateDriverJob(r.job);
  toast('Retrying failed driver and gaming downloads', 'info');
});
$('#drvCancel').addEventListener('click', async () => {
  const id = state.drvJobId;
  if (!id) return;
  await api('/api/drivers/jobs/' + id + '/cancel', { method: 'POST' });
  trayRemove(id);
});
// ============================================================================
// TWEAK WORKBENCH — gaming / tweaks / customize
//
// All three pages are the same machine pointed at a different `section` of
// the tweak database. Tweaks are applied *directly* by the backend (never
// exported as a script), and the backend restarts Explorer after each one.
// ============================================================================

/** Per-section wiring: which DOM nodes belong to which section. */
const SECTIONS = {
  gaming: {
    grid: '#gamingGrid', presets: '#gamingPresetGrid', filter: '#gamingFilter',
    count: '#gamingSelCount', apply: '#btnApplyGaming', revert: '#btnGamingRevert',
    clear: '#btnGamingClear', label: 'gaming tweak'
  },
  tweaks: {
    grid: '#tweakGrid', presets: '#presetGrid', filter: '#tweaksFilter',
    count: '#tweaksSelCount', apply: '#btnApplySelected', revert: '#btnTweaksRevert',
    clear: '#btnTweaksClear', label: 'tweak'
  },
  customize: {
    grid: '#customizeGrid', presets: '#customizePresetGrid', filter: '#customizeFilter',
    count: '#customizeSelCount', apply: '#btnApplyVisual', revert: '#btnCustomizeRevert',
    clear: '#btnCustomizeClear', label: 'customization'
  }
};

/**
 * One consistent vector icon per tweak category (the old design used 119
 * different emoji, many of which render as tofu on minimal Windows fonts).
 */
const CATEGORY_ICONS = {
  'Latency & Network': 'i-wifi',
  'Game Optimization': 'i-gamepad',
  Performance: 'i-bolt',
  Privacy: 'i-shield',
  Appearance: 'i-sparkles',
  Taskbar: 'i-taskbar',
  'Start Menu': 'i-grid',
  'File Explorer': 'i-folder',
  'Desktop & Login': 'i-user',
  Debloat: 'i-trash',
  Cleanup: 'i-broom',
  System: 'i-cpu'
};
function tweakIcon(t) {
  return CATEGORY_ICONS[t && t.category] || 'i-sliders';
}

const PRESET_ICONS = {
  gaming: 'i-gamepad',
  netlatency: 'i-wifi',
  privacy: 'i-shield',
  balanced: 'i-scale',
  cleanup: 'i-broom',
  debloat: 'i-trash',
  win10look: 'i-window',
  powerlook: 'i-monitor'
};

/**
 * Fetch (once) and render the tweaks belonging to one section.
 * Guarded: two navigations arriving while the first fetch is in flight used
 * to render an empty grid, then a filled one — "the page changed by itself".
 */
async function loadSection(section) {
  const st = state.tweaks[section];
  if (!st) return;
  if (!st.loaded && !st.loading) {
    st.loading = api('/api/tweaks?section=' + encodeURIComponent(section))
      .then((data) => {
        st.list = data.tweaks || [];
        st.loaded = true;
      })
      .catch(() => {})
      .finally(() => { st.loading = null; });
  }
  await Promise.all([st.loading, loadPresets()].filter(Boolean));
  setSectionLabels(section);
  renderSection(section);
  renderSectionPresets(section);
}

async function loadPresets() {
  if (state.presetsLoaded) return state.presets;
  if (!state.presetsLoading) {
    state.presetsLoading = api('/api/tweaks/presets')
      .then((data) => {
        state.presets = data.presets || [];
        state.presetsLoaded = true;
        return state.presets;
      })
      .catch(() => state.presets)
      .finally(() => { state.presetsLoading = null; });
  }
  return state.presetsLoading;
}

/** Keep each sidebar subdivision focused on one tweak category. */
function setSectionLabels(section) {
  const category = state.tweakView[section] || '';
  if (section === 'gaming') {
    $('#gamingPageTitle').textContent = category || 'Gaming';
    $('#gamingSectionTitle').textContent = category ? category + ' Tweaks' : 'Gaming Tweaks';
  } else if (section === 'tweaks') {
    $('#tweaksPageTitle').textContent = category || 'Performance & Privacy Tweaks';
    $('#tweaksSectionTitle').textContent = category ? category + ' Tweaks' : 'Tweaks';
  }
}

/** Group a tweak list by its `category` field, preserving first-seen order. */
function groupByCategory(list) {
  const groups = [];
  const index = new Map();
  list.forEach((t) => {
    const cat = t.category || 'Other';
    if (!index.has(cat)) { index.set(cat, { name: cat, items: [] }); groups.push(index.get(cat)); }
    index.get(cat).items.push(t);
  });
  return groups;
}

function matchesFilter(t, needle) {
  if (!needle) return true;
  const hay = (t.name + ' ' + (t.description || '') + ' ' + (t.category || '')).toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function renderSection(section) {
  const cfg = SECTIONS[section];
  const st = state.tweaks[section];
  const grid = $(cfg.grid);
  if (!grid) return;

  const needle = st.filter.trim().toLowerCase();
  const category = state.tweakView[section] || '';
  const visible = st.list.filter((t) => (!category || t.category === category) && matchesFilter(t, needle));
  grid.innerHTML = '';

  if (!visible.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><svg class="ico big-ico" aria-hidden="true"><use href="#i-search"/></svg>' +
      (needle ? 'No ' + esc(cfg.label) + 's match “' + esc(st.filter) + '”.' : 'Loading…') + '</div>';
    updateSelCount(section);
    return;
  }

  groupByCategory(visible).forEach((group) => {
    const head = document.createElement('div');
    head.className = 'tweak-group-head';
    head.innerHTML =
      '<h3>' + esc(group.name) + '</h3>' +
      '<span class="count">' + group.items.length + '</span>' +
      '<span class="rule"></span>' +
      '<button class="grp-btn" type="button">Select all</button>';
    head.querySelector('.grp-btn').addEventListener('click', () => {
      const ids = group.items.map((t) => t.id);
      const allOn = ids.every((id) => st.selected.has(id));
      ids.forEach((id) => { if (allOn) st.selected.delete(id); else st.selected.add(id); });
      renderSection(section);
    });
    grid.appendChild(head);

    group.items.forEach((t) => grid.appendChild(tweakCard(section, t)));
  });

  updateSelCount(section);
}

function tweakCard(section, t) {
  const st = state.tweaks[section];
  const checked = st.selected.has(t.id);
  const status = state.tweakStatus[t.id] || '';
  const card = document.createElement('div');
  card.className = 'glass tweak-card' + (checked ? ' checked' : '') + (status ? ' ' + status : '');
  card.dataset.id = t.id;
  card.innerHTML =
    '<div class="tweak-top">' +
      '<span class="tweak-ico">' + icon(tweakIcon(t)) + '</span>' +
      '<span class="tweak-name">' + esc(t.name) + '</span>' +
      '<label class="switch"><input type="checkbox"' + (checked ? ' checked' : '') + '><span class="slider"></span></label>' +
    '</div>' +
    '<div class="tweak-desc">' + esc(t.description || '') + '</div>' +
    '<div class="tweak-foot">' +
      '<span class="risk ' + esc(t.risk || 'low') + '">' + esc(t.risk || 'low') + '</span>' +
      '<span class="spacer"></span>' +
      '<button class="tweak-btn apply" type="button" data-act="apply">Apply</button>' +
      (t.revert
        ? '<button class="tweak-btn revert" type="button" data-act="revert">Revert</button>'
        : '<button class="tweak-btn revert" type="button" disabled title="This tweak has no automatic revert">Revert</button>') +
    '</div>';

  const box = card.querySelector('input[type=checkbox]');
  box.addEventListener('change', () => {
    if (box.checked) st.selected.add(t.id); else st.selected.delete(t.id);
    card.classList.toggle('checked', box.checked);
    updateSelCount(section);
  });

  card.querySelectorAll('.tweak-btn[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runSingleTweak(section, t, btn.dataset.act, card);
    });
  });
  return card;
}

function updateSelCount(section) {
  const cfg = SECTIONS[section];
  const category = state.tweakView[section] || '';
  const n = state.tweaks[section].list.filter((t) => !category || t.category === category)
    .filter((t) => state.tweaks[section].selected.has(t.id)).length;
  const el = $(cfg.count);
  if (!el) return;
  el.textContent = n + ' selected';
  el.classList.toggle('has', n > 0);
}

/** Apply or revert one tweak. The backend restarts Explorer for us. */
async function runSingleTweak(section, tweak, mode, card) {
  card.classList.add('busy');
  const url = mode === 'revert' ? '/api/tweaks/revert' : '/api/tweaks/apply';
  const r = await api(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tweak.id, mode })
  });
  card.classList.remove('busy');

  if (r.skipped) { toast('“' + tweak.name + '” has no automatic revert', 'info'); return; }
  if (r.ok) {
    state.tweakStatus[tweak.id] = mode === 'revert' ? 'reverted' : 'applied';
    card.classList.remove('applied', 'reverted');
    card.classList.add(state.tweakStatus[tweak.id]);
    const verb = mode === 'revert' ? 'Reverted' : 'Applied';
    const exp = r.explorer && r.explorer.restarted ? ' · Explorer restarted' : '';
    toast(verb + ' “' + tweak.name + '” ✓' + exp, 'success');
  } else {
    toast('Could not ' + (mode === 'revert' ? 'revert' : 'apply') + ' “' + tweak.name + '”', 'error');
    showModal(tweak.name, [
      { text: String(r.error || 'The tweak reported a failure.') },
      { text: String(r.output || '') }
    ]);
  }
}

/** Apply or revert everything the user ticked in a section. */
async function runSectionBatch(section, mode) {
  const cfg = SECTIONS[section];
  const st = state.tweaks[section];
  // Keep the on-screen order, not Set insertion order.
  const category = state.tweakView[section] || '';
  const ids = st.list.filter((t) => !category || t.category === category)
    .map((t) => t.id).filter((id) => st.selected.has(id));
  if (!ids.length) {
    toast('Toggle at least one ' + cfg.label + ' first', 'info');
    return;
  }
  const btn = $(mode === 'revert' ? cfg.revert : cfg.apply);
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> ' + (mode === 'revert' ? 'Reverting…' : 'Applying…');

  const r = await api('/api/tweaks/apply-all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, mode })
  });

  btn.disabled = false;
  btn.innerHTML = original;
  reportBatch(r, mode, (mode === 'revert' ? 'Revert ' : 'Apply ') + ids.length + ' ' + cfg.label + (ids.length === 1 ? '' : 's'));
  ids.forEach((id) => { state.tweakStatus[id] = mode === 'revert' ? 'reverted' : 'applied'; });
  renderSection(section);
}

/** Shared result reporting for batch + preset runs. */
function reportBatch(r, mode, title) {
  if (!r || !r.ok) { toast('The batch failed to run', 'error'); return; }
  const results = r.results || [];
  const failed = r.failed || results.filter((x) => !x.ok && !x.skipped).length;
  const okCount = r.succeeded != null ? r.succeeded : results.filter((x) => x.ok).length;
  const verb = mode === 'revert' ? 'Reverted' : 'Applied';
  const exp = r.explorer && r.explorer.restarted ? ' · Explorer restarted' : '';

  if (failed) toast(verb + ' ' + okCount + ' of ' + results.length + ' · ' + failed + ' failed', 'error');
  else toast(verb + ' ' + okCount + ' item' + (okCount === 1 ? '' : 's') + ' ✓' + exp, 'success');

  showModal(title, results.map((x) => ({
    text: (x.skipped ? '– ' : (x.ok ? '✓ ' : '✕ ')) + (x.tweak || x.id) +
      (x.skipped ? ' (no revert available)' : ''),
    ok: x.ok
  })).concat(r.explorer && r.explorer.message
    ? [{ cmd: 'explorer', text: r.explorer.message }]
    : []));
}

// ---- presets ---------------------------------------------------------------
function renderSectionPresets(section) {
  const cfg = SECTIONS[section];
  const container = $(cfg.presets);
  if (!container) return;
  const list = state.presets.filter((p) => (p.section || 'tweaks') === section);
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:24px">No presets for this section.</div>';
    return;
  }
  list.forEach((p) => container.appendChild(presetCard(section, p)));
}

function presetCard(section, p) {
  const card = document.createElement('div');
  card.className = 'glass preset-card';
  if (p.accent) card.style.setProperty('--accent', p.accent);
  const n = (p.tweakIds || []).length;
  card.innerHTML =
    '<div class="preset-ico">' + icon(PRESET_ICONS[p.id] || 'i-sliders') + '</div>' +
    '<div class="preset-name">' + esc(p.name) + '</div>' +
    '<div class="preset-desc">' + esc(p.description || '') + '</div>' +
    '<div class="preset-count"><span class="preset-dot"></span>' + n + ' tweak' + (n === 1 ? '' : 's') + '</div>';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
  const apply = document.createElement('button');
  apply.className = 'btn btn-primary btn-sm';
  apply.style.flex = '1';
  apply.innerHTML = icon('i-bolt') + ' Apply';
  apply.onclick = (e) => { e.stopPropagation(); applyPreset(p, apply, 'apply'); };
  const select = document.createElement('button');
  select.className = 'btn btn-ghost btn-sm';
  select.textContent = 'Select';
  select.title = 'Tick this preset’s tweaks instead of applying them now';
  select.onclick = (e) => { e.stopPropagation(); selectPreset(section, p); };
  row.append(apply, select);
  card.appendChild(row);
  return card;
}

/** Tick the preset's tweaks so the user can review before applying. */
function selectPreset(section, p) {
  const st = state.tweaks[section];
  const known = new Set(st.list.map((t) => t.id));
  let hit = 0;
  (p.tweakIds || []).forEach((id) => { if (known.has(id)) { st.selected.add(id); hit++; } });
  renderSection(section);
  toast('Selected ' + hit + ' tweak' + (hit === 1 ? '' : 's') + ' from “' + p.name + '”', 'info');
}

async function applyPreset(preset, btn, mode) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Applying…';
  const r = await api('/api/tweaks/apply-preset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: preset.id, mode: mode || 'apply' })
  });
  btn.disabled = false;
  btn.innerHTML = original;
  reportBatch(r, mode, 'Preset: ' + preset.name);
  if (r && r.ok) {
    (preset.tweakIds || []).forEach((id) => { state.tweakStatus[id] = 'applied'; });
    Object.keys(SECTIONS).forEach(renderSection);
  }
}

// ---- section controls ------------------------------------------------------
Object.keys(SECTIONS).forEach((section) => {
  const cfg = SECTIONS[section];
  const filter = $(cfg.filter);
  if (filter) {
    let t = null;
    filter.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { state.tweaks[section].filter = filter.value; renderSection(section); }, 150);
    });
  }
  const apply = $(cfg.apply);
  if (apply) apply.addEventListener('click', () => runSectionBatch(section, 'apply'));
  const revert = $(cfg.revert);
  if (revert) revert.addEventListener('click', () => runSectionBatch(section, 'revert'));
  const clear = $(cfg.clear);
  if (clear) clear.addEventListener('click', () => {
    state.tweaks[section].selected.clear();
    renderSection(section);
  });
});
// ============================================================================
// IN-APP PRODUCT SHEET ("Get" window)
// ============================================================================

/** Skeleton shown while the Store catalog call is in flight. */
function productLoadingHtml(name) {
  return '<div class="product-loading">' +
    '<div class="pl-head">' +
      '<span class="spinner"></span>' +
      '<div>' +
        '<div class="pl-title">' + (name ? 'Loading ' + esc(name) + '…' : 'Loading product…') + '</div>' +
        '<div class="pl-sub">Fetching details from the Microsoft Store catalog</div>' +
      '</div>' +
    '</div>' +
    '<div class="pl-skeleton">' +
      '<div class="pl-box"></div>' +
      '<div class="pl-lines">' +
        '<div class="pl-bar h18 w60"></div>' +
        '<div class="pl-bar w40"></div>' +
        '<div class="pl-chips"><span class="pl-bar pill"></span><span class="pl-bar pill"></span></div>' +
      '</div>' +
    '</div>' +
    '<div class="pl-cta"><span class="pl-bar btn"></span><span class="pl-bar w45"></span></div>' +
    '<div class="pl-facts">' +
      '<div class="pl-bar card"></div><div class="pl-bar card"></div><div class="pl-bar card"></div>' +
    '</div>' +
  '</div>';
}

function factHtml(k, v) {
  if (!v) return '';
  return '<div class="product-fact"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
}

async function openProduct(productId, hint) {
  const id = String(productId || '').toUpperCase();
  if (!id) return;
  const body = $('#productBody');
  const cached = (hint && hint.productId === id) ? hint : (state.catalog || []).find((p) => p.productId === id);
  $('#productBackdrop').classList.add('open');
  body.scrollTop = 0;
  body.innerHTML = productLoadingHtml(cached && cached.name);

  const r = await api('/api/store/product/' + encodeURIComponent(id));
  // The user may have closed the sheet while we were loading.
  if (!$('#productBackdrop').classList.contains('open')) return;

  if (r && r.ok === false && !r.product && !cached) {
    body.innerHTML = '<div class="product-error">' +
      '<svg class="ico pe-ico" aria-hidden="true"><use href="#i-warn"/></svg>' +
      '<div class="pl-title">Could not load this product</div>' +
      '<div class="pl-sub">' + esc(r.error || 'The Store catalog did not answer.') + '</div>' +
      '</div>';
    return;
  }

  const p = Object.assign({}, cached || {}, (r && r.product) || {}, { productId: id });
  const shots = (p.screenshots || p.images || []).filter((s) => typeof s === 'string' && /^https?:/i.test(s)).slice(0, 8);

  const facts =
    factHtml('Publisher', p.publisher) +
    factHtml('Category', p.category) +
    factHtml('Price', p.price) +
    factHtml('Rating', p.rating ? (Math.round(p.rating * 10) / 10) + ' ★' + (p.ratingCount ? ' (' + p.ratingCount + ')' : '') : '') +
    factHtml('Version', p.version) +
    factHtml('Size', p.size ? fmtSize(p.size) : '') +
    factHtml('Product ID', id);

  body.innerHTML =
    '<div class="product-hero">' +
      iconHtml(p, 'pico') +
      '<div class="phead">' +
        '<h2>' + esc(p.name || id) + '</h2>' +
        '<div class="ppub">' + esc(p.publisher || 'Microsoft Store') + '</div>' +
        '<div class="product-meta">' +
          (p.price ? '<span class="badge ok">' + esc(p.price) + '</span>' : '') +
          (p.category ? '<span class="badge info">' + esc(p.category) + '</span>' : '') +
          (p.isGame ? '<span class="badge demo">Game</span>' : '') +
        '</div>' +
        '<div class="product-cta">' +
          '<button class="btn btn-primary" id="btnProductGet">' + icon('i-download') + ' Get</button>' +
          '<span class="cta-note">Universal method — every catalog, then FE3 rings Retail→RP→WIS→WIF, then a licensed Store install if needed.</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    (facts ? '<div class="product-section"><h4>Details</h4><div class="product-facts">' + facts + '</div></div>' : '') +
    (shots.length
      ? '<div class="product-section"><h4>Screenshots</h4><div class="product-shots">' +
        shots.map((s) => '<img src="' + esc(s) + '" alt="" loading="lazy" decoding="async">').join('') + '</div></div>'
      : '') +
    (p.desc ? '<div class="product-section"><h4>About</h4><div class="product-desc">' + esc(p.desc) + '</div></div>' : '');

  $('#btnProductGet').onclick = () => {
    closeProduct();
    startStoreInstall(id, p.name, p.icon);
  };
}

function closeProduct() { $('#productBackdrop').classList.remove('open'); }
$('#btnProductClose').addEventListener('click', closeProduct);
$('#productBackdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeProduct();
});

// ============================================================================
// STORE INSTALL — modal + background tray
//
// The job itself lives on the server, so "closing" the window is purely a UI
// decision: the poll keeps running and the progress collapses into a card in
// the bottom-right tray. Only "Cancel install" actually aborts the job.
// ============================================================================

async function startStoreInstall(urlOrId, name, iconUrl) {
  const r = await api('/api/store/install', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: urlOrId })
  });
  if (!r.ok || !r.job) { toast(r.error || 'Could not start install', 'error'); return; }

  state.jobId = r.job.id;
  state.jobProduct = { name: name || urlOrId, icon: iconUrl || '' };
  // Register it in the tray bookkeeping immediately; the card only appears
  // once the window is backgrounded or finishes while hidden.
  trayRegister(r.job.id, state.jobProduct);

  openJobModal(r.job);
  paintJob(r.job);
  if (state.jobTimer) clearInterval(state.jobTimer);
  state.jobTimer = setInterval(pollJob, 1000);
}

function openJobModal(job) {
  $('#jobBackdrop').classList.add('open');
  $('#jobCancel').style.display = '';
  $('#jobBackground').style.display = '';
  $('#jobBackground').innerHTML = icon('i-chevron-down') + ' Keep in background';
  $('#jobLaunch').style.display = 'none';
  $('#jobFolder').style.display = 'none';
  $('#jobRetry').style.display = 'none';
  if ($('#jobNotes')) { $('#jobNotes').style.display = 'none'; $('#jobNotes').innerHTML = ''; }
  $('#jobHint').textContent = 'Closing keeps the install running in the background.';
  const meta = state.tray.get(state.jobId);
  const appIcon = meta && meta.product && meta.product.icon;
  $('#jobIcon').innerHTML = (appIcon && /^https?:\/\//i.test(appIcon))
    ? '<img src="' + esc(appIcon) + '" alt="">'
    : icon('i-download');
  if (job) paintJob(job);
}

/** Poll the job shown in the modal. */
async function pollJob() {
  if (!state.jobId || state.jobPolling) return;
  const id = state.jobId;
  state.jobPolling = true;
  try {
    const r = await api('/api/store/jobs/' + id);
    if (!r.ok || !r.job) return;
    trayUpdate(id, r.job);
    if (state.jobId !== id) return;   // modal moved on while we were awaiting
    paintJob(r.job);
    if (r.job.status === 'done' || r.job.status === 'error' || r.job.status === 'cancelled') {
      clearInterval(state.jobTimer); state.jobTimer = null;
      $('#jobCancel').style.display = 'none';
      $('#jobBackground').textContent = 'Close';
      $('#jobHint').textContent = r.job.status === 'done'
        ? (r.job.rebootRequired ? 'Done — restart Windows to finish.' : 'All done.')
        : (r.job.failureKind === 'network'
          ? 'Download failed. Check your internet connection, then retry.'
          : (r.job.status === 'error' ? 'Installation failed. You can retry with a fresh download.' : ''));
      showRetryAction(r.job);
      showFinishActions(r.job);
      showJobNotes(r.job);
      announceJob(r.job);
    }
  } finally {
    state.jobPolling = false;
  }
}

function announceJob(job) {
  if (!job || announced.has(job.id + ':' + job.status)) return;
  announced.add(job.id + ':' + job.status);
  const nm = (job.product && job.product.name) || (state.tray.get(job.id) || {}).name || 'App';
  if (job.status === 'done') toast(nm + ' ready ✓', 'success');
  else if (job.status === 'cancelled') toast(nm + ' install cancelled', 'info');
  else if (job.status === 'error') toast(job.error || (nm + ' install failed'), 'error');
}

function paintJob(job) {
  const stages = ['resolving', 'downloading', 'installing', 'done'];
  const labels = { resolving: 'Catalog', downloading: 'Download', installing: 'Install', done: 'Done' };
  const stageHtml = stages.map((s) => {
    let cls = '';
    if (job.stage === s) cls = 'on';
    else if (stages.indexOf(job.stage) > stages.indexOf(s) || job.status === 'done') cls = 'ok';
    return '<span class="' + cls + '">' + labels[s] + '</span>';
  }).join('');
  setNodeHtml($('#jobStages'), stageHtml);

  const p = job.product || {};
  setNodeText($('#jobMeta'), [
    p.publisher || '',
    job.arch ? 'arch ' + job.arch : '',
    job.uwp === false ? 'Win32 installer' : 'UWP package',
    job.files && job.files.length ? job.files.length + ' file(s)' : '',
    job.demo ? 'demo pipeline' : ''
  ].filter(Boolean).join('  ·  '));

  const pct = Math.round(job.percent || 0);
  setNodeWidth($('#jobBar'), pct + '%');
  setNodeText($('#jobPct'), pct + '%');
  setNodeText($('#jobStageLabel'), labels[job.stage] || 'Working');

  const fpct = Math.round(job.filePercent || 0);
  setNodeWidth($('#jobFileBar'), fpct + '%');
  setNodeText($('#jobFilePct'), job.currentFile ? fpct + '%' : '');
  setNodeText($('#jobFile'), job.currentFile || (job.status === 'done' ? 'Finished' : 'Preparing…'));

  const log = $('#jobLog');
  if (setNodeText(log, (job.log || []).join('\n'))) log.scrollTop = log.scrollHeight;

  const nm = p.name || (state.tray.get(job.id) || {}).name || '';
  const verb = job.status === 'done' ? 'Installed '
    : job.status === 'error' ? 'Failed: '
      : job.status === 'cancelled' ? 'Cancelled: ' : 'Installing ';
  setNodeText($('#jobTitle'), verb + nm);
}

/**
 * "Keep in background": hide the modal, leave the job (and its poll) alive,
 * and show a compact status card bottom-right.
 */
function backgroundCurrentJob() {
  const id = state.jobId;
  $('#jobBackdrop').classList.remove('open');
  if (!id) return;
  const entry = state.tray.get(id);
  if (entry && entry.job && ['done', 'error', 'cancelled'].includes(entry.job.status)) {
    // Finished already — nothing worth keeping on screen.
    trayRemove(id);
  } else {
    trayShow(id);
    // The modal poll stops; the tray takes over so the install keeps
    // reporting while the user browses other pages.
    if (state.jobTimer) { clearInterval(state.jobTimer); state.jobTimer = null; }
    trayStartPoll(id);
    toast('Install continues in the background', 'info');
  }
  state.jobId = null;
}

/**
 * Machine-level warnings that stop an installed Store app from ever starting:
 * a disabled AppX/licence service, sideloading blocked by policy, or a
 * DRM-encrypted package with no Store licence. Without this the app simply
 * "does nothing" when clicked and the user has no idea why.
 */
function showJobNotes(job) {
  const box = $('#jobNotes');
  if (!box) return;
  const notes = (job && job.notes) || [];
  if (!notes.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = notes.map((n) => '<div class="job-note ico-line">' + icon('i-warn') + ' <span>' + esc(n) + '</span></div>').join('');
}

function showRetryAction(job) {
  const btn = $('#jobRetry');
  if (!btn) return;
  const show = job && job.status === 'error' && job.retryable;
  btn.style.display = show ? '' : 'none';
  btn.innerHTML = icon('i-undo') + ' ' + esc((job && job.retryLabel) || 'Retry install');
}

function showFinishActions(job) {
  const launchBtn = $('#jobLaunch');
  const folderBtn = $('#jobFolder');
  const ok = job && job.status === 'done' && !job.demo;
  const target = ok && job.launch;
  const folder = ok && (job.installFolder || null);

  launchBtn.style.display = target ? '' : 'none';
  folderBtn.style.display = folder ? '' : 'none';
  launchBtn.dataset.target = target || '';
  folderBtn.dataset.target = folder || '';
}

$('#jobLaunch').addEventListener('click', async () => {
  const target = $('#jobLaunch').dataset.target;
  if (!target) return;
  if (window.zlag && window.zlag.shell) {
    const r = await window.zlag.shell.openPath(target);
    if (r && r.ok === false) toast(r.error || 'Could not open the app', 'error');
  } else {
    toast('Open the app from the Start menu', 'info');
  }
});

$('#jobFolder').addEventListener('click', () => {
  const target = $('#jobFolder').dataset.target;
  if (target && window.zlag && window.zlag.shell) window.zlag.shell.openPath(target);
});

$('#jobRetry').addEventListener('click', async () => {
  const oldId = state.jobId;
  if (!oldId) return;
  const previous = state.tray.get(oldId);
  const product = previous && previous.product || state.jobProduct || { name: 'App', icon: '' };
  const btn = $('#jobRetry');
  btn.disabled = true;
  btn.textContent = 'Retrying…';
  const r = await api('/api/store/jobs/' + oldId + '/retry', { method: 'POST' });
  btn.disabled = false;
  if (!r.ok || !r.job) {
    btn.textContent = 'Retry install';
    toast(r.error || 'Could not retry the app download', 'error');
    return;
  }
  trayRemove(oldId);
  state.jobId = r.job.id;
  state.jobProduct = product;
  trayRegister(r.job.id, product);
  openJobModal(r.job);
  paintJob(r.job);
  if (state.jobTimer) clearInterval(state.jobTimer);
  state.jobTimer = setInterval(pollJob, 1000);
  toast('Retrying with a fresh download link', 'info');
});

$('#jobClose').addEventListener('click', backgroundCurrentJob);
$('#jobBackground').addEventListener('click', backgroundCurrentJob);
$('#jobBackdrop').addEventListener('click', (e) => { if (e.target === e.currentTarget) backgroundCurrentJob(); });

// Cancel aborts the install *and* closes the whole install window.
$('#jobCancel').addEventListener('click', async () => {
  const id = state.jobId;
  if (!id) return;
  $('#jobCancel').disabled = true;
  await api('/api/store/jobs/' + id + '/cancel', { method: 'POST' });
  $('#jobCancel').disabled = false;
  if (state.jobTimer) { clearInterval(state.jobTimer); state.jobTimer = null; }
  $('#jobBackdrop').classList.remove('open');
  trayRemove(id);
  state.jobId = null;
  toast('Install cancelled', 'info');
});

// ---- the bottom-right tray -------------------------------------------------
function trayRegister(id, product, opts) {
  opts = opts || {};
  state.tray.set(id, {
    id,
    kind: opts.kind || 'store',
    name: product.name,
    product,
    iconName: opts.iconName || 'i-download',
    doneText: opts.doneText || 'Installed',
    job: null,
    timer: null,
    polling: false,
    visible: false,
    el: null,
    painted: {}
  });
}

function trayShow(id) {
  const e = state.tray.get(id);
  if (!e) return;
  e.visible = true;
  renderTray();
}

function trayRemove(id) {
  const e = state.tray.get(id);
  if (e && e.timer) clearInterval(e.timer);
  if (e && e.el) e.el.remove();
  state.tray.delete(id);
  renderTray();
}

function trayUpdate(id, job) {
  const e = state.tray.get(id);
  if (!e) return;
  e.job = job;
  // Repaint just this card — a full renderTray() on every tick is what used
  // to make every other card blink too.
  if (e.visible) paintTrayCard(e);
}

/** Independent poll used once a job has been pushed to the tray. */
function trayStartPoll(id) {
  const e = state.tray.get(id);
  if (!e || e.timer) return;
  e.timer = setInterval(async () => {
    if (e.polling) return;
    e.polling = true;
    try {
      const r = await api('/api/store/jobs/' + id);
      if (!r.ok || !r.job) return;
      trayUpdate(id, r.job);
      if (['done', 'error', 'cancelled'].includes(r.job.status)) {
        clearInterval(e.timer); e.timer = null;
        announceJob(r.job);
        // Successful installs fade out on their own; failures stay put so the
        // user can click through and read the log.
        if (r.job.status === 'done') setTimeout(() => trayRemove(id), 6000);
      }
    } finally {
      e.polling = false;
    }
  }, 1500);
}

/**
 * Render the background-job tray.
 *
 * THE BLINKING FIX: this used to do `wrap.innerHTML = ''` and rebuild every
 * card from scratch on every poll tick (450–700 ms). Each rebuild restarted
 * the `trayIn` slide-in animation and re-created the <img>, so the card
 * visibly flashed several times a second for the whole install.
 *
 * Now each job owns ONE persistent DOM node that is created once and then
 * only has its text / width mutated. Nothing re-animates, nothing reflows
 * from scratch, and the progress bar glides instead of strobing.
 */
function trayCardFor(entry) {
  if (entry.el && entry.el.isConnected) return entry.el;

  const card = document.createElement('div');
  card.className = 'tray-card';
  card.title = 'Click to reopen';
  card.innerHTML =
    '<div class="tray-ico" data-role="ico"></div>' +
    '<div class="tray-info">' +
      '<div class="tray-name" data-role="name"></div>' +
      '<div class="tray-sub" data-role="sub"></div>' +
    '</div>' +
    '<div class="tray-pct" data-role="pct"></div>' +
    '<button class="tray-x" type="button" title="Dismiss">' +
      '<svg class="ico" aria-hidden="true"><use href="#i-x"/></svg></button>' +
    '<div class="tray-bar"><div class="tray-bar-fill" data-role="bar"></div></div>';

  card.querySelector('.tray-x').addEventListener('click', (ev) => {
    ev.stopPropagation();
    trayRemove(entry.id);
  });
  card.addEventListener('click', () => {
    if (entry.kind === 'driver') reopenDriverJob();
    else reopenJob(entry.id);
  });

  entry.el = card;
  entry.painted = {};      // last values, so we only touch the DOM on change
  return card;
}

/** Update one card in place — only the properties that actually changed. */
function paintTrayCard(entry) {
  const card = trayCardFor(entry);
  const job = entry.job || {};
  const status = job.status || 'running';
  const pct = Math.round(job.percent || 0);
  const prev = entry.painted;
  const hasFailure = status === 'error' || (entry.kind === 'driver' && status === 'done' && job.failed);

  const cls = 'tray-card' +
    (hasFailure ? ' error' : (status === 'done' ? ' done' : ''));
  if (prev.cls !== cls) { card.className = cls; prev.cls = cls; }

  if (prev.name !== entry.name) {
    card.querySelector('[data-role="name"]').textContent = entry.name || 'Working';
    prev.name = entry.name;
  }

  const sub = status === 'done'
    ? (hasFailure ? job.failed + ' failed — click to retry' : (entry.doneText || 'Installed'))
    : status === 'error' ? (job.error || 'Failed')
      : status === 'cancelled' ? 'Cancelled'
        : (job.currentFile || job.current || job.stage || 'Working…');
  if (prev.sub !== sub) {
    card.querySelector('[data-role="sub"]').textContent = sub;
    prev.sub = sub;
  }

  const pctText = hasFailure ? '!' : (status === 'done' ? '✓' : pct + '%');
  if (prev.pctText !== pctText) {
    card.querySelector('[data-role="pct"]').textContent = pctText;
    prev.pctText = pctText;
  }

  const width = (status === 'done' ? 100 : pct) + '%';
  if (prev.width !== width) {
    card.querySelector('[data-role="bar"]').style.width = width;
    prev.width = width;
  }

  // The icon is the expensive one — an <img> re-created every tick is what
  // made the card flicker white. Only ever write it when it truly changes.
  const appIcon = entry.product && entry.product.icon;
  const iconKey = status + ':' + (appIcon || entry.iconName || '');
  if (prev.iconKey !== iconKey) {
    card.querySelector('[data-role="ico"]').innerHTML =
      (appIcon && /^https?:\/\//i.test(appIcon) && !hasFailure)
        ? '<img src="' + esc(appIcon) + '" alt="">'
        : icon(hasFailure ? 'i-warn'
          : (status === 'done' ? 'i-check' : (entry.iconName || 'i-download')));
    prev.iconKey = iconKey;
  }
  return card;
}

function renderTray() {
  const wrap = $('#jobTray');
  if (!wrap) return;

  const wanted = [];
  state.tray.forEach((e) => { if (e.visible) wanted.push(e); });

  // Remove cards whose job is gone — without touching the survivors.
  Array.from(wrap.children).forEach((child) => {
    if (!wanted.some((e) => e.el === child)) child.remove();
  });

  wanted.forEach((e) => {
    const card = paintTrayCard(e);
    if (card.parentNode !== wrap) wrap.appendChild(card);
  });
}

/** Bring a backgrounded install back into the full window. */
function reopenJob(id) {
  const e = state.tray.get(id);
  if (!e) return;
  if (e.timer) { clearInterval(e.timer); e.timer = null; }
  e.visible = false;
  renderTray();
  state.jobId = id;
  state.jobProduct = e.product;
  openJobModal(e.job);
  const finished = e.job && ['done', 'error', 'cancelled'].includes(e.job.status);
  if (finished) {
    $('#jobCancel').style.display = 'none';
    $('#jobBackground').textContent = 'Close';
    showRetryAction(e.job);
    showFinishActions(e.job);
    showJobNotes(e.job);
    $('#jobHint').textContent = e.job.failureKind === 'network'
      ? 'Download failed. Check your internet connection, then retry.'
      : (e.job.status === 'error' ? 'Installation failed. Retry with a fresh download.' : 'All done.');
  } else {
    $('#jobBackground').innerHTML = icon('i-chevron-down') + ' Keep in background';
    if (state.jobTimer) clearInterval(state.jobTimer);
    state.jobTimer = setInterval(pollJob, 1000);
  }
}

// ---------------------------------------------------------------- init
boot();
