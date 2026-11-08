'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const moduleSource = fs.readFileSync(
  path.join(__dirname, '..', 'MMM-ImmichTileSlideShow.js'),
  'utf8'
);

function loadModuleDefinition(options = {}) {
  let definition;
  const context = {
    Module: {
      register(_name, config) {
        definition = config;
      }
    },
    document: options.document || {},
    setTimeout: options.setTimeout || setTimeout,
    ...(options.Image ? { Image: options.Image } : {}),
    ...(options.Hls ? { Hls: options.Hls } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  };
  vm.runInNewContext(moduleSource, context);
  return definition;
}

function makeClassList() {
  const classes = new Set();
  return {
    add(...names) {
      for (const name of names) classes.add(name);
    },
    remove(...names) {
      for (const name of names) classes.delete(name);
    },
    contains(name) {
      return classes.has(name);
    }
  };
}

test('waits for image decoding before fading old tile media out', async () => {
  const timers = [];
  const definition = loadModuleDefinition({
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  const tile = {
    dataset: { mmmitssMediaSrc: '/old' },
    classList: makeClassList(),
    style: { setProperty() {} },
    get offsetWidth() {
      return 0;
    }
  };
  const applied = [];
  let resolveDecode;
  const decodePromise = new Promise((resolve) => {
    resolveDecode = resolve;
  });
  const slideshow = {
    cfg: { transition: 'fade', transitionMs: 100 },
    _preloadTileImage(src) {
      assert.equal(src, '/new');
      return decodePromise;
    },
    _fadeTileToMedia: definition._fadeTileToMedia,
    _fadeTileIn: definition._fadeTileIn,
    _applyTileContent(_tile, image) {
      applied.push(image.src);
    },
    _applyMosaicSpans() {}
  };

  definition._applyTile.call(slideshow, tile, { src: '/new', kind: 'image' }, true);

  assert.equal(tile.classList.contains('swap-out'), false);
  assert.deepEqual(applied, []);

  resolveDecode();
  await Promise.resolve();

  assert.equal(tile.classList.contains('swap-out'), true);
  assert.deepEqual(applied, []);
  assert.equal(timers[0].delay, 50);

  timers.shift().callback();
  assert.deepEqual(applied, ['/new']);
  assert.equal(tile.dataset.mmmitssMediaSrc, '/new');
  assert.equal(tile.classList.contains('swap-in'), true);
  assert.equal(timers[0].delay, 50);

  timers.shift().callback();
  assert.equal(tile.classList.contains('swap-in'), false);
});

test('image preload waits for Image.decode()', async () => {
  const events = [];
  let resolveDecode;
  class FakeImage {
    set src(value) {
      events.push(`src:${value}`);
    }

    decode() {
      events.push('decode');
      return new Promise((resolve) => {
        resolveDecode = resolve;
      });
    }
  }
  const definition = loadModuleDefinition({ Image: FakeImage });
  let resolved = false;
  const preload = definition._preloadTileImage.call({}, '/preview').then(() => {
    resolved = true;
  });

  assert.deepEqual(events, ['src:/preview', 'decode']);
  assert.equal(resolved, false);
  resolveDecode();
  await preload;
  assert.equal(resolved, true);
});

test('keeps the previous tile image and logs when preload fails', async () => {
  const definition = loadModuleDefinition();
  const tile = {
    dataset: { mmmitssMediaSrc: '/old' },
    classList: makeClassList(),
    style: { setProperty() {} },
    get offsetWidth() {
      return 0;
    }
  };
  const applied = [];
  const messages = [];
  const slideshow = {
    cfg: { transition: 'fade', transitionMs: 100 },
    _preloadTileImage: () => Promise.reject(new Error('decode failed')),
    _fadeTileToMedia: definition._fadeTileToMedia,
    _applyTileContent(_tile, image) {
      applied.push(image.src);
    },
    _applyMosaicSpans() {},
    log(...args) {
      messages.push(args);
    }
  };

  definition._applyTile.call(slideshow, tile, { src: '/new', kind: 'image' }, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(applied, []);
  assert.equal(tile.dataset.mmmitssMediaSrc, '/old');
  assert.deepEqual(messages, [['image preload failed:', 'decode failed']]);
});

function makeVideo() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    autoplay: true,
    paused: true,
    currentTime: 6.5,
    style: {},
    playCalls: 0,
    sourceAssignments: 0,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    set src(value) {
      this.sourceAssignments += 1;
      attributes.set('src', value);
    },
    get src() {
      return this.getAttribute('src');
    },
    emit(name, event) {
      for (const callback of listeners.get(name) || []) callback(event);
    },
    pause() {
      if (this.paused) return;
      this.paused = true;
      for (const callback of listeners.get('pause') || []) callback();
    },
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    load() {},
    remove() {}
  };
}

function makeTile() {
  let video = null;
  const image = { style: {} };
  const caption = { style: {}, textContent: '' };
  const media = {
    appendChild(element) {
      video = element;
    }
  };
  return {
    image,
    caption,
    get video() {
      return video;
    },
    querySelector(selector) {
      if (selector === '.immich-tile-img') return image;
      if (selector === 'video.immich-tile-video') return video;
      if (selector === '.immich-tile-caption') return caption;
      if (selector === '.immich-tile-media') return media;
      return null;
    }
  };
}

test('enforces the video concurrency limit and does not reload an unchanged URL', () => {
  const createdVideos = [];
  const definition = loadModuleDefinition({
    document: {
      createElement(tag) {
        assert.equal(tag, 'video');
        const video = makeVideo();
        createdVideos.push(video);
        return video;
      }
    }
  });
  const slideshow = {
    cfg: {
      videos: {
        enabled: true,
        muted: true,
        loop: true,
        autoplay: true,
        preload: 'none',
        maxConcurrent: 1
      },
      captions: { enabled: false }
    },
    _activeVideos: new Set(),
    _hlsPlayers: new Map(),
    _pendingHlsVideos: new Map(),
    _stopping: false,
    _disposeHlsPlayer: definition._disposeHlsPlayer,
    _queueHlsVideo: definition._queueHlsVideo,
    _startNextHlsVideo: definition._startNextHlsVideo,
    _startVideoPlayback: definition._startVideoPlayback,
    _playReservedVideo: definition._playReservedVideo,
    _attachHlsPlayer: definition._attachHlsPlayer,
    log() {}
  };
  const firstTile = makeTile();
  const secondTile = makeTile();

  definition._applyTileContent.call(slideshow, firstTile, {
    kind: 'video',
    src: '/video/one',
    posterSrc: '/poster/one'
  });
  definition._applyTileContent.call(slideshow, secondTile, {
    kind: 'video',
    src: '/video/two',
    posterSrc: '/poster/two'
  });

  assert.equal(createdVideos[0].autoplay, false);
  assert.equal(createdVideos[1].autoplay, false);
  assert.equal(createdVideos[0].playCalls, 1);
  assert.equal(createdVideos[1].playCalls, 0);
  assert.equal(slideshow._activeVideos.size, 1);

  definition._applyTileContent.call(slideshow, firstTile, {
    kind: 'video',
    src: '/video/one',
    posterSrc: '/poster/one'
  });
  assert.equal(createdVideos[0].sourceAssignments, 1);
  assert.equal(createdVideos[0].playCalls, 1);

  definition._applyTileContent.call(slideshow, firstTile, {
    kind: 'video',
    src: '/video/three',
    posterSrc: '/poster/three'
  });
  assert.equal(createdVideos[0].sourceAssignments, 2);
  assert.equal(createdVideos[0].playCalls, 2);
  assert.equal(slideshow._activeVideos.size, 1);
});

test('logs video playback errors and leaves the poster visible', () => {
  const definition = loadModuleDefinition({
    document: {
      createElement(tag) {
        assert.equal(tag, 'video');
        return makeVideo();
      }
    }
  });
  const messages = [];
  const slideshow = {
    cfg: {
      videos: {
        enabled: true,
        muted: true,
        loop: true,
        autoplay: true,
        preload: 'none',
        maxConcurrent: 1
      },
      captions: { enabled: false }
    },
    _activeVideos: new Set(),
    _hlsPlayers: new Map(),
    _pendingHlsVideos: new Map(),
    _stopping: false,
    _disposeHlsPlayer: definition._disposeHlsPlayer,
    _queueHlsVideo: definition._queueHlsVideo,
    _startNextHlsVideo: definition._startNextHlsVideo,
    _startVideoPlayback: definition._startVideoPlayback,
    _playReservedVideo: definition._playReservedVideo,
    _attachHlsPlayer: definition._attachHlsPlayer,
    log(...args) {
      messages.push(args);
    }
  };
  const tile = makeTile();

  definition._applyTileContent.call(slideshow, tile, {
    kind: 'video',
    src: '/video/fail',
    posterSrc: '/poster/fail'
  });
  tile.video.error = { code: 4, message: 'unsupported codec' };
  tile.video.currentSrc = '/video/fail';
  tile.video.emit('error');

  assert.equal(tile.video.style.display, 'none');
  assert.equal(tile.image.style.backgroundImage, "url('/poster/fail')");
  assert.equal(slideshow._activeVideos.has(tile.video), false);
  assert.deepEqual(messages, [[
    'video playback failed:',
    '/video/fail',
    'MediaError 4: unsupported codec'
  ]]);
});

test('upgrades a pending video poster into the video pool without duplicating it', () => {
  const definition = loadModuleDefinition();
  const photo = { kind: 'image', assetId: 'photo-1', src: '/photo' };
  const poster = {
    kind: 'image',
    assetId: 'video-1',
    src: '/poster',
    videoPending: true
  };
  const video = { kind: 'video', assetId: 'video-1', src: '/video' };
  const slideshow = {
    images: [photo, poster],
    _imagePool: [photo, poster],
    _videoPool: [],
    _nextImageIndex: 1,
    log() {},
    _setAlbumLabel() {},
    _setDebugText() {}
  };

  definition.socketNotificationReceived.call(slideshow, 'IMMICH_TILES_APPEND', {
    images: [video]
  });

  assert.deepEqual(slideshow.images, [photo, video]);
  assert.deepEqual(slideshow._imagePool, [photo]);
  assert.deepEqual(slideshow._videoPool, [video]);
  assert.equal(slideshow._nextImageIndex, 0);
});

test('loads hls.js and manages realtime HLS playback sessions', () => {
  const players = [];
  const fetchCalls = [];
  class FakeHls {
    static Events = {
      LEVEL_LOADING: 'levelLoading',
      FRAG_LOADING: 'fragLoading',
      MANIFEST_PARSED: 'manifestParsed',
      ERROR: 'error'
    };

    static isSupported() {
      return true;
    }

    constructor(config) {
      this.config = config;
      this.listeners = new Map();
      this.destroyed = false;
      players.push(this);
    }

    on(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }

    emit(name, data) {
      for (const callback of this.listeners.get(name) || []) callback(name, data);
    }

    loadSource(source) {
      this.source = source;
    }

    attachMedia(video) {
      this.video = video;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const definition = loadModuleDefinition({
    document: {
      createElement(tag) {
        assert.equal(tag, 'video');
        return makeVideo();
      }
    },
    Hls: FakeHls,
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return Promise.resolve({ ok: true });
    }
  });
  const slideshow = {
    cfg: {
      videos: {
        enabled: true,
        muted: true,
        loop: true,
        autoplay: true,
        preload: 'none',
        maxConcurrent: 1,
        playbackMode: 'hls'
      },
      captions: { enabled: false }
    },
    _activeVideos: new Set(),
    _hlsPlayers: new Map(),
    _pendingHlsVideos: new Map(),
    _stopping: false,
    _disposeHlsPlayer: definition._disposeHlsPlayer,
    _queueHlsVideo: definition._queueHlsVideo,
    _startNextHlsVideo: definition._startNextHlsVideo,
    _startVideoPlayback: definition._startVideoPlayback,
    _playReservedVideo: definition._playReservedVideo,
    _attachHlsPlayer: definition._attachHlsPlayer,
    log() {}
  };
  const tile = makeTile();
  const assetId = '123e4567-e89b-42d3-a456-426614174000';
  const sessionId = '123e4567-e89b-42d3-a456-426614174001';
  const firstSource = `/immichtilesslideshow-hls/${assetId}/main.m3u8?v=1`;
  const secondAssetId = '123e4567-e89b-42d3-a456-426614174002';

  assert.equal(
    definition.getScripts.call({ file: (file) => file }).join('\n'),
    'configSchema.js\nnode_modules/hls.js/dist/hls.min.js'
  );
  definition._applyTileContent.call(slideshow, tile, {
    kind: 'video',
    assetId,
    src: firstSource,
    posterSrc: '/poster/one'
  });

  assert.equal(players.length, 1);
  assert.equal(players[0].source, firstSource);
  assert.equal(players[0].video, tile.video);
  assert.equal(tile.video.getAttribute('src'), null);
  assert.equal(tile.video.playCalls, 0);

  players[0].emit(FakeHls.Events.LEVEL_LOADING, {
    url: `/immichtilesslideshow-hls/${assetId}/${sessionId}/0/playlist.m3u8`
  });
  players[0].emit(FakeHls.Events.FRAG_LOADING, { frag: { sn: 3 } });
  const headers = {};
  players[0].config.xhrSetup(
    { setRequestHeader: (name, value) => { headers[name] = value; } },
    `/immichtilesslideshow-hls/${assetId}/${sessionId}/0/playlist.m3u8`
  );
  assert.equal(headers['x-immich-hls-position'], '6.5');
  players[0].config.xhrSetup(
    { setRequestHeader: (name, value) => { headers[name] = value; } },
    `/immichtilesslideshow-hls/${assetId}/${sessionId}/0/init.mp4`
  );
  assert.equal(headers['x-immich-hls-init-segment'], '3');

  players[0].emit(FakeHls.Events.MANIFEST_PARSED, {});
  assert.equal(tile.video.playCalls, 1);
  definition._applyTileContent.call(slideshow, tile, {
    kind: 'video',
    assetId,
    src: firstSource,
    posterSrc: '/poster/one'
  });
  assert.equal(players.length, 1);
  assert.equal(tile.video.playCalls, 1);

  definition._applyTileContent.call(slideshow, tile, {
    kind: 'video',
    assetId: secondAssetId,
    src: `/immichtilesslideshow-hls/${secondAssetId}/main.m3u8?v=2`,
    posterSrc: '/poster/two'
  });
  assert.equal(players[0].destroyed, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, `/immichtilesslideshow-hls/${assetId}/${sessionId}`);
  assert.equal(fetchCalls[0].options.method, 'DELETE');
  assert.equal(fetchCalls[0].options.keepalive, true);
  assert.equal(players.length, 2);
});

test('limits active realtime HLS sessions to maxConcurrent', () => {
  const players = [];
  const fetchCalls = [];
  class FakeHls {
    static Events = {
      LEVEL_LOADING: 'levelLoading',
      FRAG_LOADING: 'fragLoading',
      MANIFEST_PARSED: 'manifestParsed',
      ERROR: 'error'
    };

    static isSupported() {
      return true;
    }

    constructor() {
      this.listeners = new Map();
      this.destroyed = false;
      players.push(this);
    }

    on(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }

    emit(name, data) {
      for (const callback of this.listeners.get(name) || []) callback(name, data);
    }

    loadSource(source) {
      this.source = source;
    }

    attachMedia(video) {
      this.video = video;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const definition = loadModuleDefinition({
    document: {
      createElement(tag) {
        assert.equal(tag, 'video');
        return makeVideo();
      }
    },
    Hls: FakeHls,
    fetch(url) {
      fetchCalls.push(url);
      return Promise.resolve({ ok: true });
    }
  });
  const slideshow = Object.assign(Object.create(definition), {
    cfg: {
      videos: {
        enabled: true,
        muted: true,
        loop: false,
        autoplay: true,
        preload: 'none',
        maxConcurrent: 1,
        playbackMode: 'hls'
      },
      captions: { enabled: false }
    },
    _activeVideos: new Set(),
    _hlsPlayers: new Map(),
    _pendingHlsVideos: new Map(),
    _stopping: false
  });
  const firstTile = makeTile();
  const secondTile = makeTile();
  const firstAssetId = '123e4567-e89b-42d3-a456-426614174000';
  const secondAssetId = '123e4567-e89b-42d3-a456-426614174002';
  const sessionId = '123e4567-e89b-42d3-a456-426614174001';

  definition._applyTileContent.call(slideshow, firstTile, {
    kind: 'video',
    assetId: firstAssetId,
    src: `/immichtilesslideshow-hls/${firstAssetId}/main.m3u8`,
    posterSrc: '/poster/one'
  });
  definition._applyTileContent.call(slideshow, secondTile, {
    kind: 'video',
    assetId: secondAssetId,
    src: `/immichtilesslideshow-hls/${secondAssetId}/main.m3u8`,
    posterSrc: '/poster/two'
  });

  assert.equal(players.length, 1);
  assert.equal(slideshow._activeVideos.size, 1);
  assert.equal(slideshow._pendingHlsVideos.size, 1);

  players[0].emit(FakeHls.Events.LEVEL_LOADING, {
    url: `/immichtilesslideshow-hls/${firstAssetId}/${sessionId}/0/playlist.m3u8`
  });
  players[0].emit(FakeHls.Events.MANIFEST_PARSED, {});
  assert.equal(firstTile.video.playCalls, 1);
  firstTile.video.pause();

  assert.equal(players[0].destroyed, true);
  assert.equal(players.length, 2);
  assert.equal(players[1].source, `/immichtilesslideshow-hls/${secondAssetId}/main.m3u8`);
  assert.equal(slideshow._activeVideos.size, 1);
  assert.equal(slideshow._pendingHlsVideos.size, 0);
  assert.deepEqual(fetchCalls, [`/immichtilesslideshow-hls/${firstAssetId}/${sessionId}`]);
});
