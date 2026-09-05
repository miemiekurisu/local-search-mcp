import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG, ensureDir, safeJoin } from '../../config/index.js';
import { isExpired, computeExpiresAt } from './paperCachePolicy.js';

// Serialize all manifest mutations (add/touch/delete) through one in-process
// promise queue AND a cross-process exclusive lock file. Each mutating method
// does load→modify→_save; without this, another process (http_server vs
// mcp_server) sharing the same PAPER_CACHE_MANIFEST can whole-file-overwrite
// the other's entries, or crash on a Windows rename EPERM.
function _envInt(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

const LOCK_STALE_MS = _envInt('PAPER_MANIFEST_LOCK_STALE_MS', 30000, 100);
const LOCK_ACQUIRE_TIMEOUT_MS = _envInt('PAPER_MANIFEST_LOCK_TIMEOUT_MS', 20000, 50);
const LOCK_RETRY_MS = _envInt('PAPER_MANIFEST_LOCK_RETRY_MS', 100, 10);
const SAVE_MAX_ATTEMPTS = 3;

const _sleep = ms => new Promise(r => setTimeout(r, ms));

let _writeQueue = Promise.resolve();
async function _serializedWrite(lockPath, fn) {
  const prev = _writeQueue;
  let release;
  _writeQueue = new Promise(r => (release = r));
  await prev;
  let locked = false;
  try {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        locked = true;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (_e) {
          // lock vanished (or stat failed): fall through to deadline + retry
        }
        if (Date.now() > deadline) {
          throw Object.assign(new Error(`manifest lock ${lockPath} unavailable after ${LOCK_ACQUIRE_TIMEOUT_MS}ms`), { code: 'MANIFEST_LOCK_TIMEOUT' });
        }
        await _sleep(LOCK_RETRY_MS);
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= SAVE_MAX_ATTEMPTS - 1 || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
        await _sleep(150 * (attempt + 1));
      }
    }
  } finally {
    if (locked) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
    release();
  }
}

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
    return _serializedWrite(this.lockPath, () => {
      this._data = null;
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
    });
  }

  touch(id) {
    return _serializedWrite(this.lockPath, () => {
      this._data = null;
      this.load();
      const item = this._data.items[id];
      if (item) {
        item.last_access_at = new Date().toISOString();
        item.access_count = (item.access_count || 0) + 1;
        this._save();
      }
    });
  }

  deleteEntry(id) {
    return _serializedWrite(this.lockPath, () => {
      this._data = null;
      this.load();
      const removed = this._data.items[id] || null;
      delete this._data.items[id];
      this._save();
      return removed;
    });
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
