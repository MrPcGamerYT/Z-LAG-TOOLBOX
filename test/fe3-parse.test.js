'use strict';

/**
 * Regression tests for the FE3 SyncUpdates / GetExtendedUpdateInfo2 parsing.
 *
 * The bug these lock down: file names and update identities live in two
 * different subtrees of the SyncUpdates answer and are joined by <ID>. The
 * old regex-splitting parser paired them positionally, so the toolbox asked
 * GetExtendedUpdateInfo2 for the link of an update that has no payload and
 * got an empty <FileLocation> list back on every ring — surfacing as
 * "Microsoft did not return a download link for this package (update …).
 *  Tried rings Retail, RP, WIS, WIF."
 *
 * Run with:  node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const catalog = require('../server/store/catalog');
const { parseXml } = require('../server/store/xmlparse');

const {
  __test: { parseFe3Sync, parseFileUrls, pickPackages, parseFileKey }
} = catalog;

/** Build a SyncUpdates response shaped like the real one. */
function buildSync(entries) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const newUpdates = entries.map((e) => {
    const inner =
      '<UpdateIdentity UpdateID="' + e.updateId + '" RevisionNumber="' + e.revision + '"/>' +
      '<Properties UpdateType="Software">' +
      (e.secured === false ? '' : '<SecuredFragment/>') +
      '</Properties>';
    return '<UpdateInfo><ID>' + e.id + '</ID><Deployment><Action>Install</Action></Deployment>' +
      '<Xml>' + esc(inner) + '</Xml></UpdateInfo>';
  }).join('');

  // Deliberately emitted in a DIFFERENT order than <NewUpdates> so that any
  // positional pairing produces wrong answers.
  const extended = entries.slice().reverse().map((e) => {
    const files = (e.files || []).map((f) =>
      '<File FileName="' + f.name + '" InstallerSpecificIdentifier="' + f.ident +
      '" Modified="' + f.modified + '" Digest="abc" Size="123"/>').join('');
    return '<Update><ID>' + e.id + '</ID><Xml>' + esc('<Files>' + files + '</Files>') + '</Xml></Update>';
  }).join('');

  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    '<s:Body><SyncUpdatesResponse><SyncUpdatesResult>' +
    '<NewUpdates>' + newUpdates + '</NewUpdates>' +
    '<ExtendedUpdateInfo><Updates>' + extended + '</Updates></ExtendedUpdateInfo>' +
    '</SyncUpdatesResult></SyncUpdatesResponse></s:Body></s:Envelope>';
}

const SPOTIFY = [
  {
    id: '3001', updateId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', revision: '1',
    files: [
      { ident: 'SpotifyAB.SpotifyMusic_1.260.1006.0_neutral_~_zpdnekdrzrea0',
        name: 'Spotify.appxbundle', modified: '2026-01-04T11:00:00.000' },
      { ident: 'SpotifyAB.SpotifyMusic_1.260.1006.0_neutral_~_zpdnekdrzrea0',
        name: 'Spotify.BlockMap', modified: '2026-01-04T11:00:00.000' }
    ]
  },
  {
    id: '3002', updateId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', revision: '7',
    files: [{ ident: 'Microsoft.VCLibs.140.00_14.0.33728.0_x64__8wekyb3d8bbwe',
      name: 'VCLibs.appx', modified: '2025-11-02T09:30:00.000' }]
  },
  {
    id: '3003', updateId: 'cccccccc-3333-4333-8333-cccccccccccc', revision: '3',
    files: [{ ident: 'Microsoft.NET.Native.Runtime.2.2_2.2.28604.0_x64__8wekyb3d8bbwe',
      name: 'NetNative.appx', modified: '2025-06-15T08:00:00.000' }]
  }
];

test('parseFe3Sync joins file names to their own UpdateID via <ID>', () => {
  const { nameModified, identities } = parseFe3Sync(buildSync(SPOTIFY));

  const main = 'SpotifyAB.SpotifyMusic_1.260.1006.0_neutral_~_zpdnekdrzrea0_Spotify.appxbundle';
  const vclibs = 'Microsoft.VCLibs.140.00_14.0.33728.0_x64__8wekyb3d8bbwe_VCLibs.appx';
  const netnative = 'Microsoft.NET.Native.Runtime.2.2_2.2.28604.0_x64__8wekyb3d8bbwe_NetNative.appx';

  assert.deepStrictEqual(Object.keys(identities).sort(), [main, netnative, vclibs].sort());

  // The critical assertion: each package maps to ITS OWN update identity,
  // not to whichever one happened to be adjacent in the document.
  assert.deepStrictEqual(identities[main],
    { updateId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', revision: '1' });
  assert.deepStrictEqual(identities[vclibs],
    { updateId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', revision: '7' });
  assert.deepStrictEqual(identities[netnative],
    { updateId: 'cccccccc-3333-4333-8333-cccccccccccc', revision: '3' });

  assert.strictEqual(nameModified[main], '2026-01-04T11:00:00.000');
});

test('parseFe3Sync drops BlockMap side files', () => {
  const { identities } = parseFe3Sync(buildSync(SPOTIFY));
  assert.ok(!Object.keys(identities).some((k) => /blockmap/i.test(k)));
});

test('parseFe3Sync returns nothing for an empty catalog answer', () => {
  const empty = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>' +
    '<SyncUpdatesResponse><SyncUpdatesResult><NewUpdates/>' +
    '<ExtendedUpdateInfo/></SyncUpdatesResult></SyncUpdatesResponse></s:Body></s:Envelope>';
  const { nameModified } = parseFe3Sync(empty);
  assert.strictEqual(Object.keys(nameModified).length, 0);
});

test('pickPackages selects the main package plus one dependency each', () => {
  const { nameModified } = parseFe3Sync(buildSync(SPOTIFY));
  const picked = pickPackages(nameModified, 'SpotifyAB.SpotifyMusic', 'x64', false, false);
  assert.strictEqual(picked.files.length, 3);
  // Main package must be installed last, after its dependencies.
  assert.match(picked.mainFile, /SpotifyMusic/);
  assert.strictEqual(picked.files[picked.files.length - 1], picked.mainFile);
});

test('parseFileUrls prefers the package payload over the BlockMap link', () => {
  const xml =
    '<GetExtendedUpdateInfo2Response><GetExtendedUpdateInfo2Result><FileLocations>' +
    '<FileLocation><FileDigest>x</FileDigest>' +
    '<Url>http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/abc/x.BlockMap?P1=1&amp;P2=2</Url>' +
    '</FileLocation>' +
    '<FileLocation><FileDigest>y</FileDigest>' +
    '<Url>http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/def/Spotify.appxbundle' +
    '?P1=1730000000&amp;P2=404&amp;P3=2&amp;P4=verylongsignaturevaluegoeshere0000000000</Url>' +
    '</FileLocation>' +
    '</FileLocations></GetExtendedUpdateInfo2Result></GetExtendedUpdateInfo2Response>';
  const url = parseFileUrls(xml);
  assert.ok(url.includes('Spotify.appxbundle'), 'picked ' + url);
  assert.ok(!/blockmap/i.test(url));
});

test('parseFileUrls returns null when Microsoft sends no locations', () => {
  const xml = '<GetExtendedUpdateInfo2Response><GetExtendedUpdateInfo2Result>' +
    '<FileLocations/></GetExtendedUpdateInfo2Result></GetExtendedUpdateInfo2Response>';
  assert.strictEqual(parseFileUrls(xml), null);
});

test('parseFileKey reads arch, version and extension out of a package key', () => {
  const p = parseFileKey('Microsoft.VCLibs.140.00_14.0.33728.0_x64__8wekyb3d8bbwe_VCLibs.appx');
  assert.strictEqual(p.arch, 'x64');
  assert.strictEqual(p.version, '14.0.33728.0');
  assert.strictEqual(p.ext, 'appx');
});

test('xml parser survives stray markup inside escaped payloads', () => {
  const doc = parseXml('<a><b attr="1 < 2">text &amp; more</b><c/></a>');
  const b = doc.getElementsByTagName('b')[0];
  assert.strictEqual(b.text, 'text & more');
  assert.strictEqual(doc.getElementsByTagName('c').length, 1);
});

test('parseProductId understands store urls, ids and query strings', () => {
  assert.strictEqual(catalog.parseProductId('9NCBCSZSJRSB'), '9NCBCSZSJRSB');
  assert.strictEqual(
    catalog.parseProductId('https://apps.microsoft.com/detail/9ncbcszsjrsb?hl=en-us'),
    '9NCBCSZSJRSB');
  assert.strictEqual(
    catalog.parseProductId('https://www.microsoft.com/store/productId/9WZDNCRFJBH4'),
    '9WZDNCRFJBH4');
});

const {
  FE3_RINGS, SEARCH_LIMIT, uniqueRings, extractFulfillment, parseFulfillmentBlob
} = catalog.__test;

test('FE3 walks rings in a fixed order: Retail → RP → WIS → WIF first', () => {
  assert.deepStrictEqual(FE3_RINGS.slice(0, 4), ['Retail', 'RP', 'WIS', 'WIF']);
  assert.ok(FE3_RINGS.includes('Beta'));
  assert.ok(FE3_RINGS.includes('Canary'));
  assert.ok(FE3_RINGS.includes('Dev'));
  assert.ok(FE3_RINGS.includes('External'));
  const rings = uniqueRings('WIS');
  assert.strictEqual(rings[0], 'WIS');
  assert.ok(rings.includes('Retail'));
  assert.strictEqual(rings.filter((r) => r === 'WIS').length, 1);
});

test('universal search keeps up to 160 unique product ids', () => {
  assert.strictEqual(SEARCH_LIMIT, 160);
});

test('extractFulfillment reads WuCategoryId from Display Catalog SKUs', () => {
  const blob = JSON.stringify({
    WuCategoryId: 'cat-123',
    PackageFamilyName: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0'
  });
  assert.deepStrictEqual(parseFulfillmentBlob(blob), {
    WuCategoryId: 'cat-123',
    PackageFamilyName: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0'
  });
  const dcat = {
    DisplaySkuAvailabilities: [
      { Sku: { FulfillmentData: blob } }
    ]
  };
  const hit = extractFulfillment(dcat);
  assert.strictEqual(hit.WuCategoryId, 'cat-123');
  assert.strictEqual(hit.PackageFamilyName, 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0');
  assert.strictEqual(extractFulfillment({}), null);
});
