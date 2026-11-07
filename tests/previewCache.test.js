'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const PreviewCache = require('../previewCache');

async function createCache(t, maxBytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmm-immich-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new PreviewCache({ directory, maxBytes, concurrency: 2 });
  await cache.initialize();
  return cache;
}

function imageStream(content) {
  return Readable.from([Buffer.from(content)]);
}

test('stores previews by asset version and rendition and restores them after restart', async (t) => {
  const cache = await createCache(t, 1024);
  const stored = await cache.store('asset-1', 'version-1', 'preview', imageStream('preview bytes'), {
    contentType: 'image/jpeg',
    etag: '"preview-etag"'
  });

  assert.equal(stored.contentType, 'image/jpeg');
  assert.equal(stored.etag, '"preview-etag"');
  assert.equal((await readFile(stored.filePath)).toString(), 'preview bytes');
  assert.equal(await cache.get('asset-1', 'version-2', 'preview'), null);
  assert.equal(await cache.get('asset-1', 'version-1', 'thumbnail'), null);

  const restored = new PreviewCache({ directory: cache.directory, maxBytes: 1024, concurrency: 2 });
  await restored.initialize();
  assert.equal((await restored.get('asset-1', 'version-1', 'preview')).size, 13);
});

test('evicts the oldest unprotected previews while retaining protected assets', async (t) => {
  const cache = await createCache(t, 10);
  await cache.store('asset-old', '1', 'preview', imageStream('123456'), {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cache.store('asset-active', '1', 'preview', imageStream('1234'), {});
  cache.setProtectedAssets([{ assetId: 'asset-active', assetVersion: '1', cacheVariant: 'preview' }]);

  await cache.store('asset-new', '1', 'preview', imageStream('abcdef'), {});

  assert.equal(await cache.get('asset-old', '1', 'preview'), null);
  assert.ok(await cache.get('asset-active', '1', 'preview'));
  assert.ok(await cache.get('asset-new', '1', 'preview'));
});

test('does not evict protected entries when the requested preview exceeds available space', async (t) => {
  const cache = await createCache(t, 5);
  await cache.store('asset-active', '1', 'preview', imageStream('12345'), {});
  cache.setProtectedAssets([{ assetId: 'asset-active', assetVersion: '1', cacheVariant: 'preview' }]);

  const result = await cache.store('asset-too-large', '1', 'preview', imageStream('x'), {});

  assert.equal(result, null);
  assert.ok(await cache.get('asset-active', '1', 'preview'));
  assert.equal(cache.totalBytes, 5);
});

test('skips a preview whose declared size exceeds the entire cache limit', async (t) => {
  const cache = await createCache(t, 5);

  const result = await cache.store('asset-too-large', '1', 'preview', imageStream('123456'), {
    contentLength: '6'
  });

  assert.equal(result, null);
  assert.equal(cache.totalBytes, 0);
});
