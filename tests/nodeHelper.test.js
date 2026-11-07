'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let nodeHelper;
Module._load = function (request, parent, isMain) {
  if (request === 'node_helper') return { create: (definition) => definition };
  if (request === 'logger') return { debug() {}, error() {}, info() {}, warn() {} };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  nodeHelper = require('../node_helper');
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
