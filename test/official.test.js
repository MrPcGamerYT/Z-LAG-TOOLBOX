'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  wingetArgs, wingetSuccess, isStoreProductId,
  parseWingetProgress, parseDiscover, discoverLaunchCommand,
  appInstallManagerScript, needsLicensedFallback, looksEncrypted
} = require('../server/store/official');

test('Store product ids are recognised (9 + 11 alphanumerics)', () => {
  assert.ok(isStoreProductId('9NCBCSZSJRSB'));
  assert.ok(isStoreProductId('9n0dx20hk701'));
  assert.ok(!isStoreProductId('XP8K0J757HPH6W'));
  assert.ok(!isStoreProductId('Spotify.Spotify'));
});

test('WinGet is invoked like the Store: msstore + silent + accept agreements', () => {
  const args = wingetArgs('9NCBCSZSJRSB', 'msstore');
  assert.deepStrictEqual(args.slice(0, 3), ['install', '--id', '9NCBCSZSJRSB']);
  assert.ok(args.includes('--source') && args.includes('msstore'));
  assert.ok(args.includes('--accept-package-agreements'));
  assert.ok(args.includes('--accept-source-agreements'));
  assert.ok(args.includes('--disable-interactivity'));
  assert.ok(args.includes('--silent'));
});

test('already-installed WinGet codes count as success', () => {
  assert.ok(wingetSuccess(0));
  assert.ok(wingetSuccess(-1978335189));
  assert.ok(!wingetSuccess(1));
  assert.ok(!wingetSuccess(-1978335217));
});

test('WinGet progress lines become a percent', () => {
  assert.strictEqual(parseWingetProgress('Downloading  45%'), 45);
  assert.strictEqual(parseWingetProgress('  3.0 MB / 10.0 MB'), 30);
  assert.strictEqual(parseWingetProgress('hello'), null);
});

test('Start-menu discovery yields a shell:AppsFolder launch id', () => {
  const info = parseDiscover([
    'name=Spotify',
    'appid=SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
    'family=SpotifyAB.SpotifyMusic_zpdnekdrzrea0',
    'state=Ok'
  ].join('\n'));
  assert.strictEqual(info.launch, 'shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify');
  assert.strictEqual(info.appId, 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify');
});

test('discovery queries Get-StartApps (the Start menu catalog)', () => {
  const cmd = discoverLaunchCommand('9NCBCSZSJRSB', 'Spotify', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0');
  assert.match(cmd, /Get-StartApps/);
  assert.match(cmd, /Get-AppxPackage/);
});

test('Store API fallback uses AppInstallManager, not Add-AppxPackage', () => {
  const cmd = appInstallManagerScript('9NCBCSZSJRSB');
  assert.match(cmd, /AppInstallManager/);
  assert.match(cmd, /StartAppInstallAsync/);
  assert.ok(!/Add-AppxPackage/.test(cmd));
});

test('licensed fallback runs when sideload cannot launch or is encrypted', () => {
  assert.strictEqual(needsLicensedFallback({ ok: false }), true);
  assert.strictEqual(needsLicensedFallback({ ok: true, launch: 'shell:AppsFolder\\A!B' }), false);
  assert.strictEqual(needsLicensedFallback({ ok: true, launch: null }), true);
  assert.strictEqual(needsLicensedFallback(
    { ok: true, launch: 'shell:AppsFolder\\A!B', notes: ['DRM-encrypted Store package'] }), true);
  assert.strictEqual(needsLicensedFallback(
    { ok: true, launch: 'x' }, [{ type: 'eappxbundle' }]), true);
});

test('encrypted/DRM payloads are detected so official install runs first', () => {
  assert.strictEqual(looksEncrypted([{ type: 'msixbundle' }]), false);
  assert.strictEqual(looksEncrypted([{ type: 'eappx' }]), true);
  assert.strictEqual(looksEncrypted([{ type: 'emsixbundle' }]), true);
  assert.strictEqual(looksEncrypted([{ name: 'Game_1.0_x64.eappxbundle' }]), true);
});
