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

const yearAndEmoji = {
  source: '^\\d{4}\\s*(?:-\\s*)?(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})',
  flags: 'u'
};

test('normalizes cache and album rotation settings, including RegExp patterns', () => {
  const config = normalize({
    immich: albumConfig,
    cache: { enabled: true, directory: '/tmp/immich-cache', maxBytes: 2048, concurrency: 3 },
    albumRotation: { enabled: true, intervalMinutes: 60, alignToHour: true, patterns: [yearAndEmoji, /^2026/i] }
  });

  assert.deepEqual(config.cache, {
    directory: '/tmp/immich-cache',
    maxBytes: 2048,
    concurrency: 3,
    enabled: true
  });
  assert.deepEqual(config.albumRotation.patterns, [
    { source: yearAndEmoji.source, flags: 'u' },
    { source: '^2026', flags: 'i' }
  ]);
  assert.equal(config.albumRotation.intervalMinutes, 60);
  assert.equal(config.albumRotation.alignToHour, true);

  const pattern = new RegExp(config.albumRotation.patterns[0].source, config.albumRotation.patterns[0].flags);
  assert.equal(pattern.test('2026 🏕️ Husbilsresan'), true);
  assert.equal(pattern.test('2026 🇸🇪 Sommar'), true);
  assert.equal(pattern.test('2017 - 🇺🇸 Chicago'), true);
  assert.equal(pattern.test('2023⛪Vadstena Kloster'), true);
  assert.equal(pattern.test('2026 Semester'), false);
  assert.equal(pattern.test('2026'), false);
});

test('rejects invalid rotation patterns and non-album rotation sources', () => {
  assert.throws(() => normalize({
    immich: albumConfig,
    albumRotation: { enabled: true, patterns: ['['] }
  }), /albumRotation\.patterns\[0\] is invalid/);

  assert.throws(() => normalize({
    immich: albumConfig,
    albumRotation: { enabled: true, patterns: [{ source: '2026', flags: 1 }] }
  }), /albumRotation\.patterns\[0\]\.flags must be a string/);

  assert.throws(() => normalize({
    immich: albumConfig,
    albumRotation: { enabled: true, intervalMinutes: 45, alignToHour: true }
  }), /albumRotation\.alignToHour requires intervalMinutes to be 60/);

  assert.throws(() => normalize({
    immich: { ...albumConfig, source: 'search' },
    albumRotation: true
  }), /albumRotation requires the active Immich source to be "album"/);
});
