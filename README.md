# MMM-ImmichTileSlideShow

A tile-based photo & video slideshow for MagicMirror², backed by [Immich](https://immich.app/).

Pick a **mode**, point it at your Immich server, done:

```js
{
  module: "MMM-ImmichTileSlideShow",
  config: {
    mode: "grid", cols: 4, rows: 3,
    immich: {
      url: "http://your-immich-host:2283",
      apiKey: "<YOUR_API_KEY>",
      source: "album",
      album: "MagicMirror"
    }
  }
}
```

- **Three layout modes** — `frame` (one photo), `grid` (uniform tiles), `mosaic` (bento-box)
- Rotates tiles on an interval with fade/slide transitions
- Video tiles with autoplay, muting, and a concurrency cap
- Optional captions and auto-scrolling
- Works with **Immich v1.94 → v3.x** (version auto-detected)
- Renders placeholder tiles with zero config, so you can verify the UI first

> **Upgrading from v1?** The configuration format changed. See [Migrating from v1](#migrating-from-v1).

<img src="public/screenshot.png" alt="Screenshot" width="640" />

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/kju78/MMM-ImmichTileSlideShow.git MMM-ImmichTileSlideShow
cd MMM-ImmichTileSlideShow
npm install
```

Then add a module block to `config/config.js` — start from [Layout modes](#layout-modes) below or [`examples/config.example.js`](examples/config.example.js).

## Layout modes

`mode` is the one option that shapes everything else. Pick the one matching your intent.

### `mode: "frame"` — digital picture frame

One full-screen photo at a time. No grid math, no featured tiles.

```js
config: {
  mode: "frame",
  interval: 15000,
  immich: { url: "…", apiKey: "…", source: "album", album: "Family" }
}
```

### `mode: "grid"` — uniform tile wall

Exactly `cols` × `rows` equally-sized tiles filling the screen. Images crop to fill (`fit: "cover"`), so there are never blank cells.

```js
config: {
  mode: "grid",
  cols: 4,
  rows: 3,
  immich: { url: "…", apiKey: "…", source: "album", album: "MagicMirror" }
}
```

Sizing guide for a 16:9 monitor:

| Look | Config |
|---|---|
| Two big side-by-side | `cols: 2, rows: 1` |
| Six large tiles | `cols: 3, rows: 2` |
| Twelve medium tiles | `cols: 4, rows: 3` |
| Fifteen smaller tiles | `cols: 5, rows: 3` |

### `mode: "mosaic"` — bento-box (default)

Column count adapts to the viewport, and tiles stretch by image aspect: portraits span 2 rows, landscapes 2 columns, panoramas 3. A few "featured" tiles are enlarged near the center.

```js
config: {
  mode: "mosaic",
  featured: { min: 2, max: 4 },
  immich: { url: "…", apiKey: "…", source: "memory" }
}
```

**Mosaic ignores `cols`/`rows` by design.** A fixed cell budget plus multi-cell spans is what produces blank cells, so mosaic derives its column count from the viewport instead. To make mosaic tiles bigger, set a minimum tile width with `tileSize` — CSS fills as many columns as fit, and rows stay unbounded, so spans still pack cleanly:

```js
config: {
  mode: "mosaic",
  tileSize: "large",   // "small" | "medium" | "large", or a number of px
  immich: { … }
}
```

#### Fullscreen fit (automatic)

When the browser is actually filling the screen — F11, `requestFullscreen()`, or Chromium `--kiosk` — mosaic switches to a **viewport-fitted** layout. Instead of filling columns against a fixed row height and letting the last row spill past the bottom edge, it solves an exact `cols × rows` split for the visible area:

- Tracks are `repeat(n, 1fr)`, so the grid always sums to exactly the viewport — no overflow, no clipped bottom row, no bleed past the edges.
- The tile count is exactly the number of planned slots, with no spare buffer tiles (a spare tile is what used to land off-screen).
- Slots are planned so they cover every cell exactly once: a few 2×2 features near the centre (still honoring `featured.min`/`max`/`band`), some 2×1 and 1×2 blocks for texture, 1×1 for the rest. Exact coverage means no blank cells either.
- Each photo is matched to a slot whose aspect ratio is close to its own, chosen from a short look-ahead window in the album. Since tiles use `fit: "cover"`, matching shape to slot is what keeps subjects from being cropped or pushed off-centre.

Detection is a heuristic: `--kiosk` and F11 report no fullscreen element, so it compares the viewport against `screen` — strictly on width, loosely on height, since browser chrome (a tab strip survives macOS fullscreen) costs height but never width. If your setup reads wrong, force it:

```js
config: {
  mode: "mosaic",
  fitToScreen: true,   // "auto" (default) | true | false
  immich: { … }
}
```

`tileSize` still applies — it becomes the target cell width the solver aims for. Everything re-solves on resize, and the layout reverts to the flowing auto-fill mosaic if the window leaves fullscreen. Windowed (non-fullscreen) mosaic and `scroll` mosaics are unchanged.

Roughly how many columns you get on a 1920px-wide display (windowed; fullscreen fit solves its own split):

| `tileSize` | Min width | Columns |
|---|---|---|
| *(unset)* | adaptive | 9 |
| `"small"` | 240px | 7 |
| `"medium"` | 340px | 5 |
| `"large"` | 480px | 3 |
| `600` | 600px | 3 |

> Mosaic is the densest, most visually varied layout. If you want exact tile counts rather than a minimum size, use `grid`.

## Options

Grouped options accept `true`, `false`, **or** an object of settings — so `videos: true` and `videos: { maxConcurrent: 2 }` are both valid.

### Layout

| Name | Type | Default | Description |
|---|---|---|---|
| `mode` | string | `"mosaic"` | `"frame"`, `"grid"`, or `"mosaic"`. Determines tile count, sizing, and whether aspect-based spans apply. |
| `cols` | number | `3` | Columns — `grid` mode only. |
| `rows` | number | `2` | Rows — `grid` mode only. |
| `tileSize` | number \| string | `null` | Minimum tile width — **`mosaic` mode only**. `"small"` (240px), `"medium"` (340px), `"large"` (480px), or a number of pixels. `null` uses the adaptive width heuristic. Ignored in `grid`/`frame`, where `cols`/`rows` govern. |
| `fit` | string | `"cover"` | How media fills a tile: `"cover"` (crop) or `"contain"` (letterbox). |
| `dim` | number | `0.25` | Darkening overlay so other modules stay readable. `0`–`1` or `0`–`100`. |
| `fullscreen` | boolean | `true` | Render as a fullscreen background (no `position` needed). Set `false` to render inside a region. |
| `fitToScreen` | boolean \| `"auto"` | `"auto"` | **`mosaic` only.** Solve an exact grid for the viewport so tiles can't overflow. `"auto"` enables it when the browser fills the screen; `true`/`false` override the detection. |
| `heightPx` | number | `360` | Grid height when `fullscreen: false`. `0` lets CSS control it. |

### Slideshow

| Name | Type | Default | Description |
|---|---|---|---|
| `interval` | number | `10000` | Milliseconds between tile swaps. |
| `transition` | string | `"fade"` | `"fade"` or `"slide"`, used for timed tile swaps and when new album data replaces visible tiles. |
| `transitionMs` | number | `600` | Transition duration in ms. |
| `randomize` | boolean | `true` | Swap a random tile each interval instead of cycling in order. |
| `staggerMs` | number | `250` | Stagger between tiles during the initial fill. |

Incoming images are loaded and decoded in the browser before a tile is changed
or faded in. This only preloads media being shown in visible tiles; it does not
decode the entire album into browser memory.

### Captions

| Name | Type | Default | Description |
|---|---|---|---|
| `captions` | boolean \| object | `false` | `true` to enable with defaults, or `{ fields: [...] }`. |
| `captions.fields` | array | `["date"]` | Any of `"title"`, `"date"`, `"album"`. |

### Featured tiles (mosaic only)

| Name | Type | Default | Description |
|---|---|---|---|
| `featured` | boolean \| object | `true` | Enlarged 2×2 tiles near the center. Automatically disabled in `grid`/`frame`. |
| `featured.min` / `featured.max` | number | `2` / `3` | How many tiles are featured at once. |
| `featured.shuffleMinutes` | number | `10` | Reshuffle which tiles are featured. `0` disables. |
| `featured.band` | number | `0.5` | Center band where featured tiles are placed. `0`–`1` or `0`–`100`. |

### Videos

| Name | Type | Default | Description |
|---|---|---|---|
| `videos` | boolean \| object | `true` | `false` disables video tiles entirely. |
| `videos.ratio` | string | `"4:1"` | Images-to-videos cadence, e.g. 4 images then 1 video. |
| `videos.placement` | string | `"center"` | `"center"`, `"featured"`, or `"any"`. |
| `videos.preferFeatured` | boolean | `true` | Prefer featured tiles for playback when available. |
| `videos.centerBand` | number | `null` | Center band for placement; falls back to `featured.band`. |
| `videos.maxConcurrent` | number | `1` | Cap on simultaneously playing videos — **keep low on a Pi**. |
| `videos.autoplay` / `muted` / `loop` | boolean | `true` | Standard HTML5 video behavior. `muted` is required by most autoplay policies. |
| `videos.preload` | string | `"metadata"` | `"none"`, `"metadata"`, or `"auto"`. |
| `videos.playbackMode` | string | `"playback"` | `"playback"` uses Immich's normal video endpoint; `"hls"` uses Immich v3 real-time HLS transcoding. |
| `videos.fallbackToOriginal` | boolean | `true` | Try the original video if Immich's playback endpoint fails. Set `false` to require the playback endpoint only. |

### Scrolling

| Name | Type | Default | Description |
|---|---|---|---|
| `scroll` | boolean \| object | `false` | Credits-style upward auto-scroll. |
| `scroll.speed` | number | `18` | Pixels per second. |

### Media filters & performance

| Name | Type | Default | Description |
|---|---|---|---|
| `imageExtensions` | string | `"jpg,jpeg,png,gif,webp,heic"` | Allowed image extensions (filtered server-side). |
| `videoExtensions` | string | `"mp4,mov,m4v,webm,avi,mkv,3gp"` | Allowed video extensions. |
| `performance.lightweight` | boolean | `false` | Prefer smaller Immich thumbnails. Recommended on Raspberry Pi. |
| `performance.maxTiles` | number | `160` | Upper bound on tiles kept in the DOM (`mosaic` only; `grid`/`frame` use `cols`×`rows`). |
| `performance.sizeCacheMax` | number | `400` | Max entries in the client-side aspect-ratio cache. |
| `performance.sizeCacheTtlMinutes` | number | `30` | Clear that cache periodically. `0` disables. |
| `debug` | boolean | `false` | Verbose logs plus an on-screen status label. |

### Immich

`immich` takes one server object, or an array of them with `activeImmich` selecting the index.

| Name | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | Immich base URL, e.g. `http://host:2283`. **Required.** |
| `apiKey` | string | — | Immich API key. **Required.** See [permissions](#required-api-key-permissions). |
| `timeout` | number | `10000` | Request timeout in ms. |
| `source` | string | `"memory"` | Where photos come from: `memory`, `album`, `search`, `random`, `anniversary`. |
| `album` | array \| string | — | For `source: "album"`. Accepts album **names or IDs**, mixed freely. Pass an array to pull from **multiple albums** — their assets are merged into one pool before sorting. A bare string works for a single album. |
| `days` | number | `7` | For `source: "memory"`: how many days back to include. |
| `query` | object | `null` | For `search`/`random`/`anniversary`: extra Immich search payload fields. |
| `size` | number | `100` | For `search`/`random`/`anniversary`: how many assets to request. |
| `anniversary.back` / `.forward` | number | `3` | Days around today to include. |
| `anniversary.startYear` / `.endYear` | number | 5 years ago / this year | Year range to scan. |
| `sort` | string | `"none"` | `name`, `created`, `modified`, `taken`, `random`, or `none`. |
| `sortDesc` | boolean | `false` | Reverse the sort order. |
| `activeImmich` | number | `0` | Top-level: which server in the `immich` array to use. |

### Local media cache and album rotation

The optional server-side cache stores Immich image previews and video posters on
local disk. Video playback itself continues to stream from Immich unless a
separate full-video cache is enabled.

| Name | Type | Default | Description |
|---|---|---|---|
| `cache` | boolean \| object | `false` | Enable the local media cache. |
| `cache.directory` | string | `~/.cache/MMM-ImmichTileSlideShow` | Cache directory; set an absolute path on a mounted USB drive to move both caches off the SD card. |
| `cache.previewMaxBytes` | number | `8589934592` | Preview/poster cache size limit (8 GiB). The oldest unprotected entries are evicted first. Legacy `cache.maxBytes` remains supported as an alias. |
| `cache.videoMaxBytes` | number | `0` | Separate full-video cache limit; `0` disables it. Cached videos are stored under `cache.directory/videos`, with one download at a time. |
| `cache.concurrency` | number | `2` | Maximum number of preview downloads in flight; valid range is 1–8. |
| `albumRotation` | boolean \| object | `false` | Rotate through selected albums while preparing the next album in the background. |
| `albumRotation.intervalMinutes` | number | `60` | Time to show each album. If preparation is late, the current album remains visible. |
| `albumRotation.alignToHour` | boolean | `false` | With a 60-minute interval, switch at local `HH:00` boundaries. If the next album is not ready, keep the current one until the next hour. |
| `albumRotation.albums` | array \| string | `[]` | Exact album names or IDs to include. |
| `albumRotation.patterns` | array | `[]` | String patterns, RegExp values, or serializable `{ source, flags }` objects matched against album names. Exact names and patterns are combined. |

If both album selectors are empty, rotation uses the album names and IDs from
`immich.album`. Each module start chooses a random matching album, then rotation
advances through the selected candidates. If names or patterns are configured,
`immich.album` is not used for normal selection; it is only a fallback after a
rotation startup error. Rotation only accepts `source: "album"`.

The active and next albums are protected from eviction while the next album is
being prepared. When the configured size limit prevents storing a preview, that
image still loads through the normal Immich proxy. A cache directory on a USB
disk can be selected with an absolute path after the drive is mounted.
When `cache.videoMaxBytes` is greater than zero, complete video streams are
prefetched into a separate bounded cache. On startup, photo tiles are sent
without waiting for full video downloads; video poster tiles appear immediately,
and each video is added after its cache attempt finishes, so a large video
cannot keep the screen on placeholders.
The next album is fully prefetched before the scheduled switch. Videos that are
too large or blocked by the cache limit still use Immich's playback endpoint
directly. Set `videos.fallbackToOriginal: false` to prevent original-file
fallback; playback and cache failures are logged.
Cached video responses support HTTP byte ranges for playback and seeking.
Both the active and next albums are protected while the next album is prepared,
so size the video cache to hold both. The preview and video limits are
independent, not one shared total: setting them to 4 GiB and 6 GiB respectively
allows up to 10 GiB of cached files. A video download can temporarily add up
to another `videoMaxBytes` while it is written. Repeated SD reads are generally
less of a wear concern than writing and replacing cache entries; point
`cache.directory` at a mounted USB disk to move both caches and their writes
off the SD card.
The selected album name is shown at the bottom-left of the display. A preview
that is not yet cached is fetched through Immich, so its first appearance can
wait on the network; later appearances use the local cache while the entry
remains cached.

### Keyboard album picker

Press `A` to open the picker, type to filter the alphabetized album list, use
the up/down arrows to move, `Enter` to choose, and `Esc` to close. Choosing an
album keeps it selected and pauses automatic rotation. When
`albumRotation.enabled` is true, choose **Automatic rotation** in the picker to
resume the configured rotation.

```js
config: {
  cache: {
    enabled: true,
    directory: "/mnt/usb/immich-preview-cache",
    previewMaxBytes: 8 * 1024 * 1024 * 1024,
    videoMaxBytes: 2 * 1024 * 1024 * 1024,
    concurrency: 2
  },
  albumRotation: {
    enabled: true,
    intervalMinutes: 60,
    alignToHour: true,
    albums: [],
    patterns: [{
      source: "^\\d{4}\\s*(?:-\\s*)?(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})",
      flags: "u"
    }]
  },
  immich: {
    url: "http://your-immich-host:2283",
    apiKey: "<YOUR_API_KEY>",
    source: "album"
  }
}
```

## Immich integration

The module detects your Immich version and proxies media requests through MagicMirror's Node helper. The API key is not embedded in proxied media URLs. However, MagicMirror sends module configuration to its browser frontend, so do not treat `immich.apiKey` as hidden from clients that can inspect the mirror; use a read-only key and restrict access to trusted clients.

- **Images** — proxied Immich thumbnails. With `performance.lightweight`, the smaller `thumbnail` is tried first, then `preview`, then the original. Otherwise `preview` first.
- **Videos** — by default, the encoded video stream (v1.x `/assets/{id}/video`, v3+ `/assets/{id}/video/playback`) with a thumbnail poster. `videos.playbackMode: "hls"` uses Immich v3 real-time HLS instead. Posters use the preview cache; standard full streams can be downloaded to the optional, separately bounded video cache.
- **Large albums** — on Immich v3+, album assets are paged via `/search/metadata`. Without local caching, pages stream as they arrive; with caching enabled, the album waits for its preview/video prefetches before rendering.
- **Local caching** — previews and videos are keyed by asset version. Cached videos are served from disk with HTTP Range support; uncached or oversized videos fall back to the Immich stream. The next selected album is loaded and cached before the scheduled switch.

### Required API-key permissions

When creating the key in Immich (**Account → API Keys**), grant:

| Scope | Used for |
| --- | --- |
| `album.read` | List albums and fetch album metadata |
| `asset.read` | Album listing, search, memories, asset metadata |
| `asset.view` | Thumbnails and video playback |
| `asset.download` | Originals (fallback when a thumbnail is missing) |
| `memory.read` | `source: "memory"` |

On pre-v3 servers `asset.read` also covers thumbnails and originals — the `asset.view` / `asset.download` split arrived in v3.

Configure `immich.apiKey` in MagicMirror from a local secret source. Never commit the actual key to this module repository or paste it into documentation.

## Tests

Run the built-in tests with `npm test`. They cover cache persistence, size limits,
protected assets, video and poster preloading, range-capable video responses, and
cache/rotation configuration validation.

## Migrating from v1

v2 replaces the flat option list with a mode-driven config. **v1 configs are not read** — the module logs an error naming each legacy option and shows it on screen, so nothing fails silently.

Layout options collapse into `mode`:

| v1 | v2 |
|---|---|
| `autoLayout: true` | `mode: "mosaic"` |
| `autoLayout: false, tileCols: 4, tileRows: 3` | `mode: "grid", cols: 4, rows: 3` |
| `autoLayout: false, tileCols: 1, tileRows: 1` | `mode: "frame"` |
| `tileSpans` | implied by `mode` — remove it |

Renamed options:

| v1 | v2 |
|---|---|
| `updateInterval` | `interval` |
| `transitionDurationMs` | `transitionMs` |
| `randomizeTiles` | `randomize` |
| `initialStaggerMs` | `staggerMs` |
| `imageFit` | `fit` |
| `overlayOpacity` | `dim` |
| `useFullscreenBelow` | `fullscreen` |
| `containerHeightPx` | `heightPx` |
| `validImageFileExtensions` | `imageExtensions` |
| `validVideoFileExtensions` | `videoExtensions` |

Flat groups become objects (or plain booleans):

| v1 | v2 |
|---|---|
| `showCaptions: true, tileInfo: ["date"]` | `captions: { fields: ["date"] }` |
| `featuredAuto` | `featured: true` / `featured: false` |
| `featuredTilesMin`, `featuredTilesMax` | `featured: { min, max }` |
| `featuredShuffleMinutes`, `featuredCenterBand` | `featured: { shuffleMinutes, band }` |
| `enableVideos` | `videos: true` / `videos: false` |
| `imageVideoRatio`, `videoPlacement`, `videoPreferFeatured`, `videoCenterBand` | `videos: { ratio, placement, preferFeatured, centerBand }` |
| `videoMaxConcurrent`, `videoAutoplay`, `videoMuted`, `videoLoop`, `videoPreload` | `videos: { maxConcurrent, autoplay, muted, loop, preload }` |
| `enableScrolling`, `scrollSpeedPxPerSec` | `scroll: { speed }` |
| `lightweightMode`, `maxTiles`, `sizeCacheMax`, `sizeCacheTtlMinutes` | `performance: { lightweight, maxTiles, sizeCacheMax, sizeCacheTtlMinutes }` |
| `tileGapPx`, `backgroundColor` | removed — gap and tile backdrop are handled by CSS |

Immich config is now a single object:

| v1 | v2 |
|---|---|
| `immichConfigs: [{ … }]` | `immich: { … }` (array still allowed for multiple servers) |
| `activeImmichConfigIndex` | `activeImmich` |
| `mode: "album"` (inside the entry) | `source: "album"` |
| `albumId: ["<id>"]` / `albumName: "Name"` | `album: "<id or name>"` — auto-detected |
| `numDaysToInclude` | `days` |
| `querySize` | `size` |
| `anniversaryDatesBack`, `anniversaryDatesForward`, `anniversaryStartYear`, `anniversaryEndYear` | `anniversary: { back, forward, startYear, endYear }` |
| `sortImagesBy` | `sort` |
| `sortImagesDescending` | `sortDesc` |

### Before / after

```js
// v1
config: {
  autoLayout: false, tileCols: 4, tileRows: 3,
  updateInterval: 10000, imageFit: "cover", overlayOpacity: 0.15,
  lightweightMode: true, enableVideos: true, videoMaxConcurrent: 1,
  immichConfigs: [{
    url: "http://immich:2283", apiKey: "KEY", mode: "album",
    albumName: "MagicMirror", sortImagesBy: "random"
  }]
}

// v2
config: {
  mode: "grid", cols: 4, rows: 3,
  interval: 10000, fit: "cover", dim: 0.15,
  performance: { lightweight: true },
  videos: { maxConcurrent: 1 },
  immich: {
    url: "http://immich:2283", apiKey: "KEY", source: "album",
    album: "MagicMirror", sort: "random"
  }
}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Red error box listing options | v1 config detected | Follow [Migrating from v1](#migrating-from-v1); each listed option names its v2 replacement. |
| Blank screen | `fullscreen_below` hidden by another module | Restart MagicMirror; ensure no module hides that region. For inline rendering set `fullscreen: false` and add a `position`. |
| "Loaded 0 image(s)" | Empty album, wrong `source`, or a name mismatch | Album names are case-sensitive — the log prints all available albums. Try `source: "memory"` to confirm connectivity. |
| Photos load but tiles stay blank | API key missing `asset.view` | Grant the [required scopes](#required-api-key-permissions). |
| Videos show only a poster | Codec unsupported by the browser | Expected fallback. Set `videos: false` to skip them, or re-encode in Immich. |
| Tiles feel too small | Mosaic packs densely by design | Switch to `mode: "grid"` with a low `cols`/`rows`, or `mode: "frame"`. |
| Black/blank cells in the grid | Aspect spans exceed the grid area | In fullscreen/kiosk this can't happen (slots cover the grid exactly). Windowed: use `mode: "grid"` (spans are off) instead of `mode: "mosaic"`. |
| Tiles bleed past the screen edge in mosaic | Browser isn't actually fullscreen, so the fitted layout is off | Launch Chromium with `--kiosk` (or press F11). Set `debug: true` to see the solved `cols × rows` in the on-screen label. |
| Tiles overflow the bottom of the screen | Module older than v2.1.1 — the grid was sized against MagicMirror's region, which can be taller than the window | Update the module. v2.1.1 clamps the grid to the visible viewport and recomputes on any resize. |
| Choppy motion on a Pi | Too many tiles or concurrent videos | Set `performance: { lightweight: true }`, `videos: { maxConcurrent: 1, preload: "none" }`, and raise `interval`. |
| `response.data.assets is not iterable` | Module older than v1.0.1 on Immich v3 | Update the module — v3 album paging is handled since v1.0.1. |

## Raspberry Pi tips

```js
config: {
  mode: "grid", cols: 4, rows: 3,
  interval: 15000,
  performance: { lightweight: true },
  videos: { maxConcurrent: 1, preload: "none" }
}
```

By default, `videos.playbackMode: "playback"` uses Immich's standard video
endpoint, which serves an existing encoded file or the original. Immich's
**Real-time Transcoding → Resolutions** setting does not affect this endpoint.
To use live 480p transcoding while leaving the normal stored-video resolution
unchanged, configure:

```js
videos: {
  playbackMode: "hls",
  fallbackToOriginal: false,
  maxConcurrent: 1,
  preload: "none"
}
```

This mode requires Immich v3+, real-time transcoding enabled, and `480p`
selected under **Real-time Transcoding → Resolutions**. Immich's HLS endpoint
is experimental and requires streaming metadata for each video. If Immich
reports that metadata is not ready, the module logs the failure and leaves the
poster visible; it does not fall back to the standard playback endpoint or the
original file. HLS playlists and segments are proxied through MagicMirror and
are not stored in the module's full-video cache (`cache.videoMaxBytes`).

For the smoothest result, run MagicMirror in server mode on a stronger machine and point the Pi's browser at it.

## Compatibility

- MagicMirror² ≥ 2.1.0
- Immich v1.94 → v3.x
- No external CDN resources; all assets are served by the module

## License

MIT — see [LICENSE](LICENSE)
