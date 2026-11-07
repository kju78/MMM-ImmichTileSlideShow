'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let immichApi;
Module._load = function (request, parent, isMain) {
  if (request === 'logger') {
    return { debug() {}, error() {}, info() {}, warn() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
try {
  immichApi = require('../immichApi');
} finally {
  Module._load = originalLoad;
}

test('preloads video poster previews with image previews', async (t) => {
  const originalCache = immichApi.previewCache;
  const originalPrefetch = immichApi._prefetchPreview;
  const protectedTiles = [];
  const requestedAssets = [];
  immichApi.previewCache = {
    concurrency: 2,
    addProtectedAssets(tiles) {
      protectedTiles.push(...tiles);
    }
  };
  immichApi._prefetchPreview = async (assetId, version, variant) => {
    requestedAssets.push({ assetId, version, variant });
    return { filePath: 'cached-preview.img' };
  };
  t.after(() => {
    immichApi.previewCache = originalCache;
    immichApi._prefetchPreview = originalPrefetch;
  });

  const result = await immichApi.prefetchTiles([
    { kind: 'image', assetId: 'image-1', assetVersion: '1', cacheVariant: 'preview' },
    { kind: 'video', assetId: 'video-1', assetVersion: '2', cacheVariant: 'preview', posterSrc: '/poster' },
    { kind: 'video', assetId: 'video-2', assetVersion: '3', cacheVariant: 'preview' }
  ]);

  assert.deepEqual(result, { requested: 2, cached: 2, failed: 0 });
  assert.deepEqual(requestedAssets.map((item) => item.assetId).sort(), ['image-1', 'video-1']);
  assert.deepEqual(protectedTiles.map((item) => item.assetId).sort(), ['image-1', 'video-1']);
});
