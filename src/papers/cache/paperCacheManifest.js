import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG, ensureDir, safeJoin } from '../../config/index.js';
import { isExpired, computeExpiresAt } from './paperCachePolicy.js';

export class PaperCacheManifest {
  constructor(manifestPath) {
    this.path = manifestPath;
    this.lockPath = manifestPath + '.lock';
    this._data = null;
  }

  load() {
    if (this._data) return this._data;
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf8');
        this._data = JSON.parse(raw);
        return this._data;
      }
    } catch (err) {
      console.error(`[cache-manifest] failed to load, starting fresh: ${err.message}`);
    }
    this._data = { items: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    return this._data;
  }

  _save() {
    ensureDir(path.dirname(this.path));
    this._data.updated_at = new Date().toISOString();
    const tmp = this.path + '.tmp.' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    fs.renameSync(tmp, this.path);
  }

  getItem(id) {
    this.load();
    return this._data.items[id] || null;
  }

  findByPaperKey(paperKey, variant) {
    this.load();
    const results = [];
    for (const item of Object.values(this._data.items)) {
      if (item.paper_key === paperKey && (!variant || item.variant === variant)) {
        results.push(item);
      }
    }
    results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return results;
  }

  findByHash(contentHash) {
    this.load();
    return Object.values(this._data.items).filter(i => i.content_hash === contentHash);
  }

  findByUrl(normalizedUrl) {
    this.load();
    return Object.values(this._data.items).filter(i => i.normalized_url === normalizedUrl);
  }

  addEntry(entry) {
    this.load();
    const id = entry.id || crypto.randomUUID();
    const now = new Date().toISOString();
    this._data.items[id] = {
      id,
      paper_key: entry.paper_key,
      identifier_type: entry.identifier_type || null,
      identifier_value: entry.identifier_value || null,
      variant: entry.variant,
      source: entry.source || null,
      source_url: entry.source_url || null,
      normalized_url: entry.normalized_url || null,
      content_hash: entry.content_hash || null,
      file_path: entry.file_path,
      mime_type: entry.mime_type || null,
      size_bytes: entry.size_bytes || 0,
      created_at: now,
      last_access_at: now,
      expires_at: entry.expires_at || computeExpiresAt(entry.variant) || null,
      pinned: entry.pinned ? 1 : 0,
      open_access_status: entry.open_access_status || null,
      license: entry.license || null,
      status: entry.status || 'ready',
      error_message: entry.error_message || null
    };
    this._save();
    return id;
  }

  touch(id) {
    this.load();
    const item = this._data.items[id];
    if (item) {
      item.last_access_at = new Date().toISOString();
      item.access_count = (item.access_count || 0) + 1;
      this._save();
    }
  }

  deleteEntry(id) {
    this.load();
    const removed = this._data.items[id] || null;
    delete this._data.items[id];
    this._save();
    return removed;
  }

  queryExpired(now) {
    this.load();
    return Object.values(this._data.items).filter(i => isExpired(i, now));
  }

  queryByVariant(variant) {
    this.load();
    return Object.values(this._data.items).filter(i => i.variant === variant);
  }

  allEntries() {
    this.load();
    return Object.values(this._data.items);
  }

  stats() {
    this.load();
    const items = Object.values(this._data.items);
    const byVariant = {};
    let totalBytes = 0;
    let pinned = 0;
    let expired = 0;
    const now = new Date();
    for (const item of items) {
      byVariant[item.variant] = (byVariant[item.variant] || 0) + 1;
      totalBytes += item.size_bytes || 0;
      if (item.pinned) pinned++;
      if (isExpired(item, now)) expired++;
    }
    return {
      total_items: items.length,
      total_bytes: totalBytes,
      pinned,
      expired,
      by_variant: byVariant,
      manifest_path: this.path
    };
  }

  close() {
    if (this._data) {
      this._save();
    }
    this._data = null;
  }
}
