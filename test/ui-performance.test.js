'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('lightweight rendering is enabled by default without removing spinner feedback', () => {
  const html = read('public/index.html');
  const css = read('public/css/style.css');

  assert.match(html, /<body\s+class="lightweight">/);
  assert.match(css, /body\.lightweight \.bg \{ display: none; \}/);
  assert.match(css, /body\.lightweight \*[^}]+backdrop-filter: none !important;/s);
  assert.match(css, /body\.lightweight \.spinner \{\s*animation: spin/);
  assert.match(css, /content-visibility: auto;/);
});

test('hidden Store and tweak pages are not eagerly loaded during boot', () => {
  const js = read('public/js/app.js');
  const boot = js.match(/async function boot\(\) \{([\s\S]*?)\n\}/);

  assert.ok(boot, 'boot function should exist');
  assert.doesNotMatch(boot[1], /loadFeatured\(|loadCategories\(|loadPresets\(|loadSection\(/);
  assert.match(js, /if \(page === 'store'\) loadStore\(\);/);
  assert.match(js, /const STORE_PAGE = 32;/);
  assert.match(js, /loading="lazy" decoding="async"/);
});

test('renderer work is throttled while the Electron window is hidden', () => {
  const main = read('electron/main.js');
  assert.match(main, /backgroundThrottling: true/);
  assert.doesNotMatch(main, /backgroundThrottling: false/);
});
