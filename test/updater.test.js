'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdater, cleanError } = require('../electron/updater');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function mockAutoUpdater(nextVersion) {
  const updater = new EventEmitter();
  updater.downloads = 0;
  updater.installs = 0;
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: nextVersion || '2.2.0' });
  };
  updater.downloadUpdate = async () => {
    updater.downloads++;
    updater.emit('download-progress', { percent: 42.5, transferred: 425, total: 1000 });
    updater.emit('update-downloaded', { version: nextVersion || '2.2.0' });
  };
  updater.quitAndInstall = () => { updater.installs++; };
  return updater;
}

function baseOptions(autoUpdater, overrides) {
  return Object.assign({
    app: { isPackaged: true, getVersion: () => '2.1.0' },
    autoUpdater,
    platform: 'win32',
    portable: false,
    getWindow: () => null,
    log: () => {},
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { openExternal: async () => {} }
  }, overrides || {});
}

test('installed builds download a GitHub update and expose ready state', async () => {
  const autoUpdater = mockAutoUpdater('2.2.0');
  const service = createUpdater(baseOptions(autoUpdater));

  assert.equal(service.init().status, 'idle');
  await service.check();
  await tick();

  const state = service.status();
  assert.equal(autoUpdater.downloads, 1);
  assert.equal(state.status, 'ready');
  assert.equal(state.version, '2.2.0');
  assert.equal(state.percent, 100);
  assert.deepEqual(service.install(), { ok: true });
  await tick();
  assert.equal(autoUpdater.installs, 1);
});

test('portable builds notify without downloading or self-installing', async () => {
  const autoUpdater = mockAutoUpdater('2.2.0');
  const opened = [];
  const service = createUpdater(baseOptions(autoUpdater, {
    portable: true,
    shell: { openExternal: async (url) => { opened.push(url); } }
  }));

  service.init();
  await service.check();
  await tick();

  assert.equal(service.status().status, 'available');
  assert.equal(service.status().portable, true);
  assert.equal(autoUpdater.downloads, 0);
  assert.equal(service.install().portable, true);
  await tick();
  assert.match(opened[0], /github\.com\/MrPcGamerYT\/Z-LAG-TOOLBOX\/releases\/latest/);
});

test('development and non-Windows builds keep updater disabled', () => {
  const service = createUpdater({
    app: { isPackaged: false, getVersion: () => '2.1.0' },
    platform: 'linux'
  });
  const state = service.init();
  assert.equal(state.status, 'disabled');
  assert.equal(state.supported, false);
});

test('updater errors are compact and redact authorization values', () => {
  const cleaned = cleanError(new Error('Authorization:secret-token\n request failed'));
  assert.doesNotMatch(cleaned, /secret-token/);
  assert.match(cleaned, /\[redacted\]/);
  assert.doesNotMatch(cleaned, /\n/);
});
