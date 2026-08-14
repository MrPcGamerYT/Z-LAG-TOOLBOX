'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classifyFailure } = require('../server/store/jobs');

test('Store download/network failures are classified for the Retry download action', () => {
  assert.equal(classifyFailure(new Error('getaddrinfo ENOTFOUND cdn.example'), 'resolving'), 'network');
  assert.equal(classifyFailure(new Error('Download timed out'), 'downloading'), 'network');
  assert.equal(classifyFailure(new Error('SHA-256 mismatch'), 'downloading'), 'network');
});

test('Store install failures keep a distinct retry label', () => {
  assert.equal(classifyFailure(new Error('Add-AppxPackage failed with 0x80073CF3'), 'installing'), 'install');
  assert.equal(classifyFailure(new Error('Product id was not found'), 'resolving'), 'catalog');
});
