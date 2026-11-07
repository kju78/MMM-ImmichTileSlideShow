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
    setTimeout: options.setTimeout || setTimeout
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

test('fades old tile media out before applying and fading in the replacement', () => {
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
  const slideshow = {
    cfg: { transition: 'fade', transitionMs: 100 },
    _fadeTileToMedia: definition._fadeTileToMedia,
    _fadeTileIn: definition._fadeTileIn,
    _applyTileContent(_tile, image) {
      applied.push(image.src);
    },
    _applyMosaicSpans() {}
  };

  definition._applyTile.call(slideshow, tile, { src: '/new', kind: 'image' }, true);

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

function makeVideo() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    autoplay: true,
    paused: true,
    playCalls: 0,
    sourceAssignments: 0,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
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
