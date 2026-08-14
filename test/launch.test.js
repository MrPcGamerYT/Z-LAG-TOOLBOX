'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launch = require('../electron/launch');

function tempState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlag-launch-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('startup marker enables recovery only after an unhealthy attempt', (t) => {
  const dir = tempState(t);
  assert.equal(launch.previousStartupFailed(dir), false);

  assert.equal(launch.beginStartup(dir, 'test-start'), true);
  assert.equal(launch.previousStartupFailed(dir), true);

  assert.equal(launch.markStartupHealthy(dir, 'test-ready'), true);
  assert.equal(launch.previousStartupFailed(dir), false);
});

test('elevation handoff accepts only JSON files under the state handoff directory', (t) => {
  const dir = tempState(t);
  const file = launch.createHandoffPath(dir);

  assert.equal(launch._internals.safeHandoffPath(file, dir), true);
  assert.equal(launch._internals.safeHandoffPath(path.join(dir, 'outside.json'), dir), false);
  assert.equal(launch._internals.safeHandoffPath(path.join(dir, 'handoff', 'bad.txt'), dir), false);
});

test('elevation parent receives the child ready acknowledgement', async (t) => {
  const dir = tempState(t);
  const file = launch.createHandoffPath(dir);
  const waiting = launch.waitForHandoff(file, dir, 2000);

  setTimeout(() => {
    launch.signalHandoff(file, dir, 'ready', 'window-painted');
  }, 25);

  const result = await waiting;
  assert.equal(result.phase, 'ready');
  assert.equal(result.detail, 'window-painted');
  assert.equal(fs.existsSync(file), false);
});
