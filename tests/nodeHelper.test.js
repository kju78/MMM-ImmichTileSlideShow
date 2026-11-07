'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let nodeHelper;
let immichApi;
Module._load = function (request, parent, isMain) {
  if (request === 'node_helper') return { create: (definition) => definition };
  if (request === 'logger') return { debug() {}, error() {}, info() {}, warn() {} };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  nodeHelper = require('../node_helper');
  immichApi = require('../immichApi');
} finally {
  Module._load = originalLoad;
}

test('chooses a random starting album index within the candidate list', (t) => {
  const originalRandom = Math.random;
  t.after(() => {
    Math.random = originalRandom;
  });

  Math.random = () => 0;
  assert.equal(nodeHelper._randomAlbumIndex(4), 0);

  Math.random = () => 0.74;
  assert.equal(nodeHelper._randomAlbumIndex(4), 2);

  Math.random = () => 0.999;
  assert.equal(nodeHelper._randomAlbumIndex(4), 3);
  assert.equal(nodeHelper._randomAlbumIndex(1), 0);
  assert.equal(nodeHelper._randomAlbumIndex(0), 0);
});

test('waits for the initial album cache before sending tiles to the frontend', async (t) => {
  const keys = [
    'init',
    'getAlbumNameToIdMap',
    'getAlbumAssetsForAlbumIds',
    'prefetchTiles',
    'getImageLink',
    'getVideoLink',
    'previewCache',
    'videoCache'
  ];
  const originals = Object.fromEntries(keys.map((key) => [key, immichApi[key]]));
  t.after(() => {
    for (const key of keys) immichApi[key] = originals[key];
  });

  let releaseCache;
  let reportPrefetchStarted;
  const cacheGate = new Promise((resolve) => {
    releaseCache = resolve;
  });
  const prefetchStarted = new Promise((resolve) => {
    reportPrefetchStarted = resolve;
  });
  const assets = [{
    id: 'video-1',
    type: 'VIDEO',
    originalFileName: 'clip.mp4',
    updatedAt: 'version-1'
  }];
  immichApi.init = async () => {};
  immichApi.getAlbumNameToIdMap = async () => new Map([['Album', 'album-1']]);
  immichApi.getAlbumAssetsForAlbumIds = async (_albumIds, { onPage }) => {
    onPage(assets);
    return assets;
  };
  immichApi.prefetchTiles = () => {
    reportPrefetchStarted();
    return cacheGate;
  };
  immichApi.getImageLink = () => '/poster';
  immichApi.getVideoLink = () => '/video';
  immichApi.previewCache = { setProtectedAssets() {} };
  immichApi.videoCache = { setProtectedAssets() {} };

  const notifications = [];
  const context = {
    config: {
      immich: [{
        url: 'http://immich',
        apiKey: 'test-key',
        source: 'album',
        albumIds: ['album-1'],
        albumNames: [],
        sort: 'none',
        sortDesc: false
      }],
      activeImmich: 0,
      cache: { enabled: true },
      videos: { enabled: true },
      imageExtensions: [],
      videoExtensions: ['mp4'],
      debug: false
    },
    expressApp: {},
    sendSocketNotification(notification, payload) {
      notifications.push({ notification, payload });
    }
  };

  const loading = nodeHelper._loadFromImmich(context);
  await prefetchStarted;
  assert.equal(notifications.length, 0);

  releaseCache({
    requested: 1,
    cached: 1,
    failed: 0,
    videosRequested: 1,
    videosCached: 1,
    videosFailed: 0
  });
  const tiles = await loading;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].notification, 'IMMICH_TILES_DATA');
  assert.equal(notifications[0].payload.images[0].kind, 'video');
  assert.equal(tiles.length, 1);
});

test('shows initial album photos while deferring videos until their cache is ready', async (t) => {
  const keys = [
    'init',
    'getAlbumNameToIdMap',
    'getAlbumAssetsForAlbumIds',
    'prefetchTiles',
    'getImageLink',
    'getVideoLink',
    'previewCache',
    'videoCache'
  ];
  const originals = Object.fromEntries(keys.map((key) => [key, immichApi[key]]));
  t.after(() => {
    for (const key of keys) immichApi[key] = originals[key];
  });

  let releaseVideoCache;
  let reportVideoPrefetchStarted;
  let reportVideoSent;
  const videoCacheGate = new Promise((resolve) => {
    releaseVideoCache = resolve;
  });
  const videoPrefetchStarted = new Promise((resolve) => {
    reportVideoPrefetchStarted = resolve;
  });
  const videoSent = new Promise((resolve) => {
    reportVideoSent = resolve;
  });
  const assets = [
    {
      id: 'photo-1',
      type: 'IMAGE',
      originalFileName: 'photo.jpg',
      updatedAt: 'photo-version'
    },
    {
      id: 'video-1',
      type: 'VIDEO',
      originalFileName: 'clip.mp4',
      updatedAt: 'video-version'
    }
  ];
  immichApi.init = async () => {};
  immichApi.getAlbumNameToIdMap = async () => new Map([['Album', 'album-1']]);
  immichApi.getAlbumAssetsForAlbumIds = async (_albumIds, { onPage }) => {
    onPage(assets);
    return assets;
  };
  immichApi.prefetchTiles = (tiles) => {
    if (tiles[0].kind === 'video') {
      reportVideoPrefetchStarted();
      return videoCacheGate;
    }
    return Promise.resolve({
      requested: tiles.length,
      cached: tiles.length,
      failed: 0,
      videosRequested: 0,
      videosCached: 0,
      videosFailed: 0
    });
  };
  immichApi.getImageLink = () => '/preview';
  immichApi.getVideoLink = () => '/video';
  immichApi.previewCache = { setProtectedAssets() {} };
  immichApi.videoCache = { setProtectedAssets() {} };

  const notifications = [];
  const context = {
    config: {
      immich: [{
        url: 'http://immich',
        apiKey: 'test-key',
        source: 'album',
        albumIds: ['album-1'],
        albumNames: [],
        sort: 'none',
        sortDesc: false
      }],
      activeImmich: 0,
      cache: { enabled: true },
      videos: { enabled: true },
      imageExtensions: ['jpg'],
      videoExtensions: ['mp4'],
      debug: false
    },
    expressApp: {},
    sendSocketNotification(notification, payload) {
      notifications.push({ notification, payload });
      if (notification === 'IMMICH_TILES_APPEND') reportVideoSent();
    }
  };

  const loading = nodeHelper._loadFromImmich(context, {
    waitForCache: false,
    deferVideoTilesUntilCached: true
  });
  await videoPrefetchStarted;
  const tiles = await loading;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].notification, 'IMMICH_TILES_DATA');
  assert.deepEqual(notifications[0].payload.images.map((tile) => tile.kind), ['image', 'image']);
  assert.equal(notifications[0].payload.images[1].videoPending, true);
  assert.equal(notifications[0].payload.images[1].src, '/preview');
  assert.deepEqual(tiles.map((tile) => tile.kind), ['image', 'video']);

  releaseVideoCache({
    requested: 1,
    cached: 1,
    failed: 0,
    videosRequested: 1,
    videosCached: 1,
    videosFailed: 0
  });
  await videoSent;

  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].notification, 'IMMICH_TILES_APPEND');
  assert.deepEqual(notifications[1].payload.images.map((tile) => tile.kind), ['video']);
});
