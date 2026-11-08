'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { Readable } = require('node:stream');
const test = require('node:test');
const axios = require('axios');

const originalLoad = Module._load;
let immichApi;
const loggerWarnings = [];
const logger = {
  debug() {},
  error() {},
  info() {},
  warn(...args) {
    loggerWarnings.push(args);
  }
};
Module._load = function (request, parent, isMain) {
  if (request === 'logger') {
    return logger;
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

test('does not fall back to the original when playback prefetch fails', async (t) => {
  const originalCache = immichApi.videoCache;
  const originalHttp = immichApi.http;
  const originalApiLevel = immichApi.apiLevel;
  const originalRequests = immichApi._videoRequests;
  const originalFallback = immichApi.videoFallbackToOriginal;
  const originalCacheVariant = immichApi.videoCacheVariant;
  const requestedUrls = [];
  let lookup;
  let keyVariant;
  immichApi.apiLevel = 'v1_133';
  immichApi._videoRequests = new Map();
  immichApi.videoFallbackToOriginal = false;
  immichApi.videoCacheVariant = 'playback-only';
  immichApi.videoCache = {
    key(_assetId, _version, variant) {
      keyVariant = variant;
      return 'video-cache-key';
    },
    get: async (...args) => {
      lookup = args;
      return null;
    },
    runLimited: async (operation) => operation(),
    store: async () => {
      throw new Error('A partial playback response must not be cached.');
    }
  };
  immichApi.http = {
    get: async (url) => {
      requestedUrls.push(url);
      return {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/5' },
        data: Readable.from([Buffer.from('v')])
      };
    }
  };
  loggerWarnings.length = 0;
  t.after(() => {
    immichApi.videoCache = originalCache;
    immichApi.http = originalHttp;
    immichApi.apiLevel = originalApiLevel;
    immichApi._videoRequests = originalRequests;
    immichApi.videoFallbackToOriginal = originalFallback;
    immichApi.videoCacheVariant = originalCacheVariant;
  });

  const result = await immichApi._prefetchVideo('video-1', 'version-1');

  assert.equal(result, null);
  assert.deepEqual(requestedUrls, ['/assets/video-1/video']);
  assert.deepEqual(lookup, ['video-1', 'version-1', 'playback-only']);
  assert.equal(keyVariant, 'playback-only');
  assert.ok(loggerWarnings.some(([message]) => message.includes('original-file fallback is disabled')));
});

test('stores playback-only videos in a separate cache variant when original fallback is disabled', async (t) => {
  const originalCache = immichApi.videoCache;
  const originalHttp = immichApi.http;
  const originalApiLevel = immichApi.apiLevel;
  const originalRequests = immichApi._videoRequests;
  const originalFallback = immichApi.videoFallbackToOriginal;
  const originalCacheVariant = immichApi.videoCacheVariant;
  const cacheLookups = [];
  let storedVariant;
  immichApi.apiLevel = 'v1_133';
  immichApi._videoRequests = new Map();
  immichApi.videoFallbackToOriginal = false;
  immichApi.videoCacheVariant = 'playback-only';
  immichApi.videoCache = {
    key: () => 'video-cache-key',
    get: async (...args) => {
      cacheLookups.push(args);
      return null;
    },
    runLimited: async (operation) => operation(),
    store: async (_assetId, _version, variant, stream) => {
      storedVariant = variant;
      stream.destroy();
      return { variant };
    }
  };
  immichApi.http = {
    get: async () => ({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '5' },
      data: Readable.from([Buffer.from('video')])
    })
  };
  t.after(() => {
    immichApi.videoCache = originalCache;
    immichApi.http = originalHttp;
    immichApi.apiLevel = originalApiLevel;
    immichApi._videoRequests = originalRequests;
    immichApi.videoFallbackToOriginal = originalFallback;
    immichApi.videoCacheVariant = originalCacheVariant;
  });

  const result = await immichApi._prefetchVideo('video-1', 'version-1');

  assert.deepEqual(cacheLookups, [
    ['video-1', 'version-1', 'playback-only'],
    ['video-1', 'version-1', 'playback-only']
  ]);
  assert.equal(storedVariant, 'playback-only');
  assert.deepEqual(result, { variant: 'playback-only' });
});

test('serves cached videos through a range-capable file response', async (t) => {
  const originalCreate = axios.create;
  const originalHttp = immichApi.http;
  const originalPreviewCache = immichApi.previewCache;
  const originalVideoCache = immichApi.videoCache;
  const originalApiLevel = immichApi.apiLevel;
  const originalImageProxySetup = immichApi._imageProxySetup;
  const originalVideoProxySetup = immichApi._videoProxySetup;
  const originalHlsProxySetup = immichApi._hlsProxySetup;
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
  immichApi._hlsProxySetup = false;
  t.after(() => {
    axios.create = originalCreate;
    immichApi.http = originalHttp;
    immichApi.previewCache = originalPreviewCache;
    immichApi.videoCache = originalVideoCache;
    immichApi.apiLevel = originalApiLevel;
    immichApi._imageProxySetup = originalImageProxySetup;
    immichApi._videoProxySetup = originalVideoProxySetup;
    immichApi._hlsProxySetup = originalHlsProxySetup;
  });

  await immichApi.init({
    url: 'http://immich.test',
    apiKey: 'test-key',
    cache: { enabled: false },
    videos: { enabled: true }
  }, {
    get: (route, handler) => routes.set(route, handler),
    delete: (route, handler) => routes.set(route, handler)
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

test('logs playback endpoint failures without requesting the original when disabled', async (t) => {
  const originalCreate = axios.create;
  const originalHttp = immichApi.http;
  const originalPreviewCache = immichApi.previewCache;
  const originalVideoCache = immichApi.videoCache;
  const originalApiLevel = immichApi.apiLevel;
  const originalVideoFallback = immichApi.videoFallbackToOriginal;
  const originalVideoCacheVariant = immichApi.videoCacheVariant;
  const originalImageProxySetup = immichApi._imageProxySetup;
  const originalVideoProxySetup = immichApi._videoProxySetup;
  const originalHlsProxySetup = immichApi._hlsProxySetup;
  const routes = new Map();
  const mediaRequests = [];
  axios.create = () => ({
    get: async (url) => {
      if (url === '/server/version') return { status: 200, data: { major: 1, minor: 133 } };
      mediaRequests.push(url);
      return {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
        data: Readable.from([Buffer.from('not found')])
      };
    }
  });
  immichApi._imageProxySetup = false;
  immichApi._videoProxySetup = false;
  immichApi._hlsProxySetup = false;
  loggerWarnings.length = 0;
  t.after(() => {
    axios.create = originalCreate;
    immichApi.http = originalHttp;
    immichApi.previewCache = originalPreviewCache;
    immichApi.videoCache = originalVideoCache;
    immichApi.apiLevel = originalApiLevel;
    immichApi.videoFallbackToOriginal = originalVideoFallback;
    immichApi.videoCacheVariant = originalVideoCacheVariant;
    immichApi._imageProxySetup = originalImageProxySetup;
    immichApi._videoProxySetup = originalVideoProxySetup;
    immichApi._hlsProxySetup = originalHlsProxySetup;
  });

  await immichApi.init({
    url: 'http://immich.test',
    apiKey: 'test-key',
    cache: { enabled: false },
    videos: { enabled: true, fallbackToOriginal: false }
  }, {
    get: (route, handler) => routes.set(route, handler),
    delete: (route, handler) => routes.set(route, handler)
  }, true);

  const request = {
    params: { id: 'video-1' },
    query: { v: 'version-1' },
    headers: {},
    aborted: false
  };
  const response = {
    headersSent: false,
    destroyed: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
    }
  };

  await routes.get('/immichtilesslideshow-video/:id')(request, response);

  assert.deepEqual(mediaRequests, ['/assets/video-1/video']);
  assert.equal(response.statusCode, 404);
  assert.equal(response.ended, true);
  assert.ok(loggerWarnings.some(([message]) => message.includes('original-file fallback is disabled')));
});

test('proxies realtime HLS playlists, segments, and session cleanup without MP4 fallback', async (t) => {
  const originalCreate = axios.create;
  const originalHttp = immichApi.http;
  const originalVideoCache = immichApi.videoCache;
  const originalApiLevel = immichApi.apiLevel;
  const originalPlaybackMode = immichApi.videoPlaybackMode;
  const originalImageProxySetup = immichApi._imageProxySetup;
  const originalVideoProxySetup = immichApi._videoProxySetup;
  const originalHlsProxySetup = immichApi._hlsProxySetup;
  const routes = new Map();
  const requests = [];
  const assetId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionId = '123e4567-e89b-42d3-a456-426614174001';
  let segmentPiped = false;

  axios.create = () => ({
    get: async (url, options = {}) => {
      if (url === '/server/version') return { status: 200, data: { major: 3, minor: 3, patch: 6 } };
      requests.push({ method: 'GET', url, options });
      if (url.endsWith('/main.m3u8')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          data: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000\n${sessionId}/0/playlist.m3u8\n`
        };
      }
      if (url.endsWith('/playlist.m3u8')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          data: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg_0.m4s\n'
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '7' },
        data: {
          on() {},
          pipe() {
            segmentPiped = true;
          }
        }
      };
    },
    delete: async (url) => {
      requests.push({ method: 'DELETE', url });
      return { status: 204 };
    }
  });
  immichApi._imageProxySetup = false;
  immichApi._videoProxySetup = false;
  immichApi._hlsProxySetup = false;
  t.after(() => {
    axios.create = originalCreate;
    immichApi.http = originalHttp;
    immichApi.videoCache = originalVideoCache;
    immichApi.apiLevel = originalApiLevel;
    immichApi.videoPlaybackMode = originalPlaybackMode;
    immichApi._imageProxySetup = originalImageProxySetup;
    immichApi._videoProxySetup = originalVideoProxySetup;
    immichApi._hlsProxySetup = originalHlsProxySetup;
  });

  await immichApi.init({
    url: 'http://immich.test',
    apiKey: 'test-key',
    cache: { enabled: false, videoMaxBytes: 1024 },
    videos: { enabled: true, playbackMode: 'hls', fallbackToOriginal: false }
  }, {
    get: (route, handler) => routes.set(route, handler),
    delete: (route, handler) => routes.set(route, handler)
  }, true);

  assert.equal(immichApi.videoCache, null);
  assert.equal(
    immichApi.getVideoLink(assetId, 'version-1'),
    `/immichtilesslideshow-hls/${assetId}/main.m3u8?v=version-1`
  );

  const mainResponse = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body; this.ended = true; }
  };
  await routes.get('/immichtilesslideshow-hls/:id/main.m3u8')({
    params: { id: assetId },
    headers: {}
  }, mainResponse);

  assert.equal(mainResponse.statusCode, 200);
  assert.equal(mainResponse.headers['Cache-Control'], 'no-store');
  assert.equal(mainResponse.headers['Content-Type'], 'application/vnd.apple.mpegurl');
  assert.match(mainResponse.body, new RegExp(`${sessionId}/0/playlist\\.m3u8`));

  const playlistResponse = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body; this.ended = true; }
  };
  await routes.get('/immichtilesslideshow-hls/:id/:sessionId/:variantIndex/playlist.m3u8')({
    params: { id: assetId, sessionId, variantIndex: '0' },
    headers: { 'x-immich-hls-position': '6.5' }
  }, playlistResponse);
  assert.equal(playlistResponse.statusCode, 200);
  assert.equal(
    requests.find((request) => request.url.endsWith('/playlist.m3u8')).options.headers['x-immich-hls-position'],
    '6.5'
  );

  const segmentResponse = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; },
    destroyed: false
  };
  await routes.get('/immichtilesslideshow-hls/:id/:sessionId/:variantIndex/:filename')({
    params: { id: assetId, sessionId, variantIndex: '0', filename: 'seg_0.m4s' },
    headers: { range: 'bytes=0-6', 'x-immich-hls-init-segment': '0' },
    aborted: false
  }, segmentResponse);
  assert.equal(segmentResponse.statusCode, 200);
  assert.equal(segmentPiped, true);
  assert.equal(segmentResponse.headers['content-length'], '7');
  const segmentRequest = requests.find((request) => request.url.endsWith('/seg_0.m4s'));
  assert.equal(segmentRequest.options.headers.Range, 'bytes=0-6');

  const cleanupResponse = {
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; }
  };
  await routes.get('/immichtilesslideshow-hls/:id/:sessionId')({
    params: { id: assetId, sessionId }
  }, cleanupResponse);
  assert.equal(cleanupResponse.statusCode, 204);
  assert.ok(requests.some((request) =>
    request.method === 'DELETE' && request.url === `/assets/${assetId}/video/stream/${sessionId}`
  ));
});
