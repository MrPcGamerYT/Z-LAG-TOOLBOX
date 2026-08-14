/* ============================================================================
 * Z-LAG TOOLBOX — optional HTTP server (headless / dev mode)
 * ----------------------------------------------------------------------------
 * The real product is the native Electron app (`npm start`), which needs no
 * server and opens no port. This file exists only for:
 *
 *   • developing the UI in a normal browser  (`npm run dev:web`)
 *   • running the toolbox headless on a remote/CLI Windows box
 *
 * All logic lives in server/core.js and is shared with the desktop app, so
 * both frontends behave identically.
 *
 *   node server/server.js            → http://127.0.0.1:3355
 *   PORT=8080 node server/server.js  → custom port
 *   ZLAG_HOST=0.0.0.0 node …         → expose on the network (opt-in)
 * ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const core = require('./core');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = parseInt(process.env.PORT, 10) || 3355;
// Bind to loopback by default — this is a machine-local tool, not a web service.
const HOST = process.env.ZLAG_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

function sendJson(res, code, obj) {
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  if (res.headersSent || res.writableEnded) return;
  const target = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.resolve(PUBLIC, '.' + target);
  if (normalized !== PUBLIC && !normalized.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, { 'X-Content-Type-Options': 'nosniff' });
    res.end('Forbidden');
    return;
  }
  fs.stat(normalized, (err, stat) => {
    if (res.headersSent || res.writableEnded) return;
    if (err || !stat.isFile()) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (res.headersSent || res.writableEnded) return;
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(normalized).toLowerCase()] || 'application/octet-stream'
    });
    fs.createReadStream(normalized).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    const query = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const body = req.method === 'POST' ? await readBody(req) : {};

    const r = await core.dispatch(req.method, pathname, query, body);
    return sendJson(res, r.status, r.body);
  } catch (e) {
    console.error('Handler error:', e && e.message);
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { ok: false, error: 'Internal server error' });
    } else { try { res.end(); } catch (_) {} }
  }
});

server.listen(PORT, HOST, () => {
  const mode = core.IS_WINDOWS ? 'REAL (Windows commands active)' : 'DEMO (simulated)';
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  Z-LAG TOOLBOX  ·  headless / dev server     │');
  console.log('└──────────────────────────────────────────────┘');
  console.log('  http://' + HOST + ':' + PORT);
  console.log('  Mode: ' + mode + ' | Platform: ' + process.platform);
  console.log('');
  console.log('  Tip: the real desktop app is `npm start` — it runs in its own');
  console.log('       native window with no server and no browser involved.');
});
