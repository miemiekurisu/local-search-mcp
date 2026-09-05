import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG, ensureDir } from '../../config/index.js';
import { PaperCacheManifest } from './paperCacheManifest.js';
import { paperKeyFromIdentifier, derivePaperKey } from './paperKey.js';
import { computeExpiresAt } from './paperCachePolicy.js';

export class PaperCacheStore {
  constructor(config = CONFIG.paperCache) {
    this.config = config;
    if (!config.enabled) {
      this.enabled = false;
      return;
    }
    this.enabled = true;
    this.manifest = new PaperCacheManifest(config.manifest);
    this._ensureDirs();
  }

  _ensureDirs() {
    for (const dir of [this.config.dir, this.config.rawDir, this.config.textDir,
      this.config.sectionDir, this.config.chunkDir, this.config.tmpDir]) {
      ensureDir(dir);
    }
  }

  _normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href.replace(/\/+$/, '');
    } catch {
      return url;
    }
  }

  _contentHash(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  _variantSubdir(variant) {
    const parts = String(variant || '').split('/').filter(Boolean);
    if (parts.length === 0 || !parts.every(p => /^[A-Za-z0-9_-]{1,64}$/.test(p))) {
      throw new Error(`invalid cache variant: ${variant}`);
    }
    if (parts[0] === 'raw') return parts.slice(1).join('/') || '';
    return parts.join('/');
  }

  _fileNameFor_paperKey(paperKey, ext) {
    const key = String(paperKey || '');
    if (!key) throw new Error(`invalid paper key: ${paperKey}`);
    const safe = /^[A-Za-z0-9._-]{1,120}$/.test(key) && !key.includes('..')
      ? key
      : key.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '__').slice(0, 60) || 'key';
    const digest = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
    return `${safe}-${digest}.${ext}`;
  }

  _fileForVariant(variant, paperKey, hash) {
    const subdir = this._variantSubdir(variant);
    if (variant.startsWith('raw/')) {
      return path.join(this.config.rawDir, subdir, hash);
    }
    if (variant === 'sections' || variant === 'chunks') {
      return path.join(this.config.dir, subdir, this._fileNameFor_paperKey(paperKey, 'json'));
    }
    if (variant === 'text') {
      return path.join(this.config.textDir, this._fileNameFor_paperKey(paperKey, 'txt'));
    }
    throw new Error(`invalid cache variant: ${variant}`);
  }

  async storeRaw(variant, sourceUrl, data, metadata = {}) {
    if (!this.enabled) return null;
    const normalizedUrl = this._normalizeUrl(sourceUrl);
    const hash = this._contentHash(data);
    const existing = this.manifest.findByHash(hash);
    if (existing.length > 0) {
      this.manifest.touch(existing[0].id);
      return existing[0];
    }
    const existingByUrl = this.manifest.findByUrl(normalizedUrl);
    if (existingByUrl.length > 0) {
      return existingByUrl[0];
    }
    const paperKey = metadata.paper_key || derivePaperKey(metadata);
    const filePath = this._fileForVariant(variant, paperKey, hash);
    ensureDir(path.dirname(filePath));
    const tmpPath = filePath + '.part.' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
    const id = await this.manifest.addEntry({
      paper_key: paperKey,
      identifier_type: metadata.identifier_type || null,
      identifier_value: metadata.identifier_value || null,
      variant,
      source: metadata.source || null,
      source_url: sourceUrl,
      normalized_url: normalizedUrl,
      content_hash: hash,
      file_path: filePath,
      mime_type: metadata.mime_type || null,
      size_bytes: data.length,
      expires_at: computeExpiresAt(variant),
      pinned: metadata.pinned ? 1 : 0,
      open_access_status: metadata.open_access_status || null,
      license: metadata.license || null,
      status: 'ready'
    });
    return this.manifest.getItem(id);
  }

  async storeText(paperKey, text, metadata = {}) {
    if (!this.enabled) return null;
    const filePath = this._fileForVariant('text', paperKey, null);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, text, 'utf8');
    const hash = this._contentHash(Buffer.from(text, 'utf8'));
    const id = await this.manifest.addEntry({
      paper_key: paperKey,
      identifier_type: metadata.identifier_type || null,
      identifier_value: metadata.identifier_value || null,
      variant: 'text',
      source: metadata.source || null,
      source_url: metadata.source_url || null,
      content_hash: hash,
      file_path: filePath,
      mime_type: 'text/plain',
      size_bytes: Buffer.byteLength(text, 'utf8'),
      expires_at: computeExpiresAt('text'),
      pinned: metadata.pinned ? 1 : 0,
      status: 'ready'
    });
    return this.manifest.getItem(id);
  }

  async storeSections(paperKey, sections, metadata = {}) {
    return await this._storeJson('sections', paperKey, sections, metadata);
  }

  async storeChunks(paperKey, chunks, metadata = {}) {
    return await this._storeJson('chunks', paperKey, chunks, metadata);
  }

  async _storeJson(variant, paperKey, data, metadata = {}) {
    if (!this.enabled) return null;
    const filePath = this._fileForVariant(variant, paperKey, null);
    ensureDir(path.dirname(filePath));
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, json, 'utf8');
    const hash = this._contentHash(Buffer.from(json, 'utf8'));
    return await this.manifest.addEntry({
      identifier_type: metadata.identifier_type || null,
      identifier_value: metadata.identifier_value || null,
      source: metadata.source || null,
      source_url: metadata.source_url || null,
      open_access_status: metadata.open_access_status || null,
      license: metadata.license || null,
      error_message: metadata.error_message || null,
      paper_key: paperKey,
      variant,
      content_hash: hash,
      file_path: filePath,
      mime_type: 'application/json',
      size_bytes: Buffer.byteLength(json, 'utf8'),
      status: 'ready'
    });
  }

  async readRaw(entryId) {
    const entry = this.manifest.getItem(entryId);
    if (!entry || !fs.existsSync(entry.file_path)) return null;
    await this.manifest.touch(entryId);
    return { data: fs.readFileSync(entry.file_path), entry };
  }

  async readText(entryId) {
    const entry = this.manifest.getItem(entryId);
    if (!entry || !fs.existsSync(entry.file_path)) return null;
    await this.manifest.touch(entryId);
    return { data: fs.readFileSync(entry.file_path, 'utf8'), entry };
  }

  async readJson(entryId) {
    const entry = this.manifest.getItem(entryId);
    if (!entry || !fs.existsSync(entry.file_path)) return null;
    await this.manifest.touch(entryId);
    return { data: JSON.parse(fs.readFileSync(entry.file_path, 'utf8')), entry };
  }

  findPaper(paperKey) {
    if (!this.enabled) return {};
    const sections = this.manifest.findByPaperKey(paperKey, 'sections');
    const text = this.manifest.findByPaperKey(paperKey, 'text');
    const chunks = this.manifest.findByPaperKey(paperKey, 'chunks');
    const raws = this.manifest.findByPaperKey(paperKey).filter(i => i.variant.startsWith('raw/'));
    return { sections, text, chunks, raws };
  }

  stats() {
    if (!this.enabled) return { enabled: false };
    return { enabled: true, ...this.manifest.stats() };
  }

  async cleanupItems(items, dryRun = true) {
    const removed = [];
    for (const item of items) {
      if (item.pinned) continue;
      try {
        if (fs.existsSync(item.file_path)) {
          if (!dryRun) fs.unlinkSync(item.file_path);
        }
        if (!dryRun) await this.manifest.deleteEntry(item.id);
        removed.push({ id: item.id, file_path: item.file_path, variant: item.variant, dry_run: dryRun });
      } catch (err) {
        console.error(`[cache-cleanup] failed to remove ${item.id}: ${err.message}`);
      }
    }
    return removed;
  }

  close() {
    if (this.manifest) this.manifest.close();
  }
}
