'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { Readable } = require('node:stream');
const test = require('node:test');
const axios = require('axios');

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

test('preloads video files and poster previews alongside image previews', async (t) => {
  const originalCache = immichApi.previewCache;
  const originalVideoCache = immichApi.videoCache;
  const originalPrefetch = immichApi._prefetchPreview;
  const originalVideoPrefetch = immichApi._prefetchVideo;
  const protectedTiles = [];
  const protectedVideos = [];
  const requestedAssets = [];
  const requestedVideos = [];
  immichApi.previewCache = {
    concurrency: 2,
    addProtectedAssets(tiles) {
      protectedTiles.push(...tiles);
    }
  };
  immichApi.videoCache = {
    addProtectedAssets(tiles) {
      protectedVideos.push(...tiles);
    }
  };
  immichApi._prefetchPreview = async (assetId, version, variant) => {
    requestedAssets.push({ assetId, version, variant });
    return { filePath: 'cached-preview.img' };
  };
  immichApi._prefetchVideo = async (assetId, version) => {
    requestedVideos.push({ assetId, version });
    return { filePath: 'cached-video.bin' };
  };
  t.after(() => {
    immichApi.previewCache = originalCache;
    immichApi.videoCache = originalVideoCache;
    immichApi._prefetchPreview = originalPrefetch;
    immichApi._prefetchVideo = originalVideoPrefetch;
  });

  const result = await immichApi.prefetchTiles([
    { kind: 'image', assetId: 'image-1', assetVersion: '1', cacheVariant: 'preview' },
    { kind: 'video', assetId: 'video-1', assetVersion: '2', cacheVariant: 'preview', posterSrc: '/poster' },
    { kind: 'video', assetId: 'video-2', assetVersion: '3', cacheVariant: 'preview' }
  ]);

  assert.deepEqual(result, {
    requested: 2,
    cached: 2,
    failed: 0,
    videosRequested: 2,
    videosCached: 2,
    videosFailed: 0
  });
  assert.deepEqual(requestedAssets.map((item) => item.assetId).sort(), ['image-1', 'video-1']);
  assert.deepEqual(protectedTiles.map((item) => item.assetId).sort(), ['image-1', 'video-1']);
  assert.deepEqual(requestedVideos.map((item) => item.assetId).sort(), ['video-1', 'video-2']);
  assert.deepEqual(protectedVideos.map((item) => item.cacheVariant), ['video', 'video']);
});

test('reports videos that could not be cached', async (t) => {
  const originalPreviewCache = immichApi.previewCache;
  const originalVideoCache = immichApi.videoCache;
  const originalVideoPrefetch = immichApi._prefetchVideo;
  immichApi.previewCache = null;
  immichApi.videoCache = {
    concurrency: 1,
    addProtectedAssets() {}
  };
  immichApi._prefetchVideo = async () => null;
  t.after(() => {
    immichApi.previewCache = originalPreviewCache;
    immichApi.videoCache = originalVideoCache;
    immichApi._prefetchVideo = originalVideoPrefetch;
  });

  const result = await immichApi.prefetchTiles([
    { kind: 'video', assetId: 'video-uncached', assetVersion: '1' }
  ]);

  assert.deepEqual(result, {
    requested: 0,
    cached: 0,
    failed: 0,
    videosRequested: 1,
    videosCached: 0,
    videosFailed: 1
  });
});

test('skips partial video responses and caches a complete fallback stream', async (t) => {
  const originalCache = immichApi.videoCache;
  const originalHttp = immichApi.http;
  const originalApiLevel = immichApi.apiLevel;
  const originalRequests = immichApi._videoRequests;
  const requests = [];
  let stored = null;
  immichApi.apiLevel = 'v1_133';
  immichApi._videoRequests = new Map();
  immichApi.videoCache = {
    key: () => 'video-cache-key',
    get: async () => null,
    runLimited: async (operation) => operation(),
    store: async (assetId, version, variant, stream, metadata) => {
      let body = '';
      for await (const chunk of stream) body += chunk.toString();
      stored = { assetId, version, variant, body, metadata };
      return { filePath: 'cached-video.bin' };
    }
  };
  immichApi.http = {
    get: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/video')) {
        return {
          status: 206,
          headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/5' },
          data: Readable.from([Buffer.from('v')])
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '5', etag: '"video-etag"' },
        data: Readable.from([Buffer.from('video')])
      };
    }
  };
  t.after(() => {
    immichApi.videoCache = originalCache;
    immichApi.http = originalHttp;
    immichApi.apiLevel = originalApiLevel;
    immichApi._videoRequests = originalRequests;
  });

  const result = await immichApi._prefetchVideo('video-1', 'version-1');

  assert.equal(result.filePath, 'cached-video.bin');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.responseType, 'stream');
  assert.equal(requests[0].options.headers.Accept, 'video/*, application/octet-stream;q=0.8');
  assert.ok(requests[1].url.endsWith('/assets/video-1/original'));
  assert.deepEqual(stored, {
    assetId: 'video-1',
    version: 'version-1',
    variant: 'video',
    body: 'video',
    metadata: {
      contentType: 'video/mp4',
      etag: '"video-etag"',
      contentLength: '5'
    }
  });
});

test('serves cached videos through a range-capable file response', async (t) => {
  const originalCreate = axios.create;
  const originalHttp = immichApi.http;
  const originalPreviewCache = immichApi.previewCache;
  const originalVideoCache = immichApi.videoCache;
  const originalApiLevel = immichApi.apiLevel;
  const originalImageProxySetup = immichApi._imageProxySetup;
  const originalVideoProxySetup = immichApi._videoProxySetup;
  const routes = new Map();
  const mediaRequests = [];
  let lookup;
  let sendFileCall;
  axios.create = () => ({
    get: async (url) => {
      if (url === '/server/version') return { status: 200, data: { major: 1, minor: 133 } };
      mediaRequests.push(url);
      throw new Error('Unexpected upstream media request.');
    }
  });
  immichApi.apiLevel = 'v1_133';
  immichApi._imageProxySetup = false;
  immichApi._videoProxySetup = false;
  t.after(() => {
    axios.create = originalCreate;
    immichApi.http = originalHttp;
    immichApi.previewCache = originalPreviewCache;
    immichApi.videoCache = originalVideoCache;
    immichApi.apiLevel = originalApiLevel;
    immichApi._imageProxySetup = originalImageProxySetup;
    immichApi._videoProxySetup = originalVideoProxySetup;
  });

  await immichApi.init({
    url: 'http://immich.test',
    apiKey: 'test-key',
    cache: { enabled: false },
    videos: { enabled: true }
  }, {
    get: (route, handler) => routes.set(route, handler)
  }, true);
  immichApi.videoCache = {
    get: async (...args) => {
      lookup = args;
      return {
        filePath: 'C:\\cache\\video.bin',
        contentType: 'video/mp4'
      };
    }
  };

  const request = {
    params: { id: 'video-1' },
    query: { v: 'version-1' },
    headers: { range: 'bytes=0-2' },
    aborted: false
  };
  const response = {
    headersSent: false,
    destroyed: false,
    sendFile(filePath, options, callback) {
      sendFileCall = { filePath, options, request: this.req };
      callback();
    },
    end() {}
  };
  response.req = request;

  await routes.get('/immichtilesslideshow-video/:id')(request, response);

  assert.deepEqual(lookup, ['video-1', 'version-1', 'video']);
  assert.equal(sendFileCall.filePath, 'C:\\cache\\video.bin');
  assert.equal(sendFileCall.options.acceptRanges, true);
  assert.equal(sendFileCall.options.headers['Content-Type'], 'video/mp4');
  assert.equal(sendFileCall.request, request);
  assert.deepEqual(mediaRequests, []);
});
