// modules/MMM-ImmichTileSlideShow/node_helper.js
/*
 * MagicMirror² Node Helper: MMM-ImmichTileSlideShow
 * Provides image lists to the frontend. Defaults to placeholder images
 * so the module renders without any external configuration.
 *
 * Immich integration implemented with version negotiation and proxying.
 */

/* eslint-disable no-undef */
const NodeHelper = require("node_helper");
const Log = require("logger");
const path = require("path");
const fs = require("fs");

const LOG_PREFIX = "MMM-ImmichTileSlideShow :: helper :: ";
const ROTATION_RETRY_MS = 5 * 60 * 1000;

function dlog(ctx, ...args) {
  if (ctx && ctx.config && ctx.config.debug) {
    Log.info(LOG_PREFIX + "[debug]", ...args);
  } else {
    Log.debug(LOG_PREFIX, ...args);
  }
}

/**
 * @typedef {Object} TileImage
 * @property {string} src
 * @property {string} [title]
 * @property {"image"|"video"} [kind]
 * @property {string} [posterSrc]
 * @property {string} [takenAt]
 * @property {string} [albumName]
 * @property {string} [assetId]
 * @property {string} [assetVersion]
 * @property {"preview"|"thumbnail"} [cacheVariant]
 * @property {number} [w]
 * @property {number} [h]
 */

module.exports = NodeHelper.create({
  requiresVersion: "2.1.0",

  start() {
    this.config = null;
    this._albumRotationTimer = null;
    this._albumRotationState = null;
    Log.info(LOG_PREFIX + "started");
    try {
      // Ensure a PNG screenshot exists for README reference (generated locally)
      const out = path.join(__dirname, 'public', 'screenshot.png');
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2YbXkAAAAASUVORK5CYII='; // 1x1 black PNG
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    } catch (e) {
      Log.warn(LOG_PREFIX + 'Could not (re)generate screenshot.png: ' + e.message);
    }
  },

  stop() {
    _stopAlbumRotation(this);
  },

  /**
   * Handle socket notifications from the front-end
   * @param {string} notification
   * @param {any} payload
   */
  socketNotificationReceived(notification, payload) {
    if (notification === "IMMICH_TILES_REGISTER") {
     _stopAlbumRotation(this);
     // The frontend sends an already-normalized v2 config (configSchema.js),
     // so no defaulting or legacy handling is needed here.
      this.config = payload && payload.config ? payload.config : {};
      Log.info(LOG_PREFIX + "register received");
      const immichCfg = activeImmich(this.config) || {};
      dlog(this, "incoming config", {
        source: immichCfg.source,
        url: immichCfg.url,
        hasApiKey: !!immichCfg.apiKey,
        timeout: immichCfg.timeout,
        albumNames: immichCfg.albumNames,
        albumIds: immichCfg.albumIds,
        size: immichCfg.size
      });
      if (activeImmich(this.config)) {
        const rotation = this.config.albumRotation || {};
        const load = rotation.enabled && immichCfg.source === 'album'
          ? _startAlbumRotation(this)
          : _loadFromImmichImpl(this);
        load.catch((e) => {
          Log.error(LOG_PREFIX + 'Immich load failed: ' + e.message);
          if (rotation.enabled && immichCfg.source === 'album') {
            const hasFallbackAlbum = (immichCfg.albumNames || []).length || (immichCfg.albumIds || []).length;
            if (hasFallbackAlbum) {
              _loadFromImmichImpl(this).catch((fallbackError) => {
                Log.error(LOG_PREFIX + 'Immich fallback load failed: ' + fallbackError.message);
                this._sendInitialImages();
              });
            } else {
              this._sendInitialImages();
            }
          } else {
            this._sendInitialImages();
          }
        });
      } else {
        this._sendInitialImages();
      }
      return;
    }
    // No periodic refresh path; refresh occurs on module restart or config changes
  },

  /**
   * Send a starting set of images. If Immich config is present, this is
   * where Immich fetch would be initiated. For now, send placeholders.
   */
  _sendInitialImages() {
    /** @type {TileImage[]} */
    let images = [];

    if (activeImmich(this.config)) Log.info(LOG_PREFIX + "Immich config detected — falling back to placeholders.");

    const layout = (this.config && this.config.layout) || {};
    const count = Math.max(12, (layout.rows || 2) * (layout.cols || 3) * 3);
    const base = `/${this.name}/placeholder.svg`;
    for (let i = 0; i < count; i++) {
      images.push({ src: base, title: `Tile ${i + 1}`, kind: 'image' });
    }

    this.sendSocketNotification("IMMICH_TILES_DATA", { images });
  }
});

// ------- Immich integration helpers -------

/**
 * Return the active Immich server entry from a normalized v2 config,
 * or null when no usable server is configured.
 * @param {object} moduleConfig normalized config
 * @returns {object|null}
 */
function activeImmich(moduleConfig) {
  const list = moduleConfig && Array.isArray(moduleConfig.immich) ? moduleConfig.immich : [];
  if (!list.length) return null;
  const idx = Number(moduleConfig.activeImmich) || 0;
  const entry = list[idx] || list[0];
  return entry && entry.url && entry.apiKey ? entry : null;
}

/**
 * Return true if filename has a valid extension.
 */
function hasValidExt(filename, validSet) {
  if (!filename || !filename.includes('.')) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return validSet.has(ext);
}

/**
 * Convert Immich asset to a tile image record.
 */
function toTileImage(img, immichApi, isVideo) {
  const title = (img.originalFileName || '').replace(/\.[^.]+$/, '');
  const takenAt = (img.exifInfo && img.exifInfo.dateTimeOriginal) || img.fileCreatedAt || img.fileModifiedAt || null;
  const albumName = img.albumName || null;
  const assetVersion = String(img.updatedAt || img.fileModifiedAt || img.fileCreatedAt || img.id || '');
  const cacheVariant = immichApi.preferThumbnail ? 'thumbnail' : 'preview';
  // Try to extract dimensions when available to avoid extra probing in the browser
  const exif = img && img.exifInfo ? img.exifInfo : {};
  const w = Number(
    exif.imageWidth || exif.ImageWidth || exif.exifImageWidth || exif.PixelXDimension || exif.pixelXDimension ||
    img.width || img.w || null
  ) || null;
  const h = Number(
    exif.imageHeight || exif.ImageHeight || exif.exifImageHeight || exif.PixelYDimension || exif.pixelYDimension ||
    img.height || img.h || null
  ) || null;
  if (isVideo) {
    return {
      kind: 'video',
      src: immichApi.getVideoLink(img.id, assetVersion),
      posterSrc: immichApi.getImageLink(img.id, assetVersion),
      title,
      takenAt,
      albumName,
      assetId: img.id,
      assetVersion,
      cacheVariant,
      w,
      h
    };
  }
  return {
    kind: 'image',
    src: immichApi.getImageLink(img.id, assetVersion),
    title,
    takenAt,
    albumName,
    assetId: img.id,
    assetVersion,
    cacheVariant,
    w,
    h
  };
}

/**
 * Filter a raw Immich asset list by valid extension/type and map to tile records.
 * Extracted so progressive per-page emission and the final aggregated path share logic.
 */
function _filterAndMap(rawAssets, immichApi, context, validImageSet, validVideoSet, albumName) {
  if (!Array.isArray(rawAssets) || rawAssets.length === 0) return [];
  const filtered = rawAssets.filter((img) => {
    const name = img.originalPath || img.originalFileName || '';
    const type = (img.type || '').toString().toLowerCase();
    const isVideoByType = type.includes('video');
    const isImageByType = type.includes('image');
    const okImage = hasValidExt(name, validImageSet) || isImageByType;
    const okVideo = (context.config.videos && context.config.videos.enabled === true) && (hasValidExt(name, validVideoSet) || isVideoByType);
    return okImage || okVideo;
  });
  return filtered.map((img) => {
    const name = img.originalPath || img.originalFileName || '';
    const type = (img.type || '').toString().toLowerCase();
    const isVideo = type.includes('video') || (!type && hasValidExt(name, validVideoSet));
    const tile = toTileImage(img, immichApi, isVideo);
    if (albumName) tile.albumName = albumName;
    return tile;
  });
}

/**
 * Sorting helpers
 */
function sortByKey(list, key) {
  return list.sort((a, b) => {
    const av = (a[key] || '').toString();
    const bv = (b[key] || '').toString();
    if (av > bv) return 1; if (av < bv) return -1; return 0;
  });
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function sortTiles(tiles, cfg) {
  switch (cfg.sort) {
    case 'name':
      sortByKey(tiles, 'title');
      break;
    case 'created':
    case 'modified':
    case 'taken':
      sortByKey(tiles, 'takenAt');
      break;
    case 'random':
      shuffle(tiles);
      break;
    case 'none':
    default:
      break;
  }
  if (cfg.sortDesc === true) tiles.reverse();
  return tiles;
}

function _setCacheProtection(immichApi, tiles) {
  const assets = Array.isArray(tiles) ? tiles : [];
  if (immichApi.previewCache) immichApi.previewCache.setProtectedAssets(assets);
  if (immichApi.videoCache) {
    const videos = assets
      .filter((tile) => tile && tile.kind === 'video')
      .map((tile) => ({ ...tile, cacheVariant: 'video' }));
    immichApi.videoCache.setProtectedAssets(videos);
  }
}

function _logPrefetchResults(results) {
  const summary = (results || []).reduce((total, result) => {
    if (!result) return total;
    total.previewFailed += Number(result.failed) || 0;
    total.videosRequested += Number(result.videosRequested) || 0;
    total.videosCached += Number(result.videosCached) || 0;
    total.videosFailed += Number(result.videosFailed) || 0;
    return total;
  }, { previewFailed: 0, videosRequested: 0, videosCached: 0, videosFailed: 0 });

  if (summary.previewFailed) {
    Log.warn(LOG_PREFIX + `${summary.previewFailed} album preview(s) were not cached.`);
  }
  if (summary.videosFailed) {
    Log.warn(LOG_PREFIX + `${summary.videosFailed}/${summary.videosRequested} album video(s) were not cached; they may stream from Immich.`);
  } else if (summary.videosRequested) {
    Log.info(LOG_PREFIX + `Album video cache ready (${summary.videosCached}/${summary.videosRequested}).`);
  }
}

async function _initializeImmich(context, cfg, force) {
  const immichApi = require('./immichApi.js');
  immichApi.debugOn = !!(context.config && context.config.debug);
  const perf = (context.config && context.config.performance) || {};
  await immichApi.init({
    ...cfg,
    preferThumbnail: !!perf.lightweight,
    cache: context.config && context.config.cache,
    videos: context.config && context.config.videos
  }, context.expressApp, force);
  dlog(context, 'api level resolved', immichApi.apiLevel);
  return immichApi;
}

function _stopAlbumRotation(context) {
  if (context._albumRotationTimer) clearTimeout(context._albumRotationTimer);
  context._albumRotationTimer = null;
  context._albumRotationState = null;
}

async function _resolveRotationAlbums(context, cfg, immichApi) {
  const albumMap = await immichApi.getAlbumNameToIdMap();
  const byId = new Map(Array.from(albumMap.entries()).map(([name, id]) => [String(id), name]));
  const rotation = context.config.albumRotation || {};
  const candidates = [];
  const seenIds = new Set();
  const addAlbum = (id, name) => {
    if (!id || seenIds.has(String(id))) return;
    seenIds.add(String(id));
    candidates.push({ id: String(id), name: name || byId.get(String(id)) || String(id) });
  };

  for (const selector of rotation.albums || []) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selector)) {
      const id = selector.toLowerCase();
      addAlbum(id, byId.get(id));
    } else if (albumMap.has(selector)) {
      addAlbum(albumMap.get(selector), selector);
    } else {
      Log.warn(LOG_PREFIX + `albumRotation album not found: ${selector}`);
    }
  }

  for (const definition of rotation.patterns || []) {
    const pattern = new RegExp(definition.source, definition.flags);
    for (const [name, id] of albumMap.entries()) {
      pattern.lastIndex = 0;
      if (pattern.test(name)) addAlbum(id, name);
    }
  }

  if (!(rotation.albums || []).length && !(rotation.patterns || []).length) {
    for (const name of cfg.albumNames || []) {
      if (albumMap.has(name)) addAlbum(albumMap.get(name), name);
    }
    for (const id of cfg.albumIds || []) addAlbum(id, byId.get(String(id)));
  }

  if (!candidates.length) {
    throw new Error('albumRotation selected no albums; check its names and regular-expression patterns.');
  }
  return candidates;
}

function _scheduleAlbumRotation(context, delay) {
  if (context._albumRotationTimer) clearTimeout(context._albumRotationTimer);
  context._albumRotationTimer = setTimeout(() => {
    _rotateAlbum(context).catch((error) => {
      Log.error(LOG_PREFIX + 'album rotation failed: ' + error.message);
      const state = context._albumRotationState;
      if (state) _scheduleAlbumRotation(context, _rotationDelay(state, true));
    });
  }, delay);
}

function _delayUntilNextHour() {
  const now = new Date();
  return (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();
}

function _rotationDelay(state, retry = false) {
  if (state.alignToHour) return _delayUntilNextHour();
  return retry ? ROTATION_RETRY_MS : state.intervalMs;
}

async function _prepareNextAlbum(context) {
  const state = context._albumRotationState;
  if (!state || state.stage || state.preparing) return state && state.preparing;
  const nextIndex = (state.currentIndex + 1) % state.candidates.length;
  const album = state.candidates[nextIndex];

  state.preparing = (async () => {
    const tiles = await _loadFromImmichImpl(context, {
      album,
      emit: false,
      keepCachePins: true,
      waitForCache: true,
      skipInit: true
    });
    if (!tiles.length) throw new Error(`album "${album.name}" returned no supported media.`);
    state.stage = { index: nextIndex, album, tiles };
    Log.info(LOG_PREFIX + `Next album prepared (${tiles.length} tile(s)).`);
  })();

  try {
    await state.preparing;
  } finally {
    state.preparing = null;
  }
}

async function _rotateAlbum(context) {
  const state = context._albumRotationState;
  if (!state) return;
  if (!state.stage) {
    const retryAt = state.alignToHour ? 'the next local hour' : 'in five minutes';
    Log.warn(LOG_PREFIX + `Next album is not ready; keeping the current album and retrying ${retryAt}.`);
    _prepareNextAlbum(context).catch((error) => {
      Log.error(LOG_PREFIX + 'Could not prepare next album: ' + error.message);
    });
    _scheduleAlbumRotation(context, _rotationDelay(state, true));
    return;
  }

  const next = state.stage;
  state.currentIndex = next.index;
  state.currentTiles = next.tiles;
  state.stage = null;
  const immichApi = require('./immichApi.js');
  _setCacheProtection(immichApi, state.currentTiles);
  context.sendSocketNotification('IMMICH_TILES_DATA', {
    images: state.currentTiles,
    albumName: next.album.name
  });
  Log.info(LOG_PREFIX + `Switched to album ${next.index + 1}/${state.candidates.length}.`);

  _prepareNextAlbum(context).catch((error) => {
    Log.error(LOG_PREFIX + 'Could not prepare next album: ' + error.message);
  });
  _scheduleAlbumRotation(context, _rotationDelay(state));
}

function _randomAlbumIndex(candidateCount) {
  return candidateCount > 1 ? Math.floor(Math.random() * candidateCount) : 0;
}

async function _startAlbumRotation(context) {
  const cfg = activeImmich(context.config);
  const immichApi = await _initializeImmich(context, cfg, true);
  _setCacheProtection(immichApi, []);

  const candidates = await _resolveRotationAlbums(context, cfg, immichApi);
  const currentIndex = _randomAlbumIndex(candidates.length);
  if (candidates.length < 2) {
    Log.info(LOG_PREFIX + 'Album rotation matched fewer than two albums; loading the selected album without rotation.');
    await _loadFromImmichImpl(context, {
      album: candidates[currentIndex],
      keepCachePins: true,
      skipInit: true
    });
    return;
  }

  const state = {
    candidates,
    currentIndex,
    currentTiles: [],
    stage: null,
    preparing: null,
    intervalMs: context.config.albumRotation.intervalMinutes * 60 * 1000,
    alignToHour: context.config.albumRotation.alignToHour === true
  };
  const schedule = state.alignToHour
    ? 'at each local hour boundary'
    : `every ${context.config.albumRotation.intervalMinutes} minute(s)`;
  Log.info(LOG_PREFIX + `Album rotation selected ${candidates.length} album(s); switching ${schedule}.`);
  context._albumRotationState = state;
  state.currentTiles = await _loadFromImmichImpl(context, {
    album: candidates[currentIndex],
    keepCachePins: true,
    skipInit: true
  });
  _setCacheProtection(immichApi, state.currentTiles);

  _prepareNextAlbum(context).catch((error) => {
    Log.error(LOG_PREFIX + 'Could not prepare next album: ' + error.message);
  });
  _scheduleAlbumRotation(context, _rotationDelay(state));
}

/**
 * Fetch images from Immich and send to client
 */
async function _loadFromImmichImpl(context, options) {
  options = options || {};
  // Lazy-require the API dep only when needed
  const immichApi = require('./immichApi.js');
  let cfg = activeImmich(context.config);
  if (!cfg) {
    Log.error(LOG_PREFIX + 'No usable Immich server configured (needs `url` and `apiKey`).');
    context._sendInitialImages();
    return;
  }
  if (options.album) {
    cfg = { ...cfg, albumIds: [options.album.id], albumNames: [] };
  }
  dlog(context, 'active immich server', {
    source: cfg.source,
    url: cfg.url,
    timeout: cfg.timeout,
    albumNames: cfg.albumNames,
    albumIds: cfg.albumIds,
    size: cfg.size
  });

  // Extension lists arrive pre-split from configSchema.normalize()
  const validImageSet = new Set(context.config.imageExtensions || []);
  const validVideoSet = new Set(context.config.videoExtensions || []);

  if (!options.skipInit) await _initializeImmich(context, cfg, true);
  const waitForCache = options.waitForCache === true ||
    (options.waitForCache !== false &&
      Boolean(context.config.cache && context.config.cache.enabled && (immichApi.previewCache || immichApi.videoCache)));
  let albumName = options.album && options.album.name ? options.album.name : null;
  if (!albumName && cfg.source === 'album' && (cfg.albumNames || []).length === 1) {
    albumName = cfg.albumNames[0];
  }
  if (!albumName && cfg.source === 'album' && (cfg.albumIds || []).length === 1) {
    const albumMap = await immichApi.getAlbumNameToIdMap();
    const selected = Array.from(albumMap.entries()).find(([, id]) => String(id) === String(cfg.albumIds[0]));
    if (selected) albumName = selected[0];
  }
  if ((immichApi.previewCache || immichApi.videoCache) && !options.keepCachePins) {
    _setCacheProtection(immichApi, []);
  }

  let images = [];
  if (cfg.source === 'album') {
    // `album` accepts IDs and names interchangeably; names resolve via /albums.
    let albumIds = [...cfg.albumIds];
    if (cfg.albumNames.length) {
      const resolved = await immichApi.findAlbumIds(cfg.albumNames);
      dlog(context, 'findAlbumIds', cfg.albumNames, '=>', resolved);
      if (resolved && resolved.length) albumIds = albumIds.concat(resolved);
    }
    if (albumIds.length) {

      // Without a cache wait, stream pages as they arrive. When caching is
      // enabled, hold all pages until their media prefetches have completed.
      const sortMode = cfg.sort;
      const needsFinalSort = sortMode === 'name' || sortMode === 'created' || sortMode === 'modified' || sortMode === 'taken';
      let firstPageSent = false;
      const appendedRaw = [];
      const progressiveTiles = [];
      const prefetchTasks = [];

      const onPage = (items) => {
        appendedRaw.push(...items);
        const pageTiles = _filterAndMap(items, immichApi, context, validImageSet, validVideoSet, albumName);
        if (!pageTiles.length) return;
        if (sortMode === 'random' && !needsFinalSort) shuffle(pageTiles);
        progressiveTiles.push(...pageTiles);
        if (immichApi.previewCache || immichApi.videoCache) {
          prefetchTasks.push(immichApi.prefetchTiles(pageTiles).catch((error) => {
            Log.warn(LOG_PREFIX + 'Could not prefetch album media: ' + error.message);
            return null;
          }));
        }
        if (options.emit === false || waitForCache || needsFinalSort) return;
        if (!firstPageSent) {
          firstPageSent = true;
          Log.info(LOG_PREFIX + `First page ready — sending ${pageTiles.length} tile(s) to frontend`);
          context.sendSocketNotification('IMMICH_TILES_DATA', { images: pageTiles, albumName });
        } else {
          dlog(context, `appending ${pageTiles.length} tile(s) to pool`);
          context.sendSocketNotification('IMMICH_TILES_APPEND', { images: pageTiles, albumName });
        }
      };

      images = await immichApi.getAlbumAssetsForAlbumIds(albumIds, { onPage });
      dlog(context, 'album assets total', images && images.length);

      if (waitForCache) _logPrefetchResults(await Promise.all(prefetchTasks));
      if (options.emit === false) return sortTiles(progressiveTiles, cfg);

      if (waitForCache) {
        const tiles = sortTiles(progressiveTiles, cfg);
        Log.info(LOG_PREFIX + `Album media cache ready — sending ${tiles.length} tile(s) to frontend.`);
        context.sendSocketNotification('IMMICH_TILES_DATA', { images: tiles, albumName });
        return tiles;
      }

      if (needsFinalSort) {
        // Single terminal emission for date/name sorts — the frontend receives
        // one fully-sorted set (same UX as before, just after paging completes).
        // Fall through to the shared sort/emit path below.
      } else {
        // Pages were already emitted; do not send the same media a second time.
        return progressiveTiles;
      }
      // For final-sort modes, hand off to the shared path with the accumulated set.
      images = appendedRaw;
    } else {
      Log.error(LOG_PREFIX + 'Album mode specified but no album found/selected.');
      // Try to help the user by listing available albums
      try {
        const map = await immichApi.getAlbumNameToIdMap();
        const list = Array.from(map.entries()).map(([name, id]) => `${name} => ${id}`);
        if (list.length > 0) {
          Log.info(LOG_PREFIX + `Available albums (${list.length}): ` + list.join('; '));
          Log.info(LOG_PREFIX + 'Set `immich: { source: "album", album: "<name or id from above>" }` in your config.');
        } else {
          Log.warn(LOG_PREFIX + 'No albums returned by Immich API.');
        }
      } catch (e) {
        Log.warn(LOG_PREFIX + 'Failed to list albums: ' + e.message);
      }
    }
  } else if (cfg.source === 'search') {
    images = await immichApi.searchAssets(cfg.query, cfg.size);
    dlog(context, 'search assets count', images && images.length);
  } else if (cfg.source === 'random') {
    images = await immichApi.randomSearchAssets(cfg.size, cfg.query);
    dlog(context, 'random assets count', images && images.length);
  } else if (cfg.source === 'anniversary') {
    images = await immichApi.anniversarySearchAssets(
      cfg.anniversary.back,
      cfg.anniversary.forward,
      cfg.anniversary.startYear,
      cfg.anniversary.endYear,
      cfg.size,
      cfg.query
    );
    dlog(context, 'anniversary assets count', images && images.length);
  } else {
    // memory lane (default)
    images = await immichApi.getMemoryLaneAssets(cfg.days);
    dlog(context, 'memory lane assets count', images && images.length);
  }

  // Filter by extension and kind
  if (images && images.length) {
    const before = images.length;
    images = images.filter((img) => {
      const name = img.originalPath || img.originalFileName || '';
      const type = (img.type || '').toString().toLowerCase();
      const isVideoByType = type.includes('video');
      const isImageByType = type.includes('image');
      const okImage = hasValidExt(name, validImageSet) || isImageByType;
      const okVideo = (context.config.videos && context.config.videos.enabled === true) && (hasValidExt(name, validVideoSet) || isVideoByType);
      return okImage || okVideo;
    });
    const after = images.length;
    dlog(context, `filter by ext (${before} -> ${after})`);
  }

  // Map to tile images
  let tiles = (images || []).map((img) => {
    const name = img.originalPath || img.originalFileName || '';
    const type = (img.type || '').toString().toLowerCase();
    const isVideo = type.includes('video') || (!type && hasValidExt(name, validVideoSet));
    const tile = toTileImage(img, immichApi, isVideo);
    if (albumName) tile.albumName = albumName;
    return tile;
  });
  dlog(context, 'mapped tiles', tiles && tiles.length);
  if (cfg.source !== 'album' && (immichApi.previewCache || immichApi.videoCache)) {
    if (waitForCache) {
      _logPrefetchResults([await immichApi.prefetchTiles(tiles)]);
    } else {
      immichApi.prefetchTiles(tiles).catch((error) => Log.warn(LOG_PREFIX + 'Could not prefetch media: ' + error.message));
    }
  }

  // No server-side pool cap; all filtered media are returned.

  // Sort
  tiles = sortTiles(tiles, cfg);
  dlog(context, 'sorted tiles', cfg.sort, 'descending?', cfg.sortDesc, 'count', tiles && tiles.length);

  if (options.emit === false) return tiles;

  // Send to client
  Log.info(LOG_PREFIX + `Loaded ${tiles.length} image(s) for source=${cfg.source}`);
  context.sendSocketNotification('IMMICH_TILES_DATA', { images: tiles, albumName });
  return tiles;
}

// Bind to the module object
module.exports._loadFromImmich = _loadFromImmichImpl;
module.exports._randomAlbumIndex = _randomAlbumIndex;
