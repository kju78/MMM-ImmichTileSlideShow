'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline, Transform } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

class PreviewCache {
  constructor(options) {
    if (!options || typeof options.directory !== 'string' || !options.directory.trim()) {
      throw new Error('Preview cache requires a directory.');
    }

    this.directory = path.resolve(options.directory);
    this.maxBytes = Number(options.maxBytes);
    this.concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 2));
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('Preview cache maxBytes must be a positive safe integer.');
    }
    this.maxEntryBytes = Number(options.maxEntryBytes == null ? this.maxBytes : options.maxEntryBytes);
    if (!Number.isSafeInteger(this.maxEntryBytes) || this.maxEntryBytes <= 0) {
      throw new Error('Cache maxEntryBytes must be a positive safe integer.');
    }
    this.fileExtension = String(options.fileExtension || 'img').toLowerCase();
    if (!/^[a-z0-9]+$/.test(this.fileExtension)) {
      throw new Error('Cache fileExtension must contain only letters and numbers.');
    }
    this.label = options.label || 'Preview cache';

    this.logger = options.logger || null;
    this.entries = new Map();
    this.protectedKeys = new Set();
    this.totalBytes = 0;
    this.initialized = false;
    this._writeTail = Promise.resolve();
    this._activeOperations = 0;
    this._waiters = [];
    this._initializePromise = null;
  }

  key(assetId, version, variant) {
    return crypto
      .createHash('sha256')
      .update(`${assetId}\0${version || ''}\0${variant || 'preview'}`)
      .digest('hex');
  }

  async initialize() {
    if (this.initialized) return;
    if (this._initializePromise) return this._initializePromise;

    this._initializePromise = this._initialize();
    try {
      await this._initializePromise;
    } finally {
      this._initializePromise = null;
    }
  }

  async _initialize() {
    await fsp.mkdir(this.directory, { recursive: true });
    const files = await fsp.readdir(this.directory);
    this.entries.clear();
    this.totalBytes = 0;
    const knownDataFiles = new Set();
    const dataFilenamePattern = new RegExp(`^[a-f0-9]{64}\\.${this.fileExtension}$`, 'i');
    const metadataFiles = files.filter((filename) => /^[a-f0-9]{64}\.json$/i.test(filename));
    let nextMetadataIndex = 0;
    const loadWorker = async () => {
      while (nextMetadataIndex < metadataFiles.length) {
        const filename = metadataFiles[nextMetadataIndex++];
        const key = filename.slice(0, -5);
        const metadataPath = path.join(this.directory, filename);
        const dataPath = this._dataPath(key);
        try {
          const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
          const stat = await fsp.stat(dataPath);
          if (metadata.key !== key || !stat.isFile()) {
            throw new Error('cache metadata does not match its data file');
          }

          const entry = {
            key,
            assetId: String(metadata.assetId),
            version: String(metadata.version || ''),
            variant: String(metadata.variant || 'preview'),
            size: stat.size,
            contentType: metadata.contentType || 'application/octet-stream',
            etag: metadata.etag || null,
            createdAt: metadata.createdAt || stat.mtime.toISOString()
          };
          this.entries.set(key, entry);
          this.totalBytes += stat.size;
          knownDataFiles.add(`${key}.${this.fileExtension}`);
        } catch (error) {
          this._log('warn', `Ignoring invalid cache entry ${key}: ${error.message}`);
          await this._unlinkIfPresent(metadataPath);
          await this._unlinkIfPresent(dataPath);
        }
      }
    };
    const loadConcurrency = Math.min(8, metadataFiles.length);
    await Promise.all(Array.from({ length: loadConcurrency }, () => loadWorker()));

    for (const filename of files) {
      if (dataFilenamePattern.test(filename) && !knownDataFiles.has(filename)) {
        await this._unlinkIfPresent(path.join(this.directory, filename));
      } else if (/^[a-f0-9]{64}\.tmp-[0-9]+-[a-f0-9]+$/i.test(filename)) {
        await this._unlinkIfPresent(path.join(this.directory, filename));
      } else if (/^[a-f0-9]{64}\.json\.tmp-[0-9]+-[a-f0-9]+$/i.test(filename)) {
        await this._unlinkIfPresent(path.join(this.directory, filename));
      }
    }

    await this._withWriteLock(() => this._evictFor(0));
    this.initialized = true;
    this._log('info', `ready at ${this.directory} (${this.totalBytes} bytes).`);
  }

  async get(assetId, version, variant) {
    const key = this.key(assetId, version, variant);
    const entry = this.entries.get(key);
    if (!entry) return null;
    const filePath = this._dataPath(key);
    try {
      await fsp.access(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this._withWriteLock(async () => {
        if (!this.entries.has(key)) return;
        await this._unlinkIfPresent(filePath);
        await this._unlinkIfPresent(this._metadataPath(key));
        this.entries.delete(key);
        this.totalBytes -= entry.size;
      });
      return null;
    }
    return { ...entry, filePath };
  }

  setProtectedAssets(assets) {
    this.protectedKeys = new Set();
    this.addProtectedAssets(assets);
  }

  addProtectedAssets(assets) {
    for (const asset of assets || []) {
      if (!asset || !asset.assetId) continue;
      this.protectedKeys.add(this.key(asset.assetId, asset.assetVersion, asset.cacheVariant));
    }
  }

  async runLimited(operation) {
    await this._acquire();
    try {
      return await operation();
    } finally {
      this._release();
    }
  }

  async store(assetId, version, variant, source, metadata) {
    await this.initialize();
    const key = this.key(assetId, version, variant);
    const existing = this.entries.get(key);
    if (existing) {
      if (source && typeof source.destroy === 'function') source.destroy();
      return { ...existing, filePath: this._dataPath(key) };
    }

    const sizeLimit = Math.min(this.maxBytes, this.maxEntryBytes);
    const expectedSize = Number(metadata && metadata.contentLength);
    if (Number.isFinite(expectedSize) && expectedSize > sizeLimit) {
      if (source && typeof source.destroy === 'function') source.destroy();
      this._log('warn', 'Entry exceeds the configured size limit.');
      return null;
    }

    const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    const tempPath = path.join(this.directory, `${key}.tmp-${token}`);
    let size = 0;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > sizeLimit) {
          const error = new Error('Cache entry exceeds the configured size limit.');
          error.code = 'CACHE_ENTRY_TOO_LARGE';
          callback(error);
          return;
        }
        callback(null, chunk);
      }
    });

    try {
      await pipelineAsync(source, counter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    } catch (error) {
      await this._unlinkIfPresent(tempPath);
      if (error.code === 'CACHE_ENTRY_TOO_LARGE') {
        this._log('warn', 'Entry exceeds the configured size limit.');
        return null;
      }
      throw error;
    }

    if (size === 0) {
      await this._unlinkIfPresent(tempPath);
      return null;
    }

    return this._withWriteLock(async () => {
      const alreadyStored = this.entries.get(key);
      if (alreadyStored) {
        await this._unlinkIfPresent(tempPath);
        return { ...alreadyStored, filePath: this._dataPath(key) };
      }

      if (size > sizeLimit) {
        await this._unlinkIfPresent(tempPath);
        this._log('warn', 'Entry exceeds the configured size limit.');
        return null;
      }
      await this._evictFor(size);
      if (this.totalBytes + size > this.maxBytes) {
        await this._unlinkIfPresent(tempPath);
        this._log('warn', `Preview cache limit reached; did not store asset ${assetId}.`);
        return null;
      }

      const dataPath = this._dataPath(key);
      const metadataPath = this._metadataPath(key);
      const createdAt = new Date().toISOString();
      const entry = {
        key,
        assetId: String(assetId),
        version: String(version || ''),
        variant: String(variant || 'preview'),
        size,
        contentType: (metadata && metadata.contentType) || 'application/octet-stream',
        etag: (metadata && metadata.etag) || null,
        createdAt
      };

      await fsp.rename(tempPath, dataPath);
      const metadataTempPath = `${metadataPath}.tmp-${token}`;
      try {
        await fsp.writeFile(metadataTempPath, JSON.stringify(entry), { flag: 'wx' });
        await fsp.rename(metadataTempPath, metadataPath);
      } catch (error) {
        await this._unlinkIfPresent(metadataTempPath);
        await this._unlinkIfPresent(dataPath);
        throw error;
      }

      this.entries.set(key, entry);
      this.totalBytes += size;
      return { ...entry, filePath: dataPath };
    });
  }

  _dataPath(key) {
    return path.join(this.directory, `${key}.${this.fileExtension}`);
  }

  _metadataPath(key) {
    return path.join(this.directory, `${key}.json`);
  }

  async _evictFor(incomingBytes) {
    if (this.totalBytes + incomingBytes <= this.maxBytes) return;

    const oldestFirst = Array.from(this.entries.values())
      .filter((entry) => !this.protectedKeys.has(entry.key))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const entry of oldestFirst) {
      if (this.totalBytes + incomingBytes <= this.maxBytes) break;
      await this._unlinkIfPresent(this._dataPath(entry.key));
      await this._unlinkIfPresent(this._metadataPath(entry.key));
      this.entries.delete(entry.key);
      this.totalBytes -= entry.size;
    }
  }

  async _unlinkIfPresent(filename) {
    try {
      await fsp.unlink(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async _withWriteLock(operation) {
    const previous = this._writeTail;
    let release;
    this._writeTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  _acquire() {
    if (this._activeOperations < this.concurrency) {
      this._activeOperations += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _release() {
    const next = this._waiters.shift();
    if (next) next();
    else this._activeOperations -= 1;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](`MMM-ImmichTileSlideShow :: ${this.label} :: ${message}`);
    }
  }
}

module.exports = PreviewCache;
