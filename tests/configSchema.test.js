'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalize } = require('../configSchema');

const albumConfig = {
  url: 'http://immich.local:2283',
  apiKey: 'test-key',
  source: 'album',
  album: 'Current album'
};

test('normalizes cache and album rotation settings, including RegExp patterns', () => {
  const config = normalize({
    immich: albumConfig,
    cache: { enabled: true, directory: '/tmp/immich-cache', maxBytes: 2048, concurrency: 3 },
    albumRotation: { enabled: true, intervalMinutes: 45, patterns: [/^2026/i] }
  });

  assert.deepEqual(config.cache, {
    directory: '/tmp/immich-cache',
    maxBytes: 2048,
    concurrency: 3,
    enabled: true
  });
  assert.deepEqual(config.albumRotation.patterns, [{ source: '^2026', flags: 'i' }]);
  assert.equal(config.albumRotation.intervalMinutes, 45);
});

test('rejects invalid rotation patterns and non-album rotation sources', () => {
  assert.throws(() => normalize({
    immich: albumConfig,
    albumRotation: { enabled: true, patterns: ['['] }
  }), /albumRotation\.patterns\[0\] is invalid/);

  assert.throws(() => normalize({
    immich: { ...albumConfig, source: 'search' },
    albumRotation: true
  }), /albumRotation requires the active Immich source to be "album"/);
});
