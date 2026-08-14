'use strict';

/**
 * Contract tests for the self-sufficient driver engine.
 *
 * These pin the Microsoft Update Catalog HTML parsing against realistic
 * fixtures: the search results page and the download dialog. If Microsoft's
 * markup shifts, these tests are the early-warning system.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseSearchPage, parseDownloadPage, parseSize,
  deviceQueries, pickBestOffer, stripTags
} = require('../server/drivercatalog');

const SEARCH_FIXTURE = `
<html><body>
<table id="ctl00_catalogBody_updateMatches">
<tr onclick="goToDetails('{7c90123e-aaaa-4bbb-8ccc-111122223333}')">
  <td><input type="checkbox" id="7c90123e_check" /></td>
  <td><a id="link_7c90123e" href="#">Realtek Semiconductor Corp. - Net - 10.68.1001.2024</a></td>
  <td>Windows 10, Windows 11 and later drivers, Servicing Drivers</td>
  <td>Drivers (Networking)</td>
  <td>5/14/2024</td>
  <td>10.68.1001.2024</td>
  <td>28.4 MB</td>
</tr>
<tr onclick="goToDetails('{19aabbcc-2222-4333-8444-555566667777}')">
  <td><input type="checkbox" id="19aabbcc_check" /></td>
  <td><a id="link_19aabbcc" href="#">NVIDIA - Display - 32.0.15.6094</a></td>
  <td>Windows 11</td>
  <td>Drivers (Display)</td>
  <td>8/2/2024</td>
  <td>32.0.15.6094</td>
  <td>752.3 MB</td>
</tr>
<tr onclick="goToDetails('{0f0f0f0f-3333-4444-8555-666677778888}')">
  <td><input type="checkbox" id="0f0f0f0f_check" /></td>
  <td><a id="link_0f0f0f0f" href="#">Some old driver - USB</a></td>
  <td>Windows XP</td>
  <td>Drivers (USB)</td>
  <td>1/1/2013</td>
  <td>1.0.0.1</td>
  <td>781 KB</td>
</tr>
</table>
</body></html>`;

test('search page parser extracts offers with GUIDs, columns and sizes', () => {
  const offers = parseSearchPage(SEARCH_FIXTURE);
  assert.strictEqual(offers.length, 3);
  const realtek = offers.find((o) => o.title.includes('Realtek'));
  assert.ok(realtek, 'Realtek offer parsed');
  assert.strictEqual(realtek.updateId, '7c90123e-aaaa-4bbb-8ccc-111122223333');
  assert.match(realtek.classification, /Drivers/);
  assert.match(realtek.products, /Windows 10/);
  assert.strictEqual(realtek.sizeBytes, Math.round(28.4 * 1048576));
});

test('GUID casing is normalised and duplicates removed', () => {
  const html = SEARCH_FIXTURE + SEARCH_FIXTURE;
  const offers = parseSearchPage(html);
  assert.strictEqual(offers.length, 3);
  assert.ok(offers.every((o) => o.updateId === o.updateId.toLowerCase()));
});

const DIALOG_FIXTURE = `
<script>
downloadInformation[0] = { ... };
downloadInformation[0].files[0] = {};
downloadInformation[0].files[0].url = 'http://download.windowsupdate.com/d/msdownload/driver/cab_7c90123e.cab';
downloadInformation[0].files[1] = {};
downloadInformation[0].files[1].url = 'http://download.windowsupdate.com/d/msdownload/driver/readme.txt';
</script>
`;

test('download dialog parser collects declared file URLs; .cab preferred', () => {
  const files = parseDownloadPage(DIALOG_FIXTURE);
  assert.strictEqual(files.length, 2);
  const chosen = files.find((f) => /\.cab$/i.test(f.fileName)) || files[0];
  assert.match(chosen.url, /cab_7c90123e\.cab$/);
  assert.strictEqual(chosen.fileName, 'cab_7c90123e.cab');
});

test('download dialog parser falls back to any .cab / .exe links in markup', () => {
  const html = '<a href="http://dl.catalog.update.microsoft.com/download/f/x/driver_pkg.cab">x.cab</a>';
  const files = parseDownloadPage(html);
  assert.strictEqual(files.length, 1);
  assert.match(files[0].url, /driver_pkg\.cab$/);
});

test('parseSize understands KB / MB / GB strings', () => {
  assert.strictEqual(parseSize('28.4 MB'), Math.round(28.4 * 1048576));
  assert.strictEqual(parseSize('781 KB'), 781 * 1024);
  assert.strictEqual(parseSize('1.2 GB'), Math.round(1.2 * 1073741824));
  assert.strictEqual(parseSize(''), 0);
});

test('deviceQueries puts the hardware ID first, then name fallbacks', () => {
  const qs = deviceQueries({
    name: 'Realtek PCIe GbE Family Controller',
    vendor: 'Realtek',
    hwids: ['PCI\\VEN_10EC&DEV_8168&SUBSYS_84321043', 'PCI\\VEN_10EC&DEV_8168']
  });
  assert.strictEqual(qs[0], 'PCI\\VEN_10EC&DEV_8168&SUBSYS_84321043');
  assert.ok(qs.includes('PCI\\VEN_10EC&DEV_8168'), 'short hwid included');
  assert.ok(qs.some((q) => q.includes('Realtek PCIe')), 'name query included');
});

test('pickBestOffer prefers the newest Windows 11 driver that matches the device', () => {
  const offers = parseSearchPage(SEARCH_FIXTURE);
  const best = pickBestOffer(offers, {
    name: 'Realtek PCIe GbE Family Controller', vendor: 'Realtek', hwids: []
  });
  assert.strictEqual(best.updateId, '7c90123e-aaaa-4bbb-8ccc-111122223333');
});

test('pickBestOffer chooses the newest release inside one compatible driver family', () => {
  const common = {
    title: 'NVIDIA - Display - driver', products: 'Windows 11', classification: 'Drivers (Display)', sizeBytes: 1
  };
  const older = Object.assign({}, common, {
    updateId: 'old', version: '31.0.15.1000', lastUpdated: '1/1/2024'
  });
  const newer = Object.assign({}, common, {
    updateId: 'new', version: '32.0.15.6094', lastUpdated: '8/2/2025'
  });
  const best = pickBestOffer([older, newer], {
    name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', hwids: []
  });
  assert.strictEqual(best.updateId, 'new');
});

test('stripTags normalises entities and whitespace safely', () => {
  assert.strictEqual(stripTags('<b>Realtek &amp; Co.</b>  ltd'), 'Realtek & Co. ltd');
  assert.strictEqual(stripTags('&lt;tag&gt;'), '<tag>');
});
