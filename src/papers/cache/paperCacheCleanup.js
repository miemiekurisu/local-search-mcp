import fs from 'fs';
import { CONFIG } from '../../config/index.js';
import { isExpired } from './paperCachePolicy.js';

export class PaperCacheCleanup {
  constructor(store, config = CONFIG.paperCache) {
    this.store = store;
    this.config = config;
  }

  cleanup(dryRun = true) {
    if (!this.store.enabled) return { enabled: false };
    const steps = [];
    steps.push(this._cleanupTmp(dryRun));
    const expired = this.store.manifest.queryExpired(new Date());
    steps.push(this._cleanupExpired(expired, dryRun));
    const quotaSteps = this._enforceRawQuota(dryRun);
    steps.push(...quotaSteps);
    const summary = this._summarize(steps, dryRun);
    return summary;
  }

  _cleanupTmp(dryRun) {
    const tmpDir = this.config.tmpDir;
    if (!fs.existsSync(tmpDir)) return { step: 'cleanup_tmp', removed: 0 };
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        const fp = tmpDir + '/' + f;
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            if (!dryRun) fs.unlinkSync(fp);
            removed++;
          }
        } catch {
        }
      }
    } catch {
    }
    return { step: 'cleanup_tmp', removed, dry_run: dryRun };
  }

  _cleanupExpired(expired, dryRun) {
    const removed = this.store.cleanupItems(expired, dryRun);
    return { step: 'cleanup_expired', removed: removed.length, items: removed.length > 0 ? removed.slice(0, 5) : [], dry_run: dryRun };
  }

  _enforceRawQuota(dryRun) {
    const steps = [];
    const raws = this.store.manifest.queryByVariant('raw/pdf')
      .concat(this.store.manifest.queryByVariant('raw/html'))
      .concat(this.store.manifest.queryByVariant('raw/xml'))
      .concat(this.store.manifest.queryByVariant('raw/tei'));
    const unpinned = raws.filter(i => !i.pinned && !isExpired(i, new Date()));
    unpinned.sort((a, b) => new Date(a.last_access_at) - new Date(b.last_access_at));
    let totalBytes = 0;
    for (const item of raws) totalBytes += item.size_bytes || 0;
    if (totalBytes <= this.config.rawMaxBytes) return [];
    let freed = 0;
    const toRemove = [];
    for (const item of unpinned) {
      if (totalBytes - freed <= this.config.rawMaxBytes) break;
      freed += item.size_bytes || 0;
      toRemove.push(item);
    }
    const removed = this.store.cleanupItems(toRemove, dryRun);
    if (removed.length > 0) {
      steps.push({ step: 'enforce_raw_quota', removed: removed.length, bytes_freed: freed, dry_run: dryRun });
    }
    return steps;
  }

  _summarize(steps, dryRun) {
    const flat = [];
    let totalRemoved = 0;
    for (const s of steps) {
      if (Array.isArray(s)) {
        for (const ss of s) {
          flat.push(ss);
          totalRemoved += ss.removed || 0;
        }
      } else {
        flat.push(s);
        totalRemoved += s.removed || 0;
      }
    }
    return {
      dry_run: dryRun,
      steps: flat,
      total_removed: totalRemoved,
      stats: this.store.stats()
    };
  }
}
