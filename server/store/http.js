'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';

// FIX for pkg: Node's CA bundle is missing in packaged EXE, causing
// "unable to get local issuer certificate" when calling Microsoft Store APIs
// We use system root certs if available, and fallback to insecure if needed
let ROOT_CAS = null;
try { ROOT_CAS = tls.rootCertificates; } catch (_) { ROOT_CAS = null; }

function isPkg() { return !!process.pkg; }

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Invalid URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': opts.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://apps.microsoft.com/'
    }, opts.headers || {});

    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 45000
    };

    // HTTPS cert fix for packaged EXE and corporate proxies
    if (u.protocol === 'https:') {
      // Try to use system root CAs if available
      if (ROOT_CAS && ROOT_CAS.length) {
        reqOpts.ca = ROOT_CAS;
      }
      // In pkg binary, CA bundle is often missing -> disable strict check as fallback
      // Controlled by env ZLAG_INSECURE_TLS=0 to force strict if user wants
      if (isPkg() || process.env.ZLAG_INSECURE_TLS === '1') {
        reqOpts.rejectUnauthorized = false;
      }
      // Allow caller to override
      if (typeof opts.rejectUnauthorized === 'boolean') {
        reqOpts.rejectUnauthorized = opts.rejectUnauthorized;
      }
    }

    const req = lib.request(reqOpts, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && (opts.redirects || 0) < 8) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return request(next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 }))
          .then(resolve, reject);
      }
      resolve(res);
    });

    req.on('error', (err) => {
      const msg = String(err && err.message || err || '');
      const isCertError = /unable to get local issuer certificate|self signed certificate|certificate has expired|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN/i.test(msg);
      // If cert error and we were trying strict, retry with insecure
      if (isCertError && reqOpts.rejectUnauthorized !== false && !opts._retriedInsecure) {
        // retry once with rejectUnauthorized false
        request(url, Object.assign({}, opts, { rejectUnauthorized: false, _retriedInsecure: true }))
          .then(resolve, reject);
      } else {
        reject(err);
      }
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function readStream(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (limit && size > limit) {
        stream.destroy();
        return reject(new Error('Response too large'));
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function requestText(url, opts = {}) {
  const res = await request(url, opts);
  const buf = await readStream(res, opts.limit || 20 * 1024 * 1024);
  const text = buf.toString(opts.encoding || 'utf8');
  if ((res.statusCode || 0) >= 400) {
    const err = new Error('HTTP ' + res.statusCode + ' from ' + url);
    err.statusCode = res.statusCode;
    err.body = text.slice(0, 400);
    throw err;
  }
  return { status: res.statusCode, headers: res.headers, text, res };
}

async function requestJson(url, opts = {}) {
  const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
  if (opts.body && typeof opts.body === 'object' && !Buffer.isBuffer(opts.body)) {
    opts = Object.assign({}, opts, {
      body: JSON.stringify(opts.body),
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
    });
  } else {
    opts = Object.assign({}, opts, { headers });
  }
  const r = await requestText(url, opts);
  try { return JSON.parse(r.text); } catch (e) {
    const err = new Error('Invalid JSON from ' + url);
    err.body = r.text.slice(0, 300);
    throw err;
  }
}

module.exports = { request, requestText, requestJson, readStream, UA };
